// Agent Group Chat (Swarm) routes.
//
// Manages multi-agent swarm groups: create/list/get/update/delete groups,
// manage seats (agent assignments), send messages, and trigger pipeline runs.
//
// Group ownership: only the creator (created_by) can modify group/seats.
// All routes require authentication via authMiddleware.

import { Hono } from 'hono';
import type { Variables } from '../web-context.js';
import { authMiddleware } from '../middleware/auth.js';
import { logger } from '../logger.js';
import { z } from 'zod';
import { randomUUID } from 'node:crypto';
import * as fs from 'node:fs';
import * as path from 'node:path';
import * as os from 'node:os';
import type { AuthUser } from '../types.js';
import {
  listSwarmGroups,
  getSwarmGroup,
  createSwarmGroup,
  updateSwarmGroup,
  deleteSwarmGroup,
  listGroupSeats,
  getGroupSeat,
  createGroupSeat,
  updateGroupSeat,
  deleteGroupSeat,
  createGroupMessage,
  listGroupMessages,
} from '../db.js';
import { DATA_DIR } from '../config.js';
import type { GroupSeatRow, GroupMessageRow } from '../db.js';

export const agentGroupRoutes = new Hono<{ Variables: Variables }>();

agentGroupRoutes.use('*', authMiddleware);

// ─── Zod Schemas ───────────────────────────────────────────────

const CreateGroupSchema = z.object({
  name: z.string().min(1).max(200),
  description: z.string().max(2000).optional(),
  floorPolicy: z.enum(['orchestrator_driven', 'round_robin', 'free']).optional(),
  seats: z.array(z.object({
    agentDefinitionId: z.string().min(1),
    agentVersion: z.string().optional(),
    rolePrompt: z.string().max(5000).optional(),
    speakPolicy: z.enum(['auto', 'mention_only', 'silent']).optional(),
    mounts: z.record(z.string(), z.unknown()).optional(),
    maxTurns: z.number().int().min(1).max(100).optional(),
    tokenBudget: z.number().int().min(1).optional(),
    timeBudgetMs: z.number().int().min(1000).optional(),
    maxParallel: z.number().int().min(1).max(10).optional(),
    seatOrder: z.number().int().min(0).optional(),
  })).min(1).max(20),
});

const UpdateGroupSchema = z.object({
  name: z.string().min(1).max(200).optional(),
  floorPolicy: z.enum(['orchestrator_driven', 'round_robin', 'free']).nullable().optional(),
});

const CreateSeatSchema = z.object({
  agentDefinitionId: z.string().min(1),
  agentVersion: z.string().optional(),
  rolePrompt: z.string().max(5000).optional(),
  speakPolicy: z.enum(['auto', 'mention_only', 'silent']).optional(),
  mounts: z.record(z.string(), z.unknown()).optional(),
  maxTurns: z.number().int().min(1).max(100).optional(),
  tokenBudget: z.number().int().min(1).optional(),
  timeBudgetMs: z.number().int().min(1000).optional(),
  maxParallel: z.number().int().min(1).max(10).optional(),
  seatOrder: z.number().int().min(0).optional(),
});

const UpdateSeatSchema = z.object({
  agentVersion: z.string().optional(),
  rolePrompt: z.string().max(5000).nullable().optional(),
  speakPolicy: z.enum(['auto', 'mention_only', 'silent']).optional(),
  mounts: z.record(z.string(), z.unknown()).nullable().optional(),
  maxTurns: z.number().int().min(1).max(100).optional(),
  tokenBudget: z.number().int().min(1).optional(),
  timeBudgetMs: z.number().int().min(1000).optional(),
  maxParallel: z.number().int().min(1).max(10).optional(),
  seatOrder: z.number().int().min(0).optional(),
});

const SendMessageSchema = z.object({
  text: z.string().max(10000).optional(),
  contentRef: z.string().max(10000).optional(),
  msgType: z.enum(['text', 'tool_card', 'handoff', 'pipeline_event', 'system']).optional(),
  mentions: z.array(z.object({
    seatId: z.number().int().min(1),
    agentName: z.string().optional(),
  })).max(50).optional(),
  parentMsgId: z.number().int().optional(),
});

// ─── Helpers ────────────────────────────────────────────────────

