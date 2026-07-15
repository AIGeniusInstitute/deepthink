# Agent PaaS 平台 Phase 2 PRD

**需求编号**：agent-paas-phase2
**分支**：`feat/agent-paas-phase2`
**作者**：AI Coder
**日期**：2026-07-15
**前置依赖**：Phase 1 已合并（commit `bc9ae74`）

---

## 1. 背景

Phase 1 已交付用户级 Agent 定义 + 知识库（仅 .md/.txt + FTS5）+ 市场浏览/安装。Phase 2 解决以下 Phase 1 遗留限制：

1. KB 文档类型受限于 .md/.txt
2. 无语义检索，仅关键词匹配
3. 市场仅 admin 发布，用户无法贡献
4. Agent 配额无管理入口
5. 市场无评分评论，质量信号缺失
6. Agent 改动覆盖式更新，无法回滚

---

## 2. 用户故事

### US-1：上传 PDF 知识库文档
作为知识工作者，我想把公司 PDF 手册上传到 KB，让 Agent 能基于手册内容回答问题。

### US-2：上传 DOCX 知识库文档
作为运营，我想把 Word 文档上传到 KB，省去手动转 Markdown 的环节。

### US-3：抓取 URL 内容入库
作为研究员，我想提交一个网页链接，系统自动抓取正文入库。

### US-4：语义检索 KB
作为知识工作者，我想用自然语言提问（而非关键词），系统返回语义相关的段落。

### US-5：用户发布模板到市场
作为有经验的用户，我想把自己调教好的 Agent / KB / MCP 配置发布到市场，供他人安装。

### US-6：管理员审核发布请求
作为管理员，我想看到所有待审核的发布请求，批准或拒绝。

### US-7：管理员调整用户 Agent 配额
作为管理员，我想把某付费用户的 Agent 配额从 10 调到 50。

### US-8：用户给市场模板打分评论
作为用户，我想给已安装的模板打分并写评论，帮助其他用户决策。

### US-9：Agent 版本回滚
作为 Agent 维护者，我想把 Agent 回滚到昨天修改前的版本。

---

## 3. 假设（Assumptions）

### A1：PDF/DOCX 解析后端
- PDF 用 `pdf-parse`（纯 JS，无系统依赖）
- DOCX 用 `mammoth`（已在依赖，前端 mammoth.browser 已用）
- 上传上限：单文件 10MB（Phase 1 是 5MB，PDF/DOCX 通常更大）
- 解析后存为纯文本（不保留格式），原 PDF/DOCX 文件不保留

### A2：URL 抓取
- 用户 POST `/api/paas/knowledge-bases/:id/documents/url` 携带 `url`
- 后端 `fetch(url)` + `cheerio` 解析 HTML，提取 `<article>` / `<main>` / `<body>` 文本
- 抓取超时 15s，最多 1MB 文本
- 同源策略：不限制（用户提交任意 URL，风险自负）
- 仅 HTTP/HTTPS，禁止 `file://` / `ftp://`

### A3：向量嵌入 API
- 用户在设置中配置 embedding provider：`base_url` + `api_key` + `model`（默认 `text-embedding-3-small`，1536 维）
- 后端调用 OpenAI 兼容 API：`POST {base_url}/embeddings` body `{ model, input }` → 返回 `{ data: [{ embedding: number[] }] }`
- 配置缺失时：`kb_search` 仅用 FTS5；`kb_documents_search_hybrid` 端点返回 `{"error":"embedding not configured"}` + 仅 FTS5 结果
- 嵌入缓存：BLOB 列 `kb_documents.embedding`（Float32Array, 1536*4 = 6144 字节/文档）

### A4：向量检索实现
- **不用 sqlite-vec**（需 native 扩展，better-sqlite3 不兼容）
- **不用 pgvector**（DeepThink 是 SQLite-only）
- MVP 方案：加载 KB 下所有文档的 embedding 到内存（Float32Array 数组），用纯 JS 计算余弦相似度，返回 top-K
- 性能预算：1000 文档 × 1536 维 = 6MB 内存，单次查询 < 50ms（向量点积是 SIMD 友好的纯循环）
- 1000 文档上限：单 KB 超过 1000 文档时禁用向量检索并提示用户

### A5：混合检索
- `kb_search` 工具同时跑 FTS5 + 向量，融合排序
- 融合策略：归一化 bm25 分数 + 归一化余弦相似度，加权（0.5 / 0.5）求和
- 嵌入未配置时仅用 FTS5（保持 Phase 1 行为）

### A6：用户发布 + 审核
- `marketplace_items` 新增列：`status`（draft/pending/approved/rejected）, `submitted_by`（user_id）
- 现有 admin 直接发布的模板 `status='approved'` 且 `submitted_by=NULL`
- 用户提交：`POST /api/paas/marketplace/submit`，状态 `pending`
- admin 审核：`POST /api/paas/marketplace/:id/approve` / `reject`
- 市场列表默认只展示 `status='approved'`；admin 可加 `?status=pending` 看待审

