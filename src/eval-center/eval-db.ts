// DeepThink Eval Center — PostgreSQL data layer
// Dedicated pg.Pool, independent of the main SQLite db singleton.
// All eval-center data (datasets, cases, rubrics, runs, traces, scores) lives here.

import pg from 'pg';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import crypto from 'node:crypto';
import { logger } from '../logger.js';
import type {
  ProjectRow, DatasetRow, DatasetVersionRow, TestCaseRow,
  RubricRow, RubricVersionRow, EvalRunRow, EvalResultRow,
  AgentTraceRow, TraceSpanRow, RubricDimension, CreateTestCaseInput,
} from './eval-types.js';

const EVAL_PG_URL = process.env.EVAL_PG_URL || 'postgresql://eval:eval123@localhost:5436/eval_center';

let pool: pg.Pool | null = null;
let ready = false;

export function isEvalDbReady(): boolean {
  return ready && pool !== null;
}

export function getEvalPool(): pg.Pool {
  if (!pool) throw new Error('Eval PG pool not initialized');
  return pool;
}

export async function initEvalDb(): Promise<void> {
  pool = new pg.Pool({
    connectionString: EVAL_PG_URL,
    max: 10,
    idleTimeoutMillis: 30_000,
  });
  // Idle-client errors (e.g. PG restart kills connections) must NOT crash the
  // process — pg.Pool emits 'error' on idle clients; handle and log.
  pool.on('error', (err: any) => {
    logger.warn({ err: (err as Error).message?.slice(0, 200) }, 'Eval PG pool idle error (ignored)');
  });
  // Apply schema (idempotent)
  const __dirname = path.dirname(fileURLToPath(import.meta.url));
  const schemaPath = path.join(__dirname, 'eval-schema.sql');
  const schemaSql = fs.readFileSync(schemaPath, 'utf8');
  await pool.query(schemaSql);
  ready = true;
  logger.info({ url: EVAL_PG_URL.replace(/:[^:@]+@/, ':***@') }, 'Eval Center PG schema applied');
}

// ==================== Projects ====================

export async function createProject(name: string, ownerId: string, description?: string): Promise<ProjectRow> {
  const { rows } = await pool!.query<ProjectRow>(
    `INSERT INTO eval_project (name, description, owner_id) VALUES ($1, $2, $3) RETURNING *`,
    [name, description ?? null, ownerId],
  );
  return rows[0];
}

export async function listProjects(ownerId: string): Promise<ProjectRow[]> {
  const { rows } = await pool!.query<ProjectRow>(
    `SELECT * FROM eval_project WHERE owner_id = $1 ORDER BY created_at DESC`, [ownerId]);
  return rows;
}

export async function getProject(id: string, ownerId: string): Promise<ProjectRow | null> {
  const { rows } = await pool!.query<ProjectRow>(
    `SELECT * FROM eval_project WHERE id = $1 AND owner_id = $2`, [id, ownerId]);
  return rows[0] ?? null;
}

// ==================== Datasets ====================

export async function createDataset(
  projectId: string, name: string, datasetType: string, description?: string,
): Promise<DatasetRow> {
  const { rows } = await pool!.query<DatasetRow>(
    `INSERT INTO eval_dataset (project_id, name, description, dataset_type)
     VALUES ($1, $2, $3, $4) RETURNING *`,
    [projectId, name, description ?? null, datasetType],
  );
  return rows[0];
}

export async function listDatasets(projectId: string): Promise<DatasetRow[]> {
  const { rows } = await pool!.query<DatasetRow>(
    `SELECT * FROM eval_dataset WHERE project_id = $1 AND is_archived = false ORDER BY created_at DESC`,
    [projectId]);
  return rows;
}

export async function getDataset(id: string): Promise<DatasetRow | null> {
  const { rows } = await pool!.query<DatasetRow>(`SELECT * FROM eval_dataset WHERE id = $1`, [id]);
  return rows[0] ?? null;
}

export async function archiveDataset(id: string): Promise<void> {
  await pool!.query(`UPDATE eval_dataset SET is_archived = true WHERE id = $1`, [id]);
}

// ==================== Dataset Versions ====================

export async function createDatasetVersion(
  datasetId: string, createdBy: string, changeLog?: string, parentVersion?: number,
): Promise<DatasetVersionRow> {
  const client = await pool!.connect();
  try {
    await client.query('BEGIN');
    const { rows: maxRows } = await client.query(
      `SELECT COALESCE(MAX(version), 0) AS v FROM eval_dataset_version WHERE dataset_id = $1`, [datasetId]);
    const version = (maxRows[0].v ?? 0) + 1;
    const { rows } = await client.query<DatasetVersionRow>(
      `INSERT INTO eval_dataset_version (dataset_id, version, parent_version, content_hash, change_log, created_by)
       VALUES ($1, $2, $3, $4, $5, $6) RETURNING *`,
      [datasetId, version, parentVersion ?? null, 'pending', changeLog ?? null, createdBy],
    );
    await client.query('COMMIT');
    return rows[0];
  } catch (e) {
    await client.query('ROLLBACK');
    throw e;
  } finally {
    client.release();
  }
}

