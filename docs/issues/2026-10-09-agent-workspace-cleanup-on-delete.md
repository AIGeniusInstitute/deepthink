# 删除 Agent 不清理其工作区（幽灵工作区 + extra 目录泄漏）

- 日期：2026-10-09
- 影响面：Agent Studio（`/agents`）删除 Agent；以及**所有**工作区删除路径的磁盘泄漏（见 §3.2）
- 严重度：中（不丢数据、不影响运行，但产生无法回收的孤儿工作区与磁盘占用）
- 状态：已修复

---

## 1. 用户现象

在 Agent Studio 点「删除」删掉一个 Agent 后：

1. Agent 从卡片矩阵里消失了（这是符合预期的）；
2. 但它此前「测试对话」开出来的那间工作区**仍然留在工作区/对话列表里**。点进去是一间永远不会再有回复的空对话——因为它背后已经没有 Agent 了；
3. 这间工作区**永远无法被复用**：工作区的 jid 与 folder 都由 Agent 的 UUID 派生（`web:agent-{id}` / `agent-{id}`），UUID 不会再次生成，所以它既不会自动消失，也不会被新 Agent 接管。用户只能眼看着它一直挂在列表里；
4. 磁盘上对应目录（含容器里的 `.npm-global`，可能有几十 MB~几百 MB 的全局 npm 包）也原样留着。

> 证据类型说明：本条最初是**代码层推断**得出的（旧实现只删 `agent_definitions` 一行），随后已在隔离实例上
> **实机复现**并抓到实际残留：把路由改回旧实现跑一次 E2E，库里立刻多出一间幽灵工作区（见 §5 的取证输出）。
> 另外检查过两个实例的库，**在我动手之前都没有已存在的幽灵工作区**——也就是说这是一个"删除就会触发、
> 但当时库里恰好还没有"的缺陷，而不是已经在用户数据里堆了一片。

## 2. 问题描述

`DELETE /api/paas/agents/:id` 的处理函数只有一行实质动作——删 `agent_definitions` 表的一行：

```ts
// 修复前 src/routes/paas-agents.ts
paasAgentsRoute.delete('/:id', (c) => {
  const user = c.get('user');
  const id = c.req.param('id');
  const ok = deleteAgentDefinition(id, user.id);   // 只有这一句
  if (!ok) {
    return c.json({ error: 'Agent definition not found' }, 404);
  }
  return c.json({ success: true });
});
```

`deleteAgentDefinition`（`src/db.ts:10916`）也确实只做一件事：

```ts
db.prepare('DELETE FROM agent_definitions WHERE id = ? AND user_id = ?').run(id, userId);
```

于是由该 Agent UUID 派生的两类产物全部留下：

- **数据库行**：`registered_groups`（工作区本体）、`chats`、`messages`、`sessions`、`group_members`、`user_pinned_groups`、该 folder 的 `scheduled_tasks` 等；
- **文件系统目录**：6 个 per-folder 目录（见 §3.2 的清单）。

对比平台既有的工作区删除实现（`DELETE /api/groups/:jid`，`src/routes/groups.ts:841`），它有一套完整的拆除流程——先停 runner，再删数据，再清内存态。Agent 删除路径漏掉了整条流程。

## 3. 根因

### 3.1 主因：Agent 删除路径没有工作区拆除逻辑

平台对「工作区」的拆除逻辑集中在 `DELETE /api/groups/:jid`，顺序是：

1. 停掉引用该 folder 的**所有** runner——包含同 folder 的兄弟 jid，以及它们派生的虚拟 jid（子 Agent `{jid}#agent:{id}`、定时任务 `{jid}#task:{id}`）。不先停就删目录，会让还在跑的 runner 的 cwd/session 目录被抽走（容器内表现为 ENOENT 或未定义行为）；
2. `deleteGroupData(jid, folder)` —— 删表（`src/db.ts:7106`）；
3. `removeFlowArtifacts(folder)` —— 删目录（`src/file-manager.ts:359`）；
4. 清主进程内存态：`deps.getRegisteredGroups()` / `deps.getSessions()` / `deps.setLastAgentTimestamp()`。

Agent 删除路径当初只实现了「让 Agent 从列表消失」，完全没有第 1~4 步。**这不是并发或时序问题，是纯粹的功能缺失**——旧实现在结构上就没有清理工作区的可能。

