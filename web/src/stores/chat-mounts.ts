import { create } from 'zustand';
import { persist } from 'zustand/middleware';

export interface ChatMounts {
  skillIds: string[];
  mcpIds: string[];
  kbIds: string[];
}

export interface ChatMountsState {
  // per groupJid 选中的技能/MCP/知识库
  mounts: Record<string, ChatMounts>;
  toggleSkill: (groupJid: string, skillId: string) => void;
  toggleMcp: (groupJid: string, mcpId: string) => void;
  toggleKb: (groupJid: string, kbId: string) => void;
  setSkills: (groupJid: string, skillIds: string[]) => void;
  clear: (groupJid: string) => void;
  getMounts: (groupJid: string) => ChatMounts;
}

const EMPTY: ChatMounts = { skillIds: [], mcpIds: [], kbIds: [] };

export const useChatMountsStore = create<ChatMountsState>()(
  persist(
    (set, get) => ({
      mounts: {},
      toggleSkill: (groupJid, skillId) =>
        set((s) => {
          const cur = s.mounts[groupJid] ?? EMPTY;
          const has = cur.skillIds.includes(skillId);
          return {
            mounts: {
              ...s.mounts,
              [groupJid]: {
                ...cur,
                skillIds: has
                  ? cur.skillIds.filter((x) => x !== skillId)
                  : [...cur.skillIds, skillId],
              },
            },
          };
        }),
      toggleMcp: (groupJid, mcpId) =>
        set((s) => {
          const cur = s.mounts[groupJid] ?? EMPTY;
          const has = cur.mcpIds.includes(mcpId);
          return {
            mounts: {
              ...s.mounts,
              [groupJid]: {
                ...cur,
                mcpIds: has ? cur.mcpIds.filter((x) => x !== mcpId) : [...cur.mcpIds, mcpId],
              },
            },
          };
        }),
      toggleKb: (groupJid, kbId) =>
        set((s) => {
          const cur = s.mounts[groupJid] ?? EMPTY;
          const has = cur.kbIds.includes(kbId);
          return {
            mounts: {
              ...s.mounts,
              [groupJid]: {
                ...cur,
                kbIds: has ? cur.kbIds.filter((x) => x !== kbId) : [...cur.kbIds, kbId],
              },
            },
          };
        }),
      setSkills: (groupJid, skillIds) =>
        set((s) => {
          const cur = s.mounts[groupJid] ?? EMPTY;
          return { mounts: { ...s.mounts, [groupJid]: { ...cur, skillIds } } };
        }),
      clear: (groupJid) =>
        set((s) => {
          const next = { ...s.mounts };
          delete next[groupJid];
          return { mounts: next };
        }),
      getMounts: (groupJid) => get().mounts[groupJid] ?? EMPTY,
    }),
    { name: 'deepthink-chat-mounts' },
  ),
);
