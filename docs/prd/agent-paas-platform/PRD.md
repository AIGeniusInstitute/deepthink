# DeepThink 企业级 Agent PaaS 平台 — PRD

**版本**: v1.0 (MVP)
**分支**: `feat/agent-paas-platform` (基于 `main`)
**作者**: ai-coder
**日期**: 2026-07-15

---

## 1. 背景与目标

DeepThink 当前已具备多 Agent 协作框架、Claude/AtomCode 双引擎、飞书/Telegram/Web 多通道接入。但用户无法：

- **自定义 Agent**：现有 `agents` 表只存任务实例（运行态），没有"Agent 定义"实体（静态配置：prompt/工具/模型/知识库）。
- **挂载知识库**：完全没有 KB/RAG 能力，Agent 无法检索企业文档。
- **工具/MCP/Skill 市场**：MCP 和 Skill 是 per-user 全量挂载到所有会话，没有"市场"概念供浏览/订阅，也没有 per-agent 挂载粒度。

本 PRD 把 DeepThink 升级为**企业级 Agent PaaS 平台**：用户可创建自己的 Agent、挂载知识库与工具/MCP/Skill，运行时按 Agent 配置组装执行环境。

---

## 2. 用户故事

| # | 角色 | 故事 | MVP | Phase 2 |
|---|------|------|-----|---------|
| US1 | 企业用户 | 创建一个"客服 Agent"，配置系统 prompt + 选择挂载的知识库 + 选用工具市场里的 3 个工具 | ✅ | |
| US2 | 企业用户 | 在知识库页面上传 PDF/Markdown，Agent 对话时可检索 | ✅ (MD/TXT only) | PDF/OCR |
| US3 | 企业用户 | 浏览工具市场，把"代码搜索"工具挂到自己的 Agent 上 | ✅ (admin curated) | 用户发布 |
| US4 | 企业用户 | 把同一个 Skill（如 `/code-review`）挂到多个 Agent 上 | ✅ | |
| US5 | 管理员 | 在市场页发布新的 Agent 模板 / MCP 模板 / Skill 模板 / KB 模板 | ✅ (DB seed) | 发布 UI |
| US6 | 企业用户 | 创建 Agent 后，在主对话框选择该 Agent 作为对话主体 | ✅ | |
| US7 | 企业用户 | 查看自己 Agent 的对话历史、token 用量 | ✅ (复用现有 usage) | |
| US8 | 团队管理员 | 把 Agent 共享给团队成员，团队成员可使用但不可编辑 | | ✅ |
| US9 | 企业用户 | 在市场发布自己的 Agent 模板，赚分成 | | ✅ |

---

## 3. 假设与取舍 (Think Before Coding)

### 3.1 假设清单

| # | 假设 | 理由 |
|---|------|------|
| A1 | **新增 `agent_definitions` 表**，不复用现有 `agents` 表（agents 表保留为任务实例） | 定义是静态配置，实例是运行态，混在一起会污染查询语义 |
| A2 | **Agent 定义归属 user_id**，不做 org/team 层级（Phase 2） | 简单性优先，多租户 org 模型会大幅膨胀 schema |
| A3 | **知识库用 SQLite FTS5 全文检索**，不上向量 DB | MVP 够用，文档切片 + FTS5 能解决 80% 场景；向量 DB（Milvus/pgvector）Phase 2 再加 |
| A4 | **知识库支持 Markdown 和纯文本**，PDF/DOCX 解析 Phase 2 | 文档解析依赖很重（pdf-parse/mammoth），简单性优先 |
| A5 | **市场是 admin curated**：admin 通过 seed 脚本或后台 API 发布模板，用户浏览+安装；用户不能自助发布（Phase 2） | 自助发布需要审核/分成/版本管理，MVP 不做 |
| A6 | **安装模板 = 复制为用户私有实例**：市场模板（agent_template/mcp_template/skill_template/kb_template）被用户"安装"后，复制一份到用户自己的 `agent_definitions`/MCP 配置/skills 目录/kb 实例 | 简单的 clone 模型，避免运行时跨用户依赖 |
| A7 | **per-agent 挂载粒度**：新表 `agent_mounts` 记录 (agent_def_id, resource_type, resource_id) 三元组；agent-runner 启动时按 mount 表过滤 MCP/Skill/KB | 替代当前 per-user 全量挂载，是 PaaS 的核心价值 |
| A8 | **Agent 定义可绑定到一个群组**：用户在对话框选择 Agent → 写入 `registered_groups.agent_def_id`，该群组后续会话使用此 Agent 定义 | 复用现有群组路由，不破坏现有 UX |
| A9 | **Agent prompt 支持模板变量** `{{user_name}}` `{{kb_name}}`，运行时替换 | 简单字符串替换，不要 template 引擎 |
| A10 | **KB 检索通过新 MCP 工具 `kb_search` 暴露给 Agent**，不直接注入 prompt | 保持 Agent 行为可观测；kb_search 注入到 agent-runner 内置 MCP |
| A11 | **MVP 不做 Agent 版本管理**：定义是单版本，编辑即覆盖 | 简单性优先，版本管理 Phase 2 |
| A12 | **市场模板存储在 `marketplace_items` 表**，`item_type` 区分 agent/mcp/skill/kb 四种 | 一张表比四张表简单，filter by type 即可 |

