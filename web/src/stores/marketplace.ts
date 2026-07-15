import { create } from 'zustand';
import { api } from '../api/client';

export type MarketplaceItemType = 'agent_template' | 'mcp_template' | 'skill_template' | 'kb_template';
export type MarketplaceStatus = 'pending' | 'approved' | 'rejected';

export interface MarketplaceReview {
  id: string;
  itemId: string;
  userId: string;
  rating: number;
  comment: string | null;
  createdAt: string;
  updatedAt: string;
}

export interface MarketplaceItem {
  id: string;
  itemType: MarketplaceItemType;
  name: string;
  description: string;
  authorName: string;
  tags: string[];
  payload: unknown;
  installedCount: number;
  createdAt: string;
  updatedAt: string;
  status?: MarketplaceStatus;
  submittedBy?: string | null;
  ratingAverage?: number;
  ratingCount?: number;
}

interface MarketplaceState {
  list: MarketplaceItem[];
  mine: MarketplaceItem[];
  reviews: Record<string, MarketplaceReview[]>;
  loading: boolean;
  error: string | null;
  load: (itemType?: MarketplaceItemType, status?: MarketplaceStatus) => Promise<void>;
  loadMine: () => Promise<void>;
  loadReviews: (itemId: string) => Promise<MarketplaceReview[]>;
  install: (id: string) => Promise<{ success: boolean; message: string }>;
  submit: (data: {
    itemType: MarketplaceItemType;
    name: string;
    description: string;
    authorName: string;
    tags: string[];
    payload: unknown;
  }) => Promise<MarketplaceItem | null>;
  approve: (id: string) => Promise<boolean>;
  reject: (id: string) => Promise<boolean>;
  submitReview: (itemId: string, rating: number, comment: string) => Promise<boolean>;
}

export const useMarketplaceStore = create<MarketplaceState>((set, get) => ({
  list: [],
  mine: [],
  reviews: {},
  loading: false,
  error: null,
  load: async (itemType, status) => {
    set({ loading: true, error: null });
    try {
      const params: string[] = [];
      if (itemType) params.push(`item_type=${itemType}`);
      if (status) params.push(`status=${status}`);
      const qs = params.length > 0 ? `?${params.join('&')}` : '';
      const res = await api.get<{ items: MarketplaceItem[] }>(`/api/paas/marketplace${qs}`);
      set({ list: res.items ?? [], loading: false });
    } catch (e: any) {
      set({ loading: false, error: e?.message ?? 'Load failed' });
    }
  },
  loadMine: async () => {
    try {
      const res = await api.get<{ items: MarketplaceItem[] }>('/api/paas/marketplace/mine');
      set({ mine: res.items ?? [] });
    } catch {
      set({ mine: [] });
    }
  },
  loadReviews: async (itemId) => {
    try {
      const res = await api.get<{ reviews: MarketplaceReview[] }>(`/api/paas/marketplace/${itemId}/reviews`);
      set({ reviews: { ...get().reviews, [itemId]: res.reviews ?? [] } });
      return res.reviews ?? [];
    } catch {
      return [];
    }
  },
  install: async (id) => {
    try {
      const res = await api.post<{ success: boolean; installed: { type: string; id?: string; name?: string } }>(`/api/paas/marketplace/${id}/install`);
      return { success: true, message: `Installed: ${res.installed?.name ?? res.installed?.type ?? 'ok'}` };
    } catch (e: any) {
      return { success: false, message: e?.message ?? 'Install failed' };
    }
  },
  submit: async (data) => {
    try {
      const res = await api.post<{ item: MarketplaceItem }>('/api/paas/marketplace/submit', data);
      return res.item;
    } catch {
      return null;
    }
  },
  approve: async (id) => {
    try {
      await api.post(`/api/paas/marketplace/${id}/approve`);
      return true;
    } catch {
      return false;
    }
  },
  reject: async (id) => {
    try {
      await api.post(`/api/paas/marketplace/${id}/reject`);
      return true;
    } catch {
      return false;
    }
  },
  submitReview: async (itemId, rating, comment) => {
    try {
      await api.post(`/api/paas/marketplace/${itemId}/reviews`, { rating, comment });
      await get().loadReviews(itemId);
      return true;
    } catch {
      return false;
    }
  },
}));
