# 技术方案：Loop Engineering v2

分支：`feat/loop-engineering-v2`  
关联 PRD：`docs/prd/loop-engineering-v2/PRD.md`  
作者：AI Coder  日期：2026-07-08

## 0. 现状摸底（已核实）

| 模块 | 文件 | 状态 |
|------|------|------|
| 后端状态机 | `src/loop-orchestrator.ts` (587 行) | ✅ 可用，4 种 kind 的执行+评审+迭代闭环已通 |
| 斜杠命令 | `src/loop-commands.ts` (319 行) + `src/index.ts:1499-1510` dispatch | ✅ 主对话框 `/goal /loop /schedule /proactive /cancel /loops` 已接入 |
| API 路由 | `src/routes/loops.ts` (124 行) | ✅ `GET /api/loops`、`/:id`、`/:id/trace`、`/:id/cancel`、`/:id/usage` |
| DB 表 | `loop_runs` / `loop_iterations` / `loop_trace_nodes` + `scheduled_tasks.loop_kind/loop_run_id` | ✅ schema v41 |
| 前端独立页 | `web/src/pages/LoopsPage.tsx` + `LoopDagPanel.tsx` + `stores/loops.ts` | ✅ 但与主对话框割裂 |
| SubAgent | `container/agent-runner/src/agent-definitions.ts` | ✅ code-reviewer / web-researcher，**无 Supervisor** |
| 顶栏 | `web/src/components/chat/ChatView.tsx:564` | 渲染 `{group.name}` 原始值 |

## 1. 改动总览

```
后端 (src/)
├── db.ts                         # v41→v42: messages +loop_run_id 列
├── loop-orchestrator.ts          # +adaptive/skill_evolution 分支 + suggested_next_turns
├── loop-commands.ts              # +handleAdaptiveCommand / handleSkillEvolutionCommand
├── routes/loops.ts               # +PATCH /api/loops/:id/trace/:nodeId (编辑回写)
├── supervisor.ts                 # 【新】Supervisor 决策器（delegate/clarify/auto）
├── agent-supervisor-integration.ts # 【新】主消息流接入 Supervisor 钩子
└── index.ts                      # dispatch +adaptive/+skill_evolution；Supervisor 拦截入口

容器 (container/agent-runner/src/)
└── agent-definitions.ts          # +supervisor SubAgent 定义

前端 (web/src/)
├── components/chat/
│   ├── ChatView.tsx              # 顶栏宣传语；Supervisor 开关；LoopModeSwitcher 挂载
│   ├── MessageInput.tsx          # +mode prop，展开 goal/cron/maxTurns 字段
│   ├── MessageBubble.tsx         # 检测 message.loop_run_id → 渲染 InlineLoopCard
│   ├── InlineLoopCard.tsx        # 【新】实时 DAG + 进度 + 取消
│   ├── LoopModeSwitcher.tsx      # 【新】输入区 4 chip
│   └── SupervisorToggle.tsx      # 【新】顶栏开关
├── components/loops/
│   └── LoopDagPanel.tsx          # 增强：横向 SVG 流程 + 节点编辑
├── stores/
│   ├── loops.ts                  # +adaptive/skill_evolution kind；+editTraceNode
│   ├── chat.ts                   # +supervisorMode 持久化
│   └── messages.ts               # 消息类型 +loop_run_id 字段
└── api/client.ts                 # 无改动

类型 (shared/)
└── stream-event.ts               # 无改动（复用 loop_* 事件）
```

## 2. 详细设计

### 2.1 DB 迁移 v41 → v42

`src/db.ts`：

```sql
ALTER TABLE messages ADD COLUMN loop_run_id TEXT;
```

`SCHEMA_VERSION = '42'`。messages 表 SELECT / INSERT 语句同步加列（影响 `db.ts` 中 4 处 messages SQL，逐一加）。

`storeMessageDirect` opts 增加 `loopRunId?: string`，写入时落库。回放（`getMessages`）返回该字段。

### 2.2 顶栏宣传语（Req4）

`web/src/components/chat/ChatView.tsx:564` 改造：

