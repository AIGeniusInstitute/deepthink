# OpenCode 引擎 SubAgent 回复复读用户输入 + 每轮注入 system_context

- 日期：2026-07-19
- 范围：OpenCode 引擎（`engine=opencode`）的会话型 SubAgent（`processAgentConversation` 路径）
- 结论：**已真正修复**（双根因，均已修，typecheck + 全量约束测试通过）

## 1. 用户现象

在 Web 端对一个配置了 `engine=opencode` 的会话型 Agent（SubAgent）连续提问，Agent 的回复完全答非所问：

- 问「我问你是谁」，回复里直接把整段 `<system_context>` 注入块原样吐出来，后面跟「我问你是谁 我问你是谁」（用户输入被复读）。
- 每多问一句，`<system_context>` 块里嵌套的历史就增长一截，回复越来越长、越来越乱。
- 问「1+1=」同样回复一长串 system_context + 「1+1=」，看不到真正的答案。
- 上下文点「清除」也不管用，下一轮 system_context 照样出现。

用户原话：「回答问题逻辑错误，完全不知道是消息错乱了还是咋回事。」

## 2. 问题描述

从技术视角，两个独立缺陷叠加，导致 OpenCode SubAgent 的回复 =「整段注入 prompt」+「用户问题复读」：

1. **Bug A（session 读错列）**：`processAgentConversation` 读取 SubAgent 会话 ID 时，对所有引擎统一调用 `getSession(folder, agentId)`（读 `sessions.session_id` 列）。但 OpenCode（以及 Codex / AtomCode）的会话 ID 存在各自专用列（`opencode_session_id` / `codex_thread_id` / `atomcode_session_id`），`session_id` 列在这类行里是空串 `''`。于是 OpenCode SubAgent 的 `sessionId` 永远是 `undefined`：
   - `!sessionId` 恒为真 → 每轮都命中 `buildRecentConversationHistoryContext` 注入分支，把最近历史包成 `<system_context>` 拼到 prompt 头部。
   - `containerInput.sessionId` 恒为 `undefined` → `opencode-engine.ts` 每轮都 `createSession()` 新建一个 OpenCode 会话，彻底丢失上下文。
2. **Bug B（fullText 累加了用户输入 part）**：`opencode-engine.ts` 的 `runOneTurn` 把所有 `message.part.updated` 事件里 `part.type==='text'` 的文本累加进 `fullText` 并作为回复。但 OpenCode 在收到 `POST /session/:id/message` 后，会先把**用户那条消息**（含我们发出去的整段 prompt，包括注入的 `<system_context>`）作为一个 TextPart 经 `message.part.updated` 推送出来，随后才推送 assistant 的回复 part。part 本身没有 role 字段，engine 无法区分，于是 `fullText` =「整段用户 prompt」+「assistant 回复」，回复里自然出现原样的 system_context 和用户问题。

两者叠加：每轮新建会话 + 注入历史 + 把注入的 prompt 又当回复吐出来 → 用户看到的「消息错乱」。

## 3. 根因

代码层面：

- **Bug A**：`src/index.ts` 旧代码（`processAgentConversation` 内）：
  ```ts
  const sessionId = getSession(effectiveGroup.folder, agentId) || undefined;
  ```
  `getSession` 读的是 `session_id` 列（Claude SDK 路径专用）。同文件里 SubAgent **写** session 的地方（`processAgentConversation` 的 wrappedOnOutput / finalize session）是按引擎分流的：
  ```ts
  if (effectiveGroup.engine === 'atomcode') setAtomcodeSessionId(...)
  else if (effectiveGroup.engine === 'codex') setCodexThreadId(...)
  else if (effectiveGroup.engine === 'opencode') setOpencodeSessionId(...)
  else setSession(...)
  ```
  写分流、读不分流 → OpenCode/Codex/AtomCode 的 SubAgent 会话永远读不回来。（`getAllSessions()` 也只 SELECT `session_id`，所以主路径在服务重启后同样会丢 OpenCode 会话，但主路径注入只在 recovery/provider-switch 时触发，不是本次症状的直接原因。）

