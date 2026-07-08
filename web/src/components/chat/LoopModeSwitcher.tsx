import { useState, type ReactNode } from 'react';
import { Loader2, Send, X } from 'lucide-react';
import { useDisplayMode } from '../../hooks/useDisplayMode';

export type LoopMode = 'chat' | 'goal' | 'time' | 'proactive' | 'adaptive' | 'skill_evolution';

interface ModeConfig {
  label: string;
  emoji: string;
  title: string;
}

const MODES: Record<LoopMode, ModeConfig> = {
  chat: { label: '对话', emoji: '💬', title: '普通对话模式' },
  goal: { label: '目标循环', emoji: '🎯', title: '目标驱动，评审通过即完成' },
  time: { label: '时间循环', emoji: '🔄', title: '间隔执行 (/loop) 或 cron 定时 (/schedule)' },
  proactive: { label: '主动循环', emoji: '🤖', title: 'cron 驱动 + 评审，可并行' },
  adaptive: { label: '自适应', emoji: '🧬', title: 'max_turns 动态调整，探索型任务' },
  skill_evolution: { label: '技能自进化', emoji: '🧪', title: '迭代修改 skill 至测试通过' },
};

const CHIP_ORDER: LoopMode[] = ['chat', 'goal', 'time', 'proactive', 'adaptive', 'skill_evolution'];

export function LoopModeSwitcher({
  mode,
  onChange,
}: {
  mode: LoopMode;
  onChange: (m: LoopMode) => void;
}) {
  const { mode: displayMode } = useDisplayMode();
  const alignCls = displayMode === 'compact' ? 'mx-auto px-4' : 'max-w-4xl mx-auto px-4 lg:pl-[60px]';
  return (
    <div className={`${alignCls} flex items-center gap-1 overflow-x-auto no-scrollbar pb-1`}>
      {CHIP_ORDER.map((m) => {
        const cfg = MODES[m];
        const active = mode === m;
        return (
          <button
            key={m}
            onClick={() => onChange(m)}
            title={cfg.title}
            className={`flex-shrink-0 px-2.5 py-1 rounded-full text-xs font-medium transition-colors cursor-pointer border ${
              active
                ? 'bg-primary text-primary-foreground border-primary'
                : 'bg-surface text-muted-foreground border-border hover:bg-accent'
            }`}
          >
            <span className="mr-1">{cfg.emoji}</span>
            {cfg.label}
          </button>
        );
      })}
    </div>
  );
}

interface LoopFormProps {
  mode: Exclude<LoopMode, 'chat'>;
  onSend: (slashCommand: string) => Promise<boolean> | boolean;
  onCancel: () => void;
}

function Field({ label, children }: { label: string; children: ReactNode }) {
  return (
    <label className="block">
      <span className="text-[11px] text-muted-foreground">{label}</span>
      {children}
    </label>
  );
}

const inputCls =
  'w-full mt-0.5 px-2 py-1.5 text-sm bg-background border border-border rounded-md focus:outline-none focus:ring-1 focus:ring-primary';

