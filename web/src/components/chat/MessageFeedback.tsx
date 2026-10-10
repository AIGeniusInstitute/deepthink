/**
 * 消息级反馈控件（PRD F1.1）。
 *
 * 设计约束来自 PRD 的一句话：**反馈必须零摩擦**。所以：
 *   - 点赞是单击即达，不弹窗、不追问（正向反馈追问会显著降低提交率）
 *   - 点踩才弹原因选择，且原因是**预置枚举**不是自由文本 —— 自由文本无法聚合，
 *     采了也分析不了（后端同样做了枚举校验）
 *   - 已选状态回显：刷新页面后按钮仍是选中态，否则用户会怀疑"我到底提交上没有"
 *
 * 失败静默：FLM 关闭或接口报错时只 toast 一次，绝不阻断消息阅读。
 */
import { useEffect, useState } from 'react';
import { ThumbsUp, ThumbsDown, Check, Loader2 } from 'lucide-react';
import { toast } from 'sonner';
import {
  Dialog, DialogContent, DialogHeader, DialogTitle, DialogFooter,
} from '@/components/ui/dialog';
import { Button } from '@/components/ui/button';
import { Textarea } from '@/components/ui/textarea';
import { REASON_TAGS, getMyFeedback, submitFeedback, isDegraded } from '../../api/flm';

interface MessageFeedbackProps {
  messageId: string;
  chatJid: string;
  sessionId?: string | null;
  /** 紧凑模式下行内展示，尺寸更小。 */
  compact?: boolean;
}

type LocalState = 'none' | 'liked' | 'rejected';

export function MessageFeedback({ messageId, chatJid, sessionId, compact }: MessageFeedbackProps) {
  const [state, setState] = useState<LocalState>('none');
  const [busy, setBusy] = useState(false);
  const [dialogOpen, setDialogOpen] = useState(false);
  const [tags, setTags] = useState<string[]>([]);
  const [correction, setCorrection] = useState('');

  // 回显：别让用户刷新后以为自己没提交过。
  useEffect(() => {
    let alive = true;
    getMyFeedback(messageId, chatJid)
      .then((r) => {
        if (!alive || !r.feedback) return;
        const t = r.feedback.type;
        if (t === 'explicit_like' || t === 'explicit_rating' || t === 'explicit_adopt') setState('liked');
        else if (t === 'explicit_reject' || t === 'explicit_correction') setState('rejected');
        setTags(r.feedback.reasonTags ?? []);
        setCorrection(r.feedback.correctionText ?? '');
      })
      .catch(() => {
        /* 回显失败不影响提交能力，静默 */
      });
    return () => {
      alive = false;
    };
  }, [messageId, chatJid]);

  async function send(payload: Parameters<typeof submitFeedback>[0], next: LocalState) {
    setBusy(true);
    try {
      const res = await submitFeedback(payload);
      if (isDegraded(res)) {
        toast.info('反馈模块当前已关闭，未记录');
        return;
      }
      setState(next);
      toast.success('感谢反馈');
    } catch {
      toast.error('反馈提交失败，请稍后重试');
    } finally {
      setBusy(false);
    }
  }

  function handleLike() {
    if (busy) return;
    if (state === 'liked') return;
    void send({ messageId, chatJid, sessionId, type: 'explicit_like', rating: 5 }, 'liked');
  }

  function handleRejectClick() {
    if (busy) return;
    setDialogOpen(true);
  }

  function submitReject() {
    setDialogOpen(false);
    const isCorrection = correction.trim().length > 0;
    void send(
      {
        messageId,
        chatJid,
        sessionId,
        // 带纠正文本的走 explicit_correction：这是知识条目的唯一来源，
        // 混进 explicit_reject 会让知识候选池里全是"没说什么"的空条目。
        type: isCorrection ? 'explicit_correction' : 'explicit_reject',
        rating: 1,
        reasonTags: tags,
        correctionText: isCorrection ? correction.trim() : null,
      },
      'rejected',
    );
  }

  const iconSize = compact ? 'w-3 h-3' : 'w-3.5 h-3.5';
  const btnClass = compact
    ? 'w-5 h-5 rounded flex items-center justify-center transition-colors cursor-pointer'
    : 'h-7 px-2 rounded-md flex items-center gap-1 text-xs transition-colors cursor-pointer';

  return (
    <>
      <div className="flex items-center gap-0.5" data-testid="message-feedback">
        <button
          type="button"
          onClick={handleLike}
          disabled={busy}
          data-testid="feedback-like"
          aria-pressed={state === 'liked'}
          title="有帮助"
          aria-label="这条回复有帮助"
          className={`${btnClass} ${
            state === 'liked'
              ? 'text-green-600 bg-green-500/10'
              : 'text-muted-foreground hover:text-foreground hover:bg-foreground/5'
          }`}
        >
          {busy && state !== 'liked' ? (
            <Loader2 className={`${iconSize} animate-spin`} />
          ) : state === 'liked' ? (
            <Check className={iconSize} />
          ) : (
            <ThumbsUp className={iconSize} />
          )}
        </button>

        <button
          type="button"
          onClick={handleRejectClick}
          disabled={busy}
          data-testid="feedback-reject"
          aria-pressed={state === 'rejected'}
          title="没解决"
          aria-label="这条回复没解决问题"
          className={`${btnClass} ${
            state === 'rejected'
              ? 'text-red-600 bg-red-500/10'
              : 'text-muted-foreground hover:text-foreground hover:bg-foreground/5'
          }`}
        >
          {state === 'rejected' ? <Check className={iconSize} /> : <ThumbsDown className={iconSize} />}
        </button>
      </div>

      <Dialog open={dialogOpen} onOpenChange={setDialogOpen}>
        <DialogContent className="sm:max-w-md">
          <DialogHeader>
            <DialogTitle>这条回复哪里不对？</DialogTitle>
          </DialogHeader>

          <div className="flex flex-wrap gap-2 py-2">
            {REASON_TAGS.map((t) => {
              const active = tags.includes(t);
              return (
                <button
                  key={t}
                  type="button"
                  onClick={() => setTags(active ? tags.filter((x) => x !== t) : [...tags, t])}
                  aria-pressed={active}
                  className={`px-3 py-1.5 text-xs rounded-full border transition-colors cursor-pointer ${
                    active
                      ? 'border-primary bg-primary/10 text-primary'
                      : 'border-border text-muted-foreground hover:border-foreground/30'
                  }`}
                >
                  {t}
                </button>
              );
            })}
          </div>

          <Textarea
            value={correction}
            onChange={(e) => setCorrection(e.target.value)}
            placeholder="补充说明：期望的正确答案是什么？（选填，填写后会作为知识条目候选送审）"
            rows={3}
            className="text-sm"
          />

          <DialogFooter>
            <Button variant="outline" onClick={() => setDialogOpen(false)}>取消</Button>
            <Button onClick={submitReject}>提交</Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>
    </>
  );
}
