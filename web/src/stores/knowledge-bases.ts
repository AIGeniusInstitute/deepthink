import { create } from 'zustand';
import { api, apiFetch } from '../api/client';

export interface KbDocumentMeta {
  id: string;
  kb_id: string;
  filename: string;
  content_hash: string;
  size_bytes: number;
  created_at: string;
  parser_type?: string | null;
  embedding_model?: string | null;
  embedded: boolean;
  parse_status?: string | null;
  parse_stage?: string | null;
  error_message?: string | null;
  chunk_count?: number | null;
  embedded_chunk_count?: number | null;
  processed_at?: string | null;
  stages?: Array<{ stage: string; status: string; ms: number; detail?: string }>;
}

export interface FaqConfig {
  indexMode: 'question_only' | 'question_answer';
  questionIndexMode: 'combined' | 'separate';
}

export interface KnowledgeBase {
  id: string;
  userId: string;
  name: string;
  description: string;
  docCount: number;
  createdAt: string;
  updatedAt: string;
  /** `faq` 库只走向量检索、只能放 FAQ 条目、不接受文件上传。 */
  type?: 'document' | 'faq';
  faqConfig?: FaqConfig | null;
  /** Doc2Query 预生成问题（上游 question_generation_config）。 */
  questionGenerationConfig?: QuestionGenerationConfig;
}

export interface QuestionGenerationConfig {
  enabled: boolean;
  questionCount: number;
  customInstructions: string;
}

/** 一次问题生成的统计。`disabled` 为真时其余字段无意义。 */
export interface QuestionGenStats {
  eligible: number;
  generated: number;
  questions: number;
  skipped: number;
  stale: number;
  disabled?: boolean;
}

/** 一条 FAQ 条目。字段在网络上统一是 snake_case，与后端零翻译。 */
export interface KbFaqEntry {
  id: string;
  chunk_id: string;
  knowledge_base_id: string;
  standard_question: string;
  similar_questions: string[];
  negative_questions: string[];
  answers: string[];
  answer_strategy: 'all' | 'random';
  version: number;
  is_enabled: boolean;
  content: string;
  content_hash: string;
  embedded: boolean;
  updated_at: string;
  created_at: string;
}

export interface FaqEntryInput {
  standard_question: string;
  similar_questions?: string[];
  negative_questions?: string[];
  answers?: string[];
  answer_strategy?: 'all' | 'random';
  is_enabled?: boolean;
}

/** 一条检索命中：内容 + 可回源核验的字符偏移。 */
export interface KbHit {
  chunk_id: string;
  doc_id: string;
  kb_id: string;
  filename: string;
  content: string;
  heading_path: string | null;
  start_at: number;
  end_at: number;
  score: number;
  vector_score: number | null;
  keyword_score: number | null;
  source: 'vector' | 'keyword' | 'hybrid';
}

export interface KbChunk {
  id: string;
  kb_id: string;
  doc_id: string;
  chunk_index: number;
  content?: string;
  preview: string;
  char_count: number;
  heading_path: string | null;
  start_at: number;
  end_at: number;
  is_enabled: boolean;
  embedded: boolean;
  embedding_model?: string | null;
  /** 正文版本号；改动一次加一，预生成问题靠它判断是否过期。 */
  content_revision?: number;
  /** Doc2Query 为该分块预生成的问题（只进向量索引，不是分块正文的一部分）。 */
  generated_questions?: string[];
}

export interface KbCitation {
  chunk_id: string;
  doc_id: string;
  kb_id: string;
  filename: string;
  heading_path: string | null;
  start_at: number;
  end_at: number;
  content: string;
  score: number;
}

export interface KbChatMessage {
  id?: string;
  role: 'user' | 'assistant';
  content: string;
  citations?: KbCitation[];
  created_at?: string;
}

export interface KbSearchParams {
  mode?: 'keyword' | 'vector' | 'hybrid';
  top_k?: number;
  min_score?: number;
  rerank?: boolean;
  debug?: boolean;
}

export interface ChunkConfigInput {
  strategy?: 'auto' | 'heading' | 'heuristic' | 'recursive';
  chunk_size?: number;
  chunk_overlap?: number;
}