### 3.2 顺带发现：`removeFlowArtifacts` 漏了 `data/extra/{folder}`

排查「还有哪些目录该删」时，逐个比对了 `DATA_DIR` 下的 17 个子目录与 `removeFlowArtifacts` 的清理清单，发现 `extra/` 不在清单里。

`data/extra/{folder}` 是 per-folder 的持久目录，bind-mount 进容器成为 `/workspace/extra`，容器内 `npm install -g <pkg>` 装的全局包会落到它的 `.npm-global/`。它是**唯一**由 `container-runner.ts` 写入的 per-folder 目录，量级可达几 MB~几百 MB。

影响面比 3.1 更广：**所有**走 `removeFlowArtifacts` 的删除路径（删除任务工作区、删除群组工作区、Agent 删除）都在泄漏这个目录，不只是 Agent 删除。

`extra/` 的孤儿目录可以直接在本机实盘看到——隔离实例 `~/.deepthink-9999/extra/` 下就躺着两个已不存在对应工作区的目录：

```
$ ls ~/.deepthink-9999/extra/
swarm-0beb99c4
swarm-f1b0d0e0
```

## 4. 复现路径

前置：任意已初始化实例（推荐起隔离实例，勿用生产库）。

```bash
make start-prod PORT=9999
```

1. 登录 Web，进入 `/agents`；
2. 新建一个 Agent（记下它的 id，或在列表页从 URL `/agents/{id}` 取）；
3. 点该 Agent 的「测试对话」——这一步会创建 jid `web:agent-{id}`、folder `agent-{id}` 的工作区；
4. 回到 `/agents`，删除这个 Agent；
5. 观察：Agent 卡片消失，但工作区列表里那间测试对话**还在**。

命令行等价复现（不需要点 UI）：

```bash
BASE=http://localhost:9999
# 登录拿 cookie（--cookie-jar 保存）
curl -s -c /tmp/dt.jar -X POST "$BASE/api/auth/login" \
  -H 'content-type: application/json' -d '{"username":"admin","password":"<PASS>"}'

# 建 Agent
ID=$(curl -s -b /tmp/dt.jar -X POST "$BASE/api/paas/agents" \
  -H 'content-type: application/json' \
  -d '{"name":"复现用","system_prompt":"x","kind":"assistant"}' \
  | python3 -c 'import sys,json;print(json.load(sys.stdin)["agent"]["id"])')

# 开测试对话 → 工作区诞生
curl -s -b /tmp/dt.jar -X POST "$BASE/api/paas/agents/$ID/test-chat"

# 删 Agent
curl -s -b /tmp/dt.jar -X DELETE "$BASE/api/paas/agents/$ID"

# 断言残留（修复前：这里会打印出 web:agent-$ID；修复后：无输出）
curl -s -b /tmp/dt.jar "$BASE/api/groups" \
  | python3 -c "import sys,json;g=json.load(sys.stdin)['groups'];print([k for k in g if '$ID' in k])"
```

## 5. 诊断方法

可直接复制粘贴的检查命令：

```bash
# 1. 查库里有没有「工作区还在、Agent 定义已没」的幽灵工作区
sqlite3 ~/.deepthink-9999/db/messages.db "
  SELECT jid, folder, name FROM registered_groups g
  WHERE g.jid LIKE 'web:agent%'
    AND NOT EXISTS (
      SELECT 1 FROM agent_definitions d
      WHERE 'web:agent-'||d.id = g.jid
         OR 'web:agent-test-'||d.id = g.jid
         OR 'web:agent-orch-'||d.id = g.jid
    );"
# ⚠️ 三个 jid 形式都要匹配：只写 'web:agent-'||d.id 会把「历史命名 agent-test-{id} 的正常工作区」
#    误报成幽灵（它们的 Agent 定义其实还在，只是工作区用了改名前的 folder）。
# 想列出全部 agent 相关工作区（不筛幽灵）：
sqlite3 ~/.deepthink-9999/db/messages.db \
  "SELECT jid, folder, name FROM registered_groups WHERE jid LIKE 'web:agent%';"
```

**实机复现的取证输出**（把路由改回旧实现后跑一次 E2E，立刻出现）：

