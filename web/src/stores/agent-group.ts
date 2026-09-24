/**
 * Agent Group Chat store — Zustand store managing swarm groups,
 * group chat messages, and pipeline runs.
 */
import { create } from 'zustand';
import {
  listAgentGroups,
  getAgentGroup,
  createAgentGroup,
  updateAgentGroup,
  deleteAgentGroup,
  addGroupSeat,
  updateGroupSeat,
  deleteGroupSeat,
  sendGroupMessage,
  listGroupMessages,
  startGroupRun,
  getRunNodes,
  getNodeTrace,
  cancelGroupRun,
  type AgentGroup,
  type AgentGroupDetail,
  type GroupSeat,
  type GroupMessage,
  type CreateGroupPayload,
  type CreateSeatPayload,
  type UpdateGroupPayload,
  type UpdateSeatPayload,
  type SendMessagePayload,
  type SendMessageResult,
  type PipelineRun,
  type PipelineNode,
  type TraceDetail,
} from '../api/agent-groups';

export interface AgentGroupState {
  groups: AgentGroup[];
  groupsLoading: boolean;
  groupsError: string | null;

  currentGroup: AgentGroupDetail | null;
  seats: GroupSeat[];
  detailLoading: boolean;
  detailError: string | null;

  messages: GroupMessage[];
  messagesLoading: boolean;
  messagesError: string | null;
  hasMoreMessages: boolean;

  currentRun: PipelineRun | null;
  nodes: PipelineNode[];
  runsLoading: boolean;

  selectedNodeId: string | null;
  traceData: TraceDetail | null;
  traceLoading: boolean;

  fetchGroups: () => Promise<void>;
  fetchGroup: (jid: string) => Promise<void>;
  createGroup: (data: CreateGroupPayload) => Promise<AgentGroupDetail | null>;
  updateGroup: (jid: string, data: UpdateGroupPayload) => Promise<boolean>;
  deleteGroup: (jid: string) => Promise<boolean>;
  addSeat: (jid: string, data: CreateSeatPayload) => Promise<GroupSeat | null>;
  updateSeat: (jid: string, seatId: number, data: UpdateSeatPayload) => Promise<boolean>;
  removeSeat: (jid: string, seatId: number) => Promise<boolean>;
  sendMessage: (jid: string, data: SendMessagePayload) => Promise<SendMessageResult | null>;
  fetchMessages: (jid: string, before?: string) => Promise<void>;
  appendMessage: (msg: GroupMessage) => void;
  startRun: (jid: string) => Promise<PipelineRun | null>;
  cancelRun: (runId: string) => Promise<boolean>;
  fetchRunNodes: (runId: string) => Promise<void>;
  fetchNodeTrace: (nodeRunId: string) => Promise<void>;
  selectNode: (nodeId: string | null) => void;
  clearCurrent: () => void;
}

