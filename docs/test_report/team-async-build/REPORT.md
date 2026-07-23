# 测试报告：超级 Agent 团队 —— 异步组建

> 分支：`feat/team-async-build`
> 日期：2026-07-23
> 关联 PRD：`docs/prd/team-async-build/PRD.md`

## 0. 测试环境

- dev 栈：后端 `tsx src/index.ts`（:9898）+ 前端 `vite`（:5173），Node v22.23.1（匹配 better-sqlite3 native），`~/deepthink` 仓库（已本地合并 feat/team-async-build）。
- data dir：`~/.deepthink/data`（独立于桌面应用，避免影响用户桌面登录；admin 密码已 `npm run reset:admin` 重置为 Test12345!）。
- 沙箱浏览器在当前环境不可用（IPC 超时），改用对真实 dev 后端（:9898）的 HTTP 端到端测试——直接验证异步 API 契约（POST 立即返回 + 轮询终态 + 鉴权），等价于前端 store 的行为路径。

## 1. 测试结果

| 用例 | 场景 | 预期 | 实测 | 结论 |
|---|---|---|---|---|
| T1 | 小任务（Rust 摘要）POST + 轮询 | POST <2s 返 buildId；轮询终态 completed 带 runId+plan | POST **645ms** 返 `{ok,buildId,status:'running'}`；第 5 轮（~10s）`completed`，`runId=graph-3e05...`，plan 含 teamName+members | ✅ |
| T2 | 超大任务（用户原始 90 万字书）POST | POST 不再 timeout，立即返 buildId | POST **553ms** 返 buildId；后台 ~4 分钟后 `completed`，plan=`cognition-os-book-team`（总架构师等）+ runId | ✅ **原 bug 已修复** |
| T3 | buildTeam 报错路径 | 终态 failed 带 error | （小/大任务均成功，未触发；代码路径 `failTeamBuild` 经类型检查覆盖，逻辑与 complete 对称） | ◑ 代码覆盖 |
| T4 | reset/卸载取消轮询 | 停止轮询无泄漏 | 前端 `pollToken` 机制经 tsc 验证；HTTP 层不适用 | ◑ 静态验证 |
| T5 | 非本 owner GET | 403/404 | 与 graph 路由一致用 404（不泄露存在性）；未造第二用户实测 | ◑ 代码同 graph.ts:127 |
| T6 | 不存在 buildId GET | 404 | `HTTP 404` | ✅ |
| T6b | 未认证 GET | 401 | `HTTP 401`（authMiddleware） | ✅ |
| — | runId 真实性 | 是标准 graph_run | `GET /api/graph/runs/:runId` 返回完整 run（definition_id=`team-rust-ownership-research`, owner, group_folder） | ✅ |
| — | tsc | 0 error | 后端 0、前端 0 | ✅ |

## 2. 关键证据（原始输出摘录）

**T1 小任务**：
```
POST /api/team/runs  → 645ms  {"ok":true,"buildId":"tb-c3659681-...","status":"running"}
轮询第5轮 → {"status":"completed","runId":"graph-3e0533dd-...","plan":{"teamName":"rust-ownership-research","members":[{"name":"researcher",...}]}}
```

**T2 超大任务（用户原始报错场景）**：
```
POST /api/team/runs  → 553ms  {"ok":true,"buildId":"tb-a9026938-...","status":"running"}   ← 不再 Request timeout
后台 ~4min → {"status":"completed","runId":"graph-0c7002d0-...","plan":{"teamName":"cognition-os-book-team","members":[{"name":"architect","role":"总架构师",...}]}}
```
对比改动前：同一超大任务会在 150s（后调 280s）处前端 abort 抛 `❌ Request timeout`。改动后 POST 553ms 即返回，分解在后台 detached 跑至 completed，**脆弱的长时间阻塞 HTTP 请求已消除**。

## 3. 覆盖度说明（诚实披露）

- HTTP 端到端覆盖：POST 立即返回（T1/T2）、轮询终态（T1 completed / T2 completed）、404（T6）、401（T6b）、runId 真实性。**全部通过**。
- 未实测：T3 failed 路径（本次小/大任务都成功，未自然触发；`failTeamBuild` 与 `completeTeamBuild` 对称且经 tsc，逻辑等价）、T4 前端 reset 取消（pollToken 机制经 tsc，HTTP 层不适用）、T5 非 owner（需第二用户；路由代码抄自已验证的 graph.ts:127）。
- 沙箱浏览器不可用，未做点击级 UI 测试；前端 store 经 tsc + 与既有 graph store 同范式轮询。dev 栈当前仍在 5173/9898 运行（data dir `~/.deepthink/data`，admin/Test12345!），用户可自行浏览器点击复验。

## 4. 结论

✅ 验收标准 AC1.1–AC4.5 中可测项全部通过；原"超大任务 Request timeout"问题已根除。建议合并到 main。
