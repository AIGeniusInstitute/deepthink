import { useEffect, useState, useCallback } from 'react';
import { PageHeader } from '@/components/common/PageHeader';
import { Button } from '@/components/ui/button';
import { Card, CardContent } from '@/components/ui/card';
import { Input } from '@/components/ui/input';
import { Badge } from '@/components/ui/badge';
import { Tabs, TabsList, TabsTrigger, TabsContent } from '@/components/ui/tabs';
import {
  Dialog, DialogContent, DialogHeader, DialogTitle, DialogFooter,
} from '@/components/ui/dialog';
import { toast } from 'sonner';
import {
  FlaskConical, Plus, Play, Copy, GitBranch, Activity, TrendingUp,
  Trophy, Radar, ListTree, FileText, RefreshCw, CheckCircle2, XCircle,
} from 'lucide-react';
import * as ec from '../api/eval-center';
import type {
  EvalProject, EvalDataset, EvalVersion, EvalCase, EvalRubric, EvalRubricVersion,
  EvalRun, EvalResult, TraceData,
} from '../api/eval-center';

const STATUS_COLOR: Record<string, string> = {
  draft: 'bg-gray-100 text-gray-600',
  published: 'bg-green-100 text-green-700',
  deprecated: 'bg-red-100 text-red-700',
  archived: 'bg-gray-200 text-gray-500',
  running: 'bg-blue-100 text-blue-700 animate-pulse',
  completed: 'bg-green-100 text-green-700',
  failed: 'bg-red-100 text-red-700',
};

function ScoreBar({ value, max = 100 }: { value: number; max?: number }) {
  const pct = Math.max(0, Math.min(100, (value / max) * 100));
  const color = pct >= 80 ? 'bg-green-500' : pct >= 50 ? 'bg-yellow-500' : 'bg-red-500';
  return (
    <div className="h-2 w-full rounded-full bg-gray-200 overflow-hidden">
      <div className={`h-full ${color} rounded-full transition-all`} style={{ width: `${pct}%` }} />
    </div>
  );
}

function RadarChart({ dims }: { dims: Record<string, any> }) {
  const entries = Object.entries(dims || {});
  if (entries.length === 0) return <div className="text-sm text-gray-400">无维度数据</div>;
  const size = 220; const cx = size / 2; const cy = size / 2; const R = 80;
  const n = entries.length;
  const pts = entries.map(([, d], i) => {
    const score = (d.score ?? 0) / 100;
    const ang = (Math.PI * 2 * i) / n - Math.PI / 2;
    return [cx + Math.cos(ang) * R * score, cy + Math.sin(ang) * R * score];
  });
  const polyStr = pts.map((p) => p.join(',')).join(' ');
  const labels = entries.map(([name, d], i) => {
    const ang = (Math.PI * 2 * i) / n - Math.PI / 2;
    const lx = cx + Math.cos(ang) * (R + 22); const ly = cy + Math.sin(ang) * (R + 22);
    return (
      <text key={name} x={lx} y={ly} textAnchor="middle" dominantBaseline="middle"
        className="fill-gray-600" style={{ fontSize: 10 }}>{name} ({d.score ?? 0})</text>
    );
  });
  const grid = [0.25, 0.5, 0.75, 1].map((f) =>
    entries.map((_, i) => {
      const ang = (Math.PI * 2 * i) / n - Math.PI / 2;
      return [cx + Math.cos(ang) * R * f, cy + Math.sin(ang) * R * f].join(',');
    }).join(' ')
  );
  return (
    <svg width={size} height={size} className="mx-auto">
      {grid.map((g, i) => <polygon key={i} points={g} fill="none" stroke="#e5e7eb" strokeWidth={1} />)}
      <polygon points={polyStr} fill="rgba(59,130,246,0.25)" stroke="#3b82f6" strokeWidth={2} />
      {pts.map((p, i) => <circle key={i} cx={p[0]} cy={p[1]} r={3} fill="#3b82f6" />)}
      {labels}
    </svg>
  );
}

