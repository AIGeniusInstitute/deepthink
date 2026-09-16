# Fix Agent Stream Output & Skill Context Loading

**日期**：2026-09-17
**分支**：`fix/agent-stream-skill-context`
**状态**：已修复，待验证

---

## 1. 用户现象

1. **Agent 对话没有流式中间过程输出**：在主对话输入消息后，看不到 Agent 的思考过程（thinking）、工具调用（tool_use）、技能调用（skill call）等中间过程的实时流式输出。
2. **运行轨迹刷新后消失**：即使偶尔能看到，刷新页面后这些轨迹数据也不复存在。
3. **选定技能未加载到上下文**：在输入框"技能"下拉菜单选择一个具体技能后与 Agent 对话，Agent 回复为空或无效——技能未被 Agent 感知和读取。
4. **新建会话 Tab 监控**：希望在新 Tab 中监控 Agent 输出验证情况。

---

## 2. 问题描述

### 问题 A：技能未加载（Bug 根因明确）
`applyTurnMounts()` 在 `src/container-runner.ts` 中只把技能内容注入到 `systemPrompt` 作为 `<skill>` XML 文本，但**没有**将技能条目添加进 `agentDefinition.mounts` 数组（MCP 和 KB 是添加了的）。导致 agent-runner 的 `mountedSkillNames` 始终为空，`skillsOption` 恒为 `'all'`——Agent 看不出哪些技能被用户"选中"。

### 问题 B：流式输出竞态条件（潜在问题）
分布式模式下，`registerDistributedOutput` handler 在 `publishAgentTask` **之后**注册。虽然 Redis 订阅已就绪，但 handler 注册的微小延迟可能丢失首几个 stream 事件（IPC 事件路由到 `"no handler registered"` 分支）。

### 问题 C：运行轨迹不持久（Bug 明确）
当 Agent 完成回复时，`handleWsNewMessage` 清除 streaming 状态（包含 `traceEvents`），导致工具调用/技能调用等轨迹数据消失。`thinkingText` 已通过 `thinkingCache` 持久化，但 `traceEvents` 没有对应的持久化机制。

---

## 3. 根因

### 根因 A（代码层面）
`src/container-runner.ts:applyTurnMounts()` 第 1330-1345 行：
- 技能内容以 `<skill>` XML 注入到 `base.systemPrompt` ✓
- 但缺少将技能加入 `base.mounts` 的代码（对比 MCP 在第 1348-1378 行、KB 在第 1381-1396 行都添加到了 mounts） ✗
- `agent-runner/src/index.ts:1827-1829` 的 `mountedSkillNames` 过滤 `agentDef.mounts` 中 `resourceType === 'skill'` 的条目——始终为空

### 根因 B（代码层面）
`src/index.ts` 两处分布式 dispatch（主对话 ~5357、Agent 会话 ~9017）：
- 顺序：`publishAgentTask` → `registerDistributedOutput`
- 理论上 agent-runner 启动需时间，实际竞态窗口极小（微秒级），但不符合安全原则

### 根因 C（代码层面）
`web/src/stores/chat.ts:handleWsNewMessage()` 第 2506-2536 行：
- `shouldFinalizeAssistant` 时，`thinkingText` 保存到 `thinkingCache[msg.id]`（持久化） ✓
- `traceEvents` 随 streaming 状态被 `delete nextStreaming[chatJid]` 删除 ✗
- 缺少 `traceCache` 持久化机制

---

## 4. 复现路径

1. 登录 http://192.168.1.25:30080/chat（admin/88888888）
2. 在主对话输入框下拉菜单选择一个技能（如 "test-mount-skill"）
3. 输入消息发送给 Agent
4. **问题 A**：Agent 回复为空，技能未被识别
5. 观察 Agent 回复过程：无思考/工具/技能调用的流式卡片
6. Agent 回复完成后：无运行轨迹留存
7. 刷新页面：之前的轨迹完全丢失

---

## 5. 诊断方法

### 检查技能挂载日志
```bash
kubectl logs -n deepthink deploy/deepthink --tail=100 | grep applyTurnMounts
# 期望看到: "skills injected into systemPrompt + mounts"
# 旧版本: 只有 "skills injected into systemPrompt"（无 mounts）
```

### 检查 Agent 定义日志
```bash
kubectl logs -n deepthink deploy/agent-runner --tail=100 | grep "Agent definition applied"
# 期望看到: "skill=N" (N > 0)
# 旧版本: "skill=0"
```

### 检查流式事件是否到达前端
```javascript
// 浏览器控制台
// 检查 stream_event 是否到达
wsManager.on('stream_event', console.log)
```

---

## 6. 修复方案

### 修复 A：技能加入 mounts（`src/container-runner.ts`）
```diff
 if (pieces.length > 0) {
   base.systemPrompt = ... + pieces.join('\n');
+  // 同时将技能加入 mounts 数组
+  for (const skillId of turnMounts.skills) {
+    const key = `skill:${skillId}`;
+    if (!existingKeys.has(key)) {
+      base.mounts.push({
+        resourceType: 'skill',
+        resourceId: skillId,
+        resourceName: skillId,
+      });
+      existingKeys.add(key);
+    }
+  }
+  // 添加显式的技能选择指令
+  base.systemPrompt += '\n\n用户已选择以下技能用于本对话：...';
 }
```

### 修复 B：Handler 先于任务发布（`src/index.ts`）
```diff
+// 先注册 handler
+ipcWatcherManager?.registerDistributedOutput(folder, handler);
+handlerPreRegistered = true;
 // 再发布任务
 published = await publishAgentTask(taskInput);
 if (!published) {
+  // 非发布方：取消 handler
+  ipcWatcherManager?.unregisterDistributedOutput(folder);
   output = { status: 'success', result: null };
 }
```

### 修复 C：Trace 持久化（`web/src/stores/chat.ts` + `MessageBubble.tsx`）
- 新增 `traceCache: Record<string, StreamingTraceEvent[]>`
- `handleWsNewMessage` 中：`streamState.traceEvents` → `traceCache[msg.id]`
- sessionStorage 持久化（`hc_trace_cache` key），刷新不丢失
- `MessageBubble` 渲染持久化的 trace（"运行轨迹"卡片）

---

## 7. 处理卡住的状态

无特殊操作。重启 agent-runner 和 web-server Pod 即可应用新代码：
```bash
kubectl rollout restart -n deepthink deploy/deepthink
kubectl rollout restart -n deepthink deploy/agent-runner
```

---

## 8. 经验沉淀 / 预防

1. **挂载对称性原则**：skills/MCP/KB 三者应遵循相同的挂载模式——都添加到 `base.mounts`，不要只给其中某个特殊处理。
2. **竞态安全原则**：分布式 handler 始终应在任务发布前注册。虽然实际竞态窗口极小，但代码层面保持因果关系正确。
3. **持久化对称性原则**：`thinkingText` 有 `thinkingCache` 则 `traceEvents` 也应有 `traceCache`，两者对齐。
4. **巡检脚本**：添加集成测试用例，验证技能选中后能在 agent-runner 日志中看到 `skill=N (N>0)`。