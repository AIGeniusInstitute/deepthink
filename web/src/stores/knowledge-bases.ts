import { create } from 'zustand';
import { api } from '../api/client';

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
}

export interface KnowledgeBase {
  id: string;
  userId: string;
  name: string;
  description: string;
  docCount: number;
  createdAt: string;
  updatedAt: string;
}

export interface KbSearchHit {
  kb_id: string;
  kb_name?: string | null;
  doc_id: string;
  filename: string;
  snippet: string;
  rank: number;
}

interface KbState {
  list: KnowledgeBase[];
  loading: boolean;
  error: string | null;
  load: () => Promise<void>;
  create: (name: string, description: string) => Promise<KnowledgeBase | null>;
  remove: (id: string) => Promise<boolean>;
  listDocuments: (kbId: string) => Promise<KbDocumentMeta[]>;
  uploadDocument: (kbId: string, file: File) => Promise<boolean>;
  uploadFromUrl: (kbId: string, url: string) => Promise<boolean>;
  removeDocument: (kbId: string, docId: string) => Promise<boolean>;
  search: (kbId: string, query: string, limit?: number) => Promise<KbSearchHit[]>;
  embedAll: (kbId: string) => Promise<{ embedded: number; failed: number } | null>;
  embedDocument: (kbId: string, docId: string) => Promise<boolean>;
}

export const useKnowledgeBasesStore = create<KbState>((set, get) => ({
  list: [],
  loading: false,
  error: null,
  load: async () => {
    set({ loading: true, error: null });
    try {
      const res = await api.get<{ knowledge_bases: KnowledgeBase[] }>('/api/paas/knowledge-bases');
      set({ list: res.knowledge_bases ?? [], loading: false });
    } catch (e: any) {
      set({ loading: false, error: e?.message ?? 'Load failed' });
    }
  },
  create: async (name, description) => {
    try {
      const res = await api.post<{ knowledge_base: KnowledgeBase }>('/api/paas/knowledge-bases', { name, description });
      await get().load();
      return res.knowledge_base;
    } catch {
      return null;
    }
  },
  remove: async (id) => {
    try {
      await api.delete(`/api/paas/knowledge-bases/${id}`);
      await get().load();
      return true;
    } catch {
      return false;
    }
  },
  listDocuments: async (kbId) => {
    const res = await api.get<{ documents: KbDocumentMeta[] }>(`/api/paas/knowledge-bases/${kbId}/documents`);
    return res.documents ?? [];
  },
  uploadDocument: async (kbId, file) => {
    const fd = new FormData();
    fd.append('file', file);
    try {
      await api.post<{ document: KbDocumentMeta }>(`/api/paas/knowledge-bases/${kbId}/documents`, fd, 120_000);
      return true;
    } catch {
      return false;
    }
  },
  uploadFromUrl: async (kbId, url) => {
    try {
      await api.post(`/api/paas/knowledge-bases/${kbId}/documents/url`, { url }, 30_000);
      return true;
    } catch {
      return false;
    }
  },
  removeDocument: async (kbId, docId) => {
    try {
      await api.delete(`/api/paas/knowledge-bases/${kbId}/documents/${docId}`);
      return true;
    } catch {
      return false;
    }
  },
  search: async (kbId, query, limit = 5) => {
    const res = await api.post<{ results: KbSearchHit[] }>(`/api/paas/knowledge-bases/${kbId}/search`, { query, limit });
    return res.results ?? [];
  },
  embedAll: async (kbId) => {
    try {
      const res = await api.post<{ embedded?: number; failed?: number }>(`/api/paas/knowledge-bases/${kbId}/embed-all`, {}, 120_000);
      return { embedded: res.embedded ?? 0, failed: res.failed ?? 0 };
    } catch {
      return null;
    }
  },
  embedDocument: async (kbId, docId) => {
    try {
      await api.post(`/api/paas/knowledge-bases/${kbId}/documents/${docId}/embed`, {}, 30_000);
      return true;
    } catch {
      return false;
    }
  },
}));
