---
title: "Agent Group Chat 辩论上下文传递修复"
date: 2026-09-25
status: fixed
severity: critical
---

## 1. 用户现象

用户创建了包含多个 Agent 席位的群组（如"首席架构师"→"代码审查专家"），发起辩论后：
- 第一个席位（架构师）正常输出完整分析
- 第二个席位（审查专家）表示"我没有看到前序席位的分析内容附在下方"
- 辩论功能形同虚设——审查专家无法引用或批判架构师的结论

## 2. 问题描述

`composeAgentPrompt()` 函数负责为每个 graph node（Agent 席位）构建 prompt。在辩论场景中，后续席位需要在 prompt 中看到前序席位的输出（通过 graph state 中的 `node_seat-XX_output` 键传递），但函数原实现仅处理 `goal` 和 `gate feedback`，未读取 `node_*_output` 类 state 键。

此外，`resolveExecutionMode()` 中 swarm group 的执行模式检查在 DB 查询之后，导致 DB 中的 `execution_mode='container'` 覆盖 swarm- 前缀检查，Agent 在 K8s Pod（无 Docker）中尝试 spawn 容器失败。

## 3. 根因

**代码层面**：`src/graph-engineering/graph-runner.ts` 中两个函数存在缺陷：

1. **`composeAgentPrompt()`**：缺少对 `node_*_output` state 键的检测和注入逻辑。swarm 辩论的 state 传递机制（`state_patch_json` → `node_seat-XX_output`）在 graph 引擎层正常工作，但 compose 函数未消费这些键。

2. **`resolveExecutionMode()`**：swarm- 前缀的 group folder 应在所有 DB 查询之前就返回 `'host'`，但旧代码将 `ctx.groupFolder === 'main' ? 'host' : 'container'` 放在函数末尾，被 DB 中的 `execution_mode='container'` 短路。

**部署层面**：
- Dockerfile.fast 未安装 agent-runner 依赖（`@anthropic-ai/claude-agent-sdk`），导致 agent 无法启动
- `kubectl cp` 文件补丁在 Pod 重启后丢失（Node.js 模块缓存 + K8s 重启还原镜像）
- Docker 构建在 `npm ci` 步骤超时（需 registry mirror 和更长超时）

## 4. 复现路径

1. 创建 swarm 群组，添加 2+ Agent 席位，seat-0 为"首席架构师"，seat-1 为"代码审查专家"
2. 发起辩论：`POST /api/agent-groups/{jid}/runs` 并传入具体 prompt
3. 等待 seat-0 完成
4. 查看 seat-1 的 `input_summary`：旧代码中 state 仅含 `goal`，无 `node_seat-XX_output`
5. 查看 seat-1 的输出：会显示"我没有看到前序席位的分析"

## 5. 诊断方法

```bash
# 查看 graph run 的 input_summary（确认 state 中是否有前序输出）
curl -b cookie.txt http://host:30080/api/agent-groups/runs/{runId}/nodes | jq '.nodes[1].input_summary'

# 查看 Pod 日志（确认 composeAgentPrompt 是否检测到 state keys）
kubectl -n deepthink logs -l app.kubernetes.io/name=deepthink | grep composeAgentPrompt

# 检查 Docker 镜像中的修复代码
docker run --rm --entrypoint sh deepthink-server:latest -c "grep -c 'prevOutputKeys' /app/dist/graph-engineering/graph-runner.js"
```

## 6. 修复方案

### composeAgentPrompt（核心修复）

```diff
+   // Swarm debate: feed previous seat outputs into the prompt
+   const prevOutputKeys = Object.keys(state)
+     .filter((k) => k.startsWith('node_') && k.endsWith('_output'))
+     .sort();
+   if (prevOutputKeys.length > 0) {
+     const previousOutputs = prevOutputKeys
+       .map((k) => {
+         const seatId = k.replace(/^node_/, '').replace(/_output$/, '');
+         const text = typeof state[k] === 'string' ? (state[k] as string) : '';
+         return `### ${seatId} 的发言\n\n${text}`;
+       })
+       .join('\n\n---\n\n');
+     if (previousOutputs) {
+       prompt = `【前序席位发言】（请仔细审阅后给出你的分析和批判）\n\n${previousOutputs}\n\n---\n\n${prompt}`;
+     }
+   }
+   // DEBUG: log state keys for diagnosing
+   const allKeys = Object.keys(state).filter(k => k.startsWith('node_'));
+   if (allKeys.length > 0) {
+     logger.info({ nodeId: node.id, stateKeys: allKeys, prevOutputKeys }, 'composeAgentPrompt: state node keys');
+   }
```

### resolveExecutionMode

```diff
  function resolveExecutionMode(ctx: GraphRunContext, deps: GraphDeps): ExecutionMode {
+   // Default for 'main' and swarm groups is host; swarm groups run in K8s without Docker
+   if (ctx.groupFolder === 'main' || ctx.groupFolder.startsWith('swarm-')) return 'host';
    // ... DB checks ...
-   return ctx.groupFolder === 'main' ? 'host' : 'container';
+   return 'container';
  }
```

### Dockerfile.fast

```diff
  COPY container/agent-runner/package*.json ./container/agent-runner/
+ RUN cd /app/container/agent-runner && npm install --omit=dev --registry=${NPM_REGISTRY}
```

## 7. 处理卡住的状态

如有遗留的 graph run 处于 running/pending 状态：

```sql
UPDATE graph_runs SET status='interrupted', ended_at=NOW() WHERE status='running';
UPDATE graph_node_runs SET status='interrupted', ended_at=NOW() WHERE status='running';
```

## 8. 经验沉淀 / 预防

- **K8s 部署必须用 Docker 镜像**，`kubectl cp` 文件补丁不可靠（Pod 重启还原 + Node.js 模块缓存）
- **Docker 构建需 registry mirror**：`--registry=https://registry.npmmirror.com`
- **验证修复前先确认镜像 SHA**：`docker run --rm --entrypoint sh image:tag -c "grep -c 'fix' /app/dist/file.js"`
- **辩论 prompt 模板**应显式提示："前序席位的发言会附在下方，请仔细审阅后给出分析和批判"
- **巡检脚本**：定期用 `docker run` 检查 dist 中关键修复点是否存在