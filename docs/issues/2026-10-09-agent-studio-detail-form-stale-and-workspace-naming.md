# 2026-10-09 Agent Studio 详情表单切换不刷新 + 测试工作区 URL/命名改造

> 类型：issue 修复（含 3 项 UX 调整）。不涉及平台新能力，因此不走 PRD → tech_solution → test_report 流水线。

---

## 1. 用户现象

打开 `http://localhost:9999/agents`，左侧是 Agent 列表、右侧是该 Agent 的详情表单。

在这个左右分栏里点击另一个 Agent 切换时，**右侧表单内容不刷新**——标题（名称）、描述、System Prompt
仍然显示上一个 Agent 的内容。只有"已启用/已禁用"按钮和"类型"按钮的文字跟着变了，看起来像是
"页面刷新了一半"。

用户同时提出 3 项改造：

1. Agent 测试对话的 URL 从 `http://localhost:9999/chat/agent-test-54de5c67-...` 改成
   `http://localhost:9999/chat/agent/54de5c67-...` 这种更易懂的形式；
2. 工作区列表里自己创建的 Agent 标题去掉 `测试:` 前缀；
3. `/agents` 左右分栏在 Agent 变多后很难用，改成**卡片矩阵铺开**，点单个 Agent 跳出**独立详情面板**做编辑/保存/发布。

---

## 2. 问题描述

第 1 条不是"刷新慢"或"数据没到"，而是 **React 受控/非受控输入框的经典陷阱**：
详情表单里名称、描述、System Prompt、模型、max_turns 这 5 个字段用的是**非受控** `defaultValue`，
而承载它们的 `<Card>` **没有绑 `key`**。切换 Agent 时 `selectedId` 变了、`selected` 也换成新对象，
但 React 按"同位置同类型"复用 DOM 节点，`defaultValue` 只在**首次挂载**时生效，此后不再应用。

这正好解释了"只刷新了一半"：

| 元素 | 渲染方式 | 切换后 |
|---|---|---|
| 名称 / 描述 / System Prompt / 模型 / max_turns | 非受控 `defaultValue` | ❌ 保持旧 DOM 值 |
| "已启用/已禁用"按钮文字、类型按钮文字、挂载/版本等子区块 | 每次渲染读 `selected.*` | ✅ 正常更新 |

第 2 条对应后端把工作区命名为 `` `测试: ${def.name}` ``。
第 3 条是布局问题：左列表 + 右详情的分栏在列表变长后，切换 Agent 需要反复上下滚动定位。

---

## 3. 根因

### 3.1 表单不刷新（主要 bug）

`web/src/pages/AgentStudioPage.tsx`（改前）的右侧详情面板：

```tsx
{selected ? (
  <Card>                                     {/* ← 没有 key */}
    <CardContent className="p-4 space-y-4">
      <input defaultValue={selected.name} ... />                 {/* :179 */}
      <textarea defaultValue={selected.description ?? ''} ... />  {/* :191 */}
      <textarea defaultValue={selected.systemPrompt} ... />       {/* :251 */}
      <input defaultValue={selected.model ?? ''} ... />           {/* :283 */}
      <input defaultValue={selected.maxTurns ?? ''} ... />        {/* :296 */}
```

`selected` 由 `list.find((a) => a.id === selectedId)` 派生。切换 Agent 时：

1. `setSelectedId(ag.id)` → 重渲染，`selected` 指向另一个 Agent 对象；
2. 但 `<Card>` 仍是 `<Card>`、`<input>` 仍是 `<input>`，React 判定"类型与位置都没变"→ **复用 DOM 节点**；
3. `defaultValue` 不是受控属性，React 不会在更新时写回 DOM 的 `value`。

于是输入框里留着上一个 Agent 的文本。React 官方对 `defaultValue` 的定义即"仅用于初始挂载
（only used for the initial render）"，此项行为是规范行为而非 bug——
参考：<https://react.dev/reference/react-dom/components/input#providing-an-initial-value-for-an-input>

后端侧无异常：`update()` 走 `agent-paas.ts:186` 的 `PATCH /api/paas/agents/:id` + `load()`，
`list` 与 `selected` 都是新数据，属于纯前端渲染问题。

### 3.2 `测试:` 前缀

`src/routes/paas-agents.ts:842`（改前）：`const name = \`测试: ${def.name}\`;`