/** Check group ownership. Returns a non-null group on success. */
function checkOwnership(user: AuthUser, jid: string) {
  const group = getSwarmGroup(jid);
  return { group, owner: !!group && (group.created_by === user.id || user.role === 'admin') };
}

function seatToJson(s: GroupSeatRow) {
  let mounts: unknown;
  if (s.mounts) {
    try { mounts = JSON.parse(s.mounts); } catch { mounts = s.mounts; }
  }
  return {
    id: s.id,
    agentDefinitionId: s.agent_definition_id,
    agentVersion: s.agent_version,
    rolePrompt: s.role_prompt,
    speakPolicy: s.speak_policy,
    mounts,
    maxTurns: s.max_turns,
    tokenBudget: s.token_budget,
    timeBudgetMs: s.time_budget_ms,
    maxParallel: s.max_parallel,
    seatOrder: s.seat_order,
    createdAt: s.created_at,
  };
}

function msgToJson(m: GroupMessageRow) {
  let mentions: unknown;
  if (m.mentions) {
    try { mentions = JSON.parse(m.mentions); } catch { mentions = m.mentions; }
  }
  return {
    id: m.id,
    groupId: m.group_id,
    runId: m.run_id,
    nodeRunId: m.node_run_id,
    senderType: m.sender_type,
    senderSeatId: m.sender_seat_id,
    msgType: m.msg_type,
    contentRef: m.content_ref ?? undefined,
    mentions,
    parentMsgId: m.parent_msg_id,
    status: m.status,
    tokenIn: m.token_in,
    tokenOut: m.token_out,
    durationMs: m.duration_ms,
    createdAt: m.created_at,
  };
}

// ─── Routes: Group CRUD ────────────────────────────────────────

agentGroupRoutes.post('/', async (c) => {
  const authUser = c.get('user') as AuthUser;
  const body = await c.req.json().catch(() => null);
  const parsed = CreateGroupSchema.safeParse(body);
  if (!parsed.success) {
    return c.json({ error: 'Invalid body', detail: parsed.error.issues.map(i => `${i.path.join('.')}: ${i.message}`).join('; ') }, 400);
  }
  const { name, description, floorPolicy, seats } = parsed.data;
  const jid = `web:swarm:${randomUUID()}`;
  const folder = `swarm-${randomUUID().slice(0, 8)}`;
  try {
    createSwarmGroup({ jid, name: description ? `${name} - ${description}` : name, folder, created_by: authUser.id, groupKind: 'swarm', floorPolicy: floorPolicy ?? null });
    for (let i = 0; i < seats.length; i++) {
      const s = seats[i];
      createGroupSeat({ groupId: jid, agentDefinitionId: s.agentDefinitionId, agentVersion: s.agentVersion ?? 'latest', rolePrompt: s.rolePrompt ?? '', speakPolicy: s.speakPolicy ?? 'auto', mounts: s.mounts ? JSON.stringify(s.mounts) : '{}', maxTurns: s.maxTurns ?? 10, tokenBudget: s.tokenBudget ?? 100000, timeBudgetMs: s.timeBudgetMs ?? 600000, maxParallel: s.maxParallel ?? 1, seatOrder: s.seatOrder ?? i });
    }
    const group = getSwarmGroup(jid);
    return c.json({
      jid: jid,
      name: name,
      folder: folder,
      groupKind: 'swarm',
      floorPolicy: floorPolicy ?? 'orchestrator_driven',
      swarmStatus: 'active',
      orchestratorAgentId: null,
      graphDefinitionId: null,
      createdBy: authUser.id,
      createdAt: group?.added_at ?? new Date().toISOString(),
      seats: listGroupSeats(jid).map(seatToJson),
    }, 201);
  } catch (err: any) {
    return c.json({ error: `Failed to create group: ${err.message}` }, 500);
  }
});

agentGroupRoutes.get('/', (c) => {
  const authUser = c.get('user') as AuthUser;
  const groups = listSwarmGroups(authUser.id);
  return c.json({
    groups: groups.map(g => ({
      jid: g.jid, name: g.name, folder: g.folder,
      groupKind: g.groupKind ?? 'swarm',
      floorPolicy: g.floorPolicy ?? 'orchestrator_driven',
      swarmStatus: g.swarmStatus ?? 'active',
      seatCount: listGroupSeats(g.jid).length,
      createdAt: g.added_at,
    })),
  });
});

