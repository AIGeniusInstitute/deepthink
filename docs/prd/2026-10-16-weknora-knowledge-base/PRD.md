# PRD — DeepThink 知识库子系统（WeKnora 内核复刻）

- **版本**：v1.0
- **日期**：2026-10-16
- **对应意图**：`docs/intent/2026-10-16-weknora-knowledge-base/INTENT.md`
- **参考实现**：`~/WeKnora`（Tencent WeKnora v0.8.3）

---

## 1. 背景

DeepThink 现有知识库是一个约 1000 行的最小实现，核心能力为「整篇文档向量化 + FTS5 全文检索」。它存在一个**功能性缺陷**，而非性能问题：

`src/embedding.ts:23` 定义 `MAX_EMBED_TEXT_CHARS = 8000`，`embedText()` 在第 101 行执行 `text.slice(0, 8000)`。这意味着**超过 8000 字符的文档，只有前 8000 字符进入向量索引**，其余部分在向量检索路径上永久不可见（FTS5 路径仍覆盖全文，但中文场景下 FTS5 的 BM25 分词效果有限）。

WeKnora 作为成熟的企业级知识管理框架，通过**分块（chunking）+ chunk 级向量化 + 混合检索 + 重排 + 引用溯源**解决同一问题。本次复刻即以 WeKnora 的知识库内核为蓝本，补齐 DeepThink 的这块能力。

## 2. 目标与非目标

### 2.1 目标

为 DeepThink 交付一个**端到端可用**的知识库子系统：文档进去，答案出来，且答案可溯源。

### 2.2 非目标（明确排除，避免范围蔓延）

| 排除项 | 理由 |
|---|---|
| Agent / 沙箱 / 技能 / MCP 发布 | DeepThink 已具备（Agent Studio、5 引擎、sandbox、skills、mcp-registry） |
| IM 频道集成 | DeepThink 已有 8 个 IM 通道 |
| 多租户 RBAC / 审计日志 | DeepThink 已有 RBAC + `auth_audit_log` |
| Wiki 模式 / 知识图谱 | 非知识库内核，列为 v2 |
| 11 类数据源连接器 | 非知识库内核，列为 v3 |
| 多模态 / 图片向量 | 依赖多模态 embedding 模型，列为 v2 |
| 多种向量库（Qdrant/Milvus/ES…） | DeepThink 的可插拔状态层已定调 sqlite-vec / pgvector 两条路 |

## 3. 用户故事

| # | 角色 | 故事 |
|---|---|---|
| US-1 | 知识管理者 | 我要上传一份 80 页的产品手册 PDF，并确保**全文**都能被检索到 |
| US-2 | 知识管理者 | 我要看到文档被切成了哪些片段，并修正切分错误的片段 |
| US-3 | 知识管理者 | 我要知道文档解析到哪一步了、失败了为什么 |
| US-4 | 使用者 | 我用自然语言提问，得到答案，并能**点开引用看到原文片段** |
| US-5 | 知识管理者 | 我要能调试检索：输入查询，看召回了哪些片段、各自得分多少 |
| US-6 | Agent | 我要通过 MCP 工具检索知识库并读取文档全文 |

## 4. 功能需求

### FR-1 解析流水线

文档从上传到可检索是一段异步流水线，必须**可观测**。

**需求**
- FR-1.1 文档具有明确状态：`pending` → `parsing` → `chunking` → `embedding` → `ready` / `failed`
- FR-1.2 每个阶段记录开始/结束时间与耗时
- FR-1.3 `failed` 状态记录失败阶段与错误原因
- FR-1.4 支持重新解析（reparse），可携带新的分块配置
- FR-1.5 支持取消进行中的解析
- FR-1.6 支持扩展格式：在既有 `.md/.txt/.pdf/.docx` 基础上增加 `.html/.htm/.csv/.json/.xlsx/.pptx`

**验收标准**

| ID | 验收标准 |
|---|---|
| AC-1.1 | 上传 PDF 后，`GET /documents/:id` 在流水线各阶段返回对应 `parse_status` |
| AC-1.2 | 流水线结束后状态变为 `ready`，且 `chunk_count > 0` |
| AC-1.3 | 传入一个损坏的 PDF，状态变为 `failed` 且 `error_message` 非空、含失败阶段名 |
| AC-1.4 | 对 `ready` 文档调用 reparse，状态重新走完流水线，chunk 被整体替换（旧 chunk 不残留） |
| AC-1.5 | 上传 `.xlsx` 与 `.html` 能成功解析出非空文本 |