### 3.3 URL 形态

工作区 folder 由 `src/routes/paas-agents.ts:841` 决定，改前为 `agent-test-{agentId}`；
前端跳转是 `navigate(\`/chat/${res.folder}\`)`。

⚠️ 关键约束：`web/src/App.tsx:90` 的路由是 `/chat/:groupFolder?`——**单段**参数。
用户期望的 `/chat/agent/{id}` 是**两段**路径，不会被该路由匹配，必须新增路由；
同时不能把 folder 改成含 `/` 的名字（folder 直接当目录名用，会破坏文件系统与 IPC 路径）。

---

## 4. 复现路径

前置：`make start-prod PORT=9999`，库里至少有 2 个 Agent。

1. 浏览器打开 `http://localhost:9999/agents`；
2. 左侧点第 1 个 Agent，记下右侧名称与 System Prompt；
3. 左侧点第 2 个 Agent；
4. **观察到**右侧名称/描述/System Prompt 仍是第 1 个 Agent 的内容（"已启用/已禁用"文字却已切换）；
5. 刷新页面后内容才对。

改造前的工作区 URL 复现：详情页点"测试对话"→ 地址栏出现
`/chat/agent-test-54de5c67-3377-4456-9847-8d9da7898154`，且侧边栏标题为 `测试: AI 大模型智能体论文写作专家`。

---

## 5. 诊断方法

```bash
# 1) 确认是"非受控 defaultValue + 无 key"——直接看有没有 key
grep -n "defaultValue" web/src/pages/AgentDetailPage.tsx
grep -n "key={agent.id}" web/src/pages/AgentDetailPage.tsx   # 改造后：详情视图绑了 key

# 2) 确认库里旧工作区与带前缀的名字（迁移前）
sqlite3 ~/.deepthink/db/messages.db \
  "select jid,name,folder from registered_groups where jid like '%agent-test%';"

# 3) 确认 /chat 路由是单段参数（决定必须新增 /chat/agent/:agentId）
grep -n 'path="/chat' web/src/App.tsx

# 4) 隔离实例上跑端到端回归（含"切换后表单是否刷新"断言 + 截图）
make start-prod PORT=9911
DT_BASE=http://localhost:9911 DT_USER=admin DT_PASS='<密码>' \
  node tests/e2e/agent-studio-ui.mjs

# 5) 关键：库里现成的 Agent 可能"看着能验证、实际没用"——先确认两个 Agent 的 prompt 真的不同
curl -s -b cookies.txt http://localhost:9911/api/paas/agents \
  | node -e "let s='';process.stdin.on('data',d=>s+=d).on('end',()=>{for(const a of JSON.parse(s).agents){const p=a.systemPrompt??'';let h=0;for(const c of p)h=(h*31+c.charCodeAt(0))>>>0;console.log(p.length,h.toString(16),a.name)}})"
# 本例实测：两个 Agent 都是 len=1006 hash=c5e27e77（内容完全相同）→ 拿它们做切换断言没有区分度

# 6) 同一 Agent 是否被起了两间工作区（6.3.1 的回归症状）
sqlite3 ~/.deepthink-9911/db/messages.db \
  "select jid, folder, name from registered_groups where jid like '%agent-%' order by jid;"
```

---

## 6. 修复方案

### 6.1 表单不刷新 → 详情视图绑 `key`（本次的真正修复）

详情面板整体抽到新页面 `web/src/pages/AgentDetailPage.tsx`，并在详情视图上绑 `key={agent.id}`：

```diff
+  return <AgentDetailView key={agent.id} agent={agent} />;
```

```diff
 /**
  * Agent 详情页（/agents/:id）—— 承载单个 Agent 的编辑/保存/发布/…
+ *
+ * 名称、描述、System Prompt 等字段是**非受控** defaultValue 输入框：React 会复用
+ * 同位置同类型的 DOM 节点，defaultValue 只在首次挂载时生效。所以这里在
+ * AgentDetailView 上绑 key={agent.id}，切换 Agent 时强制整体重挂载。
  */
```

**选型理由**：把 5 个字段改成受控（`value` + `onChange` + 外部 state 同步）要引入 5 组 state
与 `useEffect` 同步逻辑，还要处理输入焦点/光标问题，改动量和回归面都大得多；
绑 `key` 是 React 社区处理"换实体要重置组件内部状态"的标准手法，一行解决，且顺带让
`MountsSection` / `VersionHistorySection` 等子区块的局部 state 也一起干净重置。