agentGroupRoutes.get('/:jid', (c) => {
  const authUser = c.get('user') as AuthUser;
  const jid = c.req.param('jid');
  const { group, owner } = checkOwnership(authUser, jid);
  if (!group) return c.json({ error: 'Group not found' }, 404);
  if (!owner) return c.json({ error: 'Forbidden' }, 403);
  return c.json({
    jid: group.jid, name: group.name, folder: group.folder,
    groupKind: group.groupKind ?? 'swarm',
    floorPolicy: group.floorPolicy ?? 'orchestrator_driven',
    swarmStatus: group.swarmStatus ?? 'active',
    orchestratorAgentId: group.orchestratorAgentId ?? null,
    graphDefinitionId: group.graphDefinitionId ?? null,
    createdBy: group.created_by,
    createdAt: group.added_at,
    seats: listGroupSeats(jid).map(seatToJson),
  });
});

agentGroupRoutes.patch('/:jid', async (c) => {
  const authUser = c.get('user') as AuthUser;
  const jid = c.req.param('jid');
  const { group, owner } = checkOwnership(authUser, jid);
  if (!group) return c.json({ error: 'Group not found' }, 404);
  if (!owner) return c.json({ error: 'Forbidden' }, 403);
  const body = await c.req.json().catch(() => null);
  const parsed = UpdateGroupSchema.safeParse(body);
  if (!parsed.success) return c.json({ error: 'Invalid body', detail: parsed.error.issues.map(i => i.message).join('; ') }, 400);
  updateSwarmGroup(jid, { name: parsed.data.name, floorPolicy: parsed.data.floorPolicy });
  const updated = getSwarmGroup(jid);
  if (!updated) return c.json({ error: 'Group not found' }, 404);
  return c.json({
    jid: updated.jid, name: updated.name, folder: updated.folder,
    groupKind: updated.groupKind ?? 'swarm',
    floorPolicy: updated.floorPolicy ?? 'orchestrator_driven',
    swarmStatus: updated.swarmStatus ?? 'active',
    orchestratorAgentId: updated.orchestratorAgentId ?? null,
    graphDefinitionId: updated.graphDefinitionId ?? null,
    createdBy: updated.created_by,
    createdAt: updated.added_at,
    seats: listGroupSeats(jid).map(seatToJson),
  });
});

agentGroupRoutes.delete('/:jid', (c) => {
  const authUser = c.get('user') as AuthUser;
  const jid = c.req.param('jid');
  const { group, owner } = checkOwnership(authUser, jid);
  if (!group) return c.json({ error: 'Group not found' }, 404);
  if (!owner) return c.json({ error: 'Forbidden' }, 403);
  deleteSwarmGroup(jid);
  return c.json({ ok: true });
});

// ─── Routes: Seats ─────────────────────────────────────────────

agentGroupRoutes.get('/:jid/seats', (c) => {
  const authUser = c.get('user') as AuthUser;
  const jid = c.req.param('jid');
  const { group, owner } = checkOwnership(authUser, jid);
  if (!group) return c.json({ error: 'Group not found' }, 404);
  if (!owner) return c.json({ error: 'Forbidden' }, 403);
  return c.json({ seats: listGroupSeats(jid).map(seatToJson) });
});

agentGroupRoutes.post('/:jid/seats', async (c) => {
  const authUser = c.get('user') as AuthUser;
  const jid = c.req.param('jid');
  const { group, owner } = checkOwnership(authUser, jid);
  if (!group) return c.json({ error: 'Group not found' }, 404);
  if (!owner) return c.json({ error: 'Forbidden' }, 403);
  const body = await c.req.json().catch(() => null);
  const parsed = CreateSeatSchema.safeParse(body);
  if (!parsed.success) return c.json({ error: 'Invalid body', detail: parsed.error.issues.map(i => i.message).join('; ') }, 400);
  const existingSeats = listGroupSeats(jid);
  const maxOrder = existingSeats.reduce((max, s) => Math.max(max, s.seat_order), -1);
  const seatOrder = parsed.data.seatOrder ?? (maxOrder + 1);
  try {
    const newSeat = createGroupSeat({
      groupId: jid,
      agentDefinitionId: parsed.data.agentDefinitionId,
      agentVersion: parsed.data.agentVersion ?? 'latest',
      rolePrompt: parsed.data.rolePrompt ?? '',
      speakPolicy: parsed.data.speakPolicy ?? 'auto',
      mounts: parsed.data.mounts ? JSON.stringify(parsed.data.mounts) : '{}',
      maxTurns: parsed.data.maxTurns ?? 10,
      tokenBudget: parsed.data.tokenBudget ?? 100000,
      timeBudgetMs: parsed.data.timeBudgetMs ?? 600000,
      maxParallel: parsed.data.maxParallel ?? 1,
      seatOrder,
    });
    return c.json(seatToJson(newSeat), 201);
  } catch (err: any) {
    return c.json({ error: `Failed to add seat: ${err.message}` }, 500);
  }
});

