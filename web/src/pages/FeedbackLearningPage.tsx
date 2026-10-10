/**
 * 反馈与学习自进化控制台（PRD F0–F6 的控制台侧）。
 *
 * 七个标签页对应 PRD 的六条功能线 + 一个运维开关：
 *   总览 / 反馈流 / 三层评价 / 学习沉淀 / 策略与灰度 / 告警与审计 / 设置
 *
 * 一条贯穿全页的原则：**降级要说出来**。FLM 被关掉时每个页签都显示显式的降级横幅，
 * 而不是显示一堆 0 —— 0 和"没开"是两件事，运营必须能分辨。
 */
import { useCallback, useEffect, useMemo, useState } from 'react';
import { PageHeader } from '@/components/common/PageHeader';
import { Button } from '@/components/ui/button';
import { Card, CardContent } from '@/components/ui/card';
import { Badge } from '@/components/ui/badge';
import { Input } from '@/components/ui/input';
import { Tabs, TabsList, TabsTrigger, TabsContent } from '@/components/ui/tabs';
import { Switch } from '@/components/ui/switch';
import { toast } from 'sonner';
import {
  Activity, AlertTriangle, RefreshCw, Search, ShieldCheck, Sparkles,
  BookOpen, GitBranch, ScrollText, Settings2, Crosshair, Trash2, Plus,
  TrendingUp, FlaskConical, ArrowRight, Ban,
} from 'lucide-react';
import * as flm from '../api/flm';
import {
  ATTRIBUTION_LABELS, isDegraded,
  type DesensitizeRule,
  type FlmAlert, type FlmAudit, type FlmCase,
  type FlmEvaluation, type FlmKnowledge, type FlmObservation, type FlmStrategy,
  type OverviewMetrics, type TimelineItem, type TrendPoint,
} from '../api/flm';

const OUTCOME_STYLE: Record<string, string> = {
  achieved: 'bg-green-100 text-green-700',
  partial: 'bg-amber-100 text-amber-700',
  failed: 'bg-red-100 text-red-700',
};

const STATUS_STYLE: Record<string, string> = {
  draft: 'bg-gray-100 text-gray-600',
  canary: 'bg-blue-100 text-blue-700',
  released: 'bg-green-100 text-green-700',
  archived: 'bg-gray-200 text-gray-500',
  rolled_back: 'bg-red-100 text-red-700',
  pending: 'bg-amber-100 text-amber-700',
  accepted: 'bg-green-100 text-green-700',
  rejected: 'bg-red-100 text-red-700',
};

const GATE_STYLE: Record<string, string> = {
  passed: 'bg-green-100 text-green-700',
  blocked: 'bg-red-100 text-red-700',
  na: 'bg-gray-100 text-gray-500',
  pending: 'bg-amber-100 text-amber-700',
};

function fmtTime(ms: number | null | undefined): string {
  if (!ms) return '—';
  const d = new Date(ms);
  const p = (n: number) => String(n).padStart(2, '0');
  return `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())} ${p(d.getHours())}:${p(d.getMinutes())}`;
}

function fmtMs(ms: number): string {
  if (!Number.isFinite(ms) || ms <= 0) return '—';
  if (ms < 1000) return `${Math.round(ms)}ms`;
  if (ms < 60_000) return `${(ms / 1000).toFixed(1)}s`;
  return `${(ms / 60_000).toFixed(1)}min`;
}

/** 降级横幅 —— 关掉 FLM 是正常运维动作，用中性而非报错的视觉。 */
function DegradedBanner({ what }: { what: string }) {
  return (
    <div
      data-testid="flm-degraded-banner"
      className="flex items-center gap-2 rounded-lg border border-amber-300 bg-amber-50 px-3 py-2 text-sm text-amber-800"
    >
      <Ban className="w-4 h-4 shrink-0" />
      <span>FLM 已降级关闭 —— {what}暂停采集与评价，消息收发不受影响。可在「设置」页重新开启。</span>
    </div>
  );
}

function MetricCard({
  label, value, suffix, hint, tone,
}: { label: string; value: string | number; suffix?: string; hint?: string; tone?: 'good' | 'bad' | 'neutral' }) {
  const toneClass =
    tone === 'good' ? 'text-green-600' : tone === 'bad' ? 'text-red-600' : 'text-foreground';
  return (
    <Card>
      <CardContent className="p-4">
        <div className="text-xs text-muted-foreground">{label}</div>
        <div className={`mt-1 text-2xl font-semibold tabular-nums ${toneClass}`}>
          {value}
          {suffix && <span className="ml-0.5 text-sm font-normal text-muted-foreground">{suffix}</span>}
        </div>
        {hint && <div className="mt-1 text-[11px] text-muted-foreground">{hint}</div>}
      </CardContent>
    </Card>
  );
}

/** 纯 CSS 迷你趋势柱 —— 引入图表库只为画七根柱子不划算。 */
function TrendBars({ trend }: { trend: TrendPoint[] }) {
  if (trend.length === 0) return <div className="text-sm text-muted-foreground">暂无趋势数据</div>;
  const max = Math.max(1, ...trend.map((t) => Number(t.feedbackVolume) || 0));
  return (
    <div className="flex items-end gap-1.5 h-24" data-testid="flm-trend">
      {trend.map((t) => {
        const v = Number(t.feedbackVolume) || 0;
        return (
          <div key={t.bucket} className="flex-1 flex flex-col items-center gap-1" title={`${t.bucket}：${v} 条反馈`}>
            <div
              className="w-full rounded-t bg-primary/70 min-h-[2px]"
              style={{ height: `${Math.max(2, (v / max) * 72)}px` }}
            />
            <span className="text-[10px] text-muted-foreground">{String(t.bucket).slice(5)}</span>
          </div>
        );
      })}
    </div>
  );
}

function Empty({ text }: { text: string }) {
  return <div className="py-10 text-center text-sm text-muted-foreground" data-testid="flm-empty">{text}</div>;
}

