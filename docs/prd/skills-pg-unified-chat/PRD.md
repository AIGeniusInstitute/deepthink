# PRD: Skills 迁 PostgreSQL + 对话挂载控件 + 办公技能快捷按钮

> 分支 `feat/skills-pg-unified-chat`。对应 intent: docs/intent/skills-pg-unified-chat/INTENT.md

## 背景（探查结论，非假设）

- PG 基础设施已就绪：`DATABASE_URL` 以 `postgresql://` 开头 → `sqlite-compat.ts` + `pg-sync-driver.ts`(同步桥) + `sql-translator.ts`(方言翻译) 全自动切换，结构化业务数据（agents/agent_definitions/agent_mounts/knowledge_bases/kb_documents/mcp_registry_*/billing/usage/skill_versions）已可入 PG。schema_version=60。
- **唯一缺口**：无 `skills` 表。技能源纯文件系统：`DATA_DIR/skills/{userId}/` + `.skills-manifest.json`，`discoverSkills()` 扫目录不查库。
- 办公技能 PPT/Excel/PDF/Word/Markdown 在 `~/.claude/skills` 已有现成 SKILL.md（pptx/xlsx/pdf/docx/markdown-mermaid-writing），OCR 无现成 skill。
- 前端对话主分支：`ChatView.tsx:813` 渲染 `<LoopModeSwitcher>`，814-827 三元 `chat? MessageInput : LoopForm`。
- 前端无多选下拉原语（`select.tsx` 是 Radix 单选），需基于 `popover.tsx`+`checkbox.tsx` 自建。
- Docker：`deploy/docker/docker-compose.yml` 单服务无 PG，volume `deepthink-data` named；`deploy/local/docker-compose.yml` 有 PG(pgvector:pg16)+Redis+MinIO 但三个 volume 均 named 未 bind-mount 到本机磁盘。

## 范围决策（Think Before Coding — 显式声明，避免假设）

用户原话"把 Agent、技能、MCP、知识库、工作区产物…全部数据存储到 PostgreSQL"。逐项核实后的范围：

| 数据类 | 现状 | 本期处理 | 理由 |
|---|---|---|---|
| Agent | agent_definitions 已在 DB（PG 模式即入 PG） | ✅ 确认 PG 模式即可，无需改 | 已具备 |
| 技能(skills) | 纯文件系统，无表 | ✅ **新建 `skills` 表**（元数据+SKILL.md 内容），seed 办公技能 | 用户明确要"初始化到 skill 表" |
| MCP | mcp_registry_* 已在 DB | ✅ 确认即可 | 已具备 |
| 知识库 | knowledge_bases+kb_documents 已在 DB | ✅ 确认即可 | 已具备 |
| 工作区产物 | 文件系统/object-store(fs/s3) | ⚠️ **元数据入 PG**（新增 `workspace_artifacts` 表存 name/path/size/ref），**大 blob 留 object-store**(MinIO) | 大 blob 入 PG BLOB 是反模式（膨胀/ vacuum 慢/单行 1GB 上限）；MinIO volume 同样 bind-mount 到本机磁盘保证持久。若用户坚持 blob 入 PG，再改。 |
| Docker 数据盘 | named volume | ✅ **改 bind-mount 到本机磁盘**（`./data/pg` `./data/redis` `./data/minio` `./data/deepthink`） | 用户明确"数据盘挂载到本机磁盘" |

**明确不做（防过度工程）**：
- 不把 SQLite 整库一次性搬到 PG（PG 模式已自动支持，建表即生效）。
- 不重写 agent-runner 的文件挂载机制（技能运行时通过 system_prompt 注入内容，无需物化 SKILL.md 到磁盘）。
- 不删除 LoopForm 的斜杠命令能力（`/goal` `/loop` 等后端仍识别），仅隐藏 UI 按钮。

## 功能点与验收标准

### FP1: skills 表 + Docker PG 数据盘 bind-mount（需求1）

