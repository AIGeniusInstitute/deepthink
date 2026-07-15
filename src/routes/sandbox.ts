/**
 * Sandbox REST routes.
 * All endpoints require authentication. Each user can only access their own
 * sandbox sessions (in addition to the per-session check inside SandboxManager).
 */

import { Hono } from 'hono';
import type { Variables } from '../web-context.js';
import { authMiddleware } from '../middleware/auth.js';
import { getSandboxManager } from '../sandbox/index.js';
import type { SandboxLanguage } from '../sandbox/config.js';
import { logger } from '../logger.js';

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
router.post('/sessions/:id/browser/click', authMiddleware, async (c) => {
  const user = c.get('user');
  if (!user) return c.json({ error: '未登录' }, 401);
  const id = c.req.param('id');
  const body = await c.req.json().catch(() => ({})) as { selector: string };
  if (!body.selector) return c.json({ error: 'selector 必填' }, 400);
  const session = getSandboxManager().get(id);
  if (!session) return c.json({ error: '沙箱不存在' }, 404);
  if (session.userId !== user.id) return c.json({ error: 'Forbidden' }, 403);
  try {
    const browser = await getSandboxManager().getBrowser(id);
    if (!browser) return c.json({ error: '浏览器未启动' }, 400);
    await browser.click(body.selector);
    return c.json({ ok: true });
  } catch (e: any) {
    return c.json({ error: e.message ?? '点击失败' }, 400);
  }
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