```tsx
// 原：<h2>{group.name}</h2>
// 新：
<h2 className="...truncate">
  {isDefaultHomeName(group.name, currentUser) 
    ? <SloganRotator /> 
    : <>{group.name} <span className="block text-xs text-muted-foreground"><SloganRotator /></span></>}
</h2>
```

`SloganRotator`（新组件，`web/src/components/chat/SloganRotator.tsx`）：15s 切换一条，`localStorage('deepthink:slogan-index')` 记忆。语条见 PRD §1.4。

`isDefaultHomeName` 复用 `ChatGroupItem.tsx:53-56` 的同名逻辑，提取到 `web/src/lib/group-name.ts` 共享。

### 2.3 输入区模式切换器（Req1）

新组件 `web/src/components/chat/LoopModeSwitcher.tsx`：

```tsx
type LoopMode = 'chat' | 'goal' | 'time' | 'proactive';
// chip: 💬 对话 | 🎯 目标 | 🔄 时间 | 🤖 主动
// 选中非 chat 时，MessageInput 下方展开表单：
//   goal:      [目标描述] [成功标准(选填)] [最大轮次 默认5]
//   time:      [间隔/选择: 5m/30m/1h/自定义cron] [任务描述]
//   proactive: [cron] [目标] [□ 并行]
// 发送时构造斜杠命令字符串：/goal X max_turns=N / /loop 5m X / /proactive cron X workflow=parallel
// 走原 onSend，复用后端 dispatch，零新 API
```

`MessageInput` 增加 `mode` 受控 prop，`ChatView` 持有 `loopMode` 状态，切换时展开/收起表单。发送后重置为 `chat`。

**为何不新增 API**：UI 只是斜杠命令的语法糖，复用 `src/index.ts:1499-1510` 的 dispatch，避免重复实现校验/调度。

### 2.4 内联 LoopRunCard（Req2.1）

#### 2.4.1 消息绑定 loop_run_id

`src/index.ts` 的 `handleGoalLoopCommand` 等返回字符串后，主流程把该字符串作为 bot 消息存入 DB。改造：在 `resolveLoopCommandDeps` 返回里增加 `attachLoopRunId(loopRunId)` 回调；命令 handler 在返回前调用，把 `loop_run_id` 写入本次回复消息。

具体实现：`handleXxxLoopCommand` 返回 `{ reply: string; loopRunId?: string }` 而非纯 string。`src/index.ts` 的命令 dispatch 处（约 1499 行）拿到后，调 `sendMessage(chatJid, reply, { loopRunId })` → `storeMessageDirect` 落库。

#### 2.4.2 前端 InlineLoopCard

`web/src/components/chat/MessageBubble.tsx`：

```tsx
if (message.loop_run_id && message.is_from_me) {
  return <InlineLoopCard loopRunId={message.loop_run_id} initialText={message.content} />;
}
// 否则走原渲染
```

`InlineLoopCard.tsx`：

```tsx
// 轮询：loop active 时 5s 一次 /api/loops/:id + /api/loops/:id/trace
// 头部：emoji+目标+turn N/M+状态+取消
// 中部：<LoopDagPanel roots={traceRoots} realtime={isActive} />
//   active 时：running 节点 pulse 动画
// 尾部：token/cost 汇总 + 折叠/展开
// loop 终态（completed/failed/cancelled）停止轮询
```

复用 `stores/loops.ts` 的 `fetchLoopDetail` / `fetchLoopTraceTree` / `cancelLoop`。

### 2.5 DAG 节点抽屉 + 编辑回写（Req2.1）

`LoopDagPanel.tsx` 增强：

1. **横向 SVG 流程**：保留缩进树作为 fallback，新增 `layout='flow'` 模式：
   - 节点用 `<rect>` + `<text>` 绘制
   - 父子关系用 `<path>` 带箭头
   - 节点坐标用简易层级布局算法（每层 x 等距，同层 y 居中）
2. **节点编辑**：`TraceDetailDrawer` 对 `loop.status === 'completed'` 的节点显示「✏️ 编辑 output」按钮：
   - 点击 → `<textarea>` 编辑 `output_summary`
   - 保存 → `PATCH /api/loops/:id/trace/:nodeId` { output_summary }
   - 后端写回 DB，并记 `edited_at`（新增列 `loop_trace_nodes.edited_at TEXT`，v42 一并迁移）

