# 技术方案 — DeepThink 长驻 Supervisor Agent

> 分支：`feat/supervisor-longrunning`
> 关联 PRD：`docs/prd/supervisor-longrunning/PRD.md`
> 作者：DeepThink AI Coder  日期：2026-07-20

## 1. 架构总览

```
┌──────────────────────────────────────────────────────────────┐
│  Backend 进程（由 desktop BackendSupervisor 保活）            │
│                                                               │
│  ┌─────────────────┐        boot           ┌───────────────┐ │
│  │ index.ts main() │ ───────────────────► │ startSuper-   │ │
│  │  - initDB       │                        │ visorLoop()   │ │
│  │  - startSched-  │                        │  + cleanup    │ │
│  │    ulerLoop     │                        │  + recover     │ │
│  └────────┬────────┘                        └──────┬────────┘ │
│           │                                          │          │
│           │  WebDeps.runSupervisor*                 │ tick      │
│           ▼                                          ▼          │
│  ┌─────────────────┐   enqueue   ┌────────────────────────┐ │
│  │ GroupQueue      │ ◄───────── │ supervisor-agent.ts     │ │
│  │  (主 Agent 跑)  │            │  - runSupervisionCheck  │ │
│  └────────┬────────┘            │  - 采集证据(消息+loop)  │ │
│           │                     │  - LLM 评估 → decision  │ │
│           │ storeResult&Notify  │  - 副作用(回喂/收尾)    │ │
│           ▼                     └───────────┬────────────┘ │
│  ┌─────────────────┐                         │ r/w           │
│  │ loop-orchestr-  │ ── stream events ──────│ (订阅         │
│  │ ator.ts (主Agent)│  (loop_review_result)  │  on_iter)    │
│  └─────────────────┘                         ▼              │
│                          ┌──────────────────────────────┐   │
│                          │ SQLite: supervisor_sessions  │   │
│                          │         supervisor_decisions │   │
│                          └──────────────────────────────┘   │
└──────────────────────────────────────────────────────────────┘
```

**数据流**：
1. 主 Agent（loop-orchestrator 或普通对话）在 GroupQueue 上跑，产出消息/loop 状态/trace。
2. Supervisor tick（周期 or 事件）→ `runSupervisionCheck` → 读证据 → LLM → decision → 落库。
3. 若 decision=redirect/escalate → `storePromptMessage(sourceKind='supervisor')` + `queue.enqueueMessageCheck` → 回喂主 Agent 下一轮。
4. 崩溃 → 后端重启 → `startSupervisorLoop` → `cleanupStaleSupervisorChecks` + 扫描 active 会话恢复。

## 2. 数据库设计（`src/db.ts` `initDatabase` 内追加）

### 表 1：`supervisor_sessions`
```sql
CREATE TABLE IF NOT EXISTS supervisor_sessions (
  id                TEXT PRIMARY KEY,             -- 'sup_<uuid>'
  group_folder      TEXT NOT NULL,
  chat_jid          TEXT NOT NULL,
  owner_user_id     TEXT,
  goal_text         TEXT NOT NULL,
  success_criteria  TEXT NOT NULL,
  strategy          TEXT NOT NULL DEFAULT 'periodic',  -- periodic|on_iteration|hybrid
  period_ms         INTEGER NOT NULL DEFAULT 300000,
  max_checks        INTEGER NOT NULL DEFAULT 100,
  bound_loop_run_id TEXT,                          -- nullable
  status            TEXT NOT NULL DEFAULT 'active', -- active|paused|completed|failed|aborted
  consecutive_errors INTEGER NOT NULL DEFAULT 0,
  current_checks    INTEGER NOT NULL DEFAULT 0,
  last_check_at     INTEGER,
  next_check_at     INTEGER,
  started_at        INTEGER NOT NULL,
  ended_at          INTEGER,
  config_json       TEXT,                          -- 预留扩展
  created_at        INTEGER NOT NULL,
  created_by        TEXT
);
CREATE INDEX IF NOT EXISTS idx_supervisor_sessions_status ON supervisor_sessions(status);
CREATE INDEX IF NOT EXISTS idx_supervisor_sessions_chat ON supervisor_sessions(chat_jid);
CREATE INDEX IF NOT EXISTS idx_supervisor_sessions_next ON supervisor_sessions(next_check_at);
```