interface KbState {
  list: KnowledgeBase[];
  loading: boolean;
  error: string | null;
  load: () => Promise<void>;
  get: (id: string) => Promise<KnowledgeBase | null>;
  create: (name: string, description: string, type?: 'document' | 'faq') => Promise<KnowledgeBase | null>;
  remove: (id: string) => Promise<boolean>;
  updateFaqConfig: (kbId: string, config: Partial<FaqConfig>) => Promise<KnowledgeBase | null>;
  updateQuestionGenConfig: (
    kbId: string,
    config: Partial<QuestionGenerationConfig>,
  ) => Promise<KnowledgeBase | null>;
  generateQuestions: (kbId: string) => Promise<{ ok: boolean; error?: string; stats?: QuestionGenStats }>;
  listFaqEntries: (kbId: string) => Promise<KbFaqEntry[]>;
  createFaqEntry: (kbId: string, input: FaqEntryInput) => Promise<{ ok: boolean; error?: string; entry?: KbFaqEntry }>;
  updateFaqEntry: (kbId: string, entryId: string, input: FaqEntryInput) => Promise<{ ok: boolean; error?: string; entry?: KbFaqEntry }>;
  deleteFaqEntries: (kbId: string, ids: string[]) => Promise<number>;
  listDocuments: (kbId: string) => Promise<KbDocumentMeta[]>;
  getDocument: (docId: string) => Promise<KbDocumentMeta | null>;
  uploadDocument: (kbId: string, file: File, cfg?: ChunkConfigInput) => Promise<{ ok: boolean; error?: string }>;
  uploadFromUrl: (kbId: string, url: string) => Promise<{ ok: boolean; error?: string }>;
  removeDocument: (kbId: string, docId: string) => Promise<boolean>;
  reparseDocument: (docId: string, cfg?: ChunkConfigInput) => Promise<boolean>;
  cancelIngest: (docId: string) => Promise<boolean>;
  getDocumentContent: (docId: string, start?: number, end?: number) => Promise<string>;
  listChunks: (docId: string, full?: boolean) => Promise<KbChunk[]>;
  updateChunk: (chunkId: string, content: string) => Promise<KbChunk | null>;
  removeChunk: (chunkId: string) => Promise<boolean>;
  listChunkRevisions: (chunkId: string) => Promise<Array<{ id: string; content: string; created_at: string }>>;
  revertChunk: (chunkId: string, revisionId: string) => Promise<KbChunk | null>;
  previewChunks: (kbId: string, text: string, cfg?: ChunkConfigInput) => Promise<KbChunk[]>;
  search: (kbId: string, query: string, params?: KbSearchParams) => Promise<{ hits: KbHit[]; debug?: any }>;
  rebuildIndex: (kbId: string) => Promise<{
    dimension_changed?: boolean;
    rechunked_documents?: number;
    attempted?: number;
    success?: number;
    failed?: number;
  } | null>;
  listChatMessages: (sessionId: string) => Promise<KbChatMessage[]>;
  clearChatSession: (sessionId: string) => Promise<boolean>;
}

/** 子资源路径统一挂在这个前缀下，避免各处重复拼串。 */
const KB_API = '/api/paas/knowledge-bases';