agentGroupRoutes.patch('/:jid/seats/:sid', async (c) => {
  const authUser = c.get('user') as AuthUser;
  const jid = c.req.param('jid');
  const sidParam = c.req.param('sid');
  const sid = parseInt(sidParam, 10);
  if (isNaN(sid)) return c.json({ error: 'Invalid seat id' }, 400);
  const { group, owner } = checkOwnership(authUser, jid);
  if (!group) return c.json({ error: 'Group not found' }, 404);
  if (!owner) return c.json({ error: 'Forbidden' }, 403);
  const seat = getGroupSeat(sid);
  if (!seat || seat.group_id !== jid) return c.json({ error: 'Seat not found' }, 404);
  const body = await c.req.json().catch(() => null);
  const parsed = UpdateSeatSchema.safeParse(body);
  if (!parsed.success) return c.json({ error: 'Invalid body', detail: parsed.error.issues.map(i => i.message).join('; ') }, 400);
  const p = parsed.data;
  const fields: Record<string, unknown> = {};
  if (p.agentVersion !== undefined) fields.agent_version = p.agentVersion;
  if (p.rolePrompt !== undefined) fields.role_prompt = p.rolePrompt;
  if (p.speakPolicy !== undefined) fields.speak_policy = p.speakPolicy;
  if (p.mounts !== undefined) fields.mounts = p.mounts !== null ? JSON.stringify(p.mounts) : '{}';
  if (p.maxTurns !== undefined) fields.max_turns = p.maxTurns;
  if (p.tokenBudget !== undefined) fields.token_budget = p.tokenBudget;
  if (p.timeBudgetMs !== undefined) fields.time_budget_ms = p.timeBudgetMs;
  if (p.maxParallel !== undefined) fields.max_parallel = p.maxParallel;
  if (p.seatOrder !== undefined) fields.seat_order = p.seatOrder;
  if (Object.keys(fields).length > 0) updateGroupSeat(sid, fields);
  const updatedSeat = getGroupSeat(sid);
  if (!updatedSeat) return c.json({ error: 'Seat not found after update' }, 404);
  return c.json(seatToJson(updatedSeat));
});

agentGroupRoutes.delete('/:jid/seats/:sid', (c) => {
  const authUser = c.get('user') as AuthUser;
  const jid = c.req.param('jid');
  const sidParam = c.req.param('sid');
  const sid = parseInt(sidParam, 10);
  if (isNaN(sid)) return c.json({ error: 'Invalid seat id' }, 400);
  const { group, owner } = checkOwnership(authUser, jid);
  if (!group) return c.json({ error: 'Group not found' }, 404);
  if (!owner) return c.json({ error: 'Forbidden' }, 403);
  const seat = getGroupSeat(sid);
  if (!seat || seat.group_id !== jid) return c.json({ error: 'Seat not found' }, 404);
  deleteGroupSeat(sid);
  return c.json({ ok: true });
});

// ─── Routes: Messages ──────────────────────────────────────────

agentGroupRoutes.post('/:jid/messages', async (c) => {
  const authUser = c.get('user') as AuthUser;
  const jid = c.req.param('jid');
  const { group, owner } = checkOwnership(authUser, jid);
  if (!group) return c.json({ error: 'Group not found' }, 404);
  if (!owner) return c.json({ error: 'Forbidden' }, 403);
  const body = await c.req.json().catch(() => null);
  const parsed = SendMessageSchema.safeParse(body);
  if (!parsed.success) return c.json({ error: 'Invalid body', detail: parsed.error.issues.map(i => i.message).join('; ') }, 400);
  const contentRef = parsed.data.contentRef ?? parsed.data.text ?? undefined;
  const msg = createGroupMessage({
    groupId: jid,
    senderType: 'user',
    msgType: parsed.data.msgType ?? 'text',
    contentRef,
    mentions: parsed.data.mentions ? JSON.stringify(parsed.data.mentions) : '[]',
    parentMsgId: parsed.data.parentMsgId,
  });
  return c.json(msgToJson(msg), 201);
});