**测试用例**

| ID | 前置 | 步骤 | 预期 |
|---|---|---|---|
| TC-1.1 | 已建 KB | 上传 80 页 PDF | 201；轮询状态最终 `ready` |
| TC-1.2 | 已建 KB | 上传截断的 PDF（前 5 字节 `%PDF-` 后接随机字节） | 状态 `failed`，`error_message` 含 `parsing` |
| TC-1.3 | 有 ready 文档 | POST reparse | 旧 chunk 全删，新 chunk 生成，`chunk_count` 一致 |
| TC-1.4 | 已建 KB | 上传 `.html` 文件 | 解析出正文（不含 `<script>` 内容） |

---

### FR-2 分块引擎

**需求**
- FR-2.1 支持三种分块策略：`heading`（按标题层级）、`heuristic`（按段落/句子边界）、`recursive`（按分隔符递归）
- FR-2.2 可配置 `chunk_size`（默认 512）与 `chunk_overlap`（默认 80）
- FR-2.3 分块保留位置信息：`start_at` / `end_at`（字符偏移）、`chunk_index`
- FR-2.4 分块保留结构信息：`heading_path`（所属标题路径）
- FR-2.5 相邻 chunk 记录 `pre_chunk_id` / `next_chunk_id`
- FR-2.6 分块结果可预览（不落库）：`POST /chunker/preview`
- FR-2.7 分块可编辑（内容、启用状态）、可删除
- FR-2.8 分块编辑保留修订历史，可回滚

**验收标准**

| ID | 验收标准 |
|---|---|
| AC-2.1 | 一份 20000 字符的无标题长文，按 `heuristic` 切分，产出 chunk 数 ≥ 20（20000/512≈39，考虑 overlap 取整） |
| AC-2.2 | 所有 chunk 的 `start_at`/`end_at` 拼接可覆盖原文全部字符区间，无空洞 |
| AC-2.3 | `chunk_size=512` 时，无单个 chunk 超过 `512 * 1.5` 字符（软上限，段落过长时才可溢出） |
| AC-2.4 | 带 Markdown 标题的文档按 `heading` 切分，每个 chunk 的 `heading_path` 非空 |
| AC-2.5 | 预览接口不产生任何数据库写入 |
| AC-2.6 | 编辑 chunk 内容后，修订历史多一条记录，可 revert 回原内容 |

**测试用例**

| ID | 前置 | 步骤 | 预期 |
|---|---|---|---|
| TC-2.1 | — | 生成 20000 字符长文，调 chunker | chunk 数 ≥ 20 |
| TC-2.2 | — | 对 TC-2.1 结果校验偏移 | 区间并集 == [0, len) |
| TC-2.3 | — | 传入 `# A\n\npara\n\n## B\n\npara2` | 产出 2 个 chunk，`heading_path` 分别为 `A`、`A > B` |
| TC-2.4 | 有 chunk | `PUT /chunks/:id` 改内容 | `GET /chunks/:id/revisions` 返回 2 条 |

---

### FR-3 向量化（chunk 级）

**需求**
- FR-3.1 向量化对象从「整篇文档」改为「每个 chunk」
- FR-3.2 向量维度自适应 `embedding.json` 的 `dimensions`，不得硬编码
- FR-3.3 支持批量 embedding，失败可重试
- FR-3.4 记录每个 chunk 的 `embedding_model`，模型变更时可识别需重嵌入的 chunk
- FR-3.5 未配置 embedding 时，全链路降级为纯关键词检索，不报错

**验收标准**

| ID | 验收标准 |
|---|---|
| AC-3.1 | 一份 20000 字符文档，`ready` 后**每个** chunk 都有向量（`embedded_count == chunk_count`） |
| AC-3.2 | 把 `dimensions` 配成 1024 并重建，向量写入成功（当前实现在此处必然失败） |
| AC-3.3 | 对文档执行「这篇手册讲了什么」类查询，能召回位于文档**后半部分**（字符偏移 > 8000）的 chunk |
| AC-3.4 | 未配置 embedding 时，上传文档仍成功，检索走 FTS 返回结果 |

