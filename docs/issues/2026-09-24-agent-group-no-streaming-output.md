# Agent 群组（swarm）对话没有流式输出、实时气泡为空白、席位不继承技能/MCP/知识库

> 承接 [`2026-09-23-agent-group-message-no-response.md`](./2026-09-23-agent-group-message-no-response.md)。
> 上一个 issue 修好了「席位根本不执行」，本 issue 修的是「执行了但用户看不到」——即流式渲染与挂载能力对齐。

## 1. 用户现象

在「唯心唯物辩论」群组页（`/agent-groups/web:swarm:546f318b-...`）：

- 发消息后**对话框没有任何输出**：新出现的席位气泡是**空的**（有气泡框、有头像，就是没字）；
- 席位回复**不流式**：只有手动刷新页面后才突然整段出现，且是未渲染的原始文本；右侧 Pipeline 面板也不会跟着这条消息跑起来；
- 输入框上方**没有**「技能 / MCP 工具 / 知识库」工具栏 —— 席位跑起来时也没有任何挂载能力。

期望（用户原话）：**复用现有的 Agent 对话流式输出逻辑，同时具备现有的 agent 挂载 skill、mcp、知识库的能力，在群组对话里实时流式输出响应。**

## 2. 问题描述

上一个 issue 之后，后端其实已经在正确地把 `stream_event` 推到 swarm 的 chatJid 上，**问题全在前端与挂载链路**：

1. `GroupChatArea` 的 WS 处理器**只认识 `group_message_created`** 一种事件，席位的 `text_delta` 被直接丢弃 → 没有任何逐字输出。
2. 收到 `group_message_created` 后，它把事件载荷 `{...event.groupMessage}` 直接塞进消息列表，而事件里的正文字段叫 **`content`**；渲染层读的却是 **`contentRef`**（`GET /messages` 的字段名）→ **永远是空白气泡**。
3. 席位的原始 `text_delta` 只带一个不透明的 `turnId`（`graph-xxx-seat-1`），前端**无法把这段文字归属到某个席位** → 即使监听也画不出来。
4. swarm 的 `POST /messages` 不接受 `selectedMounts`，页面也没有挂载工具栏 → 席位与普通对话**能力不对等**（普通对话的 `ChatView` 会把 skills/mcp/kb 随消息带上）。

## 3. 根因

### 3.1 前端只处理一种事件，且字段名错位

`web/src/components/agent-group/GroupChatArea.tsx`（修复前）：

```tsx
const unsub = wsManager.on('stream_event', (data: any) => {
  if (data?.chatJid !== groupJid) return;
  const event = data.event;
  // ← 只认这一种；text_delta / graph_node_start 全被丢弃
  if (event?.eventType !== 'group_message_created' || !event.groupMessage) return;
  appendMessage({
    ...event.groupMessage,      // ← 带的是 content
    mentions: [],
    parentMsgId: null,
  } as GroupMessage);
});
```

```tsx
// 渲染层（同一个文件）
<div className="whitespace-pre-wrap break-words">{msg.contentRef ?? ''}</div>
//                                                         ↑ undefined → 空气泡
```

`groupMessage.content` 与 `GroupMessage.contentRef` 是同一个值的两个名字：WS 事件（`src/agent-group/swarm-runner.ts` 的 `groupMessageCreatedEvent`）用 `content`，REST（`msgToJson`）用 `contentRef`。前端把前者原样塞进后者的类型里，TypeScript 的 `as GroupMessage` 断言又把这条缝盖住了。刷新页面走 `GET /messages`（`contentRef` 有值）所以能看到历史，实时追加的那条永远是空的 —— 这正是用户说的「对话框没有任何输出」。

### 3.2 席位流式文本无法归属（后端缺口）

修复前，一次真实运行的 WS 帧统计（隔离实例，见 §9）：

| 事件 | 次数 | 携带的信息 |
|------|------|-----------|
| `text_delta` | 14 | 只有 `turnId: graph-<runId>-seat-1`，**没有 seatId** |
| `graph_node_start/end` | 2 / 2 | `graphEvent.nodeId = seat-1 / seat-2` |
| `group_message_created` | 2 | 节点**跑完**才发 |

