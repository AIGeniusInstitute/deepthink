# PRD：超级 Agent 团队 —— 异步组建（Async Team Build）

> 状态：v1
> 分支：`feat/team-async-build`
> 日期：2026-07-23
> 关联：`docs/issues/2026-07-23-team-run-request-timeout.md`（前置 issue：前端超时修复）、`docs/prd/super-agent-team/PRD.md`（Super Agent Team 主体）

---

## 0. 背景与动机

`POST /api/team/runs` 当前是**同步阻塞**请求：后端 `buildTeam()` 在返回响应前必须完成 `decompose()`（LLM 分解，单次 120s、失败重试一次 → 最坏 240s）+ 成员创建 + graph 注册启动。前端只能干等。

前置 issue（2026-07-23）已把前端超时从 150s 提到 280s 以覆盖最坏 240s，但这是**兜底补丁**，脆弱性仍在：

1. **长时阻塞 HTTP 请求**：单次请求挂起最久 240s，任何中间代理 / 网关 / 浏览器的隐性 idle 超时都可能再次掐断（280s 已逼近 Node/Vite 默认 `requestTimeout` 300s）。
2. **无进度反馈**：用户盯着 spinner 240s，看不到分解进度。
3. **不可恢复**：前端刷新/关闭页面即丢失这次 build，后端虽可能继续，但前端拿不到结果。

本 PRD 把 `/api/team/runs` 改为**异步生命周期**：立即返回 `buildId`，分解+组建在后台 detached 执行，前端轮询拿 `plan` 与 `runId`。彻底消除长时间阻塞 HTTP 请求这一脆弱模式。

## 1. 目标

**需求1（异步化）**：`POST /api/team/runs` 立即返回 `{ buildId, status: 'running' }`（<100ms），`buildTeam`（decompose + 成员创建 + graph 注册启动）在后台 detached 执行，结果写入持久化的 `team_builds` 记录。

**需求2（轮询拿结果）**：新增 `GET /api/team/runs/:buildId`，返回 build 状态（`running` / `completed` / `failed`）及完成时的 `{ plan, runId }`。前端轮询至终态后渲染 DAG 并进入既有 graph run 轮询。

**需求3（可恢复）**：build 记录持久化到 DB，页面刷新后可凭 `buildId` 继续轮询拿结果，不再因刷新丢失。

**需求4（向后兼容）**：`TeamPage` 渲染契约不变——仍通过 `lastRunId + lastPlan` 进入 DAG 可视化；`buildTeam` 幂等性（同 teamName+member.name 复用）不变。

## 2. 设计原则

1. **Surgical Changes**：`team-builder.ts` 核心算法（decompose/assemble/start）**零改动**——异步化只发生在路由层与前端 store，`buildTeam` 签名与返回值不变。
2. **Simplicity First**：build 记录用一张极简 `team_builds` 表（id + status + plan_json + run_id + error + 时间戳），不引入通用 job 框架 / 队列 / worker pool。后台执行用既有 fire-and-forget 模式（`promise.then(...).catch(...)` + logger）。
3. **复用既有轮询范式**：前端轮询复用 `stores/graph.ts` 的 GET + 定时器 + 停止条件范式。
4. **不破坏既有契约**：`/api/graph/runs/:id`、`GraphPage` 可视化、graph run 轮询全部不变。

## 3. 功能点与验收标准

### 功能点 1：`team_builds` 持久化记录 — P0

**描述**：新增 DB 表 `team_builds`，字段：`id`(text PK)、`owner_user_id`、`group_folder`、`chat_jid`、`goal_text`、`status`('running'|'completed'|'failed')、`plan_json`(nullable)、`run_id`(nullable)、`member_def_ids_json`(nullable)、`error`(nullable)、`created_at`(int ms)、`updated_at`(int ms)。配套 `createTeamBuild / getTeamBuild / completeTeamBuild / failTeamBuild` 四个 db 函数。

