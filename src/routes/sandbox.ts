/**
 * Sandbox REST routes.
 * All endpoints require authentication. Each user can only access their own
 * sandbox sessions (in addition to the per-session check inside SandboxManager).
 */

import { Hono } from 'hono';
import path from 'node:path';
import type { Variables } from '../web-context.js';
import { authMiddleware } from '../middleware/auth.js';
import { getSandboxManager } from '../sandbox/index.js';
import { runBrowserAgent } from '../sandbox/browser-agent.js';
import type { SandboxLanguage } from '../sandbox/config.js';
import { logger } from '../logger.js';
import { getSandboxSessionId } from '../db.js';

const router = new Hono<{ Variables: Variables }>();

const LANGS: SandboxLanguage[] = ['python', 'node', 'sh'];

// POST /api/sandbox/sessions — create a new sandbox
router.post('/sessions', authMiddleware, async (c) => {
  const user = c.get('user');
  if (!user) return c.json({ error: '未登录' }, 401);
  const body = await c.req.json().catch(() => ({})) as {
    language?: string;
    browserEnabled?: boolean;
    ttlMinutes?: number;
  };
  const language = (body.language as SandboxLanguage) || 'python';
  if (!LANGS.includes(language)) {
    return c.json({ error: `不支持的语言: ${language}` }, 400);
  }
  const browserEnabled = !!body.browserEnabled;
  try {
    const session = await getSandboxManager().create(user.id, {
      language,
      browserEnabled,
      ttlMinutes: body.ttlMinutes,
    });
    return c.json(session);
  } catch (e: any) {
    logger.warn({ err: e.message }, 'Sandbox create failed');
    return c.json({ error: e.message ?? '创建失败' }, 400);
  }
});

// GET /api/sandbox/sessions — list user's active sessions
router.get('/sessions', authMiddleware, async (c) => {
  const user = c.get('user');
  if (!user) return c.json({ error: '未登录' }, 401);
  const sessions = await getSandboxManager().listForUser(user.id);
  return c.json({ sessions });
});

// GET /api/sandbox/sessions/:id
router.get('/sessions/:id', authMiddleware, async (c) => {
  const user = c.get('user');
  if (!user) return c.json({ error: '未登录' }, 401);
  const id = c.req.param('id');
  const session = getSandboxManager().get(id);
  if (!session) return c.json({ error: '沙箱不存在' }, 404);
  if (session.userId !== user.id) return c.json({ error: 'Forbidden' }, 403);
  return c.json(session);
});

// DELETE /api/sandbox/sessions/:id
router.delete('/sessions/:id', authMiddleware, async (c) => {
  const user = c.get('user');
  if (!user) return c.json({ error: '未登录' }, 401);
  const id = c.req.param('id');
  const session = getSandboxManager().get(id);
  if (!session) return c.json({ error: '沙箱不存在' }, 404);
  if (session.userId !== user.id) return c.json({ error: 'Forbidden' }, 403);
  await getSandboxManager().destroy(id, 'user_requested');
  return c.json({ ok: true });
});

// POST /api/sandbox/sessions/:id/execute — run code
router.post('/sessions/:id/execute', authMiddleware, async (c) => {
  const user = c.get('user');
  if (!user) return c.json({ error: '未登录' }, 401);
  const id = c.req.param('id');
  const body = await c.req.json().catch(() => ({})) as {
    language?: string;
    code?: string;
    stdin?: string;
    timeoutMs?: number;
  };
  if (!body.code) return c.json({ error: 'code 不能为空' }, 400);
  const language = (body.language as SandboxLanguage) || 'python';
  if (!LANGS.includes(language)) {
    return c.json({ error: `不支持的语言: ${language}` }, 400);
  }
  try {
    const result = await getSandboxManager().executeCode(id, user.id, {
      language,
      code: body.code,
      stdin: body.stdin,
      timeoutMs: body.timeoutMs,
    });
    return c.json(result);
  } catch (e: any) {
    return c.json({ error: e.message ?? '执行失败' }, 400);
  }
});

