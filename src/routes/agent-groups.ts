// Agent Group Chat (Swarm) routes.
//
// Manages multi-agent swarm groups: create/list/get/update/delete groups,
// manage seats (agent assignments), send messages, and trigger pipeline runs.
//
// A user message starts a graph run over the group's seats — see
// src/agent-group/swarm-definition.ts for how seats become a graph definition.
//
// Group ownership: only the creator (created_by) can modify group/seats.
// All routes require authentication via authMiddleware.

import { Hono } from 'hono';
import { getWebDeps, type SelectedMounts, type Variables } from '../web-context.js';
import { authMiddleware } from '../middleware/auth.js';
import { logger } from '../logger.js';
import { z } from 'zod';
import { randomUUID } from 'node:crypto';
import type { AuthUser, RegisteredGroup } from '../types.js';
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
  getUserHomeGroup,
} from '../db.js';
import { ensureSwarmDefinition } from '../agent-group/swarm-definition.js';
import { triggerSwarmRun } from '../agent-group/swarm-runner.js';
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
  /** Chat mount selections for this message — same shape as the Web chat's
   *  POST /messages `selectedMounts`, applied to every seat's turn. */
  selectedMounts: z
    .object({
      skills: z.array(z.string()).max(50).optional(),
      mcpServers: z.array(z.string()).max(50).optional(),
      kbIds: z.array(z.string()).max(50).optional(),
    })
    .optional(),
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
    createSwarmGroup({
      jid,
      name: description ? `${name} - ${description}` : name,
      folder,
      created_by: authUser.id,
      groupKind: 'swarm',
      floorPolicy: floorPolicy ?? null,
      // Seats belong to the creator, so they run in the creator's own home
      // execution mode — an admin's swarm runs on the host like `main` does.
      executionMode: getUserHomeGroup(authUser.id)?.executionMode ?? 'container',
    });
    for (let i = 0; i < seats.length; i++) {
      const s = seats[i];
      createGroupSeat({ groupId: jid, agentDefinitionId: s.agentDefinitionId, agentVersion: s.agentVersion ?? 'latest', rolePrompt: s.rolePrompt ?? '', speakPolicy: s.speakPolicy ?? 'auto', mounts: s.mounts ? JSON.stringify(s.mounts) : '{}', maxTurns: s.maxTurns ?? 10, tokenBudget: s.tokenBudget ?? 100000, timeBudgetMs: s.timeBudgetMs ?? 600000, maxParallel: s.maxParallel ?? 1, seatOrder: s.seatOrder ?? i });
    }
    const group = getSwarmGroup(jid);
    refreshSwarmDefinition(jid);
    const withDefinition = getSwarmGroup(jid);
    return c.json({
      jid: jid,
      name: name,
      folder: folder,
      groupKind: 'swarm',
      floorPolicy: floorPolicy ?? 'orchestrator_driven',
      swarmStatus: 'active',
      orchestratorAgentId: null,
      graphDefinitionId: withDefinition?.graphDefinitionId ?? null,
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
    refreshSwarmDefinition(jid);
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
  refreshSwarmDefinition(jid);
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
  refreshSwarmDefinition(jid);
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

  // A user text message is the prompt for a run: the seats execute in turn and
  // their replies land back in group_messages. Non-text rows (pipeline_event /
  // system) are conversation log entries, not prompts.
  const goalText = (parsed.data.text ?? '').trim();
  let graphRunId: string | undefined;
  let runError: string | undefined;
  if (goalText && (parsed.data.msgType ?? 'text') === 'text') {
    const result = startSwarmRun(group, authUser, goalText, parsed.data.selectedMounts);
    if ('error' in result) runError = result.error;
    else graphRunId = result.runId;
  }

  return c.json({ ...msgToJson(msg), graphRunId, runError }, 201);
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

/**
 * Start a run for a swarm group through the graph engine. Returns an explicit
 * error rather than a fake `running` status when no run could be started.
 */
function startSwarmRun(
  group: RegisteredGroup & { jid: string },
  authUser: AuthUser,
  goalText: string,
  turnMounts?: SelectedMounts,
): { runId: string } | { error: string } {
  const startGraphRun = getWebDeps()?.startGraphRun;
  if (!startGraphRun) {
    logger.warn({ jid: group.jid }, 'Swarm run: graph execution not initialized');
    return { error: 'graph execution not initialized' };
  }
  return triggerSwarmRun({
    group,
    ownerUserId: group.created_by ?? authUser.id,
    goalText,
    turnMounts,
    startGraphRun,
  });
}

/**
 * Best-effort refresh of the group's graph definition after a seat changed.
 * Never fails the seat operation — the definition also self-heals on the next
 * run via ensureSwarmDefinition.
 */
function refreshSwarmDefinition(jid: string): void {
  const group = getSwarmGroup(jid);
  if (!group) return;
  try {
    const ensured = ensureSwarmDefinition(group);
    if ('error' in ensured) {
      logger.warn({ jid, error: ensured.error }, 'Swarm definition refresh skipped');
    }
  } catch (err) {
    logger.error({ err, jid }, 'Swarm definition refresh failed');
  }
}

/** Text of the most recent user message in the group, if any. */
function lastUserMessageText(jid: string): string | undefined {
  const recent = listGroupMessages(jid, undefined, 20);
  const last = recent.find(m => m.sender_type === 'user');
  return last?.content_ref?.trim() || undefined;
}

// ─── Routes: Pipeline Runs ─────────────────────────────────────

const RunSchema = z.object({
  prompt: z.string().max(50000).optional(),
});

agentGroupRoutes.post('/:jid/runs', async (c) => {
  const authUser = c.get('user') as AuthUser;
  const jid = c.req.param('jid');
  const { group, owner } = checkOwnership(authUser, jid);
  if (!group) return c.json({ error: 'Group not found' }, 404);
  if (!owner) return c.json({ error: 'Forbidden' }, 403);

  const body = await c.req.json().catch(() => ({}));
  const parsed = RunSchema.safeParse(body);

  const seats = listGroupSeats(jid).filter(s => s.speak_policy !== 'silent');
  if (seats.length === 0) {
    return c.json({
      runId: null, groupJid: jid, status: 'idle',
      warning: 'No seats found matching the execution criteria',
      nodes: [],
    }, 201);
  }

  const goalText =
    (parsed.success ? parsed.data.prompt?.trim() : '') ||
    lastUserMessageText(jid) ||
    `继续「${group.name}」的讨论`;

  const started = startSwarmRun(group, authUser, goalText);
  if ('error' in started) return c.json({ error: started.error }, 400);

  return c.json({
    runId: started.runId,
    groupJid: jid,
    status: 'running',
    executedSeat: {
      id: seats[0].id,
      agentDefinitionId: seats[0].agent_definition_id,
      speakPolicy: seats[0].speak_policy,
    },
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
