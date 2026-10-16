/**
 * Agent PaaS: Knowledge Bases.
 *
 * CRUD + document ingest + chunk management + retrieval + retrieval-augmented
 * QA. Documents are parsed on upload, then split into chunks and embedded
 * asynchronously by the ingest pipeline; clients poll `parse_status` on the
 * document rather than holding the upload request open.
 */

import { Hono, type Context } from 'hono';
import { z } from 'zod';
import type { Variables } from '../web-context.js';
import { authMiddleware } from '../middleware/auth.js';
import {
  listKnowledgeBases,
  getKnowledgeBase,
  createKnowledgeBase,
  updateKnowledgeBase,
  deleteKnowledgeBase,
  listKbDocuments,
  addKbDocument,
  addPendingKbDocument,
  deleteKbDocument,
  getKbDocument,
  getKbChunk,
  listChunksForDocument,
  updateKbChunkContent,
  deleteKbChunk,
  listKbChunkRevisions,
  revertKbChunkRevision,
  updateDocumentParseState,
  setDocumentParserType,
  clearKbVectorIndex,
  appendKbChatMessage,
  listKbChatMessages,
  deleteKbChatSession,
  countChunksForDocument,
  countEmbeddedChunksForDocument,
  KB_TYPE_FAQ,
  ensureFaqContainerDocument,
  createFaqEntry,
  updateFaqEntry,
  listFaqEntries,
  getFaqEntry,
  deleteFaqEntries,
  updateKnowledgeBaseFaqConfig,
  updateKnowledgeBaseQuestionGenerationConfig,
  type KnowledgeBaseRow,
  type KbDocumentRow,
  type KbChunkRow,
} from '../db.js';
import {
  DEFAULT_FAQ_CONFIG,
  parseFaqConfig,
  parseFaqMetadata,
  normalizeAnswerStrategy,
  normalizeIndexMode,
  normalizeQuestionIndexMode,
  type FaqMetadata,
} from '../kb/faq.js';
import {
  clampQuestionCount,
  parseQuestionGenerationConfig,
  serializeQuestionGenerationConfig,
  type GeneratedQuestion,
} from '../kb/doc2query.js';
import { generateQuestionsForKb } from '../kb/question-gen.js';
import {
  KnowledgeBaseCreateSchema,
  KnowledgeBasePatchSchema,
  KbSearchSchema,
  FaqEntrySchema,
  FaqEntryDeleteSchema,
} from '../schemas.js';
import type { KnowledgeBase, KbDocument } from '../types.js';
import { logger } from '../logger.js';
import {
  detectParser,
  sniffParserFromBuffer,
  sniffTextFromBuffer,
  parsePdf,
  parseDocx,
  parseHtml,
  parseDelimited,
  parseJson,
  fetchUrlContent,
  SUPPORTED_PARSERS,
  PdfHasNoTextLayerError,
} from '../document-parser.js';
import {
  startIngestAsync,
  reparseDocument,
  cancelIngest,
  isIngesting,
} from '../kb/pipeline.js';
import { startOcrIngestAsync, PARSER_TYPE_PDF_OCR } from '../kb/ocr-ingest.js';
import { getOcrConfig, ocrBaseUrl } from '../ocr.js';
import { isModelInstalled, probeLocalModelService } from '../local-model.js';
import { chunkText } from '../kb/chunker.js';
import { searchChunks, type Citation, type SearchHit } from '../kb/search.js';
import {
  answerQuestionStream,
  resolveQueryExpansion,
  resolveQueryUnderstanding,
  resolveRagConfig,
  type RagStreamEvent,
} from '../kb/rag.js';
import {
  embedText,
  getEmbeddingConfig,
  embedChunksForDocument,
  embedAllChunksInKb,
  syncVecDimensionFromConfig,
} from '../embedding.js';

export const paasKbRoute = new Hono<{ Variables: Variables }>();

paasKbRoute.use('*', authMiddleware);

const MAX_DOC_BYTES = 100 * 1024 * 1024; // 100MB — spreadsheets and decks need headroom

function serializeKb(row: KnowledgeBaseRow): KnowledgeBase {
  const type = row.type === KB_TYPE_FAQ ? KB_TYPE_FAQ : 'document';
  return {
    id: row.id,
    userId: row.user_id,
    name: row.name,
    description: row.description,
    docCount: row.doc_count,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
    type,
    // 上游对非 FAQ 库把 faq_config 清成 nil（EnsureDefaults，:772-774），
    // 这里同样只在 FAQ 库上回显，避免普通库看到一份无意义的默认配置。
    faqConfig: type === KB_TYPE_FAQ ? parseFaqConfig(row.faq_config) : null,
    // Doc2Query 配置对两种库都存在（FAQ 库用不上，但上游也没对它做区分），
    // 所以这里总是回显，关着就是 `{enabled:false,...}`。
    questionGenerationConfig: parseQuestionGenerationConfig(row.question_generation_config),
  };
}

function serializeDoc(row: KbDocumentRow): KbDocument {
  return {
    id: row.id,
    kbId: row.kb_id,
    userId: row.user_id,
    filename: row.filename,
    content: row.content,
    contentHash: row.content_hash,
    sizeBytes: row.size_bytes,
    createdAt: row.created_at,
    parserType: row.parser_type ?? null,
    embeddingModel: row.embedding_model ?? null,
    embedded: !!(row.embedding && row.embedding.length > 0),
  };
}

/** Document metadata without the (potentially huge) parsed body. */
function serializeDocMeta(row: KbDocumentRow): Record<string, unknown> {
  return {
    id: row.id,
    kb_id: row.kb_id,
    filename: row.filename,
    content_hash: row.content_hash,
    size_bytes: row.size_bytes,
    created_at: row.created_at,
    parser_type: row.parser_type ?? null,
    parse_status: row.parse_status ?? 'ready',
    parse_stage: row.parse_stage ?? null,
    error_message: row.error_message ?? null,
    chunk_count: row.chunk_count ?? 0,
    embedded_chunk_count: row.embedded_chunk_count ?? 0,
    embedding_dim: row.embedding_dim ?? null,
    processed_at: row.processed_at ?? null,
    stages: parseStages(row.stages_json),
  };
}

