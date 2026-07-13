// Self-Evolving Harness routes — version archive, proposals, eval runs.
//
// All endpoints require admin role (harness mutations affect every agent on
// the host). The eval runner and registry are NOT exposed for mutation —
// only their outputs (versions, proposals, runs) are readable/writable.

import { Hono } from 'hono';
import type { Variables } from '../web-context.js';
import { authMiddleware, adminRoleMiddleware } from '../middleware/auth.js';
import {
  listHarnessEvalCases,
  listHarnessEvalRuns,
  listHarnessVersions,
  listHarnessProposals,
  type HarnessVersionStatus,
} from '../db.js';
import {
  captureCurrentHarness,
  diffVersions,
  getVersion,
  getPromotedVersion,
  listVersions,
  promoteVersion,
  readManifest,
  rollbackTo,
  snapshotCurrentHarness,
} from '../harness-registry.js';
import {
  listEvalRuns,
  loadAndSyncEvalCases,
  loadEvalCasesFromDb,
  runEvalForVersion,
} from '../harness-eval.js';
import {
  createProposal,
  getProposalWithEvidence,
  runMetaLoopForProposal,
} from '../harness-meta-loop.js';
import { logger } from '../logger.js';

const harnessRoutes = new Hono<{ Variables: Variables }>();

harnessRoutes.use('*', authMiddleware);
harnessRoutes.use('*', adminRoleMiddleware);

/** GET /api/harness/versions — list versions (newest first). */
harnessRoutes.get('/versions', (c) => {
  const status = c.req.query('status') as HarnessVersionStatus | undefined;
  const limit = parseInt(c.req.query('limit') ?? '100', 10);
  const versions = listVersions({ status, limit });
  const promoted = getPromotedVersion();
  return c.json({
    versions: versions.map((v) => ({
      ...v,
      is_promoted: promoted?.id === v.id,
    })),
    promoted_id: promoted?.id ?? null,
  });
});

/** POST /api/harness/snapshot — capture current harness into a new version. */
harnessRoutes.post('/snapshot', async (c) => {
  const body = await c.req.json().catch(() => ({} as any));
  const source = typeof body.source === 'string' ? body.source : 'manual';
  const status = body.status === 'promoted' ? 'promoted' : 'experimental';
  const notes = typeof body.notes === 'string' ? body.notes.slice(0, 1000) : null;
  // If status=promoted, this also promotes (demoting the previous promoted).
  const version = snapshotCurrentHarness({ source, status, notes });
  return c.json({ version });
});

/** GET /api/harness/versions/:id — version row + manifest. */
harnessRoutes.get('/versions/:id', (c) => {
  const id = c.req.param('id');
  const row = getVersion(id);
  if (!row) return c.json({ error: 'version not found' }, 404);
  const manifest = readManifest(id);
  return c.json({ version: row, manifest });
});

/** GET /api/harness/versions/:id/diff/:otherId — diff two versions. */
harnessRoutes.get('/versions/:id/diff/:otherId', (c) => {
  const aId = c.req.param('id');
  const bId = c.req.param('otherId');
  const diff = diffVersions(aId, bId);
  return c.json({ a: aId, b: bId, diff });
});

/** POST /api/harness/versions/:id/promote — promote a version to live. */
harnessRoutes.post('/versions/:id/promote', (c) => {
  const id = c.req.param('id');
  try {
    promoteVersion(id);
    return c.json({ ok: true, id });
  } catch (err) {
    return c.json({ error: (err as Error).message }, 400);
  }
});

/** POST /api/harness/versions/:id/rollback — rollback to a prior version. */
harnessRoutes.post('/versions/:id/rollback', (c) => {
  const id = c.req.param('id');
  try {
    rollbackTo(id);
    return c.json({ ok: true, id });
  } catch (err) {
    return c.json({ error: (err as Error).message }, 400);
  }
});

