/**
 * Doc2Query：给每个分块预生成"这段内容能回答的问题"，把问题也编进索引。
 *
 * 规格来源（逐行核对 WeKnora v0.8.3）：
 *   - 配置结构      internal/types/knowledgebase.go:639-646
 *   - 默认值/上限   knowledge_process_config.go:260（Enabled 零值即关）、
 *                   knowledge_process.go:2024-2031（<=0 → 3、>10 → 10）
 *   - 提示词        config/prompt_templates/generate_questions.yaml
 *   - LLM 调用      knowledge_process.go:2510-2521（temperature 0.7 / maxTokens 512 / 仅 user）
 *   - 输出解析      knowledge_process.go:2524-2546
 *   - source_id     internal/types/faq.go:34-49（>64 字节时只哈希 questionID）
 *   - 索引正文      knowledge_index_content.go:9-21（标题 + "\n" + 正文）
 *   - 批次大小      knowledge_post_process.go:599-604（questionGenChunkBatchSize = 20）
 *
 * 四条显式偏离：
 *
 * 1. **没有 asynq。** 上游把生成任务丢进 `question` 队列（MaxRetry 3、
 *    Timeout 30min）。本仓库是单进程，按批次同步跑，批内单个分块失败只跳过
 *    该分块——这条与上游一致（`knowledge_process.go:2404-2408` 是 continue，
 *    不是 return）。
 * 2. **没有 trace span。** 上游每个批次开 `postprocess.question.batch[i]` 的
 *    span，本仓库没有 tracing 基建，只写日志。
 * 3. **没有 `Thinking: &false`。** 上游显式关掉思考模式（那是它 chat 客户端的
 *    字段），OpenAI 兼容协议里没有对应项，故不发这个字段。
 * 4. **语言名映射只覆盖少数几种。** 上游 `LanguageLocaleName`
 *    （context_helpers.go:431-453）有一张几十项的表；这里只映射常见几种，
 *    其余原样返回 locale 串。提示词里 `{{language}}` 是给模型看的自然语言名，
 *    取不到名字时退化成 locale 串仍可读，不会空着。
 *
 * 一条承重语义：**生成的问题自己不进 `chunk.content`**，只是额外的一条索引
 * 条目（SourceID 加后缀），检索命中后按 `chunk_id` 归并回父分块。所以用户
 * 看到的永远是分块正文，不是问题文本。
 */

import { createHash } from 'node:crypto';

/** 上游 `questionGenChunkBatchSize`（knowledge_post_process.go:603）。 */
export const QUESTION_GEN_BATCH_SIZE = 20;

export const DEFAULT_QUESTION_COUNT = 3;
export const MAX_QUESTION_COUNT = 10;

/** 上游 `MaxCustomPromptInstructionsLength`（prompt_instructions.go:9）。 */
export const MAX_CUSTOM_INSTRUCTIONS_LENGTH = 4000;

/** 上游 `maxGeneratedQuestionSourceIDLength`（faq.go:34）。 */
const MAX_SOURCE_ID_LENGTH = 64;

export const QUESTION_TEMPERATURE = 0.7;
export const QUESTION_MAX_TOKENS = 512;

export interface QuestionGenerationConfig {
  enabled: boolean;
  questionCount: number;
  customInstructions: string;
}

export interface GeneratedQuestion {
  id: string;
  question: string;
  /** 生成时该分块的内容版本；与当前版本不一致说明问题已经过期。 */
  contentRevision?: number;
}

/** 上游 `QuestionGenerationConfig.Enabled` 零值即关（默认关，见模块头注释）。 */
export const DEFAULT_QUESTION_GENERATION_CONFIG: QuestionGenerationConfig = {
  enabled: false,
  questionCount: DEFAULT_QUESTION_COUNT,
  customInstructions: '',
};

