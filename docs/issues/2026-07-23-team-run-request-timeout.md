# 2026-07-23-team-run-request-timeout

## 1. 用户现象

「团队」页面（`http://127.0.0.1:5173/team`）：输入一个复杂任务（本例为「写一本 9 章 90 万字的 AI Agent 技术书籍」），点击「组建团队并启动」，执行过程中前端弹出：

```
❌ Request timeout
```

对应的网络请求 `POST http://127.0.0.1:5173/api/team/runs` 被前端主动 abort，状态码 408。

## 2. 问题描述

`POST /api/team/runs` 的后端处理函数 `buildTeam()` 在返回响应前，**同步阻塞**于 `decompose()`——一次（失败则重试一次）LLM 分解调用。该调用单次超时 120s、重试一次，**最坏耗时 ≈ 2 × 120s = 240s**，之后才创建成员 / 注册 graph / 启动 run 并返回 `{runId, plan}`。

而前端 `useTeamStore.buildTeam` 给这次请求设的前端超时是 **150s**（`web/src/stores/team.ts` `timeoutMs: 150_000`）。`150s < 240s`，于是对超大任务（LLM 分解慢，或 JSON 解析失败触发重试）请求在前端被 `AbortController` 提前中断，`web/src/api/client.ts:36` 把 `AbortError` 转成 `{ status: 408, message: 'Request timeout' }`，用户看到「Request timeout」。

后端 `requestTimeout` 为 10min（600s），并非瓶颈；后端在请求被前端放弃后往往仍在继续，甚至最终成功启动了 team run，但用户已被错误提示误导。

## 3. 根因

**代码层面：前端请求超时阈值（150s）小于后端 `buildTeam` 的最坏阻塞耗时（240s），两者未对齐。**

证据链：

| # | 文件:行 | 证据 |
|---|---|---|
| 1 | `web/src/api/client.ts:3` | `const REQUEST_TIMEOUT_MS = 8000;`（默认 8s） |
| 2 | `web/src/api/client.ts:34-37` | `fetch` 抛 `AbortError`（DOMException, name==='AbortError'）→ `throw { status: 408, message: 'Request timeout' }` |
| 3 | `web/src/stores/team.ts:62`（修复前） | `timeoutMs: 150_000` —— 前端 150s 后 abort |
| 4 | `src/agent-team/team-builder.ts:58` | `const DECOMPOSE_TIMEOUT_MS = 120_000;` |
| 5 | `src/agent-team/team-builder.ts:61-73` | `decompose()`：attempt 1 → 解析失败 → attempt 2 → 仍失败 → fallback；两次 `sdkQuery` 各带 120s 超时 |
| 6 | `src/sdk-query.ts:24,38-39,66` | `sdkQuery` 超时/失败返回 `null` → `parseTeamPlan(null)` 失败 → 触发重试 |
| 7 | `src/web.ts:2849` | 后端 `requestTimeout: 10 * 60 * 1000`（600s），非瓶颈 |

外部依据：Claude Agent SDK 的 `query()` 在 `abortController.abort()` 后即结束迭代（见 `sdk-query.ts:45-62`），故单次 attempt ≈ 120s，两次 ≈ 240s。

## 4. 复现路径

1. 启动开发栈：在 `~/deepthink` 下 `npm run dev`（后端 :9898）+ `npm run dev:web`（前端 :5173）。
2. 浏览器打开 `http://127.0.0.1:5173/team`，登录 `admin / Test12345!`。
3. 在「目标」输入框粘贴一个**超大复杂任务**（例如「写一本 9 章 90 万字的技术书，每章 10 万字…」级别的大段 prompt）。
4. 点击「组建团队并启动」。
5. 等待约 150s，前端弹出 `❌ Request timeout`；此时后端日志通常仍能看到 `Team decompose attempt 1 invalid; retrying` 之类，并在 ~240s 后（成功或降级）继续 `Super Agent Team started`。

> 小任务（分解 <150s 一次成功）不会复现，因此该 bug 仅在「任务大到使 LLM 分解耗时 >150s 或触发重试」时暴露。

## 5. 诊断方法

```bash
# 5.1 直接看前端给 team/runs 设的超时（修复前 150_000）
grep -n "timeoutMs" ~/deepthink/web/src/stores/team.ts

# 5.2 看后端 decompose 的最坏耗时来源
grep -n "DECOMPOSE_TIMEOUT_MS\|sdkQuery(prompt" ~/deepthink/src/agent-team/team-builder.ts

# 5.3 看前端 AbortError → 408 的转换
grep -n "AbortError\|Request timeout" ~/deepthink/web/src/api/client.ts

# 5.4 实测复现（需要开发栈在跑）
# 浏览器 DevTools → Network → POST /api/team/runs，观察是否在 150s 处变为 (failed) / 408。
```

