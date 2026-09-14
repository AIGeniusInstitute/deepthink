# Intent: 端到端 Bugfix — Agent 对话流式输出 & 新建会话 Tab 无响应

**日期**: 2026-09-15
**分支**: `fix/agent-streaming-and-new-chat-tab`
**参考项目**: `~/prime-ai-harness/` (PrimeHarness) 已修复同类问题

## 用户原始意图

K8s 集群部署的 DeepThink 系统存在两个严重 Bug：

1. **Agent 对话输出无中间过程流式输出**：主对话 Agent 输入消息后，没有思考推理过程、工具调用输出、技能调用输出等中间流式输出。用户只能看到最终结果，中间过程完全丢失。

2. **新建会话 Tab 无响应**：在 Agent 会话界面，点击新建会话 Tab 后，Agent 完全无响应。

## 参考修复（PrimeHarness）

PrimeHarness 项目 (`~/prime-ai-harness/`) 在最近的 commits 中修复了同类问题，关键修复包括：

### Fix A: 流式中间过程丢失（commit cf5bcfd）
- **根因**：`startAgentResultLoop` 固定 2s 轮询把 stream delta 攒成 2 秒一批，短回复时全部事件与 final 同批到达，前端流式面板刚建立立即被清
- **修复**：自适应三态轮询——满轮(≥32)立即续轮清积压、有事件退避 200ms 追流、空轮回落 2s

### Fix B: 云模式 publisher 不等待 turn 完成（commit 5e54ee9）
- **根因**：云模式 `processGroupMessages` 只 publish `agent_task.create` 即 return，GroupQueue 把"publish 完成"当"执行完成"，~50ms 后即广播 idle → 前端清 waiting 态，此后全部流式 delta 被丢弃
- **修复**：publish 后等待 runner 完成（eventDrivenTaskWaiters + hasTurnReply DB 轮询兜底）

### Fix C: 执行轨迹跨进程覆盖（commit cf5bcfd）
- **根因**：TraceNodeAllocator 的 nodeId 每进程从 1 递增，K8s 每 task 新 pod 必然跨进程碰撞 UNIQUE(chat_jid,id)，upsert 原地覆盖历史轨迹行
- **修复**：host 在 runContainerAgent/runHostAgent 构造 ContainerInput 时注入 traceNodeIdBase = MAX(chat_trace_nodes.id)+1

### Fix D: 主对话 wait key 无条件下放（commit e81bf9b）
- **根因**：waitForEventDrivenFinal 的 wait key 由 messageTaskId（仅定时任务消息有值）门控，普通用户消息跳过等待
- **修复**：无条件 wait key = `messageTaskId ?? grp:{chatJid}:{turnMessageId}`

### Fix E: 会话 Agent meta 隔离（commit e81bf9b）
- **根因**：agent-runner runningTasks 按 aggregate_id(chatJid) 单条登记，主对话与会话 Agent 共用一 key，后完成任务删 key 致另一任务 final 丢 meta → 回复落入错误 JID
- **修复**：meta 经 onOutput 闭包捕获，每个任务结果始终携带自己的 meta

### Fix F: trace 节点按会话隔离（commit 1952117）
- **根因**：会话 Agent 的 trace 节点落基础 JID（主对话池），主对话时间窗把会话 Agent 的工具轨迹挂到主对话消息下方，会话 Tab 看不到
- **修复**：trace 节点按 agentId 路由到虚拟 JID

## 验收标准

1. 主对话输入消息后，能看到流式输出的：
   - 思考/推理过程（thinking_delta）
   - 文本输出（text_delta, 逐字流式）
   - 工具调用（tool_use_start / tool_result）
   - 技能调用
2. "技能"选择区域选择技能后，技能正常加载并被 Agent 读取
3. 新建会话 Tab 后，Agent 正常响应并返回结果
4. 所有中间过程数据在对话框中保留展示（刷新后也能恢复）