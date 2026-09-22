# Agent Group Chat — API Response Shape Mismatch

## 1. 用户现象
进入 Agent 群组详情页后，Pipeline 面板始终显示「等待节点启动」或「暂无节点数据」，点击"启动 Pipeline"按钮后无节点出现。

## 2. 问题描述
前端 Zustand store 的 `startRun` 和 `fetchRunNodes` 方法从 API 响应中读取了错误的字段路径，导致始终 `undefined`，PipelinePanel 无法渲染任何节点。

## 3. 根因
- 后端 `POST /api/agent-groups/:jid/runs` 返回 flat `{runId, status, groupJid, executedSeat, nodeId}`
- 前端 `startRun()` 读 `result.run`（不存在）→ `undefined`
- 后端 `GET /api/agent-groups/runs/:id/nodes` 返回 `{runId, nodes: [...]}`
- 前端 `fetchRunNodes()` 读 `data.run`（不存在）→ 状态恒为 null
- `PipelineNode` 接口缺少后端 snake_case 字段（`node_type`, `input_summary`, `input_tokens` 等），导致节点信息无法显示

## 4. 复现路径
1. 登录 DeepThink
2. 创建或打开任意 Swarm 群组
3. 观察右侧 Pipeline 面板 — 始终显示"暂无节点数据"
4. 点击"启动 Pipeline" → 按钮状态变为 running
5. 等待 30s+ → Pipeline 面板仍无节点出现（实际后端已有 completed 节点）

## 5. 诊断方法
```bash
# 1. 获取 session token
TOKEN=$(curl -s -X POST http://192.168.1.25:30080/api/auth/login \
  -H 'Content-Type: application/json' \
  -d '{"username":"admin","password":"admin123"}' \
  | python3 -c "import sys,json; print(json.load(sys.stdin).get('token',''))")

# 2. 验证后端返回 shape
GID="web:swarm:..."
curl -s -X POST "http://192.168.1.25:30080/api/agent-groups/$GID/runs" \
  -H "Cookie: deepthink_session=$TOKEN" -H 'Content-Type: application/json'
# 预期输出: {"runId":"...","groupJid":"...","status":"running",...}
# 注意: 顶层无 "run" 包装

# 3. 检查前端 store 读取路径
grep -n "result\.run\|data\.run" web/src/stores/agent-group.ts
```

## 6. 修复方案

### `web/src/api/agent-groups.ts`
- `PipelineRun` 接口：添加 `runId?`, `groupJid?`, `executedSeat?`, `nodeId?` 字段
- `PipelineNode` 接口：添加 snake_case 字段 `node_type`, `input_summary`, `output_summary`, `input_tokens`, `output_tokens`, `cost_usd`, `graph_run_id`
- `startGroupRun()`: 返回类型保持 `Promise<PipelineRun>`（flat 结构）
- `getRunNodes()`: 返回类型改为 `Promise<{runId: string; nodes: PipelineNode[]}>`

### `web/src/stores/agent-group.ts`
```diff
- const run: PipelineRun = { id: result.run.runId, ... };
+ const run: PipelineRun = { id: result.runId ?? result.id, runId: result.runId, ... };

- const run = data.run;
+ const current = get().currentRun;
  set({
-   currentRun: run,
+   currentRun: current ? { ...current, status: ... } : null,
-   nodes: data.nodes,
+   nodes: data.nodes ?? [],
  });
```

### `web/src/components/agent-group/PipelinePanel.tsx`
- `nodeTitle()`: 添加 snake_case 兼容 `node.node_type || node.nodeType`
- `statusIcon()`: 添加 "completed"/"success" 同态处理

## 7. 处理卡住的状态
无需特殊处理 — 旧前端状态为 null/空数组，修复后重新部署即可正常显示。

## 8. 经验沉淀 / 预防
- **前后端类型对齐检查清单**：每次新增 API 时，后端用 `curl` 验证实际返回 shape，前端按 shape 写类型定义
- **Zustand store 断言**：关键 store 方法加 `console.debug` 或 devtools 中间件追踪数据流
- **API 响应 shape 文档化**：在 route handler 顶部添加 JSDoc 注释描述返回 JSON 结构