export const useAgentGroupStore = create<AgentGroupState>((set, get) => ({
  groups: [],
  groupsLoading: false,
  groupsError: null,

  currentGroup: null,
  seats: [],
  detailLoading: false,
  detailError: null,

  messages: [],
  messagesLoading: false,
  messagesError: null,
  hasMoreMessages: false,

  currentRun: null,
  nodes: [],
  runsLoading: false,

  selectedNodeId: null,
  traceData: null,
  traceLoading: false,

  fetchGroups: async () => {
    set({ groupsLoading: true, groupsError: null });
    try {
      const data = await listAgentGroups();
      set({ groups: data.groups ?? [], groupsLoading: false });
    } catch (err) {
      set({ groupsError: (err as Error).message, groupsLoading: false });
    }
  },

  fetchGroup: async (jid) => {
    set({ detailLoading: true, detailError: null });
    try {
      const detail = await getAgentGroup(jid);
      set({
        currentGroup: detail,
        seats: detail.seats ?? [],
        detailLoading: false,
      });
    } catch (err) {
      set({ detailError: (err as Error).message, detailLoading: false });
    }
  },

  createGroup: async (data) => {
    try {
      const detail = await createAgentGroup(data);
      const { groups } = get();
      set({
        groups: [
          { jid: detail.jid, name: detail.name, folder: detail.folder,
            groupKind: detail.groupKind, floorPolicy: detail.floorPolicy,
            swarmStatus: detail.swarmStatus, seatCount: detail.seats.length,
            createdAt: detail.createdAt },
          ...groups,
        ],
      });
      return detail;
    } catch (err) {
      set({ groupsError: (err as Error).message });
      return null;
    }
  },

  updateGroup: async (jid, data) => {
    try {
      const detail = await updateAgentGroup(jid, data);
      const cg = get().currentGroup;
      if (cg && cg.jid === jid) {
        set({ currentGroup: detail, seats: detail.seats });
      }
      return true;
    } catch { return false; }
  },

  deleteGroup: async (jid) => {
    try {
      await deleteAgentGroup(jid);
      set({ groups: get().groups.filter(g => g.jid !== jid) });
      return true;
    } catch { return false; }
  },

  addSeat: async (jid, data) => {
    try {
      const seat = await addGroupSeat(jid, data);
      set({ seats: [...get().seats, seat] });
      return seat;
    } catch { return null; }
  },

  updateSeat: async (jid, seatId, data) => {
    try {
      await updateGroupSeat(jid, seatId, data);
      set({
        seats: get().seats.map(s => s.id === seatId ? { ...s, ...data } : s),
      });
      return true;
    } catch { return false; }
  },

  removeSeat: async (jid, seatId) => {
    try {
      await deleteGroupSeat(jid, seatId);
      set({ seats: get().seats.filter(s => s.id !== seatId) });
      return true;
    } catch { return false; }
  },

  sendMessage: async (jid, data) => {
    try {
      const msg = await sendGroupMessage(jid, data);
      set({ messages: [...get().messages, msg] });
      // A text message starts a swarm run; adopt it so the Pipeline panel
      // tracks the run the user just triggered instead of the previous one.
      if (msg.graphRunId) {
        set({
          currentRun: { id: msg.graphRunId, runId: msg.graphRunId, groupJid: jid, status: 'running' },
          nodes: [],
        });
      }
      return msg;
    } catch { return null; }
  },

  fetchMessages: async (jid, before?) => {
    set({ messagesLoading: true, messagesError: null });
    try {
      const data = await listGroupMessages(jid, before);
      const existing = get().messages;
      const mergedById = new Map<number, GroupMessage>();
      for (const m of existing) mergedById.set(m.id, m);
      for (const m of data.messages) mergedById.set(m.id, m);
      const merged = Array.from(mergedById.values()).sort(
        (a, b) => a.createdAt.localeCompare(b.createdAt),
      );
      set({ messages: merged, messagesLoading: false, hasMoreMessages: data.hasMore });
    } catch (err) {
      set({ messagesError: (err as Error).message, messagesLoading: false });
    }
  },

  appendMessage: (msg) => {
    if (get().messages.some(m => m.id === msg.id)) return;
    set({ messages: [...get().messages, msg] });
  },

  startRun: async (jid) => {
    try {
      const result = await startGroupRun(jid);
      // Backend returns flat {runId, status, groupJid, ...}
      const run: PipelineRun = {
        id: result.runId ?? result.id,
        runId: result.runId,
        groupJid: result.groupJid,
        status: result.status,
        executedSeat: result.executedSeat,
        nodeId: result.nodeId,
      };
      set({ currentRun: run, nodes: [] });
      return run;
    } catch { return null; }
  },

  cancelRun: async (runId) => {
    try {
      const result = await cancelGroupRun(runId);
      const current = get().currentRun;
      if (current && (current.id === runId || current.runId === runId)) {
        set({
          currentRun: { ...current, status: 'cancelled' as const },
          nodes: get().nodes.map(n =>
            n.status === 'running' ? { ...n, status: 'cancelled' as const } : n,
          ),
        });
      }
      return result.status === 'cancelled';
    } catch { return false; }
  },

  fetchRunNodes: async (runId) => {
    set({ runsLoading: true });
    try {
      const data = await getRunNodes(runId);
      // Backend returns {runId, nodes: [...]} — no "run" wrapper
      const current = get().currentRun;
      set({
        currentRun: current ? { ...current, status: data.nodes.some(n => n.status === 'running') ? 'running' as const : 'completed' as const } : null,
        nodes: data.nodes ?? [],
        runsLoading: false,
      });
    } catch { set({ runsLoading: false }); }
  },

  fetchNodeTrace: async (nodeRunId) => {
    set({ traceLoading: true });
    try {
      const data = await getNodeTrace(nodeRunId);
      set({ traceData: data, traceLoading: false });
    } catch { set({ traceLoading: false }); }
  },

  selectNode: (nodeId) => set({ selectedNodeId: nodeId, traceData: null }),

  clearCurrent: () => set({
    currentGroup: null, seats: [], messages: [],
    hasMoreMessages: false, currentRun: null, nodes: [],
    selectedNodeId: null, traceData: null,
  }),
}));