agentGroupRoutes.get('/:jid/messages', (c) => {
  const authUser = c.get('user') as AuthUser;
  const jid = c.req.param('jid');
  const { group, owner } = checkOwnership(authUser, jid);
  if (!group) return c.json({ error: 'Group not found' }, 404);
  if (!owner) return c.json({ error: 'Forbidden' }, 403);
  const beforeParam = c.req.query('before');
  const before = beforeParam ? parseInt(beforeParam, 10) : undefined;
  const limit = Math.min(parseInt(c.req.query('limit') ?? '50', 10) || 50, 200);
  const messages = listGroupMessages(jid, before, limit);
  return c.json({
    messages: messages.map(msgToJson),
    hasMore: messages.length === limit,
  });
});

// ─── Helpers: Agent Execution ───────────────────────────────────

/** Load agent definition content from the file-based agent-definitions store. */
function loadSwarmAgentDefContent(agentDefId: string): string {
  const agentsDir = path.join(os.homedir(), '.claude', 'agents');
  try {
    return fs.readFileSync(path.join(agentsDir, `${agentDefId}.md`), 'utf-8');
  } catch {
    // Fallback: some deployments store agents under DATA_DIR
    try {
      return fs.readFileSync(path.join(DATA_DIR, 'agents', `${agentDefId}.md`), 'utf-8');
    } catch {
      return '';
    }
  }
}

/** Create a pipeline node record for tracking agent execution progress. */
async function createPipelineNode(
  runId: string,
  nodeType: string,
  title: string,
  status: string,
  groupFolder: string,
  detail?: Record<string, unknown>,
): Promise<string | null> {
  try {
    const { getDb } = await import('../db.js');
    const db = getDb();
    const nodeId = `node-${randomUUID().slice(0, 8)}`;
    const now = new Date().toISOString();
    // PG schema: id, graph_run_id, node_id, node_type, status, attempt, input_summary, output_summary,
    // state_patch_json, parent_node_run_id, started_at, ended_at, input_tokens, output_tokens,
    // cost_usd, error, is_idempotent
    db.prepare(
      `INSERT INTO graph_node_runs (id, graph_run_id, node_id, node_type, status, attempt, input_summary, started_at, is_idempotent)
       VALUES (?, ?, ?, ?, ?, 0, ?, ?, 0)`,
    ).run(nodeId, runId, nodeType, nodeType, status, detail ? JSON.stringify(detail) : null, now);
    return nodeId;
  } catch (e) {
    console.error('[createPipelineNode] INSERT failed:', (e as Error)?.message || e, 'runId:', runId);
    return null;
  }
}

/** Update pipeline node status. */
async function updatePipelineNode(
  nodeId: string,
  status: string,
  detail?: Record<string, unknown>,
): Promise<void> {
  try {
    const { getDb } = await import('../db.js');
    const db = getDb();
    const updates: string[] = ['status = ?', 'ended_at = ?'];
    const values: unknown[] = [status, new Date().toISOString()];
    if (detail) { updates.push('output_summary = ?'); values.push(JSON.stringify(detail)); }
    db.prepare(`UPDATE graph_node_runs SET ${updates.join(', ')} WHERE id = ?`)
      .run(...values, nodeId);
  } catch (e) { console.error('[updatePipelineNode] UPDATE failed:', (e as Error)?.message || e); }
}

// ─── Routes: Pipeline Runs ─────────────────────────────────────

const RunSchema = z.object({
  prompt: z.string().max(50000).optional(),
  seatId: z.number().int().optional(),
});

