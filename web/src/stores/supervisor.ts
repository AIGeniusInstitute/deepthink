import { create } from 'zustand';
import {
  listSupervisors,
  createSupervisor,
  patchSupervisor,
  deleteSupervisor,
  triggerSupervisorCheck,
  listSupervisorDecisions,
  getSupervisor,
  type SupervisorSession,
  type SupervisorDecision,
  type CreateSupervisorInput,
} from '../api/supervisor';

interface SupervisorState {
  sessions: SupervisorSession[];
  selectedId: string | null;
  decisions: SupervisorDecision[];
  loading: boolean;
  error: string | null;
  fetchSessions: () => Promise<void>;
  select: (id: string | null) => void;
  create: (input: CreateSupervisorInput) => Promise<SupervisorSession>;
  toggle: (id: string, enabled: boolean) => Promise<void>;
  remove: (id: string, force?: boolean) => Promise<void>;
  triggerCheck: (id: string) => Promise<void>;
  loadDecisions: (id: string) => Promise<void>;
}

export const useSupervisorStore = create<SupervisorState>((set, get) => ({
  sessions: [],
  selectedId: null,
  decisions: [],
  loading: false,
  error: null,
  fetchSessions: async () => {
    set({ loading: true, error: null });
    try {
      const sessions = await listSupervisors();
      set({ sessions, loading: false });
    } catch (err) {
      set({ error: (err as Error).message, loading: false });
    }
  },
  select: (id) => {
    set({ selectedId: id, decisions: [] });
    if (id) void get().loadDecisions(id);
  },
  create: async (input) => {
    const session = await createSupervisor(input);
    await get().fetchSessions();
    return session;
  },
  toggle: async (id, enabled) => {
    await patchSupervisor(id, { enabled });
    await get().fetchSessions();
    if (get().selectedId === id) await get().loadDecisions(id);
  },
  remove: async (id, force = false) => {
    await deleteSupervisor(id, { force });
    if (get().selectedId === id) set({ selectedId: null, decisions: [] });
    await get().fetchSessions();
  },
  triggerCheck: async (id) => {
    await triggerSupervisorCheck(id);
    await get().loadDecisions(id);
    await get().fetchSessions();
  },
  loadDecisions: async (id) => {
    try {
      const decisions = await listSupervisorDecisions(id, { limit: 100 });
      set({ decisions });
    } catch (err) {
      set({ error: (err as Error).message });
    }
  },
}));

export {
  getSupervisor,
};