function parseStages(raw?: string | null): unknown[] {
  if (!raw) return [];
  try {
    const parsed = JSON.parse(raw);
    return Array.isArray(parsed) ? parsed : [];
  } catch {
    return [];
  }
}

function serializeChunk(row: KbChunkRow, withContent = true): Record<string, unknown> {
  return {
    id: row.id,
    kb_id: row.kb_id,
    doc_id: row.doc_id,
    chunk_index: row.chunk_index,
    content: withContent ? row.content : undefined,
    preview: row.content.slice(0, 200),
    char_count: row.content.length,
    heading_path: row.heading_path,
    start_at: row.start_at,
    end_at: row.end_at,
    pre_chunk_id: row.pre_chunk_id,
    next_chunk_id: row.next_chunk_id,
    is_enabled: !!row.is_enabled,
    chunk_type: row.chunk_type,
    // 子块靠这个字段回指父块；前端据此区分「父块 / 子块」。漏了它，库里明明有父子
    // 两层，界面上一律显示成普通分块。
    parent_chunk_id: row.parent_chunk_id ?? null,
    embedded: !!row.embedding,
    embedding_model: row.embedding_model ?? null,
    created_at: row.created_at,
    updated_at: row.updated_at,
    // Doc2Query 的产出挂在这里，前端看分块时能直接看到"这块能回答什么问题"。
    // 过期与否按 content_revision 判定，和上游 IsQuestionCurrent 同一套规则。
    content_revision: row.content_revision ?? 1,
    generated_questions: questionsOf(row).map((q) => q.question),
  };
}

/**
 * 分块自带 metadata，直接读它即可 —— 列表接口一次返回几百个分块，每个再回查
 * 一次库就是几百次多余查询。
 */
function questionsOf(row: KbChunkRow): GeneratedQuestion[] {
  if (!row.metadata) return [];
  try {
    const meta = JSON.parse(row.metadata) as { generated_questions?: unknown };
    const list = meta?.generated_questions;
    if (!Array.isArray(list)) return [];
    return list.filter(
      (q): q is GeneratedQuestion =>
        !!q && typeof q === 'object' && typeof (q as { question?: unknown }).question === 'string',
    );
  } catch {
    return [];
  }
}

/** Confirm the KB exists and belongs to the caller. */
function requireKb(kbId: string, userId: string): KnowledgeBaseRow | null {
  return getKnowledgeBase(kbId, userId);
}

/**
 * Wire shape of a retrieval hit. Every field a client needs to render and
 * verify a citation travels together — the offsets are what let the UI re-slice
 * the source document and show the user the surrounding text.
 */
function serializeHit(h: SearchHit): Record<string, unknown> {
  return {
    chunk_id: h.chunkId,
    doc_id: h.docId,
    kb_id: h.kbId,
    filename: h.filename,
    content: h.content,
    heading_path: h.headingPath,
    start_at: h.startAt,
    end_at: h.endAt,
    score: h.score,
    vector_score: h.vectorScore,
    keyword_score: h.keywordScore,
    source: h.source,
  };
}

// ─── Knowledge base CRUD ──────────────────────────────────

paasKbRoute.get('/', (c) => {
  const user = c.get('user');
  const rows = listKnowledgeBases(user.id);
  return c.json({ knowledge_bases: rows.map(serializeKb) });
});

paasKbRoute.post('/', async (c) => {
  const user = c.get('user');
  const body = await c.req.json().catch(() => ({}));
  const validation = KnowledgeBaseCreateSchema.safeParse(body);
  if (!validation.success) {
    return c.json({ error: 'Invalid input', issues: validation.error.issues }, 400);
  }
  const type = validation.data.type === KB_TYPE_FAQ ? KB_TYPE_FAQ : 'document';
  const requested = validation.data.faq_config;
  // 落库用上游的键名（snake_case），缺省项按 EnsureDefaults 补默认值。
  const faqConfig =
    type === KB_TYPE_FAQ
      ? JSON.stringify({
          index_mode: normalizeIndexMode(requested?.index_mode ?? DEFAULT_FAQ_CONFIG.indexMode),
          question_index_mode: normalizeQuestionIndexMode(
            requested?.question_index_mode ?? DEFAULT_FAQ_CONFIG.questionIndexMode,
          ),
        })
      : null;
  const qgRequested = validation.data.question_generation_config;
  const row = createKnowledgeBase(user.id, validation.data.name, validation.data.description, {
    type,
    faqConfig,
    questionGenerationConfig: qgRequested
      ? serializeQuestionGenerationConfig({
          enabled: qgRequested.enabled === true,
          questionCount: clampQuestionCount(qgRequested.question_count),
          customInstructions: qgRequested.custom_instructions ?? '',
        })
      : null,
  });
  return c.json({ knowledge_base: serializeKb(row) }, 201);
});

paasKbRoute.get('/:id', (c) => {
  const user = c.get('user');
  const row = requireKb(c.req.param('id'), user.id);
  if (!row) return c.json({ error: 'Knowledge base not found' }, 404);
  return c.json({ knowledge_base: serializeKb(row) });
});

paasKbRoute.patch('/:id', async (c) => {
  const user = c.get('user');
  const id = c.req.param('id');
  const body = await c.req.json().catch(() => ({}));
  const validation = KnowledgeBasePatchSchema.safeParse(body);
  if (!validation.success) {
    return c.json({ error: 'Invalid input', issues: validation.error.issues }, 400);
  }
  const existing = requireKb(id, user.id);
  if (!existing) return c.json({ error: 'Knowledge base not found' }, 404);

  // faq_config 只在 FAQ 库上有意义（上游 EnsureDefaults 对非 FAQ 库直接清空）。
  const requested = validation.data.faq_config;
  if (requested && existing.type === KB_TYPE_FAQ) {
    const current = parseFaqConfig(existing.faq_config);
    updateKnowledgeBaseFaqConfig(
      id,
      JSON.stringify({
        index_mode: normalizeIndexMode(requested.index_mode ?? current.indexMode),
        question_index_mode: normalizeQuestionIndexMode(
          requested.question_index_mode ?? current.questionIndexMode,
        ),
      }),
    );
  }

  // Doc2Query 配置是「部分更新」：没传的字段沿用现值，传了才覆盖。
  // 上游没有单独的更新接口，配置是随 KB 整体提交的；这里保留同样的语义但允许
  // 只改一个开关，否则前端每改一次 enabled 都要把 question_count 一起回填。
  const qgRequested = validation.data.question_generation_config;
  if (qgRequested) {
    const current = parseQuestionGenerationConfig(existing.question_generation_config);
    updateKnowledgeBaseQuestionGenerationConfig(
      id,
      serializeQuestionGenerationConfig({
        enabled: qgRequested.enabled ?? current.enabled,
        questionCount: clampQuestionCount(qgRequested.question_count ?? current.questionCount),
        customInstructions: qgRequested.custom_instructions ?? current.customInstructions,
      }),
    );
  }

  const row = updateKnowledgeBase(id, user.id, {
    name: validation.data.name,
    description: validation.data.description,
  });
  if (!row) return c.json({ error: 'Knowledge base not found' }, 404);
  return c.json({ knowledge_base: serializeKb(row) });
});