agentGroupRoutes.post('/:jid/runs', async (c) => {
  const authUser = c.get('user') as AuthUser;
  const jid = c.req.param('jid');
  const { group, owner } = checkOwnership(authUser, jid);
  if (!group) return c.json({ error: 'Group not found' }, 404);
  if (!owner) return c.json({ error: 'Forbidden' }, 403);

  const body = await c.req.json().catch(() => ({}));
  const parsed = RunSchema.safeParse(body);
  const userPrompt = parsed.success ? (parsed.data.prompt || '') : '';

  const runId = `run-${randomUUID()}`;
  const now = new Date().toISOString();

  // Create run record
  try {
    const { getDb } = await import('../db.js');
    const db = getDb();
    // PG schema: id, definition_id, definition_version, owner_user_id, group_folder, chat_jid,
    // goal_text, status, current_node_id, state_json, max_parallel, started_at, ended_at, ...
    db.prepare(
      'INSERT INTO graph_runs (id, definition_id, definition_version, owner_user_id, group_folder, chat_jid, goal_text, status, state_json, max_parallel, started_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)',
    ).run(runId, 'swarm-pipeline', 1, authUser.id, group.folder, jid,
      userPrompt || `Swarm group run for ${group.name}`, 'running', '{}', 4, now);
  } catch (e) { console.error('[runSwarmPipeline] INSERT graph_runs failed:', (e as Error)?.message || e, 'runId:', runId); }

  // Find target seats to execute
  const allSeats = listGroupSeats(jid);
  const targetSeats = parsed.success && parsed.data.seatId
    ? allSeats.filter(s => s.id === parsed.data.seatId)
    : allSeats.filter(s => s.speak_policy === 'auto');

  if (targetSeats.length === 0) {
    return c.json({
      runId, groupJid: jid, status: 'running',
      warning: 'No seats found matching the execution criteria',
      nodes: [],
    }, 201);
  }

  // Execute the first matching seat (MVP: single-seat run)
  const seat = targetSeats[0];
  const agentContent = loadSwarmAgentDefContent(seat.agent_definition_id);
  const systemPrompt = agentContent
    ? `${agentContent}\n\n## Role\n${seat.role_prompt || 'You are an AI assistant in a swarm group.'}`
    : (seat.role_prompt || 'You are an AI assistant in a swarm group.');

  // Build workspace dirs for the swarm group
  const workspaceGlobal = path.join(DATA_DIR, 'groups', group.folder, 'workspace');
  const workspaceMemory = path.join(DATA_DIR, 'memory', group.folder);
  fs.mkdirSync(workspaceGlobal, { recursive: true });
  fs.mkdirSync(workspaceMemory, { recursive: true });

  const prompt = userPrompt || `You are agent "${seat.agent_definition_id}" in swarm group "${group.name}". Respond to the latest discussion or provide your analysis.`;

  const taskInput = {
    prompt,
    sessionId: `swarm-${group.folder}-${seat.id}-${runId.slice(-8)}`,
    turnId: runId,
    groupFolder: group.folder,
    chatJid: jid,
    isMain: false,
    isHome: false,
    isAdminHome: false,
    workspaceGlobal,
    workspaceMemory,
    agentDefinition: {
      id: seat.agent_definition_id,
      systemPrompt,
      mounts: [] as Array<{ resourceType: string; resourceId: string; resourceName?: string; kbId?: string }>,
    },
    engine: 'claude',
  };

  // Create pipeline node for this seat's execution
  const nodeId = await createPipelineNode(
    runId, 'agent', `Agent: ${seat.agent_definition_id}`,
    'running', group.folder,
    { seatId: seat.id, agentDefId: seat.agent_definition_id, speakPolicy: seat.speak_policy },
  );

  // Subscribe to agent output BEFORE publishing the task
  let agentResponse = '';
  let streamEvents = 0;

  const { subscribeIpcOutput, publishAgentTask } = await import('../redis-bus.js');
  const unsub = await subscribeIpcOutput(group.folder, 'messages', async (payload: any) => {
    // Agent-runner wraps output in { type: "agent_output", output: { status, ... } }
    const msg = payload?.output || payload;
    if (!msg || msg.status === 'not_agent_output') return;

    if (msg.status === 'stream') {
      streamEvents++;
      // Accumulate text from text_delta or message events
      if (msg.streamEvent?.eventType === 'text_delta' || msg.streamEvent?.eventType === 'message') {
        const delta = msg.streamEvent?.delta || msg.streamEvent?.text || '';
        agentResponse += delta;
      }
    }

    if (msg.status === 'closed' || msg.status === 'success' || msg.status === 'error') {
      const finalContent = msg.result || agentResponse || msg.error || '(Agent execution completed)';

      // Store agent response as group message
      try {
        createGroupMessage({
          groupId: jid,
          runId,
          nodeRunId: nodeId ?? undefined,
          senderType: 'agent',
          senderSeatId: seat.id,
          msgType: 'text',
          contentRef: typeof finalContent === 'string'
            ? finalContent.slice(0, 10000)
            : JSON.stringify(finalContent).slice(0, 10000),
          status: msg.status === 'error' ? 'failed' : 'completed',
        });
      } catch (err) {
        // best-effort: message storage shouldn't block the run
        console.error('[runSwarmPipeline] createGroupMessage failed:', (err as Error)?.message || err);
      }

      // Update pipeline node
      const isError = msg.status === 'error';
      await updatePipelineNode(nodeId ?? '', isError ? 'failed' : 'completed', {
        outputLength: typeof finalContent === 'string' ? finalContent.length : 0,
        streamEvents,
        error: isError ? (msg.error || 'Unknown error') : undefined,
      });

      // Update run status
      try {
        const { getDb } = await import('../db.js');
        const db = getDb();
        db.prepare('UPDATE graph_runs SET status = ?, ended_at = ? WHERE id = ?')
          .run(isError ? 'failed' : 'completed', new Date().toISOString(), runId);
      } catch (e) { console.error('[runSwarmPipeline] UPDATE graph_runs status failed:', (e as Error)?.message || e); }

      // Unsubscribe after completion
      try { unsub(); } catch { /* ignore */ }
    }
  });

  // Publish the agent task to Redis
  let published = false;
  try {
    published = await publishAgentTask(taskInput);
  } catch (err) {
    // publishAgentTask may fail if Redis is not connected
  }

  return c.json({
    runId,
    groupJid: jid,
    status: published ? 'running' : 'queued',
    executedSeat: { id: seat.id, agentDefinitionId: seat.agent_definition_id, speakPolicy: seat.speak_policy },
    nodeId,
    prompt: prompt.slice(0, 200),
  }, 201);
});