### 表 2：`supervisor_decisions`
```sql
CREATE TABLE IF NOT EXISTS supervisor_decisions (
  id            TEXT PRIMARY KEY,                  -- 'dec_<uuid>'
  session_id    TEXT NOT NULL,
  turn_index    INTEGER NOT NULL,                  -- check 序号
  action        TEXT NOT NULL,                     -- continue|redirect|escalate|complete|abort|error
  conclusion    TEXT,
  evidence_json TEXT,                              -- [{type,ref,detail}]
  next_action_hint TEXT,
  confidence    REAL,
  trace_summary TEXT,
  triggered_by TEXT,                               -- 'tick'|'event'|'manual'|'recovery'
  status        TEXT NOT NULL DEFAULT 'completed', -- running|completed|error
  started_at    INTEGER NOT NULL,
  ended_at      INTEGER,
  error         TEXT
);
CREATE INDEX IF NOT EXISTS idx_supervisor_decisions_session ON supervisor_decisions(session_id, started_at);
CREATE INDEX IF NOT EXISTS idx_supervisor_decisions_status ON supervisor_decisions(status);
```

**为什么独立两张表而非复用 `loop_runs`**：语义不同——loop_runs 是"被监督的主任务"，supervisor_sessions 是"监督者自身"。复用会污染 loop 查询与状态机。Surgical：只新增，不动既有表语义。

## 3. 后端模块

### 3.1 `src/supervisor-agent.ts`（新增，核心）

导出：
```ts
export type SupervisorStrategy = 'periodic' | 'on_iteration' | 'hybrid';
export type SupervisorSessionStatus = 'active'|'paused'|'completed'|'failed'|'aborted';
export type SupervisorAction = 'continue'|'redirect'|'escalate'|'complete'|'abort';

export interface SupervisorSession { /* 映射表字段 */ }
export interface SupervisorDecision { /* 映射表字段 */ }
export interface SupervisorEvidence { type:'message'|'test'|'file'|'loop_status'; ref:string; detail:string }

// 生命周期
export function generateSupervisorId(): string;             // sup_<uuid>
export async function createSupervisorSession(input): Promise<SupervisorSession>;
export async function getSupervisorSession(id): Promise<SupervisorSession | null>;
export async function listSupervisorSessions(filter): Promise<SupervisorSession[]>;
export async function updateSupervisorSession(id, patch): Promise<SupervisorSession>;
export async function deleteSupervisorSession(id, opts?:{force?:boolean}): Promise<void>;
export async function setSupervisorEnabled(id, enabled): Promise<SupervisorSession>; // toggle

// 决策
export async function listSupervisorDecisions(sessionId, {limit}): Promise<SupervisorDecision[]>;
export function parseSupervisorDecision(raw: string): ParsedDecision | null; // 纯函数，可单测

// 核心检查
export interface SupervisorCheckDeps {
  getRecentMessages: (chatJid, limit) => Promise<Message[]>;
  getBoundLoopRun?: (loopRunId) => Promise<LoopRunSummary | null>;
  sdkQuery: (prompt, opts) => Promise<string>;
  storePromptMessage: (chatJid, text, sourceKind) => Promise<void>;
  enqueueMessageCheck: (chatJid) => Promise<void>;
  broadcastStreamEvent?: (evt) => void;
  now: () => number; // 注入便于测试
}
export async function runSupervisionCheck(sessionId, deps, triggeredBy): Promise<SupervisorDecision>;

// 调度循环（boot 启动）
export interface SupervisorLoopDeps extends SupervisorCheckDeps {
  runningTaskIds?: never; // 不混用
}
export function startSupervisorLoop(deps): void;
export function stopSupervisorLoop(): void;
export async function cleanupStaleSupervisorChecks(): Promise<number>;

// 事件订阅
export async function onLoopEventForSupervisor(event, deps): Promise<void>; // loop_review_result/loop_end
```

**`runSupervisionCheck` 内部流程**：
1. 读 session；若非 `active` → return（不跑）。
2. 若 `current_checks >= max_checks` → 自动 `completed` + notify。
3. 插入一条 `supervisor_decisions` 行 `status='running'`（心跳）。
4. 采集证据：`getRecentMessages(chatJid,30)` + `getBoundLoopRun` 摘要。
5. 拼 prompt（goal/success_criteria/证据/策略上下文）→ `sdkQuery`（maxTurns:1）。
6. `parseSupervisorDecision` 解析 → 若解析失败 → decision `action='error'`，`consecutive_errors++`。
7. 写回 decision：`status='completed'`（或 error），`ended_at`，更新 session：`current_checks++`、`last_check_at=now`、`next_check_at=now+period_ms`、`consecutive_errors`（成功清零/失败累加）。
8. 副作用：按 action 调 `storePromptMessage`+`enqueueMessageCheck`（redirect/escalate）或置会话终态（complete/abort）。
9. 熔断：`consecutive_errors>=5` → `status='failed'`，notify。
10. `broadcastStreamEvent`（`supervisor_check_*`，供前端实时）。

