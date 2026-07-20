import { apiFetch } from './client';

export type SupervisorStrategy = 'periodic' | 'on_iteration' | 'hybrid';
export type SupervisorSessionStatus =
  | 'active'
  | 'paused'
  | 'completed'
  | 'failed'
  | 'aborted';
export type SupervisorAction =
  | 'continue'
  | 'redirect'
  | 'escalate'
  | 'complete'
  | 'abort'
  | 'error';

export interface SupervisorEvidence {
  type: 'message' | 'test' | 'file' | 'loop_status';
  ref: string;
  detail?: string;
}

export interface SupervisorSession {
  id: string;
  group_folder: string;
  chat_jid: string;
  owner_user_id: string | null;
  goal_text: string;
  success_criteria: string;
  strategy: SupervisorStrategy;
  period_ms: number;
  max_checks: number;
  bound_loop_run_id: string | null;
  status: SupervisorSessionStatus;
  consecutive_errors: number;
  current_checks: number;
  last_check_at: string | null;
  next_check_at: string | null;
  last_bound_turn: number;
  started_at: string;
  ended_at: string | null;
  config_json: string | null;
  created_at: string;
  created_by: string | null;
}

export interface SupervisorDecision {
  id: string;
  session_id: string;
  turn_index: number;
  action: SupervisorAction;
  conclusion: string | null;
  evidence_json: string | null;
  next_action_hint: string | null;
  confidence: number | null;
  trace_summary: string | null;
  triggered_by: string;
  status: 'running' | 'completed' | 'error';
  started_at: string;
  ended_at: string | null;
  error: string | null;
}

export interface CreateSupervisorInput {
  group_folder: string;
  chat_jid: string;
  goal_text: string;
  success_criteria: string;
  strategy?: SupervisorStrategy;
  period_ms?: number;
  max_checks?: number;
  bound_loop_run_id?: string | null;
}

export async function listSupervisors(
  params: { status?: string; chat_jid?: string } = {},
): Promise<SupervisorSession[]> {
  const qs = new URLSearchParams();
  if (params.status) qs.set('status', params.status);
  if (params.chat_jid) qs.set('chat_jid', params.chat_jid);
  const q = qs.toString();
  const data = await apiFetch<{ sessions: SupervisorSession[] }>(
    `/api/supervisor${q ? `?${q}` : ''}`,
  );
  return data.sessions ?? [];
}

export async function createSupervisor(
  input: CreateSupervisorInput,
): Promise<SupervisorSession> {
  const data = await apiFetch<{ session: SupervisorSession }>(`/api/supervisor`, {
    method: 'POST',
    body: JSON.stringify(input),
  });
  return data.session;
}

export async function getSupervisor(
  id: string,
): Promise<{ session: SupervisorSession; decisions: SupervisorDecision[] }> {
  return apiFetch(`/api/supervisor/${id}`);
}

export async function patchSupervisor(
  id: string,
  patch: Partial<CreateSupervisorInput & { enabled: boolean }>,
): Promise<SupervisorSession> {
  const data = await apiFetch<{ session: SupervisorSession }>(`/api/supervisor/${id}`, {
    method: 'PATCH',
    body: JSON.stringify(patch),
  });
  return data.session;
}

export async function deleteSupervisor(
  id: string,
  opts: { force?: boolean } = {},
): Promise<void> {
  const q = opts.force ? '?force=true' : '';
  await apiFetch(`/api/supervisor/${id}${q}`, { method: 'DELETE' });
}

export async function triggerSupervisorCheck(
  id: string,
): Promise<{ ok: boolean; decision?: SupervisorDecision; fedBack?: boolean; reason?: string }> {
  return apiFetch(`/api/supervisor/${id}/check`, { method: 'POST' });
}

export async function listSupervisorDecisions(
  id: string,
  opts: { limit?: number; offset?: number } = {},
): Promise<SupervisorDecision[]> {
  const qs = new URLSearchParams();
  if (opts.limit != null) qs.set('limit', String(opts.limit));
  if (opts.offset != null) qs.set('offset', String(opts.offset));
  const q = qs.toString();
  const data = await apiFetch<{ decisions: SupervisorDecision[] }>(
    `/api/supervisor/${id}/decisions${q ? `?${q}` : ''}`,
  );
  return data.decisions ?? [];
}