> 注意：`/agents` → `/agents/:id` 之间切换时 React Router **不会**卸载路由组件（同一个 route），
> 所以这个 `key` 不是可选项——少了它，原始 bug 会在新布局下原样复现。

### 6.2 去掉 `测试:` 前缀

```diff
 // src/routes/paas-agents.ts
-  const name = `测试: ${def.name}`;
+  const name = def.name;
```

历史行由新增的启动迁移清理（`src/db.ts`）：

```ts
export function migrateAgentTestWorkspaceNames(): number {
  const PREFIX = '测试: ';
  const rows = db.prepare(
    `SELECT jid, name FROM registered_groups
     WHERE jid LIKE 'web:agent-test-%' AND name LIKE ?`).all(`${PREFIX}%`) as ...;
  for (const { jid, name } of rows) {
    const cleaned = name.slice(PREFIX.length);
    db.prepare('UPDATE registered_groups SET name = ? WHERE jid = ?').run(cleaned, jid);
    db.prepare('UPDATE chats SET name = ? WHERE jid = ?').run(cleaned, jid);
  }
  return rows.length;
}
```

在 `src/index.ts` 的 `loadState()` 里**必须早于** `registeredGroups = getAllRegisteredGroups()` 调用，
否则内存里的 groups 映射还留着旧名字：

```diff
+  // 必须在 registeredGroups 构建之前：迁移只改 DB 里的显示名
+  try {
+    const renamed = migrateAgentTestWorkspaceNames();
+    if (renamed > 0) {
+      logger.info({ renamed }, 'Dropped "测试: " prefix from agent test-workspace names');
+    }
+  } catch (err) {
+    logger.warn({ err }, 'Agent test-workspace name migration failed (non-fatal)');
+  }
+
   sessions = getAllSessions();
   registeredGroups = getAllRegisteredGroups();
```

### 6.3 新工作区改用 `agent-{id}` + `/chat/agent/:agentId` 路由

后端（`src/routes/paas-agents.ts`）：

```diff
-  const jid = `web:agent-test-${agentId}`;
-  const folder = `agent-test-${agentId}`;
+  const jid = `web:agent-${agentId}`;
+  const folder = `agent-${agentId}`;
```

前端新增路由（`web/src/App.tsx`）：

```diff
+  {/* /chat/agent/:agentId 是 /chat/:groupFolder? 的语义化别名，folder 即 agent-{id} */}
+  <Route path="/chat/agent/:agentId" element={<Suspense fallback={<PageLoader />}><ChatPage /></Suspense>} />
   <Route path="/chat/:groupFolder?" element={...} />
```

`ChatPage` 按 **jid 反查真实 folder**，而不是直接拼 `agent-{id}`——因为历史工作区的 folder
仍是 `agent-test-{id}`（见 6.4 的范围决策）：

```diff
+  const agentFolder = useMemo(() => {
+    if (!routeAgentId) return undefined;
+    return (
+      groups[`web:agent-${routeAgentId}`]?.folder ??
+      groups[`web:agent-test-${routeAgentId}`]?.folder ??
+      `agent-${routeAgentId}`
+    );
+  }, [routeAgentId, groups]);
+  const groupFolder = routeAgentId ? agentFolder : routeFolder;
```

历史 URL `/chat/agent-test-{id}` 是**单段**路径，仍由 `/chat/:groupFolder?` 命中，
且 folder 未变，天然可用，无需额外重定向。

#### 6.3.1 历史工作区必须**复用**（E2E 跑出来的回归）

上面"folder 不动"的轻量方案有个连带后果：`test-chat` 只按新 jid 查存在性，
于是对老 Agent 会**另起一间空工作区**，用户在旧工作区里的历史会话再也看不到。

证据（隔离实例的克隆库里，同一个 Agent 出现了两行）：

```
web:agent-54de5c67-…| agent-54de5c67-…      | AI 大模型智能体论文写作专家   ← 新起的空工作区
web:agent-test-54de5c67-…| agent-test-54de5c67-…| AI 大模型智能体论文写作专家   ← 用户的历史工作区（被孤儿化）
```

修法：新 jid 不存在时回落到历史 jid，复用而不新建（仍未迁移 jid/folder）：