export async function listDatasetVersions(datasetId: string): Promise<DatasetVersionRow[]> {
  const { rows } = await pool!.query<DatasetVersionRow>(
    `SELECT * FROM eval_dataset_version WHERE dataset_id = $1 ORDER BY version DESC`, [datasetId]);
  return rows;
}

export async function getDatasetVersion(id: string): Promise<DatasetVersionRow | null> {
  const { rows } = await pool!.query<DatasetVersionRow>(
    `SELECT * FROM eval_dataset_version WHERE id = $1`, [id]);
  return rows[0] ?? null;
}

export async function getDatasetVersionByNum(datasetId: string, version: number): Promise<DatasetVersionRow | null> {
  const { rows } = await pool!.query<DatasetVersionRow>(
    `SELECT * FROM eval_dataset_version WHERE dataset_id = $1 AND version = $2`, [datasetId, version]);
  return rows[0] ?? null;
}

// Compute content hash over all active cases in a version (SHA-256 over canonical JSON)
export async function computeVersionContentHash(versionId: string): Promise<string> {
  const { rows } = await pool!.query(
    `SELECT id, input_text, expected_output, expected_trajectory, expected_tool_calls, tags, difficulty, category, is_golden
     FROM eval_test_case WHERE dataset_version_id = $1 AND status != 'deprecated'
     ORDER BY id`, [versionId]);
  const canon = JSON.stringify(rows.map((r: any) => ({
    i: r.input_text, e: r.expected_output, t: r.expected_trajectory, tc: r.expected_tool_calls,
    g: r.tags, d: r.difficulty, c: r.category, golden: r.is_golden,
  })));
  return crypto.createHash('sha256').update(canon).digest('hex');
}

export async function publishDatasetVersion(versionId: string, ownerId: string): Promise<DatasetVersionRow> {
  const client = await pool!.connect();
  try {
    await client.query('BEGIN');
    const { rows: vRows } = await client.query<DatasetVersionRow>(
      `SELECT * FROM eval_dataset_version WHERE id = $1 FOR UPDATE`, [versionId]);
    const ver = vRows[0];
    if (!ver) throw new Error('version not found');
    if (ver.status === 'published') throw new Error('already published');
    // Count active cases
    const { rows: cRows } = await client.query(
      `SELECT COUNT(*)::int AS n FROM eval_test_case WHERE dataset_version_id = $1 AND status = 'active'`, [versionId]);
    const caseCount = cRows[0].n;
    if (caseCount === 0) throw new Error('cannot publish empty dataset (no active cases)');
    const contentHash = await computeVersionContentHashFromClient(client, versionId);
    // Idempotent: if same content_hash already published, point latest to it
    const { rows: exist } = await client.query<DatasetVersionRow>(
      `SELECT * FROM eval_dataset_version WHERE dataset_id = $1 AND content_hash = $2 AND status = 'published'`,
      [ver.dataset_id, contentHash]);
    let target: DatasetVersionRow;
    if (exist.length > 0) {
      // Re-publish same content — just bump latest
      target = exist[0];
      await client.query(`UPDATE eval_dataset_version SET status = 'deprecated' WHERE id = $1`, [versionId]);
    } else {
      const { rows: upd } = await client.query<DatasetVersionRow>(
        `UPDATE eval_dataset_version SET status = 'published', content_hash = $1, case_count = $2, published_at = now()
         WHERE id = $3 RETURNING *`, [contentHash, caseCount, versionId]);
      target = upd[0];
    }
    await client.query(`UPDATE eval_dataset SET latest_version = $1 WHERE id = $2`, [target.version, ver.dataset_id]);
    await client.query(
      `INSERT INTO eval_publish_log (entity_type, entity_id, from_version, to_version, action, operator_id)
       VALUES ('dataset', $1, $2, $3, 'publish', $4)`,
      [ver.dataset_id, ver.version, target.version, ownerId]);
    await client.query('COMMIT');
    return target;
  } catch (e) {
    await client.query('ROLLBACK');
    throw e;
  } finally {
    client.release();
  }
}

