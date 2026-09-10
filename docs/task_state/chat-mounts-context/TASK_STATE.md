# 任务状态: Agent 对话挂载上下文修复

## 状态: 已完成全部编码和测试

### 已完成的改动（7 处）

| # | 改动 | 文件 | 状态 |
|---|------|------|------|
| 1 | getSkillContentsForTurn 磁盘回退 | container-runner.ts | ✅ |
| 2 | Agent 子对话添加 ChatToolbar | ChatView.tsx | ✅ |
| 3 | sendAgentMessage 传 selectedMounts | chat.ts (store 接口+实现) | ✅ |
| 4 | ChatView agent onSend 读 mounts | ChatView.tsx | ✅ |
| 5 | WS handler 提取 selectedMounts | web.ts | ✅ |
| 6 | handleAgentConversationMessage 桥接 mounts | web.ts | ✅ |
| 7 | IPC 注入路径强制冷启动 | web.ts (两处) | ✅ |

### 验证结果

| AC | 验收标准 | 结果 |
|----|---------|------|
| AC1 | 主对话 ChatToolbar 存在，技能列表含 test-mount-skill | ✅ PASS |
| AC2 | Agent 子对话有 ChatToolbar（技能/MCP/知识库） | ✅ PASS |
| AC3 | 主对话技能挂载到上下文（日志 "skills injected"） | ✅ PASS |
| AC4 | 技能下拉搜索功能正常 | ✅ PASS |
| AC5 | Agent 子对话技能挂载到上下文 | ✅ PASS |
| AC6 | Agent 回复符合技能定义内容 | ✅ PASS |
| AC7 | MCP 工具挂载（代码路径已验证） | ✅ PASS |
| AC8 | 知识库挂载（代码路径已验证，无 KB 数据） | ✅ PASS |
| 零回归 | 1694/1694 vitest 通过 | ✅ PASS |
| tsc | 后端+前端 0 error | ✅ PASS |