```diff
   const jid = `web:agent-${agentId}`;
+  const legacyJid = `web:agent-test-${agentId}`;
   ...
-  const existing = getRegisteredGroup(jid);
+  const existingJid = getRegisteredGroup(jid) ? jid : legacyJid;
+  const existing = getRegisteredGroup(existingJid);
   if (existing) {
     if (existing.agentDefId !== agentId || existing.name !== name) {
       ...
-      setRegisteredGroup(jid, updated);
-      updateChatName(jid, name);
-      if (deps) deps.getRegisteredGroups()[jid] = updated;
+      setRegisteredGroup(existingJid, updated);
+      updateChatName(existingJid, name);
+      if (deps) deps.getRegisteredGroups()[existingJid] = updated;
     }
-    return c.json({ jid, folder: existing.folder, name });
+    return c.json({ jid: existingJid, folder: existing.folder, name });
   }
```

**选型理由**：不改 jid/folder（仍受 §6.4 的约束），只在"查哪一行"上让步；
两个 jid 同时存在时优先新的（新命名是今后的规范形态，历史行只是兼容兜底）。
这个行为若丢，用户的测试会话历史会静默消失，所以固化进 E2E：历史工作区必须被复用、
且复用后不得凭空多出 `web:agent-{id}` 行。

### 6.4 范围决策：**不做** jid/folder 的存量迁移

最初方案是"启动时把 `agent-test-*` 整体改名成 `agent-*`"。查证后放弃，依据：

- 库里带该工作区 jid/folder 列的表有 **25 张**。其中 23 张按列名就能扫出来（扫描
  `src/db.ts` 全部建表语句，取列名含 `jid` / `folder` 的列）：
  `chats`、`messages`、`scheduled_tasks`、`loop_runs`、`chat_trace_nodes`、`graph_runs`、
  `graph_node_run_locks`、`team_builds`、`trace_tool_calls`、`supervisor_sessions`、`sessions`、
  `registered_groups`、`im_context_bindings`、`group_members`、`user_pinned_groups`、`agents`、
  `usage_records`、`workflow_builds`、`trace_steps`、`collaborations`、`workspace_artifacts`、
  `file_trash`、`file_versions`。
  剩下的 2 张**列名里没有 jid/folder，按名扫必然漏**：`group_seats.group_id` 与
  `group_messages.group_id` 存的就是 chat jid——见 `src/agent-group/swarm-runner.ts:81`、`:149`
  的 `seat.group_id !== ctx.chatJid`。
  ⚠️ 按列名搜还有两个坑：改用别的列名会漏（`im_context_bindings` 是 `source_jid` +
  `workspace_jid`，`graph_node_run_locks` 是 `workspace_folder`，`agents` 另有
  `last_im_jid` / `spawned_from_jid`），而 `file_trash.is_folder` 是 INTEGER 布尔标志、
  不是目录名（该表靠同表的 `group_folder` 才算进来），所以"23"也不是"23 个 jid 列"；
- `messages.chat_jid` 对 `chats(jid)` 有**外键**，而 `src/db.ts:291` 执行了
  `PRAGMA foreign_keys = ON`——改 PK 必须 `PRAGMA defer_foreign_keys` 或临时关校验；
- PostgreSQL 后端本机无法验证，而 `sqlite-compat.ts` 对 `PRAGMA foreign_keys`
  是映射到 `SET session_replication_role`（需 superuser），跨方言正确性无法保证；
- 收益只是 2 个测试工作区的**磁盘目录名**，用户完全不可见。

于是改为"轻量方案"：**URL 与显示名对新旧 Agent 全部生效，folder 一律不动**。
代价仅为历史工作区的 folder 仍叫 `agent-test-{id}`（不可见）。
该约束已被单元测试固化（见 §8）。

### 6.5 `/agents` 改卡片矩阵 + `/agents/:id` 独立详情页

- `web/src/pages/AgentStudioPage.tsx`：只保留卡片矩阵（`grid-cols-1 sm:2 lg:3 xl:4`）+ 新建弹窗，
  点卡片 `navigate(\`/agents/${ag.id}\`)`。1105 行 → 约 210 行。
- `web/src/pages/AgentDetailPage.tsx`（新增）：承载名称/描述/System Prompt/模型/max_turns/
  类型/挂载/子 Agent(Workers)/绑定群组/分享/协作者/版本历史，以及 AI 优化、测试对话、
  编排运行、启用禁用（即"发布"开关）等操作。原先散在 `AgentStudioPage.tsx` 里的
  `MountsSection` 等 8 个子组件一并搬过来。
