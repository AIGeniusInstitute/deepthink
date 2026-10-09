# 2026-10-09 开放平台 Agent API 长任务必然 500（硬编码 120s 超时 + 错误信息被吞）

> 类型：issue 修复（线上接口报错）。非新需求开发，不走 PRD → tech_solution → test_report 流水线。

---

## 1. 用户现象

用开放平台的 API Key 调 Agent（Agent as a Service）接口，请求**必然**失败：

```bash
curl http://localhost:9999/v1/agents/54de5c67-3377-4456-9847-8d9da7898154/chat/completions \
  -H "Authorization: Bearer sk-HN_..." \
  -H "Content-Type: application/json" \
  -d '{"messages":[{"role":"user","content":"临床研究 AI Agent 平台的知识库与数据服务平台"}]}'
```

返回（实测耗时 **122s**）：

```json
{"error":{"message":"Agent execution failed","type":"server_error","code":500}}
```

现象的关键特征是**耗时恒定在 2 分钟出头**——不管 prompt 是什么、Agent 是哪个，都是这个时长，
说明不是上游模型偶发故障，而是有个定时器在掐。

同一个接口、同一个 Key、同一个 Agent，把 prompt 换成一句话的短任务则**正常返回**：

```
HTTP:200 total:7.041031s
{"choices":[{"message":{"role":"assistant","content":"收到"}},...]}
```

---

## 2. 问题描述

`/v1/agents/:agentId/chat/completions` 的实现是"在 HTTP 请求里同步跑完一个 Agent"：
路由调 `runAgent()` → `@anthropic-ai/claude-agent-sdk` 的 `query()` → 等最终 `result`。
`runAgent()` 给每次调用挂了一个**硬编码 120 秒**的 `AbortController` 定时器。

问题在于：**一次 Agent 运行的耗时由任务决定，不由 HTTP 层决定**。这个 Agent
（`AI 大模型智能体论文写作专家`）在做 web 会话时写出过一篇 44KB 论文，实测耗时约 **14 分钟**
（`14:43:05` 起跑 → `14:57:45` 落盘）。也就是说：

- web / IM 路径：`containerTimeout` 默认 **30 分钟**，跑得完；
- 开放平台 API 路径：写死 **120 秒**，**任何真实任务都跑不完**，100% 在 120s 被 abort。

被 abort 后，`runAgent()` 的 catch 又把真实原因替换成一句无信息量的 `Agent execution failed`
（`status = 500`），日志里同样只剩这句话，导致排查必须先复现才能拿到线索。

---

## 3. 根因

### 3.1 硬编码的 120s / 300s 超时（直接原因）

`src/open-platform/agent-service.ts`（改前）：

```ts
const DEFAULT_TIMEOUT_MS = 120_000;   // :22  ← 同步接口
const STREAM_TIMEOUT_MS = 300_000;    // :23  ← 流式接口

// buildQueryOptions() 内：
const abortController = new AbortController();
const timer = setTimeout(() => abortController.abort(), timeoutMs);
```

超时到点 → `abort()` → SDK 终止 Claude Code 子进程 → `query()` 的 `for await` 抛错。

### 3.2 报错文案会误导排查方向

SDK（`node_modules/@anthropic-ai/claude-agent-sdk/sdk.mjs`，压缩后）在子进程 `error` 事件里：

```js
Q.on("error",(ee)=>{ ...
  if(this.abortController.signal.aborted)
      this.exitError = u_(),        // u_() => new Error("Claude Code process aborted by user")
      hn(ee,{telemetryMessage:"Claude Code process aborted by user",errorClass:"aborted"});
  else if(we&&Sw(ee)){ /* 这里才会报真正的 spawn 错误（ENOENT 等） */ }
```

即 `Claude Code process aborted by user` 是 **abort 语境下的兜底文案**，它会**覆盖**这次 `error`
事件本来的内容。看到这句话不要去查"claude 可执行文件没找到 / 进程起不来"——它更可能是超时。

### 3.3 真实原因被 catch 吞掉（放大原因）

```ts
} catch (err) {
  logger.warn({ agentId, err: (err as Error).message?.slice(0, 200) }, 'runAgent failed');
  const e: any = new Error('Agent execution failed');   // ← 上游 message 在这里被丢弃
  e.status = 500;
  throw e;
}
```