agentGroupRoutes.get('/runs/:id/nodes', async (c) => {
  const runId = c.req.param('id');
  try {
    const { getDb } = await import('../db.js');
    const db = getDb();
    const nodes = db.prepare('SELECT * FROM graph_node_runs WHERE graph_run_id = ? ORDER BY started_at ASC').all(runId);
    return c.json({ runId, nodes });
  } catch { return c.json({ runId, nodes: [] }); }
});

agentGroupRoutes.get('/node-runs/:id', async (c) => {
  const nodeId = c.req.param('id');
  try {
    const { getDb } = await import('../db.js');
    const db = getDb();
    const node = db.prepare('SELECT * FROM graph_node_runs WHERE id = ?').get(nodeId);
    if (!node) return c.json({ error: 'Node run not found' }, 404);
    return c.json({ nodeRun: node });
  } catch { return c.json({ error: 'Node run not found' }, 404); }
});

agentGroupRoutes.get('/node-runs/:id/trace', async (c) => {
  const nodeId = c.req.param('id');
  try {
    const { getDb } = await import('../db.js');
    const db = getDb();
    // Get the node run to access its graph_run_id;
    // loop_trace_nodes may be linked via extra_ref col (sqlite) or absent (pg).
    const node = db.prepare('SELECT * FROM graph_node_runs WHERE id = ?').get(nodeId) as any;
    const graphRunId: string | undefined = node?.graph_run_id;

    // trace_tool_calls links via graph_node_id (= graph_node_runs.id)
    const toolCalls = db.prepare(
      'SELECT * FROM trace_tool_calls WHERE graph_node_id = ? ORDER BY started_at ASC',
    ).all(nodeId);

    // loop_trace_nodes: prefer extra_ref (sqlite col), fallback to loop_run_id
    let traceNodes: unknown[] = [];
    try {
      traceNodes = db
        .prepare('SELECT * FROM loop_trace_nodes WHERE extra_ref = ? ORDER BY started_at ASC')
        .all(nodeId);
    } catch {
      if (graphRunId) {
        try {
          traceNodes = db
            .prepare('SELECT * FROM loop_trace_nodes WHERE loop_run_id = ? ORDER BY started_at ASC')
            .all(graphRunId);
        } catch { /* empty – loop_trace_nodes table may not be available */ }
      }
    }

    return c.json({ node, traceNodes, toolCalls });
  } catch (err) {
    logger.warn({ err }, 'Failed to get node trace');
    return c.json({ traceNodes: [], toolCalls: [] });
  }
});

export default agentGroupRoutes;