paasKbRoute.delete('/:id', (c) => {
  const user = c.get('user');
  const ok = deleteKnowledgeBase(c.req.param('id'), user.id);
  if (!ok) return c.json({ error: 'Knowledge base not found' }, 404);
  return c.json({ success: true });
});

// ─── FAQ entries ──────────────────────────────────────────
//
// 一条条目 = kb_chunks 里的一行（chunk_type='faq'），业务字段在 metadata JSON，
// 与上游一致。上传路径对 FAQ 库关闭——上游的报错原文是"FAQ 知识库不支持文件
// 上传，请使用 FAQ 导入功能"（`knowledge_create.go:61-63`）。

function serializeFaqEntry(row: KbChunkRow): Record<string, unknown> {
  const meta: FaqMetadata = parseFaqMetadata(row.metadata) ?? { standard_question: '' };
  return {
    id: row.id,
    chunk_id: row.id,
    knowledge_base_id: row.kb_id,
    standard_question: meta.standard_question,
    similar_questions: meta.similar_questions ?? [],
    negative_questions: meta.negative_questions ?? [],
    answers: meta.answers ?? [],
    answer_strategy: normalizeAnswerStrategy(meta.answer_strategy),
    version: meta.version ?? 1,
    is_enabled: !!row.is_enabled,
    content: row.content,
    content_hash: row.content_hash,
    embedded: !!row.embedding,
    updated_at: row.updated_at,
    created_at: row.created_at,
  };
}

/**
 * FAQ 条目落库后**立刻**建索引。
 *
 * 上游 `CreateFAQEntry` 就是同步索引（`knowledge_faq.go`：`indexFAQChunks` 成功
 * 才返回条目，失败则删掉刚建的 chunk），不是留给后续批处理 —— FAQ 库的条目本来
 * 也没有别的向量化入口。这里沿用这个语义，唯一区别是索引失败**不回滚**：条目已经
 * 落库，删掉用户刚填的内容比留一条列表里可见的「待向量化」（重存一次即重试）更糟。
 *
 * `embedChunksForDocument` 只挑 `embedding IS NULL` 的行，重复调用是幂等的；
 * 对 FAQ 行它走 `buildFaqIndexTexts`，所以 separate 模式下的相似问题会各占一条向量。
 */
async function indexFaqEntry(docId: string, kbId: string, entryId: string) {
  const stats = await embedChunksForDocument(docId).catch((err) => {
    logger.warn({ err, kbId }, 'FAQ 条目向量化请求失败，条目保持「待向量化」');
    return { attempted: 0, success: 0, failed: 0 };
  });
  if (stats.failed > 0) {
    logger.warn({ kbId, failed: stats.failed }, 'FAQ 条目向量化失败，条目保持「待向量化」');
  }
  return getKbChunk(entryId);
}

paasKbRoute.get('/:id/faq/entries', (c) => {
  const user = c.get('user');
  const kb = requireKb(c.req.param('id'), user.id);
  if (!kb) return c.json({ error: 'Knowledge base not found' }, 404);
  if (kb.type !== KB_TYPE_FAQ) {
    return c.json({ error: 'Not a FAQ knowledge base' }, 422);
  }
  const entries = listFaqEntries(kb.id).map(serializeFaqEntry);
  return c.json({ entries, total: entries.length });
});

paasKbRoute.get('/:id/faq/entries/:entryId', (c) => {
  const user = c.get('user');
  const kb = requireKb(c.req.param('id'), user.id);
  if (!kb || kb.type !== KB_TYPE_FAQ) {
    return c.json({ error: 'FAQ knowledge base not found' }, 404);
  }
  const row = getFaqEntry(c.req.param('entryId'));
  if (!row || row.kb_id !== kb.id) return c.json({ error: 'FAQ entry not found' }, 404);
  return c.json({ entry: serializeFaqEntry(row) });
});

paasKbRoute.post('/:id/faq/entries', async (c) => {
  const user = c.get('user');
  const kb = requireKb(c.req.param('id'), user.id);
  if (!kb || kb.type !== KB_TYPE_FAQ) {
    return c.json({ error: 'FAQ knowledge base not found' }, 404);
  }
  const body = await c.req.json().catch(() => ({}));
  const validation = FaqEntrySchema.safeParse(body);
  if (!validation.success) {
    return c.json({ error: 'Invalid input', issues: validation.error.issues }, 400);
  }
  const { indexMode } = parseFaqConfig(kb.faq_config);
  const container = ensureFaqContainerDocument(kb.id, user.id, kb.name);
  const row = createFaqEntry(container.id, kb.id, user.id, validation.data, indexMode);
  const indexed = await indexFaqEntry(container.id, kb.id, row.id);
  return c.json({ entry: serializeFaqEntry(indexed ?? row) }, 201);
});

