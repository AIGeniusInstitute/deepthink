import { create } from 'zustand';
import { api } from '../api/client';
import type { GroupInfo, GroupMember } from '../types';
import { useChatStore } from './chat';

export type { GroupInfo };

interface GroupsState {
  groups: Record<string, GroupInfo>;
  loading: boolean;
  error: string | null;
  members: Record<string, GroupMember[]>;
  membersLoading: boolean;
  runnerStates: Record<string, 'idle' | 'running'>;
  loadGroups: () => Promise<void>;
  loadMembers: (jid: string) => Promise<void>;
  addMember: (jid: string, userId: string) => Promise<void>;
  removeMember: (jid: string, userId: string) => Promise<void>;
  setRunnerState: (chatJid: string, state: 'idle' | 'running') => void;
}

export const useGroupsStore = create<GroupsState>((set, get) => ({
  groups: {},
  loading: false,
  error: null,
  members: {},
  membersLoading: false,
  runnerStates: {},

  loadGroups: async () => {
    set({ loading: true });
    try {
      const data = await api.get<{ groups: Record<string, GroupInfo> }>('/api/groups');
      set({ groups: data.groups, loading: false, error: null });
    } catch (err) {
      set({ loading: false, error: err instanceof Error ? err.message : String(err) });
    }
  },

  loadMembers: async (jid: string) => {
    set({ membersLoading: true });
    try {
      const data = await api.get<{ members: GroupMember[] }>(`/api/groups/${encodeURIComponent(jid)}/members`);
      set((state) => ({
        members: { ...state.members, [jid]: data.members },
        membersLoading: false,
      }));
    } catch (err) {
      set({ membersLoading: false });
      throw err;
    }
  },

  addMember: async (jid: string, userId: string) => {
    const data = await api.post<{ members: GroupMember[] }>(
      `/api/groups/${encodeURIComponent(jid)}/members`,
      { user_id: userId },
    );
    set((state) => ({
      members: { ...state.members, [jid]: data.members },
    }));
    // Refresh group lists to update member_count (both stores)
    get().loadGroups();
    useChatStore.getState().loadGroups();
  },

  removeMember: async (jid: string, userId: string) => {
    const data = await api.delete<{ members: GroupMember[] }>(
      `/api/groups/${encodeURIComponent(jid)}/members/${encodeURIComponent(userId)}`,
    );
    set((state) => ({
      members: { ...state.members, [jid]: data.members },
    }));
    // Refresh group lists (both stores) — removed member loses access
    get().loadGroups();
    useChatStore.getState().loadGroups();
  },

  setRunnerState: (chatJid: string, state: 'idle' | 'running') => {
    set((s) => {
      if (state === 'idle') {
        const { [chatJid]: _, ...rest } = s.runnerStates;
        return { runnerStates: rest };
      }
      return { runnerStates: { ...s.runnerStates, [chatJid]: state } };
    });
  },
}));
