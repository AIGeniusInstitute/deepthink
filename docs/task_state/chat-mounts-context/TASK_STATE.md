# TASK STATE: Agent 对话挂载上下文修复

## 状态：全部完成

### 改动清单（7 处）

| # | 文件 | 改动 | 状态 |
|---|------|------|------|
| 1 | `src/container-runner.ts` | 新增 `getSkillContentsForTurn()` 磁盘回退 + import `getSkillContentPath`/`parseFrontmatter` | ✅ |
| 2 | `src/container-runner.ts` | `applyTurnMounts` 调用改 `getSkillContentsForTurn` + MCP/KB 日志 | ✅ |
| 3 | `web/src/components/chat/ChatView.tsx` | Agent 子对话添加 ChatToolbar + onSend 读 mounts | ✅ |
| 4 | `web/src/stores/chat.ts` | `sendAgentMessage` 加 `selectedMounts` 参数 + WS 消息体 | ✅ |
| 5 | `src/web.ts` | WS handler 提取 `selectedMounts` 传给两个 handler | ✅ |
| 6 | `src/web.ts` | `handleAgentConversationMessage` 调 `setPendingTurnMounts` | ✅ |
| 7 | `src/web.ts` | 两条路径 `hasTurnMounts` 时强制冷启动 | ✅ |

### 验证结果

- 后端 tsc: 0 error 0 warning ✅
- 前端 tsc: 0 error ✅
- Bug 1 验证: 日志 `skills injected` skillCount=1 skillIds=["test-mount-skill"] ✅
- Bug 5 验证: 浏览器确认 agent 子对话有 ChatToolbar (技能/MCP/KB 三个下拉) ✅
- Bug 2/3/4/6 验证: agent 子对话发消息触发 `applyTurnMounts` ✅
- MCP 验证: 日志 `MCP/KB mounts appended` mcpMounted=1 ✅
- KB 验证: 日志 `MCP/KB mounts appended` kbMounted=1 ✅
- 三合一验证: skillCount=1 + mcpMounted=1 + kbMounted=1 + totalMounts=2 ✅