路由层 `src/routes/open-platform.ts:291` 本来是按 `err.message` 往外吐的
（`(err as Error).message || 'Agent execution failed'`），也就是说**原设计意图就是要透出原因**，
是 `runAgent` 把它换成了通用文案。日志里同样只剩 `Agent execution failed`，现场证据为零。

---

## 4. 复现路径

前置：本机跑着一个隔离实例（`make start-prod PORT=9999`），库里有该 Agent + 一个带 `agent` scope 的 API Key。

1. 发长任务请求（任意需要多轮工具调用的 prompt）：

   ```bash
   curl -s -w "\nHTTP:%{http_code} total:%{time_total}s\n" \
     http://localhost:9999/v1/agents/54de5c67-3377-4456-9847-8d9da7898154/chat/completions \
     -H "Authorization: Bearer sk-HN_..." -H "Content-Type: application/json" \
     -d '{"messages":[{"role":"user","content":"临床研究 AI Agent 平台的知识库与数据服务平台"}]}'
   ```

2. 观察：`total` ≈ **122s**，body 为 `{"error":{"message":"Agent execution failed",...}}`。

3. 对照（同一 Key / 同一 Agent，短任务）：

   ```bash
   -d '{"messages":[{"role":"user","content":"只回答两个字：收到"}]}'   # → HTTP 200, ~7s
   ```

   短任务成功 ⇒ 鉴权、计费、provider、SDK 通路全部正常 ⇒ 变量只有"运行时长"。

---

## 5. 诊断方法

```bash
# 1) 日志里唯一的那行真话（改前）——注意 err 字段
grep -A4 "runAgent failed" logs/deepthink-9999.log
#  [WARN] runAgent failed
#      agentId: "54de5c67-..."
#      err: "Claude Code process aborted by user"     ← 就是超时 abort

# 2) 确认超时来源是代码而非上游
grep -n "TIMEOUT_MS" src/open-platform/agent-service.ts

# 3) 对照 web 路径同一 Agent 的真实耗时（证明任务本身就要十几分钟）
grep -n "Spawning host agent" -A3 logs/deepthink-9999.log | head
grep -n "Agent output:" logs/deepthink-9999.log | head
```

改后，超时会直接打出根因，不再需要复现：

```
[WARN] runAgent timed out
    agentId: "54de5c67-..."
    timeoutMs: 60000
    elapsedMs: 62028
```

---

## 6. 修复方案

### 改动 1：超时改用平台统一的 `containerTimeout`（核心）

```diff
-import { buildClaudeEnvLines, getClaudeProviderConfig } from '../runtime-config.js';
+import {
+  buildClaudeEnvLines,
+  getClaudeProviderConfig,
+  getSystemSettings,
+} from '../runtime-config.js';

-const DEFAULT_TIMEOUT_MS = 120_000;
-const STREAM_TIMEOUT_MS = 300_000;
+/**
+ * Agent 单次运行的时长上限。用平台统一的 `containerTimeout`（默认 30 分钟，
+ * 设置页 / `CONTAINER_TIMEOUT` 可调），与容器 / 宿主机路径同一把尺子。
+ */
+function agentTimeoutMs(): number {
+  return getSystemSettings().containerTimeout;
+}
```

同步 / 流式两处都改为 `const timeoutMs = agentTimeoutMs();`。
`containerTimeout` 已经在 `runtime-config.ts` 里做了范围钳制（1 分钟 ~ 24 小时）并有设置页入口，
所以复用它是"同一把尺子"，不需要再引入一个新开关。

### 改动 2：区分超时与真实故障，并把上游原因透出来

```diff
  } catch (err) {
-    logger.warn({ agentId, err: (err as Error).message?.slice(0, 200) }, 'runAgent failed');
-    const e: any = new Error('Agent execution failed');
-    e.status = 500;
-    throw e;
+    const upstream = (err as Error)?.message || String(err);
+    const elapsedMs = Date.now() - startedAt;
+    // abortController 只有本函数的超时定时器会触发（finally 里的 abort 在
+    // return/throw 之后才执行），所以信号已 abort ⇒ 就是超时，不是上游故障。
+    if (abortController.signal.aborted) {
+      logger.warn({ agentId, timeoutMs, elapsedMs }, 'runAgent timed out');
+      const e: any = new Error(`Agent execution timed out after ${Math.round(elapsedMs / 1000)}s`);
+      e.status = 504;
+      throw e;
+    }
+    logger.warn({ agentId, elapsedMs, err: upstream.slice(0, 200) }, 'runAgent failed');
+    const e: any = new Error(`Agent execution failed: ${upstream}`.slice(0, 300));
+    e.status = 500;
+    throw e;
  } finally {
```