### 3.2 取舍说明

- **简单性优先**：不做 RBAC 细粒度权限、不做版本、不做分成、不做审核、不做团队共享。这些都是 Phase 2。
- **不破坏现有 UX**：用户可以继续不用 Agent 定义，直接用群组 + 全量 MCP（兼容老路径）。
- **KB 检索用 FTS5**：FTS5 内置于 SQLite，零依赖，足够 MVP。
- **文档解析只做 MD/TXT**：PDF 等重格式 Phase 2。

---

## 4. 功能需求

### 4.1 后端

#### 4.1.1 数据库 Schema (v44 → v48)

**新表**:

1. `agent_definitions` — Agent 定义
   - `id` (TEXT PK, UUID)
   - `user_id` (TEXT, FK users.id)
   - `name` (TEXT)
   - `description` (TEXT)
   - `system_prompt` (TEXT)
   - `model` (TEXT, nullable = 用全局默认)
   - `engine` (TEXT, 'claude' | 'atomcode', default 'claude')
   - `avatar_emoji` (TEXT, nullable)
   - `avatar_color` (TEXT, nullable)
   - `max_turns` (INTEGER, nullable)
   - `temperature` (REAL, nullable)
   - `enabled` (INTEGER, default 1)
   - `created_at` (TEXT, ISO)
   - `updated_at` (TEXT, ISO)

2. `agent_mounts` — Agent 资源挂载
   - `id` (TEXT PK, UUID)
   - `agent_def_id` (TEXT, FK agent_definitions.id ON DELETE CASCADE)
   - `resource_type` (TEXT, 'mcp_server' | 'skill' | 'knowledge_base')
   - `resource_id` (TEXT) — MCP: mcp_server_id; Skill: skill_name; KB: kb_id
   - `created_at` (TEXT, ISO)
   - UNIQUE (agent_def_id, resource_type, resource_id)

3. `knowledge_bases` — 知识库
   - `id` (TEXT PK, UUID)
   - `user_id` (TEXT)
   - `name` (TEXT)
   - `description` (TEXT)
   - `doc_count` (INTEGER, default 0)
   - `created_at`, `updated_at`

4. `kb_documents` — 知识库文档
   - `id` (TEXT PK, UUID)
   - `kb_id` (TEXT, FK knowledge_bases.id ON DELETE CASCADE)
   - `user_id` (TEXT)
   - `filename` (TEXT)
   - `content` (TEXT) — 原文
   - `content_hash` (TEXT, sha256)
   - `size_bytes` (INTEGER)
   - `created_at`

5. `kb_documents_fts` — FTS5 虚拟表（content='kb_documents', content_rowid='rowid'）
   - 列: `filename`, `content`
   - 触发器同步 INSERT/UPDATE/DELETE

6. `marketplace_items` — 市场模板
   - `id` (TEXT PK, UUID)
   - `item_type` (TEXT, 'agent_template' | 'mcp_template' | 'skill_template' | 'kb_template')
   - `name` (TEXT)
   - `description` (TEXT)
   - `author_name` (TEXT)
   - `tags` (TEXT, JSON array)
   - `payload` (TEXT, JSON) — 完整模板内容（不同 item_type 不同 schema）
   - `installed_count` (INTEGER, default 0)
   - `created_at`, `updated_at`

