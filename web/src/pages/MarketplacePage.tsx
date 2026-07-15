import { useEffect, useState } from 'react';
import { useMarketplaceStore, type MarketplaceItemType, type MarketplaceItem, type MarketplaceStatus } from '../stores/marketplace';
import { useAuthStore } from '../stores/auth';
import { PageHeader } from '@/components/common/PageHeader';
import { Button } from '@/components/ui/button';
import { Card, CardContent } from '@/components/ui/card';
import { toast } from 'sonner';
import { Download, ShoppingBag, Star, Send, Check, X, MessageSquare, Flag } from 'lucide-react';

const TYPE_LABEL: Record<MarketplaceItemType, string> = {
  agent_template: 'Agent',
  mcp_template: 'MCP',
  skill_template: 'Skill',
  kb_template: 'KB',
};

const ALL_TYPES: MarketplaceItemType[] = ['agent_template', 'mcp_template', 'skill_template', 'kb_template'];

const STATUS_LABEL: Record<MarketplaceStatus, string> = {
  pending: '待审核',
  approved: '已通过',
  rejected: '已拒绝',
};

function Stars({ avg, count, size = 'sm' }: { avg: number; count: number; size?: 'sm' | 'lg' }) {
  const cls = size === 'lg' ? 'size-5' : 'size-3.5';
  return (
    <div className="flex items-center gap-1">
      <div className="flex items-center">
        {[1, 2, 3, 4, 5].map((n) => (
          <Star
            key={n}
            className={`${cls} ${n <= Math.round(avg) ? 'fill-amber-400 text-amber-400' : 'text-muted-foreground/40'}`}
          />
        ))}
      </div>
      {count > 0 && <span className="text-xs text-muted-foreground ml-1">{avg.toFixed(1)} ({count})</span>}
    </div>
  );
}