// POST /api/sandbox/sessions/:id/browser/start
router.post('/sessions/:id/browser/start', authMiddleware, async (c) => {
  const user = c.get('user');
  if (!user) return c.json({ error: '未登录' }, 401);
  const id = c.req.param('id');
  const body = await c.req.json().catch(() => ({})) as { url?: string };
  const session = getSandboxManager().get(id);
  if (!session) return c.json({ error: '沙箱不存在' }, 404);
  if (session.userId !== user.id) return c.json({ error: 'Forbidden' }, 403);
  try {
    // Note: onFrame is wired by the WebSocket layer when a client subscribes.
    // For REST-only usage we pass a no-op here.
    await getSandboxManager().startBrowser(id, () => {});
    if (body.url) {
      const browser = await getSandboxManager().getBrowser(id);
      if (browser) await browser.navigate(body.url);
    }
    return c.json({ ok: true, started: true });
  } catch (e: any) {
    return c.json({ error: e.message ?? '浏览器启动失败' }, 400);
  }
});

// POST /api/sandbox/sessions/:id/browser/navigate
router.post('/sessions/:id/browser/navigate', authMiddleware, async (c) => {
  const user = c.get('user');
  if (!user) return c.json({ error: '未登录' }, 401);
  const id = c.req.param('id');
  const body = await c.req.json().catch(() => ({})) as { url: string };
  if (!body.url) return c.json({ error: 'url 必填' }, 400);
  const session = getSandboxManager().get(id);
  if (!session) return c.json({ error: '沙箱不存在' }, 404);
  if (session.userId !== user.id) return c.json({ error: 'Forbidden' }, 403);
  try {
    const browser = await getSandboxManager().getBrowser(id);
    if (!browser) return c.json({ error: '浏览器未启动' }, 400);
    await browser.navigate(body.url);
    return c.json({ ok: true, url: body.url });
  } catch (e: any) {
    return c.json({ error: e.message ?? '导航失败' }, 400);
  }
});

// POST /api/sandbox/sessions/:id/browser/click
// 支持两种模式：selector 选择器点击，或 {x,y} 坐标点击（用于前端帧交互转发）。
router.post('/sessions/:id/browser/click', authMiddleware, async (c) => {
  const user = c.get('user');
  if (!user) return c.json({ error: '未登录' }, 401);
  const id = c.req.param('id');
  const body = await c.req.json().catch(() => ({})) as {
    selector?: string;
    x?: number;
    y?: number;
  };
  const session = getSandboxManager().get(id);
  if (!session) return c.json({ error: '沙箱不存在' }, 404);
  if (session.userId !== user.id) return c.json({ error: 'Forbidden' }, 403);
  try {
    const browser = await getSandboxManager().getBrowser(id);
    if (!browser) return c.json({ error: '浏览器未启动' }, 400);
    if (body.x != null && body.y != null) {
      await browser.clickAt(Number(body.x), Number(body.y));
    } else if (body.selector) {
      await browser.click(body.selector);
    } else {
      return c.json({ error: 'selector 或 x/y 必填' }, 400);
    }
    return c.json({ ok: true });
  } catch (e: any) {
    return c.json({ error: e.message ?? '点击失败' }, 400);
  }
});

// POST /api/sandbox/sessions/:id/browser/scroll — 滚动 {deltaX, deltaY}
router.post('/sessions/:id/browser/scroll', authMiddleware, async (c) => {
  const user = c.get('user');
  if (!user) return c.json({ error: '未登录' }, 401);
  const id = c.req.param('id');
  const body = await c.req.json().catch(() => ({})) as { deltaX?: number; deltaY?: number };
  const session = getSandboxManager().get(id);
  if (!session) return c.json({ error: '沙箱不存在' }, 404);
  if (session.userId !== user.id) return c.json({ error: 'Forbidden' }, 403);
  try {
    const browser = await getSandboxManager().getBrowser(id);
    if (!browser) return c.json({ error: '浏览器未启动' }, 400);
    await browser.scroll(Number(body.deltaX ?? 0), Number(body.deltaY ?? 0));
    return c.json({ ok: true });
  } catch (e: any) {
    return c.json({ error: e.message ?? '滚动失败' }, 400);
  }
});

