import { useEffect, useState } from 'react';
import {
  useSupervisorStore,
} from '../stores/supervisor';
import type {
  SupervisorSession,
  SupervisorDecision,
  SupervisorEvidence,
  SupervisorStrategy,
} from '../api/supervisor';

const STATUS_COLORS: Record<string, string> = {
  active: 'bg-blue-100 text-blue-700',
  paused: 'bg-gray-200 text-gray-700',
  completed: 'bg-green-100 text-green-700',
  failed: 'bg-red-100 text-red-700',
  aborted: 'bg-orange-100 text-orange-700',
};

const ACTION_COLORS: Record<string, string> = {
  continue: 'bg-gray-100 text-gray-700',
  redirect: 'bg-purple-100 text-purple-700',
  escalate: 'bg-yellow-100 text-yellow-700',
  complete: 'bg-green-100 text-green-700',
  abort: 'bg-red-100 text-red-700',
  error: 'bg-red-200 text-red-800',
};

const STRATEGY_LABELS: Record<string, string> = {
  periodic: '⏱ 周期巡检',
  on_iteration: '🔁 逐轮监督',
  hybrid: '🔀 混合',
};

function parseEvidence(d: SupervisorDecision): SupervisorEvidence[] {
  if (!d.evidence_json) return [];
  try {
    const arr = JSON.parse(d.evidence_json);
    return Array.isArray(arr) ? arr : [];
  } catch {
    return [];
  }
}

export function SupervisorPage() {
  const {
    sessions,
    decisions,
    loading,
    error,
    selectedId,
    fetchSessions,
    select,
    create,
    toggle,
    remove,
    triggerCheck,
    loadDecisions,
  } = useSupervisorStore();
  const [showCreate, setShowCreate] = useState(false);

  useEffect(() => {
    fetchSessions();
    const interval = setInterval(() => {
      fetchSessions();
      if (selectedId) loadDecisions(selectedId);
    }, 5000);
    return () => clearInterval(interval);
  }, [fetchSessions, loadDecisions, selectedId]);

  return (
    <div className="flex h-full">
      <div className="w-1/2 border-r overflow-y-auto p-4">
        <div className="flex items-center justify-between mb-4">
          <h1 className="text-xl font-bold">Supervisor Agent</h1>
          <button
            onClick={() => setShowCreate(true)}
            className="px-3 py-1.5 bg-blue-600 text-white rounded text-sm hover:bg-blue-700"
          >
            + 新建 Supervisor
          </button>
        </div>

        {loading && sessions.length === 0 && (
          <div className="text-gray-500">加载中…</div>
        )}
        {error && <div className="text-red-600">错误：{error}</div>}
        {!loading && sessions.length === 0 && (
          <div className="text-gray-500">
            <p>暂无 Supervisor 会话。</p>
            <p className="mt-2 text-sm">
              新建一个长驻监督者，自主定义监督目标 / 周期 / 策略，监督主对话 Agent 全过程并回喂结论。
            </p>
          </div>
        )}

        <div className="space-y-2">
          {sessions.map((s) => (
            <SessionCard
              key={s.id}
              session={s}
              selected={selectedId === s.id}
              onSelect={() => select(s.id)}
              onToggle={(en) => toggle(s.id, en)}
              onRemove={async () => {
                if (confirm(`删除 Supervisor ${s.id.slice(0, 16)}…？`)) {
                  await remove(s.id, true);
                }
              }}
              onCheck={() => triggerCheck(s.id)}
            />
          ))}
        </div>
      </div>

      <div className="w-1/2 overflow-y-auto p-4">
        {selectedId ? (
          <DecisionTimeline decisions={decisions} />
        ) : (
          <div className="text-gray-400">← 选择一个 Supervisor 查看监督决策时间线</div>
        )}
      </div>

      {showCreate && (
        <CreateDialog
          onClose={() => setShowCreate(false)}
          onCreate={async (input) => {
            try {
              await create(input);
              setShowCreate(false);
            } catch (err: any) {
              alert(err?.message ?? '创建失败');
            }
          }}
        />
      )}
    </div>
  );
}