export function LoopForm({ mode, onSend, onCancel }: LoopFormProps) {
  const { mode: displayMode } = useDisplayMode();
  const alignCls = displayMode === 'compact' ? 'mx-auto px-4' : 'max-w-4xl mx-auto px-4 lg:pl-[60px]';
  const [goal, setGoal] = useState('');
  const [successCriteria, setSuccessCriteria] = useState('');
  const [maxTurns, setMaxTurns] = useState('5');
  const [interval, setInterval] = useState('5m');
  const [cron, setCron] = useState('0 * * * *');
  const [isCron, setIsCron] = useState(false);
  const [parallel, setParallel] = useState(false);
  const [skillPath, setSkillPath] = useState('');
  const [testCmd, setTestCmd] = useState('');
  const [sending, setSending] = useState(false);

  const buildCommand = (): string | null => {
    const g = goal.trim();
    if (!g && mode !== 'skill_evolution') return null;
    switch (mode) {
      case 'goal':
        return `/goal ${g}${successCriteria ? ` (成功标准: ${successCriteria})` : ''}${maxTurns ? ` max_turns=${maxTurns}` : ''}`;
      case 'time':
        if (!interval.trim()) return null;
        return `/loop ${interval} ${g}`;
      case 'proactive': {
        if (!cron.trim()) return null;
        return `/proactive ${cron} ${g}${parallel ? ' workflow=parallel' : ''}`;
      }
      case 'adaptive':
        return `/adaptive ${g}${maxTurns ? ` max_turns=${maxTurns}` : ''}`;
      case 'skill_evolution': {
        const sp = skillPath.trim();
        const tc = testCmd.trim();
        if (!sp || !tc) return null;
        return `/skill_evolution ${sp} "${tc}"${maxTurns ? ` max_turns=${maxTurns}` : ''}`;
      }
    }
  };

  const handleSend = async () => {
    const cmd = buildCommand();
    if (!cmd) return;
    setSending(true);
    try {
      const ok = await onSend(cmd);
      if (ok) {
        setGoal('');
        setSuccessCriteria('');
        setSkillPath('');
        setTestCmd('');
        onCancel();
      }
    } finally {
      setSending(false);
    }
  };

  return (
    <div className={alignCls}>
      <div className="bg-surface rounded-2xl border border-border shadow-sm p-3 space-y-2">
      <div className="flex items-center justify-between">
        <span className="text-xs font-medium text-muted-foreground">
          {MODES[mode].emoji} {MODES[mode].label}
        </span>
        <button
          onClick={onCancel}
          className="text-muted-foreground hover:text-foreground p-1 rounded hover:bg-accent"
          title="切回对话"
        >
          <X className="w-4 h-4" />
        </button>
      </div>

      {mode === 'skill_evolution' ? (
        <>
          <Field label="Skill 路径（如 tests/skills/demo.test.js 或 skills/foo/SKILL.md）">
            <input className={inputCls} value={skillPath} onChange={(e) => setSkillPath(e.target.value)} placeholder="tests/skills/demo.test.js" />
          </Field>
          <Field label="测试命令（exit 0 = 通过）">
            <input className={inputCls} value={testCmd} onChange={(e) => setTestCmd(e.target.value)} placeholder="node tests/skills/demo.test.js" />
          </Field>
        </>
      ) : (
        <Field label="目标 / 任务描述">
          <textarea
            className={inputCls + ' resize-none'}
            rows={2}
            value={goal}
            onChange={(e) => setGoal(e.target.value)}
            placeholder="例：修复 README 错字并校验链接"
            onKeyDown={(e) => {
              if (e.key === 'Enter' && (e.metaKey || e.ctrlKey)) {
                e.preventDefault();
                handleSend();
              }
            }}
          />
        </Field>
      )}

      {mode === 'goal' && (
        <Field label="成功标准（选填，评审器参考）">
          <input className={inputCls} value={successCriteria} onChange={(e) => setSuccessCriteria(e.target.value)} placeholder="例：README 所有链接可达" />
        </Field>
      )}

      {(mode === 'goal' || mode === 'adaptive') && (
        <Field label="最大轮次 (1-10)">
          <input className={inputCls} type="number" min={1} max={10} value={maxTurns} onChange={(e) => setMaxTurns(e.target.value)} />
        </Field>
      )}

      {mode === 'time' && (
        <>
          <div className="flex gap-2 text-xs">
            <button
              type="button"
              onClick={() => setIsCron(false)}
              className={`px-2 py-1 rounded border ${!isCron ? 'bg-primary text-primary-foreground border-primary' : 'bg-surface border-border'}`}
            >
              间隔 (/loop)
            </button>
            <button
              type="button"
              onClick={() => setIsCron(true)}
              className={`px-2 py-1 rounded border ${isCron ? 'bg-primary text-primary-foreground border-primary' : 'bg-surface border-border'}`}
            >
              Cron (/schedule)
            </button>
          </div>
          {isCron ? (
            <Field label="Cron 表达式（分 时 日 月 周）">
              <input className={inputCls} value={cron} onChange={(e) => setCron(e.target.value)} placeholder="0 9 * * *" />
            </Field>
          ) : (
            <Field label="间隔（30s / 5m / 1h / 2h）">
              <input className={inputCls} value={interval} onChange={(e) => setInterval(e.target.value)} placeholder="5m" />
            </Field>
          )}
        </>
      )}

      {mode === 'proactive' && (
        <>
          <Field label="Cron 表达式">
            <input className={inputCls} value={cron} onChange={(e) => setCron(e.target.value)} placeholder="0 * * * *" />
          </Field>
          <label className="flex items-center gap-2 text-xs text-muted-foreground">
            <input type="checkbox" checked={parallel} onChange={(e) => setParallel(e.target.checked)} />
            并行 workflow（多子任务并发）
          </label>
        </>
      )}

      <div className="flex justify-end gap-2 pt-1">
        <button
          onClick={handleSend}
          disabled={sending || !buildCommand()}
          className="inline-flex items-center gap-1 px-3 py-1.5 text-sm font-medium rounded-md bg-primary text-primary-foreground disabled:opacity-50 disabled:cursor-not-allowed hover:bg-primary/90 transition-colors"
        >
          {sending ? <Loader2 className="w-4 h-4 animate-spin" /> : <Send className="w-4 h-4" />}
          启动循环
        </button>
      </div>
      </div>
    </div>
  );
}