// POST /api/sandbox/sessions/:id/browser/press — 按键 {key}
router.post('/sessions/:id/browser/press', authMiddleware, async (c) => {
  const user = c.get('user');
  if (!user) return c.json({ error: '未登录' }, 401);
  const id = c.req.param('id');
  const body = await c.req.json().catch(() => ({})) as { key?: string };
  if (!body.key) return c.json({ error: 'key 必填' }, 400);
  const session = getSandboxManager().get(id);
  if (!session) return c.json({ error: '沙箱不存在' }, 404);
  if (session.userId !== user.id) return c.json({ error: 'Forbidden' }, 403);
  try {
    const browser = await getSandboxManager().getBrowser(id);
    if (!browser) return c.json({ error: '浏览器未启动' }, 400);
    await browser.pressKey(body.key);
    return c.json({ ok: true });
  } catch (e: any) {
    return c.json({ error: e.message ?? '按键失败' }, 400);
  }
});

// ─── Browser Use Agent ──────────────────────────────────────────
// 模块级 run 跟踪，用于 stop。
const agentRuns = new Map<string, { runId: string; isStopped: () => boolean; stop: () => void }>();

function newRunId(): string {
  return `ba_${Date.now().toString(36)}_${Math.random().toString(36).slice(2, 8)}`;
}

// POST /api/sandbox/sessions/:id/browser/agent — 启动自然语言浏览器 Agent
router.post('/sessions/:id/browser/agent', authMiddleware, async (c) => {
  const user = c.get('user');
  if (!user) return c.json({ error: '未登录' }, 401);
  const id = c.req.param('id');
  const body = await c.req.json().catch(() => ({})) as {
    goal?: string;
    maxSteps?: number;
    initialUrl?: string;
  };
  if (!body.goal || !body.goal.trim()) {
    return c.json({ error: 'goal 必填' }, 400);
  }
  const session = getSandboxManager().get(id);
  if (!session) return c.json({ error: '沙箱不存在' }, 404);
  if (session.userId !== user.id) return c.json({ error: 'Forbidden' }, 403);
  try {
    const browser = await getSandboxManager().getBrowser(id);
    if (!browser) return c.json({ error: '浏览器未启动' }, 400);

    // 若已有运行中的 Agent，先停止
    const prev = agentRuns.get(id);
    if (prev) prev.stop();

    const runId = newRunId();
    let stopped = false;
    const isStopped = () => stopped;
    const stop = () => { stopped = true; };
    agentRuns.set(id, { runId, isStopped, stop });

    runBrowserAgent({
      sessionId: id,
      userId: user.id,
      goal: body.goal.trim(),
      browser,
      runId,
      maxSteps: body.maxSteps,
      initialUrl: body.initialUrl,
      isStopped,
    });

    return c.json({ ok: true, runId });
  } catch (e: any) {
    return c.json({ error: e.message ?? '启动 Agent 失败' }, 400);
  }
});

// POST /api/sandbox/sessions/:id/browser/agent/stop
router.post('/sessions/:id/browser/agent/stop', authMiddleware, async (c) => {
  const user = c.get('user');
  if (!user) return c.json({ error: '未登录' }, 401);
  const id = c.req.param('id');
  const session = getSandboxManager().get(id);
  if (!session) return c.json({ error: '沙箱不存在' }, 404);
  if (session.userId !== user.id) return c.json({ error: 'Forbidden' }, 403);
  const run = agentRuns.get(id);
  if (run) {
    run.stop();
    agentRuns.delete(id);
  }
  return c.json({ ok: true });
});

// POST /api/sandbox/sessions/:id/browser/type
router.post('/sessions/:id/browser/type', authMiddleware, async (c) => {
  const user = c.get('user');
  if (!user) return c.json({ error: '未登录' }, 401);
  const id = c.req.param('id');
  const body = await c.req.json().catch(() => ({})) as {
    selector: string;
    text: string;
  };
  if (!body.selector || !body.text) {
    return c.json({ error: 'selector 和 text 必填' }, 400);
  }
  const session = getSandboxManager().get(id);
  if (!session) return c.json({ error: '沙箱不存在' }, 404);
  if (session.userId !== user.id) return c.json({ error: 'Forbidden' }, 403);
  try {
    const browser = await getSandboxManager().getBrowser(id);
    if (!browser) return c.json({ error: '浏览器未启动' }, 400);
    await browser.type(body.selector, body.text);
    return c.json({ ok: true });
  } catch (e: any) {
    return c.json({ error: e.message ?? '输入失败' }, 400);
  }
});