async function computeVersionContentHashFromClient(client: pg.PoolClient, versionId: string): Promise<string> {
  const { rows } = await client.query(
    `SELECT id, input_text, expected_output, expected_trajectory, expected_tool_calls, tags, difficulty, category, is_golden
     FROM eval_test_case WHERE dataset_version_id = $1 AND status != 'deprecated' ORDER BY id`, [versionId]);
  const canon = JSON.stringify(rows.map((r: any) => ({
    i: r.input_text, e: r.expected_output, t: r.expected_trajectory, tc: r.expected_tool_calls,
    g: r.tags, d: r.difficulty, c: r.category, golden: r.is_golden,
  })));
  return crypto.createHash('sha256').update(canon).digest('hex');
}

export async function rollbackDatasetVersion(datasetId: string, toVersion: number, ownerId: string): Promise<void> {
  const client = await pool!.connect();
  try {
    await client.query('BEGIN');
    const { rows } = await client.query<DatasetVersionRow>(
      `SELECT * FROM eval_dataset_version WHERE dataset_id = $1 AND version = $2 AND status = 'published'`,
      [datasetId, toVersion]);
    if (!rows[0]) throw new Error(`published version ${toVersion} not found`);
    await client.query(`UPDATE eval_dataset SET latest_version = $1 WHERE id = $2`, [toVersion, datasetId]);
    await client.query(
      `INSERT INTO eval_publish_log (entity_type, entity_id, from_version, to_version, action, operator_id)
       VALUES ('dataset', $1, NULL, $2, 'rollback', $3)`, [datasetId, toVersion, ownerId]);
    await client.query('COMMIT');
  } catch (e) {
    await client.query('ROLLBACK');
    throw e;
  } finally {
    client.release();
  }
}

// ==================== Test Cases ====================

export async function createTestCase(versionId: string, input: CreateTestCaseInput): Promise<TestCaseRow> {
  const { rows } = await pool!.query<TestCaseRow>(
    `INSERT INTO eval_test_case
       (dataset_version_id, external_id, input_text, input_metadata, expected_output,
        expected_trajectory, expected_tool_calls, context, tags, difficulty, category, is_golden, status)
     VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13) RETURNING *`,
    [versionId, input.external_id ?? null, input.input_text, JSON.stringify(input.input_metadata ?? {}),
     input.expected_output ?? null, JSON.stringify(input.expected_trajectory ?? null) ?? null,
     JSON.stringify(input.expected_tool_calls ?? null) ?? null, JSON.stringify(input.context ?? {}),
     input.tags ?? [], input.difficulty ?? null, input.category ?? null, input.is_golden ?? false,
     input.status ?? 'active'],
  );
  return rows[0];
}

export async function listTestCases(versionId: string, filter?: {
  tags?: string[]; category?: string; difficulty?: string; status?: string; keyword?: string;
}): Promise<TestCaseRow[]> {
  const where = [`dataset_version_id = $1`];
  const params: any[] = [versionId];
  let idx = 2;
  if (filter?.status) { where.push(`status = $${idx++}`); params.push(filter.status); }
  if (filter?.category) { where.push(`category = $${idx++}`); params.push(filter.category); }
  if (filter?.difficulty) { where.push(`difficulty = $${idx++}`); params.push(filter.difficulty); }
  if (filter?.tags?.length) { where.push(`tags && $${idx++}`); params.push(filter.tags); }
  if (filter?.keyword) { where.push(`input_text ILIKE $${idx++}`); params.push(`%${filter.keyword}%`); }
  const { rows } = await pool!.query<TestCaseRow>(
    `SELECT * FROM eval_test_case WHERE ${where.join(' AND ')} ORDER BY created_at`, params);
  return rows;
}

export async function getTestCase(id: string): Promise<TestCaseRow | null> {
  const { rows } = await pool!.query<TestCaseRow>(`SELECT * FROM eval_test_case WHERE id = $1`, [id]);
  return rows[0] ?? null;
}

export async function updateTestCase(id: string, patch: Partial<CreateTestCaseInput>): Promise<TestCaseRow | null> {
  const sets: string[] = [];
  const params: any[] = [];
  let idx = 1;
  const add = (col: string, val: any) => { sets.push(`${col} = $${idx++}`); params.push(val); };
  if (patch.input_text !== undefined) add('input_text', patch.input_text);
  if (patch.input_metadata !== undefined) add('input_metadata', JSON.stringify(patch.input_metadata));
  if (patch.expected_output !== undefined) add('expected_output', patch.expected_output);
  if (patch.expected_trajectory !== undefined) add('expected_trajectory', JSON.stringify(patch.expected_trajectory) ?? null);
  if (patch.expected_tool_calls !== undefined) add('expected_tool_calls', JSON.stringify(patch.expected_tool_calls) ?? null);
  if (patch.context !== undefined) add('context', JSON.stringify(patch.context));
  if (patch.tags !== undefined) add('tags', patch.tags);
  if (patch.difficulty !== undefined) add('difficulty', patch.difficulty);
  if (patch.category !== undefined) add('category', patch.category);
  if (patch.is_golden !== undefined) add('is_golden', patch.is_golden);
  if (patch.status !== undefined) add('status', patch.status);
  if (patch.external_id !== undefined) add('external_id', patch.external_id);
  if (sets.length === 0) return getTestCase(id);
  params.push(id);
  const { rows } = await pool!.query<TestCaseRow>(
    `UPDATE eval_test_case SET ${sets.join(', ')} WHERE id = $${idx} RETURNING *`, params);
  return rows[0] ?? null;
}

