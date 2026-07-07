import { create } from 'zustand';
import { apiFetch } from '../api/client';

export interface LoopRun {
  id: string;
  owner_user_id: string;
  group_folder: string;
  chat_jid: string;
  kind: 'goal' | 'loop' | 'schedule' | 'proactive';
  goal_text: string;
  success_criteria: string | null;
  max_turns: number;
  current_turn: number;
  status: 'pending' | 'running' | 'reviewing' | 'iterating' | 'completed' | 'failed' | 'cancelled';
  started_at: string;
  ended_at: string | null;
  total_input_tokens: number;
  total_output_tokens: number;
  total_cost_usd: number;
  root_prompt: string | null;
  scheduled_task_id: string | null;
  workflow_mode: string | null;
  cancel_reason: string | null;
}

export interface LoopIteration {
  id: number;
  loop_run_id: string;
  turn_index: number;
  status: 'running' | 'completed' | 'failed' | 'skipped';
  agent_session_id: string | null;
  started_at: string;
  ended_at: string | null;
  input_tokens: number;
  output_tokens: number;
  cost_usd: number;
  review_result: 'pass' | 'fail' | 'needs_improvement' | 'skipped' | null;
  review_reason: string | null;
  agent_output: string | null;
}

export interface LoopTraceNode {
  id: number;
  loop_run_id: string;
  iteration_id: number | null;
  node_type: 'turn' | 'tool' | 'review' | 'goal_check' | 'skill' | 'subagent';
  parent_node_id: number | null;
  tool_name: string | null;
  tool_use_id: string | null;
  title: string | null;
  input_summary: string | null;
  output_summary: string | null;
  started_at: string;
  ended_at: string | null;
  tokens: number;
  status: string | null;
  children?: LoopTraceNode[];
}

interface LoopsState {
  loops: LoopRun[];
  loading: boolean;
  error: string | null;
  filterStatus: string;
  filterKind: string;
  fetchLoops: () => Promise<void>;
  setFilter: (status: string, kind: string) => void;
}

export const useLoopsStore = create<LoopsState>((set, get) => ({
  loops: [],
  loading: false,
  error: null,
  filterStatus: '',
  filterKind: '',
  fetchLoops: async () => {
    set({ loading: true, error: null });
    try {
      const params = new URLSearchParams();
      const { filterStatus, filterKind } = get();
      if (filterStatus) params.set('status', filterStatus);
      if (filterKind) params.set('kind', filterKind);
      const query = params.toString();
      const data = await apiFetch<{ loops: LoopRun[] }>(
        `/api/loops${query ? `?${query}` : ''}`,
      );
      set({ loops: data.loops ?? [], loading: false });
    } catch (err) {
      set({ error: (err as Error).message, loading: false });
    }
  },
  setFilter: (status, kind) => {
    set({ filterStatus: status, filterKind: kind });
  },
}));

export async function fetchLoopDetail(id: string): Promise<{
  loop: LoopRun;
  iterations: LoopIteration[];
  traceNodes: LoopTraceNode[];
}> {
  return apiFetch(`/api/loops/${id}`);
}

export async function fetchLoopTraceTree(id: string): Promise<{ loop_run_id: string; roots: LoopTraceNode[] }> {
  return apiFetch(`/api/loops/${id}/trace`);
}

export async function cancelLoop(id: string): Promise<{ ok: boolean }> {
  return apiFetch(`/api/loops/${id}/cancel`, { method: 'POST' });
}
