import { afterAll, afterEach, beforeAll, describe, expect, test } from 'vitest';
import fs from 'fs';
import os from 'os';
import path from 'path';

// Point DATA_DIR at a temp dir BEFORE importing db.ts so initDatabase() creates
// an isolated messages.db for this test run.
const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'sat-trace-'));
process.env.DEEPTHINK_DATA_DIR = tmpDir;

import {
  initDatabase,
  upsertChatTraceNode,
  listGraphNodeTraceNodes,
  upsertTraceToolCall,
  listTraceToolCalls,
  getDb,
} from '../../src/db.js';

beforeAll(() => {
  initDatabase();
});

afterAll(() => {
  try {
    fs.rmSync(tmpDir, { recursive: true, force: true });
  } catch {
    // best-effort cleanup
  }
});

describe('super-agent-team C1: schema v53 trace tables', () => {
  test('schema_version is 53', () => {
    const row = getDb()
      .prepare('SELECT value FROM router_state WHERE key = ?')
      .get('schema_version') as { value: string } | undefined;
    expect(row?.value).toBe('53');
  });

  test('chat_trace_nodes has graph columns', () => {
    const cols = getDb()
      .prepare("PRAGMA table_info('chat_trace_nodes')")
      .all() as Array<{ name: string }>;
    const names = cols.map((c) => c.name);
    expect(names).toContain('graph_run_id');
    expect(names).toContain('graph_node_id');
    expect(names).toContain('tool_name');
    expect(names).toContain('tool_use_id');
  });

  test('trace_tool_calls table exists', () => {
    const cols = getDb()
      .prepare("PRAGMA table_info('trace_tool_calls')")
      .all() as Array<{ name: string }>;
    const names = cols.map((c) => c.name);
    expect(names).toContain('tool_use_id');
    expect(names).toContain('input_json');
    expect(names).toContain('output_json');
  });
});

describe('super-agent-team C1: chat_trace_nodes graph linkage (TC12/TC14)', () => {
  const chatJid = 'feishu:test-trace';

  afterEach(() => {
    getDb().prepare('DELETE FROM chat_trace_nodes WHERE chat_jid = ?').run(chatJid);
  });

  test('upsert persists graph_run_id/graph_node_id and queryable by node', () => {
    upsertChatTraceNode({
      id: 1001,
      chat_jid: chatJid,
      node_type: 'turn',
      title: 'agent turn',
      started_at: '2026-07-22T00:00:00.000Z',
      graph_run_id: 'graph-run-1',
      graph_node_id: 'node-impl',
      tool_name: 'Bash',
      tool_use_id: 'toolu_1',
    });
    const rows = listGraphNodeTraceNodes('graph-run-1', 'node-impl');
    expect(rows).toHaveLength(1);
    expect(rows[0].graph_run_id).toBe('graph-run-1');
    expect(rows[0].graph_node_id).toBe('node-impl');
    expect(rows[0].tool_use_id).toBe('toolu_1');
  });

  test('plain chat trace (no graph fields) still works — backward compat (TC14)', () => {
    upsertChatTraceNode({
      id: 1002,
      chat_jid: chatJid,
      node_type: 'turn',
      title: 'plain chat',
      started_at: '2026-07-22T00:00:01.000Z',
    });
    const rows = listGraphNodeTraceNodes('graph-run-1', 'node-impl');
    expect(rows).toHaveLength(0); // not linked to graph
  });
});

describe('super-agent-team C1: trace_tool_calls upsert merge (TC13)', () => {
  const runId = 'graph-run-tc13';

  afterEach(() => {
    getDb().prepare('DELETE FROM trace_tool_calls WHERE graph_run_id = ?').run(runId);
  });

  test('input then output merge into one row by tool_use_id', () => {
    // first stream event: tool input
    upsertTraceToolCall({
      graph_run_id: runId,
      graph_node_id: 'node-x',
      chat_jid: 'feishu:tc13',
      tool_use_id: 'toolu_merge',
      tool_name: 'Bash',
      input_json: JSON.stringify({ command: 'ls' }),
      status: 'running',
      started_at: '2026-07-22T00:00:00.000Z',
    });
    // second stream event: tool result
    upsertTraceToolCall({
      graph_run_id: runId,
      tool_use_id: 'toolu_merge',
      tool_name: 'Bash',
      output_json: JSON.stringify({ stdout: 'file.txt' }),
      status: 'success',
      started_at: '2026-07-22T00:00:00.000Z',
      ended_at: '2026-07-22T00:00:01.000Z',
    });
    const rows = listTraceToolCalls(runId, 'node-x');
    expect(rows).toHaveLength(1);
    expect(rows[0].input_json).toContain('ls');
    expect(rows[0].output_json).toContain('file.txt');
    expect(rows[0].status).toBe('success');
    expect(rows[0].ended_at).toBe('2026-07-22T00:00:01.000Z');
  });
});