function SessionCard({
  session,
  selected,
  onSelect,
  onToggle,
  onRemove,
  onCheck,
}: {
  session: SupervisorSession;
  selected: boolean;
  onSelect: () => void;
  onToggle: (enabled: boolean) => void;
  onRemove: () => void;
  onCheck: () => void;
}) {
  const isActive = session.status === 'active';
  return (
    <div
      onClick={onSelect}
      className={`border rounded p-3 cursor-pointer hover:bg-gray-50 ${
        selected ? 'ring-2 ring-blue-400' : ''
      }`}
    >
      <div className="flex items-center justify-between">
        <div className="flex items-center gap-2">
          <span className="font-medium">{STRATEGY_LABELS[session.strategy] ?? session.strategy}</span>
          <span className={`text-xs px-2 py-0.5 rounded ${STATUS_COLORS[session.status] ?? 'bg-gray-100'}`}>
            {session.status}
          </span>
          {session.consecutive_errors > 0 && (
            <span className="text-xs px-1.5 py-0.5 rounded bg-red-100 text-red-700">
              err {session.consecutive_errors}
            </span>
          )}
        </div>
        <div className="text-xs text-gray-500">
          {session.current_checks}/{session.max_checks} 次
        </div>
      </div>
      <div className="mt-2 text-sm text-gray-700 line-clamp-2">{session.goal_text}</div>
      <div className="mt-2 flex items-center justify-between text-xs text-gray-500">
        <span>周期 {Math.round(session.period_ms / 1000)}s</span>
        <span>{new Date(session.started_at).toLocaleString()}</span>
      </div>
      <div className="mt-2 flex items-center gap-3 text-xs" onClick={(e) => e.stopPropagation()}>
        <button
          onClick={() => onToggle(!isActive)}
          className={`px-2 py-0.5 rounded ${
            isActive
              ? 'bg-yellow-100 text-yellow-700 hover:bg-yellow-200'
              : 'bg-green-100 text-green-700 hover:bg-green-200'
          }`}
        >
          {isActive ? '暂停' : '恢复'}
        </button>
        <button onClick={onCheck} className="text-blue-600 hover:underline">
          立即监督
        </button>
        <button onClick={onRemove} className="text-red-600 hover:underline">
          删除
        </button>
      </div>
    </div>
  );
}

function DecisionTimeline({ decisions }: { decisions: SupervisorDecision[] }) {
  if (decisions.length === 0) {
    return <div className="text-gray-400">尚无监督决策。等待首次周期到达或点击「立即监督」。</div>;
  }
  return (
    <div>
      <h2 className="text-lg font-bold mb-3">监督决策时间线</h2>
      <div className="space-y-3">
        {decisions.map((d) => (
          <DecisionCard key={d.id} decision={d} />
        ))}
      </div>
    </div>
  );
}

function DecisionCard({ decision }: { decision: SupervisorDecision }) {
  const [expanded, setExpanded] = useState(false);
  const evidence = parseEvidence(decision);
  return (
    <div className="border rounded p-3">
      <div className="flex items-center justify-between">
        <div className="flex items-center gap-2">
          <span className="text-xs text-gray-500">#{decision.turn_index}</span>
          <span className={`text-xs px-2 py-0.5 rounded ${ACTION_COLORS[decision.action] ?? 'bg-gray-100'}`}>
            {decision.action}
          </span>
          <span className="text-xs text-gray-500">{decision.triggered_by}</span>
        </div>
        <span className="text-xs text-gray-500">
          {new Date(decision.started_at).toLocaleString()}
        </span>
      </div>
      {decision.conclusion && (
        <div className="mt-2 text-sm text-gray-800">{decision.conclusion}</div>
      )}
      {decision.next_action_hint && (
        <div className="mt-1 text-sm text-purple-700 bg-purple-50 rounded p-2">
          ↪ {decision.next_action_hint}
        </div>
      )}
      {decision.error && (
        <div className="mt-1 text-xs text-red-600">错误：{decision.error}</div>
      )}
      <div className="mt-2 flex items-center justify-between text-xs text-gray-500">
        <span>
          {decision.confidence != null
            ? `置信度 ${(decision.confidence * 100).toFixed(0)}%`
            : ''}
        </span>
        {evidence.length > 0 && (
          <button onClick={() => setExpanded(!expanded)} className="text-blue-600 hover:underline">
            {expanded ? '收起证据' : `查看证据 (${evidence.length})`}
          </button>
        )}
      </div>
      {expanded && evidence.length > 0 && (
        <div className="mt-2 space-y-1 text-xs">
          {evidence.map((e, i) => (
            <div key={i} className="border-l-2 border-gray-300 pl-2">
              <span className="font-mono text-gray-600">[{e.type}]</span>{' '}
              <span className="text-gray-800">{e.ref}</span>
              {e.detail && <div className="text-gray-500">{e.detail}</div>}
            </div>
          ))}
        </div>
      )}
      {decision.trace_summary && (
        <div className="mt-2 text-xs text-gray-400 font-mono">{decision.trace_summary}</div>
      )}
    </div>
  );
}