export function MarketplacePage() {
  const { list, load, install, loading } = useMarketplaceStore();
  const currentUser = useAuthStore((s) => s.user);
  const isAdmin = currentUser?.role === 'admin';
  const [filter, setFilter] = useState<MarketplaceItemType | 'all'>('all');
  const [statusFilter, setStatusFilter] = useState<MarketplaceStatus | 'approved'>('approved');
  const [selected, setSelected] = useState<MarketplaceItem | null>(null);
  const [showSubmit, setShowSubmit] = useState(false);

  useEffect(() => { load(undefined, isAdmin ? statusFilter as MarketplaceStatus : 'approved'); }, [load, isAdmin, statusFilter]);

  const handleInstall = async (id: string, name: string) => {
    const res = await install(id);
    if (res.success) toast.success(`Installed: ${name}`);
    else toast.error(res.message);
  };

  const filtered = filter === 'all' ? list : list.filter((i) => i.itemType === filter);

  return (
    <div className="mx-auto max-w-7xl px-4 py-6">
      <PageHeader
        title="市场"
        subtitle="浏览并安装 Agent / MCP / Skill / KB 模板（含评分与评论）"
        actions={
          <Button onClick={() => setShowSubmit(true)}>
            <Send className="size-4 mr-1" /> 提交模板
          </Button>
        }
      />

      <div className="mt-4 flex flex-wrap items-center gap-2">
        <button
          className={`px-3 py-1 text-sm rounded-md border ${filter === 'all' ? 'bg-teal-500 text-white' : 'bg-background'}`}
          onClick={() => setFilter('all')}
        >
          全部
        </button>
        {ALL_TYPES.map((t) => (
          <button
            key={t}
            className={`px-3 py-1 text-sm rounded-md border ${filter === t ? 'bg-teal-500 text-white' : 'bg-background'}`}
            onClick={() => setFilter(t)}
          >
            {TYPE_LABEL[t]}
          </button>
        ))}
        {isAdmin && (
          <div className="ml-auto flex items-center gap-1">
            <span className="text-xs text-muted-foreground">状态：</span>
            {(['approved', 'pending', 'rejected'] as MarketplaceStatus[]).map((s) => (
              <button
                key={s}
                className={`px-2 py-0.5 text-xs rounded-md border ${statusFilter === s ? 'bg-indigo-500 text-white' : 'bg-background'}`}
                onClick={() => setStatusFilter(s)}
              >
                {STATUS_LABEL[s]}
              </button>
            ))}
          </div>
        )}
      </div>

      {loading && <div className="text-sm text-muted-foreground mt-4">加载中…</div>}

      {filtered.length === 0 && !loading && (
        <div className="mt-10 text-center text-sm text-muted-foreground">
          <ShoppingBag className="size-10 mx-auto mb-2 opacity-50" />
          市场暂无内容。
        </div>
      )}

      <div className="mt-6 grid grid-cols-1 sm:grid-cols-2 lg:grid-cols-3 gap-4">
        {filtered.map((item) => (
          <Card key={item.id} className="cursor-pointer hover:shadow-md transition" onClick={() => setSelected(item)}>
            <CardContent className="p-4 space-y-2">
              <div className="flex items-start justify-between">
                <div className="font-medium truncate flex-1">{item.name}</div>
                <span className="text-xs px-1.5 py-0.5 rounded bg-muted">{TYPE_LABEL[item.itemType]}</span>
              </div>
              <div className="text-sm text-muted-foreground line-clamp-3 min-h-[3.5rem]">
                {item.description || '无描述'}
              </div>
              <div className="flex items-center justify-between text-xs text-muted-foreground">
                <span>作者 {item.authorName || '匿名'} · 安装 {item.installedCount}</span>
                {item.status && item.status !== 'approved' && (
                  <span className={`px-1.5 py-0.5 rounded ${item.status === 'pending' ? 'bg-amber-100 text-amber-700' : 'bg-red-100 text-red-700'}`}>
                    {STATUS_LABEL[item.status]}
                  </span>
                )}
              </div>
              <div className="flex items-center justify-between">
                <Stars avg={item.ratingAverage ?? 0} count={item.ratingCount ?? 0} />
                <div className="flex items-center gap-1" onClick={(e) => e.stopPropagation()}>
                  {isAdmin && item.status === 'pending' && (
                    <>
                      <Button size="sm" variant="ghost" onClick={async () => {
                        const ok = await useMarketplaceStore.getState().approve(item.id);
                        if (ok) { toast.success('已通过'); load(undefined, statusFilter as MarketplaceStatus); }
                        else toast.error('操作失败');
                      }} title="通过">
                        <Check className="size-4 text-emerald-600" />
                      </Button>
                      <Button size="sm" variant="ghost" onClick={async () => {
                        const ok = await useMarketplaceStore.getState().reject(item.id);
                        if (ok) { toast.success('已拒绝'); load(undefined, statusFilter as MarketplaceStatus); }
                        else toast.error('操作失败');
                      }} title="拒绝">
                        <X className="size-4 text-red-500" />
                      </Button>
                    </>
                  )}
                  <Button size="sm" onClick={() => handleInstall(item.id, item.name)}>
                    <Download className="size-4 mr-1" /> 安装
                  </Button>
                </div>
              </div>
              {item.tags && item.tags.length > 0 && (
                <div className="flex flex-wrap gap-1">
                  {item.tags.map((t) => (
                    <span key={t} className="text-xs px-1.5 py-0.5 rounded bg-muted/50">#{t}</span>
                  ))}
                </div>
              )}
            </CardContent>
          </Card>
        ))}
      </div>

      {selected && (
        <ItemDetailDrawer
          item={selected}
          onClose={() => setSelected(null)}
          onInstall={() => handleInstall(selected.id, selected.name)}
        />
      )}

      {showSubmit && (
        <SubmitDialog
          onClose={() => setShowSubmit(false)}
          onSubmitted={(item) => {
            toast.success('已提交，等待管理员审核');
            setShowSubmit(false);
            load(undefined, statusFilter as MarketplaceStatus);
            setSelected(item);
          }}
        />
      )}
    </div>
  );
}