paasKbRoute.put('/:id/faq/entries/:entryId', async (c) => {
  const user = c.get('user');
  const kb = requireKb(c.req.param('id'), user.id);
  if (!kb || kb.type !== KB_TYPE_FAQ) {
    return c.json({ error: 'FAQ knowledge base not found' }, 404);
  }
  const existing = getFaqEntry(c.req.param('entryId'));
  if (!existing || existing.kb_id !== kb.id) {
    return c.json({ error: 'FAQ entry not found' }, 404);
  }
  const body = await c.req.json().catch(() => ({}));
  const validation = FaqEntrySchema.safeParse(body);
  if (!validation.success) {
    return c.json({ error: 'Invalid input', issues: validation.error.issues }, 400);
  }
  const { indexMode } = parseFaqConfig(kb.faq_config);
  const row = updateFaqEntry(existing.id, validation.data, indexMode);
  if (!row) return c.json({ error: 'FAQ entry not found' }, 404);
  // 编辑会把 embedding 置空（内容变了，旧向量失效），所以这里必须重新索引，
  // 否则改过的条目就再也搜不到了。
  const indexed = await indexFaqEntry(row.doc_id, kb.id, row.id);
  return c.json({ entry: serializeFaqEntry(indexed ?? row) });
});

paasKbRoute.delete('/:id/faq/entries', async (c) => {
  const user = c.get('user');
  const kb = requireKb(c.req.param('id'), user.id);
  if (!kb || kb.type !== KB_TYPE_FAQ) {
    return c.json({ error: 'FAQ knowledge base not found' }, 404);
  }
  const body = await c.req.json().catch(() => ({}));
  const validation = FaqEntryDeleteSchema.safeParse(body);
  if (!validation.success) {
    return c.json({ error: 'Invalid input', issues: validation.error.issues }, 400);
  }
  // Only ids that really belong to this KB — an id from another KB must not be
  // deletable by guessing it.
  const owned = validation.data.ids.filter((id) => getFaqEntry(id)?.kb_id === kb.id);
  return c.json({ deleted: deleteFaqEntries(owned) });
});

// ─── Chunking preview ─────────────────────────────────────

const ChunkerPreviewSchema = z.object({
  text: z.string().min(1),
  chunk_size: z.number().int().positive().max(8192).optional(),
  chunk_overlap: z.number().int().min(0).max(4096).optional(),
  strategy: z.enum(['heading', 'heuristic', 'recursive', 'auto']).optional(),
  /** 启用父子分块（父块不参与 embedding，仅供命中后回溯上下文）。 */
  parent_child: z.boolean().optional(),
});

paasKbRoute.post('/:id/chunker/preview', async (c) => {
  const user = c.get('user');
  if (!requireKb(c.req.param('id'), user.id)) {
    return c.json({ error: 'Knowledge base not found' }, 404);
  }
  const body = await c.req.json().catch(() => ({}));
  const validation = ChunkerPreviewSchema.safeParse(body);
  if (!validation.success) {
    return c.json({ error: 'Invalid input', issues: validation.error.issues }, 400);
  }
  const { text, chunk_size, chunk_overlap, strategy } = validation.data;
  const chunks = chunkText(text, {
    chunkSize: chunk_size,
    chunkOverlap: chunk_overlap,
    ...(strategy && strategy !== 'auto' ? { strategy } : {}),
  });
  return c.json({
    chunks: chunks.map((ch) => ({
      index: ch.index,
      content: ch.content,
      heading_path: ch.headingPath,
      start_at: ch.startAt,
      end_at: ch.endAt,
      char_count: ch.content.length,
    })),
    total: chunks.length,
  });
});

// ─── Documents ────────────────────────────────────────────

paasKbRoute.get('/:id/documents', (c) => {
  const user = c.get('user');
  const id = c.req.param('id');
  if (!requireKb(id, user.id)) {
    return c.json({ error: 'Knowledge base not found' }, 404);
  }
  const rows = listKbDocuments(id, user.id);
  return c.json({ documents: rows.map(serializeDocMeta) });
});

paasKbRoute.post('/:id/documents', async (c) => {
  const user = c.get('user');
  const id = c.req.param('id');
  const kb = requireKb(id, user.id);
  if (!kb) {
    return c.json({ error: 'Knowledge base not found' }, 404);
  }
  // 上游同样禁止 FAQ 库走文件上传（`knowledge_create.go:61-63`）。
  if (kb.type === KB_TYPE_FAQ) {
    return c.json({ error: 'FAQ 知识库不支持文件上传，请使用 FAQ 条目接口' }, 422);
  }
  let formData: FormData;
  try {
    formData = await c.req.formData();
  } catch {
    return c.json({ error: 'Expected multipart form data with a file field' }, 400);
  }
  const file = formData.get('file');
  if (!(file instanceof File)) {
    return c.json({ error: 'Missing "file" field' }, 400);
  }
  if (file.size > MAX_DOC_BYTES) {
    return c.json({ error: `File too large (max ${MAX_DOC_BYTES / 1024 / 1024}MB)` }, 400);
  }
  let buf: Buffer;
  try {
    buf = Buffer.from(await file.arrayBuffer());
  } catch {
    return c.json({ error: 'Failed to read file' }, 400);
  }
  // Detect by name/mime first, then by magic bytes / text-ness for mis-labelled
  // uploads. Binary formats we cannot extract are rejected rather than indexed
  // as mojibake.
  let parserType = detectParser(file.name, file.type);
  if (!parserType) parserType = sniffParserFromBuffer(buf);
  if (!parserType) parserType = sniffTextFromBuffer(buf);
  if (!parserType) {
    return c.json(
      { error: `Unsupported file type. Supported: ${SUPPORTED_PARSERS.join(', ')}` },
      400,
    );
  }
  const chunkConfig = readChunkConfig(formData);
  // 父子分块按库显式开启；未传时保持既有的单层分块行为。
  const parentChild = isTruthyFormFlag(formData.get('parent_child'));

  let content: string;
  try {
    content = await parseByType(parserType, file.name, buf);
  } catch (err) {
    // 扫描件走的是一条独立通道：OCR 要跑几十分钟，不能在这个请求里等。
    if (err instanceof PdfHasNoTextLayerError) {
      return await startScannedPdfUpload(c, id, user.id, file.name, buf, {
        chunkConfig,
        parentChild,
      });
    }
    logger.warn({ err, filename: file.name, parserType }, 'Document parse failed');
    return c.json(
      { error: err instanceof Error ? err.message : 'Failed to parse document' },
      400,
    );
  }
  if (!content.trim()) {
    return c.json({ error: 'Parsed document is empty' }, 400);
  }

  try {
    const result = addKbDocument(id, user.id, file.name, content);
    if (result.duplicate) {
      return c.json(
        { error: 'Duplicate document (same content hash)', doc_id: result.row.id },
        409,
      );
    }
    const docId = result.row.id;
    updateDocumentParseState(docId, { parse_status: 'pending', error_message: null });
    setDocumentParserType(docId, parserType);
    // Chunking + embedding run in the background; the client polls parse_status.
    startIngestAsync(docId, { chunkConfig, parserType, parentChild });
    return c.json(
      { document: { ...serializeDocMeta(result.row), parser_type: parserType, parse_status: 'pending' } },
      201,
    );
  } catch (err) {
    logger.error({ err }, 'Failed to add KB document');
    return c.json({ error: 'Failed to add document' }, 500);
  }
});