- **Bug B**：`container/agent-runner/src/opencode-engine.ts` 的 SSE 消费循环：
  ```ts
  if (type === 'message.part.updated') {
    const part = (props as { part?: {...} }).part;
    if (!part) continue;
    if (part.type === 'text' && part.text) {
      fullText += part.text;   // ← 用户输入 part 也进了这里
      ...
    }
  }
  ```
  OpenCode 的 `message.part.updated` 事件 properties = `{ sessionID, part, time }`，part 上**没有 role**；role 在 `message.updated` 事件的 `info.role` 上。engine 没有消费 `message.updated`，无从区分用户/助手 part。

外部依据（OpenCode 源码 schema，`packages/schema/src/`）：

- `v1/session.ts` 的 `PartUpdated` 事件定义：
  ```ts
  PartUpdated: define({
    type: "message.part.updated",
    schema: { sessionID, part: Part, time: Schema.Finite },
  })
  ```
  `Part` 是按 `type` 判别的 union（text/reasoning/tool/step-start/...），**无 role 字段**；`partBase` 含 `messageID`。
- `v1/session.ts` 的 `MessageUpdated` 事件：`schema: { sessionID, info: Info }`，`Info = User | Assistant`，判别字段 `role`（`"user" | "assistant"`），`info.id` 为 MessageID。
- `session-status-event.ts`：`session.status` 事件 properties = `{ sessionID, status }`，`status.type ∈ {"idle","retry","busy"}` —— engine 用 `status.type==='idle'` 判定回合结束是正确的，本次未改。
- `session/prompt.ts` 的 `createUserMessage`：`yield* sessions.updateMessage(info)` 后 `for (const part of parts) yield* sessions.updatePart(part)` —— 确认用户消息的 TextPart 会触发 `message.updated`（role=user）先于其 `message.part.updated`，因此按 messageID 过滤可靠。

## 4. 复现路径

1. 启动 DeepThink，配置一个 OpenCode provider（设置 → OpenCode 引擎）。
2. 创建一个会话型 SubAgent，其所属群组 `engine='opencode'`。
3. 在该 Agent 的会话里发第一条消息（例如「你是谁」），等到回复（哪怕回复异常也行，目的是在 DB 里留一条历史）。
4. 发第二条消息「我问你是谁」。
5. 观察 Agent 回复：会以 `<system_context>` 开头，内含上一轮 `[admin]/[assistant]` 转录，结尾复读「我问我是谁 我问你是谁」。
6. 继续发消息，`<system_context>` 嵌套层级递增。

根因侧复现（无需真模型，看 DB 即可）：

```bash
sqlite3 data/db/messages.db \
  "SELECT group_folder, agent_id, session_id, opencode_session_id FROM sessions WHERE opencode_session_id IS NOT NULL"
# 修复前：opencode_session_id 列有值，但代码读的是 session_id 列（空串）
```

## 5. 诊断方法

- 看注入的 intro 文本定位路径。`src/index.ts` 三处 `buildRecentConversationHistoryContext` 调用各有不同 intro：
  - `检测到上次有未完成消息…` → 主路径 recovery 分支
  - `检测到本次因切换 provider…` → 主路径 provider-switch 分支
  - `检测到当前 agent 的底层模型 session 是新的…` → **SubAgent 路径**（`processAgentConversation`，本次症状）
- 用户截图里的 intro 正是第三条 → 确认走 SubAgent 路径。
- grep 确认 OpenCode 会话存在专用列但读取走 `getSession`：

```bash
grep -n "getSession(effectiveGroup.folder, agentId)" src/index.ts   # 修复前命中 7542
grep -n "setOpencodeSessionId\|getOpencodeSessionId" src/index.ts    # 写有、读无
```

## 6. 修复方案

### Bug A：按引擎读取 SubAgent 会话 ID

`src/index.ts`：

```diff
   setSession,
   setAtomcodeSessionId,
   setCodexThreadId,
   setOpencodeSessionId,
+  getAtomcodeSessionId,
+  getCodexThreadId,
+  getOpencodeSessionId,
   deleteSession,
```

新增按引擎分流的 getter（放在 `processAgentConversation` 前）：