export function EvalCenterPage() {
  const [projects, setProjects] = useState<EvalProject[]>([]);
  const [curProject, setCurProject] = useState<EvalProject | null>(null);
  const [datasets, setDatasets] = useState<EvalDataset[]>([]);
  const [curDataset, setCurDataset] = useState<EvalDataset | null>(null);
  const [versions, setVersions] = useState<EvalVersion[]>([]);
  const [curVersion, setCurVersion] = useState<EvalVersion | null>(null);
  const [cases, setCases] = useState<EvalCase[]>([]);
  const [rubrics, setRubrics] = useState<EvalRubric[]>([]);
  const [curRubric, setCurRubric] = useState<EvalRubric | null>(null);
  const [rubricVersions, setRubricVersions] = useState<EvalRubricVersion[]>([]);
  const [curRubricVer, setCurRubricVer] = useState<EvalRubricVersion | null>(null);
  const [runs, setRuns] = useState<EvalRun[]>([]);
  const [agents, setAgents] = useState<{ id: string; name: string }[]>([]);
  const [tab, setTab] = useState('overview');

  // dialogs
  const [showProj, setShowProj] = useState(false);
  const [showDs, setShowDs] = useState(false);
  const [showVer, setShowVer] = useState(false);
  const [showCase, setShowCase] = useState(false);
  const [showRubric, setShowRubric] = useState(false);
  const [showRun, setShowRun] = useState(false);

  const refreshProjects = useCallback(async () => {
    const ps = await ec.listProjects();
    setProjects(ps);
    if (!curProject && ps.length > 0) setCurProject(ps[0]);
  }, [curProject]);

  useEffect(() => { refreshProjects().catch(() => {}); }, [refreshProjects]);

  useEffect(() => {
    if (!curProject) return;
    ec.listDatasets(curProject.id).then(setDatasets).catch(() => {});
    ec.listRubrics(curProject.id).then(setRubrics).catch(() => {});
    ec.listRuns(curProject.id).then(setRuns).catch(() => {});
  }, [curProject]);

  useEffect(() => {
    if (!curDataset) return;
    ec.listVersions(curDataset.id).then(setVersions).catch(() => {});
  }, [curDataset]);

  useEffect(() => {
    if (!curVersion) return;
    ec.listCases(curVersion.id).then(setCases).catch(() => {});
  }, [curVersion]);

  useEffect(() => {
    if (!curRubric) return;
    ec.listRubricVersions(curRubric.id).then(setRubricVersions).catch(() => {});
  }, [curRubric]);

  useEffect(() => {
    ec.listAgents().then((r) => setAgents(r.agents || [])).catch(() => {});
  }, []);

  return (
    <div className="flex h-full flex-col">
      <PageHeader title="评测中心" subtitle="Agent 评测：数据集 × 评分标准 × 自动化运行 × 多维评分"
        actions={
          <div className="flex items-center gap-2">
            <select className="rounded border border-gray-300 bg-white px-2 py-1 text-sm dark:bg-gray-800"
              value={curProject?.id ?? ''} onChange={(e) => {
                const p = projects.find((x) => x.id === e.target.value) ?? null;
                setCurProject(p); setCurDataset(null); setCurVersion(null); setCurRubric(null);
              }}>
              {projects.length === 0 && <option value="">无项目</option>}
              {projects.map((p) => <option key={p.id} value={p.id}>{p.name}</option>)}
            </select>
            <Button size="sm" variant="outline" onClick={() => refreshProjects()}>
              <RefreshCw className="h-4 w-4" />
            </Button>
            <Button size="sm" onClick={() => setShowProj(true)}><Plus className="h-4 w-4" />项目</Button>
          </div>
        }
      />
      <div className="flex-1 overflow-auto p-4">
        <Tabs value={tab} onValueChange={setTab}>
          <TabsList className="flex-wrap h-auto">
            <TabsTrigger value="overview" className="gap-1"><FlaskConical className="h-4 w-4" />概览</TabsTrigger>
            <TabsTrigger value="datasets" className="gap-1"><FileText className="h-4 w-4" />数据集</TabsTrigger>
            <TabsTrigger value="cases" className="gap-1"><ListTree className="h-4 w-4" />用例</TabsTrigger>
            <TabsTrigger value="rubric" className="gap-1"><Trophy className="h-4 w-4" />评分标准</TabsTrigger>
            <TabsTrigger value="runs" className="gap-1"><Play className="h-4 w-4" />评测运行</TabsTrigger>
            <TabsTrigger value="results" className="gap-1"><TrendingUp className="h-4 w-4" />结果分析</TabsTrigger>
            <TabsTrigger value="drift" className="gap-1"><Radar className="h-4 w-4" />漂移检测</TabsTrigger>
          </TabsList>

          {/* Overview */}
          <TabsContent value="overview">
            <div className="grid grid-cols-2 gap-4 md:grid-cols-4">
              {[
                { label: '项目', value: projects.length, icon: FlaskConical },
                { label: '数据集', value: datasets.length, icon: FileText },
                { label: '评分标准', value: rubrics.length, icon: Trophy },
                { label: '评测运行', value: runs.length, icon: Play },
              ].map((s) => (
                <Card key={s.label}><CardContent className="flex items-center gap-3 p-4">
                  <s.icon className="h-8 w-8 text-blue-500" />
                  <div><div className="text-2xl font-bold">{s.value}</div><div className="text-xs text-gray-500">{s.label}</div></div>
                </CardContent></Card>
              ))}
            </div>
            <Card className="mt-4"><CardContent className="p-4">
              <h3 className="mb-3 font-semibold">最近评测运行</h3>
              {runs.length === 0 ? <p className="text-sm text-gray-400">暂无运行</p> : (
                <div className="space-y-2">
                  {runs.slice(0, 5).map((r) => (
                    <div key={r.id} className="flex items-center justify-between rounded border p-2 text-sm">
                      <span className="font-mono text-xs">{r.id.slice(0, 8)}</span>
                      <Badge className={STATUS_COLOR[r.status] ?? 'bg-gray-100'}>{r.status}</Badge>
                      <span>得分 {r.overall_score ?? '-'}</span>
                      <span>通过率 {r.pass_rate != null ? (r.pass_rate * 100).toFixed(0) + '%' : '-'}</span>
                      <span className="text-gray-500">{r.llm_model}</span>
                    </div>
                  ))}
                </div>
              )}
            </CardContent></Card>
          </TabsContent>

          {/* Datasets */}
          <TabsContent value="datasets">
            <div className="mb-3 flex items-center gap-2">
              <Button size="sm" onClick={() => setShowDs(true)} disabled={!curProject}><Plus className="h-4 w-4" />新建数据集</Button>
            </div>
            <div className="grid grid-cols-1 gap-3 md:grid-cols-3">
              {datasets.map((d) => (
                <Card key={d.id} className={`cursor-pointer ${curDataset?.id === d.id ? 'ring-2 ring-blue-500' : ''}`}
                  onClick={() => { setCurDataset(d); setCurVersion(null); setTab('cases'); }}>
                  <CardContent className="p-4">
                    <div className="flex items-center justify-between">
                      <h4 className="font-semibold">{d.name}</h4>
                      <Badge className="bg-purple-100 text-purple-700">{d.dataset_type}</Badge>
                    </div>
                    <p className="mt-1 text-xs text-gray-500">{d.description ?? '无描述'}</p>
                    <div className="mt-2 text-xs text-gray-400">最新版本 v{d.latest_version}</div>
                  </CardContent>
                </Card>
              ))}
            </div>
            {curDataset && (
              <Card className="mt-4"><CardContent className="p-4">
                <div className="mb-3 flex items-center justify-between">
                  <h3 className="font-semibold">{curDataset.name} · 版本列表</h3>
                  <div className="flex gap-2">
                    <Button size="sm" variant="outline" onClick={() => setShowVer(true)}><Plus className="h-4 w-4" />新版本</Button>
                  </div>
                </div>
                <div className="space-y-2">
                  {versions.map((v) => (
                    <div key={v.id} className={`flex items-center justify-between rounded border p-2 ${curVersion?.id === v.id ? 'border-blue-500 bg-blue-50' : ''}`}>
                      <div className="flex items-center gap-2">
                        <button className="font-mono text-sm hover:underline" onClick={() => setCurVersion(v)}>v{v.version}</button>
                        <Badge className={STATUS_COLOR[v.status] ?? 'bg-gray-100'}>{v.status}</Badge>
                        <span className="text-xs text-gray-500">{v.case_count} 用例</span>
                        <span className="font-mono text-xs text-gray-400">{v.content_hash?.slice(0, 12)}</span>
                      </div>
                      <div className="flex gap-1">
                        {v.status === 'draft' && (
                          <Button size="sm" variant="ghost" onClick={async () => {
                            try { await ec.publishVersion(curDataset.id, v.id, 'publish'); toast.success('版本已发布');
                              setVersions(await ec.listVersions(curDataset.id)); } catch (e: any) { toast.error(e.message); }
                          }}><GitBranch className="h-4 w-4" />发布</Button>
                        )}
                        <Button size="sm" variant="ghost" onClick={async () => {
                          try { await ec.rollbackVersion(curDataset.id, v.version); toast.success('已回滚'); setVersions(await ec.listVersions(curDataset.id)); } catch (e: any) { toast.error(e.message); }
                        }}>回滚</Button>
                        <Button size="sm" variant="ghost" onClick={async () => {
                          try { await ec.cloneVersion(v.id, curProject!.id, curDataset.name + '-克隆'); toast.success('已克隆'); } catch (e: any) { toast.error(e.message); }
                        }}><Copy className="h-4 w-4" /></Button>
                      </div>
                    </div>
                  ))}
                </div>
              </CardContent></Card>
            )}
          </TabsContent>

          {/* Cases */}
          <TabsContent value="cases">
            {!curVersion ? <p className="text-sm text-gray-400">请先在「数据集」选择一个版本</p> : (
              <>
                <div className="mb-3 flex items-center gap-2">
                  <Button size="sm" onClick={() => setShowCase(true)}><Plus className="h-4 w-4" />新建用例</Button>
                  <span className="text-sm text-gray-500">{cases.length} 条用例</span>
                </div>
                <div className="space-y-2">
                  {cases.map((c) => (
                    <Card key={c.id}><CardContent className="p-3">
                      <div className="flex items-start justify-between gap-2">
                        <div className="flex-1">
                          <div className="flex items-center gap-2">
                            <span className="font-mono text-xs text-gray-400">{c.id.slice(0, 8)}</span>
                            {c.is_golden && <Badge className="bg-amber-100 text-amber-700">⭐ Golden</Badge>}
                            {c.category && <Badge variant="outline">{c.category}</Badge>}
                            {c.difficulty && <Badge variant="outline">{c.difficulty}</Badge>}
                            {c.tags?.map((t) => <Badge key={t} className="bg-gray-100 text-gray-600">{t}</Badge>)}
                          </div>
                          <p className="mt-1 text-sm"><b>输入：</b>{c.input_text}</p>
                          {c.expected_output && <p className="text-sm text-gray-600"><b>期望：</b>{c.expected_output}</p>}
                        </div>
                        <div className="flex flex-col gap-1">
                          <Button size="sm" variant="ghost" onClick={async () => {
                            try { await ec.promoteGolden(c.id); toast.success('已设为 Golden'); setCases(await ec.listCases(curVersion.id)); } catch (e: any) { toast.error(e.message); }
                          }}>⭐</Button>
                          <Button size="sm" variant="ghost" onClick={async () => {
                            if (!confirm('删除该用例？')) return;
                            try { await ec.deleteCase(c.id); setCases(await ec.listCases(curVersion.id)); toast.success('已删除'); } catch (e: any) { toast.error(e.message); }
                          }}><XCircle className="h-4 w-4" /></Button>
                        </div>
                      </div>
                    </CardContent></Card>
                  ))}
                </div>
              </>
            )}
          </TabsContent>

          {/* Rubric */}
          <TabsContent value="rubric">
            <div className="mb-3 flex gap-2">
              <Button size="sm" onClick={() => setShowRubric(true)} disabled={!curProject}><Plus className="h-4 w-4" />新建评分标准</Button>
            </div>
            <div className="grid grid-cols-1 gap-3 md:grid-cols-2">
              {rubrics.map((r) => (
                <Card key={r.id} className={`cursor-pointer ${curRubric?.id === r.id ? 'ring-2 ring-blue-500' : ''}`} onClick={() => setCurRubric(r)}>
                  <CardContent className="p-4">
                    <h4 className="font-semibold">{r.name}</h4>
                    <p className="text-xs text-gray-500">{r.description ?? '无描述'}</p>
                    <div className="mt-1 text-xs text-gray-400">最新版本 v{r.latest_version}</div>
                  </CardContent>
                </Card>
              ))}
            </div>
            {curRubric && (
              <Card className="mt-4"><CardContent className="p-4">
                <h3 className="mb-3 font-semibold">{curRubric.name} · 版本</h3>
                <div className="space-y-2">
                  {rubricVersions.map((rv) => (
                    <div key={rv.id} className={`flex items-center justify-between rounded border p-2 ${curRubricVer?.id === rv.id ? 'border-blue-500 bg-blue-50' : ''}`}>
                      <div className="flex items-center gap-2">
                        <button className="font-mono text-sm hover:underline" onClick={() => setCurRubricVer(rv)}>v{rv.version}</button>
                        <Badge className={STATUS_COLOR[rv.status] ?? 'bg-gray-100'}>{rv.status}</Badge>
                        <span className="text-xs text-gray-500">{rv.dimensions?.length ?? 0} 维度</span>
                        <span className="text-xs text-gray-500">阈值 {rv.pass_threshold}</span>
                      </div>
                    </div>
                  ))}
                </div>
                {curRubricVer && (
                  <div className="mt-3">
                    <h4 className="mb-2 text-sm font-semibold">评分维度</h4>
                    <div className="space-y-1">
                      {curRubricVer.dimensions?.map((d: any, i) => (
                        <div key={i} className="flex items-center justify-between rounded bg-gray-50 p-2 text-sm">
                          <span>{d.name}</span>
                          <div className="flex gap-2 text-xs text-gray-500">
                            <span>{d.scorer ?? (d.assertions ? 'deterministic' : 'llm_judge')}</span>
                            <span>权重 {d.weight}</span>
                            <span>scale {d.scale ?? 5}</span>
                          </div>
                        </div>
                      ))}
                    </div>
                  </div>
                )}
              </CardContent></Card>
            )}
          </TabsContent>

          {/* Runs */}
          <TabsContent value="runs">
            <div className="mb-3 flex gap-2">
              <Button size="sm" onClick={() => setShowRun(true)} disabled={!curVersion || !curRubricVer}>
                <Play className="h-4 w-4" />发起评测
              </Button>
              {(!curVersion || !curRubricVer) && <span className="self-center text-xs text-gray-400">需先选数据集版本与评分标准版本</span>}
            </div>
            <div className="space-y-2">
              {runs.map((r) => (
                <Card key={r.id} className="cursor-pointer" onClick={() => { setTab('results'); }}>
                  <CardContent className="p-3">
                    <div className="flex items-center justify-between">
                      <div className="flex items-center gap-2">
                        <span className="font-mono text-xs">{r.id.slice(0, 8)}</span>
                        <Badge className={STATUS_COLOR[r.status] ?? 'bg-gray-100'}>{r.status}</Badge>
                        <span className="text-xs text-gray-500">{r.llm_model}</span>
                      </div>
                      <div className="flex items-center gap-4 text-sm">
                        <span>得分 <b>{r.overall_score ?? '-'}</b></span>
                        <span>通过 {r.passed_cases}/{r.total_cases}</span>
                        <span>通过率 {r.pass_rate != null ? (r.pass_rate * 100).toFixed(0) + '%' : '-'}</span>
                      </div>
                    </div>
                  </CardContent>
                </Card>
              ))}
            </div>
          </TabsContent>

          {/* Results */}
          <TabsContent value="results"><ResultsTab runs={runs} /></TabsContent>

          {/* Drift */}
          <TabsContent value="drift"><DriftTab versionId={curVersion?.id} /></TabsContent>
        </Tabs>
      </div>

      {/* Dialogs */}
      <NewProjectDialog open={showProj} setOpen={setShowProj} onCreated={() => { refreshProjects(); setShowProj(false); }} />
      <NewDatasetDialog open={showDs} setOpen={setShowDs} projectId={curProject?.id} onCreated={async () => {
        if (curProject) setDatasets(await ec.listDatasets(curProject.id)); setShowDs(false);
      }} />
      <NewVersionDialog open={showVer} setOpen={setShowVer} datasetId={curDataset?.id} onCreated={async () => {
        if (curDataset) setVersions(await ec.listVersions(curDataset.id)); setShowVer(false);
      }} />
      <NewCaseDialog open={showCase} setOpen={setShowCase} versionId={curVersion?.id} onCreated={async () => {
        if (curVersion) setCases(await ec.listCases(curVersion.id)); setShowCase(false);
      }} />
      <NewRubricDialog open={showRubric} setOpen={setShowRubric} projectId={curProject?.id} onCreated={async () => {
        if (curProject) setRubrics(await ec.listRubrics(curProject.id)); setShowRubric(false);
      }} />
      <NewRunDialog open={showRun} setOpen={setShowRun} agents={agents} curVersion={curVersion} curRubricVer={curRubricVer}
        projectId={curProject?.id} onCreated={async () => {
          if (curProject) setRuns(await ec.listRuns(curProject.id)); setShowRun(false); setTab('results');
        }} />
    </div>
  );
}