/**
 * 扫描件通道：建一份「正文待定」的文档行，把 OCR 丢到后台，立刻返回 201。
 *
 * 这里**先检查 OCR 是否真的能跑**再建行。理由：OCR 失败要几十分钟后才暴露，
 * 而失败原因是「模型没装」这种上传前就已知的事 —— 让用户等半小时再看到
 * "识别失败"，不如当场告诉他去设置里启用。代价是扫描件上传多一次 3 秒内的探测。
 */
async function startScannedPdfUpload(
  c: Context<{ Variables: Variables }>,
  kbId: string,
  userId: string,
  filename: string,
  buf: Buffer,
  options: { chunkConfig: ReturnType<typeof readChunkConfig>; parentChild: boolean },
): Promise<Response> {
  const ocrCfg = getOcrConfig();
  if (!ocrCfg.enabled) {
    return c.json(
      {
        error:
          '该 PDF 没有文字层（扫描件），需要 OCR，但 OCR 当前未启用。请在「设置 → 本机模型服务」中启用扫描件 OCR 后重新上传。',
        code: 'ocr_disabled',
      },
      400,
    );
  }

  // 只在本机服务模式下探测；管理员显式配置了远端 OCR 服务时，探测本机 Ollama
  // 没有意义（那台服务可能是另一套）。
  if (!ocrCfg.baseUrl) {
    const service = await probeLocalModelService();
    if (!service.available) {
      return c.json(
        {
          error: `该 PDF 没有文字层（扫描件），需要 OCR，但本机模型服务不可用（${service.baseUrl}）：${service.error ?? '未启动'}。请在「设置 → 本机模型服务」中一键启用。`,
          code: 'local_model_unavailable',
        },
        400,
      );
    }
    if (!isModelInstalled(service.models, ocrCfg.model)) {
      return c.json(
        {
          error: `该 PDF 没有文字层（扫描件），需要 OCR，但视觉模型 ${ocrCfg.model} 尚未下载。请在「设置 → 本机模型服务」中下载后再上传。`,
          code: 'ocr_model_missing',
        },
        400,
      );
    }
  }

  const row = addPendingKbDocument(kbId, userId, filename);
  setDocumentParserType(row.id, PARSER_TYPE_PDF_OCR);
  startOcrIngestAsync(row.id, buf, {
    chunkConfig: options.chunkConfig,
    parentChild: options.parentChild,
  });
  return c.json(
    {
      document: {
        ...serializeDocMeta({ ...row, parser_type: PARSER_TYPE_PDF_OCR, parse_status: 'ocr' }),
        ocr: true,
      },
      ocr: { model: ocrCfg.model, baseUrl: ocrBaseUrl(ocrCfg) },
    },
    201,
  );
}

async function parseByType(parserType: string, filename: string, buf: Buffer): Promise<string> {
  switch (parserType) {
    case 'pdf':
      return parsePdf(buf);
    case 'docx':
      return parseDocx(buf);
    case 'html':
      return parseHtml(buf.toString('utf8'));
    case 'csv':
      return parseDelimited(buf.toString('utf8'), filename.toLowerCase().endsWith('.tsv') ? '\t' : ',');
    case 'json':
      return parseJson(buf.toString('utf8'));
    default:
      return buf.toString('utf8');
  }
}

/** Optional per-upload chunking overrides, sent as form fields. */
/** 表单布尔字段：接受 'true' / '1'。缺失或其它值一律视为关闭。 */
function isTruthyFormFlag(value: unknown): boolean {
  return value === 'true' || value === '1';
}

function readChunkConfig(formData: FormData): {
  chunkSize?: number;
  chunkOverlap?: number;
  strategy?: 'heading' | 'heuristic' | 'recursive' | 'auto';
} {
  const cfg: {
    chunkSize?: number;
    chunkOverlap?: number;
    strategy?: 'heading' | 'heuristic' | 'recursive' | 'auto';
  } = {};
  const size = formData.get('chunk_size');
  if (typeof size === 'string' && size.trim()) {
    const n = Number.parseInt(size, 10);
    if (Number.isFinite(n) && n > 0) cfg.chunkSize = n;
  }
  const overlap = formData.get('chunk_overlap');
  if (typeof overlap === 'string' && overlap.trim()) {
    const n = Number.parseInt(overlap, 10);
    if (Number.isFinite(n) && n >= 0) cfg.chunkOverlap = n;
  }
  const strategy = formData.get('strategy');
  if (strategy === 'heading' || strategy === 'heuristic' || strategy === 'recursive' || strategy === 'auto') {
    cfg.strategy = strategy;
  }
  return cfg;
}

paasKbRoute.post('/:id/documents/url', async (c) => {
  const user = c.get('user');
  const id = c.req.param('id');
  if (!requireKb(id, user.id)) {
    return c.json({ error: 'Knowledge base not found' }, 404);
  }
  const body = await c.req.json().catch(() => ({}));
  const url = typeof body.url === 'string' ? body.url.trim() : '';
  if (!url) return c.json({ error: 'Missing "url" field' }, 400);
  if (!/^https?:\/\//i.test(url)) {
    return c.json({ error: 'Only http(s) URLs are supported' }, 400);
  }
  let content: string;
  try {
    content = await fetchUrlContent(url);
  } catch (err) {
    logger.warn({ err, url }, 'URL fetch failed');
    return c.json(
      { error: err instanceof Error ? err.message : 'Failed to fetch URL' },
      400,
    );
  }
  if (!content.trim()) {
    return c.json({ error: 'Fetched URL has no text content' }, 400);
  }
  let fname: string;
  try {
    const u = new URL(url);
    const last = u.pathname.split('/').filter(Boolean).pop();
    fname = last ? decodeURIComponent(last) : `${u.hostname}.txt`;
  } catch {
    fname = 'url-content.txt';
  }
  try {
    const result = addKbDocument(id, user.id, fname, content);
    if (result.duplicate) {
      return c.json(
        { error: 'Duplicate document (same content hash)', doc_id: result.row.id },
        409,
      );
    }
    updateDocumentParseState(result.row.id, { parse_status: 'pending' });
    startIngestAsync(result.row.id, { parserType: 'url' });
    return c.json(
      { document: { ...serializeDocMeta(result.row), source_url: url, parse_status: 'pending' } },
      201,
    );
  } catch (err) {
    logger.error({ err }, 'Failed to add URL document');
    return c.json({ error: 'Failed to add document' }, 500);
  }
});