即：文字是有的，但它是「某个 graph 节点的内部流」，swarm 页面没有任何办法把它挂到左边的席位气泡上。

### 3.3 挂载能力不对等

- 普通对话：`web/src/components/chat/ChatView.tsx:434` 把 `useChatMountsStore` 的选择映射成 `selectedMounts` 随 POST 发出；后端 `src/container-runner.ts` 的 `applyTurnMounts()` 负责把它变成 `systemPrompt` 里的 skill 内容 + `mounts[]` 里的 MCP / 知识库。
- swarm：`src/routes/agent-groups.ts` 的 `SendMessageSchema` 根本没有 `selectedMounts` 字段，页面也没有 `ChatToolbar`。

- 另外，swarm 席位节点在 `runAgentNode` 里构造的「合成群组」**从不设置 `created_by`**（只有绑定了真实 Agent 定义时才设），而 `applyTurnMounts` / `loadUserPlugins` / `loadUserMcpServers` / 用户级全局记忆**全部以 `group.created_by` 为 owner 依据** → 即使传了 mounts 也解析不到归属。

## 4. 复现路径

1. 打开 Agent 群组详情页（`/agent-groups/web:swarm:<uuid>`）；
2. 发一条消息，**不要刷新页面**；
3. 观察：几秒后出现一个**空白**的席位气泡；整段回复只在刷新后才出现，且不流式；
4. 观察输入框上方：没有技能 / MCP / 知识库下拉；
5. 查库确认后端其实写成功了（`group_messages` 里 `sender_type='agent'` 的行确实存在）—— 说明丢的是前端渲染，不是执行。

## 5. 诊断方法

```bash
# 1. 后端到底推了哪些事件？（隔离实例 9998，数据目录 /tmp/deepthink-verify）
DATA_DIR=/tmp/deepthink-verify WAIT_MS=120000 node /tmp/swarm-e2e.mjs 9998 "用一句话说明什么是涌现"
# 输出末尾的 "event summary" 会按 chatJid|eventType 聚合计数

# 2. 席位回复有没有落库（排除「没执行」这一类原因）
sqlite3 -header ~/.deepthink-9999/db/messages.db \
  "SELECT id,sender_type,sender_seat_id,status,substr(content_ref,1,40) FROM group_messages ORDER BY id DESC LIMIT 6;"

# 3. 前端拿到的载荷字段名（content）与渲染字段名（contentRef）是否错位
grep -n "contentRef" web/src/components/agent-group/GroupChatArea.tsx
grep -n "content:" src/agent-group/swarm-runner.ts

# 4. 挂载是否真的生效（后端日志，每席位一条）
grep -A4 "applyTurnMounts: mounts appended" logs/deepthink-9999.log | tail -6
```

## 6. 修复方案

选型：**不新造流式通道，复用普通对话那条链路**。后端把「席位文本」翻译成一个带 seatId 的派生事件，前端按普通聊天的做法累积渲染；挂载则复用 `startGraphRun` 已有的 `initialState` 加性通道，落到既有的 `applyTurnMounts`。

### 6.1 `shared/stream-event.ts`：`groupMessage.id` 变可选

```diff
   /** Agent Group Chat (swarm): a `group_messages` row. Carried on
-   *  `group_message_created` (the row exists). */
+   *  `group_message_created` (the row exists — `id` is set) and on
+   *  `group_message_delta` (only `senderSeatId` + the incremental `content`
+   *  text are meaningful; the row is only written once the seat settles). */
   groupMessage?: {
-    id: number;
+    id?: number;
```

`group_message_delta` 与 `group_message_done` 两个事件类型**本来就已经在 `StreamEventType` 联合类型里**，本次只是把它们真正用起来（`make sync-types` 同步到三份副本）。

### 6.2 后端：把席位节点的流事件翻译成「带座位号」的事件

