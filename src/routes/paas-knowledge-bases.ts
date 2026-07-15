/**
 * Agent PaaS: Knowledge Bases CRUD + Document upload + FTS5 search.
 *
 * MVP: 仅支持 Markdown 和纯文本，≤5MB，UTF-8。FTS5 全文检索。
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
  searchKbDocuments,
  type KnowledgeBaseRow,
  type KbDocumentRow,
} from '../db.js';
import {
  KnowledgeBaseCreateSchema,
  KnowledgeBasePatchSchema,
  KbSearchSchema,
} from '../schemas.js';
import type { KnowledgeBase, KbDocument, KbSearchResult } from '../types.js';
import { logger } from '../logger.js';
import {
  detectParser,
  sniffParserFromBuffer,
  parsePdf,
  parseDocx,
  fetchUrlContent,
} from '../document-parser.js';
import { triggerEmbeddingAsync } from '../embedding.js';

export const paasKbRoute = new Hono<{ Variables: Variables }>();

paasKbRoute.use('*', authMiddleware);

const MAX_DOC_BYTES = 10 * 1024 * 1024; // 10MB (raised in Phase 2 for PDF/DOCX)

function serializeKb(row: KnowledgeBaseRow): KnowledgeBase {
  return {
    id: row.id,
    userId: row.user_id,
    name: row.name,
    description: row.description,
    docCount: row.doc_count,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
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
  const row = createKnowledgeBase(
    user.id,
    validation.data.name,
    validation.data.description,
  );
  return c.json({ knowledge_base: serializeKb(row) }, 201);
});

paasKbRoute.get('/:id', (c) => {
  const user = c.get('user');
  const id = c.req.param('id');
  const row = getKnowledgeBase(id, user.id);
  if (!row) {
    return c.json({ error: 'Knowledge base not found' }, 404);
  }
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
  const row = updateKnowledgeBase(id, user.id, {
    name: validation.data.name,
    description: validation.data.description,
  });
  if (!row) {
    return c.json({ error: 'Knowledge base not found' }, 404);
  }
  return c.json({ knowledge_base: serializeKb(row) });
});

paasKbRoute.delete('/:id', (c) => {
  const user = c.get('user');
  const id = c.req.param('id');
  const ok = deleteKnowledgeBase(id, user.id);
  if (!ok) {
    return c.json({ error: 'Knowledge base not found' }, 404);
  }
  return c.json({ success: true });
});

paasKbRoute.get('/:id/documents', (c) => {
  const user = c.get('user');
  const id = c.req.param('id');
  const kb = getKnowledgeBase(id, user.id);
  if (!kb) {
    return c.json({ error: 'Knowledge base not found' }, 404);
  }
  const rows = listKbDocuments(id, user.id);
  // 不返回 content（列表场景），仅返回元信息
  const docs = rows.map((r) => ({
    id: r.id,
    kb_id: r.kb_id,
    filename: r.filename,
    content_hash: r.content_hash,
    size_bytes: r.size_bytes,
    created_at: r.created_at,
  }));
  return c.json({ documents: docs });
});

paasKbRoute.post('/:id/documents', async (c) => {
  const user = c.get('user');
  const id = c.req.param('id');
  const kb = getKnowledgeBase(id, user.id);
  if (!kb) {
    return c.json({ error: 'Knowledge base not found' }, 404);
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
  // Detect parser by name/mime first, then by magic bytes for mis-labeled uploads.
  let parserType = detectParser(file.name, file.type);
  if (!parserType) {
    parserType = sniffParserFromBuffer(buf);
  }
  if (!parserType) {
    return c.json(
      { error: 'Only .md / .txt / .pdf / .docx are supported' },
      400,
    );
  }
  let content: string;
  try {
    if (parserType === 'pdf') content = await parsePdf(buf);
    else if (parserType === 'docx') content = await parseDocx(buf);
    else content = buf.toString('utf8');
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
  try {
    const result = addKbDocument(id, user.id, file.name, content);
    if (result.duplicate) {
      return c.json(
        { error: 'Duplicate document (same content hash)', doc_id: result.row.id },
        409,
      );
    }
    const meta = {
      id: result.row.id,
      kb_id: result.row.kb_id,
      filename: result.row.filename,
      content_hash: result.row.content_hash,
      size_bytes: result.row.size_bytes,
      created_at: result.row.created_at,
      parser_type: parserType,
    };
    // Async embedding — fire-and-forget. Won't block the 201 response.
    triggerEmbeddingAsync(result.row.id, content).catch((err) =>
      logger.error({ err, docId: result.row.id }, 'Embedding trigger failed'),
    );
    return c.json({ document: meta }, 201);
  } catch (err) {
    logger.error({ err }, 'Failed to add KB document');
    return c.json({ error: 'Failed to add document' }, 500);
  }
});

// Phase 2: ingest content from a URL (server fetches + strips HTML)
paasKbRoute.post('/:id/documents/url', async (c) => {
  const user = c.get('user');
  const id = c.req.param('id');
  const kb = getKnowledgeBase(id, user.id);
  if (!kb) {
    return c.json({ error: 'Knowledge base not found' }, 404);
  }
  const body = await c.req.json().catch(() => ({}));
  const url = typeof body.url === 'string' ? body.url.trim() : '';
  if (!url) {
    return c.json({ error: 'Missing "url" field' }, 400);
  }
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
  // Filename derived from URL path; fall back to domain if empty.
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
    const meta = {
      id: result.row.id,
      kb_id: result.row.kb_id,
      filename: result.row.filename,
      content_hash: result.row.content_hash,
      size_bytes: result.row.size_bytes,
      created_at: result.row.created_at,
      source_url: url,
    };
    triggerEmbeddingAsync(result.row.id, content).catch((err) =>
      logger.error({ err, docId: result.row.id }, 'Embedding trigger failed'),
    );
    return c.json({ document: meta }, 201);
  } catch (err) {
    logger.error({ err }, 'Failed to add URL document');
    return c.json({ error: 'Failed to add document' }, 500);
  }
});

// Phase 2: re-embed a single document on demand (admin or owner)
paasKbRoute.post('/:id/documents/:docId/embed', async (c) => {
  const user = c.get('user');
  const id = c.req.param('id');
  const docId = c.req.param('docId');
  const kb = getKnowledgeBase(id, user.id);
  if (!kb) {
    return c.json({ error: 'Knowledge base not found' }, 404);
  }
  const { embedDocumentById } = await import('../embedding.js');
  const ok = await embedDocumentById(docId);
  if (!ok) {
    return c.json({ error: 'Embedding not configured or document not found' }, 400);
  }
  return c.json({ success: true, doc_id: docId });
});

// Phase 2: batch embed all un-embedded documents in a KB
paasKbRoute.post('/:id/embed-all', async (c) => {
  const user = c.get('user');
  const id = c.req.param('id');
  const kb = getKnowledgeBase(id, user.id);
  if (!kb) {
    return c.json({ error: 'Knowledge base not found' }, 404);
  }
  const { embedAllInKb } = await import('../embedding.js');
  const stats = await embedAllInKb(id);
  return c.json(stats);
});

paasKbRoute.delete('/:id/documents/:docId', (c) => {
  const user = c.get('user');
  const id = c.req.param('id');
  const docId = c.req.param('docId');
  const kb = getKnowledgeBase(id, user.id);
  if (!kb) {
    return c.json({ error: 'Knowledge base not found' }, 404);
  }
  const ok = deleteKbDocument(docId, user.id);
  if (!ok) {
    return c.json({ error: 'Document not found' }, 404);
  }
  return c.json({ success: true });
});

paasKbRoute.post('/:id/search', async (c) => {
  const user = c.get('user');
  const id = c.req.param('id');
  const kb = getKnowledgeBase(id, user.id);
  if (!kb) {
    return c.json({ error: 'Knowledge base not found' }, 404);
  }
  const body = await c.req.json().catch(() => ({}));
  const validation = KbSearchSchema.safeParse(body);
  if (!validation.success) {
    return c.json({ error: 'Invalid input', issues: validation.error.issues }, 400);
  }
  const limit = validation.data.limit ?? 5;
  const results = searchKbDocuments([id], validation.data.query, limit);
  return c.json({ results });
});

export default paasKbRoute;

export const _z = z; // prevent ts unused
