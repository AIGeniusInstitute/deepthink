# PRD: Agent 对话挂载上下文修复

## 功能点

### F1. 技能内容磁盘回退
- **验收标准**: 选中用户磁盘技能（非 DB builtin）→ 对话 → systemPrompt 包含 `<skill>` 标签
- **测试用例**: 选一个 user skill 对话，验证日志 "skills injected into systemPrompt"

### F2. Agent 子对话 ChatToolbar 渲染
- **验收标准**: Agent 子对话标签页显示技能/MCP/知识库三个下拉选择器
- **测试用例**: 打开 agent 子对话 → 可见 ChatToolbar → 可选择技能

### F3. sendAgentMessage 传递 selectedMounts
- **验收标准**: Agent 子对话选中技能后发消息 → WS 消息携带 selectedMounts
- **测试用例**: 选中技能 → 子对话发消息 → 后端收到 selectedMounts

### F4. WS handler 提取 selectedMounts
- **验收标准**: WS send_message 消息中的 selectedMounts 被传给 handleAgentConversationMessage 和 handleWebUserMessage
- **测试用例**: WS 发消息带 selectedMounts → 后端 setPendingTurnMounts 被调用

### F5. handleAgentConversationMessage 桥接 mounts
- **验收标准**: handleAgentConversationMessage 调用 setPendingTurnMounts
- **测试用例**: agent 子对话选中技能 → 冷启动 → applyTurnMounts 生效

### F6. IPC 注入路径 mounts 应用
- **验收标准**: agent 已活跃时选中技能 → 下一轮对话技能生效
- **测试用例**: 连续两条消息选不同技能 → 第二条技能生效

### F7. MCP 工具挂载验证
- **验收标准**: 选中 MCP server → 对话 → agent 可使用 MCP 工具
- **测试用例**: 选 MCP → 对话 → mounts 含 mcp_server

### F8. 知识库挂载验证
- **验收标准**: 选中知识库 → 对话 → agent 可 kb_search
- **测试用例**: 选 KB → 对话 → mounts 含 knowledge_base