/** 上游把所有入口的 question_count 都夹到 [1,10]，<=0 视作 3。 */
export function clampQuestionCount(raw: unknown): number {
  const n = typeof raw === 'number' && Number.isFinite(raw) ? Math.trunc(raw) : 0;
  if (n <= 0) return DEFAULT_QUESTION_COUNT;
  if (n > MAX_QUESTION_COUNT) return MAX_QUESTION_COUNT;
  return n;
}

/** 解析 KB 上的 `question_generation_config`（snake_case，与上游 JSON 键一致）。 */
export function parseQuestionGenerationConfig(
  raw: string | null | undefined,
): QuestionGenerationConfig {
  if (!raw) return { ...DEFAULT_QUESTION_GENERATION_CONFIG };
  try {
    const parsed = JSON.parse(raw) as Record<string, unknown>;
    if (!parsed || typeof parsed !== 'object') return { ...DEFAULT_QUESTION_GENERATION_CONFIG };
    const custom =
      typeof parsed.custom_instructions === 'string'
        ? parsed.custom_instructions.slice(0, MAX_CUSTOM_INSTRUCTIONS_LENGTH)
        : '';
    return {
      enabled: parsed.enabled === true,
      questionCount: clampQuestionCount(parsed.question_count),
      customInstructions: custom,
    };
  } catch {
    return { ...DEFAULT_QUESTION_GENERATION_CONFIG };
  }
}

export function serializeQuestionGenerationConfig(config: QuestionGenerationConfig): string {
  return JSON.stringify({
    enabled: config.enabled === true,
    question_count: clampQuestionCount(config.questionCount),
    ...(config.customInstructions
      ? { custom_instructions: config.customInstructions.slice(0, MAX_CUSTOM_INSTRUCTIONS_LENGTH) }
      : {}),
  });
}

/** 上游 `buildKnowledgeIndexContent`：标题去空白，空标题则不拼。 */
export function buildQuestionIndexContent(title: string | null | undefined, question: string): string {
  const trimmed = (title ?? '').trim();
  if (!trimmed) return question;
  return `${trimmed}\n${question}`;
}

/**
 * 上游 `GeneratedQuestionSourceID`：`chunkID + "-" + questionID`，超过 64 字节
 * 时**只**哈希 questionID（chunkID 原样保留），前缀换成 `-q`，取 SHA-256 前
 * 12 字节的十六进制（24 字符）。
 *
 * 这个规则必须逐字节一致：删除与重建索引都要用同一个 id 才能对得上。
 */
export function generatedQuestionSourceId(chunkId: string, questionId: string): string {
  const candidate = `${chunkId}-${questionId}`;
  if (candidate.length <= MAX_SOURCE_ID_LENGTH) return candidate;
  const digest = createHash('sha256').update(questionId, 'utf8').digest();
  return `${chunkId}-q${digest.subarray(0, 12).toString('hex')}`;
}

/**
 * 上游输出解析（knowledge_process.go:2524-2546）。
 *
 * 三个细节都照抄：
 *   - `TrimLeft` 的切集是字面量 `"0123456789.-*) "`，会把行首的数字与项目符号
 *     一并吃掉（所以 "1. 什么是 RAG" → "什么是 RAG"）；
 *   - 长度门槛 `len > 5` 是**字节数**，中文一条 5 字的问题（15 字节）能过，
 *     英文 "What?" （5 字节）会被丢掉；
 *   - **不去重**，模型给两条一样的问题就存两条。
 */
export function parseGeneratedQuestions(responseText: string, questionCount: number): string[] {
  const out: string[] = [];
  for (const rawLine of responseText.split('\n')) {
    let line = rawLine.trim();
    if (!line) continue;
    line = line.replace(/^[0-9.\-*) ]+/, '').trim();
    if (line && Buffer.byteLength(line, 'utf8') > 5) {
      out.push(line);
      if (out.length >= questionCount) break;
    }
  }
  return out;
}

/**
 * 上游 `{{context}}` 段落：把相邻分块作为"理解上下文"给出，并明确声明问题只能
 * 针对 main_content。没有相邻分块时整段为空串（不是空标签）。
 */
