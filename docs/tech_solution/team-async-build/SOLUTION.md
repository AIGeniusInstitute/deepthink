# 技术方案：超级 Agent 团队 —— 异步组建（Async Team Build）

> 分支：`feat/team-async-build`
> 关联 PRD：`docs/prd/team-async-build/PRD.md`

## 1. 选型决策

**为何新增 `team_builds` 表而非复用 `graph_runs`**：`graph_runs.definition_id` 为 `NOT NULL` + FK（`src/db.ts:494,510`），而 decompose 之前没有 graph definition。若复用 graph_runs 承载 build 期，要么放开 NOT NULL（侵入核心 graph 表 schema，违反 Surgical），要么预占一个假 definition（污染定义表）。故新增极简 `team_builds` 表与 graph_runs 解耦：build 完成后 `run_id` 指向 `buildTeam` 内部正常 `startGraphRun` 产出的 graph_run。

**为何不动 `team-builder.ts`**：异步化只发生在"何时返回响应"这一层，`buildTeam` 的算法（decompose → create members → assemble → register → start → detached execute）与签名（`buildTeam(input, deps): Promise<TeamBuildResult | TeamBuildError>`）保持不变。路由层 fire-and-forget 调用它，结果回写 `team_builds`。

## 2. 改动清单

| 文件 | 改动 | 性质 |
|---|---|---|
| `src/db.ts` | 新增 `team_builds` 建表（schema 块）+ 4 个函数 `createTeamBuild/getTeamBuild/completeTeamBuild/failTeamBuild` + `TeamBuildRow` 类型 | 新增 |
| `src/routes/team.ts` | POST `/runs` 改为建行+fire-and-forget+立即返回 buildId；新增 GET `/runs/:buildId` | 改+新增 |
| `web/src/stores/team.ts` | `buildTeam()` 改 POST+轮询 GET；移除 280s 长超时；`reset()` 取消轮询 | 改 |
| `src/agent-team/team-builder.ts` | **不动** | — |
| `web/src/pages/TeamPage.tsx` | **不动**（已有 `startPolling(lastRunId)` 与 `lastPlan` 预览，异步后行为一致） | — |

## 3. DB schema

```sql
CREATE TABLE IF NOT EXISTS team_builds (
  id TEXT PRIMARY KEY,
  owner_user_id TEXT NOT NULL,
  group_folder TEXT NOT NULL,
  chat_jid TEXT NOT NULL,
  goal_text TEXT NOT NULL,
  status TEXT NOT NULL DEFAULT 'running'
    CHECK(status IN ('running','completed','failed')),
  plan_json TEXT,
  run_id TEXT,
  error TEXT,
  created_at INTEGER NOT NULL,
  updated_at INTEGER NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_team_builds_owner ON team_builds(owner_user_id, created_at DESC);
```

幂等：`CREATE TABLE IF NOT EXISTS`，fresh/existing DB 都安全，无需 ALTER/version gate（与 `graph_runs` 同范式，`src/db.ts:491`）。

## 4. 后端流程

### POST `/api/team/runs`
```
1. authUser = c.get('user'); 校验 body（TeamRunBodySchema 不变）
2. buildId = `tb-${crypto.randomUUID()}`
3. createTeamBuild({ id: buildId, owner_user_id, group_folder, chat_jid, goal_text, status:'running' })
4. // fire-and-forget（沿用 team-builder.ts:261 的 .then().catch() 范式）
   webDeps.buildTeam(input)
     .then(result => 'error' in result
       ? failTeamBuild(buildId, result.error + (result.detail?`: ${result.detail}`:''))
       : completeTeamBuild(buildId, { plan_json: JSON.stringify(result.plan), run_id: result.runId }))
     .catch(err => failTeamBuild(buildId, (err as Error).message))
5. return c.json({ ok:true, buildId, status:'running' })
```
进程级 `unhandledRejection` 已有 logger 兜底（`src/logger.ts:28`），双重保险。

### GET `/api/team/runs/:buildId`
抄 `routes/graph.ts:127` 范式：authMiddleware + owner 校验 + 404/403 + `c.json`。
```
row = getTeamBuild(buildId)
if !row → 404
if row.owner_user_id !== authUser.id && role!=='admin' → 404（与 graph 一致，不泄露存在性）
status:
  'running'   → { status:'running' }
  'completed' → { status:'completed', plan: JSON.parse(plan_json), runId: run_id }
  'failed'    → { status:'failed', error }
```

## 5. 前端流程（`web/src/stores/team.ts`）

```
buildTeam(input):
  set building=true, error=null, lastRunId=null, lastPlan=null
  data = POST /api/team/runs (input)   // <1s 返回
  buildId = data.buildId
  pollToken = ++currentPollToken       // 模块级，reset() 时令其失效
  loop:
    res = GET /api/team/runs/:buildId   // 默认 8s 超时
    if pollToken !== currentPollToken: return  // 已被 reset 取消
    if res.status==='completed':
      set lastRunId=res.runId, lastPlan=res.plan, building=false; return
    if res.status==='failed':
      set error=res.error, building=false; return
    await sleep(2000)                   // 2s 间隔（与 graph store 5s 同范式，build 期更敏感取 2s）
reset():
  currentPollToken++  // 使正在跑的轮询自停
  set building=false, error=null, lastRunId=null, lastPlan=null
```
不再有 280s 单次超时；每次 GET 用默认 8s，单次失败（网络抖动）不致命——下一轮重试。

## 6. 终态衔接
completed → `lastRunId` 被设 → `TeamPage.tsx:49` 的 `useEffect([lastRunId])` 自动 `startPolling(lastRunId)`（graph store 5s 轮询 `/api/graph/runs/:id`）→ `GraphDagView` 渲染。与改动前行为完全一致，`lastPlan` 预览也由轮询拿到。无需改 TeamPage。

## 7. 风险与兜底
- **僵尸 running 行**：进程 crash 在 build 中途 → 行卡 running，前端轮询不收敛。P0 不做自动清理（接受）；后续可加 `created_at < now-10min 且 status='running'` 的启动期扫描置 failed。文档记录。
- **owner 校验**：与 graph 一致用 404（不泄露存在性）。
- **并发**：`createTeamBuild` 各行独立 PK（uuid），无串扰。