`streamAgent()` 的 SSE 错误块同样区分（`agent_error` 里带上是超时还是具体原因）。

### 选型理由

| 决策 | 理由 |
|---|---|
| 复用 `containerTimeout` 而非新加 `OPEN_PLATFORM_*_TIMEOUT` | 平台语义就是"一次 Agent 最多跑多久"，web/IM 路径用的就是它；设置页已有入口，避免同一概念两个开关 |
| 超时返回 **504** 而非 500 | 500 的含义是"服务坏了"，504 gateway timeout 才准确；调用方可以据此判断"该改流式或加长超时" |
| 保留上游 message | 路由本来就打算透出 `err.message`（`open-platform.ts:291`），是 `runAgent` 把它丢了；不保留就永远只能复现才能定位 |
| 不做"超时返回半截文本" | 同步接口只消费最终 `result`；把被砍断的半成品当成功返回比报错更坏（调用方无法区分"写完了"和"被砍了"） |

### 改动 3：把 Agent 的 `cwd` 显式指到它自己的工作区（补做，见 §8 遗留风险）

超时解除后长任务会真正跑完，暴露了原实现一个更严重的问题：`buildQueryOptions()`
**没有传 `cwd`**，而 SDK 的 `Options.cwd` 默认取 `process.cwd()`——本服务从仓库根目录启动，
等于把**平台源码树**交给一个 `permissionMode: 'bypassPermissions'` 的 Agent 当工作目录。

```diff
+function resolveAgentWorkspaceDir(agentId: string): string {
+  const registered =
+    getRegisteredGroup(`web:agent-${agentId}`) ?? getRegisteredGroup(`web:agent-test-${agentId}`);
+  const dir = path.join(GROUPS_DIR, registered?.folder ?? `agent-${agentId}`);
+  fs.mkdirSync(dir, { recursive: true });
+  return dir;
+}
+
 export function resolveAgent(agentId, userId) {
   ...
       mcpServers: resolveAgentMcpServers(def.user_id, agentId),
       agents: buildWorkerAgents(listAgentWorkers(agentId)),
+      workspaceDir: resolveAgentWorkspaceDir(agentId),
   };
 }

   const options: Record<string, unknown> = {
+    cwd: agent.workspaceDir,
     ...(agent.model ? { model: agent.model } : {}),
```

### 改动 4：Agent 删除时兜底清理「只有 API 用过」的工作区目录

改动 3 让每个 AaaS Agent 都有了一间工作区，但用户可能从没点过 Agent Studio 的"测试对话"
——那种情况下目录存在、却没有 `registered_group` 行，而 `DELETE /api/paas/agents/:id`
只遍历有注册行的 folder，会留下孤儿目录（该目录是本次改动新引入的，属于"自己的 mess"）。

```diff
   ].filter((jid) => getRegisteredGroup(jid) !== undefined);
+  // 上面这轮循环处理的是"已注册为工作区"的 folder（其中含"runner 停不下来就有意保留
+  // 目录"的情况，所以下面兜底时要避开它们）。
+  const handledFolders = new Set(
+    workspaceJids.map((jid) => getRegisteredGroup(jid)?.folder).filter((f): f is string => !!f),
+  );

   ...
+  for (const folder of [`agent-${id}`, `agent-test-${id}`]) {
+    if (handledFolders.has(folder)) continue;
+    if (!fs.existsSync(path.join(GROUPS_DIR, folder))) continue;
+    removeFlowArtifacts(folder);
+    logger.info({ folder, agentId: id }, 'Agent API-only workspace dir removed with agent');
+  }
+
   deleteAgentDefinition(id, user.id);
```

刻意**跳过** `handledFolders`：那轮循环里有"runner 停不下来就有意保留目录"的保护，
兜底不能把它覆盖掉。

### 选型理由（改动 3 / 4）

