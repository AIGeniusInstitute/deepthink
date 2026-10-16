# DeepThink Web API 参考

> 本文档从 `CLAUDE.md` §7 拆分而来。修改 / 新增 API 端点时请同步更新。
>
> 顶层 `CLAUDE.md` 只保留路由文件入口索引作为 Agent 快速导航锚点；
> 详细端点清单按需 Read 本文档（每请求约节省 ~1K cache_read tokens）。

## 认证

- `GET /api/auth/status` — 系统初始化状态（`initialized`、是否有用户）
- `POST /api/auth/setup` — 创建首个管理员（仅用户表为空时可用）
- `POST /api/auth/login` · `POST /api/auth/logout` · `GET /api/auth/me`（含 `setupStatus`）
- `POST /api/auth/register` · `PUT /api/auth/profile` · `PUT /api/auth/change-password`

## 群组

- `GET /api/groups` · `POST /api/groups`（创建 Web 会话）
- `PATCH /api/groups/:jid`（重命名） · `DELETE /api/groups/:jid`
- `POST /api/groups/:jid/reset-session`（重建工作区）
- `GET /api/groups/:jid/messages`（分页 + 轮询，支持多 JID 查询）
- `POST /api/messages`（向工作区发送消息；首字符 `/clear` 触发会话重置，返回 `{ success: true, cleared: true }`）
- `GET|PUT /api/groups/:jid/env`（群组级容器环境变量）

## 文件

- `GET /api/groups/:jid/files` · `POST /api/groups/:jid/files`（上传，50MB 限制）
- `GET /api/groups/:jid/files/download/:path` · `DELETE /api/groups/:jid/files/:path`
- `POST /api/groups/:jid/directories`

## 记忆

- `GET /api/memory/sources` · `GET /api/memory/search`（全文检索）
- `GET|PUT /api/memory/file`

## 知识库

路由文件 `src/routes/paas-knowledge-bases.ts`，挂载于 `/api/paas/knowledge-bases`（`src/web.ts:336`）。

流水线：文档先解析 → 按策略切分成**携带原文绝对字符偏移**的分块 → 逐块向量化；检索在**分块粒度**做（向量臂 + 关键词臂 RRF 融合）。不变式 `text.slice(chunk.start_at, chunk.end_at) === chunk.content`，这是引用能回源核验的前提。

