/**
 * Super Agent Team page — input a complex task, DeepThink autonomously
 * decomposes it into a team (creates agent members + assembles a graph) and
 * starts a run. Shows the team plan preview, then jumps to the GraphPage
 * detail view for live DAG visualization + node-internal trace.
 *
 * Mirrors GraphPage structure. The run started here is a standard graph_run,
 * so GraphPage renders it unchanged.
 */
import { useEffect, useMemo, useState } from 'react';
import { useTeamStore } from '../stores/team';
import { useGroupsStore } from '../stores/groups';
import { useGraphStore } from '../stores/graph';
import { GraphDagView } from '../components/graph/GraphDagView';

export function TeamPage() {
  const building = useTeamStore((s) => s.building);
  const error = useTeamStore((s) => s.error);
  const lastRunId = useTeamStore((s) => s.lastRunId);
  const lastPlan = useTeamStore((s) => s.lastPlan);
  const buildTeam = useTeamStore((s) => s.buildTeam);

  const groups = useGroupsStore((s) => s.groups);
  const loadGroups = useGroupsStore((s) => s.loadGroups);
  const startPolling = useGraphStore((s) => s.startPolling);
  const stopPolling = useGraphStore((s) => s.stopPolling);

  const [goal, setGoal] = useState('');
  const [background, setBackground] = useState('');
  const [criteria, setCriteria] = useState('');
  const [showAdvanced, setShowAdvanced] = useState(false);

  useEffect(() => {
    void loadGroups();
  }, [loadGroups]);

  // Pick the user's home group for the run.
  const home = useMemo(() => {
    const entries = Object.entries(groups);
    const found =
      entries.find(([, g]) => g.is_my_home) ??
      entries.find(([, g]) => g.is_home) ??
      entries.find(([, g]) => g.kind === 'home') ??
      entries[0];
    return found ? { chatJid: found[0], folder: found[1].folder } : null;
  }, [groups]);

  // When a run starts, poll it + show the DAG view.
  useEffect(() => {
    if (lastRunId) {
      startPolling(lastRunId);
    }
    return () => stopPolling();
  }, [lastRunId, startPolling, stopPolling]);

  const handleBuild = async () => {
    if (!goal.trim() || !home) return;
    await buildTeam({
      goalText: goal.trim(),
      background: background.trim() || undefined,
      acceptanceCriteria: criteria.trim() || undefined,
      groupFolder: home.folder,
      chatJid: home.chatJid,
    });
  };

  if (lastRunId) {
    return (
      <div className="flex flex-col h-full">
        <div className="flex items-center gap-2 px-4 py-2 border-b border-border">
          <button
            onClick={() => {
              stopPolling();
              useTeamStore.getState().reset();
            }}
            className="text-sm text-muted-foreground hover:text-foreground"
          >
            ← 新建团队
          </button>
          <span className="text-sm text-muted-foreground">
            团队 {lastPlan?.teamName ?? ''} · 运行 {lastRunId.slice(0, 12)}
          </span>
        </div>
        <div className="flex-1 min-h-0">
          <GraphDagView runId={lastRunId} />
        </div>
      </div>
    );
  }

  return (
    <div className="flex flex-col h-full overflow-y-auto">
      <div className="px-4 py-3 border-b border-border">
        <h2 className="font-semibold text-foreground">超级 Agent 团队</h2>
        <p className="text-xs text-muted-foreground mt-1">
          输入超复杂任务，DeepThink 自主拆解、组建 Agent 团队（自主设计角色 / System Prompt / 工具），用 DAG 任务图可视化执行，节点内步骤 + 工具调用全 trace 可回溯。
        </p>
      </div>

      <div className="p-4 space-y-3 max-w-3xl">
        {!home && (
          <div className="text-xs text-amber-600">
            未找到可用工作区（group）。请先在 Web 创建/进入一个工作区。
          </div>
        )}
        <div>
          <label className="text-xs text-muted-foreground block mb-1">任务目标 *</label>
          <textarea
            value={goal}
            onChange={(e) => setGoal(e.target.value)}
            rows={4}
            placeholder="例：调研 2026 年 Agent 框架趋势，实现一个最小可运行的 TODO 原型并写单元测试，产出研究报告 + 可运行代码 + 测试通过"
            className="w-full text-sm rounded border border-border bg-background px-3 py-2 resize-y"
          />
        </div>

        <button
          onClick={() => setShowAdvanced((v) => !v)}
          className="text-xs text-muted-foreground hover:text-foreground"
        >
          {showAdvanced ? '收起高级选项' : '高级选项（背景 / 验收标准）'}
        </button>
        {showAdvanced && (
          <>
            <div>
              <label className="text-xs text-muted-foreground block mb-1">背景（可选）</label>
              <textarea
                value={background}
                onChange={(e) => setBackground(e.target.value)}
                rows={2}
                className="w-full text-sm rounded border border-border bg-background px-3 py-2 resize-y"
              />
            </div>
            <div>
              <label className="text-xs text-muted-foreground block mb-1">验收标准（可选，推荐填写以驱动行为证据）</label>
              <textarea
                value={criteria}
                onChange={(e) => setCriteria(e.target.value)}
                rows={2}
                placeholder="例：测试全部通过；报告含趋势章节"
                className="w-full text-sm rounded border border-border bg-background px-3 py-2 resize-y"
              />
            </div>
          </>
        )}

        {error && (
          <div className="text-xs text-red-600 bg-red-50 rounded p-2">❌ {error}</div>
        )}

        <button
          onClick={() => void handleBuild()}
          disabled={building || !goal.trim() || !home}
          className="px-4 py-2 rounded bg-foreground text-background text-sm hover:opacity-90 disabled:opacity-50"
        >
          {building ? '组建团队中…（拆解 + 创建成员 + 组装图）' : '🤝 组建团队并启动'}
        </button>

        {lastPlan && (
          <div className="border border-border rounded p-3 space-y-2">
            <div className="text-xs text-muted-foreground">团队计划预览</div>
            <div className="text-sm font-medium">团队：{lastPlan.teamName}</div>
            <div className="text-xs">成员（{lastPlan.members.length}）：</div>
            <ul className="text-xs space-y-0.5 ml-4">
              {lastPlan.members.map((m) => (
                <li key={m.name}>
                  <span className="font-mono">{m.name}</span> — {m.role}
                  {m.engine && m.engine !== 'claude' && (
                    <span className="text-muted-foreground">（{m.engine}）</span>
                  )}
                </li>
              ))}
            </ul>
            <div className="text-xs">节点（{lastPlan.graph.nodes.length}）：
              {lastPlan.graph.nodes.map((n) => n.title).join(' → ')}
            </div>
          </div>
        )}
      </div>
    </div>
  );
}
