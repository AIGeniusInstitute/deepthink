# PRD: 执行 DAG 画布修复

## 1. 背景

DeepThink Agent 的"执行 DAG"侧边栏用于可视化展示当前会话的执行轨迹（Turn → Tool → Sub-Agent）。当前实现存在三个阻塞性缺陷，导致 DAG 画布完全不可用：

1. **画布无连线**：节点之间的父子边（edge）不渲染，画布呈现一堆孤立节点。
2. **无缩放控件**：画布缺少 +/-/fit-view 等控制按钮，用户无法缩放或平移视图。
3. **节点无输入输出数据**：点开节点后，输入/输出文本为空。

## 2. 目标

修复上述三个缺陷，使 DAG 画布能正确展示：
- 节点之间的父子连线（Turn → Tool / Turn → Sub-Agent）
- React Flow 内置缩放控件（Controls + Background）
- 每个节点点开后能看到具体的输入/输出文本

## 3. 用户故事

### US-1: DAG 连线可见
**Given** 用户在一个会话中发送了消息并触发了工具调用
**When** 用户点击侧边栏"执行 DAG"标签
**Then** 画布上应显示 Turn 根节点，并有一条连线从 Turn 指向每个 Tool / Sub-Agent 子节点

### US-2: 缩放控件可用
**Given** 用户打开 DAG 画布
**When** 画布渲染完成
**Then** 画布右下角应显示 +/-/fit-view/lock 控制按钮，用户可点击放大缩小
**And** 画布背景应有 React Flow 默认的点状网格

### US-3: 节点输入输出数据可见
**Given** 用户点击 DAG 画布上的某个节点
**When** 右侧详情面板展开
**Then** 输入框应显示该节点的输入摘要（工具调用的入参 / Turn 的用户消息）
**And** 输出框应显示该节点的输出摘要（工具返回值 / Turn 的 assistant 回复 / Sub-Agent 的最终输出）

## 4. 验收标准

### AC-1: 连线渲染
- Turn 根节点必须持久化到 `chat_trace_nodes` 表（`node_type='turn'`, `parent_node_id=NULL`）。
- Tool / Sub-Agent 节点的 `parent_node_id` 必须指向已存在的 Turn 节点 id。
- React Flow 画布上每个有 `parent_node_id` 的节点都应渲染一条 source→target 边。

### AC-2: 缩放控件
- `DagView.tsx` 必须渲染 `<Controls />`、`<Background />` 作为 `<ReactFlow>` 的子组件。
- 用户可点击 +/- 按钮缩放画布。

### AC-3: 节点数据
- Turn 节点：`input_summary` = 用户消息文本（截断），`output_summary` = assistant 最终回复文本（截断）。
- Tool 节点：`input_summary` 来自 `tool_use_start`，`output_summary` 来自 `tool_use_end`（`toolResult`）。
- Sub-Agent 节点：`input_summary` 来自 `task_start`（`taskDescription`），`output_summary` 来自 `task_updated` 终态事件的 summary。
- 节点状态：Tool 在 `tool_use_end` 时转为 `done`；Sub-Agent 在 `task_updated` 终态时转为 `done`/`failed`；Turn 在 query 完成时转为 `done`。

### AC-4: 跨 turn 持久化
- 同一会话的多个 Turn 不会因 nodeId 冲突而互相覆盖（nodeId 在进程内单调递增，跨进程重启通过 `traceNodeStartId` 种子避免冲突）。

## 5. 非目标

- 不改动 DAG 节点布局算法（保持现有 grid 布局，不引入 dagre）。
- 不实现 review / goal_check 节点类型（loop-engineering 概念，普通会话不产生）。
- 不改动 annotation 的 WS 实时推送（保持现状）。
- 不实现移动端 DAG sheet（保持现状，仅桌面 `lg:` 断点渲染）。

## 6. 风险

| 风险 | 缓解 |
|------|------|
| traceNode 事件量增大导致 WS 流量上升 | traceNode 仅在节点状态变更时携带，单次 turn 增量 ≤ 10 个事件，影响可忽略 |
| 跨进程重启的 nodeId 冲突 | 主进程在启动 agent-runner 前查询 `MAX(id)` 并通过 `traceNodeStartId` 注入种子 |
| 现有 E2E 脚本 `e2e_slash_effort_dag.py` 依赖合成数据 | 不改动 E2E 脚本，它仍然用合成 turn 节点验证画布渲染逻辑 |