- `GET|POST /` · `GET|PATCH|DELETE /:id` — 知识库 CRUD。知识库有 `type`：`document`（默认）| `faq`；FAQ 库额外回显 `faqConfig`，普通库该字段为 `null`。两种库都回显 `questionGenerationConfig`（Doc2Query，默认 `{enabled:false, questionCount:3, customInstructions:''}`）；创建/更新用 snake_case `question_generation_config: {enabled, question_count, custom_instructions}`，**PATCH 是部分更新**（只传 `enabled` 不会把 `question_count` 打回默认）
- `POST /:id/chunker/preview` — 用给定分块配置预演切分，不落库
- `GET|POST /:id/documents` — 文档列表 / 上传（multipart，单文件 ≤100MB；可选表单字段 `strategy` / `chunk_size` / `chunk_overlap` / `parent_child`，省略则用默认 `heuristic` / 512 / 80 / 关）
- `POST /:id/documents/url` — 从 URL 抓取正文入库（15s 超时，1MB 文本上限）
- `GET /documents/:docId` — 单文档元数据（`parse_status` / `parse_stage` / `chunk_count` / `embedded_chunk_count` / `error_message` / `stages`）
- `GET /documents/:docId/content?start&end` — 按字符区间取原文（引用回源核验、分块编辑预览用）
- `GET /documents/:docId/chunks?full=1` — 分块列表，每块带 `start_at` / `end_at` / `heading_path` / `content_revision` / `generated_questions[]`（后者是 Doc2Query 的产出，**不属于**分块正文）
- `POST /documents/:docId/reparse` · `POST /documents/:docId/cancel` · `DELETE /:id/documents/:docId`
- `GET|PUT|DELETE /chunks/:chunkId` — 单块读写删（改内容后该块向量**与预生成问题**都失效并被清除，需重新嵌入 / 重新生成）
- `GET /chunks/:chunkId/revisions` · `POST /chunks/:chunkId/revert` — 修订历史与回滚
- `POST /:id/documents/:docId/embed` · `POST /:id/embed-all` · `POST /:id/rebuild-index` — 向量化与索引重建（`dimension_changed` 为真说明嵌入维度变了，全部文档需重新嵌入）
- `GET /:id/faq/entries` · `GET|PUT|DELETE /:id/faq/entries/:entryId` · `POST /:id/faq/entries` — **FAQ 条目**（仅 `type=faq` 的库；普通库返回 422）。字段用 snake_case：`standard_question` / `similar_questions[]` / `negative_questions[]` / `answers[]` / `answer_strategy` / `is_enabled`。批量删除走 `DELETE /:id/faq/entries`，body `{ids: [...]}`（≤20 条一次），只删属于本库的 id
- `POST /:id/generate-questions` — **Doc2Query**:对全部合格分块（`chunk_type=text`、启用、有可提取文字）预生成问题并编入向量索引。**同步**执行、逐块调用问答模型（`data/config/rag.json` 的 `model`，temperature 0.7 / max_tokens 512），分块多时耗时长。返回 `{eligible, generated, questions, skipped, stale}`：`skipped` 是单块调用失败被跳过的次数（不影响其余分块），`stale` 是生成期间正文被改动而丢弃结果的次数。未启用或没配模型 → **400** + `disabled: true`（不是错误，只是能力不可用）
- `POST /:id/search` — 三模式检索，body `{query, mode, limit, minScore, useRerank, debug}`，`mode` ∈ `hybrid`（默认）| `keyword` | `vector`；`debug: true` 返回 `mode` / `effective_mode` / `pool_size` / 各臂候选数 / `faq_negative_filtered` / `kb_buckets` 与 `timings_ms`
- `POST /search/all` — 跨当前用户全部知识库检索
- `POST /chat` — RAG 问答；stream 时走 SSE，`citations` 事件先于 `delta` 发出，末尾 `data: [DONE]`
- `GET /chat/sessions/:sessionId/messages` · `DELETE /chat/sessions/:sessionId`

**检索语义注意**：关键词臂是**子串/短语**语义（FTS5 `trigram` 分词器 + 词项 OR，`<3` 字符的词走 `instr()` 降级）。中文整句在纯 `keyword` 模式下不命中——它不是文档里的连续子串；默认的 `hybrid` 模式由向量臂覆盖这类查询。详见 [`docs/issues/2026-10-16-kb-chinese-keyword-search-dead.md`](issues/2026-10-16-kb-chinese-keyword-search-dead.md)。

**Doc2Query 语义注意**：预生成的问题**不进 `chunk.content`**，只是额外的一条向量索引条目（命中后按 `chunk_id` 归并回父分块），所以检索结果的 `content` 永远是分块正文、`start_at/end_at` 偏移不变式照常成立。与上游有一处有意偏离：**问题只进向量索引，不进关键词索引**，因此 `mode: 'keyword'` 召不回这些问法——这是取舍不是 bug，向量召回只增不减。另外生成的问题是**快照**：分块正文一旦被编辑（`content_revision` 自增），该块的预生成问题及其向量会被一并清除，需要重新生成。

**FAQ 检索语义注意**：FAQ 库**没有关键词索引**（与上游一致），只走向量臂——所以 `mode: 'keyword'` 对 FAQ 库**恒定返回 0 条**，这不是故障。机制是检索前按 KB 类型分桶、关键词臂只收文档桶（`debug.kb_buckets` 可观察）。另外负向问题是**检索后**按"忽略大小写与首尾空白的精确相等"否决，不是子串匹配：提问"RAG怎么安装？"不会被负例"RAG怎么安装"误杀。FAQ 分块的 `content` 是合成的问答文本，**不满足** `slice(start_at,end_at)===content` 这条偏移量不变式，引用回源请直接读 `content`。

