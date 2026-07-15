import { useEffect } from 'react';
import { Flag, Check, Trash2 } from 'lucide-react';
import { Button } from '@/components/ui/button';
import { Card } from '@/components/ui/card';
import { useUsersStore, type ReviewReport } from '../../stores/users';
import type { TabNotification } from './utils';

export function ReviewReportsTab({ setNotice, setError }: TabNotification) {
  const { reviewReports, loading, fetchReviewReports, resolveReviewReport } = useUsersStore();

  useEffect(() => { void fetchReviewReports(); }, [fetchReviewReports]);

  const handleResolve = async (report: ReviewReport, action: 'dismiss' | 'delete_review') => {
    const verb = action === 'dismiss' ? '驳回' : '删除评论';
    if (!confirm(`${verb}该举报？`)) return;
    const ok = await resolveReviewReport(report.id, action);
    if (ok) setNotice(`已${verb}`);
    else setError('处理失败');
  };

  return (
    <div className="space-y-4">
      <div className="text-sm text-muted-foreground">
        市场评论举报队列。驳回表示该举报不成立（保留评论）；删除评论将级联删除评论及其所有举报记录。
      </div>

      <Card className="divide-y divide-border overflow-hidden">
        {reviewReports.length === 0 ? (
          <div className="p-6 text-center text-sm text-muted-foreground">
            {loading ? '加载中…' : '暂无待处理举报'}
          </div>
        ) : (
          reviewReports.map((r) => (
            <div key={r.id} className="px-5 py-4 space-y-2">
              <div className="flex items-start justify-between gap-3">
                <div className="flex-1 min-w-0">
                  <div className="flex items-center gap-2 text-sm">
                    <Flag className="size-4 text-amber-600" />
                    <span className="font-medium">{r.reporter_username}</span>
                    <span className="text-muted-foreground">举报于 {new Date(r.created_at).toLocaleString('zh-CN')}</span>
                  </div>
                  <div className="mt-1 text-sm text-foreground bg-muted/30 rounded-md px-2 py-1.5">
                    {r.reason}
                  </div>
                  <div className="mt-2 text-xs text-muted-foreground">
                    涉及评论：{r.review.rating} 星 · {r.review.item_name}
                  </div>
                  {r.review.comment && (
                    <div className="mt-1 text-xs text-muted-foreground border-l-2 border-border pl-2">
                      {r.review.comment}
                    </div>
                  )}
                </div>
                <div className="flex flex-col gap-1 shrink-0">
                  <Button size="sm" variant="ghost" onClick={() => handleResolve(r, 'dismiss')} title="驳回（保留评论）">
                    <Check className="size-4 text-emerald-600" /> 驳回
                  </Button>
                  <Button size="sm" variant="ghost" onClick={() => handleResolve(r, 'delete_review')} title="删除评论">
                    <Trash2 className="size-4 text-red-500" /> 删除
                  </Button>
                </div>
              </div>
            </div>
          ))
        )}
      </Card>
    </div>
  );
}
