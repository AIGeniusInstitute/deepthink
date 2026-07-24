import { useState } from 'react';
import { Bell, BellOff, ChevronDown, ChevronRight, Clock, Activity, Target } from 'lucide-react';
import { useChatStore, type ReminderLogEntry, type ReminderStatus } from '../../stores/chat';
import { useAuthStore } from '../../stores/auth';

/**
 * Reminder panel — dedicated region in the chat sidebar that surfaces the
 * Agent Reminder mechanism: live status (enabled / step progress / last
 * injection) and the full injection log (time, reason, turn, goal snippet,
 * injected summary). Default-on, user-toggled (PRD F4/F5).
 */
export function ReminderPanel({ groupJid }: { groupJid: string }) {
  const user = useAuthStore((s) => s.user);
  const enabledFromPref = user?.reminder_enabled ?? true;

  const streaming = useChatStore((s) => s.streaming[groupJid]);
  const reminderLog: ReminderLogEntry[] = streaming?.reminderLog ?? [];
  const reminderStatus: ReminderStatus | undefined = streaming?.reminderStatus;

  // Effective enabled: preference off → off. Preference on + we've seen a
  // status (or it's early in the run) → on.
  const enabled = enabledFromPref && (reminderStatus?.enabled ?? true);
  const intervalSteps = reminderStatus?.intervalSteps ?? 0;
  const stepsSinceLast = streaming?.toolStepsSinceReminder ?? 0;
  const remaining = intervalSteps > 0 ? Math.max(0, intervalSteps - stepsSinceLast) : null;
  const injections = reminderStatus?.injections ?? 0;

  return (
    <div className="flex flex-col h-full min-h-0">
      <div className="px-3 py-2 border-b border-border flex items-center gap-2">
        {enabled ? (
          <Bell className="w-4 h-4 text-primary" />
        ) : (
          <BellOff className="w-4 h-4 text-muted-foreground" />
        )}
        <span className="text-sm font-medium">Reminder 机制</span>
        <span
          className={`ml-auto text-[11px] px-1.5 py-0.5 rounded-full ${
            enabled
              ? 'bg-primary/10 text-primary'
              : 'bg-muted text-muted-foreground'
          }`}
        >
          {enabled ? '已开启' : '已关闭'}
        </span>
      </div>

      <div className="flex-1 overflow-y-auto min-h-0">
        {/* ── Live status ── */}
        <div className="px-3 py-3 space-y-2 border-b border-border">
          <div className="text-[11px] font-medium text-muted-foreground flex items-center gap-1">
            <Activity className="w-3 h-3" /> 实时状态
          </div>
          <div className="grid grid-cols-2 gap-2 text-xs">
            <StatusCell label="开关" value={enabled ? '开启' : '关闭'} />
            <StatusCell label="注入次数" value={String(injections)} />
            <StatusCell
              label="注入间隔"
              value={intervalSteps > 0 ? `${intervalSteps} 步` : '—'}
            />
            <StatusCell
              label="距下次注入"
              value={enabled && remaining !== null ? `${remaining} 步` : '—'}
            />
          </div>
          {reminderStatus?.lastAt && (
            <div className="text-[11px] text-muted-foreground flex items-center gap-1">
              <Clock className="w-3 h-3" />
              最近注入：{formatTime(reminderStatus.lastAt)}
              <span className="ml-1 px-1.5 py-0.5 rounded bg-muted">
                {reminderStatus.lastReason === 'compact' ? '压缩后' : '周期'}
              </span>
            </div>
          )}
          {!enabled && (
            <p className="text-[11px] text-muted-foreground">
              Reminder 已关闭，Agent 运行时不会注入目标提醒。可在「设置 → 个人偏好」开启。
            </p>
          )}
          {enabled && injections === 0 && (
            <p className="text-[11px] text-muted-foreground">
              暂无注入记录。长任务执行超过 {intervalSteps || 8} 步工具调用后，将在此显示 Reminder 注入日志。
            </p>
          )}
        </div>

        {/* ── Injection log ── */}
        <div className="px-3 py-3">
          <div className="text-[11px] font-medium text-muted-foreground mb-2 flex items-center gap-1">
            <Target className="w-3 h-3" /> 注入日志
            <span className="ml-auto">{reminderLog.length} 条</span>
          </div>
          {reminderLog.length === 0 ? (
            <p className="text-[11px] text-muted-foreground">暂无注入记录</p>
          ) : (
            <div className="space-y-2">
              {[...reminderLog].reverse().map((entry) => (
                <ReminderLogRow key={entry.id} entry={entry} />
              ))}
            </div>
          )}
        </div>
      </div>
    </div>
  );
}

function StatusCell({ label, value }: { label: string; value: string }) {
  return (
    <div className="rounded-md bg-muted/40 px-2 py-1.5">
      <div className="text-[10px] text-muted-foreground">{label}</div>
      <div className="text-xs font-medium truncate">{value}</div>
    </div>
  );
}

function ReminderLogRow({ entry }: { entry: ReminderLogEntry }) {
  const [open, setOpen] = useState(false);
  const isCompact = entry.reason === 'compact';
  return (
    <div className="rounded-md border border-border bg-muted/20 overflow-hidden">
      <button
        onClick={() => setOpen(!open)}
        className="w-full flex items-center gap-2 px-2 py-1.5 text-left hover:bg-muted/40 transition-colors"
      >
        {open ? (
          <ChevronDown className="w-3 h-3 text-muted-foreground shrink-0" />
        ) : (
          <ChevronRight className="w-3 h-3 text-muted-foreground shrink-0" />
        )}
        <span
          className={`text-[10px] px-1.5 py-0.5 rounded-full shrink-0 ${
            isCompact ? 'bg-purple-500/10 text-purple-600 dark:text-purple-400' : 'bg-blue-500/10 text-blue-600 dark:text-blue-400'
          }`}
        >
          {isCompact ? '压缩后' : '周期'}
        </span>
        <span className="text-[11px] text-muted-foreground shrink-0">
          turn {entry.turnIndex}
        </span>
        <span className="text-[11px] text-muted-foreground shrink-0">
          {entry.stepsSinceLast} 步
        </span>
        <span className="text-[11px] text-muted-foreground ml-auto shrink-0">
          {formatTime(entry.timestamp)}
        </span>
      </button>
      {open && (
        <div className="border-t border-border px-2 py-2 space-y-1.5">
          <div>
            <div className="text-[10px] text-muted-foreground">任务目标</div>
            <div className="text-[11px] whitespace-pre-wrap break-words">
              {entry.goalSnippet || '—'}
            </div>
          </div>
          <div>
            <div className="text-[10px] text-muted-foreground">注入内容</div>
            <div className="text-[11px] whitespace-pre-wrap break-words font-mono">
              {entry.summary}
            </div>
          </div>
        </div>
      )}
    </div>
  );
}

function formatTime(ts: number): string {
  try {
    const d = new Date(ts);
    return d.toLocaleTimeString('zh-CN', { hour: '2-digit', minute: '2-digit', second: '2-digit' });
  } catch {
    return '—';
  }
}