// POST /api/sandbox/sessions/:id/browser/screenshot
router.post('/sessions/:id/browser/screenshot', authMiddleware, async (c) => {
  const user = c.get('user');
  if (!user) return c.json({ error: '未登录' }, 401);
  const id = c.req.param('id');
  const session = getSandboxManager().get(id);
  if (!session) return c.json({ error: '沙箱不存在' }, 404);
  if (session.userId !== user.id) return c.json({ error: 'Forbidden' }, 403);
  try {
    const browser = await getSandboxManager().getBrowser(id);
    if (!browser) return c.json({ error: '浏览器未启动' }, 400);
    const dataUrl = await browser.screenshot();
    const title = await browser.getTitle().catch(() => null);
    const url = await browser.getCurrentUrl().catch(() => null);
    return c.json({ screenshot: dataUrl, title, url });
  } catch (e: any) {
    return c.json({ error: e.message ?? '截图失败' }, 400);
  }
});

// POST /api/sandbox/sessions/:id/browser/evaluate
router.post('/sessions/:id/browser/evaluate', authMiddleware, async (c) => {
  const user = c.get('user');
  if (!user) return c.json({ error: '未登录' }, 401);
  const id = c.req.param('id');
  const body = await c.req.json().catch(() => ({})) as { script: string };
  if (!body.script) return c.json({ error: 'script 必填' }, 400);
  const session = getSandboxManager().get(id);
  if (!session) return c.json({ error: '沙箱不存在' }, 404);
  if (session.userId !== user.id) return c.json({ error: 'Forbidden' }, 403);
  try {
    const browser = await getSandboxManager().getBrowser(id);
    if (!browser) return c.json({ error: '浏览器未启动' }, 400);
    const value = await browser.evaluate(body.script);
    return c.json({ value });
  } catch (e: any) {
    return c.json({ error: e.message ?? '执行失败' }, 400);
  }
});

// POST /api/sandbox/sessions/:id/browser/stop
router.post('/sessions/:id/browser/stop', authMiddleware, async (c) => {
  const user = c.get('user');
  if (!user) return c.json({ error: '未登录' }, 401);
  const id = c.req.param('id');
  const session = getSandboxManager().get(id);
  if (!session) return c.json({ error: '沙箱不存在' }, 404);
  if (session.userId !== user.id) return c.json({ error: 'Forbidden' }, 403);
  await getSandboxManager().stopBrowser(id);
  return c.json({ ok: true });
});

// POST /api/sandbox/sessions/:id/browser/restart
router.post('/sessions/:id/browser/restart', authMiddleware, async (c) => {
  const user = c.get('user');
  if (!user) return c.json({ error: '未登录' }, 401);
  const id = c.req.param('id');
  const session = getSandboxManager().get(id);
  if (!session) return c.json({ error: '沙箱不存在' }, 404);
  if (session.userId !== user.id) return c.json({ error: 'Forbidden' }, 403);
  const browser = await getSandboxManager().getBrowser(id);
  if (!browser) return c.json({ error: '浏览器未启动' }, 400);
  try {
    await browser.restart();
    return c.json({ ok: true });
  } catch (e: any) {
    return c.json({ error: e.message ?? '重启失败' }, 400);
  }
});

// GET /api/sandbox/by-group/:groupFolder — resolve the sandbox session bound to a chat group
router.get('/by-group/:groupFolder', authMiddleware, async (c) => {
  const user = c.get('user');
  if (!user) return c.json({ error: '未登录' }, 401);
  const groupFolder = c.req.param('groupFolder');
  const sid = getSandboxSessionId(groupFolder);
  if (!sid) return c.json({ sessionId: null });
  const session = getSandboxManager().get(sid);
  if (!session || session.userId !== user.id) {
    return c.json({ sessionId: null });
  }
  return c.json({ sessionId: sid, status: session.status, browserEnabled: session.browserEnabled });
});