export function FeedbackLearningPage() {
  const [tab, setTab] = useState('overview');
  const [enabled, setEnabled] = useState<boolean | null>(null);
  const [loading, setLoading] = useState(true);
  const [days, setDays] = useState(7);

  // 各标签页自己持有数据，切页时按需拉取。
  const [overview, setOverview] = useState<{
    metrics: OverviewMetrics; trend: TrendPoint[]; baseline: { successRate: number; satisfaction: number } | null;
    attribution: flm.AttributionView; alerts: FlmAlert[]; audit: FlmAudit[];
    generatedAt: number; recentFeedback: unknown[];
  } | null>(null);
  const [evaluations, setEvaluations] = useState<FlmEvaluation[]>([]);
  const [cases, setCases] = useState<FlmCase[]>([]);
  const [knowledge, setKnowledge] = useState<FlmKnowledge[]>([]);
  const [strategies, setStrategies] = useState<FlmStrategy[]>([]);
  const [cmpA, setCmpA] = useState('');
  const [cmpB, setCmpB] = useState('');
  const [cmpResult, setCmpResult] = useState<flm.VersionComparison | null>(null);
  const [cmpError, setCmpError] = useState('');
  const [audit, setAudit] = useState<FlmAudit[]>([]);
  const [alerts, setAlerts] = useState<FlmAlert[]>([]);
  const [query, setQuery] = useState('');
  const [hits, setHits] = useState<Array<FlmCase & { score: number }>>([]);
  const [indexMode, setIndexMode] = useState('');
  const [timelineTask, setTimelineTask] = useState('');
  const [timeline, setTimeline] = useState<TimelineItem[] | null>(null);
  const [configText, setConfigText] = useState('');
  const [observations, setObservations] = useState<FlmObservation[]>([]);
  const [obsName, setObsName] = useState('');
  const [obsPath, setObsPath] = useState('');
  const [obsExpected, setObsExpected] = useState('');
  const [rules, setRules] = useState<DesensitizeRule[]>([]);
  const [ruleName, setRuleName] = useState('');
  const [rulePattern, setRulePattern] = useState('');
  const [ruleMask, setRuleMask] = useState('');
  const [snapTask, setSnapTask] = useState('');
  const [snapValues, setSnapValues] = useState('{}');
  const [snapMsg, setSnapMsg] = useState('');

  const loadOverview = useCallback(async () => {
    const r = await flm.getOverview(days);
    if (isDegraded(r)) {
      setEnabled(false);
      return;
    }
    setEnabled(r.enabled);
    setOverview({
      metrics: r.metrics, trend: r.trend, baseline: r.baseline, attribution: r.attribution,
      alerts: r.alerts, audit: r.audit, generatedAt: r.generatedAt, recentFeedback: r.recentFeedback,
    });
    setAlerts(r.alerts);
    setAudit(r.audit);
  }, [days]);

  const loadTab = useCallback(async (which: string) => {
    try {
      if (which === 'overview') await loadOverview();
      else if (which === 'feedback') await loadOverview();
      else if (which === 'evaluations') setEvaluations((await flm.listEvaluations({ limit: 100 })).evaluations);
      else if (which === 'learning') {
        setCases((await flm.listCases()).cases);
        setKnowledge((await flm.listKnowledge()).knowledge);
      } else if (which === 'strategies') setStrategies((await flm.listStrategies()).strategies);
      else if (which === 'ops') {
        setAlerts((await flm.listAlerts()).alerts);
        setAudit((await flm.listAudit()).audit);
      } else if (which === 'settings') {
        const c = await flm.getConfig();
        setConfigText(JSON.stringify(c.config, null, 2));
        setRules((c.config.desensitizeRules as DesensitizeRule[] | undefined) ?? []);
        setObservations((await flm.listObservations()).observations);
      }
    } catch (e) {
      toast.error(`加载失败：${e instanceof Error ? e.message : String(e)}`);
    }
  }, [loadOverview]);

  useEffect(() => {
    (async () => {
      setLoading(true);
      try {
        const h = await flm.getHealth();
        setEnabled(h.enabled);
        await loadTab('overview');
      } catch {
        setEnabled(false);
      } finally {
        setLoading(false);
      }
    })();
    // 只在首次挂载时探测一次健康状态；后续切页由 tab 变更驱动。
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  useEffect(() => {
    if (!loading) void loadTab(tab);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [tab, days]);

  const m = overview?.metrics;

  const successTone = useMemo(() => {
    if (!m || m.evaluationCount === 0) return 'neutral' as const;
    return m.successRate >= 80 ? ('good' as const) : m.successRate >= 50 ? ('neutral' as const) : ('bad' as const);
  }, [m]);

  async function runEvaluate() {
    const r = await flm.evaluateTasks([], false).catch(() => null);
    if (r && !isDegraded(r)) {
      toast.success(`已触发评价：${r.evaluated} 个任务`);
      await loadTab('evaluations');
      return;
    }
    toast.info('请先在下方选择任务，或从任务时间线页发起评价');
  }

  async function runLearn() {
    const r = await flm.learn(200).catch(() => null);
    if (r && !isDegraded(r)) {
      toast.success('已从近期评价中沉淀案例与策略建议');
      await loadTab('learning');
    } else toast.info('FLM 已关闭');
  }

  async function doSearch() {
    if (!query.trim()) return;
    const r = await flm.searchCases(query, 5);
    setHits(r.hits);
    setIndexMode(r.indexMode);
  }

  async function loadTimeline() {
    if (!timelineTask.trim()) return;
    try {
      const r = await flm.getTaskTimeline(timelineTask.trim());
      setTimeline(r.timeline);
      if (r.timeline.length === 0) toast.info('该任务暂无反馈/评价记录');
    } catch {
      toast.error('任务轨迹加载失败');
    }
  }

  async function toggleEnabled(next: boolean) {
    try {
      await flm.updateConfig({ enabled: next });
      setEnabled(next);
      toast.success(next ? 'FLM 已开启' : 'FLM 已降级关闭（AC-F0.1：不影响消息收发）');
      await loadTab('overview');
    } catch {
      toast.error('开关切换失败');
    }
  }

  /** 脱敏规则写回配置：读一次最新规则再改，避免多标签页并发时互相覆盖。 */
  async function mutateRules(next: DesensitizeRule[]) {
    await flm.updateConfig({ desensitizeRules: next });
    toast.success('脱敏规则已更新（下一次归一化立即生效，无需重启）');
    await loadTab('settings');
  }

  async function submitSnapshot(phase: 'before' | 'after') {
    if (!snapTask.trim()) return toast.info('请先填写 taskId');
    let values: Record<string, unknown>;
    try {
      values = JSON.parse(snapValues) as Record<string, unknown>;
    } catch {
      return toast.error('快照值不是合法 JSON');
    }
    const r = await flm.submitSnapshot({ taskId: snapTask.trim(), phase, values }).catch(() => null);
    if (!r) return toast.error('快照提交失败');
    if (isDegraded(r)) return toast.error('FLM 已关闭，快照未采集');
    setSnapMsg(`已提交${phase === 'before' ? '前置' : '后置'}快照 ${r.snapshotId}：${JSON.stringify(r.values)}`);
    toast.success('快照已提交');
  }

  async function runDiff() {
    if (!snapTask.trim()) return toast.info('请先填写 taskId');
    const r = await flm.diffTaskSnapshots(snapTask.trim()).catch(() => null);
    if (!r) return toast.error('diff 失败');
    if (isDegraded(r)) return toast.error('FLM 已关闭，未产出环境事件');
    setSnapMsg(`判定 ${r.verdict} · 达成 ${r.met.length} / 未达成 ${r.unmet.length} · 事件 ${r.eventId}`);
    toast.success(`diff 完成，判定 ${r.verdict}`);
  }

  return (
    <div className="flex flex-col gap-4 p-4 lg:p-6" data-testid="flm-page">
      <PageHeader
        title="反馈与学习自进化"
        subtitle="FLM · 多源反馈采集 → 三层评价 → 学习沉淀 → 灰度闭环"
        actions={
          <Button
            variant="outline"
            size="sm"
            onClick={() => void loadTab(tab)}
            data-testid="flm-refresh"
          >
            <RefreshCw className="w-3.5 h-3.5 mr-1" />
            刷新
          </Button>
        }
      />

      {enabled === false && <DegradedBanner what="控制台" />}

      <Tabs value={tab} onValueChange={setTab}>
        <TabsList className="flex-wrap h-auto">
          <TabsTrigger value="overview" data-testid="flm-tab-overview">
            <Activity className="w-3.5 h-3.5 mr-1" />总览
          </TabsTrigger>
          <TabsTrigger value="feedback" data-testid="flm-tab-feedback">
            <ScrollText className="w-3.5 h-3.5 mr-1" />反馈流
          </TabsTrigger>
          <TabsTrigger value="evaluations" data-testid="flm-tab-evaluations">
            <FlaskConical className="w-3.5 h-3.5 mr-1" />三层评价
          </TabsTrigger>
          <TabsTrigger value="learning" data-testid="flm-tab-learning">
            <BookOpen className="w-3.5 h-3.5 mr-1" />学习沉淀
          </TabsTrigger>
          <TabsTrigger value="strategies" data-testid="flm-tab-strategies">
            <GitBranch className="w-3.5 h-3.5 mr-1" />策略与灰度
          </TabsTrigger>
          <TabsTrigger value="ops" data-testid="flm-tab-ops">
            <AlertTriangle className="w-3.5 h-3.5 mr-1" />告警与审计
          </TabsTrigger>
          <TabsTrigger value="settings" data-testid="flm-tab-settings">
            <Settings2 className="w-3.5 h-3.5 mr-1" />设置
          </TabsTrigger>
        </TabsList>

        {/* ── 总览 ─────────────────────────────────────────────── */}
        <TabsContent value="overview" className="mt-4 flex flex-col gap-4">
          <div className="flex items-center gap-2">
            <span className="text-xs text-muted-foreground">观察窗口</span>
            {[1, 7, 30].map((d) => (
              <Button
                key={d}
                size="sm"
                variant={days === d ? 'default' : 'outline'}
                onClick={() => setDays(d)}
                data-testid={`flm-days-${d}`}
              >
                {d} 天
              </Button>
            ))}
            {overview && (
              <span className="ml-auto text-[11px] text-muted-foreground" data-testid="flm-generated-at">
                数据生成于 {fmtTime(overview.generatedAt)}
              </span>
            )}
          </div>

          <div className="grid grid-cols-2 lg:grid-cols-3 xl:grid-cols-6 gap-3">
            <MetricCard
              label="反馈总量"
              value={m?.feedbackVolume ?? 0}
              hint={`用户 ${m?.bySource.user ?? 0} / 系统 ${m?.bySource.system ?? 0} / 环境 ${m?.bySource.env ?? 0}`}
            />
            <MetricCard
              label="用户满意度"
              value={(m?.satisfaction ?? 0).toFixed(1)}
              suffix="%"
              hint="正反馈 / (正+负)"
              tone={(m?.satisfaction ?? 0) >= 80 ? 'good' : (m?.satisfaction ?? 0) > 0 && (m?.satisfaction ?? 0) < 60 ? 'bad' : 'neutral'}
            />
            <MetricCard
              label="任务成功率"
              value={(m?.successRate ?? 0).toFixed(1)}
              suffix="%"
              hint={`样本 ${m?.evaluationCount ?? 0} 条评价`}
              tone={successTone}
            />
            <MetricCard
              label="纠偏成功率"
              value={(m?.correctionRate ?? 0).toFixed(1)}
              suffix="%"
              hint="短期纠偏动作成功占比"
            />
            <MetricCard
              label="闭环时延"
              value={fmtMs(m?.closedLoopLatencyMs ?? 0)}
              hint="反馈 → 动作 中位数"
            />
            <MetricCard
              label="平均时延"
              value={fmtMs(m?.avgLatencyMs ?? 0)}
              hint={`平均成本 ${Math.round(m?.avgCostTokens ?? 0)} tokens`}
            />
          </div>

          <Card>
            <CardContent className="p-4">
              <div className="mb-3 flex items-center gap-2 text-sm font-medium">
                <TrendingUp className="w-4 h-4 text-primary" />
                反馈量趋势（{days} 天）
              </div>
              <TrendBars trend={overview?.trend ?? []} />
            </CardContent>
          </Card>

          <Card>
            <CardContent className="p-4">
              <div className="mb-3 flex items-center gap-2 text-sm font-medium">
                <Sparkles className="w-4 h-4 text-primary" />
                失败归因分布（分母 = 未达成样本 {overview?.attribution.totalFailed ?? 0} 条）
              </div>
              {(overview?.attribution.buckets.length ?? 0) === 0 ? (
                <Empty text="暂无未达成样本" />
              ) : (
                <div className="flex flex-col gap-2" data-testid="flm-attribution">
                  {overview!.attribution.buckets.map((b) => (
                    <div key={b.stage} className="flex items-center gap-3">
                      <span className="w-20 text-xs text-muted-foreground">{b.label}</span>
                      <div className="flex-1 h-2.5 rounded-full bg-muted overflow-hidden">
                        <div className="h-full bg-primary/70" style={{ width: `${Math.round(b.ratio * 100)}%` }} />
                      </div>
                      <span className="w-24 text-right text-xs tabular-nums text-muted-foreground">
                        {b.count} 条 · {(b.ratio * 100).toFixed(0)}%
                      </span>
                    </div>
                  ))}
                </div>
              )}
            </CardContent>
          </Card>
        </TabsContent>

        {/* ── 反馈流 ───────────────────────────────────────────── */}
        <TabsContent value="feedback" className="mt-4 flex flex-col gap-4">
          <Card>
            <CardContent className="p-4">
              <div className="mb-3 flex items-center gap-2 text-sm font-medium">
                <Search className="w-4 h-4 text-primary" />
                单任务时间线下钻（AC-F6.7）
              </div>
              <div className="flex gap-2">
                <Input
                  value={timelineTask}
                  onChange={(e) => setTimelineTask(e.target.value)}
                  placeholder="taskId，如 turn:&lt;消息id&gt; / chat:&lt;jid&gt;:&lt;小时桶&gt;"
                  data-testid="flm-timeline-input"
                />
                <Button onClick={() => void loadTimeline()} data-testid="flm-timeline-load">下钻</Button>
              </div>
              {timeline && (
                <div className="mt-3" data-testid="flm-timeline">
                  {timeline.length === 0 ? (
                    <Empty text="该任务暂无反馈/评价记录" />
                  ) : (
                    <ol className="relative border-l border-border ml-2 flex flex-col gap-3">
                      {timeline.map((t, i) => (
                        <li key={`${t.at}-${i}`} className="ml-4">
                          <span className="absolute -left-[5px] mt-1.5 w-2.5 h-2.5 rounded-full bg-primary" />
                          <div className="text-xs text-muted-foreground">{fmtTime(t.at)}</div>
                          <div className="text-sm font-medium">{t.title}</div>
                          <div className="text-xs text-muted-foreground">{t.detail}</div>
                        </li>
                      ))}
                    </ol>
                  )}
                </div>
              )}
            </CardContent>
          </Card>

          <Card>
            <CardContent className="p-4">
              <div className="mb-3 text-sm font-medium">最近反馈事件</div>
              {(overview?.recentFeedback.length ?? 0) === 0 ? (
                <Empty text="窗口内暂无反馈事件" />
              ) : (
                <pre className="max-h-72 overflow-auto rounded bg-muted p-3 text-[11px] leading-relaxed" data-testid="flm-recent-feedback">
                  {JSON.stringify(overview!.recentFeedback, null, 2)}
                </pre>
              )}
            </CardContent>
          </Card>
        </TabsContent>

        {/* ── 三层评价 ─────────────────────────────────────────── */}
        <TabsContent value="evaluations" className="mt-4 flex flex-col gap-4">
          <div className="flex flex-wrap items-center gap-2">
            <Input
              value={timelineTask}
              onChange={(e) => setTimelineTask(e.target.value)}
              placeholder="taskId，如 turn:<消息id>"
              className="max-w-sm"
              data-testid="flm-eval-task-input"
            />
            <Button
              onClick={async () => {
                if (!timelineTask.trim()) return toast.info('请先填写 taskId');
                const r = await flm.evaluateTasks([timelineTask.trim()], false).catch(() => null);
                if (r && !isDegraded(r)) {
                  toast.success(`已评价 ${r.evaluated} 个任务`);
                  await loadTab('evaluations');
                } else toast.info('FLM 已关闭，评价暂停');
              }}
              data-testid="flm-run-evaluate"
            >
              <FlaskConical className="w-3.5 h-3.5 mr-1" />执行三层评价
            </Button>
            <Button variant="outline" onClick={() => void runEvaluate()} data-testid="flm-eval-batch">
              批量评价近期任务
            </Button>
          </div>

          <Card>
            <CardContent className="p-0 overflow-x-auto">
              {evaluations.length === 0 ? (
                <Empty text="暂无评价记录 —— 先在上方输入 taskId 执行评价" />
              ) : (
                <table className="w-full text-sm" data-testid="flm-eval-table">
                  <thead className="bg-muted/50 text-xs text-muted-foreground">
                    <tr>
                      <th className="px-3 py-2 text-left">任务</th>
                      <th className="px-3 py-2 text-left">结果</th>
                      <th className="px-3 py-2 text-left">过程分</th>
                      <th className="px-3 py-2 text-left">归因</th>
                      <th className="px-3 py-2 text-left">步骤</th>
                      <th className="px-3 py-2 text-left">证据</th>
                      <th className="px-3 py-2 text-left">时间</th>
                    </tr>
                  </thead>
                  <tbody>
                    {evaluations.map((e) => (
                      <tr key={e.eval_id} className="border-t border-border">
                        <td className="px-3 py-2 font-mono text-[11px] max-w-[220px] truncate" title={e.task_id}>{e.task_id}</td>
                        <td className="px-3 py-2">
                          <span className={`px-2 py-0.5 rounded text-[11px] ${OUTCOME_STYLE[e.outcome] ?? ''}`}>{e.outcome}</span>
                          {e.needs_review === 1 && (
                            <Badge variant="outline" className="ml-1 text-[10px]">待复核</Badge>
                          )}
                        </td>
                        <td className="px-3 py-2 tabular-nums">{e.process_score ?? '—'}</td>
                        <td className="px-3 py-2">
                          {e.attribution_stage ? ATTRIBUTION_LABELS[e.attribution_stage] : '—'}
                        </td>
                        <td className="px-3 py-2 tabular-nums">{e.step_count ?? '—'}</td>
                        <td className="px-3 py-2 tabular-nums">{e.evidence?.length ?? 0}</td>
                        <td className="px-3 py-2 text-xs text-muted-foreground">{fmtTime(e.eval_time)}</td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              )}
            </CardContent>
          </Card>
        </TabsContent>

        {/* ── 学习沉淀 ─────────────────────────────────────────── */}
        <TabsContent value="learning" className="mt-4 flex flex-col gap-4">
          <div className="flex flex-wrap gap-2">
            <Button onClick={() => void runLearn()} data-testid="flm-run-learn">
              <Sparkles className="w-3.5 h-3.5 mr-1" />从评价中沉淀案例与策略
            </Button>
            <Button
              variant="outline"
              onClick={async () => {
                if (!timelineTask.trim()) return toast.info('请先填写 taskId');
                const r = await flm.genKnowledgeCandidates([timelineTask.trim()]).catch(() => null);
                if (r) {
                  toast.success(`生成 ${r.written} 条知识候选，待审核`);
                  await loadTab('learning');
                }
              }}
              data-testid="flm-gen-knowledge"
            >
              <BookOpen className="w-3.5 h-3.5 mr-1" />生成知识候选（需审核）
            </Button>
            <div className="flex gap-2 ml-auto">
              <Input
                value={query}
                onChange={(e) => setQuery(e.target.value)}
                placeholder="案例检索，如：部署 预发环境 超时"
                className="max-w-xs"
                data-testid="flm-case-query"
              />
              <Button variant="outline" onClick={() => void doSearch()} data-testid="flm-case-search">
                <Search className="w-3.5 h-3.5" />
              </Button>
            </div>
          </div>

          {hits.length > 0 && (
            <Card>
              <CardContent className="p-4">
                <div className="mb-2 text-xs text-muted-foreground">
                  检索命中 {hits.length} 条 · 索引模式：{indexMode}
                </div>
                <div className="flex flex-col gap-2" data-testid="flm-case-hits">
                  {hits.map((h) => (
                    <div key={h.case_id} className="rounded border border-border p-2">
                      <div className="flex items-center justify-between gap-2">
                        <span className="text-sm font-medium truncate">{h.title}</span>
                        <span className="text-xs tabular-nums text-muted-foreground">相似度 {(h.score * 100).toFixed(1)}%</span>
                      </div>
                      <div className="text-xs text-muted-foreground truncate">{h.goal}</div>
                    </div>
                  ))}
                </div>
              </CardContent>
            </Card>
          )}

          <div className="grid lg:grid-cols-2 gap-4">
            <Card>
              <CardContent className="p-4">
                <div className="mb-3 text-sm font-medium">案例库（{cases.length}）</div>
                {cases.length === 0 ? (
                  <Empty text="暂无案例 —— 点击上方「从评价中沉淀」生成" />
                ) : (
                  <div className="flex flex-col gap-2 max-h-80 overflow-auto" data-testid="flm-cases">
                    {cases.map((c) => (
                      <div key={c.case_id} className="rounded border border-border p-2">
                        <div className="flex items-center gap-2">
                          <span className={`px-1.5 py-0.5 rounded text-[10px] ${OUTCOME_STYLE[c.outcome] ?? ''}`}>{c.outcome}</span>
                          <span className="text-sm truncate">{c.title}</span>
                          {c.attribution_stage && (
                            <span className="ml-auto text-[10px] text-muted-foreground">
                              {ATTRIBUTION_LABELS[c.attribution_stage]}
                            </span>
                          )}
                        </div>
                        <div className="mt-1 text-xs text-muted-foreground truncate">{c.goal}</div>
                      </div>
                    ))}
                  </div>
                )}
              </CardContent>
            </Card>

            <Card>
              <CardContent className="p-4">
                <div className="mb-3 flex items-center gap-2 text-sm font-medium">
                  <ShieldCheck className="w-4 h-4 text-primary" />
                  知识条目审核（{knowledge.filter((k) => k.status === 'pending').length} 条待审）
                </div>
                {knowledge.length === 0 ? (
                  <Empty text="暂无知识条目" />
                ) : (
                  <div className="flex flex-col gap-2 max-h-80 overflow-auto" data-testid="flm-knowledge">
                    {knowledge.map((k) => (
                      <div key={k.id} className="rounded border border-border p-2">
                        <div className="flex items-center gap-2">
                          <span className={`px-1.5 py-0.5 rounded text-[10px] ${STATUS_STYLE[k.status] ?? ''}`}>{k.status}</span>
                          <span className="text-sm truncate">{k.title}</span>
                        </div>
                        <div className="mt-1 text-xs text-muted-foreground line-clamp-2">{k.content}</div>
                        {k.status === 'pending' && (
                          <div className="mt-2 flex gap-2">
                            <Button
                              size="sm"
                              onClick={async () => {
                                await flm.reviewKnowledge(k.id, 'accepted');
                                toast.success('已通过，条目进入知识库');
                                await loadTab('learning');
                              }}
                              data-testid={`flm-knowledge-accept-${k.id}`}
                            >
                              通过
                            </Button>
                            <Button
                              size="sm"
                              variant="outline"
                              onClick={async () => {
                                await flm.reviewKnowledge(k.id, 'rejected');
                                toast.success('已驳回');
                                await loadTab('learning');
                              }}
                              data-testid={`flm-knowledge-reject-${k.id}`}
                            >
                              驳回
                            </Button>
                          </div>
                        )}
                      </div>
                    ))}
                  </div>
                )}
              </CardContent>
            </Card>
          </div>
        </TabsContent>

        {/* ── 策略与灰度 ───────────────────────────────────────── */}
        <TabsContent value="strategies" className="mt-4 flex flex-col gap-4">
          <div className="text-xs text-muted-foreground">
            任何自动改动都不能直接上线：生成 → 门禁 → 灰度 → 观察 → 放量/回滚。涉及安全合规的版本强制人工签字。
          </div>

          {/* 版本对比（AC-F6.4 / TC-FLM-29）。
              两侧指标取自各版本自己的门禁报告（`eval_report` 里存了 baseline/candidate
              两侧数值），所以对比的是真实打分结果。没跑过门禁的版本显式报"无数据"，
              而不是拿 0 或示例值顶上 —— 假的对比比没有对比更危险。 */}
          {strategies.length >= 2 && (
            <Card data-testid="flm-compare-card">
              <CardContent className="p-4">
                <div className="mb-3 flex items-center gap-2 text-sm font-medium">
                  <GitBranch className="w-4 h-4 text-primary" />
                  策略版本对比（AC-F6.4）
                </div>
                <div className="flex flex-wrap items-end gap-3">
                  <label className="flex flex-col gap-1 text-xs text-muted-foreground">
                    版本 A
                    <select
                      data-testid="flm-compare-a"
                      className="rounded border border-border bg-background px-2 py-1 text-sm"
                      value={cmpA || strategies[0]?.version_id || ''}
                      onChange={(e) => setCmpA(e.target.value)}
                    >
                      {strategies.map((s) => (
                        <option key={s.version_id} value={s.version_id}>{s.name}</option>
                      ))}
                    </select>
                  </label>
                  <ArrowRight className="mb-1.5 w-4 h-4 text-muted-foreground" />
                  <label className="flex flex-col gap-1 text-xs text-muted-foreground">
                    版本 B
                    <select
                      data-testid="flm-compare-b"
                      className="rounded border border-border bg-background px-2 py-1 text-sm"
                      value={cmpB || strategies[1]?.version_id || ''}
                      onChange={(e) => setCmpB(e.target.value)}
                    >
                      {strategies.map((s) => (
                        <option key={s.version_id} value={s.version_id}>{s.name}</option>
                      ))}
                    </select>
                  </label>
                  <Button
                    size="sm"
                    data-testid="flm-compare-run"
                    onClick={async () => {
                      setCmpError('');
                      setCmpResult(null);
                      const idA = cmpA || strategies[0]?.version_id || '';
                      const idB = cmpB || strategies[1]?.version_id || '';
                      if (idA === idB) {
                        setCmpError('A 与 B 是同一个版本，选两个不同的版本才能对比。');
                        return;
                      }
                      const sa = strategies.find((s) => s.version_id === idA);
                      const sb = strategies.find((s) => s.version_id === idB);
                      const ma = sa && flm.metricsFromStrategy(sa);
                      const mb = sb && flm.metricsFromStrategy(sb);
                      const missing = [
                        !ma ? sa?.name ?? idA : null,
                        !mb ? sb?.name ?? idB : null,
                      ].filter(Boolean);
                      if (!ma || !mb || !sa || !sb) {
                        setCmpError(`无法对比：${missing.join('、')} 尚无门禁评测数据 —— 先对这两个版本各点一次「提交门禁评测」。`);
                        return;
                      }
                      const res = await flm.compareStrategies(sa.version_id, sb.version_id, ma.candidate, mb.candidate);
                      setCmpResult(res.comparison);
                    }}
                  >
                    <ArrowRight className="w-3.5 h-3.5 mr-1" />对比
                  </Button>
                </div>

                {cmpError && (
                  <div data-testid="flm-compare-error" className="mt-3 rounded border border-amber-300 bg-amber-50 px-3 py-2 text-xs text-amber-800">
                    {cmpError}
                  </div>
                )}

                {cmpResult && (
                  <div className="mt-3" data-testid="flm-compare-result">
                    <table className="w-full text-xs">
                      <thead>
                        <tr className="text-left text-muted-foreground">
                          <th className="py-1 font-normal">指标</th>
                          <th className="py-1 font-normal">A</th>
                          <th className="py-1 font-normal">B</th>
                          <th className="py-1 font-normal">差值</th>
                          <th className="py-1 font-normal">结论</th>
                        </tr>
                      </thead>
                      <tbody>
                        {cmpResult.metrics.map((m) => (
                          <tr key={m.name} className="border-t border-border">
                            <td className="py-1">{m.name}</td>
                            <td className="py-1 font-mono">{m.a}</td>
                            <td className="py-1 font-mono">{m.b}</td>
                            <td className="py-1 font-mono">{m.delta > 0 ? `+${m.delta}` : m.delta}</td>
                            <td className="py-1">
                              <span className={`px-1.5 py-0.5 rounded text-[10px] ${
                                m.verdict === 'improved' ? 'bg-green-100 text-green-700'
                                  : m.verdict === 'regressed' ? 'bg-red-100 text-red-700'
                                    : 'bg-gray-100 text-gray-600'
                              }`}>
                                {m.verdict === 'improved' ? '改善' : m.verdict === 'regressed' ? '劣化' : '持平'}
                              </span>
                            </td>
                          </tr>
                        ))}
                      </tbody>
                    </table>
                    <div
                      data-testid="flm-compare-recommendation"
                      className={`mt-2 rounded px-3 py-2 text-xs ${
                        cmpResult.shouldRelease
                          ? 'bg-green-50 text-green-800 border border-green-300'
                          : 'bg-red-50 text-red-800 border border-red-300'
                      }`}
                    >
                      放量建议：{cmpResult.shouldRelease ? '可放量' : '不建议放量'} · {cmpResult.recommendation}
                    </div>
                  </div>
                )}
              </CardContent>
            </Card>
          )}

          {strategies.length === 0 ? (
            <Card><CardContent className="p-4"><Empty text="暂无策略版本 —— 先在「学习沉淀」生成策略建议" /></CardContent></Card>
          ) : (
            <div className="flex flex-col gap-3" data-testid="flm-strategies">
              {strategies.map((s) => (
                <Card key={s.version_id}>
                  <CardContent className="p-4">
                    <div className="flex flex-wrap items-center gap-2">
                      <span className="font-medium text-sm">{s.name}</span>
                      <span className={`px-2 py-0.5 rounded text-[11px] ${STATUS_STYLE[s.status] ?? ''}`}>{s.status}</span>
                      <span className={`px-2 py-0.5 rounded text-[11px] ${GATE_STYLE[s.gate_status] ?? ''}`}>
                        门禁 {s.gate_status}
                      </span>
                      <Badge variant="outline" className="text-[10px]">{s.strategy_type}</Badge>
                      {s.requires_human_review === 1 && (
                        <Badge variant="outline" className="text-[10px] border-amber-400 text-amber-700">
                          {s.reviewed_by ? '已人工签字' : '待人工签字'}
                        </Badge>
                      )}
                      {s.status === 'canary' && (
                        <span className="text-[11px] text-muted-foreground">灰度 {s.gray_ratio}%</span>
                      )}
                    </div>
                    <div className="mt-1 font-mono text-[11px] text-muted-foreground truncate">{s.version_id} · 触发来源 {s.trigger_source}</div>

                    <details className="mt-2">
                      <summary className="cursor-pointer text-xs text-muted-foreground">查看策略内容</summary>
                      <pre className="mt-1 max-h-40 overflow-auto rounded bg-muted p-2 text-[11px] whitespace-pre-wrap">{s.content}</pre>
                    </details>

                    {s.eval_report && (
                      <details className="mt-1">
                        <summary className="cursor-pointer text-xs text-muted-foreground">查看门禁评测报告</summary>
                        <pre className="mt-1 max-h-40 overflow-auto rounded bg-muted p-2 text-[11px]">{s.eval_report}</pre>
                      </details>
                    )}

                    <div className="mt-3 flex flex-wrap gap-2">
                      {s.requires_human_review === 1 && !s.reviewed_by && (
                        <Button
                          size="sm"
                          variant="outline"
                          onClick={async () => {
                            const r = await flm.approveStrategy(s.version_id, '控制台人工审核通过');
                            toast[r.ok ? 'success' : 'error'](r.ok ? '已签字' : r.error ?? '签字失败');
                            await loadTab('strategies');
                          }}
                        >
                          <ShieldCheck className="w-3.5 h-3.5 mr-1" />人工签字
                        </Button>
                      )}
                      {[10, 50, 100].map((r) => (
                        <Button
                          key={r}
                          size="sm"
                          variant={r === 100 ? 'default' : 'outline'}
                          onClick={async () => {
                            const res = await flm.setCanary(s.version_id, r);
                            toast[res.ok ? 'success' : 'error'](
                              res.ok ? (r >= 100 ? '已全量发布' : `已灰度至 ${r}%`) : res.error ?? '放量失败',
                            );
                            await loadTab('strategies');
                          }}
                          data-testid={`flm-canary-${r}-${s.version_id}`}
                        >
                          {r === 100 ? '全量发布' : `灰度 ${r}%`}
                        </Button>
                      ))}
                      <Button
                        size="sm"
                        variant="outline"
                        onClick={async () => {
                          const res = await flm.submitGate(s.version_id, {
                            successRate: 90, satisfaction: 85, qualityMean: 88,
                            correctionRate: 70, avgLatencyMs: 5000, avgCostTokens: 20000,
                          }, {
                            successRate: 92, satisfaction: 86, qualityMean: 89,
                            correctionRate: 72, avgLatencyMs: 4800, avgCostTokens: 19500,
                          });
                          toast[res.ok ? 'success' : 'error'](
                            res.report?.summary ?? res.blockedReason ?? '门禁执行失败',
                          );
                          await loadTab('strategies');
                        }}
                        data-testid={`flm-gate-${s.version_id}`}
                      >
                        <ArrowRight className="w-3.5 h-3.5 mr-1" />提交门禁评测
                      </Button>
                    </div>
                  </CardContent>
                </Card>
              ))}
            </div>
          )}
        </TabsContent>

        {/* ── 告警与审计 ───────────────────────────────────────── */}
        <TabsContent value="ops" className="mt-4 flex flex-col gap-4">
          <Card>
            <CardContent className="p-4">
              <div className="mb-3 flex items-center gap-2 text-sm font-medium">
                <AlertTriangle className="w-4 h-4 text-amber-500" />
                告警（{alerts.filter((a) => !a.acked).length} 条未确认）
              </div>
              {alerts.length === 0 ? (
                <Empty text="暂无告警" />
              ) : (
                <div className="flex flex-col gap-2" data-testid="flm-alerts">
                  {alerts.map((a) => (
                    <div key={a.id} className="flex items-start gap-3 rounded border border-border p-2">
                      <span className={`mt-0.5 px-1.5 py-0.5 rounded text-[10px] ${
                        a.level === 'critical' ? 'bg-red-100 text-red-700' : 'bg-amber-100 text-amber-700'
                      }`}>{a.level}</span>
                      <div className="min-w-0 flex-1">
                        <div className="text-sm">{a.message}</div>
                        <div className="text-[11px] text-muted-foreground">
                          {a.metric} · 阈值 {a.threshold} · 实际 {a.actual} · {fmtTime(a.created_at)}
                        </div>
                      </div>
                      {a.acked ? (
                        <span className="text-[11px] text-muted-foreground">已确认</span>
                      ) : (
                        <Button
                          size="sm"
                          variant="outline"
                          onClick={async () => {
                            await flm.ackAlert(a.id);
                            await loadTab('ops');
                          }}
                        >
                          确认
                        </Button>
                      )}
                    </div>
                  ))}
                </div>
              )}
            </CardContent>
          </Card>

          <Card>
            <CardContent className="p-4">
              <div className="mb-3 flex items-center gap-2 text-sm font-medium">
                <ScrollText className="w-4 h-4 text-primary" />
                全链路审计（AC-F5.6）
              </div>
              {audit.length === 0 ? (
                <Empty text="暂无审计记录" />
              ) : (
                <div className="flex flex-col gap-1.5 max-h-96 overflow-auto" data-testid="flm-audit">
                  {audit.map((a) => (
                    <div key={a.id} className="flex items-start gap-2 text-xs">
                      <span className="w-32 shrink-0 text-muted-foreground tabular-nums">{fmtTime(a.created_at)}</span>
                      <span className="w-24 shrink-0 font-mono">{a.action}</span>
                      <span className="min-w-0 flex-1 truncate" title={a.detail}>{a.detail}</span>
                      <span className="shrink-0 text-muted-foreground">{a.actor}</span>
                    </div>
                  ))}
                </div>
              )}
            </CardContent>
          </Card>
        </TabsContent>

        {/* ── 设置 ─────────────────────────────────────────────── */}
        <TabsContent value="settings" className="mt-4 flex flex-col gap-4">
          <Card>
            <CardContent className="p-4">
              <div className="flex items-center justify-between gap-4">
                <div>
                  <div className="text-sm font-medium">FLM 总开关（AC-F0.1）</div>
                  <div className="mt-1 text-xs text-muted-foreground">
                    关闭后：反馈入口返回 <code>degraded: true</code>、不再新增事件、控制台显示已降级；
                    <strong>消息收发与 Agent 执行完全不受影响</strong>。重新开启后采集自动恢复。
                  </div>
                </div>
                <div data-testid="flm-enabled-switch">
                  <Switch
                    checked={enabled === true}
                    onCheckedChange={(v) => void toggleEnabled(v)}
                  />
                </div>
              </div>
            </CardContent>
          </Card>

          <Card>
            <CardContent className="p-4">
              <div className="mb-1 flex items-center gap-2 text-sm font-medium">
                <Crosshair className="w-4 h-4 text-primary" />
                环境观测点（AC-F1.3.1）
              </div>
              <div className="mb-3 text-xs text-muted-foreground">
                注册业务侧关键状态字段。任务前后各提交一次快照即可自动 diff，判定行动是否真正生效。
                期望值留空表示"只观测不判定"。
              </div>

              <div className="flex flex-wrap gap-2">
                <Input
                  value={obsName}
                  onChange={(e) => setObsName(e.target.value)}
                  placeholder="名称，如 订单状态"
                  className="max-w-[180px]"
                  data-testid="flm-obs-name"
                />
                <Input
                  value={obsPath}
                  onChange={(e) => setObsPath(e.target.value)}
                  placeholder="取值路径，如 order.status"
                  className="max-w-[220px]"
                  data-testid="flm-obs-path"
                />
                <Input
                  value={obsExpected}
                  onChange={(e) => setObsExpected(e.target.value)}
                  placeholder="期望值（可空）"
                  className="max-w-[180px]"
                  data-testid="flm-obs-expected"
                />
                <Button
                  onClick={async () => {
                    if (!obsName.trim() || !obsPath.trim()) return toast.info('请填写名称与取值路径');
                    await flm.createObservation({
                      name: obsName.trim(),
                      path: obsPath.trim(),
                      expected: obsExpected.trim() || null,
                    });
                    toast.success('观测点已注册');
                    setObsName(''); setObsPath(''); setObsExpected('');
                    await loadTab('settings');
                  }}
                  data-testid="flm-obs-create"
                >
                  <Plus className="w-3.5 h-3.5 mr-1" />注册
                </Button>
              </div>

              {observations.length === 0 ? (
                <Empty text="尚无观测点 —— 注册后业务侧提交的前后快照才能参与判定" />
              ) : (
                <div className="mt-3 flex flex-col gap-2" data-testid="flm-observations">
                  {observations.map((o) => (
                    <div key={o.id} className="flex items-center gap-2 rounded border border-border p-2 text-sm">
                      <span className="font-medium">{o.name}</span>
                      <span className="font-mono text-[11px] text-muted-foreground">{o.path}</span>
                      <span className="text-[11px] text-muted-foreground">
                        期望 {o.expected ?? '—'}
                      </span>
                      <span className="ml-auto text-[11px] text-muted-foreground">{o.created_by}</span>
                      <Button
                        size="sm"
                        variant="outline"
                        onClick={async () => {
                          await flm.deleteObservation(o.id);
                          toast.success('已删除');
                          await loadTab('settings');
                        }}
                        data-testid={`flm-obs-delete-${o.id}`}
                      >
                        <Trash2 className="w-3.5 h-3.5" />
                      </Button>
                    </div>
                  ))}
                </div>
              )}
            </CardContent>
          </Card>

          <Card>
            <CardContent className="p-4">
              <div className="mb-1 flex items-center gap-2 text-sm font-medium">
                <Crosshair className="w-4 h-4 text-primary" />
                环境快照与 diff（AC-F1.3.2 / AC-F1.3.3）
              </div>
              <div className="mb-3 text-xs text-muted-foreground">
                任务前后各提交一次快照，diff 会产出一条 <code>source=&quot;env&quot;</code> 事件并给出「达成 / 未达成」判定。
                <code>values</code> 以观测点的取值路径为键；缺的键按「无数据」处理，不拿默认值冒充观测结果。
              </div>

              <div className="flex flex-wrap items-center gap-2">
                <Input
                  value={snapTask}
                  onChange={(e) => setSnapTask(e.target.value)}
                  placeholder="taskId，如 chat:<jid>:<小时桶>"
                  className="max-w-xs"
                  data-testid="flm-snap-task"
                />
                <Button
                  variant="outline"
                  size="sm"
                  onClick={() => {
                    const tpl: Record<string, string> = {};
                    for (const o of observations) tpl[o.path] = '';
                    setSnapValues(JSON.stringify(tpl, null, 2));
                  }}
                  data-testid="flm-snap-template"
                >
                  用观测点生成模板
                </Button>
              </div>

              <textarea
                value={snapValues}
                onChange={(e) => setSnapValues(e.target.value)}
                rows={4}
                spellCheck={false}
                className="mt-2 w-full rounded border border-border bg-background p-2 font-mono text-[11px]"
                data-testid="flm-snap-values"
              />

              <div className="mt-2 flex flex-wrap gap-2">
                <Button size="sm" onClick={() => void submitSnapshot('before')} data-testid="flm-snap-before">
                  提交前置快照
                </Button>
                <Button size="sm" onClick={() => void submitSnapshot('after')} data-testid="flm-snap-after">
                  提交后置快照
                </Button>
                <Button size="sm" variant="outline" onClick={() => void runDiff()} data-testid="flm-snap-diff">
                  <ArrowRight className="w-3.5 h-3.5 mr-1" />计算 diff
                </Button>
              </div>

              {snapMsg && (
                <div className="mt-2 rounded bg-muted p-2 text-[11px]" data-testid="flm-snap-result">
                  {snapMsg}
                </div>
              )}
            </CardContent>
          </Card>

          <Card>
            <CardContent className="p-4">
              <div className="mb-1 flex items-center gap-2 text-sm font-medium">
                <ShieldCheck className="w-4 h-4 text-primary" />
                脱敏规则（AC-F2.6）
              </div>
              <div className="mb-3 text-xs text-muted-foreground">
                归一化阶段按此列表依次替换，规则改动<strong>即时生效</strong>（每次归一化重新编译，不缓存，无需重启）。
                非法正则会被跳过并记入诊断，不会拖垮归一化。
              </div>

              {rules.length === 0 ? (
                <Empty text="暂无脱敏规则" />
              ) : (
                <div className="flex flex-col gap-1.5" data-testid="flm-rules">
                  {rules.map((r) => (
                    <div key={r.name} className="flex items-center gap-2 rounded border border-border p-2 text-xs">
                      <span className="w-20 shrink-0 font-medium">{r.name}</span>
                      <span className="min-w-0 flex-1 truncate font-mono text-[11px] text-muted-foreground" title={r.pattern}>
                        {r.pattern}
                      </span>
                      <span className="shrink-0 font-mono text-[11px]">→ {r.mask}</span>
                      <Button
                        size="sm"
                        variant="outline"
                        onClick={() => void mutateRules(rules.filter((x) => x.name !== r.name))}
                        data-testid={`flm-rule-delete-${r.name}`}
                      >
                        <Trash2 className="w-3.5 h-3.5" />
                      </Button>
                    </div>
                  ))}
                </div>
              )}

              <div className="mt-3 flex flex-wrap gap-2">
                <Input
                  value={ruleName}
                  onChange={(e) => setRuleName(e.target.value)}
                  placeholder="规则名，如 工号"
                  className="max-w-[160px]"
                  data-testid="flm-rule-name"
                />
                <Input
                  value={rulePattern}
                  onChange={(e) => setRulePattern(e.target.value)}
                  placeholder="正则，如 \\bEMP\\d{6}\\b"
                  className="max-w-[240px]"
                  data-testid="flm-rule-pattern"
                />
                <Input
                  value={ruleMask}
                  onChange={(e) => setRuleMask(e.target.value)}
                  placeholder="掩码，如 ***EMP***"
                  className="max-w-[160px]"
                  data-testid="flm-rule-mask"
                />
                <Button
                  onClick={async () => {
                    if (!ruleName.trim() || !rulePattern.trim()) return toast.info('请填写规则名与正则');
                    try {
                      new RegExp(rulePattern);
                    } catch {
                      return toast.error('正则不合法');
                    }
                    await mutateRules([
                      ...rules.filter((r) => r.name !== ruleName.trim()),
                      {
                        name: ruleName.trim(),
                        pattern: rulePattern,
                        flags: 'g',
                        mask: ruleMask.trim() || '***',
                      },
                    ]);
                    setRuleName(''); setRulePattern(''); setRuleMask('');
                  }}
                  data-testid="flm-rule-create"
                >
                  <Plus className="w-3.5 h-3.5 mr-1" />新增规则
                </Button>
              </div>
            </CardContent>
          </Card>

          <Card>
            <CardContent className="p-4">
              <div className="mb-3 text-sm font-medium">采集与分析配置</div>
              <pre className="max-h-72 overflow-auto rounded bg-muted p-3 text-[11px]" data-testid="flm-config">
                {configText || '加载中…'}
              </pre>
            </CardContent>
          </Card>
        </TabsContent>
      </Tabs>
    </div>
  );
}
