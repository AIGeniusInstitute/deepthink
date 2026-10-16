/**
 * Agent PaaS: Knowledge Bases.
 *
 * CRUD + document ingest + chunk management + retrieval + retrieval-augmented
 * QA. Documents are parsed on upload, then split into chunks and embedded
 * asynchronously by the ingest pipeline; clients poll `parse_status` on the
 * document rather than holding the upload request open.
 */

import { Hono } from 'hono';
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
} from '../document-parser.js';
import {
  startIngestAsync,
  reparseDocument,
  cancelIngest,
  isIngesting,
} from '../kb/pipeline.js';
import { chunkText } from '../kb/chunker.js';
import { searchChunks, type Citation, type SearchHit } from '../kb/search.js';
import {
  answerQuestionStream,
  resolveQueryExpansion,
  resolveQueryUnderstanding,
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

const MAX_DOC_BYTES = 20 * 1024 * 1024; // 20MB — spreadsheets and decks need headroom

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
    embedded: !!row.embedding,
    embedding_model: row.embedding_model ?? null,
    created_at: row.created_at,
    updated_at: row.updated_at,
  };
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
  const row = createKnowledgeBase(user.id, validation.data.name, validation.data.description, {
    type,
    faqConfig,
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
  return c.json({ entry: serializeFaqEntry(row) }, 201);
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
  return c.json({ entry: serializeFaqEntry(row) });
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
    return c.json({ error: `File too large (max ${MAX_DOC_BYTES} bytes)` }, 400);
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
  let content: string;
  try {
    content = await parseByType(parserType, file.name, buf);
  } catch (err) {
    logger.warn({ err, filename: file.name, parserType }, 'Document parse failed');
    return c.json(
      { error: err instanceof Error ? err.message : 'Failed to parse document' },
      400,
    );
  }
  if (!content.trim()) {
    return c.json({ error: 'Parsed document is empty' }, 400);
  }

  const chunkConfig = readChunkConfig(formData);
  // 父子分块按库显式开启；未传时保持既有的单层分块行为。
  const parentChild = isTruthyFormFlag(formData.get('parent_child'));

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
