// DeepThink Eval Center — API routes
// Mounted at /api/eval-center. All eval data lives in the dedicated PostgreSQL.
// Uses authMiddleware (session cookie). user.id = owner_id.

import { Hono } from 'hono';
import type { Variables } from '../web-context.js';
import { authMiddleware } from '../middleware/auth.js';
import {
  isEvalDbReady, createProject, listProjects, getProject,
  createDataset, listDatasets, getDataset, archiveDataset,
  createDatasetVersion, listDatasetVersions, getDatasetVersion, getDatasetVersionByNum,
  publishDatasetVersion, rollbackDatasetVersion,
  createTestCase, listTestCases, getTestCase, updateTestCase, deleteTestCase, batchEditTestCases,
  promoteToGolden, diffVersions, cloneDataset,
  createRubric, listRubrics, getRubric, publishRubricVersion, createRubricDraft, listRubricVersions, getRubricVersion, rollbackRubric,
  createEvalRun, getEvalRun, listEvalRuns, getEvalResult, listEvalResults,
  getAgentTraceByResult, listTraceSpans,
  addGoldenAnnotation, listGoldenAnnotations, arbitrateGolden,
  listDriftReports, getPublishLogs,
} from '../eval-center/eval-db.js';
import { startEvalRun, retryCase } from '../eval-center/eval-runner.js';
import { detectDrift } from '../eval-center/eval-drift.js';

const evalCenterRoutes = new Hono<{ Variables: Variables }>();
evalCenterRoutes.use('*', authMiddleware);

// Guard: if eval PG not ready, return 503 on data routes (but allow a health probe)
evalCenterRoutes.use('*', async (c, next) => {
  if (!isEvalDbReady()) return c.json({ error: 'Eval Center database not initialized (EVAL_PG_URL)' }, 503);
  await next();
});

function getUser(c: any): string { return (c.get('user') as any).id as string; }

// ==================== Projects ====================
evalCenterRoutes.post('/projects', async (c) => {
  const body = await c.req.json();
  if (!body.name) return c.json({ error: 'name required' }, 400);
  const p = await createProject(body.name, getUser(c), body.description);
  return c.json(p, 201);
});
evalCenterRoutes.get('/projects', async (c) => c.json(await listProjects(getUser(c))));
evalCenterRoutes.get('/projects/:id', async (c) => {
  const p = await getProject(c.req.param('id'), getUser(c));
  return p ? c.json(p) : c.json({ error: 'not found' }, 404);
});

// ==================== Datasets ====================
evalCenterRoutes.post('/datasets', async (c) => {
  const body = await c.req.json();
  if (!body.project_id || !body.name) return c.json({ error: 'project_id, name required' }, 400);
  const ds = await createDataset(body.project_id, body.name, body.dataset_type ?? 'golden', body.description);
  return c.json(ds, 201);
});
evalCenterRoutes.get('/datasets', async (c) => {
  const pid = c.req.query('project_id');
  if (!pid) return c.json({ error: 'project_id required' }, 400);
  return c.json(await listDatasets(pid));
});
evalCenterRoutes.get('/datasets/:id', async (c) => {
  const ds = await getDataset(c.req.param('id'));
  return ds ? c.json(ds) : c.json({ error: 'not found' }, 404);
});
evalCenterRoutes.delete('/datasets/:id', async (c) => { await archiveDataset(c.req.param('id')); return c.json({ ok: true }); });

// ==================== Dataset Versions ====================
evalCenterRoutes.post('/datasets/:id/versions', async (c) => {
  const body = await c.req.json().catch(() => ({}));
  const v = await createDatasetVersion(c.req.param('id'), getUser(c), body.change_log, body.parent_version);
  return c.json(v, 201);
});
evalCenterRoutes.get('/datasets/:id/versions', async (c) => c.json(await listDatasetVersions(c.req.param('id'))));