/** GET /api/harness/proposals — list proposals. */
harnessRoutes.get('/proposals', (c) => {
  const baselineVersionId = c.req.query('baseline_version_id');
  const proposals = listHarnessProposals({
    baselineVersionId: baselineVersionId || undefined,
    limit: 100,
  });
  return c.json({ proposals });
});

/** POST /api/harness/proposals — submit a proposal and run the meta-loop.
 *  Body: { hypothesis, expected_behavior, mutation_patch, baseline_version_id? }
 *  This is the entrypoint for the Self-Harness loop. */
harnessRoutes.post('/proposals', async (c) => {
  const body = await c.req.json().catch(() => ({} as any));
  const hypothesis = typeof body.hypothesis === 'string' ? body.hypothesis.slice(0, 2000) : '';
  const expectedBehavior = typeof body.expected_behavior === 'string' ? body.expected_behavior.slice(0, 2000) : '';
  const mutationPatch = typeof body.mutation_patch === 'string' ? body.mutation_patch.slice(0, 50_000) : '';
  const baselineVersionId = typeof body.baseline_version_id === 'string' ? body.baseline_version_id : undefined;
  const runImmediately = body.run_immediately !== false; // default true

  if (!hypothesis || !expectedBehavior || !mutationPatch) {
    return c.json({ error: 'hypothesis, expected_behavior, mutation_patch 必填' }, 400);
  }

  try {
    const created = createProposal({ hypothesis, expectedBehavior, mutationPatch, baselineVersionId });
    if (!runImmediately) {
      return c.json({ proposalId: created.proposalId, proposedVersionId: created.proposedVersionId, baselineVersionId: created.baselineVersionId, verdict: null });
    }
    const result = await runMetaLoopForProposal(created.proposalId);
    return c.json(result);
  } catch (err) {
    logger.error({ err: (err as Error).message }, 'harness proposal failed');
    return c.json({ error: (err as Error).message }, 500);
  }
});

/** GET /api/harness/proposals/:id — proposal + evidence. */
harnessRoutes.get('/proposals/:id', (c) => {
  const id = c.req.param('id');
  const evidence = getProposalWithEvidence(id);
  if (!evidence.proposal) return c.json({ error: 'proposal not found' }, 404);
  return c.json(evidence);
});

/** POST /api/harness/proposals/:id/run — (re)run the meta-loop for a proposal. */
harnessRoutes.post('/proposals/:id/run', async (c) => {
  const id = c.req.param('id');
  try {
    const result = await runMetaLoopForProposal(id);
    return c.json(result);
  } catch (err) {
    return c.json({ error: (err as Error).message }, 400);
  }
});

/** GET /api/harness/eval-runs — list eval runs. */
harnessRoutes.get('/eval-runs', (c) => {
  const versionId = c.req.query('version_id') || undefined;
  const proposalId = c.req.query('proposal_id') || undefined;
  const runs = listEvalRuns({ versionId, proposalId, limit: 500 });
  return c.json({ runs });
});

/** GET /api/harness/eval-cases — list eval cases (synced from disk on startup). */
harnessRoutes.get('/eval-cases', (c) => {
  const cases = loadEvalCasesFromDb(false);
  return c.json({ cases });
});

/** POST /api/harness/eval-cases/sync — re-scan data/harness/eval-cases/ and upsert. */
harnessRoutes.post('/eval-cases/sync', (c) => {
  const cases = loadAndSyncEvalCases();
  return c.json({ synced: cases.length, cases });
});

/** POST /api/harness/versions/:id/eval — run eval on a version without a proposal. */
harnessRoutes.post('/versions/:id/eval', async (c) => {
  const id = c.req.param('id');
  const version = getVersion(id);
  if (!version) return c.json({ error: 'version not found' }, 404);
  try {
    const { runs, aggregate } = await runEvalForVersion(id);
    return c.json({ runs, aggregate });
  } catch (err) {
    return c.json({ error: (err as Error).message }, 500);
  }
});

export default harnessRoutes;