| 决策 | 理由 |
|---|---|
| 复用 Agent Studio 测试对话那间工作区，而不是另建 `agent-api-{id}` | 同一个 Agent 的产出应该待在同一间屋子：用户在 Studio 里能看到、能接着用；另建会导致"API 写的文件 UI 里找不到" |
| `folder` 优先取注册行、缺失才回落到 `agent-{id}` | 历史工作区 jid 是 `web:agent-test-{id}` 且 folder 是注册时写死的那串；直接拼 `agent-{id}` 会跟已有目录分叉成两份 |
| 目录不存在就创建（而不是报错） | 从没点过"测试对话"是最常见的状态，报错等于让 AaaS 对绝大多数 Agent 不可用 |
| 创建失败不兜底回落 `process.cwd()` | 宁可这次调用**报错**，也不要静默退回"在仓库根目录里跑一个可写 Agent"——那正是本次要修掉的东西 |
| 删除时额外扫 `agent-${id}` / `agent-test-${id}` | folder 由 Agent UUID 派生、天然唯一，按同一规则兜底不会误删别人的目录 |

---

## 7. 处理卡住的状态

不适用：本次是"请求被 abort"，没有留下 stuck 的运行态或残留进程。

---

## 8. 经验沉淀 / 预防

1. **不要在 API 层给 Agent 运行时长设"看起来合理"的常数**。Agent 的耗时分布是长尾的
   （本平台实测：一句话 7s，写一篇论文 ~14min），任何"拍脑袋的常数"都会变成某类任务的
   硬性失败。要设上限就复用平台统一的那把尺子（`containerTimeout`）。
2. **错误包装（catch→new Error）必须保留上游 message**。这类"吞掉原因"的写法会把
   一次 5 分钟就能定位的排查拖成"必须复现"。凡是 `catch` 后重新构造 Error 的地方，
   都应把 `err.message` 带上（或至少完整落日志）。
3. **SDK 的 abort 文案具有误导性**：`Claude Code process aborted by user` 是 abort 分支的
   兜底文案，会覆盖真正的子进程错误。看到它先想"谁 abort 了我"，不要先去查可执行文件。
4. 巡检建议：开放平台接口若再次出现"耗时高度集中于某个恒定值（如 ~120s / ~300s）"的
   500/504，直接怀疑定时器而不是上游。
5. **凡是"跑 Agent"的新入口，都要显式给 `cwd`**。`Options.cwd` 默认是 `process.cwd()`，
   而平台从仓库根目录启动——漏传就等于让一个 `bypassPermissions` 的 Agent 站在源码树里。
   这条对超时/权限类 bug 尤其隐蔽：**接口返回 200 也不代表做对了**，落盘位置得断言文件系统。
6. **修完一个"掐断"类 bug 后要回头看它掩盖了什么**。120s 的硬超时把"cwd 泄漏"藏了三个月；
   解除限制的那一刻，原本被压住的问题会立刻变成新的线上事故——所以修"限制"时，
   要顺着"被限制住的那条路径在实际运行中还会碰到什么"再走一遍。

### 遗留风险（原记录的 cwd 问题，本轮已修）

`buildQueryOptions()` **没有传 `cwd`**，SDK 的 Claude Code 子进程因此继承主进程的
`process.cwd()`（即 DeepThink 仓库根目录），且 `permissionMode: 'bypassPermissions'`。
而 web 路径是显式把 `cwd` 指到该 Agent 的工作区（`container-runner.ts:2596` `cwd: groupDir`）。

改前超时 120s 把多数任务掐死在"还没开始写文件"的阶段，所以没暴露；**改后长任务会真正跑完**，
一个会写文件的 Agent 就可能把产物写进平台自己的源码树。这不是推测——上一轮两次验证运行里，
Agent 都按 `./papers/...` 落盘（写到验证进程的 cwd 下）；验证时特意把 cwd 换成
`/tmp/dt-verify/cwd`，所以仓库当时是干净的。

**已于本轮修复**：改动 3（`cwd` 指向工作区）+ 改动 4（删除时兜底清理），
验证见下方"cwd 修复验证"表——同一份脚本在改前/改后跑出**相反**结果。

### 仍然存在的已知取舍（本次接受，未改）

1. **AaaS 与 Agent Studio「测试对话」共用同一间工作区**，且 API 路径**没有** group-queue
   那样的串行化。同一个 Agent 同时被 API 和 Web 调用时，两个 SDK 会话会并发在同一个
   `cwd` 里读写。这与平台既有语义（一个 folder 一个运行中进程）不完全一致，但比"写到仓库根目录"
   严格更好；要彻底解决需要给 API 路径接 queue 或按调用派生工作区，属于独立设计题。