export function buildSurroundingContext(prev?: string | null, next?: string | null): string {
  const p = (prev ?? '').trim();
  const n = (next ?? '').trim();
  if (!p && !n) return '';
  let out = '<surrounding_context>\n';
  if (p) out += `<preceding_content>\n${p}\n\n</preceding_content>\n\n`;
  if (n) out += `<following_content>\n${n}\n\n</following_content>\n\n`;
  out += '</surrounding_context>\n\n';
  return out;
}

/**
 * 上游 `AppendCustomPromptInstructions`（prompt_instructions.go:14-25）：把自定义
 * 指令包在一个具名标签里，并追加一句固定的话说明两者冲突时以哪个为准。
 */
export function appendCustomInstructions(prompt: string, custom: string | undefined): string {
  const trimmed = (custom ?? '').trim();
  if (!trimmed) return prompt;
  return (
    `${prompt}\n\n<question_generation_business_instructions>\n${trimmed}\n` +
    `</question_generation_business_instructions>\n\n` +
    'Follow the business instructions above when they do not conflict with the core requirements.\n'
  );
}

/** 极简语言名映射，见模块头注释偏离 4。 */
const LANGUAGE_NAMES: Record<string, string> = {
  'zh-cn': 'Chinese (Simplified)',
  zh: 'Chinese (Simplified)',
  'zh-tw': 'Chinese (Traditional)',
  'zh-hk': 'Chinese (Traditional)',
  en: 'English',
  'en-us': 'English',
  'en-gb': 'English',
  ja: 'Japanese',
  ko: 'Korean',
  fr: 'French',
  de: 'German',
  es: 'Spanish',
  ru: 'Russian',
};

export function languageName(locale: string | null | undefined): string {
  const raw = (locale ?? '').trim();
  if (!raw) return LANGUAGE_NAMES['zh-cn'];
  return LANGUAGE_NAMES[raw.toLowerCase()] ?? raw;
}

/** 上游模板逐字照抄（config/prompt_templates/generate_questions.yaml）。 */
export const QUESTION_SYSTEM_PROMPT = `You are a question generation assistant optimizing for search retrieval. Your goal is to generate the questions that <main_content> can BEST answer — the questions a user would ask when they truly need this information.
Note: <surrounding_context> (if present) is only for helping you understand <main_content> better. Generate questions ONLY about <main_content>.

{{context}}
<main_content>
Document name: {{doc_name}}

{{content}}
</main_content>

## Think Before Generating
First, silently identify:
1. What is the CORE TOPIC of this content?
2. What problem or need does this content address?
3. If a user needed this information, what would they search for?

## Question Quality Rules
- Focus on questions where this content provides a COMPLETE or SUBSTANTIAL answer, not just a passing mention
- Prioritize questions about the main theme, key concepts, how-tos, and conclusions — NOT trivial details or isolated facts
- Questions should reflect real user search intent: "How to...", "What is...", "Why does...", "What are the best practices for..."
- Each question must be self-contained: NO pronouns or references (e.g., "it", "this", "that document"); use specific names
- Questions should be at a level where someone would genuinely search for the answer, not quiz-style trivia
- Each question should be concise and clear, within 30 words

## What NOT to Generate
- Do NOT generate questions about minor details that are only briefly mentioned
- Do NOT generate questions that can be answered with a single word or number extracted from the text
- Do NOT generate questions that are too broad to be meaningfully answered by this specific content

## Output
Generate {{question_count}} questions, one per line, no numbering or prefixes.

## CRITICAL: Language Rule
- Generate questions in {{language}}`;

export interface QuestionPromptInput {
  docName: string;
  content: string;
  questionCount: number;
  language?: string | null;
  prevContent?: string | null;
  nextContent?: string | null;
  customInstructions?: string;
}

/**
 * 渲染提示词。上游用的是通用 `RenderPromptPlaceholders`：**取不到值的占位符
 * 原样保留字面量**（例如 `{{language}}` 不传就留着）。这里同样不把未提供的值
 * 替换成空串，否则 `{{context}}` 会静默消失而不是留下可见痕迹。
 */
