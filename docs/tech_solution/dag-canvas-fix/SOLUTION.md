# 技术方案: 执行 DAG 画布修复

## 1. 根因分析

### 1.1 无连线 — Turn 根节点从未持久化
`TraceNodeAllocator.startTurn()`（`container/agent-runner/src/trace-node-allocator.ts:46`）只分配 id 并设置内部 `currentTurnId`，但**不发射任何 stream event、不携带 traceNode**。结果：

- `tool_use_start` / `task_start` 事件的 `traceNode.parentNodeId` 指向一个从未写入 DB 的 turn id。
- `DagView.tsx:114-121` 客户端根据 `parent_node_id` 构造 edge，但 React Flow 静默丢弃 source/target 不在 nodes 列表中的边。

### 1.2 无缩放控件 — 缺少 `<Controls/>` 组件
`DagView.tsx:164-171` 渲染 `<ReactFlowLazy>` 时只传了 `nodes/edges/onNodeClick/fitView/proOptions/className`，没有把 `<Controls/>`、`<Background/>` 作为子组件渲染。React Flow 12 的缩放控件是 opt-in。

### 1.3 节点无数据 — 三处缺陷
1. **Turn 节点无 input/output**：turn 节点从未发射，自然没有数据。
2. **Sub-Agent 节点无 output**：`trace-node-allocator.ts` 只处理 `tool_use_start/end` 和 `task_start`，没有处理 `task_updated` 终态事件，subagent 节点永远停留在 `running` 状态，`output_summary` 永远为 null。
3. **`tool_use_end` 硬编码 `nodeType:'tool'`**（`trace-node-allocator.ts:90`）：skill 节点在 `tool_use_start` 被正确分类为 `'skill'`，但 `tool_use_end` 会把它改回 `'tool'`。DB upsert 用 COALESCE 不覆盖 node_type，但前端 Zustand 合并（`chat.ts:2631-2637`）用对象展开直接覆盖，导致 live 画布显示错误颜色。
4. **Zustand 合并用 null 覆盖**（`chat.ts:2631-2637`）：`tool_use_end` 事件不携带 `inputSummary`，序列化为 `input_summary: null`，对象展开 `{...list[idx], ...node}` 会用 null 覆盖 `tool_use_start` 写入的 `input_summary`。DB 端 COALESCE 安全，但 live 状态被破坏，刷新后恢复。

### 1.4 跨 Turn nodeId 冲突（附加缺陷）
`TraceNodeAllocator` 在 `runQuery()` 内部实例化（`index.ts:1262`），每次用户消息都会创建新实例、`nextId` 重置为 1。导致第 2 条消息的 Turn(id=1) 覆盖第 1 条消息的 Turn(id=1)，DAG 只显示最新 turn 的节点。

## 2. 修复方案

### 2.1 前端 `DagView.tsx`
- 从 `@xyflow/react` 额外 import `Controls`, `Background`, `MiniMap`。
- 将它们作为 `<ReactFlow>` 的子组件渲染。
- Edge 改用 `style: { stroke: '#94a3b8' }` + `animated: true`，移除无效的 `className: 'text-slate-400'`（Tailwind text-* 不影响 SVG path 的 stroke 属性）。
- 加 `defaultEdgeOptions` 统一箭头风格。

### 2.2 `trace-node-allocator.ts`
- `ActiveTool` 接口增加 `nodeType` 字段，记录 `tool_use_start` 时的节点类型。
- `startTurn(inputSummary?)` 返回一个 turn traceNode 描述符（`{nodeId, nodeType:'turn', parentNodeId:null, title, inputSummary, status:'running'}`），供调用方发射事件。
- `tool_use_end` 分支读取 `active.nodeType` 而非硬编码 `'tool'`。
- 新增 `task_updated` 终态处理：用 `taskId` 查回 subagent 节点，设置 `outputSummary`（取 `summary` 字段）+ `status`（映射 patch.status），需要新增 `taskById: Map<string, {nodeId, parentTurnId}>` 追踪。
- 新增 `endTurn(outputSummary?, status?)` 方法，返回更新 turn 节点的 traceNode 描述符（用于 query 结束时发射 turn-end 事件）。
- 新增 `seed(startId)` 方法，幂等地种子化 `nextId`（跨进程重启避免 id 冲突）。

### 2.3 `agent-runner/src/index.ts`
- 将 `traceAllocator` 从 `runQuery()` 内部移到**模块级**单例（同进程跨 query 持久，`nextId` 单调递增）。
- `runQuery()` 开始时：
  1. 读取 `containerInput.traceNodeStartId` 调用 `traceAllocator.seed(startId)`（幂等）。
  2. 调用 `traceAllocator.resetTurn()` 清除 turn 上下文（但不清 nextId）。
  3. 调用 `traceAllocator.startTurn(prompt.slice(0, 400))` 获得 turn 描述符。
  4. 发射一个合成 `status` stream event，携带 turn traceNode（`statusText: 'turn_start'`），让主进程持久化 + 前端 live upsert。