## Agent PaaS（`/api/paas/*`）

知识库之外的 5 个 paas 路由族。它们与知识库同属 Agent PaaS（Phase 1–3），挂载点集中在 `src/web.ts:335-340`。

### Agent 定义

路由文件 `src/routes/paas-agents.ts`，挂载于 `/api/paas/agents`。**用户级** Agent 定义实体（DB-backed），与 `/api/agent-definitions`（管理 `~/.claude/agents/*.md` 全局文件）是两套东西，别混。整组要求登录。

- `GET /` · `GET /:id` · `POST /` · `PATCH /:id` · `DELETE /:id` — CRUD
- `POST /generate` — 按描述 AI 生成 Agent 定义
- `PATCH /:id/validation` — 配置结果校验策略（v58 开放平台）
- `GET /resources/available` — 当前用户可挂载的资源：`mcp_servers` / `knowledge_bases` / `skills`
- `POST /:id/mounts` · `DELETE /:id/mounts/:mountId` — 挂载资源
- `GET /:id/workers` · `PUT /:id/workers` — 查看 / 设置该 Agent 的 worker 列表
- `POST /:id/orchestrate` — 发起编排任务，**仅 `kind === 'orchestrator'` 的 Agent 可用**，body `{task, background?, acceptanceCriteria?, groupFolder?}`
- `GET /:id/versions` · `GET /:id/versions/:vid/diff` · `POST /:id/versions/:vid/restore` — 版本快照、对比与回滚
- `POST /:id/optimize` — 按反馈 AI 优化描述与 system_prompt，**只返回预览不落库**；`POST /:id/optimize/apply` 才写回（仅软字段）
- `POST /:id/share` · `GET /:id/shares` · `DELETE /:id/shares/:shareId` — 分享链接
- `GET /:id/collaborators` · `POST /:id/collaborators` · `DELETE /:id/collaborators/:userId` — 协作者
- `POST /:id/test-chat` — 测试对话

### 模板市场

路由文件 `src/routes/paas-marketplace.ts`，挂载于 `/api/paas/marketplace`。四种 `item_type`：`agent_template` / `mcp_template` / `skill_template` / `kb_template`；安装 = 把 payload 复制为用户私有实例。整组要求登录。

- `GET /?item_type=&status=` — 列表。**非 admin 恒为 `approved`**；admin 传 `?status=pending` 可看待审
- `GET /mine` — 我提交的
- `GET /:id` — 单条详情。**注意：不按 status 过滤**，拿到 id 即可读到 pending 条目
- `POST /`（admin）— 直接发布
- `POST /submit` — 用户提交，落库为 `pending` 待审
- `POST /:id/approve`（admin） · `POST /:id/reject`（admin） — 审核
- `POST /:id/reviews` · `GET /:id/reviews` — 评分与评论
- `POST /:id/install` — 安装模板
- `POST /reviews/:reviewId/report` — 举报评论

### PaaS 管理

路由文件 `src/routes/paas-admin.ts`，挂载于 `/api/paas/admin`。整组要求**登录 + admin**（`authMiddleware` + `adminRoleMiddleware`）。

- `GET /quotas` — 全部用户的 Agent 配额与用量
- `PUT /quotas/:userId` — 调整单个用户配额
- `GET /review-reports` — 待处理举报
- `POST /review-reports/:id/resolve` — 处理举报

### 嵌入模型配置

路由文件 `src/routes/paas-embedding.ts`，挂载于 `/api/paas/embedding-config`。整组要求登录。

- `GET /` — 读取嵌入配置
- `PUT /`（admin） — 写入嵌入配置（写入 `data/config/embedding.json`，知识库向量化用）
- `POST /test`（admin） — 连通性自检

### 分享链接

