import { create } from 'zustand';
import { api } from '../api/client';

export type MarketplaceItemType = 'agent_template' | 'mcp_template' | 'skill_template' | 'kb_template';

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
}

interface MarketplaceState {
  list: MarketplaceItem[];
  loading: boolean;
  error: string | null;
  load: (itemType?: MarketplaceItemType) => Promise<void>;
  install: (id: string) => Promise<{ success: boolean; message: string }>;
}

export const useMarketplaceStore = create<MarketplaceState>((set) => ({
  list: [],
  loading: false,
  error: null,
  load: async (itemType) => {
    set({ loading: true, error: null });
    try {
      const qs = itemType ? `?item_type=${itemType}` : '';
      const res = await api.get<{ items: MarketplaceItem[] }>(`/api/paas/marketplace${qs}`);
      set({ list: res.items ?? [], loading: false });
    } catch (e: any) {
      set({ loading: false, error: e?.message ?? 'Load failed' });
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
}));