**tick 循环 `startSupervisorLoop`**：
- 单进程内一个 `setInterval`（间隔 `SUPERVISOR_TICK_MS`，默认 15000，从 config 取）。
- 每 tick：`getDueSupervisorSessions(now)` →（`status='active' AND next_check_at<=now`）→ 对每个去重（`activeSupervisorChecks` Set）→ `runSupervisionCheck`（triggeredBy='tick'）。
- 心跳超时：另扫 `active` 会话 `now - last_check_at > period_ms*3` → 标 `degraded`（config_json 内记）+ 强制 check。
- boot 恢复：`cleanupStaleSupervisorChecks()` + `getDueSupervisorSessions` 自然涵盖 active 且到点的会话。

**崩溃恢复路径**：
- check 中途崩溃 → decision 行留 `status='running'`。
- 后端重启 → `startSupervisorLoop` → 首个 tick 前 `cleanupStaleSupervisorChecks` 把 `running` 翻 `error`（对应 decision），session 的 `consecutive_errors++`、`last_check_at` 不变（因此下一 tick 心跳超时检测会再触发一次 recovery check）。
- 内存 `activeSupervisorChecks` Set 在重启时为空，不会卡死。

### 3.2 `src/supervisor-config.ts`（扩展，保持向后兼容）
- 保留旧 `isSupervisorEnabled/setSupervisorEnabled`（per-group JSON）—— 旧 chat header toggle 仍用。
- 新增：DB 级 session toggle 走 `setSupervisorEnabled(sessionId, bool)`（在 `supervisor-agent.ts`，改 session.status）。
- 不破坏现有 `routes/config.ts` `/api/config/supervisor`。

### 3.3 `src/routes/supervisor.ts`（新增，Hono）
- `authMiddleware` 全局；列表/详情按 group 可见性过滤（仿 `routes/tasks.ts`）。
- `POST /` → `createSupervisorSession`；同 group 已有 active → 409。
- `GET /` → `listSupervisorSessions`。
- `GET /:id` → 会话 + 最近 50 decisions。
- `PATCH /:id` → `updateSupervisorSession`（含 `enabled` toggle）。
- `DELETE /:id` → `deleteSupervisorSession`（active 需 `?force=true` 或先 pause）。
- `POST /:id/check` → 手动 `runSupervisionCheck`（triggeredBy='manual'）。
- `GET /:id/decisions` → `listSupervisorDecisions`（分页 `?limit=&offset=`）。
- 在 `src/index.ts` 路由注册区 `app.route('/api/supervisor', supervisorRouter)`。

### 3.4 `src/index.ts` 接线
- 构造 `supervisorDeps`（含 `getRecentMessages`=`getMessagesPage` 包装、`getBoundLoopRun`=`getLoopRun` 包装、`sdkQuery`、`storePromptMessage`、`enqueueMessageCheck`=`queue.enqueueMessageCheck`、`broadcastStreamEvent`）。
- `main()` 内 `startSchedulerLoop(...)` 之后调 `startSupervisorLoop(supervisorDeps)`；`recoverPendingMessages()` 附近调 `cleanupStaleSupervisorChecks()`。
- shutdown 钩子调 `stopSupervisorLoop()`。
- StreamEvent loop 事件分发处：`loop_review_result`/`loop_end` → `onLoopEventForSupervisor(evt, supervisorDeps)`。

### 3.5 `src/types.ts`
- 新增 `SupervisorSessionStatus`、`SupervisorStrategy`、`SupervisorAction`、`SupervisorSession`、`SupervisorDecision` 类型。
- `MessageSourceKind` 已含 `'supervisor'`（types.ts:200），无需改。

## 4. 前端模块

### 4.1 `web/src/api/supervisor.ts`
- `listSupervisors()`、`createSupervisor(input)`、`getSupervisor(id)`、`patchSupervisor(id,patch)`、`deleteSupervisor(id,opts)`、`triggerCheck(id)`、`listDecisions(id,opts)`。