`GraphDeps` 新增一个可选钩子（与既有 `onNodeSettled` 同构，未接线即 no-op）：

```ts
// src/graph-engineering/graph-runner.ts
/** Called for every stream event an agent node emits, right before it is broadcast. */
onNodeStream?: (ctx: GraphRunContext, node: GraphNode, event: StreamEvent) => void;
```

```ts
// src/agent-group/swarm-runner.ts（新增纯函数，便于单测）
export function swarmSeatDeltaEvent(ctx, node, event): StreamEvent | null {
  if (event.eventType !== 'text_delta' || !event.text) return null;
  if (event.parentToolUseId) return null;            // SubAgent 的文字不算席位发言
  const seatId = seatIdFromNodeId(node.id);
  if (seatId === null) return null;
  const seat = getGroupSeat(seatId);
  if (!seat || seat.group_id !== ctx.chatJid) return null;   // 非本群席位直接放过
  return {
    eventType: 'group_message_delta',
    displayLevel: 'primary',
    agentScope: 'system',
    graphEvent: { runId: ctx.graphRunId, nodeId: node.id },
    groupMessage: { groupId: ctx.chatJid, senderType: 'agent', senderSeatId: seatId, content: event.text },
  };
}
```

```ts
// src/index.ts — graphDeps 接线（与 onNodeSettled 并列）
onNodeStream: (ctx, node, event) => {
  const delta = swarmSeatDeltaEvent(ctx, node, event);
  if (delta) broadcastStreamEvent(ctx.chatJid, delta);
},
```

### 6.3 后端：席位继承 owner 身份 + 每轮挂载

```diff
-  if (node.agentDefId) {
-    const g = group as unknown as {...};
-    g.agentDefId = node.agentDefId;
-    g.created_by = ctx.ownerUserId;
-    g._graphAgentNode = true;
-  }
+  // 节点跑在 owner 的目录里、以 owner 的身份跑，合成群组就必须带上 owner 身份：
+  // container-runner 有三处依赖 group.created_by —— Agent 定义、用户插件、
+  // 以及 applyTurnMounts 的 MCP/知识库归属校验。
+  const g = group as unknown as { agentDefId?: string; created_by?: string; _graphAgentNode?: boolean };
+  g.created_by = ctx.ownerUserId;
+  g._graphAgentNode = true;
+  if (node.agentDefId) g.agentDefId = node.agentDefId;
```

每轮挂载走的是 `startGraphRun` 的 `initialState`（和 `goal` 同一条加性通道）：

```ts
// swarm-runner.ts
initialState: { goal: opts.goalText, turnMounts: opts.turnMounts },

// graph-runner.ts（新增纯函数；只放行白名单字段，state 里的任意 key 到不了 container-runner）
export function readTurnMounts(state: GraphState): SelectedMounts | undefined {
  const raw = state.turnMounts as SelectedMounts | undefined;
  if (!raw || typeof raw !== 'object') return undefined;
  const ids = (v) => Array.isArray(v) ? v.filter(x => typeof x === 'string' && !!x) : [];
  const mounts = { skills: ids(raw.skills), mcpServers: ids(raw.mcpServers), kbIds: ids(raw.kbIds) };
  return (mounts.skills?.length || mounts.mcpServers?.length || mounts.kbIds?.length) ? mounts : undefined;
}
```

```ts
// src/routes/agent-groups.ts
selectedMounts: z.object({
  skills: z.array(z.string()).max(50).optional(),
  mcpServers: z.array(z.string()).max(50).optional(),
  kbIds: z.array(z.string()).max(50).optional(),
}).optional(),
```

### 6.4 前端：复用普通聊天的渲染与工具栏

`web/src/components/agent-group/GroupChatArea.tsx`：

