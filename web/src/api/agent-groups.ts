/**
 * Agent Group Chat API client — swarm group management, seats, messages, and pipeline runs.
 * Types match actual backend JSON response shapes from src/routes/agent-groups.ts
 */
import { apiFetch } from './client';

const BASE = '/api/agent-groups';

// ── Types (matching backend seatToJson / msgToJson / response shapes) ──

export interface GroupSeat {
  id: number;
  agentDefinitionId: string;
  agentVersion: string;
  rolePrompt: string | null;
  speakPolicy: string;
  mounts: Record<string, unknown> | null;
  maxTurns: number;
  tokenBudget: number;
  timeBudgetMs: number;
  maxParallel: number;
  seatOrder: number;
  createdAt: string;
}

export interface GroupMessage {
  id: number;
  groupId: string;
  runId: string | null;
  nodeRunId: string | null;
  senderType: string;
  senderSeatId: number | null;
  msgType: string;
  contentRef?: string;
  mentions: unknown;
  parentMsgId: number | null;
  status: string;
  tokenIn: number;
  tokenOut: number;
  durationMs: number;
  createdAt: string;
}

/** Shape returned by GET /api/agent-groups (list) */
export interface AgentGroup {
  jid: string;
  name: string;
  description?: string;
  folder?: string;
  groupKind?: string;
  floorPolicy?: string;
  swarmStatus?: string;
  seatCount?: number;
  createdAt?: string;
}

/** Shape returned by GET /api/agent-groups/:jid (detail) and POST (create) */
export interface AgentGroupDetail {
  jid: string;
  name: string;
  folder: string;
  groupKind: string;
  floorPolicy: string;
  swarmStatus: string;
  orchestratorAgentId?: string | null;
  graphDefinitionId?: string | null;
  createdBy?: string | null;
  createdAt: string;
  seats: GroupSeat[];
}

export interface CreateGroupPayload {
  name: string;
  description?: string;
  floorPolicy?: string;
  seats: CreateSeatPayload[];
}

export interface CreateSeatPayload {
  agentDefinitionId: string;
  agentVersion?: string;
  rolePrompt?: string;
  speakPolicy?: 'auto' | 'mention_only' | 'silent';
  mounts?: Record<string, unknown>;
  maxTurns?: number;
  tokenBudget?: number;
  timeBudgetMs?: number;
  maxParallel?: number;
  seatOrder?: number;
}

export interface UpdateGroupPayload {
  name?: string;
  floorPolicy?: string | null;
}

export interface UpdateSeatPayload {
  agentVersion?: string;
  rolePrompt?: string | null;
  speakPolicy?: 'auto' | 'mention_only' | 'silent';
  mounts?: Record<string, unknown> | null;
  maxTurns?: number;
  tokenBudget?: number;
  timeBudgetMs?: number;
  maxParallel?: number;
  seatOrder?: number;
}

export interface SendMessagePayload {
  text?: string;
  contentRef?: string;
  msgType?: string;
  mentions?: { seatId: number; agentName?: string }[];
  parentMsgId?: number;
}

export interface PipelineRun {
  id: string;
  groupJid?: string;
  status: 'pending' | 'running' | 'completed' | 'failed' | 'cancelled';
  nodes?: PipelineNode[];
}

export interface PipelineNode {
  id: string;
  status: 'pending' | 'running' | 'completed' | 'failed';
  title?: string;
  nodeType?: string;
}

export interface TraceDetail {
  node: PipelineNode;
  events: TraceEvent[];
}

export interface TraceEvent {
  id: string;
  eventType: string;
  content: string;
  createdAt: string;
}

// ── API Functions ─────────────────────────────────────────────────

export function listAgentGroups(): Promise<{ groups: AgentGroup[] }> {
  return apiFetch<{ groups: AgentGroup[] }>(`${BASE}`);
}

/** Returns the full group detail shape (includes seats inline). */
export function getAgentGroup(jid: string): Promise<AgentGroupDetail> {
  return apiFetch<AgentGroupDetail>(`${BASE}/${jid}`);
}

export function createAgentGroup(data: CreateGroupPayload): Promise<AgentGroupDetail> {
  return apiFetch<AgentGroupDetail>(`${BASE}`, {
    method: 'POST',
    body: JSON.stringify(data),
  });
}

export function updateAgentGroup(jid: string, data: UpdateGroupPayload): Promise<AgentGroupDetail> {
  return apiFetch<AgentGroupDetail>(`${BASE}/${jid}`, {
    method: 'PATCH',
    body: JSON.stringify(data),
  });
}

export function deleteAgentGroup(jid: string): Promise<{ ok: boolean }> {
  return apiFetch<{ ok: boolean }>(`${BASE}/${jid}`, { method: 'DELETE' });
}

export function addGroupSeat(jid: string, data: CreateSeatPayload): Promise<GroupSeat> {
  return apiFetch<GroupSeat>(`${BASE}/${jid}/seats`, {
    method: 'POST',
    body: JSON.stringify(data),
  });
}

export function updateGroupSeat(jid: string, seatId: number, data: UpdateSeatPayload): Promise<GroupSeat> {
  return apiFetch<GroupSeat>(`${BASE}/${jid}/seats/${seatId}`, {
    method: 'PATCH',
    body: JSON.stringify(data),
  });
}

export function deleteGroupSeat(jid: string, seatId: number): Promise<{ ok: boolean }> {
  return apiFetch<{ ok: boolean }>(`${BASE}/${jid}/seats/${seatId}`, { method: 'DELETE' });
}

/** Backend returns the message object directly (msgToJson shape). */
export function sendGroupMessage(jid: string, data: SendMessagePayload): Promise<GroupMessage> {
  return apiFetch<GroupMessage>(`${BASE}/${jid}/messages`, {
    method: 'POST',
    body: JSON.stringify(data),
  });
}

export function listGroupMessages(
  jid: string,
  before?: string,
  limit?: number,
): Promise<{ messages: GroupMessage[]; hasMore: boolean }> {
  const params = new URLSearchParams();
  if (before) params.set('before', before);
  if (limit) params.set('limit', String(limit));
  const qs = params.toString();
  return apiFetch<{ messages: GroupMessage[]; hasMore: boolean }>(
    `${BASE}/${jid}/messages${qs ? `?${qs}` : ''}`,
  );
}

export function startGroupRun(jid: string): Promise<{ run: PipelineRun }> {
  return apiFetch<{ run: PipelineRun }>(`${BASE}/${jid}/runs`, { method: 'POST' });
}

export function getRunNodes(runId: string): Promise<{ run: PipelineRun; nodes: PipelineNode[] }> {
  return apiFetch<{ run: PipelineRun; nodes: PipelineNode[] }>(`${BASE}/runs/${runId}/nodes`);
}

export function getNodeRunDetail(nodeRunId: string): Promise<{ node: PipelineNode }> {
  return apiFetch<{ node: PipelineNode }>(`${BASE}/nodes/${nodeRunId}`);
}

export function getNodeTrace(nodeRunId: string): Promise<TraceDetail> {
  return apiFetch<TraceDetail>(`${BASE}/nodes/${nodeRunId}/trace`);
}