**验收标准**：
- AC1.1 表在启动时自动建（migration 顺延，不动既有列）。
- AC1.2 `createTeamBuild` 插入 status='running' 行并返回 id；`getTeamBuild(id)` 读出；`completeTeamBuild(id,{plan,runId,memberDefIds})` 置 status='completed' 并写 plan_json/run_id；`failTeamBuild(id,error)` 置 status='failed'。
- AC1.3 并发安全：同 owner 多次发起 build 各得独立 buildId，互不串扰。

### 功能点 2：`POST /api/team/runs` 异步化 — P0

**描述**：路由改为：①校验 body → ②`createTeamBuild` 建行 → ③`webDeps.buildTeam(input)` **fire-and-forget**（`.then` 成功→`completeTeamBuild`，失败→`failTeamBuild`）→ ④立即 `200 { ok:true, buildId, status:'running' }`。

**验收标准**：
- AC2.1 响应在 <1s 内返回（不再阻塞于 decompose）。
- AC2.2 后台 buildTeam 成功 → 记录 status='completed' + plan_json + run_id；失败 → status='failed' + error。
- AC2.3 后台异常被 `.catch` 兜住写 failTeamBuild，不 crash 进程（unhandled rejection 兜底）。
- AC2.4 鉴权（authMiddleware）与 body schema 不变。

### 功能点 3：`GET /api/team/runs/:buildId` 轮询端点 — P0

**描述**：新增 GET 路由，返回 `{ status, plan?, runId?, memberDefIds?, error? }`。仅返回当前 auth user 自己的 build（owner 校验）。

**验收标准**：
- AC3.1 status='running' → `{ status:'running' }`（无 plan）。
- AC3.2 status='completed' → `{ status:'completed', plan, runId, memberDefIds }`。
- AC3.3 status='failed' → `{ status:'failed', error }`。
- AC3.4 非 owner 请求 → 403；不存在的 buildId → 404。

### 功能点 4：前端 store 异步轮询 — P0

**描述**：`web/src/stores/team.ts` 的 `buildTeam()` 改为：①POST 拿 buildId → ②每 2s GET `/api/team/runs/:buildId` 轮询 → ③终态写入 `lastRunId/lastPlan`（completed）或 `error`（failed）→ ④`reset()` 取消轮询。移除原 280s 单次超时。

**验收标准**：
- AC4.1 POST 即返回（<1s），UI 进入 building 态并轮询。
- AC4.2 completed → `lastRunId/lastPlan` 被设置，TeamPage 渲染 DAG（与改动前行为一致）。
- AC4.3 failed → `error` 被设置并展示。
- AC4.4 `reset()` / 组件卸载 → 停止轮询，无泄漏定时器。
- AC4.5 轮询期间单次 GET 用默认超时（8s），不再有 240s 长超时。

## 4. 非目标（P1+）

- 不做 build 进度百分比（decompose 内部不暴露阶段）。
- 不做多 build 列表 / 历史 build 管理 UI。
- 不重构 `team-builder.ts` 算法本身。

## 5. 风险

- **后台 buildTeam 失败无人知**：靠 `failTeamBuild` 写 error + 前端轮询读到 failed 展示。兜底：进程级 `unhandledRejection` 已有 logger。
- **僵尸 running 行**：若进程在 build 中途 crash，行卡在 'running'。P0 不做自动清理（重启后前端轮询会一直 running——可接受，后续可加超时扫描）。文档记录。

## 6. 测试用例（摘要）

| # | 场景 | 预期 |
|---|---|---|
| T1 | 小任务（decompose 一次成功 ~20s） | POST 即返 buildId；轮询 ~20s 后 completed，DAG 渲染 |
| T2 | 超大任务（decompose 重试/慢，~200s） | POST 即返；轮询期间 UI 持续 building；终态 completed/failed，**不再有 Request timeout** |
| T3 | buildTeam 报错 | 终态 failed，前端展示 error |
| T4 | 轮询中 reset | 停止轮询，无定时器泄漏 |
| T5 | 非 owner GET | 403 |
| T6 | 不存在 buildId GET | 404 |