evalCenterRoutes.post('/datasets/:id/versions/:vid/publish', async (c) => {
  try {
    const v = await publishDatasetVersion(c.req.param('vid'), getUser(c));
    return c.json(v);
  } catch (e) {
    return c.json({ error: (e as Error).message }, 400);
  }
});
evalCenterRoutes.post('/datasets/:id/rollback/:ver', async (c) => {
  try {
    await rollbackDatasetVersion(c.req.param('id'), parseInt(c.req.param('ver'), 10), getUser(c));
    return c.json({ ok: true });
  } catch (e) {
    return c.json({ error: (e as Error).message }, 400);
  }
});
evalCenterRoutes.get('/datasets/:id/diff', async (c) => {
  const fromV = parseInt(c.req.query('from') ?? '1', 10);
  const toV = parseInt(c.req.query('to') ?? '2', 10);
  return c.json(await diffVersions(c.req.param('id'), fromV, toV));
});
evalCenterRoutes.post('/datasets/:id/clone', async (c) => {
  const body = await c.req.json();
  if (!body.target_project_id || !body.name) return c.json({ error: 'target_project_id, name required' }, 400);
  try {
    const r = await cloneDataset(
      c.req.param('id'), body.target_project_id, body.name,
      body.clone_type ?? 'full', body.case_filter ?? null, getUser(c));
    return c.json(r, 201);
  } catch (e) {
    return c.json({ error: (e as Error).message }, 400);
  }
});

// ==================== Test Cases ====================
evalCenterRoutes.post('/test-cases', async (c) => {
  const body = await c.req.json();
  if (!body.dataset_version_id || !body.input_text) return c.json({ error: 'dataset_version_id, input_text required' }, 400);
  return c.json(await createTestCase(body.dataset_version_id, body), 201);
});
evalCenterRoutes.get('/test-cases', async (c) => {
  const vid = c.req.query('dataset_version_id');
  if (!vid) return c.json({ error: 'dataset_version_id required' }, 400);
  const filter: any = {};
  const tags = c.req.query('tags'); if (tags) filter.tags = String(tags).split(',');
  const status = c.req.query('status'); if (status) filter.status = String(status);
  const category = c.req.query('category'); if (category) filter.category = String(category);
  const difficulty = c.req.query('difficulty'); if (difficulty) filter.difficulty = String(difficulty);
  const keyword = c.req.query('keyword'); if (keyword) filter.keyword = String(keyword);
  return c.json(await listTestCases(vid, filter));
});
evalCenterRoutes.get('/test-cases/:id', async (c) => {
  const tc = await getTestCase(c.req.param('id'));
  return tc ? c.json(tc) : c.json({ error: 'not found' }, 404);
});
evalCenterRoutes.put('/test-cases/:id', async (c) => {
  const body = await c.req.json();
  const tc = await updateTestCase(c.req.param('id'), body);
  return tc ? c.json(tc) : c.json({ error: 'not found' }, 404);
});
evalCenterRoutes.delete('/test-cases/:id', async (c) => { await deleteTestCase(c.req.param('id')); return c.json({ ok: true }); });
evalCenterRoutes.post('/test-cases/batch-edit', async (c) => {
  const body = await c.req.json();
  const n = await batchEditTestCases(body.dataset_version_id, { tags: body.tags, category: body.category, difficulty: body.difficulty }, body.case_ids);
  return c.json({ updated: n });
});

// JSONL/CSV batch import
evalCenterRoutes.post('/test-cases/import', async (c) => {
  const body = await c.req.json();
  if (!body.dataset_version_id || !body.cases) return c.json({ error: 'dataset_version_id, cases[] required' }, 400);
  const created: any[] = [];
  for (const item of body.cases) {
    created.push(await createTestCase(body.dataset_version_id, item));
  }
  return c.json({ imported: created.length, cases: created }, 201);
});