```ts
function resolveAgentSessionId(
  group: { folder: string; engine?: string | null },
  agentId: string,
): string | undefined {
  if (group.engine === 'opencode') return getOpencodeSessionId(group.folder, agentId) || undefined;
  if (group.engine === 'codex')    return getCodexThreadId(group.folder, agentId)    || undefined;
  if (group.engine === 'atomcode') return getAtomcodeSessionId(group.folder, agentId) || undefined;
  return getSession(group.folder, agentId) || undefined;
}
```

`processAgentConversation` 内：

```diff
-  const sessionId = getSession(effectiveGroup.folder, agentId) || undefined;
+  const sessionId = resolveAgentSessionId(effectiveGroup, agentId);
```

选型理由：与同函数内已有的「写 session 按引擎分流」模式对齐（写分流、读也分流），不是新抽象。顺带修正了 Codex/AtomCode SubAgent 的同类隐性 bug（写专用列、读 session_id 列），属于同一处一致性修复，非投机性改动。

### Bug B：过滤掉用户消息的 part，只累加 assistant 输出

`container/agent-runner/src/opencode-engine.ts` 的 SSE 消费循环：

```diff
+      const userMessageIds = new Set<string>();
       for await (const ev of parseSseStream(res)) {
         if (done) break;
         const type = ev.type;
         const props = ev.properties ?? {};
+        if (type === 'message.updated') {
+          const info = (props as { info?: { id?: string; role?: string } }).info;
+          if (info?.id && info.role === 'user') userMessageIds.add(info.id);
+          continue;
+        }
         if (type === 'message.part.updated') {
-          const part = (props as { part?: { type?: string; text?: string; state?: { status?: string }; tool?: string } }).part;
+          const part = (props as { part?: { type?: string; text?: string; messageID?: string; state?: { status?: string }; tool?: string } }).part;
           if (!part) continue;
+          if (part.messageID && userMessageIds.has(part.messageID)) continue;
           if (part.type === 'text' && part.text) {
             fullText += part.text;
```

选型理由：part 本身无 role，role 在 `message.updated.info.role` 上；OpenCode 保证 `message.updated` 先于对应 `message.part.updated` 推送（`updateMessage` 在 `updatePart` 之前），故按 `messageID` 过滤可靠、无竞态。同时顺带过滤了用户侧 synthetic part（如「The following tool was executed by the user」），它们也属于 role=user 消息。

## 7. 处理卡住的状态

- 卡住的会话：修复后，旧 OpenCode SubAgent 在下一次正常回合会自动复用已持久化的 `opencode_session_id`（DB 里本就有值，只是之前读错列）。无需手工清理。
- 若仍想强制开新会话：`sqlite3 data/db/messages.db "UPDATE sessions SET opencode_session_id=NULL WHERE group_folder='<folder>' AND agent_id='<agentId>'"`，或在 Web 端对该 Agent 执行 `/clear`（走 `deleteSession` + 清运行时文件）。

## 8. 经验沉淀 / 预防

- **教训**：当一个键的「写」按类型分流到多列、而「读」走单一通用函数时，必然出现「写得进、读不出」的对称性破缺。新增任何带专用存储列的引擎时，**必须同时更新读路径**（`getSession` / `getAllSessions` / `resolveAgentSessionId`），并补一条约束测试。
- **OpenCode SSE 事件模型**：part 事件不带 role，role 在 message 事件上；engine 适配器消费时必须用 `message.updated` 关联 role，不能假设所有 text part 都是 assistant 输出。
- **巡检建议**：加一条约束测试，断言「OpenCode/Codex/AtomCode SubAgent 在第二次回合里 `containerInput.sessionId` 非空、且不触发 history 注入」，防回归。
- **遗留**：`getAllSessions()`（`src/db.ts`）只 SELECT `session_id` 列，服务重启后 OpenCode/Codex/AtomCode 主路径会话不会回填进内存 `sessions` map → 重启后首回合丢失上下文（不触发本次复读，但会静默丢上下文）。建议后续把 `getAllSessions` 改成按 engine 取对应列，或 loadState 时按引擎回填。本次未改（超出本 issue 范围，避免投机性改动）。