**已有表修改**:
- `registered_groups` 新增 `agent_def_id` (TEXT, nullable, FK agent_definitions.id)
- `users` 新增 `agent_quota` (INTEGER, default 10) — MVP 给每用户 10 个 Agent 配额

#### 4.1.2 API 端点

**Agent 定义 CRUD** (用户级):
- `GET /api/agent-definitions` — 列出我的 Agent
- `POST /api/agent-definitions` — 创建
- `GET /api/agent-definitions/:id` — 详情（含 mounts）
- `PATCH /api/agent-definitions/:id` — 更新
- `DELETE /api/agent-definitions/:id` — 删除
- `POST /api/agent-definitions/:id/mounts` — 挂载资源
- `DELETE /api/agent-definitions/:id/mounts/:mount_id` — 卸载资源

**知识库 CRUD** (用户级):
- `GET /api/knowledge-bases` — 列出我的 KB
- `POST /api/knowledge-bases` — 创建
- `GET /api/knowledge-bases/:id` — 详情（含 doc_count）
- `PATCH /api/knowledge-bases/:id` — 更新
- `DELETE /api/knowledge-bases/:id` — 删除
- `POST /api/knowledge-bases/:id/documents` — 上传文档（multipart）
- `GET /api/knowledge-bases/:id/documents` — 文档列表
- `DELETE /api/knowledge-bases/:id/documents/:doc_id` — 删除文档
- `POST /api/knowledge-bases/:id/search` — 全文检索（query, limit）

**市场**:
- `GET /api/marketplace` — 列表（?item_type=agent_template）
- `GET /api/marketplace/:id` — 详情
- `POST /api/marketplace/:id/install` — 安装模板到我的资源

**群组绑定 Agent**:
- `PATCH /api/groups/:jid` 已有端点扩展，支持 `agent_def_id` 字段

**KB 检索工具（agent-runner 内置 MCP）**:
- `kb_search(query, kb_ids?, limit=5)` — 检索指定 KB

#### 4.1.3 MCP 工具注入流程

`container/agent-runner/src/mcp-tools.ts` 新增 `kb_search` 工具：
1. 接收 `query`, `kb_ids` (可选，默认查当前 Agent 挂载的所有 KB), `limit`
2. 通过 IPC 文件向主进程请求检索结果（主进程持有 DB 连接，agent-runner 没有）
3. 主进程新增 IPC handler: `kb_search` → 查 FTS5 → 返回 `{filename, snippet, content}[]`

### 4.2 前端

**新页面**:

1. `/agents` — Agent Studio
   - 列表（卡片视图）：我的 Agent + 配额提示
   - 创建/编辑表单：name, description, system_prompt, model, engine, avatar, max_turns
   - 资源挂载面板：3 个 tab（MCP / Skill / KB），checkbox 选中
   - 删除按钮（带确认）
   - "创建群组并绑定此 Agent" 快捷按钮

2. `/knowledge-bases` — 知识库管理
   - 列表 + 创建表单
   - 详情页：文档列表 + 上传按钮 + 检索测试输入框

3. `/marketplace` — 市场
   - 四个 tab: Agent / MCP / Skill / KB
   - 每项卡片：name, description, author, tags, installed_count, "安装" 按钮
   - 安装后跳转到对应资源页

**已有点位的扩展**:

- 群组设置弹窗：新增"绑定 Agent"下拉框
- 主对话框 header：当前群组绑定了 Agent 时显示 Agent 名字 + emoji

### 4.3 运行时行为

**群组绑定 Agent 后的会话流程**:

1. 主进程 `runContainerAgent/runHostAgent` 读取 `group.agent_def_id`
2. 查 `agent_definitions` 表拿到定义（prompt/model/engine/max_turns/mounts）
3. 将定义序列化到 `ContainerInput.agentDefinition` 字段（含 mounts 列表）
4. agent-runner 启动时：
   - 用 `agentDefinition.system_prompt` 替换默认 system prompt
   - 用 `agentDefinition.model` 覆盖 CLAUDE_MODEL
   - MCP servers 只加载 `mounts[type=mcp_server]` 列出的（覆盖默认全量加载）
   - Skills 只加载 `mounts[type=skill]` 列出的（覆盖默认全量加载）
   - KB IDs 通过 env `AGENT_KB_IDS` 注入，供 `kb_search` 工具使用

