# 技术方案: Agent 对话挂载上下文修复

## 修复方案（6 处改动，Surgical Changes）

### 改动 1: getSkillContents 磁盘回退 (container-runner.ts)

**问题**: `getSkillContents(ids)` 只查 DB `skills` 表，用户技能存在磁盘 SKILL.md 不在 DB 中。

**方案**: 在 `applyTurnMounts` 中，DB 查询结果不足时从磁盘读取。
- 新建 helper `getSkillContentsForTurn(ids, userId)`:
  1. 调 `getSkillContents(ids)` 查 DB（builtin skills）
  2. 对未命中的 id，用 `getSkillContentPath(userId, id)` 读磁盘 SKILL.md
  3. 合并返回
- import `getSkillContentPath` from `skill-content-utils.js`
- import `parseFrontmatter` from `skill-utils.js`

### 改动 2: 前端 Agent 子对话添加 ChatToolbar (ChatView.tsx)

**问题**: agent 子对话分支（780-803 行）无 ChatToolbar。

**方案**: 在 MessageList 和 MessageInput 之间插入 ChatToolbar。

### 改动 3: 前端 sendAgentMessage 传 selectedMounts (chat.ts)

**问题**: sendAgentMessage 不传 selectedMounts。

**方案**: 
- 加 `selectedMounts?` 参数
- WS 消息体加 `selectedMounts` 字段

### 改动 4: 前端 ChatView agent 子对话 onSend 读 mounts (ChatView.tsx)

**方案**: agent 子对话 MessageInput.onSend 读 useChatMountsStore → 传给 sendAgentMessage

### 改动 5: 后端 WS handler 提取 selectedMounts (web.ts)

**问题**: WS send_message 不解析 selectedMounts，不传给 handleAgentConversationMessage/handleWebUserMessage。

**方案**:
- `MessageCreateSchema.safeParse` 加 `selectedMounts`
- `handleAgentConversationMessage` 调用传 `selectedMounts`
- `handleWebUserMessage` 调用传 `selectedMounts`

### 改动 6: 后端 handleAgentConversationMessage 桥接 mounts (web.ts)

**问题**: 不调 setPendingTurnMounts。

**方案**: 在 storeMessageDirect 后调 `deps.setPendingTurnMounts(messageId, opts.selectedMounts)`

### 改动 7: 后端 IPC 注入路径 mounts 应用 (web.ts + index.ts)

**问题**: agent 活跃时 IPC 注入不应用 mounts。

**方案**: 当 selectedMounts 非空时，不走 IPC 注入，改为 closeStdin + 冷启动（processAgentConversation 从 DB 回放上下文不丢失）。
