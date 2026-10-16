/**
 * Doc2Query 的执行侧：调模型生成问题、写回分块 metadata、把问题编进索引。
 *
 * 纯逻辑在 `./doc2query.js`（提示词模板、输出解析、SourceID 规则），这里只管
 * 编排：批量取分块、逐个调用、失败跳过、批量嵌入、写索引。
 *
 * 与上游对齐的三条控制流（其余偏离见 doc2query.ts 模块头）：
 *   - **单个分块失败只跳过它**，整批继续（`knowledge_process.go:2404-2408`
 *     是 `continue` 而不是 `return`）；
 *   - **生成期间内容被改过就丢弃结果**（`:2412-2417` 比对 ContentRevision）；
 *   - **批次大小 20**（`questionGenChunkBatchSize`）。
 *
 * 一条本仓库特有的简化：上游把问题条目插进同一个向量库、让它同时进关键词索引；
 * 本仓库的额外向量表只服务向量臂，所以生成的问题**只扩大向量召回**，不进关键词
 * 索引。这是取舍不是遗漏，已登记在 STATE 的已知缺口里。
 */

import { logger } from '../logger.js';
import {
  clearChunkVectorsBySource,
  getChunkGeneratedQuestions,
  getKbChunk,
  getKbDocumentAnyOwner,
  getKnowledgeBaseAnyOwner,
  getSiblingChunkContents,
  listChunksNeedingQuestions,
  setChunkGeneratedQuestions,
  setChunkVariantVectors,
} from '../db.js';
import { getEmbeddingConfig, embedTexts } from '../embedding.js';
import {
  QUESTION_GEN_BATCH_SIZE,
  QUESTION_MAX_TOKENS,
  QUESTION_TEMPERATURE,
  buildGeneratedQuestionsMetadata,
  buildQuestionIndexContent,
  buildQuestionPrompt,
  isQuestionGenerationEligible,
  parseGeneratedQuestions,
  parseQuestionGenerationConfig,
} from './doc2query.js';

/** 512 token 的输出用不着 120s；卡住也不该拖满整轮问答的超时预算。 */
const GENERATE_TIMEOUT_MS = 60_000;

export interface QuestionGenModelConfig {
  baseUrl: string;
  apiKey: string;
  model: string;
}

export interface QuestionGenResult {
  /** 通过筛选、真正进入生成的分块数。 */
  eligible: number;
  /** 成功写回问题的分块数。 */
  generated: number;
  /** 生成的索引条目（问题）总数。 */
  questions: number;
  /** 单块失败被跳过的次数。 */
  skipped: number;
  /** 生成期间内容被改过、结果被丢弃的次数。 */
  stale: number;
  /** 未开启（或没配模型）时为 true，其余字段无意义。 */
  disabled?: boolean;
}

/** 一次 LLM 调用。失败返回 null，由调用方计入 skipped。 */
async function generateForChunk(
  model: QuestionGenModelConfig,
  prompt: string,
): Promise<string[] | null> {
  try {
    const res = await fetch(`${model.baseUrl.replace(/\/+$/, '')}/chat/completions`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        Authorization: `Bearer ${model.apiKey}`,
      },
      body: JSON.stringify({
        model: model.model,
        // 上游只有 user 一条消息，没有 system（knowledge_process.go:2510-2521）。
        messages: [{ role: 'user', content: prompt }],
        temperature: QUESTION_TEMPERATURE,
        max_tokens: QUESTION_MAX_TOKENS,
        stream: false,
      }),
      signal: AbortSignal.timeout(GENERATE_TIMEOUT_MS),
    });
    if (!res.ok) {
      const detail = await res.text().catch(() => '');
      logger.warn(
        { status: res.status, detail: detail.slice(0, 200) },
        'Question generation call failed — skipping this chunk',
      );
      return null;
    }
    const json = (await res.json()) as { choices?: Array<{ message?: { content?: string } }> };
    // 上限给大值：截断交给调用方按 questionCount 做，这里只执行行解析规则。
    return parseGeneratedQuestions(json.choices?.[0]?.message?.content ?? '', Number.MAX_SAFE_INTEGER);
  } catch (err) {
    logger.warn({ err }, 'Question generation call threw — skipping this chunk');
    return null;
  }
}

/**
 * 给一个知识库的所有合格分块生成问题并落索引。
 *
 * `model` 为 null 时直接返回 disabled —— 没配 chat 模型不是错误，只是这个能力
 * 用不了（与 PRD §5.4「未配置必须降级而非报错」一致）。
 */
