// DeepThink Eval Center — API client
import { apiFetch } from './client';

const BASE = '/api/eval-center';

export interface EvalProject { id: string; name: string; description: string | null; owner_id: string; created_at: string; updated_at: string; }
export interface EvalDataset { id: string; project_id: string; name: string; description: string | null; dataset_type: string; latest_version: number; is_archived: boolean; created_at: string; }
export interface EvalVersion { id: string; dataset_id: string; version: number; version_label: string | null; content_hash: string; status: string; case_count: number; change_log: string | null; published_at: string | null; created_at: string; }
export interface EvalCase { id: string; dataset_version_id: string; external_id: string | null; input_text: string; expected_output: string | null; category: string | null; difficulty: string | null; tags: string[] | null; is_golden: boolean; status: string; created_at: string; }
export interface EvalRubric { id: string; project_id: string; name: string; description: string | null; latest_version: number; created_at: string; }
export interface EvalRubricVersion { id: string; rubric_id: string; version: number; version_label: string | null; dimensions: any[]; judge_model: string | null; pass_threshold: string; status: string; published_at: string | null; created_at: string; }
export interface EvalRun { id: string; project_id: string; dataset_version_id: string; rubric_version_id: string; agent_id: string; agent_version: string | null; llm_model: string; status: string; overall_score: number | null; pass_rate: number | null; total_cases: number; completed_cases: number; passed_cases: number; config_snapshot: any; started_at: string | null; completed_at: string | null; created_at: string; }
export interface EvalResult { id: string; run_id: string; test_case_id: string; status: string; agent_output: string | null; agent_latency_ms: number | null; token_usage: any; dimension_scores: Record<string, any> | null; overall_score: number | null; is_pass: boolean | null; assertion_results: any[] | null; judge_reasoning: string | null; error_message: string | null; }
export interface TraceData { trace: { id: string; span_count: number; total_tokens: number; total_latency_ms: number; input_summary: string | null; output_summary: string | null; }; spans: any[]; }
export interface DriftReport { id: string; dataset_version_id: string; signal_type: string; drift_score: number; is_drifted: boolean; detail: any; created_at: string; }

// Projects
export const listProjects = () => apiFetch<EvalProject[]>(`${BASE}/projects`);
export const createProject = (name: string, description?: string) =>
  apiFetch<EvalProject>(`${BASE}/projects`, { method: 'POST', body: JSON.stringify({ name, description }) });
export const getProject = (id: string) => apiFetch<EvalProject>(`${BASE}/projects/${id}`);

// Datasets
export const listDatasets = (projectId: string) => apiFetch<EvalDataset[]>(`${BASE}/datasets?project_id=${projectId}`);
export const createDataset = (projectId: string, name: string, description?: string) =>
  apiFetch<EvalDataset>(`${BASE}/datasets`, { method: 'POST', body: JSON.stringify({ project_id: projectId, name, description }) });

// Versions
export const listVersions = (datasetId: string) => apiFetch<EvalVersion[]>(`${BASE}/datasets/${datasetId}/versions`);
export const createVersion = (datasetId: string, versionLabel: string, notes?: string) =>
  apiFetch<EvalVersion>(`${BASE}/datasets/${datasetId}/versions`, { method: 'POST', body: JSON.stringify({ version_label: versionLabel, notes }) });
export const publishVersion = (datasetId: string, versionId: string, changeLog?: string) =>
  apiFetch<EvalVersion>(`${BASE}/datasets/${datasetId}/versions/${versionId}/publish`, { method: 'POST', body: JSON.stringify({ change_log: changeLog }) });
export const rollbackVersion = (datasetId: string, version: number) =>
  apiFetch<{ ok: boolean }>(`${BASE}/datasets/${datasetId}/rollback/${version}`, { method: 'POST' });