// ==================== Golden Set ====================
evalCenterRoutes.post('/golden/:id/promote', async (c) => {
  const tc = await promoteToGolden(c.req.param('id'));
  return tc ? c.json(tc) : c.json({ error: 'not found' }, 404);
});
evalCenterRoutes.post('/golden/:id/annotations', async (c) => {
  const body = await c.req.json();
  const a = await addGoldenAnnotation({
    caseId: c.req.param('id'), annotatorId: getUser(c),
    expectedOutput: body.expected_output, expectedTrajectory: body.expected_trajectory,
    note: body.note, round: body.round,
  });
  return c.json(a, 201);
});
evalCenterRoutes.get('/golden/:id/annotations', async (c) => c.json(await listGoldenAnnotations(c.req.param('id'))));
evalCenterRoutes.post('/golden/:id/arbitrate', async (c) => {
  const body = await c.req.json();
  const a = await arbitrateGolden({
    caseId: c.req.param('id'), arbitratorId: getUser(c),
    finalExpectedOutput: body.final_expected_output, finalExpectedTrajectory: body.final_expected_trajectory,
    reason: body.reason,
  });
  return c.json(a, 201);
});

// ==================== Rubric ====================
evalCenterRoutes.post('/rubrics', async (c) => {
  const body = await c.req.json();
  if (!body.project_id || !body.name) return c.json({ error: 'project_id, name required' }, 400);
  return c.json(await createRubric(body.project_id, body.name, body.description), 201);
});
evalCenterRoutes.get('/rubrics', async (c) => {
  const pid = c.req.query('project_id'); if (!pid) return c.json({ error: 'project_id required' }, 400);
  return c.json(await listRubrics(pid));
});
evalCenterRoutes.get('/rubrics/:id', async (c) => {
  const r = await getRubric(c.req.param('id')); return r ? c.json(r) : c.json({ error: 'not found' }, 404);
});
evalCenterRoutes.post('/rubrics/:id/versions', async (c) => {
  const body = await c.req.json();
  if (!body.dimensions) return c.json({ error: 'dimensions[] required' }, 400);
  try {
    const v = await publishRubricVersion(
      c.req.param('id'), body.dimensions, body.judge_prompt, body.judge_model,
      body.pass_threshold ?? 0.5, getUser(c), body.version_label);
    return c.json(v, 201);
  } catch (e) { return c.json({ error: (e as Error).message }, 400); }
});
evalCenterRoutes.post('/rubrics/:id/draft', async (c) => {
  const body = await c.req.json();
  return c.json(await createRubricDraft(
    c.req.param('id'), body.dimensions, body.judge_prompt, body.judge_model,
    body.pass_threshold ?? 0.5, getUser(c)), 201);
});
evalCenterRoutes.get('/rubrics/:id/versions', async (c) => c.json(await listRubricVersions(c.req.param('id'))));
evalCenterRoutes.post('/rubrics/:id/rollback/:ver', async (c) => {
  try { await rollbackRubric(c.req.param('id'), parseInt(c.req.param('ver'), 10), getUser(c)); return c.json({ ok: true }); }
  catch (e) { return c.json({ error: (e as Error).message }, 400); }
});