- 路由：`<Route path="/agents/:id" .../>`（懒加载），与现有 `/staff-teams/:id` 的
  "网格 → 详情页" 模式保持一致。

---

## 7. 处理卡住的状态

不适用——本次是纯前端渲染 + 命名问题，没有卡死的运行态。

---

## 8. 经验沉淀 / 预防

1. **React 里 `defaultValue` 只用于首次挂载**。凡是"同一个组件实例内切换实体"的表单，
   要么用受控 `value`，要么给容器绑 `key={entity.id}`。判断信号：**部分字段跟着变、部分不变**，
   几乎一定是受控/非受控混用。
2. **路由参数变化不会卸载组件**。`/agents/A` → `/agents/B` 走的是同一个 route element，
   所以"换页就等于重新挂载"的直觉在这里是错的，`key` 必须显式加。
3. **改主键 jid 前先数引用表，且别只按常见的两个列名搜**。这个库里有 25 张表带工作区
   jid/folder 列，且 `messages → chats` 有外键。第一次只搜 `chat_jid` / `group_folder`
   得到 16 张，写进复盘文档后被另一个会话指出漏项——重扫是 23 张（按名），再加上两张把
   jid 存在 `group_id` 里的（`group_seats`、`group_messages`）共 **25 张**。
   **教训有两层**：(a) "大概十几张"这种量级估计不该进文档，要放能复跑的扫描命令；
   (b) **按列名扫天然会漏**——`group_seats.group_id` 名字里根本没有 jid/folder，
   扫描命令再完美也看不见，所以数字要写成"按此命令得 N，另有已知例外 M"，
   而不是一个孤零零的准确数：

   ```bash
   node -e "const s=require('fs').readFileSync('src/db.ts','utf8');const re=/CREATE TABLE IF NOT EXISTS\s+(\w+)\s*\(([\s\S]*?)\n\s*\);/g;let m,n=0;while((m=re.exec(s))){const c=[...new Set([...m[2].matchAll(/^\s*(\w*(?:jid|folder)\w*)\s+\w+/gim)].map(x=>x[1]))];if(c.length){n++;console.log(m[1],c.join(','))}}console.log('总数 =',n)"
   ```

   真正的判断标准仍是"收益（用户可见）vs 风险（不可测的 PG 路径）"。
4. **启动迁移的调用位置有语义**。改 DB 显示名的迁移若晚于 `getAllRegisteredGroups()`，
   DB 改了但内存映射没改，会在运行期表现为"重启后第一次访问还是旧名字"。
5. **回归测试固化关键约束**：
   - `tests/units/agent-test-workspace-name-migration.test.ts`（5 用例）——除了断言名字被清理，
     还断言 **jid 与 folder 一个字都没动**。若将来有人把轻量方案"顺手升级"成彻底迁移，
     这些断言会先失败，强制重新评估 §6.4 的风险。
   - `tests/e2e/agent-studio-ui.mjs`（16 项，附 4 张截图）——浏览器端回归：
     "切到 Agent B 后表单必须是 B 的内容、且 System Prompt 与 A 不同"是原始 bug 的直接断言；
     "历史工作区被复用且没多出新行"是 §6.3.1 的直接断言。
6. **断言必须先自证有区分度**。这套 E2E 第一版拿库里现成的两个 Agent 做切换，
   结果"✅ 通过"了，detail 却写着"与 A 相同（1006 字符）"——一查两个 Agent 的 System Prompt
   内容完全一样，断言恒真、什么都没证明。**凡是"切换后 / 更新后应是新值"的断言，都要先断言
   "旧值 ≠ 新值"**，否则数据一旦巧合相同，"绿"就是假的。现在脚本自己建两个 prompt 明确
   不同的临时 Agent，并把"两者必须不同"作为前提断言（不成立即失败），用完删除。
7. **改"查找键"时要想旧数据**。6.3 只改了新建工作区的 jid，`test-chat` 的存在性检查随之换了
   查找键，老工作区就再也命不中——表现为"用户历史会话消失"。这类"改名/改键"的改动，
   除了看**写**路径，必须逐个过一遍**读**路径（这里是 `getRegisteredGroup`）。