路由文件 `src/routes/paas-share.ts`，挂载于 `/api/paas/share`。

- `GET /:token` — **公开，无需认证**（分享页展示用，prompt 预览截断至 200 字符）
- `POST /:token/install` — 需要登录，安装该分享的 Agent

## 配置

- `GET|PUT /api/config/claude` · `PUT /api/config/claude/secrets`
- `GET|PUT /api/config/claude/custom-env`
- `POST /api/config/claude/test`（连通性测试） · `POST /api/config/claude/apply`（应用到所有容器）
- `GET|PUT /api/config/feishu`（**deprecated**，使用 `/api/config/user-im/feishu` 代替）
- `GET|PUT /api/config/telegram` · `POST /api/config/telegram/test`（**deprecated**，使用 `/api/config/user-im/telegram` 代替）
- `GET|PUT /api/config/appearance` · `GET /api/config/appearance/public`（外观配置，public 端点无需认证）
- `GET|PUT /api/config/system` — 系统运行参数（容器超时、并发限制、`autoCompactWindow` 等），需要 `manage_system_config` 权限
- `GET|PUT /api/config/web-search` — 联网搜索后端（智谱 / Tavily / 博查 / Serper / Bing 抓取），GET 返回各后端凭据（`apiKey` 一律掩码为 `'<masked>'`）与 `providersMeta`，PUT 省略 `apiKey` 字段表示保留已存 key
- `POST /api/config/web-search/test` — 搜索后端连通性自检，接受 `{provider?, apiKey?, baseUrl?}` 覆盖（可测未保存的凭据），失败 400 / 无结果 200
- `GET /api/config/user-im/status`（所有渠道连接状态，含 QQ）
- `GET|PUT /api/config/user-im/feishu`（用户级飞书 IM 配置，GET 返回 `connected` 字段）
- `GET|PUT /api/config/user-im/telegram`（用户级 Telegram IM 配置，GET 返回 `connected`、`effectiveProxyUrl`、`proxySource`，PUT 支持 `proxyUrl`/`clearProxyUrl`）
- `POST /api/config/user-im/telegram/test`（Telegram Bot Token 连通性测试，使用 per-user proxyUrl）
- `GET|PUT /api/config/user-im/qq`（用户级 QQ IM 配置，GET 返回 `connected` 字段）
- `POST /api/config/user-im/qq/test`（QQ 凭据连通性测试）
- `POST /api/config/user-im/qq/pairing-code`（生成 QQ 配对码）
- `GET /api/config/user-im/qq/paired-chats`（已配对的 QQ 聊天列表）
- `DELETE /api/config/user-im/qq/paired-chats/:jid`（移除 QQ 配对）
- `GET|PUT /api/config/user-im/dingtalk`（用户级钉钉 IM 配置，GET 返回 `connected` 字段）

## 任务

- `GET /api/tasks` · `POST /api/tasks` · `PATCH /api/tasks/:id` · `DELETE /api/tasks/:id`
- `GET /api/tasks/:id/logs`

## 管理

- `GET /api/admin/users` · `POST /api/admin/users` · `PATCH /api/admin/users/:id`
- `DELETE /api/admin/users/:id` · `POST /api/admin/users/:id/restore`
- `POST /api/admin/invites` · `GET /api/admin/invites` · `DELETE /api/admin/invites/:code`
- `GET /api/admin/audit-log`
- `GET|PUT /api/admin/settings/registration`

## Sub-Agent

- `GET /api/groups/:jid/agents` · `POST /api/groups/:jid/agents`（创建 Sub-Agent）
- `DELETE /api/groups/:jid/agents/:agentId`

## 目录浏览

- `GET /api/browse/directories`（列出可选目录，受挂载白名单约束）
- `POST /api/browse/directories`（创建自定义工作目录）

## MCP Servers

- `GET /api/mcp-servers` · `POST /api/mcp-servers`（CRUD，per-user）
- `PATCH /api/mcp-servers/:id` · `DELETE /api/mcp-servers/:id`
- `POST /api/mcp-servers/sync-host`（从宿主机同步 MCP Server 配置）

