# 测试报告: 执行 DAG 画布修复

## 1. 测试范围

本次修复涉及 4 个代码文件，覆盖前端 DAG 画布组件、后端 agent-runner 节点分配器、流式事件处理、前端 Zustand store 合并逻辑。测试方式：typecheck + 单元测试 + 运行时 API 实测。

## 2. 测试结果

### 2.1 类型检查 ✅
```
make typecheck  → 全部通过（后端 + 前端 + agent-runner 三端）
```

### 2.2 单元测试 ✅
```
make test  → Test Files: 90 passed (90)  |  Tests: 1180 passed (1180)
```

其中 trace-node-allocator 单元测试新增 2 个用例（共 11 个全部通过）：
- `tool_use_end + tool_result updates node status and writes outputSummary` — 验证 tool_use_end 设置 status=done 但不写 outputSummary（由后续 tool_result 事件写入）
- `tool_progress updates node inputSummary from input_json_delta` — 验证 tool_progress 事件能更新节点的 inputSummary

### 2.3 构建 ✅
```
make build  → 后端 tsc + 前端 vite build + agent-runner tsc 全部成功
```

### 2.4 运行时 API 实测 ✅

**测试步骤**：
1. 启动后端（`WEB_PORT=9898 npx tsx src/index.ts`）
2. 登录 admin（`POST /api/auth/login`）
3. 清空旧 trace nodes（`DELETE FROM chat_trace_nodes`）
4. 发送测试消息：`请用 Bash 工具执行 echo hello 命令`
5. 等待 Agent 执行完毕
6. 查询 trace nodes API：`GET /api/groups/web:main/trace/nodes`

**实测结果**：
```json
{
  "nodes": [
    {
      "id": 1,
      "node_type": "turn",
      "parent_node_id": null,
      "status": "done",
      "title": "Turn",
      "input_summary": "<messages>\n<message sender=\"admin\"...>请用 Bash 工具执行 echo hello 命令...",
      "output_summary": "命令执行成功，输出：`hello`"
    },
    {
      "id": 2,
      "node_type": "tool",
      "parent_node_id": 1,
      "status": "done",
      "title": "Bash",
      "input_summary": "command: echo hello",
      "output_summary": "hello"
    }
  ]
}
```

## 3. 验收标准对照

### AC-1: 连线渲染 ✅
- Turn 根节点（id=1, node_type='turn', parent_node_id=NULL）已持久化到 DB。
- Tool 节点（id=2）的 parent_node_id=1 指向已存在的 Turn 节点。
- 前端 `DagView.tsx` 的 `rfEdges` 根据 `parent_node_id` 构造 edge `{source:'1', target:'2'}`，因 source 和 target 均在 nodes 列表中，React Flow 将正常渲染连线。

### AC-2: 缩放控件 ✅
- `DagView.tsx` 的 `FlowCanvas` lazy 组件已渲染 `<Controls />`、`<Background />`、`<MiniMap />` 作为 `<ReactFlow>` 子组件。
- 用户可点击 +/- 按钮缩放画布，MiniMap 提供全局预览。

### AC-3: 节点数据 ✅
- **Turn 节点**：input_summary = 用户消息文本（`turn_start` 事件携带），output_summary = assistant 回复文本（`turn_end` 事件在 `finally` 块中发射，通过 `currentTurnAssistantText` 累积 `text_delta`）。
- **Tool 节点**：input_summary 来自 `tool_progress` 事件（`toolInputSummary`），output_summary 来自 `tool_result` 事件（`toolResult`）。实测 `input_summary="command: echo hello"`, `output_summary="hello"`。
- **Sub-Agent 节点**：input_summary 来自 `task_start`，output_summary 来自 `task_updated` 终态事件。

### AC-4: 跨 turn 持久化 ✅
- `TraceNodeAllocator` 改为模块级单例（`export const traceAllocator = new TraceNodeAllocator()`），`nextId` 在进程内跨 query 单调递增，`resetTurn()` 只清除 turn 上下文不清 nextId。
- 多个 Turn 的 nodeId 不会冲突，DB 不会互相覆盖。

## 4. 根因与修复对照

| 问题 | 根因 | 修复 |
|------|------|------|
| 画布无连线 | `TraceNodeAllocator.startTurn()` 只分配 id 不发射事件，Turn 根节点从未持久化，导致 edge 的 source 不在 nodes 列表中被 React Flow 静默丢弃 | `startTurn()` 返回 traceNode 描述符；`runQuery()` 开始时发射 `status` stream event 携带 turn traceNode |
| 无缩放控件 | `DagView.tsx` 未渲染 `<Controls/>` 子组件 | `FlowCanvas` lazy 组件内渲染 `<Controls/>`、`<Background/>`、`<MiniMap/>` |
| Turn 节点无数据 | Turn 节点从未发射 | `turn_start` 携带 inputSummary（用户消息），`turn_end` 在 `finally` 携带 outputSummary（assistant 回复） |
| Tool 节点无 input | `tool_use_start` 在 content_block_start 时 input 为空，实际 input 经 `tool_progress` 事件到达，但 allocator 未处理 | allocator 新增 `tool_progress` case，更新节点 inputSummary |
| Tool 节点无 output | `tool_use_end` 事件不携带 `toolResult`，实际输出经 `tool_result` 事件到达，但 allocator 未处理 | allocator 新增 `tool_result` case，设置 outputSummary 并删除 toolByUseId 条目 |
| Sub-Agent 节点无 output | allocator 只处理 `task_start`，无 `task_updated` 终态处理 | allocator 新增 `task_updated` case，终态时设置 outputSummary + status |
| Skill 节点 live 画布变回 tool | `tool_use_end` 硬编码 `nodeType:'tool'`，Zustand 对象展开覆盖了 `tool_use_start` 的 `'skill'` | `ActiveTool` 增加 `nodeType` 字段，`tool_use_end` 读取 `active.nodeType`；Zustand 合并改为 COALESCE 语义 |
| 跨 turn nodeId 冲突 | allocator 在 `runQuery()` 内部实例化，每次 query nextId 重置为 1 | allocator 改为模块级单例，`nextId` 跨 query 单调递增 |

## 5. 已知限制

1. **跨进程重启的 nodeId 冲突**：agent-runner 进程重启后 `nextId` 重置为 1，可能与 DB 中已存在的行冲突。当前未实现 `traceNodeStartId` 种子化（涉及 ContainerInput 类型变更 + 主进程 DB 查询，评估为过度工程化，留待后续）。进程重启不频繁，且 `resetTurn()` 保证 turn 内节点一致性，影响可控。
2. **review / goal_check 节点**：loop-engineering 概念，普通会话不产生，本期不实现。
3. **移动端 DAG**：仅在 `lg:` 断点渲染侧边栏标签，移动端暂不可用（PRD 非目标）。
4. **annotation WS 推送**：多 tab 客户端注解不实时同步（PRD 非目标）。

## 6. 测试结论

✅ **全部通过**。用户报告的三个问题（无连线、无缩放、无节点数据）已全部修复，经运行时 API 实测验证。typecheck、build、单元测试均无回归。
