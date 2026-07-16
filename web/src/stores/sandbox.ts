import { create } from 'zustand';
import { sandboxApi, type SandboxSession } from '../api/sandbox';
import { wsManager } from '../api/ws';

interface SandboxStore {
  sessions: SandboxSession[];
  activeSessionId: string | null;
  browserFrame: string | null;
  // Per-session frame index — supports multiple sessions (chat + sandbox page
  // simultaneously) without overwriting each other's frame.
  browserFrames: Record<string, string>;
  // Track which sessions we've already subscribed to avoid double-subscribe.
  subscribedSessions: Set<string>;
  loading: boolean;
  error: string | null;

  loadSessions: () => Promise<void>;
  create: (opts: { language?: 'python' | 'node' | 'sh'; browserEnabled?: boolean }) => Promise<SandboxSession | null>;
  destroy: (id: string) => Promise<void>;
  setActive: (id: string | null) => void;
  sendTerminalInput: (sessionId: string, data: string) => void;
  startTerminal: (sessionId: string, cols: number, rows: number) => void;
  stopTerminal: (sessionId: string) => void;
  resizeTerminal: (sessionId: string, cols: number, rows: number) => void;
  subscribeBrowser: (sessionId: string, url?: string) => void;
  unsubscribeBrowser: (sessionId: string) => void;
  setBrowserFrame: (dataUrl: string | null) => void;
  // New: per-session frame setter, used by chat inline panel
  setBrowserFrameForSession: (sessionId: string, dataUrl: string) => void;
  getBrowserFrame: (sessionId: string) => string | null;
  isSubscribed: (sessionId: string) => boolean;
  // New: focus a session (switch active + wire frame from index)
  focusSession: (sessionId: string) => void;
  wireWsHandlers: () => (() => void) | void;
}

export const useSandboxStore = create<SandboxStore>((set, get) => ({
  sessions: [],
  activeSessionId: null,
  browserFrame: null,
  browserFrames: {},
  subscribedSessions: new Set<string>(),
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
        const browserFrames = { ...st.browserFrames };
        delete browserFrames[id];
        const subscribedSessions = new Set(st.subscribedSessions);
        subscribedSessions.delete(id);
        return {
          sessions,
          activeSessionId,
          browserFrames,
          subscribedSessions,
          browserFrame: activeSessionId === st.activeSessionId ? st.browserFrame : null,
        };
      });
    } catch (e: any) {
      set({ error: e?.message ?? '销毁失败' });
    }
  },

  setActive: (id) => set((st) => ({
    activeSessionId: id,
    browserFrame: id ? (st.browserFrames[id] ?? null) : null,
  })),

  sendTerminalInput: (sessionId, data) => {
    wsManager.send({ type: 'sandbox_terminal_input', sessionId, data });
  },

  startTerminal: (sessionId, cols, rows) => {
    wsManager.send({ type: 'sandbox_terminal_start', sessionId, cols, rows });
  },

  stopTerminal: (sessionId) => {
    wsManager.send({ type: 'sandbox_terminal_stop', sessionId });
  },
  resizeTerminal: (sessionId, cols, rows) => {
    wsManager.send({ type: 'sandbox_terminal_resize', sessionId, cols, rows });
  },

  subscribeBrowser: (sessionId, url) => {
    set((st) => {
      const subscribedSessions = new Set(st.subscribedSessions);
      subscribedSessions.add(sessionId);
      return { subscribedSessions, browserFrame: null };
    });
    wsManager.send({ type: 'sandbox_browser_subscribe', sessionId, ...(url ? { url } : {}) });
  },

  unsubscribeBrowser: (sessionId) => {
    set((st) => {
      const subscribedSessions = new Set(st.subscribedSessions);
      subscribedSessions.delete(sessionId);
      const browserFrames = { ...st.browserFrames };
      delete browserFrames[sessionId];
      return { subscribedSessions, browserFrames, browserFrame: null };
    });
    wsManager.send({ type: 'sandbox_browser_unsubscribe', sessionId });
  },

  setBrowserFrame: (dataUrl) => set({ browserFrame: dataUrl }),

  setBrowserFrameForSession: (sessionId, dataUrl) => set((st) => ({
    browserFrames: { ...st.browserFrames, [sessionId]: dataUrl },
    // Mirror to single browserFrame when this is the active session (for SandboxPage compatibility)
    browserFrame: st.activeSessionId === sessionId ? dataUrl : st.browserFrame,
  })),

  getBrowserFrame: (sessionId) => get().browserFrames[sessionId] ?? null,

  isSubscribed: (sessionId) => get().subscribedSessions.has(sessionId),

  focusSession: (sessionId) => set((st) => ({
    activeSessionId: sessionId,
    browserFrame: st.browserFrames[sessionId] ?? null,
  })),

  wireWsHandlers: () => {
    const offs: Array<(() => void) | undefined> = [];
    offs.push(wsManager.on('sandbox_browser_frame', (data) => {
      const sid = data?.sessionId;
      if (!sid) return;
      // Always store in the per-session index
      get().setBrowserFrameForSession(sid, data.dataUrl);
      // Backward-compat: if this is the active session, mirror to browserFrame
      if (sid === get().activeSessionId) {
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