// Static-prefixed document routes are registered before the `/:id/...` family
// so a document id can never be shadowed by a knowledge-base id.
paasKbRoute.get('/documents/:docId', (c) => {
  const user = c.get('user');
  const doc = getKbDocument(c.req.param('docId'), user.id);
  if (!doc) return c.json({ error: 'Document not found' }, 404);
  return c.json({ document: serializeDocMeta(doc) });
});

/** Slice the original parsed text — this is what makes a citation verifiable. */
paasKbRoute.get('/documents/:docId/content', (c) => {
  const user = c.get('user');
  const doc = getKbDocument(c.req.param('docId'), user.id);
  if (!doc) return c.json({ error: 'Document not found' }, 404);
  const start = Number.parseInt(c.req.query('start') ?? '0', 10);
  const endRaw = c.req.query('end');
  const content = doc.content ?? '';
  const from = Number.isFinite(start) ? Math.max(0, Math.min(start, content.length)) : 0;
  const to = endRaw
    ? Math.max(from, Math.min(Number.parseInt(endRaw, 10) || 0, content.length))
    : content.length;
  return c.json({
    doc_id: doc.id,
    filename: doc.filename,
    total_chars: content.length,
    start_at: from,
    end_at: to,
    content: content.slice(from, to),
  });
});

paasKbRoute.get('/documents/:docId/chunks', (c) => {
  const user = c.get('user');
  const docId = c.req.param('docId');
  const doc = getKbDocument(docId, user.id);
  if (!doc) return c.json({ error: 'Document not found' }, 404);
  const rows = listChunksForDocument(docId);
  const withContent = c.req.query('full') === '1';
  return c.json({
    document: { id: doc.id, filename: doc.filename, parse_status: doc.parse_status ?? 'ready' },
    chunks: rows.map((r) => serializeChunk(r, withContent)),
    total: rows.length,
    ingesting: isIngesting(docId),
  });
});

paasKbRoute.post('/documents/:docId/reparse', async (c) => {
  const user = c.get('user');
  const docId = c.req.param('docId');
  const doc = getKbDocument(docId, user.id);
  if (!doc) return c.json({ error: 'Document not found' }, 404);
  if (isIngesting(docId)) {
    return c.json({ error: 'Document is already being processed' }, 409);
  }
  const body = await c.req.json().catch(() => ({}));
  const validation = ChunkerPreviewSchema.partial().safeParse(body);
  const cfg = validation.success
    ? {
        chunkSize: validation.data.chunk_size,
        chunkOverlap: validation.data.chunk_overlap,
        strategy:
          validation.data.strategy && validation.data.strategy !== 'auto'
            ? validation.data.strategy
            : undefined,
      }
    : {};
  // Return immediately; the client polls parse_status for the outcome.
  void reparseDocument(docId, { chunkConfig: cfg, parentChild: validation.data?.parent_child });
  return c.json({ success: true, doc_id: docId, parse_status: 'pending' }, 202);
});

paasKbRoute.post('/documents/:docId/cancel', (c) => {
  const user = c.get('user');
  const docId = c.req.param('docId');
  if (!getKbDocument(docId, user.id)) {
    return c.json({ error: 'Document not found' }, 404);
  }
  const ok = cancelIngest(docId);
  return c.json({ success: ok, message: ok ? undefined : 'No ingestion in progress' });
});

paasKbRoute.delete('/:id/documents/:docId', (c) => {
  const user = c.get('user');
  const id = c.req.param('id');
  if (!requireKb(id, user.id)) {
    return c.json({ error: 'Knowledge base not found' }, 404);
  }
  const ok = deleteKbDocument(c.req.param('docId'), user.id);
  if (!ok) return c.json({ error: 'Document not found' }, 404);
  return c.json({ success: true });
});

// ─── Chunks ───────────────────────────────────────────────

paasKbRoute.get('/chunks/:chunkId', (c) => {
  const user = c.get('user');
  const chunk = getKbChunk(c.req.param('chunkId'));
  if (!chunk || chunk.user_id !== user.id) {
    return c.json({ error: 'Chunk not found' }, 404);
  }
  return c.json({ chunk: serializeChunk(chunk) });
});

paasKbRoute.put('/chunks/:chunkId', async (c) => {
  const user = c.get('user');
  const chunkId = c.req.param('chunkId');
  const chunk = getKbChunk(chunkId);
  if (!chunk || chunk.user_id !== user.id) {
    return c.json({ error: 'Chunk not found' }, 404);
  }
  const body = await c.req.json().catch(() => ({}));
  const content = typeof body.content === 'string' ? body.content : '';
  if (!content.trim()) return c.json({ error: 'content must be non-empty' }, 400);
  const updated = updateKbChunkContent(chunkId, content);
  return c.json({ chunk: serializeChunk(updated!) });
});

paasKbRoute.delete('/chunks/:chunkId', (c) => {
  const user = c.get('user');
  const chunkId = c.req.param('chunkId');
  const chunk = getKbChunk(chunkId);
  if (!chunk || chunk.user_id !== user.id) {
    return c.json({ error: 'Chunk not found' }, 404);
  }
  deleteKbChunk(chunkId);
  return c.json({ success: true });
});

paasKbRoute.get('/chunks/:chunkId/revisions', (c) => {
  const user = c.get('user');
  const chunkId = c.req.param('chunkId');
  const chunk = getKbChunk(chunkId);
  if (!chunk || chunk.user_id !== user.id) {
    return c.json({ error: 'Chunk not found' }, 404);
  }
  return c.json({ revisions: listKbChunkRevisions(chunkId) });
});