```diff
-if (event?.eventType !== 'group_message_created' || !event.groupMessage) return;
-appendMessage({ ...event.groupMessage, mentions: [], parentMsgId: null } as GroupMessage);
+if (event.eventType === 'group_message_delta') {         // 逐字累积到该席位的气泡
+  const { senderSeatId, content } = event.groupMessage ?? {};
+  if (senderSeatId && content) setSeats(prev => ({
+    ...prev,
+    [senderSeatId]: { name: prev[senderSeatId]?.name ?? '', text: (prev[senderSeatId]?.text ?? '') + content },
+  }));
+  return;
+}
+if (event.eventType === 'group_message_created') {       // 落库后换成正式气泡
+  const gm = event.groupMessage;
+  appendMessage({ ...gm, contentRef: gm.content, mentions: [], parentMsgId: null } as GroupMessage);
+  setSeats(prev => { const next = { ...prev }; delete next[gm.senderSeatId]; return next; });
+  return;
+}
+// graph_node_start / graph_node_end：该席位「正在思考…」的出现与收尾
```

席位气泡改走普通对话同一套 `MarkdownRenderer`（`variant="chat"`），并把「技能 / MCP 工具 / 知识库」工具栏（`ChatToolbar`，与普通对话同一个组件）放到输入框上方；发消息时按 `ChatView.tsx:434` 的同一映射带上 `selectedMounts`。另外把 `POST /messages` 返回的 `graphRunId` 记入 store 的 `currentRun`，Pipeline 面板于是能自动跟踪这条消息触发的 run（此前它只跟踪「启动 Pipeline」按钮触发的那次）。

## 7. 处理卡住的状态

无。本次是渲染与能力对齐问题，不涉及卡死的运行态。

**验证环境的选择**（避免打扰在跑的实例）：本机 9999 是用户在用的实例。为验证，把它的数据目录整体复制成 `/tmp/deepthink-verify`，用本 worktree 的构建产物在 **9998** 起一个隔离实例：

```bash
cp -R ~/.deepthink-9999 /tmp/deepthink-verify
mv /tmp/deepthink-verify/config/user-im /tmp/deepthink-verify-config-user-im.bak   # 关键：避免与线上实例抢同一个飞书长连接
DEEPTHINK_DATA_DIR=/tmp/deepthink-verify WEB_PORT=9998 node dist/index.js
```

跑完 `kill` 掉即可，线上实例全程未重启、未改数据。

## 8. 经验沉淀 / 预防

1. **同一份数据在两处用两个字段名，是最容易漏的一类 bug**：WS 事件用 `content`、REST 用 `contentRef`，中间靠一个 `as GroupMessage` 断言把类型检查关掉了。凡是「同一个 payload 跨两种传输」的场景，应让两边共用同一个字段名，或让转换函数成为唯一入口（本次前端已显式 `contentRef: gm.content` 做映射）。
2. **`as` 断言等于手动关掉编译器**。这次两处根因（字段错位、事件类型漏处理）都发生在 `as` 与「只认一种 eventType」的白名单判断上。新增事件类型时，应在前端加一条 default 分支日志，或让 `eventType` 用穷尽式 switch，漏了会被类型系统抓住。
3. **原始流事件必须自解释**。`text_delta` 只带 `turnId` 而不带座位号，导致「后端其实推了、前端却用不了」。凡是多参与方（席位 / SubAgent / 多租户）共用的流通道，事件里必须直接带**归属标识**，而不是让消费方去解析 `turnId` 字符串。
4. **合成群组要带完整 owner 身份**。`buildOwnerGroup` 只设了 `owner_user_id`（`RegisteredGroup` 根本不读这个字段），导致 `created_by` 长期为 undefined：不仅挂载失效，host 模式下 `DEEPTHINK_WORKSPACE_GLOBAL` 还会**回退到共享的 `groups/global`**（memory 层隔离退化）。这类「看起来能跑、实则悄悄降级」的字段，建议加启动期断言。
5. **群组级能力应与对话级能力共用同一套组件与字段**：本次没有新写「群组版的挂载工具栏」，而是直接复用 `ChatToolbar` + `chat-mounts` store + `selectedMounts` 字段。新增会话形态时优先复用，能力不对等的问题会自然消失。
6. **UI 缺陷也要拿到客观证据**：本次用 Playwright 驱动真实页面，在席位还在写的时候连拍快照，直接抓到 `Agent #1 · 唯心主义者 …（逐段变长）` 与 `Agent #2 · 唯物主义者 正在思考…` 同屏，比「人眼看了一下」可靠。