function ItemDetailDrawer({
  item,
  onClose,
  onInstall,
}: {
  item: MarketplaceItem;
  onClose: () => void;
  onInstall: () => void;
}) {
  const { reviews, loadReviews, submitReview } = useMarketplaceStore();
  const [rating, setRating] = useState(5);
  const [comment, setComment] = useState('');
  const [submitting, setSubmitting] = useState(false);
  const [reportingId, setReportingId] = useState<string | null>(null);

  useEffect(() => { loadReviews(item.id); }, [item.id, loadReviews]);
  const reviewList = reviews[item.id] ?? [];

  const handleSubmit = async () => {
    if (rating < 1 || rating > 5) { toast.error('请选择 1-5 星'); return; }
    setSubmitting(true);
    const ok = await submitReview(item.id, rating, comment.trim());
    setSubmitting(false);
    if (ok) { toast.success('评论已提交'); setComment(''); }
    else toast.error('评论失败');
  };

  return (
    <div className="fixed inset-0 bg-black/40 flex items-center justify-center z-50" onClick={onClose}>
      <Card className="w-full max-w-2xl max-h-[80vh] overflow-y-auto" onClick={(e) => e.stopPropagation()}>
        <CardContent className="p-5 space-y-4">
          <div className="flex items-start justify-between">
            <div>
              <div className="text-lg font-semibold">{item.name}</div>
              <div className="text-xs text-muted-foreground mt-0.5">
                {TYPE_LABEL[item.itemType]} · 作者 {item.authorName || '匿名'} · 安装 {item.installedCount}
              </div>
            </div>
            <Button variant="outline" size="sm" onClick={onClose}>关闭</Button>
          </div>

          <div className="text-sm">{item.description || '无描述'}</div>

          <div className="flex items-center gap-2">
            <Stars avg={item.ratingAverage ?? 0} count={item.ratingCount ?? 0} size="lg" />
          </div>

          {item.tags && item.tags.length > 0 && (
            <div className="flex flex-wrap gap-1">
              {item.tags.map((t) => (
                <span key={t} className="text-xs px-1.5 py-0.5 rounded bg-muted/50">#{t}</span>
              ))}
            </div>
          )}

          <div className="flex justify-end">
            <Button onClick={onInstall}><Download className="size-4 mr-1" /> 安装</Button>
          </div>

          <div className="border-t pt-3 space-y-3">
            <div className="text-sm font-medium flex items-center gap-2">
              <MessageSquare className="size-4" /> 评论（{reviewList.length}）
            </div>

            <div className="space-y-2">
              <div className="flex items-center gap-2">
                <div className="flex items-center">
                  {[1, 2, 3, 4, 5].map((n) => (
                    <button key={n} onClick={() => setRating(n)}>
                      <Star className={`size-5 ${n <= rating ? 'fill-amber-400 text-amber-400' : 'text-muted-foreground/40'}`} />
                    </button>
                  ))}
                </div>
                <span className="text-xs text-muted-foreground">{rating} 星</span>
              </div>
              <textarea
                className="w-full px-3 py-2 border rounded-md bg-background text-sm"
                rows={3}
                placeholder="写下你的评价（可选，最长 2000 字符）"
                value={comment}
                onChange={(e) => setComment(e.target.value.slice(0, 2000))}
              />
              <div className="flex justify-end">
                <Button size="sm" onClick={handleSubmit} disabled={submitting}>
                  <Send className="size-4 mr-1" /> {submitting ? '提交中…' : '提交评论'}
                </Button>
              </div>
            </div>

            {reviewList.length === 0 ? (
              <div className="text-xs text-muted-foreground">暂无评论，期待你的第一条评价。</div>
            ) : (
              <div className="space-y-2 max-h-64 overflow-y-auto">
                {reviewList.map((r) => (
                  <div key={r.id} className="border-l-2 border-teal-400 pl-3 py-1">
                    <div className="flex items-center gap-2 text-xs">
                      <Stars avg={r.rating} count={0} />
                      <span className="text-muted-foreground">{new Date(r.createdAt).toLocaleString('zh-CN')}</span>
                      <button
                        className="ml-auto text-xs text-muted-foreground hover:text-red-600 flex items-center gap-1"
                        onClick={() => setReportingId(r.id)}
                      >
                        <Flag className="size-3" /> 举报
                      </button>
                    </div>
                    {r.comment && <div className="text-sm mt-1 whitespace-pre-wrap">{r.comment}</div>}
                  </div>
                ))}
              </div>
            )}
          </div>

          {reportingId && (
            <ReportDialog
              reviewId={reportingId}
              onClose={() => setReportingId(null)}
              onSubmitted={() => {
                setReportingId(null);
                toast.success('举报已提交，管理员将审核处理');
              }}
            />
          )}
        </CardContent>
      </Card>
    </div>
  );
}

