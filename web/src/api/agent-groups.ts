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

/** Skills / MCP servers / knowledge bases mounted for one message. */
export interface SelectedMounts {
  skills?: string[];
  mcpServers?: string[];
  kbIds?: string[];
}

export interface SendMessagePayload {
  text?: string;
  contentRef?: string;
  msgType?: string;
  mentions?: { seatId: number; agentName?: string }[];
  parentMsgId?: number;
  /** Applied to every seat of the run this message triggers. */
  selectedMounts?: SelectedMounts;
}

/** A user message row, plus the swarm run it started (if any). */
export interface SendMessageResult extends GroupMessage {
  graphRunId?: string;
  runError?: string;
}

export interface PipelineRun {
  id: string;
  runId?: string;
  groupJid?: string;
  status: 'pending' | 'running' | 'completed' | 'failed' | 'cancelled';
  executedSeat?: { id: string | number; agentDefinitionId: string; speakPolicy: string };
  nodeId?: string;
  nodes?: PipelineNode[];
  nodesLoading?: boolean;
}

/** Backend returns snake_case from graph_node_runs table. */
export interface PipelineNode {
  id: string;
  graph_run_id?: string;
  node_id?: string;
  node_type?: string;
  status: 'pending' | 'running' | 'success' | 'completed' | 'failed' | 'skipped' | 'cancelled';
  title?: string;
  nodeType?: string;
  attempt?: string | number;
  input_summary?: string;
  output_summary?: string;
  started_at?: string;
  ended_at?: string;
  input_tokens?: string | number;
  output_tokens?: string | number;
  cost_usd?: number;
  error?: string | null;
}

export interface TraceDetail {
  node?: PipelineNode;
  traceNodes: TraceNode[];
  toolCalls: TraceToolCall[];
}

export interface TraceNode {
  id: number;
  loop_run_id: string;
  iteration_id: number | null;
  node_type: string;
  parent_node_id: number | null;
  tool_name: string | null;
  tool_use_id: string | null;
  title: string | null;
  input_summary: string | null;
  output_summary: string | null;
  started_at: string;
  ended_at: string | null;
  tokens: number;
  status: string | null;
}

export interface TraceToolCall {
  id: number;
  graph_run_id: string | null;
  graph_node_id: string | null;
  chat_jid: string | null;
  tool_use_id: string;
  tool_name: string;
  input_json: string | null;
  output_json: string | null;
  status: string | null;
  started_at: string;
  ended_at: string | null;
  output_ref: string | null;
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

/** Backend returns the message object directly (msgToJson shape) + graphRunId. */
export function sendGroupMessage(jid: string, data: SendMessagePayload): Promise<SendMessageResult> {
  return apiFetch<SendMessageResult>(`${BASE}/${jid}/messages`, {
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

/** Backend returns flat {runId, groupJid, status, executedSeat, nodeId, prompt}. */
export function startGroupRun(jid: string): Promise<PipelineRun> {
  return apiFetch<PipelineRun>(`${BASE}/${jid}/runs`, { method: 'POST' });
}

/** Backend returns {runId, nodes: PipelineNode[]}. */
export function getRunNodes(runId: string): Promise<{ runId: string; nodes: PipelineNode[] }> {
  return apiFetch<{ runId: string; nodes: PipelineNode[] }>(`${BASE}/runs/${runId}/nodes`);
}

export function getNodeRunDetail(nodeRunId: string): Promise<{ nodeRun: PipelineNode }> {
  return apiFetch<{ nodeRun: PipelineNode }>(`${BASE}/node-runs/${nodeRunId}`);
}

export function getNodeTrace(nodeRunId: string): Promise<TraceDetail> {
  return apiFetch<TraceDetail>(`${BASE}/node-runs/${nodeRunId}/trace`);
}