function ResultsTab({ runs }: { runs: EvalRun[] }) {
  const [selRun, setSelRun] = useState<EvalRun | null>(null);
  const [results, setResults] = useState<EvalResult[]>([]);
  const [selResult, setSelResult] = useState<EvalResult | null>(null);
  const [trace, setTrace] = useState<TraceData | null>(null);

  useEffect(() => {
    if (runs.length > 0 && !selRun) setSelRun(runs[0]);
  }, [runs, selRun]);

  useEffect(() => {
    if (!selRun) { setResults([]); return; }
    ec.listResults(selRun.id).then(setResults).catch(() => setResults([]));
    setSelResult(null); setTrace(null);
  }, [selRun]);

  useEffect(() => {
    if (!selRun || !selResult) { setTrace(null); return; }
    ec.getTrace(selRun.id, selResult.id).then(setTrace).catch(() => setTrace(null));
  }, [selRun, selResult]);

  return (
    <div className="space-y-3">
      <div className="flex flex-wrap gap-2">
        {runs.map((r) => (
          <button key={r.id} onClick={() => setSelRun(r)}
            className={`rounded border px-2 py-1 text-xs ${selRun?.id === r.id ? 'border-blue-500 bg-blue-50' : 'border-gray-200'}`}>
            {r.id.slice(0, 8)} · {r.overall_score ?? '-'}
          </button>
        ))}
      </div>
      {selRun && (
        <Card><CardContent className="p-4">
          <div className="mb-3 flex items-center justify-between">
            <h3 className="font-semibold">运行 {selRun.id.slice(0, 8)} 结果</h3>
            <Badge className={STATUS_COLOR[selRun.status] ?? 'bg-gray-100'}>{selRun.status}</Badge>
          </div>
          <div className="grid gap-2 md:grid-cols-2">
            {results.map((r) => (
              <div key={r.id} className={`rounded border p-2 ${selResult?.id === r.id ? 'border-blue-500 bg-blue-50' : ''}`}
                onClick={() => setSelResult(r)}>
                <div className="flex items-center justify-between">
                  <span className="font-mono text-xs">{r.test_case_id.slice(0, 8)}</span>
                  {r.is_pass ? <CheckCircle2 className="h-4 w-4 text-green-500" /> : <XCircle className="h-4 w-4 text-red-500" />}
                </div>
                <div className="mt-1 text-sm">得分 <b>{r.overall_score ?? '-'}</b></div>
                <ScoreBar value={r.overall_score ?? 0} />
                <p className="mt-1 truncate text-xs text-gray-500">{r.agent_output?.slice(0, 80) ?? r.error_message ?? ''}</p>
              </div>
            ))}
          </div>
        </CardContent></Card>
      )}
      {selResult && (
        <div className="grid gap-3 md:grid-cols-2">
          <Card><CardContent className="p-4">
            <h4 className="mb-2 font-semibold">维度评分雷达</h4>
            <RadarChart dims={selResult.dimension_scores ?? {}} />
            <div className="mt-2 space-y-1">
              {Object.entries(selResult.dimension_scores ?? {}).map(([name, d]: any) => (
                <div key={name} className="flex items-center justify-between text-sm">
                  <span>{name}</span>
                  <div className="flex items-center gap-2">
                    <ScoreBar value={d.score ?? 0} />
                    <span className="w-12 text-right">{d.score ?? 0}</span>
                  </div>
                </div>
              ))}
            </div>
          </CardContent></Card>
          <Card><CardContent className="p-4">
            <h4 className="mb-2 font-semibold">详情</h4>
            <p className="text-sm"><b>Agent 输出：</b></p>
            <p className="mt-1 max-h-40 overflow-auto whitespace-pre-wrap rounded bg-gray-50 p-2 text-xs">{selResult.agent_output ?? selResult.error_message ?? ''}</p>
            <p className="mt-2 text-sm"><b>Judge 推理：</b></p>
            <p className="mt-1 max-h-32 overflow-auto whitespace-pre-wrap rounded bg-gray-50 p-2 text-xs">{selResult.judge_reasoning ?? '—'}</p>
            <p className="mt-2 text-sm"><b>断言结果：</b></p>
            <div className="mt-1 space-y-1">
              {(selResult.assertion_results ?? []).map((a: any, i: number) => (
                <div key={i} className="flex items-center gap-2 text-xs">
                  {a.pass ? <CheckCircle2 className="h-3 w-3 text-green-500" /> : <XCircle className="h-3 w-3 text-red-500" />}
                  <span>{a.dim}/{a.kind}: {a.detail}</span>
                </div>
              ))}
              {(selResult.assertion_results ?? []).length === 0 && <span className="text-xs text-gray-400">无</span>}
            </div>
          </CardContent></Card>
        </div>
      )}
      {selResult && trace && (
        <Card><CardContent className="p-4">
          <h4 className="mb-2 flex items-center gap-2 font-semibold"><Activity className="h-4 w-4" />链路追踪</h4>
          <div className="mb-2 flex gap-4 text-xs text-gray-500">
            <span>Tokens: {trace.trace.total_tokens}</span>
            <span>延迟: {trace.trace.total_latency_ms}ms</span>
            <span>Span 数: {trace.trace.span_count}</span>
          </div>
          <div className="space-y-1">
            {trace.spans.map((s: any, i: number) => (
              <div key={i} className="flex items-center gap-2 rounded bg-gray-50 p-2 text-xs">
                <Badge variant="outline">{s.span_type}</Badge>
                <span>{s.name}</span>
                <span className="text-gray-400">seq={s.sequence_order}</span>
                <Badge className={s.status === 'ok' ? 'bg-green-100 text-green-700' : 'bg-red-100 text-red-700'}>{s.status}</Badge>
              </div>
            ))}
          </div>
        </CardContent></Card>
      )}
    </div>
  );
}

