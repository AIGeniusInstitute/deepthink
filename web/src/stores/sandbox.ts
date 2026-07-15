import { create } from 'zustand';
import { sandboxApi, type SandboxSession } from '../api/sandbox';
import { wsManager } from '../api/ws';

interface SandboxStore {
  sessions: SandboxSession[];
  activeSessionId: string | null;
  browserFrame: string | null;
  loading: boolean;
  error: string | null;

  loadSessions: () => Promise<void>;
  create: (opts: { language?: 'python' | 'node' | 'sh'; browserEnabled?: boolean }) => Promise<SandboxSession | null>;
  destroy: (id: string) => Promise<void>;
  setActive: (id: string | null) => void;
  sendTerminalInput: (sessionId: string, data: string) => void;
  startTerminal: (sessionId: string, cols: number, rows: number) => void;
  stopTerminal: (sessionId: string) => void;
  subscribeBrowser: (sessionId: string, url?: string) => void;
  unsubscribeBrowser: (sessionId: string) => void;
  setBrowserFrame: (dataUrl: string | null) => void;
  wireWsHandlers: () => (() => void) | void;
}

export const useSandboxStore = create<SandboxStore>((set, get) => ({
  sessions: [],
  activeSessionId: null,
  browserFrame: null,
  loading: false,
  error: null,

  loadSessions: async () => {
    set({ loading: true, error: null });
    try {
      const r = await sandboxApi.listSessions();
      set({ sessions: r.sessions, loading: false });
    } catch (e: any) {
      set({ loading: false, error: e?.message ?? '加载失败' });
    }
  },

  create: async (opts) => {
    try {
      const s = await sandboxApi.createSession(opts);
      set((st) => ({ sessions: [s, ...st.sessions], activeSessionId: s.id, browserFrame: null }));
      return s;
    } catch (e: any) {
      set({ error: e?.message ?? '创建失败' });
      return null;
    }
  },

  destroy: async (id) => {
    try {
      await sandboxApi.destroySession(id);
      set((st) => {
        const sessions = st.sessions.filter((s) => s.id !== id);
        const activeSessionId = st.activeSessionId === id ? null : st.activeSessionId;
        return { sessions, activeSessionId, browserFrame: activeSessionId === st.activeSessionId ? st.browserFrame : null };
      });
    } catch (e: any) {
      set({ error: e?.message ?? '销毁失败' });
    }
  },

  setActive: (id) => set({ activeSessionId: id, browserFrame: null }),

  sendTerminalInput: (sessionId, data) => {
    wsManager.send({ type: 'sandbox_terminal_input', sessionId, data });
  },

  startTerminal: (sessionId, cols, rows) => {
    wsManager.send({ type: 'sandbox_terminal_start', sessionId, cols, rows });
  },

  stopTerminal: (sessionId) => {
    wsManager.send({ type: 'sandbox_terminal_stop', sessionId });
  },

  subscribeBrowser: (sessionId, url) => {
    set({ browserFrame: null });
    wsManager.send({ type: 'sandbox_browser_subscribe', sessionId, ...(url ? { url } : {}) });
  },

  unsubscribeBrowser: (sessionId) => {
    wsManager.send({ type: 'sandbox_browser_unsubscribe', sessionId });
    set({ browserFrame: null });
  },

  setBrowserFrame: (dataUrl) => set({ browserFrame: dataUrl }),

  wireWsHandlers: () => {
    const offs: Array<(() => void) | undefined> = [];
    offs.push(wsManager.on('sandbox_browser_frame', (data) => {
      if (data?.sessionId === get().activeSessionId) {
        get().setBrowserFrame(data.dataUrl);
      }
    }));
    offs.push(wsManager.on('sandbox_status', (data) => {
      if (data?.sessionId) {
        set((st) => ({
          sessions: st.sessions.map((s) =>
            s.id === data.sessionId ? { ...s, status: data.status } : s,
          ),
        }));
      }
    }));
    offs.push(wsManager.on('sandbox_error', (data) => {
      console.error('[sandbox]', data?.error);
    }));
    return () => offs.forEach((off) => off?.());
  },
}));