export async function deleteTestCase(id: string): Promise<void> {
  // Soft delete
  await pool!.query(`UPDATE eval_test_case SET status = 'deprecated' WHERE id = $1`, [id]);
}

export async function batchEditTestCases(versionId: string, patch: {
  tags?: string[]; category?: string; difficulty?: string;
}, caseIds?: string[]): Promise<number> {
  const sets: string[] = [];
  const params: any[] = [];
  let idx = 1;
  if (patch.tags !== undefined) { sets.push(`tags = $${idx++}`); params.push(patch.tags); }
  if (patch.category !== undefined) { sets.push(`category = $${idx++}`); params.push(patch.category); }
  if (patch.difficulty !== undefined) { sets.push(`difficulty = $${idx++}`); params.push(patch.difficulty); }
  if (sets.length === 0) return 0;
  let where = `dataset_version_id = $${idx++}`;
  params.push(versionId);
  if (caseIds?.length) { where += ` AND id = ANY($${idx++})`; params.push(caseIds); }
  const r = await pool!.query(`UPDATE eval_test_case SET ${sets.join(', ')} WHERE ${where}`, params);
  return r.rowCount ?? 0;
}

export async function promoteToGolden(caseId: string): Promise<TestCaseRow | null> {
  const { rows } = await pool!.query<TestCaseRow>(
    `UPDATE eval_test_case SET is_golden = true WHERE id = $1 RETURNING *`, [caseId]);
  return rows[0] ?? null;
}

// Version Diff
export async function diffVersions(datasetId: string, fromVer: number, toVer: number): Promise<{
  added: any[]; modified: any[]; removed: any[];
}> {
  const fromCases = await listTestCasesByVerNum(datasetId, fromVer);
  const toCases = await listTestCasesByVerNum(datasetId, toVer);
  const fromMap = new Map(fromCases.map((c: any) => [c.external_id || c.id, c]));
  const toMap = new Map(toCases.map((c: any) => [c.external_id || c.id, c]));
  const added: any[] = []; const modified: any[] = []; const removed: any[] = [];
  for (const [k, c] of toMap) {
    if (!fromMap.has(k)) added.push(c);
    else if (JSON.stringify(fromMap.get(k)) !== JSON.stringify(c)) modified.push(c);
  }
  for (const [k, c] of fromMap) if (!toMap.has(k)) removed.push(c);
  return { added, modified, removed };
}

async function listTestCasesByVerNum(datasetId: string, version: number): Promise<TestCaseRow[]> {
  const { rows } = await pool!.query<TestCaseRow>(
    `SELECT tc.* FROM eval_test_case tc JOIN eval_dataset_version dv ON tc.dataset_version_id = dv.id
     WHERE dv.dataset_id = $1 AND dv.version = $2 AND tc.status != 'deprecated' ORDER BY tc.created_at`,
    [datasetId, version]);
  return rows;
}

// ==================== Clone ====================