// ==================== Eval Runs ====================
evalCenterRoutes.post('/eval-runs', async (c) => {
  const body = await c.req.json();
  if (!body.project_id || !body.dataset_version_id || !body.rubric_version_id || !body.agent_id) {
    return c.json({ error: 'project_id, dataset_version_id, rubric_version_id, agent_id required' }, 400);
  }
  try {
    const run = await startEvalRun({
      projectId: body.project_id, datasetVersionId: body.dataset_version_id,
      rubricVersionId: body.rubric_version_id, agentId: body.agent_id,
      llmModel: body.llm_model ?? '', modelParams: body.model_params,
      createdBy: getUser(c), maxTurns: body.max_turns, judgeModel: body.judge_model,
    });
    return c.json(run, 201);
  } catch (e) {
    return c.json({ error: (e as Error).message }, 400);
  }
});
evalCenterRoutes.get('/eval-runs', async (c) => {
  const pid = c.req.query('project_id'); if (!pid) return c.json({ error: 'project_id required' }, 400);
  return c.json(await listEvalRuns(pid));
});
// Multi-run compare — MUST precede '/eval-runs/:id' or "compare" is captured as :id.
evalCenterRoutes.get('/eval-runs/compare', async (c) => {
  const ids = (c.req.query('ids') ?? '').split(',').filter(Boolean);
  const out: any[] = [];
  for (const id of ids) {
    const run = await getEvalRun(id);
    const results = await listEvalResults(id);
    out.push({
      run_id: id, status: run?.status, overall_score: run?.overall_score, pass_rate: run?.pass_rate,
      model: run?.llm_model, results: results.map(r => ({ case_id: r.test_case_id, score: r.overall_score, pass: r.is_pass, dims: r.dimension_scores })),
    });
  }
  // Win/Loss/Tie on case-level scores
  if (out.length >= 2) {
    const a = out[0].results as any[]; const b = out[1].results as any[];
    const mapA = new Map(a.map(r => [r.case_id, r.score]));
    let win = 0, loss = 0, tie = 0;
    for (const r of b) {
      const sa = mapA.get(r.case_id); const sb = r.score;
      if (sa == null || sb == null) continue;
      if (sb > sa) win++; else if (sb < sa) loss++; else tie++;
    }
    return c.json({ runs: out, win_loss_tie: { win, loss, tie } });
  }
  return c.json({ runs: out });
});
evalCenterRoutes.get('/eval-runs/:id', async (c) => {
  const r = await getEvalRun(c.req.param('id')); return r ? c.json(r) : c.json({ error: 'not found' }, 404);
});
evalCenterRoutes.get('/eval-runs/:id/results', async (c) => c.json(await listEvalResults(c.req.param('id'))));
evalCenterRoutes.get('/eval-runs/:id/results/:rid', async (c) => {
  const r = await getEvalResult(c.req.param('rid')); return r ? c.json(r) : c.json({ error: 'not found' }, 404);
});
evalCenterRoutes.post('/eval-runs/:id/retry/:caseId', async (c) => {
  try {
    const r = await retryCase(c.req.param('id'), c.req.param('caseId'));
    return c.json(r);
  } catch (e) { return c.json({ error: (e as Error).message }, 400); }
});

// Trace lookup
evalCenterRoutes.get('/eval-runs/:id/traces/:rid', async (c) => {
  const trace = await getAgentTraceByResult(c.req.param('rid'));
  if (!trace) return c.json({ error: 'no trace' }, 404);
  const spans = await listTraceSpans(trace.id);
  return c.json({ trace, spans });
});

// ==================== Drift ====================
evalCenterRoutes.post('/drift/detect', async (c) => {
  const body = await c.req.json();
  const cur = await getDatasetVersion(body.dataset_version_id);
  if (!cur) return c.json({ error: 'current version not found' }, 404);
  if (!body.baseline_version_id) return c.json({ error: 'baseline_version_id required' }, 400);
  try {
    const r = await detectDrift(cur, body.baseline_version_id);
    return c.json(r, 201);
  } catch (e) { return c.json({ error: (e as Error).message }, 500); }
});
evalCenterRoutes.get('/drift/reports', async (c) => {
  const vid = c.req.query('dataset_version_id'); if (!vid) return c.json({ error: 'dataset_version_id required' }, 400);
  return c.json(await listDriftReports(vid));
});

// ==================== Publish logs ====================
evalCenterRoutes.get('/publish-logs', async (c) => {
  const et = c.req.query('entity_type'); const eid = c.req.query('entity_id');
  if (!et || !eid) return c.json({ error: 'entity_type, entity_id required' }, 400);
  return c.json(await getPublishLogs(et, eid));
});

// Health probe (no auth needed, but middleware already applied — lightweight)
evalCenterRoutes.get('/health', (c) => c.json({ ok: isEvalDbReady() }));

export default evalCenterRoutes;
