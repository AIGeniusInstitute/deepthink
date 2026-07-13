import { useMemo, useState } from 'react';
import { Loader2, Wand2, Check, X } from 'lucide-react';
import { toast } from 'sonner';
import { Dialog, DialogContent, DialogHeader, DialogTitle } from '@/components/ui/dialog';
import { Button } from '@/components/ui/button';
import { useSkillsStore } from '@/stores/skills';

interface OptimizeSkillDialogProps {
  open: boolean;
  onClose: () => void;
  skillId: string;
  skillName: string;
}

interface DiffLine {
  type: 'added' | 'removed' | 'unchanged';
  text: string;
}

function computeDiff(original: string, optimized: string): DiffLine[] {
  const a = original.split('\n');
  const b = optimized.split('\n');
  // LCS table
  const m = a.length, n = b.length;
  const dp: number[][] = Array.from({ length: m + 1 }, () => new Array<number>(n + 1).fill(0));
  for (let i = m - 1; i >= 0; i--) {
    for (let j = n - 1; j >= 0; j--) {
      if (a[i] === b[j]) dp[i][j] = dp[i + 1][j + 1] + 1;
      else dp[i][j] = Math.max(dp[i + 1][j], dp[i][j + 1]);
    }
  }
  const result: DiffLine[] = [];
  let i = 0, j = 0;
  while (i < m && j < n) {
    if (a[i] === b[j]) {
      result.push({ type: 'unchanged', text: a[i] });
      i++; j++;
    } else if (dp[i + 1][j] >= dp[i][j + 1]) {
      result.push({ type: 'removed', text: a[i] });
      i++;
    } else {
      result.push({ type: 'added', text: b[j] });
      j++;
    }
  }
  while (i < m) { result.push({ type: 'removed', text: a[i++] }); }
  while (j < n) { result.push({ type: 'added', text: b[j++] }); }
  return result;
}

export function OptimizeSkillDialog({
  open,
  onClose,
  skillId,
  skillName,
}: OptimizeSkillDialogProps) {
  const [feedback, setFeedback] = useState('');
  const [optimizing, setOptimizing] = useState(false);
  const [applying, setApplying] = useState(false);
  const [optimizedContent, setOptimizedContent] = useState<string | null>(null);
  const [originalContent, setOriginalContent] = useState<string | null>(null);
  const optimizeSkill = useSkillsStore((s) => s.optimizeSkill);
  const applyOptimizedSkill = useSkillsStore((s) => s.applyOptimizedSkill);

  const diff = useMemo(() => {
    if (!optimizedContent || !originalContent) return [];
    return computeDiff(originalContent, optimizedContent);
  }, [optimizedContent, originalContent]);

  const handleOptimize = async () => {
    setOptimizing(true);
    try {
      const result = await optimizeSkill(skillId, feedback.trim() || undefined);
      setOptimizedContent(result.optimized_content);
      setOriginalContent(result.original_content);
    } catch (err: any) {
      toast.error(err?.message || 'AI 优化失败');
    } finally {
      setOptimizing(false);
    }
  };

  const handleApply = async () => {
    if (!optimizedContent) return;
    setApplying(true);
    try {
      await applyOptimizedSkill(skillId, optimizedContent);
      toast.success('优化已应用，原内容已备份');
      setOptimizedContent(null);
      setOriginalContent(null);
      setFeedback('');
      onClose();
    } catch (err: any) {
      toast.error(err?.message || '应用失败');
    } finally {
      setApplying(false);
    }
  };

  const handleClose = () => {
    if (optimizing || applying) return;
    setOptimizedContent(null);
    setOriginalContent(null);
    setFeedback('');
    onClose();
  };

  return (
    <Dialog open={open} onOpenChange={(v) => !v && handleClose()}>
      <DialogContent className="sm:max-w-2xl max-h-[85vh] flex flex-col overflow-hidden">
        <DialogHeader>
          <DialogTitle className="flex items-center gap-2">
            <Wand2 className="size-4 text-primary" />
            AI 优化技能：{skillName}
          </DialogTitle>
        </DialogHeader>

        <div className="space-y-4 min-h-0 flex flex-col overflow-hidden">
          <div>
            <label className="block text-sm font-medium text-foreground mb-2">
              优化反馈（可选）
            </label>
            <textarea
              className="w-full min-h-[60px] rounded-md border border-border bg-background px-3 py-2 text-sm resize-y focus:outline-none focus:ring-2 focus:ring-ring"
              placeholder="例如：描述过于笼统，希望更聚焦于错误处理；正文缺少示例"
              value={feedback}
              onChange={(e) => setFeedback(e.target.value)}
              disabled={optimizing || applying || !!optimizedContent}
              maxLength={300}
            />
          </div>

          {!optimizedContent && (
            <div className="flex justify-end gap-3">
              <Button type="button" variant="ghost" onClick={handleClose} disabled={optimizing}>
                取消
              </Button>
              <Button type="button" onClick={handleOptimize} disabled={optimizing}>
                {optimizing ? <Loader2 className="size-4 animate-spin" /> : <Wand2 className="size-4" />}
                生成优化预览
              </Button>
            </div>
          )}

          {optimizedContent && (
            <>
              <div className="flex-1 min-h-0 overflow-y-auto rounded-md border border-border bg-muted/30">
                <div className="font-mono text-xs">
                  {diff.map((line, idx) => (
                    <div
                      key={idx}
                      className={`px-2 py-0.5 whitespace-pre-wrap break-all ${
                        line.type === 'added'
                          ? 'bg-green-100 dark:bg-green-900/30 text-green-700 dark:text-green-300'
                          : line.type === 'removed'
                            ? 'bg-red-100 dark:bg-red-900/30 text-red-700 dark:text-red-300 line-through'
                            : ''
                      }`}
                    >
                      <span className="select-none opacity-60 mr-2">
                        {line.type === 'added' ? '+' : line.type === 'removed' ? '-' : ' '}
                      </span>
                      {line.text}
                    </div>
                  ))}
                </div>
              </div>
              <div className="flex justify-end gap-3 shrink-0">
                <Button
                  type="button"
                  variant="ghost"
                  onClick={() => {
                    setOptimizedContent(null);
                    setOriginalContent(null);
                  }}
                  disabled={applying}
                >
                  <X className="size-4" />
                  放弃
                </Button>
                <Button type="button" onClick={handleApply} disabled={applying}>
                  {applying ? <Loader2 className="size-4 animate-spin" /> : <Check className="size-4" />}
                  应用优化
                </Button>
              </div>
            </>
          )}
        </div>
      </DialogContent>
    </Dialog>
  );
}
