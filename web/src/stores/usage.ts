import { create } from 'zustand';
import { api } from '../api/client';

export interface UsageSummary {
  totalInputTokens: number;
  totalOutputTokens: number;
  totalCacheReadTokens: number;
  totalCacheCreationTokens: number;
  totalCostUSD: number;
  totalMessages: number;
  totalActiveDays: number;
}

export interface UsageBreakdown {
  date: string;
  model: string;
  user_id: string;
  input_tokens: number;
  output_tokens: number;
  cache_read_tokens: number;
  cache_creation_tokens: number;
  cost_usd: number;
  request_count: number;
}

export interface DataRange {
  from: string;
  to: string;
  activeDays: number;
}

export interface UsageUser {
  id: string;
  username: string;
}

interface UsageState {
  summary: UsageSummary | null;
  breakdown: UsageBreakdown[];
  dataRange: DataRange | null;
  days: number;
  loading: boolean;
  error: string | null;

  // Filters
  selectedUserId: string | null; // null = all
  selectedModel: string | null; // null = all
  availableModels: string[];
  availableUsers: UsageUser[];

  // Actions
  loadStats: (days?: number) => Promise<void>;
  setDays: (days: number) => void;
  setSelectedUserId: (id: string | null) => void;
  setSelectedModel: (model: string | null) => void;
  loadFilters: () => Promise<void>;
}

export const useUsageStore = create<UsageState>((set, get) => ({
  summary: null,
  breakdown: [],
  dataRange: null,
  days: 7,
  loading: false,
  error: null,
  selectedUserId: null,
  selectedModel: null,
  availableModels: [],
  availableUsers: [],

  loadStats: async (days?: number) => {
    const d = days ?? get().days;
    const { selectedUserId, selectedModel } = get();
    set({ loading: true, days: d });
    try {
      const params = new URLSearchParams({ days: String(d) });
      if (selectedUserId) params.set('userId', selectedUserId);
      if (selectedModel) params.set('model', selectedModel);

      const data = await api.get<{
        summary: UsageSummary;
        breakdown: UsageBreakdown[];
        days: number;
        dataRange: DataRange | null;
      }>(`/api/usage/stats?${params.toString()}`);
      set({
        summary: data.summary,
        breakdown: data.breakdown,
        dataRange: data.dataRange,
        loading: false,
        error: null,
      });
    } catch (err) {
      set({ loading: false, error: err instanceof Error ? err.message : String(err) });
    }
  },

  setDays: (days: number) => {
    set({ days });
    get().loadStats(days);
  },

  setSelectedUserId: (id: string | null) => {
    set({ selectedUserId: id });
    get().loadStats();
  },

  setSelectedModel: (model: string | null) => {
    set({ selectedModel: model });
    get().loadStats();
  },

  loadFilters: async () => {
    try {
      const [modelsData, usersData] = await Promise.all([
        api.get<{ models: string[] }>('/api/usage/models'),
        api.get<{ users: UsageUser[] }>('/api/usage/users'),
      ]);
      set({
        availableModels: modelsData.models,
        availableUsers: usersData.users,
      });
    } catch {
      // Filters are non-critical, silently fail
    }
  },
}));