export const useKnowledgeBasesStore = create<KbState>((set, get) => ({
  list: [],
  loading: false,
  error: null,
  load: async () => {
    set({ loading: true, error: null });
    try {
      const res = await api.get<{ knowledge_bases: KnowledgeBase[] }>(KB_API);
      set({ list: res.knowledge_bases ?? [], loading: false });
    } catch (e: any) {
      set({ loading: false, error: e?.message ?? 'Load failed' });
    }
  },
  get: async (id) => {
    try {
      const res = await api.get<{ knowledge_base: KnowledgeBase }>(`${KB_API}/${id}`);
      return res.knowledge_base;
    } catch {
      return null;
    }
  },
  create: async (name, description, type) => {
    try {
      const res = await api.post<{ knowledge_base: KnowledgeBase }>(KB_API, {
        name,
        description,
        ...(type ? { type } : {}),
      });
      await get().load();
      return res.knowledge_base;
    } catch {
      return null;
    }
  },
  remove: async (id) => {
    try {
      await api.delete(`${KB_API}/${id}`);
      await get().load();
      return true;
    } catch {
      return false;
    }
  },
  updateFaqConfig: async (kbId, config) => {
    try {
      const res = await api.patch<{ knowledge_base: KnowledgeBase }>(`${KB_API}/${kbId}`, {
        faq_config: {
          ...(config.indexMode ? { index_mode: config.indexMode } : {}),
          ...(config.questionIndexMode ? { question_index_mode: config.questionIndexMode } : {}),
        },
      });
      return res.knowledge_base;
    } catch {
      return null;
    }
  },
  updateQuestionGenConfig: async (kbId, config) => {
    try {
      const res = await api.patch<{ knowledge_base: KnowledgeBase }>(`${KB_API}/${kbId}`, {
        question_generation_config: {
          ...(config.enabled !== undefined ? { enabled: config.enabled } : {}),
          ...(config.questionCount !== undefined ? { question_count: config.questionCount } : {}),
          ...(config.customInstructions !== undefined
            ? { custom_instructions: config.customInstructions }
            : {}),
        },
      });
      return res.knowledge_base;
    } catch {
      return null;
    }
  },
  generateQuestions: async (kbId) => {
    try {
      const stats = await api.post<QuestionGenStats>(`${KB_API}/${kbId}/generate-questions`, {});
      return { ok: true, stats };
    } catch (err) {
      return { ok: false, error: err instanceof Error ? err.message : '生成失败' };
    }
  },
  listFaqEntries: async (kbId) => {
    const res = await api.get<{ entries: KbFaqEntry[] }>(`${KB_API}/${kbId}/faq/entries`);
    return res.entries ?? [];
  },
  createFaqEntry: async (kbId, input) => {
    try {
      const res = await api.post<{ entry: KbFaqEntry }>(`${KB_API}/${kbId}/faq/entries`, input);
      return { ok: true, entry: res.entry };
    } catch (e: any) {
      return { ok: false, error: e?.message ?? '创建失败' };
    }
  },
  updateFaqEntry: async (kbId, entryId, input) => {
    try {
      const res = await api.put<{ entry: KbFaqEntry }>(`${KB_API}/${kbId}/faq/entries/${entryId}`, input);
      return { ok: true, entry: res.entry };
    } catch (e: any) {
      return { ok: false, error: e?.message ?? '保存失败' };
    }
  },
  deleteFaqEntries: async (kbId, ids) => {
    try {
      // api.delete 不带 body，而批量删除的 id 列表在 body 里，所以直接用 apiFetch。
      const res = await apiFetch<{ deleted: number }>(`${KB_API}/${kbId}/faq/entries`, {
        method: 'DELETE',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ ids }),
      });
      return res?.deleted ?? 0;
    } catch {
      return 0;
    }
  },
  listDocuments: async (kbId) => {
    const res = await api.get<{ documents: KbDocumentMeta[] }>(`${KB_API}/${kbId}/documents`);
    return res.documents ?? [];
  },
  getDocument: async (docId) => {
    try {
      const res = await api.get<{ document: KbDocumentMeta }>(`${KB_API}/documents/${docId}`);
      return res.document;
    } catch {
      return null;
    }
  },
  uploadDocument: async (kbId, file, cfg) => {
    const fd = new FormData();
    fd.append('file', file);
    if (cfg?.strategy) fd.append('strategy', cfg.strategy);
    if (cfg?.chunk_size) fd.append('chunk_size', String(cfg.chunk_size));
    if (cfg?.chunk_overlap !== undefined) fd.append('chunk_overlap', String(cfg.chunk_overlap));
    try {
      await apiFetch<{ document: KbDocumentMeta }>(`${KB_API}/${kbId}/documents`, {
        method: 'POST',
        body: fd,
        // 上传本身只做解析；切块与向量化在后台流水线里跑，所以不需要长超时。
        timeoutMs: 120_000,
      });
      return { ok: true };
    } catch (e: any) {
      return { ok: false, error: e?.message ?? '上传失败' };
    }
  },
  uploadFromUrl: async (kbId, url) => {
    try {
      await api.post(`${KB_API}/${kbId}/documents/url`, { url }, 30_000);
      return { ok: true };
    } catch (e: any) {
      return { ok: false, error: e?.message ?? 'URL 抓取失败' };
    }
  },
  removeDocument: async (kbId, docId) => {
    try {
      await api.delete(`${KB_API}/${kbId}/documents/${docId}`);
      return true;
    } catch {
      return false;
    }
  },
  reparseDocument: async (docId, cfg) => {
    try {
      await api.post(`${KB_API}/documents/${docId}/reparse`, cfg ?? {});
      return true;
    } catch {
      return false;
    }
  },
  cancelIngest: async (docId) => {
    try {
      await api.post(`${KB_API}/documents/${docId}/cancel`, {});
      return true;
    } catch {
      return false;
    }
  },
  getDocumentContent: async (docId, start, end) => {
    const qs = new URLSearchParams();
    if (start !== undefined) qs.set('start', String(start));
    if (end !== undefined) qs.set('end', String(end));
    const res = await api.get<{ content: string }>(
      `${KB_API}/documents/${docId}/content${qs.toString() ? `?${qs}` : ''}`,
    );
    return res.content ?? '';
  },
  listChunks: async (docId, full = false) => {
    const res = await api.get<{ chunks: KbChunk[] }>(
      `${KB_API}/documents/${docId}/chunks${full ? '?full=1' : ''}`,
    );
    return res.chunks ?? [];
  },
  updateChunk: async (chunkId, content) => {
    try {
      const res = await api.put<{ chunk: KbChunk }>(`${KB_API}/chunks/${chunkId}`, { content });
      return res.chunk;
    } catch {
      return null;
    }
  },
  removeChunk: async (chunkId) => {
    try {
      await api.delete(`${KB_API}/chunks/${chunkId}`);
      return true;
    } catch {
      return false;
    }
  },
  listChunkRevisions: async (chunkId) => {
    const res = await api.get<{ revisions: Array<{ id: string; content: string; created_at: string }> }>(
      `${KB_API}/chunks/${chunkId}/revisions`,
    );
    return res.revisions ?? [];
  },
  revertChunk: async (chunkId, revisionId) => {
    try {
      const res = await api.post<{ chunk: KbChunk }>(`${KB_API}/chunks/${chunkId}/revert`, {
        revision_id: revisionId,
      });
      return res.chunk;
    } catch {
      return null;
    }
  },
  previewChunks: async (kbId, text, cfg) => {
    const res = await api.post<{ chunks: KbChunk[] }>(`${KB_API}/${kbId}/chunker/preview`, {
      text,
      ...cfg,
    });
    return res.chunks ?? [];
  },
  search: async (kbId, query, params) => {
    const res = await api.post<{ hits: KbHit[]; debug?: any }>(`${KB_API}/${kbId}/search`, {
      query,
      ...params,
    });
    return { hits: res.hits ?? [], debug: res.debug };
  },
  rebuildIndex: async (kbId) => {
    try {
      return await api.post<{
        dimension_changed?: boolean;
        rechunked_documents?: number;
        attempted?: number;
        success?: number;
        failed?: number;
      }>(`${KB_API}/${kbId}/rebuild-index`, {}, 300_000);
    } catch {
      return null;
    }
  },
  listChatMessages: async (sessionId) => {
    const res = await api.get<{ messages: KbChatMessage[] }>(
      `${KB_API}/chat/sessions/${sessionId}/messages`,
    );
    return res.messages ?? [];
  },
  clearChatSession: async (sessionId) => {
    try {
      await api.delete(`${KB_API}/chat/sessions/${sessionId}`);
      return true;
    } catch {
      return false;
    }
  },
}));