## Claude Code Plugins

数据模型：admin 共享导入的 catalog（immutable，按内容 hash 寻址） + per-user enable refs + per-user versioned runtime snapshot。详见 `docs/claude-code-plugin-automation-design.md` 与 `CLAUDE.md` §10。

| Method | Path | Auth | 用途 |
|--------|------|------|------|
| `GET` | `/api/plugins` | 登录 | 返回 catalog 全集 + 当前用户 enabled 状态投影（一次取齐前端列表所需数据） |
| `GET` | `/api/plugins/catalog` | 登录 | catalog 索引（`marketplaces[].plugins[].versions[]` 元数据） |
| `GET` | `/api/plugins/catalog/marketplaces/:mp` | 登录 | 单个 marketplace 详情 |
| `POST` | `/api/plugins/catalog/scan` | admin (`manage_system_config`) | 触发宿主机 `~/.claude/plugins/marketplaces/` 扫描并入 catalog；返回 `ImportReport`（`marketplaces` / `plugins` / `created` / `skipped`）。主进程启动 5s 后 + 每小时自动调用同一逻辑 |
| `PATCH` | `/api/plugins/enabled/:fullId` | 登录 | body `{ enabled: boolean }`，read-modify-write `users/{userId}/plugins.json`；启用时自动 `materializeUserRuntime` 写入 `runtime/{userId}/snapshots/{snapshotId}/`；UI 必须提示"下次新会话生效" |
| `POST` | `/api/plugins/materialize` | 登录 | 手动重建当前用户的 runtime snapshot（用于 catalog 更新后强制刷新） |
| `DELETE` | `/api/plugins/marketplaces/:name` | 登录 | **NOT a catalog deletion** — 仅清理调用者自己的 `enabled.*@{name}` 引用，共享只读 catalog 不动（admin 共享导入、按内容 hash 寻址） |

**已废弃**（PR1 删除，新代码不要引用）：~~`POST /api/plugins/sync-host`~~、~~`GET /api/plugins/available-on-host`~~。

## 用量统计

- `GET /api/usage/stats?days=7&userId=&model=`（从 `usage_daily_summary` 查询，支持用户/模型筛选）
- `GET /api/usage/models`（去重模型列表）
- `GET /api/usage/users`（有用量数据的用户列表，admin 可见全部）

## 监控

- `GET /api/status` · `GET /api/health`（无需认证）

## WebSocket

- `/ws`（协议详见下方）

### 服务端 → 客户端（`WsMessageOut`）

| 类型 | 用途 |
|------|------|
| `new_message` | 新消息到达（含 `chatJid`、`message`、`is_from_me`） |
| `agent_reply` | Agent 最终回复（含 `chatJid`、`text`、`timestamp`） |
| `typing` | Agent 正在输入指示 |
| `status_update` | 系统状态变更（活跃容器数、宿主机进程数、队列长度） |
| `stream_event` | 流式事件（含 `chatJid`、`StreamEvent`） |
| `agent_status` | Sub-Agent 状态变更（含 `chatJid`、`agentId`、`status`） |
| `terminal_output` | 终端输出数据 |
| `terminal_started` | 终端会话已启动 |
| `terminal_stopped` | 终端会话已停止 |
| `terminal_error` | 终端错误 |
| `docker_build_log` | Docker 镜像构建日志 |
| `docker_build_complete` | Docker 镜像构建完成 |

### 客户端 → 服务端（`WsMessageIn`）

| 类型 | 用途 |
|------|------|
| `send_message` | 发送消息（含 `chatJid`、`content`，支持 `attachments` 和 `agentId`） |
| `terminal_start` | 启动终端会话 |
| `terminal_input` | 终端输入数据 |
| `terminal_resize` | 终端窗口大小调整 |
| `terminal_stop` | 停止终端会话 |