2. `resolveAgent()` 现在会**创建目录**——`getAgentDefinitionById` 之后即产生副作用。
   纯读的调用方（如权限探活）也会建目录。当前没有这种调用方，改动面保持最小；若将来出现，
   应把建目录挪到 `runAgent` / `streamAgent` 里。

---

## 验证记录

| 用例 | 命令要点 | 预期 | 实测 |
|---|---|---|---|
| 复现（改前） | HTTP 长任务 | 500 | ✅ `HTTP:500 total:122.034036s` |
| 对照（改前） | HTTP 短任务 | 200 | ✅ `HTTP:200 total:7.041031s` |
| 回归（改后） | `runAgent()` 短任务 | ok | ✅ `{"ok":true,"elapsedMs":3751,"textLen":2}` |
| 超时映射（改后） | `CONTAINER_TIMEOUT=60000` + 长任务 | 504 + 带秒数 | ✅ `{"ok":false,"status":504,"message":"Agent execution timed out after 62s"}` |
| 长任务 1（改后） | `runAgent()` + 原 prompt，默认 30min 上限 | 跑完返回 | ✅ `{"ok":true,"elapsedMs":168342,"textLen":2095}`（168s **>** 120s，旧代码必挂） |
| HTTP 端到端（改后） | 原样重放用户那条 curl（真实 9999 实例） | 200 + 正文 | ✅ **592s** 后返回 `chat.completion` 成功载荷（663 行论文落盘） |
| 回归（改后，实例恢复） | 实例重启后短任务 | 200 | ✅ `HTTP:200 total:4.117462s` |

> 验证方式：先做进程内验证——数据目录整体复制到 `/tmp/dt-verify/data` 隔离运行
> （避免写生产库的计费记录），**直接调用 `runAgent()`** 绕开 HTTP 层噪声。
> 再做 HTTP 端到端——`make stop-prod PORT=9999` 后用修复版 `dist/` 从独立 cwd 重启同端口同数据，
> 原样重放用户那条 curl，最后 `make start-prod PORT=9999` 恢复 watchdog 托管。
> 备注：HTTP 那次的 `%{http_code}` 行被 `head -c` 截断，但响应体是 `chat.completion`
> 成功载荷——错误分支只会产出 `{"error":{...}}`，故 200 由构造保证。

> 附带证据（见下方遗留风险）：两次运行中 Agent 都把论文产物写到了 **`<cwd>/papers/`**
> （`/private/tmp/dt-verify/cwd/papers/…_paper.md`，663 行 / 88 处 TODO）。
> Agent 写文件的基准就是进程 cwd，而生产实例的 cwd 是仓库根目录。

### cwd 修复验证（改动 3 / 4）

脚本 `/tmp/dt-verify/e2e-cwd.mjs`：隔离实例 9998（空库 + 复制来的 provider 配置），
登录 → 建 API key → 建 Agent → 经 `/v1/agents/{id}/chat/completions` 让 Agent
"写出 `cwd-marker.txt`" → 断言产物落在 `groups/agent-{id}/`、且仓库根目录干净
→ `DELETE /api/paas/agents/{id}` → 断言目录被清掉。
删除前**刻意先 `mkdir` 该目录**，好让删除断言在"旧代码从不创建它"时也有区分度。

| 断言 | 改前（`git checkout` 回旧实现后重建） | 改后 |
|---|---|---|
| `artifact_in_workspace`（产物落在 `groups/agent-{id}/`） | ❌ `false` | ✅ `true`（内容含 marker） |
| `artifact_leaked_to_cwd`（产物落进仓库根目录） | ❌ `true` | ✅ `false` |
| `repo_dirty_entries`（worktree `git status`） | ❌ `["?? cwd-marker.txt"]` | ✅ 仅本次改动的两个文件 |
| `workspace_dir_after_delete`（删除 Agent 后目录残留） | ❌ `true` | ✅ `false` |
| `aaas_status` | 200（短任务本来就能过） | 200 |

> 四条断言在改前全红、改后全绿 —— 说明它们**测的是本次改动**，而不是环境或模型行为。
> 改前那次真实把 `cwd-marker.txt` 写进了 worktree 根目录（`?? cwd-marker.txt` 就是它），
> 已随手清掉；这正是本 issue 要防的事情在生产里的样子。
>
> 注意"aaas_status 改前也是 200"：本次修的是**落盘位置**，不是"调用是否成功"——
> 所以只用 HTTP 状态码验证会得出"没问题"的错误结论，必须断言文件系统状态。
