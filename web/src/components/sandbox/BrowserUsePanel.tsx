/**
 * Browser Use Agent 控制面板。
 * - 自然语言任务输入 + 提交 / 停止
 * - 实时步骤流（thought / action / result + 当前截图缩略图）
 * - 完成总结
 * 步骤数据来自 useSandboxStore.agentSteps[sessionId]（WS 实时推送）。
 */
import { useState } from 'react';
import { Play, Square, Trash2, Loader2, Bot, ChevronRight } from 'lucide-react';
import { useSandboxStore } from '../../stores/sandbox';
import { sandboxApi } from '../../api/sandbox';
import { showToast } from '../../utils/toast';
import { Button } from '@/components/ui/button';
import { Textarea } from '@/components/ui/textarea';

interface Props {
  sessionId: string;
}

export function BrowserUsePanel({ sessionId }: Props) {
  const steps = useSandboxStore((s) => s.agentSteps[sessionId] ?? []);
  const running = useSandboxStore((s) => s.agentRunning[sessionId] ?? false);
  const summary = useSandboxStore((s) => s.agentSummary[sessionId] ?? null);
  const clearAgent = useSandboxStore((s) => s.clearAgent);

  const [goal, setGoal] = useState('');
  const [initialUrl, setInitialUrl] = useState('');
  const [submitting, setSubmitting] = useState(false);

  const handleSubmit = async () => {
    if (!goal.trim() || running) return;
    setSubmitting(true);
    clearAgent(sessionId);
    try {
      const r = await sandboxApi.runBrowserAgent(sessionId, {
        goal: goal.trim(),
        initialUrl: initialUrl.trim() || undefined,
      });
      if (!r?.ok) {
        showToast('启动失败', 'Agent 未能启动，请确认浏览器已启动');
      }
    } catch (e: any) {
      showToast('启动失败', e?.message ?? '未知错误');
    } finally {
      setSubmitting(false);
    }
  };

  const handleStop = async () => {
    try {
      await sandboxApi.stopBrowserAgent(sessionId);
    } catch (e: any) {
      showToast('停止失败', e?.message ?? '');
    }
  };

  return (
    <div className="flex flex-col h-full bg-[#0f0f14] text-neutral-200">
      {/* Header */}
      <div className="flex items-center gap-2 px-3 py-2 bg-[#1a1b26] border-b border-[#2a2b36]">
        <Bot className="w-4 h-4 text-emerald-400" />
        <span className="text-xs font-medium text-neutral-200">Browser Use Agent</span>
        {running && (
          <span className="flex items-center gap-1 text-[10px] text-emerald-400">
            <Loader2 className="w-3 h-3 animate-spin" /> 运行中
          </span>
        )}
      </div>

      {/* Input */}
      <div className="p-2.5 space-y-2 border-b border-[#2a2b36]">
        <input
          value={initialUrl}
          onChange={(e) => setInitialUrl(e.target.value)}
          placeholder="起始 URL（可选，如 https://example.com）"
          className="w-full px-2.5 py-1.5 text-xs bg-[#0f0f14] border border-[#2a2b36] rounded text-neutral-200 placeholder:text-neutral-600 focus:outline-none focus:border-emerald-500/50"
        />
        <Textarea
          value={goal}
          onChange={(e) => setGoal(e.target.value)}
          placeholder="用自然语言描述任务，如：打开百度搜索 DeepThink 并截图"
          rows={2}
          className="text-xs bg-[#0f0f14] border-[#2a2b36] rounded text-neutral-200 placeholder:text-neutral-600 resize-none focus-visible:ring-0"
        />
        <div className="flex items-center gap-2">
          {running ? (
            <Button size="sm" variant="destructive" onClick={handleStop}>
              <Square className="w-3.5 h-3.5" /> 停止
            </Button>
          ) : (
            <Button
              size="sm"
              onClick={handleSubmit}
              disabled={!goal.trim() || submitting}
              className="bg-emerald-600 hover:bg-emerald-500 text-white"
            >
              {submitting ? <Loader2 className="w-3.5 h-3.5 animate-spin" /> : <Play className="w-3.5 h-3.5" />}
              执行任务
            </Button>
          )}
          {(steps.length > 0 || summary) && !running && (
            <Button size="sm" variant="ghost" onClick={() => clearAgent(sessionId)} className="text-neutral-400">
              <Trash2 className="w-3.5 h-3.5" /> 清空
            </Button>
          )}
        </div>
      </div>

      {/* Steps */}
      <div className="flex-1 overflow-auto p-2 space-y-2">
        {steps.length === 0 && !summary && (
          <div className="text-center text-neutral-600 text-xs py-6">
            输入任务并点击「执行任务」，Agent 将自动驱动浏览器。
          </div>
        )}
        {steps.map((s, i) => (
          <div key={i} className="rounded border border-[#2a2b36] bg-[#15151c] overflow-hidden">
            <div className="flex items-start gap-2 p-2">
              {s.screenshot ? (
                <img src={s.screenshot} alt="step" className="w-24 h-16 object-cover rounded border border-[#2a2b36] flex-shrink-0" />
              ) : (
                <div className="w-24 h-16 rounded border border-[#2a2b36] flex-shrink-0 bg-[#0f0f14]" />
              )}
              <div className="flex-1 min-w-0 space-y-0.5">
                <div className="flex items-center gap-1.5">
                  <span className="text-[10px] px-1.5 py-0.5 rounded bg-emerald-900/40 text-emerald-400 font-mono">
                    #{s.step}
                  </span>
                  <span className="text-[10px] px-1.5 py-0.5 rounded bg-[#2a2b36] text-neutral-300 font-mono">
                    {String(s.action?.type ?? '?')}
                  </span>
                </div>
                <p className="text-[11px] text-neutral-400 line-clamp-2">{s.thought}</p>
                <p className="text-[11px] text-neutral-500 line-clamp-1">→ {s.result}</p>
              </div>
            </div>
          </div>
        ))}
        {summary && (
          <div className="mt-2 p-2.5 rounded border border-amber-700/40 bg-amber-950/20 text-xs text-amber-300">
            <div className="flex items-center gap-1.5 font-medium">
              <ChevronRight className="w-3.5 h-3.5" /> 结果
            </div>
            <p className="mt-1 text-amber-200/80">{summary}</p>
          </div>
        )}
      </div>
    </div>
  );
}