---

## 5. 非功能需求

| 项 | 要求 |
|----|------|
| 性能 | KB 全文检索 < 200ms（10k 文档以内）；Agent 列表加载 < 500ms |
| 并发 | 同一用户最多 10 个并发 Agent 会话（复用容器并发限制） |
| 存储 | 每用户 KB 总量 ≤ 500MB（MVP 不强制，记在 TODO） |
| 安全 | 用户只能操作自己的 Agent/KB/挂载；admin 可管理所有 |
| 兼容 | 现有不带 agent_def_id 的群组继续走默认 Claude/AtomCode 路径，零影响 |
| 可观测 | 每次会话记录 agent_def_id 到 messages 表（便于审计） |

---

## 6. 验收标准

| # | 验收点 |
|---|--------|
| AC1 | DB v48 schema 升级成功，新表存在，老数据不丢 |
| AC2 | `POST /api/agent-definitions` 创建 Agent，返回 id 和完整字段 |
| AC3 | `POST /api/agent-definitions/:id/mounts` 能挂载 MCP/Skill/KB，重复挂载返回 409 |
| AC4 | `POST /api/knowledge-bases/:id/documents` 上传 .md 文件后，`POST /search` 能检索到 |
| AC5 | `GET /api/marketplace?item_type=agent_template` 返回 admin seed 的模板列表 |
| AC6 | `POST /api/marketplace/:id/install` 安装 agent_template 后，`GET /api/agent-definitions` 能看到新 Agent |
| AC7 | `PATCH /api/groups/:jid {agent_def_id}` 切换群组绑定，`GET /api/groups` 往返一致 |
| AC8 | 群组绑定 Agent 后发消息，agent-runner 日志显示加载了定义的 system_prompt + 过滤后的 MCP |
| AC9 | 不带 agent_def_id 的群组继续工作（向后兼容） |
| AC10 | 前端 `/agents`、`/knowledge-bases`、`/marketplace` 三页可见可用 |
| AC11 | 三端 typecheck + build 全部 EXIT=0 |

---

## 7. 风险与缓解

| 风险 | 缓解 |
|------|------|
| R1: scope creep | 严格守住 MVP 范围（§3.1 假设清单），Phase 2 项显式标注 |
| R2: FTS5 性能瓶颈 | 文档数 ≤ 10k 时无需优化；超出时 Phase 2 上向量索引 |
| R3: 现有群组回归 | 不修改 group 无 agent_def_id 时的行为路径，新增字段全 nullable |
| R4: agent-runner 兼容性 | ContainerInput 新增字段可选，老 SDK 调用不传也不报错 |
| R5: 市场冷启动 | 写 seed 脚本预填 3 个 agent_template + 2 个 mcp_template + 2 个 skill_template |

---

## 8. 里程碑

| # | 里程碑 | 交付 |
|---|--------|------|
| M1 | DB schema + 数据层 | v48 migration + 新表的 CRUD 函数 |
| M2 | 后端 API | 所有 §4.1.2 端点 + 鉴权 + Zod schema |
| M3 | agent-runner 集成 | ContainerInput 扩展 + MCP/Skill 过滤加载 + kb_search MCP 工具 |
| M4 | 前端三页 | /agents, /knowledge-bases, /marketplace + 群组绑定下拉 |
| M5 | 市场种子数据 | 5+ 模板预填 |
| M6 | E2E 验证 | API curl + typecheck + build + 测试报告 |

---

## 9. Phase 2（不在 MVP 范围）

- 团队/组织层级、Agent 共享、协作编辑
- 用户自助发布模板到市场、审核流程、分成
- 向量数据库（pgvector/Milvus）+ 嵌入式检索
- PDF/DOCX/HTML 文档解析
- Agent 版本管理、A/B 测试
- 每月 Agent 用量账单、计费集成
- Agent 模板工作流（多 Agent 编排）
