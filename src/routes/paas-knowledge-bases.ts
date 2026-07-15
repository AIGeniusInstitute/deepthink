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

export const paasKbRoute = new Hono<{ Variables: Variables }>();

paasKbRoute.use('*', authMiddleware);

const MAX_DOC_BYTES = 5 * 1024 * 1024; // 5MB

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
  const allowedTypes = [
    'text/markdown',
    'text/plain',
    'text/x-markdown',
    'application/octet-stream',
  ];
  const lowerName = file.name.toLowerCase();
  const extAllowed =
    lowerName.endsWith('.md') ||
    lowerName.endsWith('.markdown') ||
    lowerName.endsWith('.txt');
  if (!allowedTypes.includes(file.type) && !extAllowed) {
    return c.json(
      { error: 'Only Markdown (.md) and plain text (.txt) are supported in MVP' },
      400,
    );
  }
  let content: string;
  try {
    const buf = await file.arrayBuffer();
    content = Buffer.from(buf).toString('utf8');
  } catch {
    return c.json({ error: 'Failed to decode file as UTF-8' }, 400);
  }
  try {
    const result = addKbDocument(id, user.id, file.name, content);
    if (result.duplicate) {
      return c.json(
        { error: 'Duplicate document (same content hash)', doc_id: result.row.id },
        409,
      );
    }
    // 不返回完整 content 避免响应过大
    const meta = {
      id: result.row.id,
      kb_id: result.row.kb_id,
      filename: result.row.filename,
      content_hash: result.row.content_hash,
      size_bytes: result.row.size_bytes,
      created_at: result.row.created_at,
    };
    return c.json({ document: meta }, 201);
  } catch (err) {
    logger.error({ err }, 'Failed to add KB document');
    return c.json({ error: 'Failed to add document' }, 500);
  }
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
