// Super Agent Team routes.
//
// POST /api/team/runs: 异步——立即创建一条 team_builds 记录（status='running'）
// 并返回 buildId，buildTeam（decompose + 成员创建 + graph 注册启动，最坏 ~240s）
// 在后台 detached 执行，结果/错误回写记录。前端轮询 GET /api/team/runs/:buildId
// 拿终态（completed → plan+runId / failed → error），消除"长时间阻塞 HTTP 请求"
// 这一脆弱模式。团队 Builder 算法本身（team-builder.ts）零改动；runId 是标准
// graph_run，/api/graph/runs/:id 与 GraphPage 可视化不变。
//
// 选型：不复用 graph_runs 承载 build 期——其 definition_id 为 NOT NULL+FK，而
// decompose 之前没有 graph definition。故新增极简 team_builds 表解耦。

import { Hono } from 'hono';
import type { Variables } from '../web-context.js';
import { authMiddleware } from '../middleware/auth.js';
import { getWebDeps } from '../web-context.js';
import { z } from 'zod';
import { randomUUID } from 'node:crypto';
import {
  createTeamBuild,
  getTeamBuild,
  completeTeamBuild,
  failTeamBuild,
} from '../db.js';
import { logger } from '../logger.js';

export const teamRoutes = new Hono<{ Variables: Variables }>();

teamRoutes.use('*', authMiddleware);

const TeamRunBodySchema = z.object({
  goalText: z.string().min(1),
  background: z.string().optional(),
  acceptanceCriteria: z.string().optional(),
  groupFolder: z.string().min(1),
  chatJid: z.string().min(1),
  userLanguage: z.string().optional(),
});

/** POST /api/team/runs — 立即返回 buildId，后台 detached 组建团队。 */
teamRoutes.post('/runs', async (c) => {
  const authUser = c.get('user') as import('../types.js').AuthUser;
  const body = await c.req.json().catch(() => null);
  const parsed = TeamRunBodySchema.safeParse(body);
  if (!parsed.success) {
    return c.json(
      { error: 'Invalid body', detail: parsed.error.issues.map((i) => i.message).join('; ') },
      400,
    );
  }
  const webDeps = getWebDeps();
  if (!webDeps?.buildTeam) {
    return c.json({ error: 'Team builder not initialized' }, 503);
  }

  const buildId = `tb-${randomUUID()}`;
  createTeamBuild({
    id: buildId,
    owner_user_id: authUser.id,
    group_folder: parsed.data.groupFolder,
    chat_jid: parsed.data.chatJid,
    goal_text: parsed.data.goalText,
  });

  const input = {
    goalText: parsed.data.goalText,
    background: parsed.data.background,
    acceptanceCriteria: parsed.data.acceptanceCriteria,
    ownerUserId: authUser.id,
    groupFolder: parsed.data.groupFolder,
    chatJid: parsed.data.chatJid,
    userLanguage: parsed.data.userLanguage ?? 'zh-CN',
  };

  // Fire-and-forget（沿用 team-builder.ts buildRunContext().then().catch() 范式）：
  // buildTeam 同步阻塞于 decompose（最坏 240s），放到后台跑，HTTP 立即返回。
  // 成功回写 plan+runId，失败回写 error；进程级 unhandledRejection 已有 logger 兜底。
  webDeps
    .buildTeam(input)
    .then((result) => {
      if ('error' in result) {
        failTeamBuild(buildId, `${result.error}${result.detail ? `：${result.detail}` : ''}`);
        logger.warn({ buildId, err: result.error, detail: result.detail }, 'team build failed');
        return;
      }
      completeTeamBuild(buildId, {
        plan_json: JSON.stringify(result.plan),
        run_id: result.runId,
      });
      logger.info({ buildId, runId: result.runId }, 'team build completed');
    })
    .catch((err: unknown) => {
      failTeamBuild(buildId, (err as Error).message?.slice(0, 500) ?? 'unknown error');
      logger.error({ buildId, err }, 'team build threw');
    });

  return c.json({ ok: true, buildId, status: 'running' });
});

/** GET /api/team/runs/:buildId — 轮询组建状态。owner 校验与 graph 路由一致（404 不泄露存在性）。 */
teamRoutes.get('/runs/:buildId', (c) => {
  const authUser = c.get('user') as import('../types.js').AuthUser;
  const buildId = c.req.param('buildId');
  const row = getTeamBuild(buildId);
  if (!row) return c.json({ error: 'Build not found' }, 404);
  if (row.owner_user_id !== authUser.id && authUser.role !== 'admin') {
    return c.json({ error: 'Build not found' }, 404);
  }
  if (row.status === 'completed') {
    return c.json({
      status: 'completed',
      runId: row.run_id,
      plan: row.plan_json ? JSON.parse(row.plan_json) : null,
    });
  }
  if (row.status === 'failed') {
    return c.json({ status: 'failed', error: row.error ?? 'build failed' });
  }
  return c.json({ status: 'running' });
});