export async function cloneDataset(
  sourceVersionId: string, targetProjectId: string, name: string, cloneType: string,
  caseFilter: any, ownerId: string,
): Promise<{ dataset: DatasetRow; version: DatasetVersionRow }> {
  const client = await pool!.connect();
  try {
    await client.query('BEGIN');
    const { rows: srcVerRows } = await client.query<DatasetVersionRow>(
      `SELECT * FROM eval_dataset_version WHERE id = $1`, [sourceVersionId]);
    const srcVer = srcVerRows[0];
    if (!srcVer) throw new Error('source version not found');
    // Create target dataset
    const dsType = (await client.query(`SELECT dataset_type FROM eval_dataset WHERE id = $1`, [srcVer.dataset_id])).rows[0].dataset_type;
    const { rows: dsRows } = await client.query<DatasetRow>(
      `INSERT INTO eval_dataset (project_id, name, dataset_type, description)
       VALUES ($1, $2, $3, 'cloned from '||$4) RETURNING *`,
      [targetProjectId, name, dsType, srcVer.version_label ?? srcVer.version]);
    const dataset = dsRows[0];
    // Create target version
    const { rows: vRows } = await client.query<DatasetVersionRow>(
      `INSERT INTO eval_dataset_version (dataset_id, version, parent_version, content_hash, change_log, created_by)
       VALUES ($1, 1, $2, 'pending', $3, $4) RETURNING *`,
      [dataset.id, srcVer.version, `clone (${cloneType}) from ${srcVer.version_label ?? srcVer.version}`, ownerId]);
    const version = vRows[0];
    // Copy cases
    let caseQuery = `SELECT * FROM eval_test_case WHERE dataset_version_id = $1 AND status != 'deprecated'`;
    const caseParams: any[] = [sourceVersionId];
    if (cloneType === 'partial') {
      if (caseFilter?.tags?.length) { caseQuery += ` AND tags && $2`; caseParams.push(caseFilter.tags); }
      if (caseFilter?.category) { caseQuery += ` AND category = $${caseParams.length + 1}`; caseParams.push(caseFilter.category); }
    }
    const { rows: cases } = await client.query(caseQuery, caseParams);
    for (const c of cases) {
      await client.query(
        `INSERT INTO eval_test_case
          (dataset_version_id, external_id, input_text, input_metadata, expected_output,
           expected_trajectory, expected_tool_calls, context, tags, difficulty, category, is_golden, status, source_trace_id)
         VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14)`,
        [version.id, c.external_id, c.input_text, c.input_metadata, c.expected_output,
         c.expected_trajectory, c.expected_tool_calls, c.context, c.tags, c.difficulty, c.category,
         c.is_golden, c.status, c.source_trace_id]);
    }
    // Clone log
    await client.query(
      `INSERT INTO eval_dataset_clone_log (source_dataset_version_id, target_dataset_id, target_version, clone_type, case_filter, operator_id)
       VALUES ($1,$2,$3,$4,$5,$6)`,
      [sourceVersionId, dataset.id, 1, cloneType, JSON.stringify(caseFilter ?? {}), ownerId]);
    await client.query('COMMIT');
    return { dataset, version };
  } catch (e) {
    await client.query('ROLLBACK');
    throw e;
  } finally {
    client.release();
  }
}

// ==================== Rubric ====================

export async function createRubric(projectId: string, name: string, description?: string): Promise<RubricRow> {
  const { rows } = await pool!.query<RubricRow>(
    `INSERT INTO eval_rubric (project_id, name, description) VALUES ($1, $2, $3) RETURNING *`,
    [projectId, name, description ?? null]);
  return rows[0];
}

export async function listRubrics(projectId: string): Promise<RubricRow[]> {
  const { rows } = await pool!.query<RubricRow>(
    `SELECT * FROM eval_rubric WHERE project_id = $1 ORDER BY created_at DESC`, [projectId]);
  return rows;
}

export async function getRubric(id: string): Promise<RubricRow | null> {
  const { rows } = await pool!.query<RubricRow>(`SELECT * FROM eval_rubric WHERE id = $1`, [id]);
  return rows[0] ?? null;
}

export async function publishRubricVersion(
  rubricId: string, dimensions: RubricDimension[], judgePrompt: string | null,
  judgeModel: string | null, passThreshold: number, createdBy: string, versionLabel?: string,
): Promise<RubricVersionRow> {
  const client = await pool!.connect();
  try {
    await client.query('BEGIN');
    const { rows: maxRows } = await client.query(
      `SELECT COALESCE(MAX(version), 0) AS v FROM eval_rubric_version WHERE rubric_id = $1`, [rubricId]);
    const version = (maxRows[0].v ?? 0) + 1;
    const { rows } = await client.query<RubricVersionRow>(
      `INSERT INTO eval_rubric_version (rubric_id, version, version_label, dimensions, judge_prompt, judge_model, pass_threshold, status, created_by, published_at)
       VALUES ($1,$2,$3,$4,$5,$6,$7,'published',$8,now()) RETURNING *`,
      [rubricId, version, versionLabel ?? `v${version}`, JSON.stringify(dimensions),
       judgePrompt, judgeModel, passThreshold, createdBy]);
    await client.query(`UPDATE eval_rubric SET latest_version = $1 WHERE id = $2`, [version, rubricId]);
    await client.query(
      `INSERT INTO eval_publish_log (entity_type, entity_id, from_version, to_version, action, operator_id)
       VALUES ('rubric', $1, NULL, $2, 'publish', $3)`, [rubricId, version, createdBy]);
    await client.query('COMMIT');
    return rows[0];
  } catch (e) {
    await client.query('ROLLBACK');
    throw e;
  } finally {
    client.release();
  }
}

