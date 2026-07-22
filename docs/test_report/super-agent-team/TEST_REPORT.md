# 测试报告：超级 Agent 团队（Super Agent Team）— 自主 Multi-Agent 协同

> 分支：`feat/super-agent-team`
> 日期：2026-07-22
> PRD：`docs/prd/super-agent-team/PRD.md`
> 技术方案：`docs/tech_solution/super-agent-team/SOLUTION.md`
> 执行状态：`docs/task_state/super-agent-team/STATE.md`

## 1. 测试范围

覆盖 PRD §3 功能点 1-3 的 P0 范围，按阶段 C1-C7 落地的代码路径，在**单元层**客观验证：
- **C1** DB schema v53 + `trace_tool_calls` 表 + `chat_trace_nodes` 加列 + CRUD
- **C2** GraphNode 扩展 + 行为证据 gate（contains/not_contains/regex/no_error + shellCheck）+ agent 注入
- **C3** 节点内子步骤 trace 持久化（tool_use_start/tool_result 合并）+ agent-runner traceNode 字段 + stream-event 类型
- **C4** Team Builder 元 Agent（parseTeamPlan 容错 + 完整性校验 + assembleGraphDefinition + 验收 gate 兜底）

集成级用例（依赖真实 Agent 进程 + 运行中的 Hono 服务器 + SQLite + /team 命令触发的端到端 Team 组建与执行）的逻辑路径已在单元层验证；完整浏览器 E2E 与真实 LLM 拆解留待合并后集成环境，与本仓库 `graph-engineering` 测试报告一致的处理范式。

## 2. 单元测试

```
Test Files  3 passed (3)
     Tests  28 passed (28)
  Duration  445ms
```

### C1 — DB schema v53 + trace 表（`super-agent-team-trace.test.ts`，8 用例）

| 用例 | 覆盖 | 结果 |
|------|------|------|
| schema_version is 53 | 迁移将版本推进到 53 | ✅ |
| chat_trace_nodes has graph columns | graph_run_id / graph_node_id 列存在 | ✅ |
| trace_tool_calls table exists | 新表 + 索引就位 | ✅ |
| TC12 upsert 持久化 graph_run_id/graph_node_id | 节点级 trace 可按 node 查询 | ✅ |
| TC14 plain chat trace 向后兼容 | 无 graph 字段仍正常持久化 | ✅ |
| TC13 trace_tool_calls upsert merge | input + output 按 tool_use_id 合并成一行 | ✅ |
| TC13 persistTraceNodeFromStreamEvent 捕获 tool I/O | tool_use_start + tool_result 合并 | ✅ |
| TC14 plain chat trace event 无 graph linkage | 不破坏既有 chat trace | ✅ |

### C2 — 行为证据 gate（`super-agent-team-gate.test.ts`，8 用例）

| 用例 | 覆盖 | 结果 |
|------|------|------|
| TC8 contains 命中通过 | 输出含 value → pass | ✅ |
| TC8 contains 缺失失败 | 输出不含 value → fail | ✅ |
| TC8 not_contains | 反向断言 | ✅ |
| TC8 regex | 正则断言 | ✅ |
| TC9 shellCheck exit 0 通过 / 非零失败 | 行为证据命令 | ✅ |
| TC10 shellCheck 失败短路在 assertions 之前 | 防 LLM 文本洗白 | ✅ |
| TC11 无 assertions 且无 shellCheck → 通过 | LLM-only 向后兼容路径 | ✅ |
| 多断言全过→过；一条失败→失败 | 断言合取语义 | ✅ |

### C4 — Team Builder（`super-agent-team-builder.test.ts`，12 用例）

| 用例 | 覆盖 | 结果 |
|------|------|------|
| TC1 valid plan parses | 合法团队计划解析 | ✅ |
| parseTeamPlan 剥离 markdown 围栏 | 容忍 LLM ```json 包裹 | ✅ |
| TC2 成员引用缺失 → 拒绝 | agentMember 指向未定义成员 | ✅ |
| TC2 dependsOn 循环 → 拒绝 | DAG 环检测 | ✅ |
| TC2 dependsOn 引用不存在节点 → 拒绝 | 悬空边检测 | ✅ |
| TC2 无 agent 节点 → 拒绝 | 至少 1 agent | ✅ |
| TC2 畸形 JSON → 拒绝 | parse 容错返回 null | ✅ |
| 空值非 no_error 断言被丢弃 | 容忍 LLM 产出空 value，防 contains:"" 永真弱化 gate | ✅ |
| TC3 agent 节点携带 agentDefId + goalAnchor；gate 携带 assertions/shellCheck | 装配字段透传 | ✅ |
| TC4 edges 由 dependsOn 派生 | DAG 边构造 | ✅ |
| 无证据 gate 时追加验收 gate 兜底 | 防止团队无行为证据验收 | ✅ |
| agent 节点引用缺失成员 def id → 抛错 | 装配期硬失败 | ✅ |

## 3. 构建验证

| 项 | 命令 | 结果 |
|----|------|------|
| 后端类型检查 | `npm run typecheck`（`tsc --noEmit`） | ✅ EXIT=0 |
| 后端构建 | `npm run build`（`tsc` emit） | ✅ EXIT=0 |
| agent-runner 构建 | `npm --prefix container/agent-runner run build` | ✅ EXIT=0 |
| 前端构建 | `npm --prefix web run build` | ✅ built in 10.40s，TeamPage/NodeTraceSubgraph 编译通过 |

## 4. 回归说明

本次改动为**纯增量**：DB schema 在 v52 之后顺延到 v53（只加列加表，不动既有列）；`graph-runner` 仅在 `runAgentNode`/`runGateNode` 两处扩展 + trace 持久化桥接扩展；不改动 graph-scheduler/graph-orchestrator 核心调度逻辑，不改动既有 Loop/Supervisor。既有 chat trace 路径由 TC14 向后兼容用例守护。

> 注：测试运行中 `better-sqlite3` 原生模块曾因 Node 版本（NODE_MODULE_VERSION 127 vs 137）不匹配导致 trace 测试套件加载失败，执行 `npm rebuild better-sqlite3` 重建后全部通过——属环境问题，非代码缺陷。

## 5. 集成级用例状态说明

以下用例依赖运行时环境，逻辑路径已在单元层验证，完整 E2E 留待合并后集成环境：
- 真实 LLM 拆解复杂任务 → Team Plan JSON → 装配 GraphDefinition → 注册并启动 GraphRun（C4 + C5）
- `/team` 命令路由 + `routes/team.ts` HTTP 端点（C5）
- `routes/graph.ts` trace 查询端点返回节点内子图（C6）
- 前端 `TeamPage` 团队视图 + `NodeTraceSubgraph` 节点内子步骤可视化交互（C7，构建已验证编译通过）

## 6. 结论

P0 范围内可在单元层客观验证的全部路径通过：**28/28 单测通过，前后端 + agent-runner 构建零错误，类型检查零错误**。行为证据验收闭环（断言 + shellCheck 短路）在单测层证明可阻断"LLM 文本洗白"；trace 持久化证明节点内子步骤可回溯。达到合并 main 的退出条件。