function DriftTab({ versionId }: { versionId?: string }) {
  const [report, setReport] = useState<any>(null);
  const [reports, setReports] = useState<any[]>([]);
  const [loading, setLoading] = useState(false);

  const detect = async () => {
    if (!versionId) { toast.error('请先选择数据集版本'); return; }
    setLoading(true);
    try {
      const r = await ec.detectDrift(versionId, versionId);
      setReport(r); toast.success('漂移检测完成');
      setReports(await ec.listDriftReports(versionId));
    } catch (e: any) { toast.error(e.message); } finally { setLoading(false); }
  };

  useEffect(() => {
    if (versionId) ec.listDriftReports(versionId).then(setReports).catch(() => {});
  }, [versionId]);

  return (
    <div className="space-y-3">
      <div className="flex items-center gap-2">
        <Button size="sm" onClick={detect} disabled={loading || !versionId}>
          <Radar className="h-4 w-4" />{loading ? '检测中...' : '运行漂移检测'}
        </Button>
        {!versionId && <span className="text-xs text-gray-400">请先选择数据集版本</span>}
      </div>
      {report && (
        <div className="grid gap-3 md:grid-cols-3">
          {[
            { key: 'inputDistribution', label: '输入分布' },
            { key: 'promptTemplate', label: 'Prompt 模板' },
            { key: 'retrievalCorpus', label: '检索语料' },
          ].map((s) => {
            const d = report[s.key]; if (!d) return null;
            return (
              <Card key={s.key}><CardContent className="p-4">
                <h4 className="font-semibold">{s.label}</h4>
                <div className="mt-2 text-3xl font-bold" style={{ color: d.is_drifted ? '#ef4444' : '#22c55e' }}>
                  {Number(d.drift_score ?? 0).toFixed(2)}
                </div>
                <Badge className={d.is_drifted ? 'bg-red-100 text-red-700' : 'bg-green-100 text-green-700'}>
                  {d.is_drifted ? '漂移' : '正常'}
                </Badge>
                <p className="mt-2 text-xs text-gray-500">{JSON.stringify(d.detail)}</p>
              </CardContent></Card>
            );
          })}
        </div>
      )}
      <Card><CardContent className="p-4">
        <h4 className="mb-2 font-semibold">历史报告</h4>
        <div className="space-y-1">
          {reports.map((r) => (
            <div key={r.id} className="flex items-center justify-between rounded bg-gray-50 p-2 text-xs">
              <span className="font-mono">{r.id.slice(0, 8)}</span>
              <span>{r.signal_type ?? 'signal'}</span>
              <Badge className={r.is_drifted ? 'bg-red-100 text-red-700' : 'bg-green-100 text-green-700'}>
                {r.is_drifted ? '漂移' : '正常'} ({Number(r.drift_score ?? 0).toFixed(2)})
              </Badge>
              <span className="text-gray-400">{new Date(r.created_at).toLocaleString()}</span>
            </div>
          ))}
          {reports.length === 0 && <p className="text-xs text-gray-400">暂无报告</p>}
        </div>
      </CardContent></Card>
    </div>
  );
}