function CreateDialog({
  onClose,
  onCreate,
}: {
  onClose: () => void;
  onCreate: (input: {
    group_folder: string;
    chat_jid: string;
    goal_text: string;
    success_criteria: string;
    strategy: SupervisorStrategy;
    period_ms: number;
    max_checks: number;
    bound_loop_run_id?: string | null;
  }) => Promise<void>;
}) {
  const [groupFolder, setGroupFolder] = useState('home');
  const [chatJid, setChatJid] = useState('web:home');
  const [goal, setGoal] = useState('');
  const [success, setSuccess] = useState('');
  const [strategy, setStrategy] = useState<SupervisorStrategy>('periodic');
  const [periodSec, setPeriodSec] = useState(300);
  const [maxChecks, setMaxChecks] = useState(100);
  const [boundLoop, setBoundLoop] = useState('');

  return (
    <div className="fixed inset-0 bg-black/40 flex items-center justify-center z-50" onClick={onClose}>
      <div
        className="bg-white rounded-lg p-6 w-[480px] max-h-[90vh] overflow-y-auto"
        onClick={(e) => e.stopPropagation()}
      >
        <h2 className="text-lg font-bold mb-4">新建 Supervisor</h2>
        <div className="space-y-3 text-sm">
          <div>
            <label className="block text-gray-600 mb-1">group_folder</label>
            <input value={groupFolder} onChange={(e) => setGroupFolder(e.target.value)} className="w-full border rounded px-2 py-1" />
          </div>
          <div>
            <label className="block text-gray-600 mb-1">chat_jid</label>
            <input value={chatJid} onChange={(e) => setChatJid(e.target.value)} className="w-full border rounded px-2 py-1" />
          </div>
          <div>
            <label className="block text-gray-600 mb-1">监督目标 *</label>
            <textarea value={goal} onChange={(e) => setGoal(e.target.value)} className="w-full border rounded px-2 py-1" rows={2} />
          </div>
          <div>
            <label className="block text-gray-600 mb-1">达成判据 *</label>
            <textarea value={success} onChange={(e) => setSuccess(e.target.value)} className="w-full border rounded px-2 py-1" rows={2} />
          </div>
          <div className="grid grid-cols-2 gap-3">
            <div>
              <label className="block text-gray-600 mb-1">监督策略</label>
              <select
                value={strategy}
                onChange={(e) => setStrategy(e.target.value as SupervisorStrategy)}
                className="w-full border rounded px-2 py-1"
              >
                <option value="periodic">⏱ 周期巡检</option>
                <option value="on_iteration">🔁 逐轮监督</option>
                <option value="hybrid">🔀 混合</option>
              </select>
            </div>
            <div>
              <label className="block text-gray-600 mb-1">周期（秒）</label>
              <input
                type="number"
                min={60}
                max={3600}
                value={periodSec}
                onChange={(e) => setPeriodSec(Number(e.target.value))}
                className="w-full border rounded px-2 py-1"
              />
            </div>
          </div>
          <div className="grid grid-cols-2 gap-3">
            <div>
              <label className="block text-gray-600 mb-1">最大监督次数</label>
              <input
                type="number"
                min={1}
                max={500}
                value={maxChecks}
                onChange={(e) => setMaxChecks(Number(e.target.value))}
                className="w-full border rounded px-2 py-1"
              />
            </div>
            <div>
              <label className="block text-gray-600 mb-1">绑定 loop_run_id（可选）</label>
              <input value={boundLoop} onChange={(e) => setBoundLoop(e.target.value)} className="w-full border rounded px-2 py-1" placeholder="loop_xxx" />
            </div>
          </div>
        </div>
        <div className="mt-5 flex justify-end gap-2 text-sm">
          <button onClick={onClose} className="px-3 py-1.5 border rounded">取消</button>
          <button
            onClick={() =>
              onCreate({
                group_folder: groupFolder,
                chat_jid: chatJid,
                goal_text: goal,
                success_criteria: success,
                strategy,
                period_ms: periodSec * 1000,
                max_checks: maxChecks,
                bound_loop_run_id: boundLoop || null,
              })
            }
            className="px-3 py-1.5 bg-blue-600 text-white rounded hover:bg-blue-700"
          >
            创建
          </button>
        </div>
      </div>
    </div>
  );
}
