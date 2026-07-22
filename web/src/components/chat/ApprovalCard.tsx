/**
 * ApprovalCard — Super Agent Team P1.
 *
 * Rendered inside the chat message stream when a graph 'human' node pauses the
 * run (the backend persists an 'approval' attachment + pushes new_message).
 * Each button submits the chosen option to
 * POST /api/graph/runs/:id/nodes/:nodeId/approve, which marks the human node
 * completed + writes the decision into the run state + resumes the run.
 *
 * No IM/push — per the user's requirement the approval loop lives entirely in
 * the DeepThink chat.
 */
import { useState } from 'react';
import { apiFetch } from '../../api/client';

interface ApprovalCardProps {
  runId: string;
  nodeId: string;
  title: string;
  question: string;
  options: { label: string; value: string }[];
}

export function ApprovalCard({ runId, nodeId, title, question, options }: ApprovalCardProps) {
  const [submitting, setSubmitting] = useState<string | null>(null);
  const [submitted, setSubmitted] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);

  const handleApprove = async (value: string) => {
    if (submitting || submitted) return;
    setSubmitting(value);
    setError(null);
    try {
      await apiFetch(`/api/graph/runs/${runId}/nodes/${nodeId}/approve`, {
        method: 'POST',
        body: JSON.stringify({ optionId: value }),
      });
      setSubmitted(value);
    } catch (err) {
      setError((err as Error).message || '提交失败');
    } finally {
      setSubmitting(null);
    }
  };

  return (
    <div className="rounded-xl border border-indigo-200/70 dark:border-indigo-700/40 bg-indigo-50/50 dark:bg-indigo-950/30 overflow-hidden">
      <div className="px-4 py-3 border-b border-indigo-100/70 dark:border-indigo-800/40 flex items-center gap-2">
        <svg className="w-4 h-4 text-indigo-500 flex-shrink-0" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2">
          <path strokeLinecap="round" strokeLinejoin="round" d="M9 12l2 2 4-4m6 2a9 9 0 11-18 0 9 9 0 0118 0z" />
        </svg>
        <span className="text-sm font-semibold text-indigo-700 dark:text-indigo-300">{title}</span>
      </div>
      <div className="px-4 py-3">
        <p className="text-sm text-gray-700 dark:text-gray-200 whitespace-pre-wrap break-words mb-3">
          {question}
        </p>
        <div className="flex flex-wrap gap-2">
          {options.map((opt) => {
            const isSubmitted = submitted === opt.value;
            const isSubmittingThis = submitting === opt.value;
            return (
              <button
                key={opt.value}
                onClick={() => handleApprove(opt.value)}
                disabled={!!submitted || !!submitting}
                className={`px-3.5 py-1.5 rounded-lg text-sm font-medium transition-colors border disabled:opacity-60 disabled:cursor-not-allowed ${
                  isSubmitted
                    ? 'bg-emerald-500 text-white border-emerald-500'
                    : opt.value === 'reject'
                      ? 'bg-white dark:bg-gray-800 text-rose-600 dark:text-rose-400 border-rose-200 dark:border-rose-800/50 hover:bg-rose-50 dark:hover:bg-rose-950/30'
                      : 'bg-white dark:bg-gray-800 text-indigo-600 dark:text-indigo-300 border-indigo-200 dark:border-indigo-800/50 hover:bg-indigo-50 dark:hover:bg-indigo-950/30'
                }`}
              >
                {isSubmittingThis ? '提交中…' : isSubmitted ? `已选择 · ${opt.label}` : opt.label}
              </button>
            );
          })}
        </div>
        {submitted && (
          <p className="mt-2 text-xs text-emerald-600 dark:text-emerald-400">
            审批已提交，团队将继续执行。
          </p>
        )}
        {error && <p className="mt-2 text-xs text-rose-500">{error}</p>}
      </div>
    </div>
  );
}