`src/routes/loops.ts` 新增：

```ts
loopsRoutes.patch('/:id/trace/:nodeId', authMiddleware, (c) => {
  // 鉴权 + 校验 loop.status==='completed'
  // updateLoopTraceNode(nodeId, { output_summary, edited_at: now })
});
```

### 2.6 adaptive 与 skill_evolution（Req2.2/2.3）

#### 2.6.1 类型扩展

`src/loop-orchestrator.ts`：

```ts
export type LoopKind = 'goal' | 'loop' | 'schedule' | 'proactive' | 'adaptive' | 'skill_evolution';
```

`web/src/stores/loops.ts` `LoopRun.kind` 联合类型同步。

#### 2.6.2 adaptive 分支

新增 `executeAdaptiveLoop(ctx, deps)`：

- 复用 `runOneIteration` + `runReviewer`
- 评审返回增加 `suggested_next_turns`：扩展 `buildReviewerPrompt`，让评审器输出 JSON `{ result, reason, suggested_next_turns }`
- `parseReviewResult` 兼容新字段
- 每轮后：若 `result==='needs_improvement'` 且连续 3 轮 `reason` 无变化 → `failed`（无进展检测）
- max_turns 动态：`effectiveMax = min(currentMax + suggested_next_turns, HARD_LIMIT)`

#### 2.6.3 skill_evolution 分支

新增 `executeSkillEvolutionLoop(ctx, deps)`：

- `success_criteria` 必须是可执行测试命令（如 `node tests/skills/foo.test.js`）
- 每轮：
  1. `runOneIteration`（prompt 要求 agent 修改 skill 文件使测试通过）
  2. 执行测试命令（`exec` in container/host，复用 `src/script-runner.ts`）
  3. 测试 exit 0 → `completed`；否则 `needs_improvement`，注入失败输出进下一轮
- 不走 sdkQuery 评审，测试结果即评审

#### 2.6.4 命令

`src/loop-commands.ts` 新增：

```
/adaptive <goal> [max_turns=N]   — 自适应循环
/skill_evolution <skill_path> <test_cmd> [max_turns=N] — 技能自进化循环
```

`src/index.ts` dispatch 加 `case 'adaptive'` / `case 'skill_evolution'`。

前端 `LoopModeSwitcher` 增加 2 个 chip（或在「高级」折叠区），`stores/loops.ts` `KIND_LABELS` 增加：
```
adaptive: '🧬 自适应',
skill_evolution: '🧪 技能自进化',
```

### 2.7 Supervisor Agent（Req3）

#### 2.7.1 SubAgent 定义

`container/agent-runner/src/agent-definitions.ts`：

```ts
export const PREDEFINED_AGENTS = {
  // ... existing
  'supervisor': {
    description: 'Human-delegated supervisor that interprets user intent, dispatches to main agent, and reviews output',
    prompt: SUPERVISOR_PROMPT,  // 见 PRD §3.2
    tools: [],  // 不直接调工具，只做意图解析
    model: process.env.SUPERVISOR_MODEL || 'inherit',
    maxTurns: 5,
  },
};
```

#### 2.7.2 消息流拦截

新文件 `src/supervisor.ts`：

```ts
export async function withSupervisor(
  userMessage: string,
  ctx: { chatJid; ownerUserId; groupFolder; userLanguage; history: Message[] },
  runMainAgent: (instruction: string) => Promise<string>,
): Promise<SupervisorOutcome> {
  // 1. 调 supervisor SubAgent (sdkQuery with agents option)
  //    让其输出 JSON: { action: 'delegate'|'clarify'|'auto', instruction?: string, question?: string }
  // 2. clarify → 直接返回 question 给用户
  // 3. delegate/auto → 调 runMainAgent(instruction)
  //    再调 supervisor 复审: { action: 'accept'|'retry', reason? }
  //    accept → 返回主 agent 输出
  //    retry → 注入 reason 重发（最多 3 轮）
}
```