export async function generateQuestionsForKb(
  kbId: string,
  model: QuestionGenModelConfig | null,
): Promise<QuestionGenResult> {
  const empty: QuestionGenResult = { eligible: 0, generated: 0, questions: 0, skipped: 0, stale: 0 };
  const kb = getKnowledgeBaseAnyOwner(kbId);
  if (!kb) return empty;

  const config = parseQuestionGenerationConfig(kb.question_generation_config);
  if (!config.enabled || !model) return { ...empty, disabled: true };

  const eligible = listChunksNeedingQuestions(kbId).filter((c) =>
    isQuestionGenerationEligible(c),
  );
  const result: QuestionGenResult = {
    eligible: eligible.length,
    generated: 0,
    questions: 0,
    skipped: 0,
    stale: 0,
  };
  if (eligible.length === 0) return result;

  const touched: string[] = [];

  for (let start = 0; start < eligible.length; start += QUESTION_GEN_BATCH_SIZE) {
    const batch = eligible.slice(start, start + QUESTION_GEN_BATCH_SIZE);

    for (const chunk of batch) {
      const revisionBefore = chunk.content_revision ?? 1;
      const { prev, next } = getSiblingChunkContents(chunk.doc_id, chunk.chunk_index);
      const prompt = buildQuestionPrompt({
        docName: docTitle(chunk.doc_id),
        content: chunk.content,
        questionCount: config.questionCount,
        prevContent: prev,
        nextContent: next,
        customInstructions: config.customInstructions,
      });

      const raw = await generateForChunk(model, prompt);
      if (raw === null) {
        result.skipped++;
        continue;
      }
      const questions = raw.slice(0, config.questionCount);
      if (questions.length === 0) {
        result.skipped++;
        continue;
      }

      // 内容在等待模型期间被改过 → 这批问题是针对旧内容写的，丢弃。
      const after = getKbChunk(chunk.id);
      if (!after || (after.content_revision ?? 1) !== revisionBefore) {
        result.stale++;
        continue;
      }

      setChunkGeneratedQuestions(
        chunk.id,
        buildGeneratedQuestionsMetadata(questions, revisionBefore),
      );
      touched.push(chunk.id);
      result.generated++;
      result.questions += questions.length;
    }
  }

  if (touched.length > 0) {
    const indexed = await indexGeneratedQuestions(touched);
    if (indexed < touched.length) {
      logger.warn(
        { kbId, chunks: touched.length, indexed },
        'Some generated questions could not be embedded',
      );
    }
  }

  return result;
}

/** 文档标题：本仓库用文件名，与上游 `knowledge.Title` 的角色一致。 */
function docTitle(docId: string): string {
  return getKbDocumentAnyOwner(docId)?.filename ?? '';
}

/**
 * 把已写进 metadata 的预生成问题编进向量索引。
 *
 * 每条问题的正文是「文档标题 \n 问题」，与上游 `buildKnowledgeIndexContent`
 * 一致；问题在分块内的序号用 variant_index 承载，归并回父分块靠 chunk_id。
 */
async function indexGeneratedQuestions(chunkIds: string[]): Promise<number> {
  const byChunk = new Map<string, Array<{ index: number; text: string }>>();
  for (const chunkId of chunkIds) {
    const chunk = getKbChunk(chunkId);
    if (!chunk) continue;
    const title = docTitle(chunk.doc_id);
    const items = getChunkGeneratedQuestions(chunkId).map((q, j) => ({
      index: j,
      text: buildQuestionIndexContent(title, q.question),
    }));
    if (items.length > 0) byChunk.set(chunkId, items);
  }
  if (byChunk.size === 0) return 0;

  if (!getEmbeddingConfig()) {
    logger.warn('No embedding config — generated questions not indexed');
    return 0;
  }

  let indexed = 0;
  for (const [chunkId, items] of byChunk) {
    const vectors = await embedTexts(items.map((i) => i.text));
    if (vectors.some((v) => v === null)) {
      logger.warn({ chunkId }, 'Embedding generated questions failed — skipped');
      continue;
    }
    setChunkVariantVectors(
      chunkId,
      items.map((item, i) => ({
        index: item.index,
        embedding: vectors[i] as Float32Array,
        model: getEmbeddingConfig()?.model ?? '',
      })),
      'generated_question',
    );
    indexed++;
  }
  return indexed;
}

/**
 * 丢弃某分块的预生成问题向量。索引条目不会跟着分块走，重切/删除分块时必须显式清。
 */
export function dropGeneratedQuestionVectors(chunkId: string): void {
  clearChunkVectorsBySource(chunkId, 'generated_question');
}