### A7：Agent 配额管理
- admin 路由 `GET /api/paas/admin/quotas` 列所有用户配额
- admin 路由 `PUT /api/paas/admin/quotas/:userId` 调整单用户配额
- 前端：在 `UsersPage` 加"配额"列，点击可编辑

### A8：评分评论
- 新表 `marketplace_reviews`：`id, item_id, user_id, rating (1-5), comment, created_at`
- 唯一约束 `UNIQUE(item_id, user_id)`：每用户对每模板只能评一次（可修改）
- 路由：`POST /api/paas/marketplace/:id/reviews`（创建/更新）、`GET /api/paas/marketplace/:id/reviews`（列表）
- MarketplaceItem 序列化新增 `rating_average`、`rating_count`

### A9：Agent 版本管理
- 新表 `agent_definition_versions`：`id, agent_def_id, version, snapshot_json, created_at, created_by`
- `version` 自增整数（per agent_def_id）
- `snapshot_json` 完整快照（system_prompt + model + engine + max_turns + temperature + mounts 列表）
- **触发时机**：每次 `PATCH /api/paas/agents/:id` 之前，把当前状态存为新版本
- 回滚：`POST /api/paas/agents/:id/versions/:vid/restore` → 把快照写回 agent_definitions 表
- 历史保留上限 20 版本/Agent，超出删最旧的

### A10：版本管理不覆盖 Phase 1 行为
- 不改 `createAgentDefinition` 流程
- 不改 `deleteAgentDefinition`（版本随 Agent 一起 CASCADE 删除）
- 仅 `updateAgentDefinition` 在写入前先快照

### A11：审核拒绝不删除
- admin reject 仅改 `status='rejected'`，保留记录
- 用户可看到自己的 rejected 模板，修改后重新提交（状态转回 pending）

### A12：评分评论不影响安装计数
- `installed_count` 仍只在 install 成功时 +1
- `rating_average` 是实时聚合（AVG(rating)）

---

## 3.5 非目标（Phase 2 不做）

- 多人协作编辑 Agent（Phase 3）
- Agent 分享链接（Phase 3）
- 嵌入模型微调
- 增量嵌入（文档修改时只重新 embed 改动部分）
- 向量索引（HNSW / IVF）— MVP 用线性扫描足够
- 评分举报 / 审核评论
- 版本 diff 视图

---

## 4. 功能需求

### 4.1 后端

#### 4.1.1 KB 文档扩展

- 修改 `src/routes/paas-knowledge-bases.ts`：
  - `MAX_DOC_BYTES` 5MB → 10MB
  - allowedTypes 增加 `application/pdf`、`application/vnd.openxmlformats-officedocument.wordprocessingml.document`
  - 新增 `POST /:id/documents/url`：body `{ url }`，后端 fetch + cheerio
- 新增 `src/document-parser.ts`：
  - `parsePdf(buf: Buffer): Promise<string>`
  - `parseDocx(buf: Buffer): Promise<string>`
  - `fetchUrl(url: string): Promise<string>`（15s 超时，1MB 上限，HTML → 纯文本）
- 文档 hash 计算改为基于解析后的纯文本（不是原文件），避免重复上传

#### 4.1.2 向量嵌入

- 新增 `src/embedding.ts`：
  - `getEmbeddingConfig(): { baseUrl, apiKey, model } | null`（从 runtime-config 读）
  - `embedText(text: string): Promise<Float32Array | null>`（调用 OpenAI 兼容 API，失败返回 null）
  - `embedBatch(texts: string[]): Promise<(Float32Array | null)[]>`
- DB schema v49：
  - `kb_documents` 加 `embedding BLOB`（可空，未嵌入时为 NULL）
  - `kb_documents` 加 `embedding_model TEXT`（可空，记录嵌入时用的模型，便于配置变更后重新嵌入）
- 修改 `addKbDocument`：插入后异步触发嵌入（不阻塞 API 响应）
- 新增 `POST /api/paas/knowledge-bases/:id/documents/:docId/embed`：手动重新嵌入单个文档
- 新增 `POST /api/paas/knowledge-bases/:id/embed-all`：批量嵌入 KB 下所有未嵌入文档

#### 4.1.3 混合检索

- 修改 `searchKbDocuments`：
  - 嵌入未配置或文档未嵌入 → 仅 FTS5（Phase 1 行为）
  - 嵌入已配置 → FTS5 top-N + 向量 top-N，融合排序
- 新增 `vectorSearchKbDocuments(kbIds, queryEmbedding: Float32Array, limit): Array<{doc_id, score, ...}>`
- 新增 `hybridSearchKbDocuments(kbIds, query, limit)`：组合 FTS5 + 向量

#### 4.1.4 用户发布 + 审核

- DB schema v49：`marketplace_items` 加 `status TEXT NOT NULL DEFAULT 'approved'`、`submitted_by TEXT`
- 新增路由 `POST /api/paas/marketplace/submit`：用户提交（status=pending）
- 新增路由 `POST /api/paas/marketplace/:id/approve` / `reject`：admin only
- 修改 `listMarketplaceItems`：默认只返回 `approved`，admin 可传 `?status=`
- 修改 `paasMarketplaceRoute.get('/')`：非 admin 强制 `status='approved'`