## 6. 修复方案

**Surgical：把前端 `team/runs` 请求超时对齐到后端最坏阻塞耗时。**

`web/src/stores/team.ts`：

```diff
       }>('/api/team/runs', {
         method: 'POST',
         body: JSON.stringify(input),
-        timeoutMs: 150_000, // decomposition + member creation can take a while
+        // buildTeam 在后端同步阻塞于 decompose()（LLM 分解，单次 120s 超时、
+        // 失败重试 1 次 → 最坏 2×120s=240s），之后才创建成员/注册/启动 graph。
+        // 原值 150s < 240s 最坏耗时，超大任务会在此提前 abort，抛出 AbortError
+        // → client.ts 转成 408 'Request timeout'，而后端其实仍在跑甚至最终成功。
+        // 这里对齐后端最坏耗时（240s）+ 余量，且保持低于后端 requestTimeout(600s)
+        // 与 Node/Vite 默认 requestTimeout(300s)。
+        timeoutMs: 280_000,
       });
```

**选型理由（为什么是改前端超时，而不是别的方案）：**

- 后端 `requestTimeout` 已是 600s，不是瓶颈；Vite dev proxy（http-proxy）默认 `proxyTimeout` 不设（无限）；Node 默认 `requestTimeout` 300s。所以前端超时阈值可安全提升到「>240s 且 <300s」区间，**280s** 即落在其中：实际完成 ≤240s < 280s（前端兜底）< 300s（服务端兜底），不会触发任何一层超时。
- 不动后端 `DECOMPOSE_TIMEOUT_MS`（120s）与重试逻辑：缩短单次超时会伤害超大任务的分解质量（LLM 来不及产出完整 TeamPlan → 总是降级单 agent），属于行为变更，超出本 issue 范围（Surgical Changes 原则）。
- 不引入「异步 build + 轮询」重构：前端在拿到 `plan` 后才画 DAG（`TeamPage` 依赖 `lastPlan`），完全异步化需新增 build-job 表 / 轮询端点 / 前端状态机，属新需求开发，非 issue 修复（Simplicity First 原则）。作为后续改进项记录于第 8 节。

**验证：** 在 worktree 内 `npx tsc --noEmit -p web/tsconfig.json` → 0 error。

## 7. 处理卡住的状态（如适用）

无需救活 stuck 运行态。但注意：修复前若用户已触发该 bug，后端可能仍在后台跑那个被前端放弃的 team run。可用以下命令核查 / 清理残留 run：

```bash
# 查看是否有仍在运行的 graph_run（含 team- 前缀的 definition）
sqlite3 ~/deepthink/data/db/deepthink.db "SELECT id, definition_id, status FROM graph_runs WHERE status='running';"
```

## 8. 经验沉淀 / 预防

**根因类：**「前端请求超时阈值 < 后端同步阻塞最坏耗时」——凡后端在返回前有不定时长的同步 LLM 调用（分解 / 评审 / 摘要），前端超时都必须按后端**最坏**耗时对齐，而非「经验值」。这类端点的超时不能复用通用 `REQUEST_TIMEOUT_MS=8s`，必须单独设大。

**巡检 / 静态约束：**

```bash
# 找出所有「带 timeoutMs 的 apiFetch 调用」与「后端 await sdkQuery / LLM 调用」做交叉比对，
# 确保前端阈值 ≥ 后端最坏（含重试）耗时。
grep -rn "timeoutMs" ~/deepthink/web/src | grep -v node_modules
grep -rn "DECOMPOSE_TIMEOUT_MS\|GATE_REVIEW_TIMEOUT_MS\|timeout:" ~/deepthink/src | grep -i "timeout"
```

**后续改进项（非本次范围）：** 将 `POST /api/team/runs` 改为异步——立即返回 `buildId`，`decompose + 组建` 在后台 detached 执行（与 graph 执行同样模式），前端轮询 `GET /api/team/builds/:id` 拿 `plan`，再进入 DAG 可视化。彻底消除「长时间阻塞 HTTP 请求」这一脆弱模式，避免未来任何代理 / 网关 / 浏览器的隐性超时再次踩雷。

**告警建议：** 后端 `logger.warn('Team decompose attempt N invalid; retrying' …)` 若频繁出现，说明分解 prompt 对当前模型过载，应收敛 prompt 或拆解粒度，而非依赖重试 + 大超时兜底。
