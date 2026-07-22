/**
 * Super Agent Team store. Calls POST /api/team/runs to autonomously decompose
 * a complex task into a team + start a graph run. The resulting runId is a
 * standard graph_run, so the graph store's loadRun/polling drive the DAG
 * visualization. Mirrors stores/graph.ts.
 */
import { create } from 'zustand';
import { apiFetch } from '../api/client';

export interface TeamPlanMember {
  name: string;
  role: string;
  systemPrompt?: string;
  engine?: string;
  skills?: string[];
  mcpServers?: string[];
  maxTurns?: number;
  deliverable?: string;
}

export interface TeamPlan {
  teamName: string;
  members: TeamPlanMember[];
  graph: { nodes: Array<{ id: string; type: string; title: string; dependsOn?: string[] }> };
  acceptanceCriteria?: string;
}

interface TeamState {
  building: boolean;
  error: string | null;
  lastRunId: string | null;
  lastPlan: TeamPlan | null;
  buildTeam: (input: {
    goalText: string;
    background?: string;
    acceptanceCriteria?: string;
    groupFolder: string;
    chatJid: string;
    userLanguage?: string;
  }) => Promise<{ runId: string; plan: TeamPlan } | null>;
  reset: () => void;
}

export const useTeamStore = create<TeamState>((set) => ({
  building: false,
  error: null,
  lastRunId: null,
  lastPlan: null,

  buildTeam: async (input) => {
    set({ building: true, error: null });
    try {
      const data = await apiFetch<{
        ok?: boolean;
        runId?: string;
        plan?: TeamPlan;
        error?: string;
        detail?: string;
      }>('/api/team/runs', {
        method: 'POST',
        body: JSON.stringify(input),
        // buildTeam 在后端同步阻塞于 decompose()（LLM 分解，单次 120s 超时、
        // 失败重试 1 次 → 最坏 2×120s=240s），之后才创建成员/注册/启动 graph。
        // 原值 150s < 240s 最坏耗时，超大任务（如多章节长文）会在此提前 abort，
        // 抛出 AbortError → client.ts 转成 408 'Request timeout'，而后端其实
        // 仍在跑甚至最终成功。这里对齐后端最坏耗时（240s）+ 余量，且保持低于
        // 后端 requestTimeout(600s) 与 Node/Vite 默认 requestTimeout(300s)。
        timeoutMs: 280_000,
      });
      if (!data.ok || !data.runId || !data.plan) {
        set({
          building: false,
          error: data.error ? `${data.error}${data.detail ? `：${data.detail}` : ''}` : 'build failed',
        });
        return null;
      }
      set({ building: false, lastRunId: data.runId, lastPlan: data.plan });
      return { runId: data.runId, plan: data.plan };
    } catch (err) {
      set({ building: false, error: (err as Error).message });
      return null;
    }
  },

  reset: () => set({ building: false, error: null, lastRunId: null, lastPlan: null }),
}));