```console
$ sqlite3 ~/.deepthink-9999/db/messages.db "
    SELECT g.jid, g.folder, g.name
    FROM registered_groups g
    WHERE g.jid LIKE 'web:agent-%'
      AND NOT EXISTS (SELECT 1 FROM agent_definitions d WHERE 'web:agent-'||d.id = g.jid);"
web:agent-c859dd39-00d4-440b-a447-362a18cfea6f|agent-c859dd39-00d4-440b-a447-362a18cfea6f|E2E 切换验证 A mv0kqlr6
web:agent-660265aa-bbca-4c2d-8d72-e30a5e395c7b|agent-660265aa-bbca-4c2d-8d72-e30a5e395c7b|E2E 切换验证 A mv0krvu9
```

两间工作区的 Agent 定义都已删除（`agent_definitions` 里查不到），工作区行与目录却都还在——
这就是 §1 描述的幽灵工作区。

# 2. 查某个 folder 的文件系统残留
for d in groups sessions ipc env memory extra; do
  p=~/.deepthink-9999/$d/agent-<ID>;   # groups/ 在 DATA_DIR 下（本项目 DATA_DIR 即实例根）
  [ -e "$p" ] && echo "残留: $p"
done

# 3. 看 extra/ 里有哪些孤儿（对照 registered_groups 的 folder 列表）
ls ~/.deepthink-9999/extra/

# 4. 端到端回归（本 issue 新增的断言包含在内）
DT_BASE=http://localhost:9999 DT_USER=admin DT_PASS='<PASS>' \
DT_DATA_DIR=$HOME/.deepthink-9999 \
  node tests/e2e/agent-studio-ui.mjs