function ReportDialog({
  reviewId,
  onClose,
  onSubmitted,
}: {
  reviewId: string;
  onClose: () => void;
  onSubmitted: () => void;
}) {
  const { reportReview } = useMarketplaceStore();
  const [reason, setReason] = useState('');
  const [submitting, setSubmitting] = useState(false);

  const handleSubmit = async () => {
    const trimmed = reason.trim();
    if (trimmed.length < 5) { toast.error('请填写至少 5 字符的举报理由'); return; }
    setSubmitting(true);
    const ok = await reportReview(reviewId, trimmed);
    setSubmitting(false);
    if (ok) onSubmitted();
    else toast.error('举报失败（该评论可能已被你举报过）');
  };

  return (
    <div className="fixed inset-0 bg-black/40 flex items-center justify-center z-50" onClick={onClose}>
      <Card className="w-full max-w-md" onClick={(e) => e.stopPropagation()}>
        <CardContent className="p-4 space-y-3">
          <div className="font-semibold flex items-center gap-2">
            <Flag className="size-4" /> 举报评论
          </div>
          <div className="text-xs text-muted-foreground">
            举报后管理员会审核该评论。多次被举报的评论可能被删除。
          </div>
          <textarea
            className="w-full px-3 py-2 border rounded-md bg-background text-sm"
            rows={4}
            placeholder="说明该评论存在的问题（5-500 字符）"
            value={reason}
            onChange={(e) => setReason(e.target.value.slice(0, 500))}
          />
          <div className="flex justify-end gap-2">
            <Button variant="outline" size="sm" onClick={onClose}>取消</Button>
            <Button size="sm" onClick={handleSubmit} disabled={submitting}>
              {submitting ? '提交中…' : '提交举报'}
            </Button>
          </div>
        </CardContent>
      </Card>
    </div>
  );
}

function SubmitDialog({
  onClose,
  onSubmitted,
}: {
  onClose: () => void;
  onSubmitted: (item: MarketplaceItem) => void;
}) {
  const { submit } = useMarketplaceStore();
  const [itemType, setItemType] = useState<MarketplaceItemType>('agent_template');
  const [name, setName] = useState('');
  const [description, setDescription] = useState('');
  const [authorName, setAuthorName] = useState('');
  const [tagsStr, setTagsStr] = useState('');
  const [payloadStr, setPayloadStr] = useState('{}');
  const [submitting, setSubmitting] = useState(false);

  const handleSubmit = async () => {
    if (!name.trim()) { toast.error('请填写名称'); return; }
    let payload: unknown;
    try { payload = JSON.parse(payloadStr); }
    catch { toast.error('payload 必须是合法 JSON'); return; }
    setSubmitting(true);
    const item = await submit({
      itemType,
      name: name.trim(),
      description: description.trim(),
      authorName: authorName.trim() || '匿名',
      tags: tagsStr.split(',').map((t) => t.trim()).filter(Boolean),
      payload,
    });
    setSubmitting(false);
    if (item) onSubmitted(item);
    else toast.error('提交失败');
  };

  return (
    <div className="fixed inset-0 bg-black/40 flex items-center justify-center z-50" onClick={onClose}>
      <Card className="w-full max-w-lg max-h-[80vh] overflow-y-auto" onClick={(e) => e.stopPropagation()}>
        <CardContent className="p-5 space-y-3">
          <div className="font-semibold">提交模板到市场</div>
          <div className="text-xs text-muted-foreground">提交后状态为 pending，等待管理员审核</div>
          <div className="grid grid-cols-2 gap-2">
            <select
              className="px-3 py-2 border rounded-md bg-background text-sm"
              value={itemType}
              onChange={(e) => setItemType(e.target.value as MarketplaceItemType)}
            >
              {ALL_TYPES.map((t) => <option key={t} value={t}>{TYPE_LABEL[t]}</option>)}
            </select>
            <input
              className="px-3 py-2 border rounded-md bg-background text-sm"
              placeholder="作者名（可空）"
              value={authorName}
              onChange={(e) => setAuthorName(e.target.value)}
            />
          </div>
          <input
            className="w-full px-3 py-2 border rounded-md bg-background text-sm"
            placeholder="名称"
            value={name}
            onChange={(e) => setName(e.target.value)}
          />
          <textarea
            className="w-full px-3 py-2 border rounded-md bg-background text-sm"
            placeholder="描述"
            rows={3}
            value={description}
            onChange={(e) => setDescription(e.target.value)}
          />
          <input
            className="w-full px-3 py-2 border rounded-md bg-background text-sm"
            placeholder="标签（逗号分隔）"
            value={tagsStr}
            onChange={(e) => setTagsStr(e.target.value)}
          />
          <textarea
            className="w-full px-3 py-2 border rounded-md bg-background text-sm font-mono"
            placeholder="payload (JSON)"
            rows={5}
            value={payloadStr}
            onChange={(e) => setPayloadStr(e.target.value)}
          />
          <div className="flex justify-end gap-2">
            <Button variant="outline" size="sm" onClick={onClose}>取消</Button>
            <Button size="sm" onClick={handleSubmit} disabled={submitting}>
              <Send className="size-4 mr-1" /> {submitting ? '提交中…' : '提交'}
            </Button>
          </div>
        </CardContent>
      </Card>
    </div>
  );
}
