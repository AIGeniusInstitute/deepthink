/**
 * Super Agent Team store. POST /api/team/runs 现在是异步：立即返回 buildId，
 * decompose + 成员创建 + graph 注册启动在后台 detached 执行（最坏 ~240s）。
 * 本 store 轮询 GET /api/team/runs/:buildId 拿终态（completed → runId+plan /
 * failed → error），不再用单次 280s 长超时阻塞请求——彻底消除"长时间阻塞 HTTP
 * 请求"的脆弱模式。终态拿到 runId 后，TeamPage 的 useEffect 会自动 startPolling
 * graph run（/api/graph/runs/:id）驱动 DAG 可视化，行为与改动前一致。
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

// 模块级轮询令牌：每次 buildTeam/reset 自增，使上一轮 in-flight 轮询自停，
// 避免组件卸载或重新发起后定时器泄漏/状态错乱。与 graph store 的 pollingTimer
// 同思路，但用令牌而非 timer id（轮询是 async loop 而非 setInterval）。
let pollToken = 0;

const POLL_INTERVAL_MS = 2000;

async function pollBuild(
  token: number,
  buildId: string,
  onCompleted: (runId: string, plan: TeamPlan) => void,
  onFailed: (error: string) => void,
): Promise<void> {
  for (;;) {
    if (token !== pollToken) return; // 已被新一轮 build/reset 取消
    let res: { status?: string; runId?: string; plan?: TeamPlan; error?: string };
    try {
      res = await apiFetch<{ status?: string; runId?: string; plan?: TeamPlan; error?: string }>(
        `/api/team/runs/${encodeURIComponent(buildId)}`,
      );
    } catch {
      // 单次 GET 失败（网络抖动 / 临时 8s 超时）不致命，下一轮重试。
      res = { status: 'running' };
    }
    if (token !== pollToken) return;
    if (res.status === 'completed' && res.runId && res.plan) {
      onCompleted(res.runId, res.plan);
      return;
    }
    if (res.status === 'failed') {
      onFailed(res.error ?? 'build failed');
      return;
    }
    // running：等下一轮
    await new Promise((r) => setTimeout(r, POLL_INTERVAL_MS));
  }
}

export const useTeamStore = create<TeamState>((set) => ({
  building: false,
  error: null,
  lastRunId: null,
  lastPlan: null,

  buildTeam: async (input) => {
    set({ building: true, error: null, lastRunId: null, lastPlan: null });
    const token = ++pollToken; // 作废任何在跑的旧轮询

    // 1. POST 立即拿 buildId（后端 <1s 返回）。
    let buildId: string;
    try {
      const data = await apiFetch<{ ok?: boolean; buildId?: string; status?: string; error?: string }>(
        '/api/team/runs',
        { method: 'POST', body: JSON.stringify(input) },
      );
      if (!data.ok || !data.buildId) {
        set({ building: false, error: data.error ?? 'build failed' });
        return null;
      }
      buildId = data.buildId;
    } catch (err) {
      set({ building: false, error: (err as Error).message });
      return null;
    }
    if (token !== pollToken) return null; // POST 期间已被 reset

    // 2. 轮询拿终态。
    return new Promise<{ runId: string; plan: TeamPlan } | null>((resolve) => {
      pollBuild(
        token,
        buildId,
        (runId, plan) => {
          if (token !== pollToken) {
            resolve(null);
            return;
          }
          set({ building: false, lastRunId: runId, lastPlan: plan });
          resolve({ runId, plan });
        },
        (error) => {
          if (token !== pollToken) {
            resolve(null);
            return;
          }
          set({ building: false, error });
          resolve(null);
        },
      );
    });
  },

  reset: () => {
    pollToken++; // 作废在跑的轮询
    set({ building: false, error: null, lastRunId: null, lastPlan: null });
  },
}));