**AC1.1** 新建 `skills` 表（schema_version 60→61）：`id TEXT PK, user_id TEXT NULL(NULL=系统内置), name TEXT, description TEXT, content TEXT(SKILL.md 全文), category TEXT, scope TEXT('builtin'|'user'|'project'), enabled INT DEFAULT 1, source TEXT('seed'|'manual'|'install'), allowed_tools TEXT, created_at, updated_at`，索引 `idx_skills_user` `idx_skills_scope`。PG 与 SQLite 双兼容。
**AC1.2** 启动时 seed 6 个办公技能到 skills 表（scope='builtin', user_id=NULL）：ppt(PPT制作)/excel(Excel表格)/pdf(PDF处理)/ocr(图片OCR)/word(WORD文档)/markdown(Markdown文档)。内容取自 `~/.claude/skills` 现成 SKILL.md（pptx/xlsx/pdf/docx/markdown-mermaid-writing），OCR 新写基于 tesseract 的 SKILL.md。幂等（ON CONFLICT DO NOTHING）。
**AC1.3** `deploy/local/docker-compose.yml` 三个 volume 改 bind-mount 到本机 `./data/{pg,redis,minio}`，`deploy/docker/docker-compose.yml` 加 postgres(pgvector:pg16) 服务 + deepthink 的 DATABASE_URL + bind-mount `./data/deepthink:/data` + `./data/pg`。
**AC1.4** `docker compose down && up` 后 PG 内 skills 表数据仍在（bind-mount 验证）。
**AC1.5** 新增 `workspace_artifacts` 表（id/group_folder/user_id/name/artifact_type/content_ref/size_bytes/created_at），元数据入 PG，blob 留 object-store。

### FP2: 对话挂载控件（技能/MCP/知识库下拉多选）（需求2）

**AC2.1** 新建 `ChatMounts` 组件（3 个多选下拉：🧪技能 / 🔌MCP / 📚知识库），基于 popover+checkbox+SearchInput，置于 MessageInput 上方 action row。技能数据源 `useSkillsStore`（读 PG skills 表 via `/api/skills`），MCP 源 `useWorkspaceConfigStore.mcpServers`，KB 源 `useKnowledgeBasesStore`。
**AC2.2** 新建 `useChatMountsStore`：per groupJid 持 `{skillIds:[], mcpIds:[], kbIds:[]}`，选中态持久到 localStorage。
**AC2.3** 发送消息时把选中的 mounts 附入 payload：`POST /api/messages` body 加 `mounts:{skillIds,mcpIds,kbIds}`。
**AC2.4** 后端 `/api/messages` 收到 mounts 后：①技能→读 skills 表 content 拼入该 turn 的 system_prompt/additional_instructions；②MCP→把 mcp server ids 加入 agent context plan 的 mcp mounts；③KB→对选中 KB 做 RAG 检索（复用 kb 检索），结果作为上下文注入 system_prompt。
**AC2.5** 选中技能后实时对话，agent 回复体现技能被加载（如选 PPT 技能后问"做个5页汇报"→agent 用 pptx 工具产出）。

### FP3: 隐藏模式按钮 + 办公技能快捷指令按钮（需求3）

**AC3.1** `ChatView.tsx:813` 删除 `<LoopModeSwitcher>` 渲染，三元简化为始终渲染 `<MessageInput>`（LoopForm 不再从 UI 触发，斜杠命令后端仍识别保留）。
**AC3.2** 新建 `OfficeSkillsBar` 组件，置于 MessageInput 上方（原 LoopModeSwitcher 位置），6 个快捷按钮：📊PPT制作 / 📈Excel表格 / 📄PDF处理 / 🔍图片OCR /📝WORD文档 / 📝Markdown文档。
**AC3.3** 点击办公技能按钮 → ①在 ChatMounts 的技能多选里自动选中该 skill；②输入框预填任务 prompt（如 PPT 按钮→"请用 PPT制作 技能，帮我做一份关于[X]的5页汇报大纲"占位，用户补全后发送）；③Agent 运行时加载该技能。
**AC3.4** Playwright UI 测试：登录→进对话→验证 LoopModeSwitcher 6 按钮不可见→验证办公技能 6 按钮可见→点击 PPT 按钮→技能下拉选中 ppt→输入框含预填→截图。

## 测试用例（编码后执行）

| TC | 步骤 | 预期 |
|---|---|---|
| TC1 | PG 模式启动，`SELECT * FROM skills WHERE scope='builtin'` | 6 行 |
| TC2 | `docker compose down && up`，再查 skills 表 | 6 行仍在（bind-mount） |
| TC3 | `curl GET /api/skills` | 返回含 6 办公技能 |
| TC4 | Playwright：对话页 LoopModeSwitcher 按钮 | 0 个 |
| TC5 | Playwright：办公技能按钮 | 6 个 |
| TC6 | Playwright：点 PPT 按钮→技能下拉 | ppt 选中 |
| TC7 | 选技能+发送消息→查 agent context 日志 | system_prompt 含技能内容 |
| TC8 | 选 KB+发送→agent 回复 | 回复引用 KB 文档 |
| TC9 | SQLite 模式（不设 DATABASE_URL）回归 | 原 skills 文件系统路径不退化，skills 表也建（双兼容） |

## 非功能
- PG/SQLite 双兼容（sql-translator 翻译）。
- 零回归：现有 SkillsPage/WorkspaceSkillsPanel/MCP/KB 管理页不退化。
- 不引入新前端重依赖（多选用现有 popover+checkbox）。
