# TASK STATE — skills-pg-unified-chat

## 需求概述
三大需求：
1. **FP1 系统数据全量入 PostgreSQL**：Agent/Skills/MCP/知识库/工作区产物存 PG；Docker DB 数据盘 bind-mount 到宿主持久化。
2. **FP2 对话挂载控件**：对话输入框上方技能/MCP/知识库下拉搜索框（多选），运行时挂载注入。
3. **FP3 办公技能快捷栏**：隐藏原 6 个循环模式按钮；6 个内置办公技能（PPT/Excel/PDF/OCR/Word/Markdown）入库，做快捷指令按钮，点击→自动选技能+预填输入。

## 状态：全部完成 ✅

### FP1 — PG 存储 + Docker bind-mount
- [x] `deploy/local/docker-compose.yml` + `deploy/docker/docker-compose.yml`：PG 数据盘改 bind-mount（`./data/pg:/var/lib/postgresql/data`），deepthink 数据 `./data/deepthink:/data`，DATABASE_URL 注入。
- [x] `src/db.ts`：新增 `skills` 表（id/user_id/name/description/content/category/scope CHECK builtin|user|project/enabled/source/allowed_tools/quick_label/quick_emoji/quick_prompt/created_at/updated_at）+ `workspace_artifacts` 表（元数据，blob 留对象存储 MinIO）。
- [x] SCHEMA_VERSION → 61；`seedBuiltinSkills()` 启动注入 6 个办公技能（UPSERT ON CONFLICT 幂等）。
- [x] `readBuiltinSkillContent()` 读 `~/.claude/skills/<dir>/SKILL.md`（OCR 走内联）。
- [x] DB helpers：`listSkillsForUser`/`listBuiltinQuickSkills`/`getSkillById`/`getSkillContents`。
- [x] `src/routes/skills.ts`：`GET /api/skills/builtin` 返回 6 个快捷技能（注册在 `/:id` 前）。

### FP2 — 对话挂载下拉控件 + 运行时注入
- [x] 前端 `web/src/stores/chat-mounts.ts`：zustand+persist per-groupJid 挂载状态。
- [x] 前端 `web/src/components/chat/ChatToolbar.tsx`：3 个 MultiSelectDropdown（技能/MCP/知识库，popover+checkbox+搜索）。
- [x] 前端 `chat.ts sendMessage` + `ChatView handleSend`：selectedMounts 传入 POST body。
- [x] `schemas.ts`：MessageCreateSchema 加 `selectedMounts`。
- [x] `web.ts handleWebUserMessage`：opts.selectedMounts → `deps.setPendingTurnMounts(msgId)`。
- [x] `web-context.ts`：WebDeps 加 `setPendingTurnMounts` + 导出 `SelectedMounts` 类型。
- [x] `index.ts`：模块级 `pendingTurnMounts` Map + `popPendingTurnMounts` + WebDeps 注入 + processGroupMessages 读 → `containerInput.turnMounts`。
- [x] `container-runner.ts`：ContainerInput 加 `turnMounts`；`applyTurnMounts()` 合并——skills→`getSkillContents` 内容注入 systemPrompt（DB 技能无磁盘 SKILL.md，不能走 skillsOption 白名单）；MCP→`loadUserMcpServers` 解析 config→mounts；KB→`getKnowledgeBase` 所有权校验→mounts。docker+host 两路径接线。

### FP3 — 隐藏循环模式按钮 + 办公快捷栏
- [x] `ChatView.tsx`：删除 LoopModeSwitcher 渲染 + LoopForm 分支（slash 命令 /goal /loop 等仍可用）；`ChatToolbar` + `MessageInput`（prefillSignal prop）。
- [x] `MessageInput.tsx`：加 `prefillSignal` prop（nonce 触发追加文本+聚焦）。
- [x] `ChatToolbar` OfficeSkillsBar：6 个快捷按钮，点击→`onPickQuickSkill(skillId, quickPrompt)`→`setSkills` + `setPrefillSignal`。

## 关键 bug 修复（loop bugfix）
1. **React #185 Maximum update depth**：ChatToolbar 的 zustand selector `s.mounts[groupJid] ?? { ... }` 每次渲染新建对象→无限重渲染。修：模块级 `EMPTY_MOUNTS` 稳定引用。
2. **/api/skills/builtin 被 /:id 遮蔽**：Hono 路由匹配 `/:id` 先于 static `/builtin`（注册顺序虽在前但需确认）→ 部署 dist 只复制了 index.js 未复制 routes/skills.js（旧路由无 /builtin）。修：完整复制 dist/ 目录。

## 验证结果
- 后端 tsc --noEmit：0 error
- 前端 tsc --noEmit：0 error
- vite build：成功（44+ 模块）
- SQLite 回归：smoke 89/89 + skills-db 6/6 = 95/95 PASS
- API：`GET /api/skills/builtin` 返回 6 个办公技能（content 含完整 SKILL.md）
- Playwright UI：6/6 PASS（LoopModeSwitcher 隐藏 / 办公栏 6 按钮 / 挂载下拉 3 个 / PPT 点击预填 / 技能自动选中 / 下拉打开搜索）

## 遗留
- per-turn mounts 仅冷启动路径生效（IPC-inject 活跃 runner 无法应用，与 `autonomous` 同限制）。
- skills 内容注入 systemPrompt（非 skillsOption 白名单），因 DB 技能在容器无磁盘 SKILL.md。