### 已知遗留（本次未修，非本次回归）

- 历史消息（从 `GET /messages` 加载的气泡）**只显示 `Agent #N`，不显示席位名**：席位名目前只在流式阶段来自 `graph_node_start.title`。要补需从 store 里已有的 `seats` 列表做 `seatId → 名称` 映射。
- 无 per-jid run 锁（连发两条消息会对同一 folder 起两个并发 run）。
- 席位级 `group_seats.mounts` 列目前无人写入，挂载是**群组级**的（与普通对话 per-conversation 的粒度一致）。

## 9. 验证证据（E2E）

隔离实例（9998，数据目录 `/tmp/deepthink-verify`，本 worktree 构建产物），走真实 HTTP + WebSocket：

### 9.1 流式事件确实带座位号发出

```
web:swarm:546f318b-...|group_message_delta -> 14     ← 新增（修复前 0）
web:swarm:546f318b-...|group_message_created -> 2
web:swarm:546f318b-...|graph_node_start -> 2 / graph_node_end -> 2 / graph_end -> 1

[event ...] group_message_delta {"groupMessage":{"seat":1,"content":"**世界的本质是意识——不是意识反映世界…"},
                                 "graphEvent":{"runId":"graph-f80f9fd5-…","nodeId":"seat-1"}}
...
[event ...] group_message_created {"groupMessage":{"id":19,"seat":1,"content":"**世界的本质是意识…"}}
```

### 9.2 落库一致

| 校验项 | 结果 |
|--------|------|
| `graph_node_runs` | `seat-1` / `seat-2` 均 `completed` |
| `group_messages` | 新增 `sender_type='agent'`、`sender_seat_id=1/2`、`status='completed'` 两行，内容按 `role_prompt` 分化（唯心 / 唯物各执一词） |

### 9.3 挂载真的到了席位（后端日志）

三次投递分别带上 `skills=["builtin-markdown"]`、`mcpServers=["web-search"]`、`kbIds=["kb-verify-1"]`（KB 为验证环境临时 seed，线上该用户暂无知识库）：

```
applyTurnMounts: skills injected into systemPrompt + mounts   ← 两个席位各一条
applyTurnMounts: mounts appended
    mcpMounted: 1   kbMounted: 1   skillMounted: 1   totalMounts: 3
```

### 9.4 页面真的在流式输出（Chromium 抓取真实 DOM）

Playwright 驱动页面发送「用一句话说明：什么是"涌现"？」，在同一页面连续取样：

```
+5000ms  Agent #1 涌现，就是整体呈现出部分之和所不具备的新性质——但请注意：能被"加总"出来的从来不是真正的新东西…
         Agent #1 · 唯心主义者 涌现不是物质在数量堆叠中凭空变出的新性质，而是先于并统摄各部分的整体理念…
         Agent #2 · 唯物主义者 正在思考…
+8000ms  Agent #1 …（上文更长）…  Agent #2 涌现，就是物质系统在要素数量与组织复杂度越过某个临界点后…
+15000ms Agent #2 …（继续变长）
```

同屏可见：**逐字增长中的席位气泡**、**尚未出字的席位显示「正在思考…」+ 转圈**、以及右侧 Pipeline 面板 `running graph-…` 中 `seat-1` 已完成（30168 tok）、`seat-2` 进行中 —— 即一条消息触发的 run 被面板自动跟踪。修复前该页面在同样操作下只会出现空白气泡。

### 环境备注

验证实例的 `config/user-im/` 已移除，故未连接任何 IM；LLM 调用走复制过来的 `claude-provider.json`，两个席位均为 **host 模式**（该群组的 `execution_mode='host'`），未受「容器访问不到私网 provider」影响（见上一个 issue 的环境备注）。