export async function createRubricDraft(
  rubricId: string, dimensions: RubricDimension[], judgePrompt: string | null,
  judgeModel: string | null, passThreshold: number, createdBy: string,
): Promise<RubricVersionRow> {
  const { rows: maxRows } = await pool!.query(
    `SELECT COALESCE(MAX(version), 0) AS v FROM eval_rubric_version WHERE rubric_id = $1`, [rubricId]);
  const version = (maxRows[0].v ?? 0) + 1;
  const { rows } = await pool!.query<RubricVersionRow>(
    `INSERT INTO eval_rubric_version (rubric_id, version, dimensions, judge_prompt, judge_model, pass_threshold, created_by)
     VALUES ($1,$2,$3,$4,$5,$6,$7) RETURNING *`,
    [rubricId, version, JSON.stringify(dimensions), judgePrompt, judgeModel, passThreshold, createdBy]);
  return rows[0];
}

export async function listRubricVersions(rubricId: string): Promise<RubricVersionRow[]> {
  const { rows } = await pool!.query<RubricVersionRow>(
    `SELECT * FROM eval_rubric_version WHERE rubric_id = $1 ORDER BY version DESC`, [rubricId]);
  return rows;
}

export async function getRubricVersion(id: string): Promise<RubricVersionRow | null> {
  const { rows } = await pool!.query<RubricVersionRow>(
    `SELECT * FROM eval_rubric_version WHERE id = $1`, [id]);
  return rows[0] ?? null;
}

export async function rollbackRubric(rubricId: string, toVersion: number, ownerId: string): Promise<void> {
  const { rows } = await pool!.query(
    `SELECT id FROM eval_rubric_version WHERE rubric_id = $1 AND version = $2`, [rubricId, toVersion]);
  if (!rows[0]) throw new Error(`rubric version ${toVersion} not found`);
  await pool!.query(`UPDATE eval_rubric SET latest_version = $1 WHERE id = $2`, [toVersion, rubricId]);
  await pool!.query(
    `INSERT INTO eval_publish_log (entity_type, entity_id, from_version, to_version, action, operator_id)
     VALUES ('rubric', $1, NULL, $2, 'rollback', $3)`, [rubricId, toVersion, ownerId]);
}

// ==================== Eval Runs ====================

export async function createEvalRun(input: {
  projectId: string; datasetVersionId: string; rubricVersionId: string;
  agentId: string; agentVersion?: string; llmModel: string; modelParams?: any;
  configSnapshot: any; createdBy: string;
}): Promise<EvalRunRow> {
  const { rows } = await pool!.query<EvalRunRow>(
    `INSERT INTO eval_run (project_id, dataset_version_id, rubric_version_id, agent_id, agent_version,
       llm_model, model_params, config_snapshot, created_by)
     VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9) RETURNING *`,
    [input.projectId, input.datasetVersionId, input.rubricVersionId, input.agentId, input.agentVersion ?? null,
     input.llmModel, JSON.stringify(input.modelParams ?? {}), JSON.stringify(input.configSnapshot), input.createdBy]);
  return rows[0];
}

export async function updateEvalRun(id: string, patch: Partial<EvalRunRow>): Promise<void> {
  const sets: string[] = []; const params: any[] = []; let idx = 1;
  const numCols = ['total_cases', 'completed_cases', 'passed_cases', 'overall_score'];
  const jsonCols = ['model_params', 'config_snapshot'];
  for (const [k, v] of Object.entries(patch)) {
    if (v === undefined) continue;
    if (numCols.includes(k)) { sets.push(`${k} = $${idx++}`); params.push(v); }
    else if (jsonCols.includes(k)) { sets.push(`${k} = $${idx++}`); params.push(JSON.stringify(v)); }
    else { sets.push(`${k} = $${idx++}`); params.push(v); }
  }
  if (sets.length === 0) return;
  params.push(id);
  await pool!.query(`UPDATE eval_run SET ${sets.join(', ')} WHERE id = $${idx}`, params);
}

export async function getEvalRun(id: string): Promise<EvalRunRow | null> {
  const { rows } = await pool!.query<EvalRunRow>(`SELECT * FROM eval_run WHERE id = $1`, [id]);
  return rows[0] ?? null;
}

export async function listEvalRuns(projectId: string, limit = 50): Promise<EvalRunRow[]> {
  const { rows } = await pool!.query<EvalRunRow>(
    `SELECT * FROM eval_run WHERE project_id = $1 ORDER BY created_at DESC LIMIT $2`, [projectId, limit]);
  return rows;
}

// ==================== Eval Results ====================

export async function createEvalResult(runId: string, caseId: string): Promise<EvalResultRow> {
  const { rows } = await pool!.query<EvalResultRow>(
    `INSERT INTO eval_result (run_id, test_case_id) VALUES ($1, $2)
     ON CONFLICT (run_id, test_case_id) DO UPDATE SET retry_count = eval_result.retry_count + 1, status = 'running'
     RETURNING *`, [runId, caseId]);
  return rows[0];
}