export type KbStreamEvent =
  | { type: 'session'; session_id: string }
  | { type: 'citations'; citations: KbCitation[] }
  | { type: 'delta'; text: string }
  | { type: 'done'; answer: string; fallback: boolean }
  | { type: 'error'; message: string };

/**
 * 知识库问答（SSE）。
 *
 * 不走 apiFetch：它是按整包 JSON 设计的，这里要的是逐帧读取。用 fetch + 手写
 * SSE 解析，并把 AbortSignal 透出去，让调用方可以中断一次回答。
 */
export async function streamKbChat(
  body: { question: string; session_id?: string; kb_ids?: string[]; top_k?: number; mode?: string },
  onEvent: (event: KbStreamEvent) => void,
  signal?: AbortSignal,
): Promise<void> {
  const res = await fetch(`${KB_API}/chat`, {
    method: 'POST',
    credentials: 'include',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(body),
    signal,
  });
  if (!res.ok || !res.body) {
    const detail = await res.text().catch(() => '');
    throw new Error(detail || `问答请求失败（${res.status}）`);
  }

  const reader = res.body.getReader();
  const decoder = new TextDecoder();
  let buffer = '';
  while (true) {
    const { done, value } = await reader.read();
    if (done) break;
    buffer += decoder.decode(value, { stream: true });
    // SSE 以空行分帧；最后一段可能不完整，留在 buffer 里等下一批。
    const frames = buffer.split('\n\n');
    buffer = frames.pop() ?? '';
    for (const frame of frames) {
      const line = frame.trim();
      if (!line.startsWith('data:')) continue;
      const payload = line.slice(5).trim();
      if (payload === '[DONE]') return;
      try {
        onEvent(JSON.parse(payload) as KbStreamEvent);
      } catch {
        // 忽略无法解析的保活帧
      }
    }
  }
}