#### 4.1.5 配额管理

- 新增路由 `GET /api/paas/admin/quotas`：admin only，列所有用户 `{userId, username, quota, used}`
- 新增路由 `PUT /api/paas/admin/quotas/:userId`：admin only，body `{ quota }`

#### 4.1.6 评分评论

- DB schema v49：新表 `marketplace_reviews`
- 新增路由 `POST /api/paas/marketplace/:id/reviews`：创建或更新（唯一约束）
- 新增路由 `GET /api/paas/marketplace/:id/reviews`：列表（最新在前）
- 修改 `serializeItem`：加 `rating_average`、`rating_count`

#### 4.1.7 Agent 版本管理

- DB schema v49：新表 `agent_definition_versions`
- 修改 `updateAgentDefinition`：写入前先调用 `saveAgentVersionSnapshot`
- 新增路由 `GET /api/paas/agents/:id/versions`：列出版本
- 新增路由 `POST /api/paas/agents/:id/versions/:vid/restore`：回滚

### 4.2 前端

- `KnowledgeBasesPage`：上传组件接受 PDF/DOCX，新增"从 URL 抓取"按钮
- `MarketplacePage`：模板卡显示 `rating_average` + `rating_count`，详情页可看评论
- `MarketplacePage`：增加"提交到市场"入口（用户把自己的 Agent / KB / MCP 发布）
- `UsersPage`：增加配额列（admin 可编辑）
- `AgentStudioPage`：增加"版本历史"抽屉

---

## 5. 非功能需求

- 向量检索内存预算：< 100MB（按 1000 文档 × 6KB 估算）
- 文档解析超时：PDF/DOCX 单文件 30s
- URL 抓取超时：15s
- 嵌入 API 调用超时：30s
- 所有新增异步任务不阻塞 API 响应（嵌入、URL 抓取完成前先返回 201，状态通过文档列表查询）
- 向后兼容：未配置 embedding 时所有 Phase 1 行为不变

---

## 6. 验收标准

| # | 验收 | 触发方式 |
|---|------|---------|
| AC-1 | 上传 PDF → `documents` 表新增行，`content` 字段是纯文本 | POST /documents with PDF |
| AC-2 | 上传 DOCX → 同上 | POST /documents with DOCX |
| AC-3 | POST /documents/url → 后端 fetch 后入库 | curl |
| AC-4 | 配置 embedding 后，新上传文档 `embedding` 字段非 NULL | DB 查询 |
| AC-5 | `kb_search` 在文档已嵌入时返回混合排序结果 | MCP 工具调用 |
| AC-6 | `kb_search` 在未配置 embedding 时仅 FTS5，不报错 | MCP 工具调用 |
| AC-7 | 用户 POST /marketplace/submit → status=pending | curl |
| AC-8 | admin POST /:id/approve → status=approved，市场列表可见 | curl |
| AC-9 | admin POST /:id/reject → status=rejected，用户列表可见 | curl |
| AC-10 | admin PUT /admin/quotas/:userId → users.agent_quota 更新 | curl |
| AC-11 | 用户 POST /:id/reviews → marketplace_reviews 新行 | curl |
| AC-12 | GET /marketplace 返回的 item 含 rating_average + rating_count | curl |
| AC-13 | PATCH /agents/:id → agent_definition_versions 新增一行 | curl |
| AC-14 | POST /agents/:id/versions/:vid/restore → agent_definitions 回滚 | curl |
| AC-15 | 版本超过 20 时最旧的被删除 | DB 查询 |
| AC-16 | 未配置 embedding 时 Phase 1 行为完全不变 | 回归测试 |

---

## 7. 风险

| 风险 | 缓解 |
|------|------|
| 嵌入 API 用户未配置 → 向量检索功能不可用 | UI 提示 + fallback 到 FTS5 |
| PDF 解析失败（加密 / 扫描版无文字） | 返回 400 "无法提取文本" |
| 嵌入内存爆炸（用户上传 10000 文档） | 单 KB 文档超 1000 时禁用向量检索 |
| 用户发布恶意 MCP（窃取 token） | 审核 admin 把关；MCP 模板安装时明确警告 |
| 版本快照存储膨胀 | 20 版本上限 + 快照只存必要字段 |

---

## 8. 里程碑

- M1（PRD + tech solution）：本提交
- M2（KB 扩展：PDF/DOCX/URL + 嵌入 + 混合检索）
- M3（Marketplace：用户发布 + 审核 + 评分评论）
- M4（配额管理 + Agent 版本管理）
- M5（前端集成 + 三端 typecheck + make build）
- M6（测试报告 + 合并 main + push）

---

## 9. Phase 3 不做

- 多人协作
- Agent 分享链接
- 嵌入微调
- 向量索引（HNSW）
- 评分举报
- 版本 diff 视图