**测试用例**

| ID | 前置 | 步骤 | 预期 |
|---|---|---|---|
| TC-3.1 | 配置好 embedding | 上传 20000 字符文档 | `embedded_count == chunk_count` |
| TC-3.2 | **复现原缺陷** | 上传 20000 字符文档，在第 15000 字符处埋入唯一串 `ZZMARKER9X`，检索 `ZZMARKER9X` | **该 chunk 出现在结果中**（旧实现此处失败） |
| TC-3.3 | 清空 embedding 配置 | 上传文档 + 检索 | 上传 201，检索有结果 |

---

### FR-4 混合检索

**需求**
- FR-4.1 向量检索与关键词检索**并行执行**，结果用 RRF（Reciprocal Rank Fusion）融合
- FR-4.2 RRF 参数可配：`k`（默认 60）、向量权重（默认 0.7）、关键词权重（默认 0.3）
- FR-4.3 过召回：先取 `max(limit*5, 50)` 候选，融合后再截断到 `limit`
- FR-4.4 支持相似度阈值过滤
- FR-4.5 支持可选重排（rerank），未配置时跳过
- FR-4.6 检索结果返回：chunk 内容、所属文档、`start_at`/`end_at`、各路原始得分、融合得分、命中来源（`vector`/`keyword`/`hybrid`）
- FR-4.7 **通过 HTTP 暴露**（当前仅 Agent 可用）
- FR-4.8 支持跨多知识库检索

**验收标准**

| ID | 验收标准 |
|---|---|
| AC-4.1 | `POST /api/paas/knowledge-bases/:id/search` 返回 `sources` 字段标注命中来源 |
| AC-4.2 | 配置 embedding 后，同一查询的 `mode=hybrid` 结果集 ⊇ `mode=keyword` 与 `mode=vector` 各自 Top-1 |
| AC-4.3 | 传入 `kb_ids: [a, b]` 能同时召回两个库的 chunk |
| AC-4.4 | 未配置 embedding 时，`mode=hybrid` 自动降级为关键词，不报错 |

**测试用例**

| ID | 前置 | 步骤 | 预期 |
|---|---|---|---|
| TC-4.1 | 有已索引 KB | 混合检索 | 每条结果含 `sources` / `vector_score` / `keyword_score` / `score` |
| TC-4.2 | 两个 KB 各有文档 | 跨库检索 | 结果中两个 kb_id 都出现 |
| TC-4.3 | 无 embedding 配置 | 混合检索 | 200，结果 `sources` 全为 `keyword` |

---

### FR-5 检索测试台

**需求**
- FR-5.1 输入 query，返回完整召回过程：候选数、融合前后排名、各阶段耗时
- FR-5.2 可临时覆盖检索参数（top_k / 权重 / 阈值）而不改变 KB 配置
- FR-5.3 返回的每条结果可展开查看完整 chunk 内容

**验收标准**

| ID | 验收标准 |
|---|---|
| AC-5.1 | 响应含 `debug` 字段，包含 `vector_candidates` / `keyword_candidates` / `fused` / `timings_ms` |
| AC-5.2 | 覆盖参数只影响本次请求，KB 配置不变 |

**测试用例**

| ID | 步骤 | 预期 |
|---|---|---|
| TC-5.1 | 检索测试台请求 | `debug.timings_ms` 各阶段 > 0；`debug.fused` 为数组 |
| TC-5.2 | 同一 query 传不同 `top_k` | 返回条数不同；再查 KB 配置未被修改 |

---

### FR-6 RAG 问答与引用溯源

**需求**
- FR-6.1 提供问答会话（session），多轮对话保留历史
- FR-6.2 流程：改写查询 → 混合检索 → 重排 → 合并上下文 → 组装 Prompt → 流式生成
- FR-6.3 **答案携带引用**，引用指向具体 chunk（含 `chunk_id` / `doc_id` / `start_at` / `end_at` / 原文片段）
- FR-6.4 无检索结果时走兜底回复，不产生幻觉
- FR-6.5 流式输出（SSE）

**验收标准**

