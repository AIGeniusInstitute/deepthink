import { create } from 'zustand';
import { api } from '../api/client';

export type ResourceType = 'mcp_server' | 'skill' | 'knowledge_base';

export interface AgentMount {
  id: string;
  agentDefId: string;
  resourceType: ResourceType;
  resourceId: string;
}

export interface AgentDefinition {
  id: string;
  userId: string;
  name: string;
  description: string;
  systemPrompt: string;
  model: string | null;
  engine: 'claude' | 'atomcode';
  avatarEmoji: string | null;
  avatarColor: string | null;
  maxTurns: number | null;
  temperature: number | null;
  enabled: boolean;
  createdAt: string;
  updatedAt: string;
  mounts?: AgentMount[];
}

export interface AvailableResource {
  mcp_servers: Array<{ id: string; name: string; type: string; enabled: boolean }>;
  knowledge_bases: Array<{ id: string; name: string; doc_count: number }>;
  skills: Array<{ id: string; name: string; description: string }>;
}

interface AgentsState {
  list: AgentDefinition[];
  quota: number;
  used: number;
  loading: boolean;
  error: string | null;
  available: AvailableResource | null;
  load: () => Promise<void>;
  loadAvailable: () => Promise<void>;
  create: (data: {
    name: string;
    description?: string;
    system_prompt?: string;
    model?: string | null;
    engine?: 'claude' | 'atomcode';
    avatar_emoji?: string | null;
    avatar_color?: string | null;
    max_turns?: number | null;
    temperature?: number | null;
    enabled?: boolean;
  }) => Promise<AgentDefinition | null>;
  update: (id: string, patch: Record<string, unknown>) => Promise<boolean>;
  remove: (id: string) => Promise<boolean>;
  addMount: (agentId: string, resourceType: ResourceType, resourceId: string) => Promise<boolean>;
  removeMount: (agentId: string, mountId: string) => Promise<boolean>;
}

export const useAgentsPaasStore = create<AgentsState>((set, get) => ({
  list: [],
  quota: 10,
  used: 0,
  loading: false,
  error: null,
  available: null,
  load: async () => {
    set({ loading: true, error: null });
    try {
      const res = await api.get<{ agents: AgentDefinition[]; quota: number; used: number }>('/api/paas/agents');
      set({ list: res.agents ?? [], quota: res.quota, used: res.used, loading: false });
    } catch (e: any) {
      set({ loading: false, error: e?.message ?? 'Load failed' });
    }
  },
  loadAvailable: async () => {
    const res = await api.get<AvailableResource>('/api/paas/agents/resources/available');
    set({ available: res });
  },
  create: async (data) => {
    try {
      const res = await api.post<{ agent: AgentDefinition }>('/api/paas/agents', data);
      await get().load();
      return res.agent;
    } catch {
      return null;
    }
  },
  update: async (id, patch) => {
    try {
      await api.patch(`/api/paas/agents/${id}`, patch);
      await get().load();
      return true;
    } catch {
      return false;
    }
  },
  remove: async (id) => {
    try {
      await api.delete(`/api/paas/agents/${id}`);
      await get().load();
      return true;
    } catch {
      return false;
    }
  },
  addMount: async (agentId, resourceType, resourceId) => {
    try {
      await api.post(`/api/paas/agents/${agentId}/mounts`, { resource_type: resourceType, resource_id: resourceId });
      await get().load();
      return true;
    } catch {
      return false;
    }
  },
  removeMount: async (agentId, mountId) => {
    try {
      await api.delete(`/api/paas/agents/${agentId}/mounts/${mountId}`);
      await get().load();
      return true;
    } catch {
      return false;
    }
  },
}));