function NewProjectDialog({ open, setOpen, onCreated }: { open: boolean; setOpen: (v: boolean) => void; onCreated: () => void; }) {
  const [name, setName] = useState(''); const [desc, setDesc] = useState('');
  return (
    <Dialog open={open} onOpenChange={setOpen}>
      <DialogContent>
        <DialogHeader><DialogTitle>新建项目</DialogTitle></DialogHeader>
        <div className="space-y-3">
          <Input placeholder="项目名称" value={name} onChange={(e) => setName(e.target.value)} />
          <Input placeholder="描述（可选）" value={desc} onChange={(e) => setDesc(e.target.value)} />
        </div>
        <DialogFooter>
          <Button variant="outline" onClick={() => setOpen(false)}>取消</Button>
          <Button onClick={async () => {
            try { await ec.createProject(name, desc); toast.success('已创建'); setName(''); setDesc(''); onCreated(); }
            catch (e: any) { toast.error(e.message); }
          }}>创建</Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}

function NewDatasetDialog({ open, setOpen, projectId, onCreated }: { open: boolean; setOpen: (v: boolean) => void; projectId?: string; onCreated: () => void; }) {
  const [name, setName] = useState('');
  return (
    <Dialog open={open} onOpenChange={setOpen}>
      <DialogContent>
        <DialogHeader><DialogTitle>新建数据集</DialogTitle></DialogHeader>
        <Input placeholder="数据集名称" value={name} onChange={(e) => setName(e.target.value)} />
        <DialogFooter>
          <Button variant="outline" onClick={() => setOpen(false)}>取消</Button>
          <Button onClick={async () => {
            try { await ec.createDataset(projectId!, name); toast.success('已创建'); setName(''); onCreated(); }
            catch (e: any) { toast.error(e.message); }
          }}>创建</Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}

function NewVersionDialog({ open, setOpen, datasetId, onCreated }: { open: boolean; setOpen: (v: boolean) => void; datasetId?: string; onCreated: () => void; }) {
  const [label, setLabel] = useState(''); const [notes, setNotes] = useState('');
  return (
    <Dialog open={open} onOpenChange={setOpen}>
      <DialogContent>
        <DialogHeader><DialogTitle>新建版本</DialogTitle></DialogHeader>
        <Input placeholder="版本标签 如 v1.0" value={label} onChange={(e) => setLabel(e.target.value)} />
        <Input placeholder="变更说明" value={notes} onChange={(e) => setNotes(e.target.value)} />
        <DialogFooter>
          <Button variant="outline" onClick={() => setOpen(false)}>取消</Button>
          <Button onClick={async () => {
            try { await ec.createVersion(datasetId!, label, notes); toast.success('已创建'); setLabel(''); setNotes(''); onCreated(); }
            catch (e: any) { toast.error(e.message); }
          }}>创建</Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}

function NewCaseDialog({ open, setOpen, versionId, onCreated }: { open: boolean; setOpen: (v: boolean) => void; versionId?: string; onCreated: () => void; }) {
  const [input, setInput] = useState(''); const [expected, setExpected] = useState('');
  const [category, setCategory] = useState(''); const [difficulty, setDifficulty] = useState('easy');
  const [tags, setTags] = useState(''); const [golden, setGolden] = useState(false);
  return (
    <Dialog open={open} onOpenChange={setOpen}>
      <DialogContent className="max-w-lg">
        <DialogHeader><DialogTitle>新建测试用例</DialogTitle></DialogHeader>
        <div className="space-y-2">
          <textarea className="w-full rounded border p-2 text-sm" rows={2} placeholder="输入文本" value={input} onChange={(e) => setInput(e.target.value)} />
          <textarea className="w-full rounded border p-2 text-sm" rows={2} placeholder="期望输出（可选）" value={expected} onChange={(e) => setExpected(e.target.value)} />
          <div className="grid grid-cols-3 gap-2">
            <Input placeholder="分类" value={category} onChange={(e) => setCategory(e.target.value)} />
            <select className="rounded border p-2 text-sm" value={difficulty} onChange={(e) => setDifficulty(e.target.value)}>
              <option value="easy">easy</option><option value="medium">medium</option><option value="hard">hard</option>
            </select>
            <Input placeholder="标签 逗号分隔" value={tags} onChange={(e) => setTags(e.target.value)} />
          </div>
          <label className="flex items-center gap-2 text-sm"><input type="checkbox" checked={golden} onChange={(e) => setGolden(e.target.checked)} />设为 Golden</label>
        </div>
        <DialogFooter>
          <Button variant="outline" onClick={() => setOpen(false)}>取消</Button>
          <Button onClick={async () => {
            try { await ec.createCase(versionId!, {
              input_text: input, expected_output: expected || undefined, category: category || undefined,
              difficulty, tags: tags ? tags.split(',').map((t) => t.trim()) : undefined, is_golden: golden,
            }); toast.success('已创建'); setInput(''); setExpected(''); onCreated(); }
            catch (e: any) { toast.error(e.message); }
          }}>创建</Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}

function NewRubricDialog({ open, setOpen, projectId, onCreated }: { open: boolean; setOpen: (v: boolean) => void; projectId?: string; onCreated: () => void; }) {
  const [name, setName] = useState('');
  const [dims, setDims] = useState<any[]>([{ name: '准确性', weight: 0.5, scale: 5, scorer: 'deterministic', assertions: [{ kind: 'contains', value: '' }] }, { name: '流畅度', weight: 0.5, scale: 5, scorer: 'llm_judge' }]);
  const [judgeModel, setJudgeModel] = useState('glm-5.2');
  return (
    <Dialog open={open} onOpenChange={setOpen}>
      <DialogContent className="max-w-2xl">
        <DialogHeader><DialogTitle>新建评分标准</DialogTitle></DialogHeader>
        <div className="space-y-2">
          <Input placeholder="评分标准名称" value={name} onChange={(e) => setName(e.target.value)} />
          <Input placeholder="Judge 模型" value={judgeModel} onChange={(e) => setJudgeModel(e.target.value)} />
          <div className="space-y-2">
            {dims.map((d, i) => (
              <div key={i} className="rounded border p-2">
                <div className="flex gap-2">
                  <Input placeholder="维度名" value={d.name} onChange={(e) => { const a = [...dims]; a[i].name = e.target.value; setDims(a); }} className="flex-1" />
                  <Input placeholder="权重" type="number" step="0.1" value={d.weight} onChange={(e) => { const a = [...dims]; a[i].weight = parseFloat(e.target.value); setDims(a); }} className="w-20" />
                  <select className="rounded border p-1 text-sm" value={d.scorer} onChange={(e) => { const a = [...dims]; a[i].scorer = e.target.value; if (e.target.value === 'deterministic' && !a[i].assertions) a[i].assertions = [{ kind: 'contains', value: '' }]; setDims(a); }}>
                    <option value="deterministic">deterministic</option><option value="llm_judge">llm_judge</option>
                  </select>
                </div>
                {d.scorer === 'deterministic' && d.assertions?.map((a: any, j: number) => (
                  <div key={j} className="mt-1 flex gap-2">
                    <select className="rounded border p-1 text-xs" value={a.kind} onChange={(e) => { const arr = [...dims]; arr[i].assertions[j].kind = e.target.value; setDims(arr); }}>
                      <option value="contains">contains</option><option value="not_contains">not_contains</option>
                      <option value="starts_with">starts_with</option><option value="regex">regex</option>
                    </select>
                    <Input placeholder="值" value={a.value} onChange={(e) => { const arr = [...dims]; arr[i].assertions[j].value = e.target.value; setDims(arr); }} className="flex-1" />
                  </div>
                ))}
              </div>
            ))}
          </div>
        </div>
        <DialogFooter>
          <Button variant="outline" onClick={() => setOpen(false)}>取消</Button>
          <Button onClick={async () => {
            try {
              const rubric = await ec.createRubric(projectId!, name);
              await ec.createRubricVersion(rubric.id, { version_label: 'v1.0', dimensions: dims, judge_model: judgeModel, pass_threshold: '0.5' });
              toast.success('已创建并发布'); setName(''); onCreated();
            } catch (e: any) { toast.error(e.message); }
          }}>创建并发布</Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}

function NewRunDialog({ open, setOpen, agents, curVersion, curRubricVer, projectId, onCreated }: {
  open: boolean; setOpen: (v: boolean) => void; agents: { id: string; name: string }[];
  curVersion: EvalVersion | null; curRubricVer?: EvalRubricVersion | null; projectId?: string; onCreated: () => void;
}) {
  const [agentId, setAgentId] = useState(''); const [model, setModel] = useState('glm-5.2'); const [maxTurns, setMaxTurns] = useState(1);
  const [running, setRunning] = useState(false);
  return (
    <Dialog open={open} onOpenChange={setOpen}>
      <DialogContent>
        <DialogHeader><DialogTitle>发起评测运行</DialogTitle></DialogHeader>
        <div className="space-y-2">
          <select className="w-full rounded border p-2 text-sm" value={agentId} onChange={(e) => setAgentId(e.target.value)}>
            <option value="">选择 Agent</option>
            {agents.map((a) => <option key={a.id} value={a.id}>{a.name}</option>)}
          </select>
          <Input placeholder="模型" value={model} onChange={(e) => setModel(e.target.value)} />
          <Input type="number" min={1} max={5} value={maxTurns} onChange={(e) => setMaxTurns(parseInt(e.target.value) || 1)} />
          <div className="text-xs text-gray-500">数据集版本 v{curVersion?.version} ({curVersion?.case_count} 用例) · Rubric v{curRubricVer?.version}</div>
        </div>
        <DialogFooter>
          <Button variant="outline" onClick={() => setOpen(false)}>取消</Button>
          <Button disabled={running || !agentId} onClick={async () => {
            setRunning(true);
            try {
              toast.info('评测运行中，请稍候...');
              const run = await ec.createRun({
                project_id: projectId!, dataset_version_id: curVersion!.id, rubric_version_id: curRubricVer!.id,
                agent_id: agentId, llm_model: model, max_turns: maxTurns, judge_model: model,
              });
              toast.success(`运行完成，得分 ${run.overall_score}`);
              onCreated();
            } catch (e: any) { toast.error(e.message); } finally { setRunning(false); }
          }}>{running ? '运行中...' : '开始评测'}</Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}