// GET /api/sandbox/sessions/:id/files?path= — list files under /workspace
router.get('/sessions/:id/files', authMiddleware, async (c) => {
  const user = c.get('user');
  if (!user) return c.json({ error: '未登录' }, 401);
  const id = c.req.param('id');
  const rawPath = c.req.query('path') || '/workspace';

  // Path traversal protection: normalize then verify it's within /workspace.
  // Plain string startsWith() is insufficient — "/workspace/../../etc" would
  // pass it but resolve to /etc.
  const norm = path.posix.normalize(rawPath).replace(/\/+$/, '');
  if (norm !== '/workspace' && !norm.startsWith('/workspace/')) {
    return c.json({ error: '路径必须在 /workspace 下' }, 400);
  }
  // Reject any remaining ".." segments (defense in depth — normalize() should
  // already have resolved them, but if the normalized path escapes /workspace
  // we catch it here).
  if (norm.includes('/../') || norm === '..') {
    return c.json({ error: '路径必须在 /workspace 下' }, 400);
  }

  const session = getSandboxManager().get(id);
  if (!session) return c.json({ error: '沙箱不存在' }, 404);
  if (session.userId !== user.id) return c.json({ error: 'Forbidden' }, 403);

  try {
    const entries = await getSandboxManager().listFiles(id, norm);
    return c.json({ path: norm, entries });
  } catch (e: any) {
    return c.json({ error: e.message ?? '列目录失败' }, 400);
  }
});

// GET /api/sandbox/sessions/:id/files/read?path= — read a text file
router.get('/sessions/:id/files/read', authMiddleware, async (c) => {
  const user = c.get('user');
  if (!user) return c.json({ error: '未登录' }, 401);
  const id = c.req.param('id');
  const rawPath = c.req.query('path') || '';

  const norm = path.posix.normalize(rawPath).replace(/\/+$/, '');
  if (norm !== '/workspace' && !norm.startsWith('/workspace/')) {
    return c.json({ error: '路径必须在 /workspace 下' }, 400);
  }
  if (norm.includes('/../') || norm === '..') {
    return c.json({ error: '路径必须在 /workspace 下' }, 400);
  }

  // Text file extension whitelist
  const ext = path.posix.extname(norm).toLowerCase();
  const textExts = new Set([
    '.py', '.js', '.ts', '.json', '.txt', '.md', '.html', '.css',
    '.sh', '.yaml', '.yml', '.env', '.cfg', '.ini', '.xml', '.csv',
    '.log', '.toml', '.jsx', '.tsx', '.sql', '.rb', '.go', '.rs',
    '.java', '.c', '.cpp', '.h', '.hpp', '.php', '.swift', '.kt',
  ]);
  if (!textExts.has(ext) && ext !== '') {
    return c.json({ error: '不支持预览该文件类型（仅支持文本文件）' }, 400);
  }

  const session = getSandboxManager().get(id);
  if (!session) return c.json({ error: '沙箱不存在' }, 404);
  if (session.userId !== user.id) return c.json({ error: 'Forbidden' }, 403);

  try {
    const result = await getSandboxManager().readFile(id, norm);
    return c.json(result);
  } catch (e: any) {
    return c.json({ error: e.message ?? '读取失败' }, 400);
  }
});

// GET /api/sandbox/sessions/:id/executions — recent executions
router.get('/sessions/:id/executions', authMiddleware, async (c) => {
  const user = c.get('user');
  if (!user) return c.json({ error: '未登录' }, 401);
  const id = c.req.param('id');
  const session = getSandboxManager().get(id);
  if (!session) return c.json({ error: '沙箱不存在' }, 404);
  if (session.userId !== user.id) return c.json({ error: 'Forbidden' }, 403);
  const { getDb } = await import('../db.js');
  const rows = getDb()
    .prepare(
      `SELECT id, session_id, language, code_hash, status, exit_code,
              stdout_bytes, stderr_bytes, truncated, duration_ms, created_at
         FROM sandbox_executions
        WHERE session_id = ?
        ORDER BY created_at DESC
        LIMIT 50`,
    )
    .all(id);
  return c.json({ executions: rows });
});

export default router;