paasKbRoute.post('/chunks/:chunkId/revert', async (c) => {
  const user = c.get('user');
  const chunkId = c.req.param('chunkId');
  const chunk = getKbChunk(chunkId);
  if (!chunk || chunk.user_id !== user.id) {
    return c.json({ error: 'Chunk not found' }, 404);
  }
  const body = await c.req.json().catch(() => ({}));
  const revisionId = typeof body.revision_id === 'string' ? body.revision_id : '';
  if (!revisionId) return c.json({ error: 'Missing revision_id' }, 400);
  const reverted = revertKbChunkRevision(chunkId, revisionId);
  if (!reverted) return c.json({ error: 'Revision not found' }, 404);
  return c.json({ chunk: serializeChunk(reverted) });
});

// ─── Embedding maintenance ────────────────────────────────

paasKbRoute.post('/:id/documents/:docId/embed', async (c) => {
  const user = c.get('user');
  const id = c.req.param('id');
  const docId = c.req.param('docId');
  if (!requireKb(id, user.id)) {
    return c.json({ error: 'Knowledge base not found' }, 404);
  }
  if (!getKbDocument(docId, user.id)) {
    return c.json({ error: 'Document not found' }, 404);
  }
  if (!getEmbeddingConfig()) {
    return c.json({ error: 'Embedding is not configured' }, 400);
  }
  const stats = await embedChunksForDocument(docId);
  updateDocumentParseState(docId, {
    embedded_chunk_count: countEmbeddedChunksForDocument(docId),
  });
  return c.json({ doc_id: docId, ...stats });
});

paasKbRoute.post('/:id/embed-all', async (c) => {
  const user = c.get('user');
  const id = c.req.param('id');
  if (!requireKb(id, user.id)) {
    return c.json({ error: 'Knowledge base not found' }, 404);
  }
  return c.json(await embedAllChunksInKb(id));
});

/**
 * Drop and refill the vector index for a KB. Used after an embedding-model
 * change, and to bring pre-chunk documents onto the chunk index.
 */
paasKbRoute.post('/:id/rebuild-index', async (c) => {
  const user = c.get('user');
  const id = c.req.param('id');
  const kb = requireKb(id, user.id);
  if (!kb) return c.json({ error: 'Knowledge base not found' }, 404);

  const dimensionChanged = syncVecDimensionFromConfig();
  if (dimensionChanged) clearKbVectorIndex(id);

  // Documents that predate the chunk layer have no chunks yet.
  const stale = listKbDocuments(id, user.id).filter((d) => countChunksForDocument(d.id) === 0);
  for (const d of stale) startIngestAsync(d.id);

  const stats = await embedAllChunksInKb(id, 200);
  return c.json({
    dimension_changed: dimensionChanged,
    rechunked_documents: stale.length,
    ...stats,
  });
});

/**
 * Doc2Query：给知识库里所有合格分块预生成"这段能回答的问题"，编进向量索引。
 *
 * 上游把这件事放在入库后处理里自动跑（`question:generation` 异步任务），本仓库
 * 是单进程，改成显式触发 —— 生成要调 LLM，几百个分块就是几百次调用，挂在上传
 * 请求里会把上传拖成分钟级。同步返回统计，前端据此提示。
 *
 * 未开启或没配 chat 模型时返回 `disabled: true` 而不是报错：没配模型不是错误，
 * 只是这个能力用不了。
 */
paasKbRoute.post('/:id/generate-questions', async (c) => {
  const user = c.get('user');
  const id = c.req.param('id');
  const kb = requireKb(id, user.id);
  if (!kb) return c.json({ error: 'Knowledge base not found' }, 404);

  const rag = resolveRagConfig();
  const result = await generateQuestionsForKb(
    id,
    rag ? { baseUrl: rag.baseUrl, apiKey: rag.apiKey, model: rag.model } : null,
  );
  if (result.disabled) {
    return c.json({
      ...result,
      error: '问题生成未开启或未配置问答模型（data/config/rag.json 的 model）',
    }, 400);
  }
  return c.json({ kb_id: id, ...result });
});

// ─── Search ───────────────────────────────────────────────

const SearchSchema = KbSearchSchema.extend({
  mode: z.enum(['keyword', 'vector', 'hybrid']).optional(),
  kb_ids: z.array(z.string()).optional(),
  top_k: z.number().int().positive().max(200).optional(),
  min_score: z.number().min(0).max(1).optional(),
  rerank: z.boolean().optional(),
  enable_query_expansion: z.boolean().optional(),
  debug: z.boolean().optional(),
});

paasKbRoute.post('/:id/search', async (c) => {
  const user = c.get('user');
  const id = c.req.param('id');
  if (!requireKb(id, user.id)) {
    return c.json({ error: 'Knowledge base not found' }, 404);
  }
  const body = await c.req.json().catch(() => ({}));
  const validation = SearchSchema.safeParse(body);
  if (!validation.success) {
    return c.json({ error: 'Invalid input', issues: validation.error.issues }, 400);
  }
  const data = validation.data;
  // Only KBs the caller owns may enter a search, whatever ids were supplied.
  const requested = data.kb_ids?.length ? data.kb_ids : [id];
  const kbIds = requested.filter((kbId) => requireKb(kbId, user.id) !== null);
  if (kbIds.length === 0) {
    return c.json({ error: 'No accessible knowledge bases in scope' }, 403);
  }

  const embedding = getEmbeddingConfig() ? await embedText(data.query) : null;
  const { hits, debug } = await searchChunks({
    kbIds,
    query: data.query,
    limit: data.top_k ?? data.limit ?? 5,
    mode: data.mode ?? 'hybrid',
    queryEmbedding: embedding,
    minScore: data.min_score,
    useRerank: data.rerank,
    enableQueryExpansion: resolveQueryExpansion(data.enable_query_expansion),
    debug: data.debug,
  });

  return c.json({
    // `results` keeps the pre-existing shape so older clients keep working.
    results: hits.map((h) => ({
      doc_id: h.docId,
      kb_id: h.kbId,
      filename: h.filename,
      snippet: h.content.slice(0, 200).replace(/\s+/g, ' ').trim(),
      rank: h.score,
    })),
    hits: hits.map(serializeHit),
    ...(debug ? { debug } : {}),
  });
});