### 4.2 `web/src/stores/supervisor.ts`（Zustand，仿 `stores/loops.ts`）
- state：`sessions[]`、`selectedId`、`decisions[]`、`loading`。
- actions：`fetch()`、`select(id)`、`create()`、`toggle(id,enabled)`、`remove(id)`、`triggerCheck(id)`、`fetchDecisions(id)`、`pollActive()`（5s 轮询 active 会话 decisions）。

### 4.3 `web/src/pages/SupervisorPage.tsx`
- 左：会话列表（status chip / goal 截断 / strategy / period / progress current_checks/max_checks / degraded 标记）。
- 右：选中会话 → 决策时间线（卡片：action 图标色、conclusion、evidence 折叠列表、confidence bar、时间、triggered_by、trace_summary）。
- 顶部「新建 Supervisor」按钮 → 弹窗（goal / success_criteria / strategy select / period number / bound_loop_run_id 可选）。
- 仿 `LoopsPage` / `HarnessPage` 的布局与样式 token。

### 4.4 `web/src/components/supervisor/`
- `SupervisorCard.tsx`、`DecisionCard.tsx`、`CreateSupervisorDialog.tsx`。
- 复用 `components/ui` 既有 Button/Dialog/Badge。

### 4.5 导航与 toggle 接线
- `App.tsx` 路由加 `/supervisor` → `SupervisorPage`。
- 顶部导航/侧栏加 "Supervisor" 入口（仿 Loops）。
- `SupervisorToggle.tsx`：保留现有 per-group toggle；额外加一个"打开 Supervisor 面板"按钮跳转 `/supervisor`。

## 5. 关键算法

### 5.1 决策解析（纯函数，可单测）
```ts
export function parseSupervisorDecision(raw: string): ParsedDecision | null {
  // 剥 markdown fence → 取第一个 {..} → JSON.parse
  // 校验 action ∈ continue|redirect|escalate|complete|abort
  // evidence 数组每项 {type,ref,detail}，type ∈ message|test|file|loop_status
  // confidence clamp [0,1]
  // next_action_hint 仅 redirect 必填校验
}
```

### 5.2 调度去抖
- `activeSupervisorChecks: Set<string>`（session id 级），check 开始 add，finally delete。
- 事件触发去抖：`eventDebounce: Map<sessionId, timer>`，5s 窗口合并为一次。

## 6. 与既有系统边界（Surgical）

| 既有 | 本期改动 |
|------|---------|
| `supervisor.ts`（MVP 意图解析） | **不动**，新子系统并存 |
| `supervisor-config.ts` | 保留旧 API，新增 DB toggle 走 session.status |
| `loop-orchestrator.ts` | **不动**，只读其 loop_run 状态 + 订阅事件 |
| `task-scheduler.ts` | **不动**，Supervisor 有独立 tick loop |
| `group-queue.ts` | **不动**，只调 `enqueueMessageCheck`/`storePromptMessage` |
| `routes/config.ts` `/api/config/supervisor` | 保留（per-group toggle），新增 `/api/supervisor` |
| `db.ts` | 仅**新增** 2 表 + 索引，不改既有表 |
| `types.ts` | 仅**新增**类型 |
| `index.ts` | 仅**新增**接线点（boot + 事件分发 + 路由注册） |

## 7. 测试策略
- 单测优先，纯函数全覆盖（parse、状态推进、去抖、熔断、心跳超时）。
- `runSupervisionCheck` 用 mock deps（mock sdkQuery 返回固定 JSON、mock queue/store）验证副作用。
- `cleanupStaleSupervisorChecks` / boot 恢复用临时 in-memory sqlite（仿既有测试）。
- 前端：typecheck + 关键组件渲染快照。
- `make typecheck && make test` 必须全绿。

## 8. 风险与缓解
| 风险 | 缓解 |
|------|------|
| Supervisor LLM 调用失败导致卡死 | maxTurns:1 + 超时 + consecutive_errors 熔断 |
| 回喂消息无限循环（redirect→check→redirect） | `current_checks` 上限 + `max_checks` 硬截断 + continue 不回喂 |
| tick 与事件并发同会话 | `activeSupervisorChecks` Set 去重 |
| 崩溃后 next_check_at 漂移 | boot `cleanupStale` + 心跳超时强制 recovery check |
| per-group toggle 与 DB session toggle 语义混淆 | 文档区分：前者"前置意图解析 MVP 开关"，后者"长驻会话开关"；前端 toggle 分别入口 |
