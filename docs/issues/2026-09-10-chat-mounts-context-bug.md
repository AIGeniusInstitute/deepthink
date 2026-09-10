# Issue: Agent 对话挂载上下文失效（6 bug）

> 日期：2026-09-10
> 范围：Agent 对话输入框选技能/MCP/知识库后，选中的资源未带到对话上下文

## 1. 用户现象

用户在 Agent 对话输入框选中某个技能后发送消息，技能内容未出现在对话上下文中，agent 不知道技能内容。MCP 工具和知识库同理。

## 2. 问题描述

Agent 对话有两条路径（主对话 HTTP POST /api/messages、子对话 WebSocket send_message），以及两种执行模式（冷启动新容器、IPC 注入活跃 runner）。技能/MCP/知识库挂载（selectedMounts）在多个环节断裂：

1. **getSkillContents 只查 DB** — 用户技能存在磁盘 SKILL.md，不在 DB `skills` 表中，查询返回空
2. **WebSocket handler 丢弃 selectedMounts** — `MessageCreateSchema.safeParse` 不传 `selectedMounts`
3. **handleAgentConversationMessage 不桥接 mounts** — 不调 `setPendingTurnMounts`，冷启动时 pop 出 undefined
4. **IPC 注入路径不支持 per-turn mounts** — 活跃 runner 只接收 stdin 文本，mounts 只在冷启动应用
5. **Agent 子对话无 ChatToolbar** — `ChatView.tsx` agent 分支不渲染 ChatToolbar 组件
6. **sendAgentMessage 不传 selectedMounts** — WS 消息体不含 `selectedMounts`

## 3. 根因

### Bug 1: getSkillContents 磁盘回退缺失
- **代码**: `src/db.ts:10383-10390` `getSkillContents()` 只做 `SELECT id, name, content FROM skills WHERE id IN (...)`
- **数据层**: DB `skills` 表仅 `seedBuiltinSkills()` 填充 6 个内置技能；用户技能由 `writeSkillContent()` 写磁盘 `data/skills/{userId}/{skillId}/SKILL.md`
- **调用链**: `container-runner.ts:1229` `applyTurnMounts()` → `getSkillContents(ids)` → DB 查空 → warn "no skill content found" → 不注入 systemPrompt

### Bug 2-6: 见 tech_solution 文档

## 4. 复现路径

1. 创建用户技能 `test-mount-skill`（磁盘 SKILL.md）
2. 打开主对话或 agent 子对话
3. 在 ChatToolbar 选中 `test-mount-skill`
4. 发送消息"测试技能"
5. Agent 回复不含技能内容（修复前）

## 5. 诊断方法

```bash
# 检查技能是否在 DB
sqlite3 ~/.deepthink/data/db/messages.db "SELECT id, name FROM skills WHERE id='test-mount-skill'"

# 检查磁盘技能
cat ~/.config/DeepThink/data/skills/{userId}/test-mount-skill/SKILL.md

# 发送带 selectedMounts 的消息
curl -X POST http://127.0.0.1:9999/api/messages \
  -H 'Content-Type: application/json' \
  -H "Cookie: $COOKIE" \
  -d '{"chatJid":"web:main","content":"测试技能","selectedMounts":{"skills":["test-mount-skill"]}}'

# 检查日志
grep "applyTurnMounts" ~/deepthink/logs/prod-server.log
```

## 6. 修复方案

### Fix 1: getSkillContentsForTurn 磁盘回退
```diff
+function getSkillContentsForTurn(ids, userId) {
+  const dbRows = getSkillContents(ids); // DB 查 builtin
+  const found = new Set(dbRows.map(r => r.id));
+  const missing = ids.filter(id => !found.has(id));
+  if (missing.length === 0 || !userId) return dbRows;
+  for (const id of missing) {
+    const skillPath = getSkillContentPath(userId, id); // 磁盘回退
+    if (skillPath && fs.existsSync(skillPath)) {
+      const content = fs.readFileSync(skillPath, 'utf-8');
+      const frontmatter = parseFrontmatter(content);
+      dbRows.push({ id, name: frontmatter.name || id, content });
+    }
+  }
+  return dbRows;
+}
- const skillRows = getSkillContents(turnMounts.skills);
+ const skillRows = getSkillContentsForTurn(turnMounts.skills, ownerUserId);
```

### Fix 2-6: WS 桥接 + ChatToolbar 渲染 + IPC 强制冷启动
见 `docs/tech_solution/chat-mounts-context/TECH_SOLUTION.md`

**选型理由**: 磁盘回退而非"用户技能写入 DB"——保持单一数据源（磁盘是 truth），DB 仅用于 builtin。IPC 强制冷启动而非"运行时注入 mounts"——processAgentConversation 从 DB 回放上下文不丢失，Simplicity First。

## 7. 处理卡住的状态

无。冷启动路径从 DB 回放，不依赖运行态进程。

## 8. 经验沉淀 / 预防

1. **磁盘/DB 双存储的资源要有统一的读取入口** — `discoverSkills` 读双源但 `getSkillContents` 只读 DB，两个函数应共享底层逻辑
2. **per-turn 挂载在 IPC 注入路径有固有局限** — 文档注释已有，但代码未自动绕过；修复后 `hasTurnMounts` 时自动走冷启动
3. **WebSocket 消息体应与 HTTP 请求体使用同一 schema** — `MessageCreateSchema.safeParse` 在 WS 路径漏传字段是常见模式错误
4. **巡检**: 每次新增 per-turn 字段时，检查 HTTP 路径（handleWebUserMessage）+ WS 路径（handleAgentConversationMessage）+ IPC 路径（queue.sendMessage）三条链路