/** Cross-KB search across every KB the caller owns. */
paasKbRoute.post('/search/all', async (c) => {
  const user = c.get('user');
  const body = await c.req.json().catch(() => ({}));
  const validation = SearchSchema.safeParse(body);
  if (!validation.success) {
    return c.json({ error: 'Invalid input', issues: validation.error.issues }, 400);
  }
  const data = validation.data;
  const owned = listKnowledgeBases(user.id).map((k) => k.id);
  const kbIds = data.kb_ids?.length
    ? data.kb_ids.filter((kbId) => owned.includes(kbId))
    : owned;
  if (kbIds.length === 0) return c.json({ hits: [], results: [] });

  const embedding = getEmbeddingConfig() ? await embedText(data.query) : null;
  const { hits, debug } = await searchChunks({
    kbIds,
    query: data.query,
    limit: data.top_k ?? data.limit ?? 5,
    mode: data.mode ?? 'hybrid',
    queryEmbedding: embedding,
    minScore: data.min_score,
    useRerank: data.rerank,
    enableQueryExpansion: resolveQueryExpansion(data.enable_query_expansion),
    debug: data.debug,
  });
  return c.json({ hits: hits.map(serializeHit), ...(debug ? { debug } : {}) });
});

// ─── Retrieval-augmented QA ───────────────────────────────

const ChatSchema = z.object({
  question: z.string().min(1),
  session_id: z.string().optional(),
  kb_ids: z.array(z.string()).optional(),
  top_k: z.number().int().positive().max(50).optional(),
  mode: z.enum(['keyword', 'vector', 'hybrid']).optional(),
  min_score: z.number().min(0).max(1).optional(),
  rerank: z.boolean().optional(),
  enable_query_expansion: z.boolean().optional(),
  enable_query_understanding: z.boolean().optional(),
  language: z.string().max(35).optional(),
  stream: z.boolean().optional(),
});

paasKbRoute.post('/chat', async (c) => {
  const user = c.get('user');
  const body = await c.req.json().catch(() => ({}));
  const validation = ChatSchema.safeParse(body);
  if (!validation.success) {
    return c.json({ error: 'Invalid input', issues: validation.error.issues }, 400);
  }
  const data = validation.data;
  const owned = listKnowledgeBases(user.id).map((k) => k.id);
  const kbIds = (data.kb_ids?.length ? data.kb_ids : owned).filter((kbId) =>
    owned.includes(kbId),
  );
  if (kbIds.length === 0) {
    return c.json({ error: 'No accessible knowledge bases' }, 403);
  }

  const sessionId = data.session_id || crypto.randomUUID();
  const history = listKbChatMessages(sessionId, user.id, 20).map((m) => ({
    role: m.role as 'user' | 'assistant',
    content: m.content,
  }));
  appendKbChatMessage({
    sessionId,
    userId: user.id,
    role: 'user',
    content: data.question,
  });

  const request = {
    kbIds,
    question: data.question,
    history,
    mode: data.mode,
    topK: data.top_k,
    useRerank: data.rerank,
    minScore: data.min_score,
    enableQueryExpansion: resolveQueryExpansion(data.enable_query_expansion),
    enableQueryUnderstanding: resolveQueryUnderstanding(data.enable_query_understanding),
    language: data.language,
  };

  if (data.stream === false) {
    const { answerQuestion } = await import('../kb/rag.js');
    const result = await answerQuestion(request);
    appendKbChatMessage({
      sessionId,
      userId: user.id,
      role: 'assistant',
      content: result.answer,
      citations: result.citations,
    });
    return c.json({
      session_id: sessionId,
      answer: result.answer,
      citations: result.citations,
      usage: result.usage,
      fallback: result.fallback,
    });
  }

  // Server-sent events: citations arrive first so sources can render while the
  // model is still producing tokens.
  const encoder = new TextEncoder();
  const stream = new ReadableStream<Uint8Array>({
    async start(controller) {
      const send = (event: RagStreamEvent | { type: 'session'; session_id: string }): void => {
        controller.enqueue(encoder.encode(`data: ${JSON.stringify(event)}\n\n`));
      };
      send({ type: 'session', session_id: sessionId });
      let finalAnswer = '';
      let citations: Citation[] = [];
      try {
        for await (const event of answerQuestionStream(request)) {
          if (event.type === 'citations') citations = event.citations;
          if (event.type === 'done') finalAnswer = event.answer;
          send(event);
        }
      } catch (err) {
        logger.warn({ err }, 'KB chat stream failed');
        send({ type: 'error', message: err instanceof Error ? err.message : String(err) });
      }
      // Persist the assistant turn so a reload replays the same citations.
      if (finalAnswer) {
        try {
          appendKbChatMessage({
            sessionId,
            userId: user.id,
            role: 'assistant',
            content: finalAnswer,
            citations,
          });
        } catch (err) {
          logger.warn({ err }, 'Failed to persist KB chat assistant message');
        }
      }
      controller.enqueue(encoder.encode('data: [DONE]\n\n'));
      controller.close();
    },
  });

  return new Response(stream, {
    headers: {
      'Content-Type': 'text/event-stream; charset=utf-8',
      'Cache-Control': 'no-cache, no-transform',
      Connection: 'keep-alive',
      'X-Accel-Buffering': 'no',
    },
  });
});

paasKbRoute.get('/chat/sessions/:sessionId/messages', (c) => {
  const user = c.get('user');
  const sessionId = c.req.param('sessionId');
  const rows = listKbChatMessages(sessionId, user.id, 200);
  return c.json({
    session_id: sessionId,
    messages: rows.map((r) => ({
      id: r.id,
      role: r.role,
      content: r.content,
      citations: (() => {
        try {
          return JSON.parse(r.citations_json);
        } catch {
          return [];
        }
      })(),
      created_at: r.created_at,
    })),
  });
});

paasKbRoute.delete('/chat/sessions/:sessionId', (c) => {
  const user = c.get('user');
  const removed = deleteKbChatSession(c.req.param('sessionId'), user.id);
  return c.json({ success: removed > 0, removed });
});

export default paasKbRoute;
