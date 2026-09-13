# Skill Mount Context Missing in Distributed Mode

## 1. 用户现象

在 DeepThink 的 Agent 对话界面中，用户通过 Web 端下拉菜单选中某个具体技能（如 `agent-browser`），但模型回复时完全无视该技能，
表现得像一个通用聊天模型，没有任何技能相关的上下文感知。

API 请求正常携带 `selectedMounts`：
```json
{
  "selectedMounts": {
    "skills": ["agent-browser"]
  }
}
```

但模型输出不体现任何技能注入痕迹。

## 2. 问题描述

`selectedMounts` 通过 Web API 正确传递到后端 `pendingTurnMounts` Map，但在**分布式分发路径**（K8s mode / `isRedisConnected() && hasDistributedRunners()`）中，
`turnMounts` 被放入 Redis 任务 payload，而 agent-runner 完全不处理该字段 —— agent-runner 代码中 `.claude/container/agent-runner/src/` 搜索 `turnMounts` 返回 **零匹配**。

Agent-runner 的系统提示词组装（`index.ts:1657`）仅使用 `containerInput.agentDefinition?.systemPrompt`，
而 `agentDefinition` 在分布式分发路径中**未被放入 payload**。

## 3. 根因

### 代码层面

分布式分发路径位于 `src/index.ts:~5226`：

```typescript
const taskInput = {
  prompt: prompt || '',
  sessionId, turnId,
  groupFolder: group.folder,
  // ...
  turnMounts,  // ← 放入 payload
  // ⚠️ agentDefinition 缺失 —— applyTurnMounts 从未被调用
};
```

**对比**：单进程路径（`processGroupMessages` → `runHostAgent` / `runContainerAgent`）在 `container-runner.ts:1547/2508` 内部调用 `applyTurnMounts()`，
该函数从 DB 加载技能内容，追加到 `agentDefinition.systemPrompt` 作为 `<skill name="...">...</skill>` XML 块。

**函数位置**：`src/container-runner.ts`:
- `loadGroupAgentDefinition()`: line 1128 — 加载 Agent 定义及其挂载列表
- `applyTurnMounts()`: line 1239 — 将 `turnMounts` 并入 `agentDefinition`
  - Skills → 注入 `systemPrompt` 为 `<skill>` XML 块
  - MCP → 追加到 `mounts` 数组
  - KB → 追加到 `mounts` 数组

**两者的中间桥梁**：`pendingTurnMounts` Map（`src/index.ts:1005`）—— Web API 写入，消息处理时读出。

### 为什么以前没发现

- 单进程/SQLite 模式不走 Redis 分发，`runHostAgent`/`runContainerAgent` 内部已正确调用 `applyTurnMounts`
- K8s 分布式模式下，agent-runner 收到任务后直接使用 `agentDefinition.systemPrompt`，而该字段未被富化
- `turnMounts` 字段一直存在 payload 中，但 agent-runner 无消费代码 → 静默丢弃

## 4. 复现路径

1. 环境要求：Redis 可用且 `hasDistributedRunners() === true`
2. 在 Agent Studio 创建一个带 `systemPrompt` 的 Agent，绑定到群组
3. 在 Web 对话界面选中一个技能（如 `agent-browser`）
4. 发送消息
5. 观察：模型回复无技能上下文，日志无 `applyTurnMounts: skills injected into systemPrompt`

## 5. 诊断方法

```bash
# 确认 agent-runner 无 turnMounts 引用
grep -r "turnMounts" container/agent-runner/src/

# 确认分布式路径未调用 applyTurnMounts
grep -n "applyTurnMounts\|loadGroupAgentDefinition" src/index.ts

# 启动 trace 日志查看技能注入
# 期望日志（修复后）：
#   applyTurnMounts: skills injected into systemPrompt
# 如果缺失该日志 → 技能未被注入
```

## 6. 修复方案

### 改动汇总（3 文件，+17 行）

#### 6.1 `src/container-runner.ts` — 导出 2 个函数

```diff
-function loadGroupAgentDefinition(
+export function loadGroupAgentDefinition(

-function applyTurnMounts(
+export function applyTurnMounts(
```

#### 6.2 `src/index.ts` — 导入 + 调用

```diff
 import {
   AvailableGroup,
   ContainerInput,
   ContainerOutput,
+  applyTurnMounts,
+  loadGroupAgentDefinition,
   runContainerAgent,
 } from './container-runner.js';
```

```diff
+      // Enrich agentDefinition with per-turn mounts (skills/MCP/KB)
+      // so the distributed agent-runner receives skill content in its
+      // system prompt.
+      const baseAgentDef = loadGroupAgentDefinition(
+        group.agentDefId,
+        group.created_by,
+      );
+      const enrichedAgentDef = applyTurnMounts(
+        baseAgentDef,
+        turnMounts,
+        group.created_by,
+      );
+
       const taskInput = {
         prompt: prompt || '',
         sessionId, turnId,
         groupFolder: group.folder,
         chatJid,
         currentSourceJid,
         isMain: isAdminHome,
         isHome, isAdminHome,
         images, messageTaskId,
         reminderConfig: buildReminderConfig(group.created_by, prompt),
         engine: group.engine,
         workspaceGlobal: distWorkspaceGlobal,
         workspaceMemory: distWorkspaceMemory,
+        agentDefinition: enrichedAgentDef,
         turnMounts,
       };
```

### 选型理由

- **Surgical Changes**: 不改 agent-runner 代码（agent-runner 已正确读取 `agentDefinition.systemPrompt`），仅在分发侧提前富化
- **单进程路径零触碰**: `runHostAgent`/`runContainerAgent` 内部已有 `applyTurnMounts`，此修复仅补齐分布式路径
- **向后兼容**: `turnMounts` 保留在 payload 中（agent-runner 忽略但不报错），`agentDefinition` 为增量字段

## 7. 处理卡住的状态

无需处理卡住状态。此 bug 为"功能缺失"（feature gap）而非脏数据问题。所有历史 turn 结果不变，新 turn 生效即可。

## 8. 经验沉淀 / 预防

### 根本教训

分布式分发路径（`publishAgentTask` → Redis → agent-runner `BLPOP`）与单进程路径（直接调用 `runHostAgent`/`runContainerAgent`）之间存在隐性分歧：
- 单进程路径: `container-runner.ts` 内部完成 `applyTurnMounts`
- 分布式路径: 裸 `taskInput` 无 `agentDefinition`，agent-runner 无 `turnMounts` 消费者

### 预防措施

1. **分布式路径代码审查 Checklist**：每次在 `processGroupMessages` 或 `container-runner.ts` 修改消息/技能/MCP/KB 处理后，必须同时检查 `isRedisConnected() && hasDistributedRunners()` 分支是否有等价逻辑
2. **结构性改进方向**（低优先级）：抽取 `buildContainerInput()` 共享函数，统一两条路径的输入构建逻辑，消除分叉
3. **烟雾测试**：在 `scripts/sys-test.sh` 增加分布式路径技能挂载用例（需 Redis + agent-runner 环境）