- `runQuery()` 结束时（success path）：
  1. 调用 `traceAllocator.endTurn(accumulatedAssistantText.slice(0, 400), 'done')` 获得 turn-end 描述符。
  2. 发射合成 `status` stream event 携带 turn-end traceNode。
  3. 如果 query error，发射 `status: 'failed'` 的 turn-end。

`accumulatedAssistantText` 复用现有的 `assistantTextTracker` 或在 `decorateStreamEvent` 里累积 `text_delta`。

### 2.4 `chat.ts` Zustand 合并修复
将 `upsertTraceNode` 的合并逻辑改为 COALESCE 语义：新事件的 `null`/`undefined` 字段不覆盖已有值。

```ts
const merged: TraceNodeEntry = {
  ...list[idx],
  ...node,
  // COALESCE: 新事件的 null 不覆盖已有非 null 值
  input_summary: node.input_summary ?? list[idx].input_summary ?? null,
  output_summary: node.output_summary ?? list[idx].output_summary ?? null,
  title: node.title ?? list[idx].title ?? null,
  status: node.status ?? list[idx].status ?? null,
  parent_node_id: node.parent_node_id ?? list[idx].parent_node_id ?? null,
  node_type: node.node_type ?? list[idx].node_type,
  // annotation 永远以服务端为准，不被流式事件覆盖
  annotation_input: list[idx].annotation_input ?? node.annotation_input ?? null,
  annotation_output: list[idx].annotation_output ?? node.annotation_output ?? null,
};
```

### 2.5 跨进程 nodeId 种子化
- `shared` 的 `ContainerInput` 类型（`container/agent-runner/src/types.ts` + `src/container-runner.ts`）新增 `traceNodeStartId?: number`。
- `db.ts` 新增 `getMaxChatTraceNodeId(chatJid): number` 查询。
- `container-runner.ts` 在构造 `dockerInput`（L1022）和 `hostInput`（L1817）时，调用 `getMaxChatTraceNodeId(chatJid) + 1` 注入 `traceNodeStartId`。

## 3. 数据流

```
用户消息 → runQuery()
  ├─ traceAllocator.seed(containerInput.traceNodeStartId)
  ├─ traceAllocator.resetTurn()
  ├─ const turn = traceAllocator.startTurn(prompt)
  ├─ emit status event { traceNode: turn }  ──→ 主进程 persist → WS broadcast → 前端 upsert
  │                                                ↓
  │                                           前端画布出现 turn 根节点
  ├─ SDK query loop
  │   ├─ tool_use_start → decorate → traceNode (parentNodeId=turn.id) → persist → 画布出现 tool 节点 + edge
  │   ├─ tool_use_end   → decorate → traceNode (outputSummary, status=done) → persist → 节点变绿
  │   ├─ task_start     → decorate → traceNode (subagent, parentNodeId=turn.id) → 画布出现 subagent 节点 + edge
  │   └─ task_updated(terminal) → decorate → traceNode (outputSummary, status=done/failed) → 节点变状态
  └─ query end → traceAllocator.endTurn(assistantText, 'done') → emit status event → turn 节点变绿 + output
```

## 4. 涉及文件

| 文件 | 改动 |
|------|------|
| `web/src/components/chat/DagView.tsx` | 加 Controls/Background/MiniMap，修 edge 样式 |
| `container/agent-runner/src/trace-node-allocator.ts` | startTurn 返回描述符；tool_use_end 保留 nodeType；task_updated 处理；endTurn 方法；seed 方法 |
| `container/agent-runner/src/index.ts` | 模块级 allocator；emit turn-start/turn-end 事件 |
| `web/src/stores/chat.ts` | upsertTraceNode 合并改为 COALESCE 语义 |
| `container/agent-runner/src/types.ts` | ContainerInput 加 traceNodeStartId |
| `src/container-runner.ts` | ContainerInput 加 traceNodeStartId；构造 input 时注入 |
| `src/db.ts` | getMaxChatTraceNodeId 查询 |

## 5. 验证

- `make typecheck` 三端类型检查通过。
- `make test` 现有约束测试不回归。
- 手动 E2E：在 Web 端发送一条消息触发工具调用，打开"执行 DAG"标签：
  1. 画布显示 Turn 根节点 + Tool 子节点 + 连线。
  2. 右下角有 +/-/fit-view 缩放控件，可点击缩放。
  3. 点击 Tool 节点，右侧详情显示输入/输出文本。
  4. 点击 Turn 节点，详情显示用户消息（输入）和 assistant 回复（输出）。
  5. 发送第二条消息，画布新增第二个 Turn + 其子节点，第一个 Turn 仍保留。