export function buildQuestionPrompt(input: QuestionPromptInput): string {
  // 用函数式替换而不是字符串替换：字符串形式的 replacement 会把 `$&`、`$'`、
  // `` $` `` 当成反向引用展开，文档正文里出现 `$&` 就会把提示词改坏。上游
  // `strings.ReplaceAll` 没有这层语义，这里必须对齐。
  const values: Record<string, string> = {
    '{{context}}': buildSurroundingContext(input.prevContent, input.nextContent),
    '{{question_count}}': String(clampQuestionCount(input.questionCount)),
    '{{content}}': input.content,
    '{{doc_name}}': input.docName,
    '{{language}}': languageName(input.language),
  };
  const prompt = QUESTION_SYSTEM_PROMPT.replace(
    /\{\{context\}\}|\{\{question_count\}\}|\{\{content\}\}|\{\{doc_name\}\}|\{\{language\}\}/g,
    (token) => values[token] ?? token,
  );
  return appendCustomInstructions(prompt, input.customInstructions);
}

/**
 * 上游 `chunkHasExtractableText`（knowledge_post_process.go:739-741）：
 * 去掉 markdown 图片与 `<image>` 包裹后还剩不剩真文字。纯图片占位的分块不生成
 * 问题——对它问什么都是编的。
 */
export function hasExtractableText(content: string): boolean {
  const stripped = (content ?? '')
    .replace(/!\[[^\]]*\]\([^)]*\)/g, '')
    .replace(/<image>[\s\S]*?<\/image>/gi, '');
  return stripped.trim().length > 0;
}

/** 只有 `text` 型分块参与生成：父块、FAQ、OCR/图注都被上游排除在外。 */
export function isQuestionGenerationEligible(chunk: {
  chunk_type?: string | null;
  content?: string | null;
  is_enabled?: number | boolean | null;
}): boolean {
  if (chunk.chunk_type !== 'text') return false;
  if (chunk.is_enabled === 0 || chunk.is_enabled === false) return false;
  return hasExtractableText(chunk.content ?? '');
}

/**
 * 上游问题 id：`q<纳秒时间戳+j>`（异步路径，knowledge_process.go:2094）。
 *
 * 必须用 BigInt：纳秒时间戳约 1.7e18，超出 `Number.MAX_SAFE_INTEGER`（9.0e15），
 * 用 double 相加时 +1 会被吞掉，同一批里前 256 条问题会得到同一个 id。Go 那边是
 * int64，没有这个问题，JS 这边只能显式用大整数才能对齐。
 */
export function makeQuestionId(nowNanos: bigint | number, index: number): string {
  return `q${BigInt(nowNanos) + BigInt(index)}`;
}

/**
 * 生成问题的元数据载体。整体**替换**而非追加——上游 `SetDocumentMetadata`
 * 是整对象 Marshal，异步路径会把该分块已有的生成问题覆盖掉。
 */
export function buildGeneratedQuestionsMetadata(
  questions: string[],
  contentRevision: number,
  nowNanos: bigint | number = BigInt(Date.now()) * 1_000_000n,
): { generated_questions: GeneratedQuestion[]; generated_questions_revision: number } {
  return {
    generated_questions: questions.map((question, j) => ({
      id: makeQuestionId(nowNanos, j),
      question,
      contentRevision,
    })),
    generated_questions_revision: contentRevision,
  };
}

/** 上游 `IsQuestionCurrent`：单个问题没记 revision 时回落到整块 revision。 */
export function areQuestionsCurrent(
  meta: { generated_questions?: GeneratedQuestion[]; generated_questions_revision?: number } | null,
  contentRevision: number,
): boolean {
  const list = meta?.generated_questions;
  if (!list || list.length === 0) return false;
  return list.every((q) => (q.contentRevision ?? meta?.generated_questions_revision ?? -1) === contentRevision);
}