export async function updateEvalResult(id: string, patch: Partial<EvalResultRow>): Promise<void> {
  const sets: string[] = []; const params: any[] = []; let idx = 1;
  const jsonCols = ['token_usage', 'dimension_scores', 'assertion_results'];
  for (const [k, v] of Object.entries(patch)) {
    if (v === undefined) continue;
    if (jsonCols.includes(k)) { sets.push(`${k} = $${idx++}`); params.push(JSON.stringify(v)); }
    else { sets.push(`${k} = $${idx++}`); params.push(v); }
  }
  if (sets.length === 0) return;
  params.push(id);
  await pool!.query(`UPDATE eval_result SET ${sets.join(', ')} WHERE id = $${idx}`, params);
}

export async function getEvalResult(id: string): Promise<EvalResultRow | null> {
  const { rows } = await pool!.query<EvalResultRow>(`SELECT * FROM eval_result WHERE id = $1`, [id]);
  return rows[0] ?? null;
}

export async function listEvalResults(runId: string): Promise<EvalResultRow[]> {
  const { rows } = await pool!.query<EvalResultRow>(
    `SELECT * FROM eval_result WHERE run_id = $1 ORDER BY created_at`, [runId]);
  return rows;
}

// ==================== Agent Trace + Spans ====================

export async function createAgentTrace(input: {
  evalResultId: string; runId: string; sessionId?: string; inputSummary?: string;
  outputSummary?: string; metadata?: any;
}): Promise<AgentTraceRow> {
  const { rows } = await pool!.query<AgentTraceRow>(
    `INSERT INTO agent_trace (eval_result_id, run_id, session_id, input_summary, output_summary, metadata)
     VALUES ($1,$2,$3,$4,$5,$6) RETURNING *`,
    [input.evalResultId, input.runId, input.sessionId ?? null, input.inputSummary ?? null,
     input.outputSummary ?? null, JSON.stringify(input.metadata ?? {})]);
  return rows[0];
}

export async function updateAgentTrace(id: string, patch: Partial<AgentTraceRow>): Promise<void> {
  const sets: string[] = []; const params: any[] = []; let idx = 1;
  if (patch.total_latency_ms !== undefined) { sets.push(`total_latency_ms = $${idx++}`); params.push(patch.total_latency_ms); }
  if (patch.total_tokens !== undefined) { sets.push(`total_tokens = $${idx++}`); params.push(patch.total_tokens); }
  if (patch.span_count !== undefined) { sets.push(`span_count = $${idx++}`); params.push(patch.span_count); }
  if (patch.output_summary !== undefined) { sets.push(`output_summary = $${idx++}`); params.push(patch.output_summary); }
  if (patch.metadata !== undefined) { sets.push(`metadata = $${idx++}`); params.push(JSON.stringify(patch.metadata)); }
  if (sets.length === 0) return;
  params.push(id);
  await pool!.query(`UPDATE agent_trace SET ${sets.join(', ')} WHERE id = $${idx}`, params);
}

export async function createTraceSpan(input: {
  traceId: string; parentSpanId?: string | null; spanType: string; sequenceOrder: number;
  name?: string; inputData?: any; outputData?: any; model?: string; tokenUsage?: any;
  latencyMs?: number; status?: string; errorMessage?: string; metadata?: any;
  startedAt?: string | null; endedAt?: string | null;
}): Promise<TraceSpanRow> {
  const { rows } = await pool!.query<TraceSpanRow>(
    `INSERT INTO trace_span
      (trace_id, parent_span_id, span_type, sequence_order, name, input_data, output_data, model,
       token_usage, latency_ms, status, error_message, metadata, started_at, ended_at)
     VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,$15) RETURNING *`,
    [input.traceId, input.parentSpanId ?? null, input.spanType, input.sequenceOrder, input.name ?? null,
     JSON.stringify(input.inputData ?? null) ?? null, JSON.stringify(input.outputData ?? null) ?? null,
     input.model ?? null, JSON.stringify(input.tokenUsage ?? {}) ?? null, input.latencyMs ?? null,
     input.status ?? 'ok', input.errorMessage ?? null, JSON.stringify(input.metadata ?? {}) ?? null,
     input.startedAt ?? null, input.endedAt ?? null]);
  return rows[0];
}

export async function getAgentTraceByResult(evalResultId: string): Promise<AgentTraceRow | null> {
  const { rows } = await pool!.query<AgentTraceRow>(
    `SELECT * FROM agent_trace WHERE eval_result_id = $1`, [evalResultId]);
  return rows[0] ?? null;
}

export async function listTraceSpans(traceId: string): Promise<TraceSpanRow[]> {
  const { rows } = await pool!.query<TraceSpanRow>(
    `SELECT * FROM trace_span WHERE trace_id = $1 ORDER BY sequence_order`, [traceId]);
  return rows;
}

