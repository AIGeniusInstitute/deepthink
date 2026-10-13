/**
 * Agent 运行监控 API。
 *
 *   GET /api/runtime-monitor/sources
 *   GET /api/runtime-monitor/overview?window=24h|7d|30d|all
 *   GET /api/runtime-monitor/runs?source=&status=&window=&from=&to=&q=&stale=&limit=&offset=
 *   GET /api/runtime-monitor/runs/:runId
 *
 * 权限：所有端点要求登录。admin 看全量；其余用户只看**自己有权访问的工作区**的运行，
 * 外加自己名下的开放平台 / 沙箱运行（这两类没有工作区归属，只能按 owner 判定）。
 * 越权访问某条运行的详情返回 404 而不是 403 —— 403 会泄露"这个 runId 存在"。
 */

import { Hono } from 'hono';
import type { Variables } from '../web-context.js';
import { authMiddleware } from '../middleware/auth.js';
import { canAccessGroup } from '../web-context.js';
import { getAllRegisteredGroups } from '../db.js';
import type { AuthUser } from '../types.js';
import { getOverview, getRunDetail, listRuns } from '../runtime-monitor/queries.js';
import { sourceLabel } from '../runtime-monitor/sources.js';
import {
  RUN_SOURCES,
  RUN_STATUSES,
  WINDOW_MS,
  type RunFilter,
  type RunSource,
  type RunStatus,
  type RunWindow,
} from '../runtime-monitor/types.js';

const router = new Hono<{ Variables: Variables }>();

router.use('*', authMiddleware);

const WINDOWS = Object.keys(WINDOW_MS) as RunWindow[];

/** 把当前用户的可访问范围转成查询过滤条件。 */
function scopeFor(user: AuthUser): Pick<RunFilter, 'allowedWorkspaces' | 'viewerUserId'> {
  if (user.role === 'admin') return { allowedWorkspaces: null };
  const ws = new Set<string>();
  for (const [jid, group] of Object.entries(getAllRegisteredGroups())) {
    if (canAccessGroup(user, { ...group, jid })) {
      ws.add(jid); // chat 来源的 workspace 是 chat_jid
      ws.add(group.folder); // 图 / Loop / 监督者 / 任务的 workspace 是 group_folder
    }
  }
  return { allowedWorkspaces: [...ws], viewerUserId: user.id };
}

function parseSources(raw: string | undefined): RunSource[] | undefined {
  if (!raw) return undefined;
  const wanted = raw
    .split(',')
    .map((s) => s.trim())
    .filter(Boolean);
  const valid = wanted.filter((s): s is RunSource => (RUN_SOURCES as string[]).includes(s));
  // 全部非法 → 返回不可满足的来源集合（空结果），而不是静默退化成"全部"
  return valid.length > 0 ? valid : [];
}

function parseStatuses(raw: string | undefined): RunStatus[] | undefined {
  if (!raw) return undefined;
  const wanted = raw
    .split(',')
    .map((s) => s.trim())
    .filter(Boolean);
  const valid = wanted.filter((s): s is RunStatus => (RUN_STATUSES as string[]).includes(s));
  return valid.length > 0 ? valid : [];
}

function parseIsoParam(raw: string | undefined): string | undefined {
  if (!raw) return undefined;
  const t = Date.parse(raw);
  return Number.isFinite(t) ? new Date(t).toISOString() : undefined;
}

/** `window` 与显式 `from` 二选一；两者都没给时列表不设时间下限。 */
function windowToFrom(raw: string | undefined): string | undefined {
  if (!raw || !(WINDOWS as string[]).includes(raw)) return undefined;
  const ms = WINDOW_MS[raw as RunWindow];
  if (ms === null) return undefined;
  return new Date(Date.now() - ms).toISOString();
}

function buildFilter(c: { req: { query: (k: string) => string | undefined } }, user: AuthUser): RunFilter {
  const windowFrom = windowToFrom(c.req.query('window'));
  const explicitFrom = parseIsoParam(c.req.query('from'));
  const q = c.req.query('q');
  return {
    sources: parseSources(c.req.query('source')),
    statuses: parseStatuses(c.req.query('status')),
    from: explicitFrom ?? windowFrom,
    to: parseIsoParam(c.req.query('to')),
    q: q ? q.slice(0, 200) : undefined,
    staleOnly: c.req.query('stale') === '1',
    ...scopeFor(user),
  };
}

/**
 * 全部来源的 key + 展示名。
 *
 * 为什么要有这个端点：`overview.bySource` 只含**有数据**的来源，而来源分布面板要让
 * 用户能点选当前为空的来源（确认"这个来源确实没在跑"）。名字只有 `sources.ts` 的注册表
 * 是权威，前端再抄一份必然漂移，所以直接把注册表吐出去。
 * 与运行数据无关，前端拉一次缓存即可。
 */
router.get('/sources', (c) => {
  return c.json({
    sources: RUN_SOURCES.map((key) => ({ source: key, label: sourceLabel(key) })),
  });
});

router.get('/overview', (c) => {
  const user = c.get('user') as AuthUser;
  const rawWindow = c.req.query('window') ?? '7d';
  const window: RunWindow = (WINDOWS as string[]).includes(rawWindow)
    ? (rawWindow as RunWindow)
    : '7d';
  const filter = buildFilter(c, user);
  // overview 的时间范围完全由 window 决定，忽略显式 from/to，避免两份时间口径打架
  return c.json(getOverview(window, { ...filter, from: undefined, to: undefined }));
});

router.get('/runs', (c) => {
  const user = c.get('user') as AuthUser;
  const filter = buildFilter(c, user);
  const limit = Number(c.req.query('limit') ?? 20);
  const offset = Number(c.req.query('offset') ?? 0);
  return c.json(
    listRuns(
      filter,
      Number.isFinite(limit) ? limit : 20,
      Number.isFinite(offset) ? offset : 0,
    ),
  );
});

router.get('/runs/:runId', (c) => {
  const user = c.get('user') as AuthUser;
  const runId = decodeURIComponent(c.req.param('runId'));
  const detail = getRunDetail(runId, buildFilter(c, user));
  if (!detail) return c.json({ error: 'Run not found' }, 404);
  return c.json(detail);
});

export default router;