export const cloneVersion = (versionId: string, targetProjectId: string, name: string, cloneType = 'full', caseFilter?: any) =>
  apiFetch<{ dataset: EvalDataset; version: EvalVersion }>(`${BASE}/datasets/${versionId}/clone`, { method: 'POST', body: JSON.stringify({ target_project_id: targetProjectId, name, clone_type: cloneType, case_filter: caseFilter }) });

// Test cases
export const listCases = (versionId: string) => apiFetch<EvalCase[]>(`${BASE}/test-cases?dataset_version_id=${versionId}`);
export const createCase = (versionId: string, data: Partial<EvalCase>) =>
  apiFetch<EvalCase>(`${BASE}/test-cases`, { method: 'POST', body: JSON.stringify({ dataset_version_id: versionId, ...data }) });
export const updateCase = (id: string, data: Partial<EvalCase>) =>
  apiFetch<EvalCase>(`${BASE}/test-cases/${id}`, { method: 'PUT', body: JSON.stringify(data) });
export const deleteCase = (id: string) => apiFetch<{ ok: boolean }>(`${BASE}/test-cases/${id}`, { method: 'DELETE' });
export const promoteGolden = (caseId: string) => apiFetch<EvalCase>(`${BASE}/golden/${caseId}/promote`, { method: 'POST' });

// Rubrics
export const listRubrics = (projectId: string) => apiFetch<EvalRubric[]>(`${BASE}/rubrics?project_id=${projectId}`);
export const createRubric = (projectId: string, name: string) =>
  apiFetch<EvalRubric>(`${BASE}/rubrics`, { method: 'POST', body: JSON.stringify({ project_id: projectId, name }) });
export const listRubricVersions = (rubricId: string) => apiFetch<EvalRubricVersion[]>(`${BASE}/rubrics/${rubricId}/versions`);
export const createRubricVersion = (rubricId: string, data: { version_label: string; dimensions: any[]; judge_model?: string; pass_threshold?: string }) =>
  apiFetch<EvalRubricVersion>(`${BASE}/rubrics/${rubricId}/versions`, { method: 'POST', body: JSON.stringify(data) });

// Runs
export const listRuns = (projectId: string) => apiFetch<EvalRun[]>(`${BASE}/eval-runs?project_id=${projectId}`);
export const createRun = (data: { project_id: string; dataset_version_id: string; rubric_version_id: string; agent_id: string; llm_model: string; max_turns?: number; judge_model?: string }) =>
  apiFetch<EvalRun>(`${BASE}/eval-runs`, { method: 'POST', body: JSON.stringify(data), timeoutMs: 300_000 });
export const getRun = (id: string) => apiFetch<EvalRun>(`${BASE}/eval-runs/${id}`);
export const listResults = (runId: string) => apiFetch<EvalResult[]>(`${BASE}/eval-runs/${runId}/results`);
export const getTrace = (runId: string, resultId: string) => apiFetch<TraceData>(`${BASE}/eval-runs/${runId}/traces/${resultId}`);
export const compareRuns = (ids: string[]) => apiFetch<{ runs: any[]; win_loss_tie?: any }>(`${BASE}/eval-runs/compare?ids=${ids.join(',')}`);

// Drift
export const detectDrift = (versionId: string, baselineVersionId: string) =>
  apiFetch<any>(`${BASE}/drift/detect`, { method: 'POST', body: JSON.stringify({ dataset_version_id: versionId, baseline_version_id: baselineVersionId }), timeoutMs: 120_000 });
export const listDriftReports = (versionId: string) => apiFetch<DriftReport[]>(`${BASE}/drift/reports?dataset_version_id=${versionId}`);

// Publish logs
export const getPublishLogs = (entityType: string, entityId: string) =>
  apiFetch<any[]>(`${BASE}/publish-logs?entity_type=${entityType}&entity_id=${entityId}`);

// Agents (reuse existing endpoint)
export async function listAgents(): Promise<{ agents: { id: string; name: string }[] }> {
  return apiFetch('/api/paas/agents');
}