// ==================== Golden Annotations ====================

export async function addGoldenAnnotation(input: {
  caseId: string; annotatorId: string; expectedOutput?: string; expectedTrajectory?: any; note?: string; round?: number;
}): Promise<any> {
  const { rows } = await pool!.query(
    `INSERT INTO eval_golden_annotation (test_case_id, annotator_id, expected_output, expected_trajectory, note, round)
     VALUES ($1,$2,$3,$4,$5,$6)
     ON CONFLICT (test_case_id, annotator_id, round) DO UPDATE SET expected_output = EXCLUDED.expected_output, expected_trajectory = EXCLUDED.expected_trajectory, note = EXCLUDED.note
     RETURNING *`,
    [input.caseId, input.annotatorId, input.expectedOutput ?? null,
     JSON.stringify(input.expectedTrajectory ?? null) ?? null, input.note ?? null, input.round ?? 1]);
  return rows[0];
}

export async function listGoldenAnnotations(caseId: string): Promise<any[]> {
  const { rows } = await pool!.query(
    `SELECT * FROM eval_golden_annotation WHERE test_case_id = $1 ORDER BY round, created_at`, [caseId]);
  return rows;
}

export async function arbitrateGolden(input: {
  caseId: string; arbitratorId: string; finalExpectedOutput?: string; finalExpectedTrajectory?: any; reason?: string;
}): Promise<any> {
  const client = await pool!.connect();
  try {
    await client.query('BEGIN');
    const { rows } = await client.query(
      `INSERT INTO eval_golden_arbitration (test_case_id, arbitrator_id, final_expected_output, final_expected_trajectory, reason)
       VALUES ($1,$2,$3,$4,$5) RETURNING *`,
      [input.caseId, input.arbitratorId, input.finalExpectedOutput ?? null,
       JSON.stringify(input.finalExpectedTrajectory ?? null) ?? null, input.reason ?? null]);
    if (input.finalExpectedOutput !== undefined) {
      await client.query(`UPDATE eval_test_case SET expected_output = $1 WHERE id = $2`,
        [input.finalExpectedOutput, input.caseId]);
    }
    await client.query(`UPDATE eval_test_case SET is_golden = true WHERE id = $1`, [input.caseId]);
    await client.query('COMMIT');
    return rows[0];
  } catch (e) {
    await client.query('ROLLBACK');
    throw e;
  } finally {
    client.release();
  }
}

// ==================== Drift ====================

export async function upsertCaseEmbedding(caseId: string, versionId: string, embedding: number[], model: string): Promise<void> {
  const vec = `[${embedding.join(',')}]`;
  await pool!.query(
    `INSERT INTO eval_case_embedding (test_case_id, dataset_version_id, embedding, model)
     VALUES ($1,$2,$3::vector,$4)
     ON CONFLICT (test_case_id) DO UPDATE SET embedding = EXCLUDED.embedding, model = EXCLUDED.model, dataset_version_id = EXCLUDED.dataset_version_id`,
    [caseId, versionId, vec, model]);
}

export async function createDriftReport(input: {
  datasetVersionId: string; reportType: string; driftScore: number; detail: any;
  baselineRef?: string; isDrifted?: boolean;
}): Promise<any> {
  const { rows } = await pool!.query(
    `INSERT INTO eval_drift_report (dataset_version_id, report_type, drift_score, detail, baseline_ref, is_drifted)
     VALUES ($1,$2,$3,$4,$5,$6) RETURNING *`,
    [input.datasetVersionId, input.reportType, input.driftScore,
     JSON.stringify(input.detail ?? {}), input.baselineRef ?? null, input.isDrifted ?? false]);
  return rows[0];
}

export async function listDriftReports(datasetVersionId: string): Promise<any[]> {
  const { rows } = await pool!.query(
    `SELECT * FROM eval_drift_report WHERE dataset_version_id = $1 ORDER BY created_at DESC`, [datasetVersionId]);
  return rows;
}

export async function getCaseEmbeddings(versionId: string): Promise<{ embedding: string; test_case_id: string }[]> {
  const { rows } = await pool!.query(
    `SELECT test_case_id, embedding::text FROM eval_case_embedding WHERE dataset_version_id = $1`, [versionId]);
  return rows as any as { embedding: string; test_case_id: string }[];
}

export async function getPublishLogs(entityType: string, entityId: string): Promise<any[]> {
  const { rows } = await pool!.query(
    `SELECT * FROM eval_publish_log WHERE entity_type = $1 AND entity_id = $2 ORDER BY created_at DESC`,
    [entityType, entityId]);
  return rows;
}

export async function closeEvalDb(): Promise<void> {
  if (pool) { await pool.end(); pool = null; ready = false; }
}