```

诊断要点：**「Agent 列表」与「工作区列表」是两个独立视图**。Agent 删掉后工作区列表仍会出现它，是最直观的信号；库里则是 `registered_groups` 有、`agent_definitions` 无。

## 6. 修复方案

### 6.1 删除 Agent 时拆除它的全部工作区（`src/routes/paas-agents.ts`）

```diff
-paasAgentsRoute.delete('/:id', (c) => {
+paasAgentsRoute.delete('/:id', async (c) => {
   const user = c.get('user');
   const id = c.req.param('id');
-  const ok = deleteAgentDefinition(id, user.id);
-  if (!ok) {
+  if (!getAgentDefinition(id, user.id)) {
     return c.json({ error: 'Agent definition not found' }, 404);
   }
+
+  // 一个 Agent 最多三间工作区：测试对话（新命名）、测试对话（改名前的历史命名）、编排工作区
+  const workspaceJids = [
+    `web:agent-${id}`,
+    `web:agent-test-${id}`,
+    `web:agent-orch-${id}`,
+  ].filter((jid) => getRegisteredGroup(jid) !== undefined);
+
+  const deps = getWebDeps();
+  for (const jid of workspaceJids) {
+    const group = getRegisteredGroup(jid);
+    if (!group) continue;
+
+    if (deps) {
+      const siblingJids = getJidsByFolder(group.folder);
+      const stopJids = Array.from(
+        new Set([...siblingJids, ...siblingJids.flatMap((j) => deps.queue.listDescendantJids(j))]),
+      );
+      try {
+        await Promise.all(stopJids.map((j) => deps.queue.stopGroup(j, { force: true })));
+      } catch (err) {
+        // 停不下来就不删这间工作区的数据：宁可留一个工作区，也不删掉正被 runner 使用的目录
+        logger.error({ err, jid, stopJids, agentId: id },
+          'Failed to stop container before deleting agent workspace');
+        continue;
+      }
+    }
+
+    deleteGroupData(jid, group.folder);
+    removeFlowArtifacts(group.folder);
+
+    if (deps) {
+      delete deps.getRegisteredGroups()[jid];
+      delete deps.getSessions()[group.folder];
+      deps.setLastAgentTimestamp(jid, { timestamp: '', id: '' });
+    }
+    logger.info({ jid, folder: group.folder, agentId: id }, 'Agent workspace removed with agent');
+  }
+
+  deleteAgentDefinition(id, user.id);
   return c.json({ success: true });
 });
```

选型理由：

- **为什么不新建一套拆除逻辑**：与 `DELETE /api/groups/:jid` 的既有顺序逐步对齐（停 runner → `deleteGroupData` → `removeFlowArtifacts` → 清内存态），复用两个已被验证的既有函数。另起一套是 v1.4.0 Swarm 踩过的坑（CLAUDE.md §2.0 ②）。
- **为什么一次覆盖三个 jid**：工作区命名在 2026-10-09 从 `agent-test-{id}` 改成 `agent-{id}`（见 `docs/issues/2026-10-09-agent-studio-detail-form-stale-and-workspace-naming.md`），历史工作区仍是旧名；另有 `agent-orch-{id}`（编排工作区）。三个都按存在与否过滤，逐个拆。
- **为什么保留 404 语义**：改成先 `getAgentDefinition` 判存在再删，是因为原来的 404 依赖 `deleteAgentDefinition` 的返回值；现在中间可能因为「runner 停不下来」而不删 Agent 定义，两者解耦后需要独立的 404 判断。**对外契约不变**（仍 200 `{success:true}` / 404），前端 `web/src/stores/agents-paas.ts:197` 无需改动。
- **为什么 runner 停不下来就跳过这间工作区（`continue`）而不是整个请求 500**：与 `DELETE /api/groups/:jid` 的「停不下来就不删，返回 500」保守风格一致；Agent 有多间工作区时，让能拆的拆掉、拆不掉的留下并记 error 日志，比整体回滚更符合「不删掉正在被使用的目录」这条底线。此时 Agent 定义仍会被删除，残留工作区可手动清理（见 §7）。

### 6.2 补上 `data/extra/{folder}`（`src/file-manager.ts`）

```diff
-/** Remove all runtime artifacts for a group folder (workspace, sessions, ipc, env, memory). */
+/** Remove all runtime artifacts for a group folder (workspace, sessions, ipc, env, memory, extra). */
 export function removeFlowArtifacts(folder: string): void {
   fs.rmSync(path.join(GROUPS_DIR, folder), { recursive: true, force: true });
   fs.rmSync(path.join(DATA_DIR, 'sessions', folder), { recursive: true, force: true });
   fs.rmSync(path.join(DATA_DIR, 'ipc', folder), { recursive: true, force: true });
   fs.rmSync(path.join(DATA_DIR, 'env', folder), { recursive: true, force: true });
   fs.rmSync(path.join(DATA_DIR, 'memory', folder), { recursive: true, force: true });
+  // extra/ 是 per-folder 持久目录（容器内 /workspace/extra，含 .npm-global 全局包），
+  // 漏删会留下几 MB~几百 MB 的孤儿目录。container-runner.ts:1082 是它唯一的写入点。
+  fs.rmSync(path.join(DATA_DIR, 'extra', folder), { recursive: true, force: true });
   deleteContainerEnvConfig(folder);
 }
```

加在 `removeFlowArtifacts` 而不是 Agent 删除路径里：这是**所有**工作区删除路径共用的函数，在这一处修等于一次性修好删除任务/删除群组/删除 Agent 三条路径。

### 6.3 回归测试

- **新增** `tests/units/remove-flow-artifacts.test.ts`（4 个用例）：断言该 folder 的 6 个目录 + `data/config/container-env/{folder}.json` 全部被删；断言同级**其它** folder 一个都不动（防止有人把删除写成扫父目录）；断言 `extra/` 里的嵌套结构（`.npm-global/lib/node_modules/x`）被递归删到底；断言对不存在的 folder 幂等不抛错。
  · 已验证**有区分度**：把新增的 extra 行注释掉，其中 2 个用例立刻失败。
- **扩展** `tests/e2e/agent-studio-ui.mjs`（第 6 步）：删掉脚本自己建的临时 Agent，断言它的工作区从 `/api/groups` 消失；给了 `DT_DATA_DIR` 时再断言 6 个目录在文件系统上都已不存在。脚本只删自己创建的 Agent，绝不动库里现成的 Agent。

#### 区分度验证（断言必须能在旧代码上失败，否则等于没测）

新加的断言只跑一遍通过是**没有说服力**的——"删完工作区不见了"也可能是它本来就不存在。所以把路由改回旧实现
（`git stash push src/routes/paas-agents.ts`）重跑了一次：

| 被测代码 | E2E 结果 | 说明 |
|---|---|---|
| 旧实现（只删 `agent_definitions`） | **20 项中 2 项失败** | 失败的正是新增的两条；其余 18 项照常通过 |
| 本修复 | **20 项全部通过** | |

旧实现下的失败输出：

```
✅ 前提：删除前 6 个目录都在（否则断言无区分度）
✅ 删除 Agent 返回成功 — HTTP 200
❌ 删 Agent 后它的工作区从列表消失 — web:agent-660265aa-bbca-4c2d-8d72-e30a5e395c7b
❌ 删 Agent 后 6 个数据目录全部清掉 — /Users/edy/.deepthink-9999/groups/agent-660265aa-...,
   .../sessions/agent-660265aa-..., .../ipc/agent-660265aa-..., .../env/agent-660265aa-...,
   .../memory/agent-660265aa-..., .../extra/agent-660265aa-...
```

注意其中那条**前提断言**：它先确认「删除前 6 个目录都在」才允许后面的断言生效。加这条是因为第一版断言
其实没有区分度——光调 `test-chat` 只会创建 `groups/` 一个目录（没真正跑过容器），于是「6 个目录全部清掉」
实际只验证了 1 个；若有人把路由改成只删 `groups/` 而不调 `removeFlowArtifacts`，断言照样通过，
而 `sessions/ipc/env/memory/extra` 会在生产里泄漏。现在由脚本补建其余 5 个目录，这条断言才真正覆盖删除路径。

#### `extra/` 修复的双路径验证

删除上面两间实测产生的幽灵工作区时走的是 `DELETE /api/groups/:jid`（另一条路径），删完 `extra/agent-660265aa-...`
同样消失——说明 §6.2 的修复对**所有**工作区删除路径生效，不是只对 Agent 删除生效：

```console
$ ls -d ~/.deepthink-9999/extra/agent-660265aa-bbca-4c2d-8d72-e30a5e395c7b
ls: ...: No such file or directory        # 删之前它存在（E2E 补建）
$ ls ~/.deepthink-9999/extra/
swarm-0beb99c4                            # 只剩与本次无关的既有目录
swarm-f1b0d0e0
```


## 7. 处理卡住的状态

本 issue 本身不产生「卡住」的运行态（幽灵工作区是静态残留，不影响服务）。若 §6.1 的 `continue` 分支被触发（有 runner 停不下来、该工作区未被拆除），手工收尾：

```bash
# 1. 先确认真没有 runner 了（Agent 定义此时已删，工作区还在）
curl -s -b /tmp/dt.jar "http://localhost:9999/api/groups" \
  | python3 -c "import sys,json;print(json.load(sys.stdin)['groups'].get('web:agent-<ID>'))"

# 2. 服务在跑的话，从 UI 的工作区列表里删掉这间工作区（走 DELETE /api/groups/:jid，含拆除逻辑）
#    命令行等价：
curl -s -b /tmp/dt.jar -X DELETE "http://localhost:9999/api/groups/web:agent-<ID>"

# 3. 若 UI 删不掉（服务异常），停服后手工清目录 + 删行
make stop-prod PORT=9999        # ⚠️ 不要用 lsof -ti:PORT | xargs kill（会杀掉 Docker/OrbStack 代理）
for d in groups sessions ipc env memory extra; do rm -rf ~/.deepthink-9999/$d/agent-<ID>; done
rm -f ~/.deepthink-9999/config/container-env/agent-<ID>.json
sqlite3 ~/.deepthink-9999/db/messages.db \
  "DELETE FROM registered_groups WHERE jid='web:agent-<ID>';
   DELETE FROM chats WHERE jid='web:agent-<ID>';
   DELETE FROM messages WHERE chat_jid='web:agent-<ID>';
   DELETE FROM sessions WHERE group_folder='agent-<ID>';"
```

## 8. 经验沉淀 / 预防

### 8.1 拆除清单要成对维护：删「行」必配删「目录」

本 issue 的两个缺陷是同一类错误——**只删了一半**。平台里「一个工作区」= 数据库若干行 + 文件系统若干目录 + 主进程内存态，三者的清理分散在 `deleteGroupData` / `removeFlowArtifacts` / route 层。新增删除路径时，三样都要做；最稳的做法是直接复用 `DELETE /api/groups/:jid` 的四步顺序，而不是自己写一遍。

**这条已被两次独立违反**：删除 Agent 完全不清理（本 issue §3.1）、`removeFlowArtifacts` 漏掉 `extra/`（§3.2）。建议 code review 时对任何 `DELETE` 路由问一句：「它对应的文件系统目录是谁在删？」

### 8.2 `DATA_DIR` 下按 folder 命名的目录，全量清单与归属

排查时把 `DATA_DIR` 下 17 个子目录逐个核对了一遍（结论已落到测试里，避免下次再靠人肉枚举）：

| 目录 | 键 | 是否需随 folder 删除 |
|---|---|---|
| `groups/` | folder | ✅ **已覆盖** |
| `sessions/` | folder | ✅ 已覆盖 |
| `ipc/` | folder | ✅ 已覆盖 |
| `env/` | folder | ✅ 已覆盖 |
| `memory/` | folder | ✅ 已覆盖 |
| `extra/` | folder | ✅ **本次补上**（此前漏删，见 §3.2） |
| `config/container-env/{folder}.json` | folder（单文件） | ✅ 已覆盖（`deleteContainerEnvConfig`） |
| `streaming-buffer/` | jid（base64url 平铺文件） | ❌ 不需要：流式过程中的临时缓冲，仅在「没有任何活跃流」时自我清理（`src/index.ts:5697`） |
| `skills/` | userId | ❌ |
| `mcp-servers/` | userId | ❌ |
| `plugins/{users,runtime}/` | userId | ❌ |
| `avatars/` | 全局 / 用户 | ❌ |
| `trace-io/` | traceId | ❌ |
| `cache/`、`file-cache/`、`harness/` | 全局 | ❌ |
| `db/` | — | ❌（就是数据库本身） |

`extra/` 是本轮枚举中**唯一**的遗漏项。

### 8.3 已知未修的相邻缺口（刻意不扩大到本 issue）

`deleteGroupData` 不清理 `im_context_bindings`——该表按 `workspace_jid` / `agent_id` 记录了 IM 话题与工作区的绑定关系。删除工作区后这些绑定行会指向已不存在的工作区。三点说明：

1. 这是**平台级既存缺口**，`DELETE /api/groups/:jid` 同样没清（它只清理 `scheduled_tasks` 的 workspace 绑定，见 `src/db.ts:7127`）；本 issue 未扩大范围去改它。
2. **不能图省事调 `deleteImContextBindingsByAgent(id)`**：该函数的 `agent_id` 指的是 `agents` 表（`SubAgent`，由 IM 话题派生，`src/index.ts:10439` 用 `crypto.randomUUID()` 生成 `SubAgent`），与本 issue 里的 `agent_definitions.id`（Agent Studio 的 Agent）是**两个不同的 id 空间**。传 Agent 定义的 id 进去属于语义错配，清不掉该清的行。这也解释了为什么那个函数至今零调用者。
3. 若将来要修，正确的目标是 `deleteImContextBindingsByWorkspace(jid)`（已有，被 `groups.ts:1339` 的工作区重建路径使用），且应同时修 `DELETE /api/groups/:jid`。

### 8.4 其它预防手段

- **新加的断言必须先在旧代码上跑一遍，确认它会红**：这已经是**同一个坑的第二次**了——`agent-studio-ui.mjs`
  早先的"切换后 System Prompt 会刷新"断言，因为库里两个 Agent 的 prompt 完全相同而毫无区分度
  （见 `docs/issues/2026-10-09-agent-studio-detail-form-stale-and-workspace-naming.md` §8）。本次的"6 个目录全部清掉"
  又差点重蹈覆辙（只创建了 1 个目录）。做法固定为：`git stash push <改动文件>` → 重编译 → 重跑 → 确认目标断言失败 →
  `git stash pop`。顺带还能拿到修复前的取证输出，一份工作两份收益。
- **给回归加断言而不是给文档加说明**：`tests/units/remove-flow-artifacts.test.ts` 逐个列出 6 个目录并断言同级目录不受影响——下次有人再加 per-folder 目录却忘了清理，或者把删除误写成扫父目录，测试会直接红。
- **E2E 支持文件系统侧断言需要显式给 `DT_DATA_DIR`**：E2E 是跨进程调用，猜不出被测实例的数据目录（`~/.deepthink-<PORT>`，由 Makefile 注入）。不给就只验 API/DB 侧并在输出里明确写「跳过了文件系统侧」，**不静默降级**。
- **排查这类问题优先用隔离实例**：`make start-prod PORT=9999`（数据目录 `$HOME/.deepthink-9999`，与生产完全隔离），本次全部复现与验证都在它上面完成。停止必须用 `make stop-prod PORT=9999`——该命令先写停止标记再杀端口监听进程，缺了停止标记 watchdog 会把进程重新拉起；且**禁止** `lsof -ti:PORT | xargs kill`（会连 Docker/OrbStack 网络代理一起杀掉）。