| ID | 验收标准 |
|---|---|
| AC-6.1 | 提问后返回的 message 上 `knowledge_references` 非空，每项含 `chunk_id` 与 `content` 片段 |
| AC-6.2 | `chunk_id` 可反查回原文，`start_at`/`end_at` 定位的原文 == chunk 内容 |
| AC-6.3 | 问一个知识库完全不相关的问题，返回兜底文案而非编造 |
| AC-6.4 | 流式接口逐块输出，最终消息落库 |

**测试用例**

| ID | 前置 | 步骤 | 预期 |
|---|---|---|---|
| TC-6.1 | KB 内有「年假 15 天」的文档 | 问「年假多少天」 | 答案含 15；`knowledge_references` 非空 |
| TC-6.2 | — | 取 TC-6.1 的引用，用其 `start_at`/`end_at` 切原文 | 切出内容 == 引用 `content` |
| TC-6.3 | — | 问「今天股票行情如何」 | 返回兜底文案，`knowledge_references` 为空 |

---

### FR-7 Web UI

**需求**
- FR-7.1 知识库列表页（已有，需扩展展示 chunk 数 / 索引状态）
- FR-7.2 知识库详情页：文档列表（含状态徽标 / 失败原因 / 重新解析操作）
- FR-7.3 文档详情：分块列表，支持查看 / 编辑 / 删除
- FR-7.4 检索测试台页面
- FR-7.5 问答页面，答案引用可点击展开原文

**验收标准**

| ID | 验收标准 |
|---|---|
| AC-7.1 | 上传文档后，UI 状态徽标从「解析中」自动变为「就绪」，无需手动刷新 |
| AC-7.2 | 失败文档显示失败原因与「重新解析」按钮 |
| AC-7.3 | 分块列表展示每块的序号、字符区间、内容摘要 |
| AC-7.4 | 问答页答案中的引用可点击展开原文片段 |
| AC-7.5 | 全部页面在 1280×800 视口下无横向滚动溢出 |

**测试用例**：见 `docs/test_report` 的 UI 测试章节（Playwright 截图）

---

### FR-8 Agent 集成（MCP 工具）

**需求**
- FR-8.1 `kb_search` 升级为 chunk 级检索，返回引用信息
- FR-8.2 新增 `read_document`：按 ID 读取文档全文
- FR-8.3 新增 `list_documents`：列出知识库内文档
- FR-8.4 工具仅在 Agent 挂载了知识库时可用

**验收标准**

| ID | 验收标准 |
|---|---|
| AC-8.1 | `kb_search` 返回结果含 `chunk_id` / `doc_id` / `content` / `score` |
| AC-8.2 | `read_document` 传入非法 ID 返回错误而非崩溃 |
| AC-8.3 | 未挂载 KB 的 Agent 调用 `kb_search` 返回「未挂载」提示 |

---

## 5. 非功能需求

| ID | 需求 |
|---|---|
| NFR-1 | 同时兼容 SQLite（sqlite-vec）与 PostgreSQL（pgvector）两种后端 |
| NFR-2 | 数据库迁移幂等，`SCHEMA_VERSION` 递增，旧库升级不丢数据 |
| NFR-3 | 现有 `kb_documents` / `knowledge_bases` 表数据在升级后**不丢失**，旧文档可重新分块索引 |
| NFR-4 | embedding 未配置时全链路可降级运行 |
| NFR-5 | 单个 chunk embedding 失败不阻断整篇文档，记录失败并可重试 |

## 6. 风险

| 风险 | 影响 | 缓解 |
|---|---|---|
| 现有 KB 数据无 chunk，升级后检索路径变化 | 老数据检索失败 | 提供「重建索引」操作；检索时对无 chunk 文档回落到旧的文档级检索 |
| 1536 维硬编码的 vec0 表已存在 | 换模型后索引不可用 | 迁移时按配置维度重建，向量表加维度指纹校验 |
| 中文分块效果 | 检索质量 | 采用标题优先 + 段落边界优先策略，避免在句中切断 |
| 无 Python 解析服务 | 格式覆盖不如 WeKnora | 复用 Node 生态解析库，明确记录格式覆盖差异 |

## 7. 里程碑

| 阶段 | 交付 |
|---|---|
| M1 | 数据模型 + 迁移 + 分块引擎 |
| M2 | 解析流水线 + chunk 级向量化 |
| M3 | 混合检索 + 检索测试台 |
| M4 | RAG 问答 + 引用溯源 |
| M5 | Web UI |
| M6 | 测试 + 报告 + 合并 |