#### 2.7.3 接入主消息流

`src/index.ts` 消息处理处：当 group 开启 supervisor（存在 `data/config/supervisor-enabled.json` 或 group 级开关），调 `withSupervisor` 包裹原 `runContainerAgent/runHostAgent`。

Supervisor 产生的中间消息（clarify 问题、retry reason）通过 `storeResultAndNotify` 存为 `source_kind='supervisor'` 消息，前端 `MessageBubble` 渲染紫色 🧭 头像。

#### 2.7.4 前端

- `SupervisorToggle.tsx`：顶栏开关，`PUT /api/config/supervisor` 持久化（per-group）
- `stores/chat.ts`：`supervisorEnabled: boolean`，`toggleSupervisor()`
- `MessageBubble.tsx`：`message.source_kind === 'supervisor'` 时渲染 🧭 头像 + 紫色边框

### 2.8 配置持久化

新增 `data/config/supervisor-enabled.json`：

```json
{ "groups": { "web:main": true, "feishu:oc_xxx": false } }
```

`src/runtime-config.ts` 增加读写函数（参考已有 `system-settings.json` 模式）。`src/routes/config.ts` 增加 `GET/PUT /api/config/supervisor`。

## 3. 数据流（关键时序）

### 3.1 UI 启动 goal loop

```
用户点 🎯 目标 chip → MessageInput 展开表单
  → 填 "修复 README 错字" max_turns=5
  → onSend("/goal 修复 README 错字 max_turns=5")
→ chat store sendAgentMessage → POST /api/chat/send
→ index.ts dispatch 'goal' → handleGoalLoopCommand
  → createLoopRunRecord + executeGoalLoop(background)
  → return { reply: "🎯 已启动... ID: xxx", loopRunId: "xxx" }
→ sendMessage(chatJid, reply, { loopRunId }) → storeMessageDirect
→ WS new_message → 前端 MessageBubble 见 loop_run_id
→ InlineLoopCard 5s 轮询 /api/loops/:id + /trace
→ 每次 iteration/review → loop_* stream event → WS push → 卡片更新
→ loop completed → 停轮询，显示最终输出
```

### 3.2 Supervisor 拦截

```
用户消息 → index.ts
→ if (supervisorEnabled[chatJid]):
    withSupervisor(msg, ctx, runMainAgent)
      → sdkQuery(supervisor, msg) → { action: 'delegate', instruction }
      → runMainAgent(instruction) → output
      → sdkQuery(supervisor, review) → { action: 'accept' }
      → return output
  else:
    runMainAgent(msg) directly
→ storeResultAndNotify
```

## 4. 验证策略

| 场景 | 验证 |
|------|------|
| 顶栏 | 进入主页，看不到 "admin Home"，见宣传语，15s 后切换 |
| 模式切换器 | 点 🎯 目标，输入框展开 3 字段，发送后表单收起 |
| 内联 DAG | 主对话框发 /goal，消息流出现卡片 + DAG，每轮更新 |
| 节点编辑 | loop 完成后，点 DAG 节点 → 抽屉 → 编辑 output → 保存 → 刷新仍在 |
| adaptive | `/adaptive 探索一个排序算法 max_turns=8`，观察 max_turns 动态变化 |
| skill_evolution | `/skill_evolution tests/skills/demo.test.js "node tests/skills/demo.test.js"` |
| Supervisor | 开关开启，发 "帮我写个 hello world"，先见 🧭 紫色消息再见主回复 |
| typecheck | `make typecheck` 全绿 |
| test | `make test` 全绿 |

## 5. 回滚

- 全部改动在 `feat/loop-engineering-v2` 分支，未合并不影响 main
- DB v42 迁移仅加列，向后兼容（旧代码不读新列）
- Supervisor 默认关闭，不影响现有流
- 新 kind 字符串不影响旧 kind 的调度

## 6. 不做的事

- 不引入 react-flow（SVG 自绘）
- 不改 IM 斜杠命令协议
- 不重写 loop-orchestrator 状态机
- 不做 Supervisor 多轮外呼工具调用
- 不改 /loops 独立页面（保持向后兼容）
