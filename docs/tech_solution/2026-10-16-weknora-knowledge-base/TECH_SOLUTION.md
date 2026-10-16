# 技术方案 — DeepThink 知识库子系统（WeKnora 内核复刻）

- **日期**：2026-10-16
- **对应 PRD**：`docs/prd/2026-10-16-weknora-knowledge-base/PRD.md`
- **参考实现**：`~/WeKnora` (`internal/infrastructure/chunker/`, `internal/application/service/knowledgebase_search_fusion.go`)

---

## 1. 设计原则

1. **加性扩展，不推翻重来**。现有 `knowledge_bases` / `kb_documents` / `kb_documents_fts` / `kb_documents_vec` / `kb_search` MCP 工具 / Web 页面与导航项全部保留并复用。新增一个 chunk 层，不删除既有文档级检索路径。
2. **对齐 WeKnora 的算法参数**，便于对照验收：`ChunkSize=512`、`ChunkOverlap=80`、RRF `k=60`、权重 `0.7/0.3`、过召回 `max(limit*5, 50)`。
3. **双后端对等**：SQLite（sqlite-vec）与 PostgreSQL（pgvector）行为一致，沿用 `sqlite-compat.ts` 单一后端选择点与 `sql-translator.ts` 方言翻译。
4. **优雅降级**：embedding 未配置 → 纯关键词；vec 扩展不可用 → 线性扫描；rerank 未配置 → 跳过。

## 2. 数据模型

### 2.1 新增表

```sql
-- 分块表（核心新增）
CREATE TABLE IF NOT EXISTS kb_chunks (
  id            TEXT PRIMARY KEY,
  kb_id         TEXT NOT NULL,
  doc_id        TEXT NOT NULL,
  user_id       TEXT NOT NULL,
  chunk_index   INTEGER NOT NULL,      -- 文档内序号，从 0 开始
  content       TEXT NOT NULL,
  content_hash  TEXT NOT NULL,         -- sha256(content)
  heading_path  TEXT,                  -- "A > B > C"，无标题时为 NULL
  start_at      INTEGER NOT NULL,      -- 原文起始字符偏移
  end_at        INTEGER NOT NULL,      -- 原文结束字符偏移（不含）
  pre_chunk_id  TEXT,                  -- 前驱 chunk
  next_chunk_id TEXT,                  -- 后继 chunk
  is_enabled    INTEGER NOT NULL DEFAULT 1,
  chunk_type    TEXT NOT NULL DEFAULT 'text',
  embedding     BLOB,                  -- Float32 原始字节，向量真相源
  embedding_model TEXT,
  created_at    TEXT NOT NULL,
  updated_at    TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_kb_chunks_doc ON kb_chunks(doc_id);
CREATE INDEX IF NOT EXISTS idx_kb_chunks_kb  ON kb_chunks(kb_id);

-- 分块修订历史
CREATE TABLE IF NOT EXISTS kb_chunk_revisions (
  id         TEXT PRIMARY KEY,
  chunk_id   TEXT NOT NULL,
  content    TEXT NOT NULL,
  reason     TEXT NOT NULL,            -- 'edit' | 'reparse'
  created_at TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_kb_chunk_rev ON kb_chunk_revisions(chunk_id);

-- 向量索引（sqlite-vec），维度运行时决定
CREATE VIRTUAL TABLE IF NOT EXISTS kb_chunks_vec USING vec0(
  chunk_id TEXT PRIMARY KEY,
  embedding FLOAT[<DIM>]
);

-- 文档级 FTS（分块检索用）
CREATE VIRTUAL TABLE IF NOT EXISTS kb_chunks_fts USING fts5(
  content, heading_path, content='kb_chunks', content_rowid='rowid'
);
```

### 2.2 `kb_documents` 扩展列

```sql
ALTER TABLE kb_documents ADD COLUMN parse_status   TEXT NOT NULL DEFAULT 'ready';
ALTER TABLE kb_documents ADD COLUMN parse_stage    TEXT;
ALTER TABLE kb_documents ADD COLUMN error_message  TEXT;
ALTER TABLE kb_documents ADD COLUMN chunk_count    INTEGER NOT NULL DEFAULT 0;
ALTER TABLE kb_documents ADD COLUMN parser_type    TEXT;          -- 修复：原只有类型声明
ALTER TABLE kb_documents ADD COLUMN embedding_dim  INTEGER;
ALTER TABLE kb_documents ADD COLUMN processed_at   TEXT;
ALTER TABLE kb_documents ADD COLUMN stages_json    TEXT;          -- 阶段耗时记录
```

> 新增列一律用既有 `ensureColumn(...)` 幂等助手，`SCHEMA_VERSION` 由 `'72'` 升至 `'73'`。
> 存量文档 `parse_status` 默认为 `'ready'` 以保持既有行为；用户可主动「重建索引」。

### 2.3 向量维度问题（修复现有硬编码）

现状 `kb_documents_vec` 建表即写死 `FLOAT[1536]`，而 `embedding.json` 允许 1–8192 维，维度不匹配时 `vec0` 写入会失败并被静默吞掉。

**方案**：启动时读取 embedding 配置的 `dimensions`，与 `router_state` 中记录的 `kb_vec_dim` 比对：
- 未记录 → 按当前维度建表，记录之
- 一致 → 直接使用
- 不一致 → **丢弃并重建** `kb_chunks_vec` / `kb_documents_vec`，记录新维度，置位「需要重建索引」标志

`kb_chunks.embedding`（BLOB）始终是**向量真相源**，`kb_chunks_vec` 仅为加速索引。索引不可用时线性扫描 `kb_chunks.embedding`，功能不降级，只降性能。这与既有 `vectorSearchKbDocumentsLinear` 的降级模式一致。

## 3. 分块引擎

新增独立模块 `src/kb/chunker.ts`（纯函数，无 IO，便于单测），对齐 WeKnora `internal/infrastructure/chunker/` 的三档策略。

### 3.1 接口

```ts
export interface ChunkConfig {
  strategy: 'heading' | 'heuristic' | 'recursive';
  chunkSize: number;    // 默认 512
  chunkOverlap: number; // 默认 80
}

export interface Chunk {
  index: number;
  content: string;
  headingPath: string | null;
  startAt: number;
  endAt: number;
}

export function chunkText(text: string, config?: Partial<ChunkConfig>): Chunk[];
export function recommendStrategy(text: string): ChunkConfig['strategy'];
```

### 3.2 策略

| 策略 | 行为 | 适用 |
|---|---|---|
| `heading` | 按 Markdown 标题（`#{1,6}`）切分，标题路径累积为 `headingPath`；单节超限时递归降级到 `heuristic` | 结构化文档 |
| `heuristic` | 按空行分段 → 段落超限则按句末标点（`.。！？!?;；\n`）切句 → 句子超限才硬切 | 通用默认 |
| `recursive` | 按分隔符优先级 `["\n\n", "\n", "。", ". ", " ", ""]` 递归二分 | 无结构长文 |

`recommendStrategy`：扫描前 20% 文本，Markdown 标题行 ≥ 3 条 → `heading`；否则 `heuristic`。

### 3.3 偏移正确性（关键）

所有策略产出的 `startAt`/`endAt` 均为**原文绝对字符偏移**，通过在切分时携带游标实现，不使用 `indexOf` 反查（后者在重复文本上会取错位置）。

**不变式**（单测强校验）：`chunks` 按 `startAt` 升序，且各区间并集覆盖 `[首个 startAt, 末个 endAt]`，相邻 chunk 的重叠量 ≤ `chunkOverlap`。

### 3.4 重叠

`chunkOverlap` 通过把上一个 chunk 的**尾部 N 字符**并入下一个 chunk 的起始实现，同时把下一个 chunk 的 `startAt` 相应前移，保证偏移仍指向原文真实位置。

## 4. 检索

### 4.1 三路检索

| 模式 | 实现 |
|---|---|
| `keyword` | `kb_chunks_fts` MATCH，bm25 排序；PG 走 `pg_trgm` similarity |
| `vector` | `kb_chunks_vec` KNN → pgvector HNSW → 线性扫描 |
| `hybrid` | 两路并行 → RRF 融合 |

### 4.2 RRF 融合（对齐 WeKnora `fuseWithRRF`）

```
score(c) = w_vec / (k + rank_vec(c)) + w_kw / (k + rank_kw(c))
```

参数：`k = 60`、`w_vec = 0.7`、`w_kw = 0.3`。仅单路命中时，另一路项为 0。

**与现有 `hybridSearchKbDocuments` 的差异**：现有实现用 min-max 归一化后加权求和（0.5/0.5），RRF 用**排名**而非分数，对分数尺度不敏感——BM25 分数无界、余弦有界，min-max 归一化会把单路噪声放大。切换为 RRF 是本次检索质量改进的关键点。现有函数保留不动（Agent 旧路径仍在用），新增 chunk 级路径。

### 4.3 过召回

```
candidates = min(max(limit * 5, 50), 500)
```

融合后按阈值过滤，再截断到 `limit`。

### 4.4 返回结构

```ts
interface ChunkSearchHit {
  chunkId: string;
  docId: string;
  kbId: string;
  filename: string;
  content: string;
  headingPath: string | null;
  startAt: number;
  endAt: number;
  score: number;          // 融合得分
  vectorScore: number | null;
  keywordScore: number | null;
  source: 'vector' | 'keyword' | 'hybrid';
}
```

### 4.5 重排

`src/kb/rerank.ts`。配置同 `embedding.json` 模式（`DATA_DIR/config/rerank.json`）。未配置时 `rerank()` 原样返回。支持 OpenAI 兼容的 `/rerank` 端点（Jina / Cohere / 硅基流动 等）。

## 5. 解析流水线

`src/kb/pipeline.ts`，进程内异步（不引入外部队列——DeepThink 是单机优先架构）。

```
pending → parsing → chunking → embedding → ready
                                    ↓
                                 failed
```

- 每个阶段用 `beginStage` / `endStage` / `failStage` 记录到 `stages_json` 与日志
- 失败写入 `parse_stage` + `error_message`，**不抛出到调用方**（上传接口立即 201 返回，流水线后台跑）
- chunk 写入为**事务**：先删旧 chunk 再插新 chunk，保证 reparse 不残留
- 单 chunk embedding 失败只标记该 chunk，不阻断整篇

## 6. RAG 问答与引用

`src/kb/rag.ts`。管线对齐 WeKnora `rag_stream`：

```
LOAD_HISTORY → CHUNK_SEARCH → CHUNK_MERGE → INTO_CHAT_MESSAGE → CHAT_COMPLETION_STREAM
```

- **引用来源**：检索命中的 chunk 直接构成 `knowledge_references`，含 `chunk_id` / `doc_id` / `start_at` / `end_at` / `content`
- **原文定位**：`GET /documents/:docId/content?start=&end=` 按偏移切原文，供引用「查看原文」
- **兜底**：检索结果为空 → 返回 `fallback_response` 文案，`knowledge_references` 为空数组
- **LLM 调用**：复用 DeepThink 既有 provider 配置（`src/provider-pool.ts`），不新建模型配置体系

## 7. 接口清单（新增/变更）

前缀 `/api/paas/knowledge-bases`，全部 `authMiddleware`。

| 方法 | 路径 | 说明 |
|---|---|---|
| POST | `/:id/chunker/preview` | 分块预览，不落库 |
| GET | `/:id/documents` | **变更**：返回 `parse_status` / `chunk_count` / `error_message` |
| GET | `/documents/:docId` | 文档详情（含阶段耗时） |
| POST | `/documents/:docId/reparse` | 重新解析 |
| POST | `/documents/:docId/cancel` | 取消解析 |
| GET | `/documents/:docId/content` | 按 `start`/`end` 取原文片段 |
| GET | `/documents/:docId/chunks` | 分块列表 |
| PUT | `/chunks/:chunkId` | 编辑分块 |
| DELETE | `/chunks/:chunkId` | 删除分块 |
| GET | `/chunks/:chunkId/revisions` | 修订历史 |
| POST | `/chunks/:chunkId/revert` | 回滚修订 |
| POST | `/:id/search` | **变更**：支持 `mode` / `kb_ids` / `top_k` / `debug`，返回 chunk 级结果 |
| POST | `/:id/rebuild-index` | 重建向量索引 |
| POST | `/chat` | RAG 问答（SSE 流式） |
| GET | `/chat/sessions` `/:sid/messages` | 会话与消息 |

> 既有 `POST /:id/documents`（上传）、`/:id/documents/url`、`/:id/embed-all` 路径与响应字段保持**向后兼容**，仅追加字段。

## 8. 前端

沿用 React 19 + Zustand + shadcn/radix + Tailwind v4。既有 `KnowledgeBasesPage.tsx` 与 `knowledge-bases.ts` store 扩展，不改导航结构（`/knowledge-bases` 已在 `nav-items.ts` 中）。

新增：
- `web/src/pages/KnowledgeBaseDetailPage.tsx` — 文档列表 + 分块 + 检索测试三 Tab
- `web/src/pages/KbChunkViewer.tsx` — 分块浏览/编辑
- `web/src/pages/KbSearchLab.tsx` — 检索测试台
- `web/src/pages/KbChatPage.tsx` — 问答 + 引用展开
- 路由挂在 `/knowledge-bases/:id`（新增，不破坏既有 `/knowledge-bases`）

状态轮询：文档 `parse_status` 非终态时，详情页按 2s 轮询直至终态，实现 AC-7.1 的「无需手动刷新」。

## 9. 测试策略

| 层 | 工具 | 覆盖 |
|---|---|---|
| 分块引擎 | Vitest | 偏移不变式、三策略、overlap、边界（空文本/单字符/超长段） |
| 检索 | Vitest | RRF 融合正确性、降级路径、跨库 |
| 流水线 | Vitest | 状态机迁移、失败记录、reparse 幂等 |
| 接口 | Vitest + fetch | 各端点契约 |
| UI | Playwright | 上传→索引→检索→问答全链路截图 |

**回归锚点**：TC-3.2 用 20000 字符文档在偏移 15000 处埋唯一串 `ZZMARKER9X`，检索必须命中——这是对原 `MAX_EMBED_TEXT_CHARS` 缺陷的直接回归测试。

## 10. 风险与取舍

| 取舍 | 决定 | 理由 |
|---|---|---|
| 是否引入外部任务队列（asynq 等价物） | **不引入** | DeepThink 单机优先，进程内异步 + 状态机足够；引入 Redis/BullMQ 会破坏开箱即用 |
| 是否保留文档级向量 | **保留** | 老数据与 Agent 旧路径依赖；chunk 级为新增优选路径，检索时优先用 chunk，无 chunk 则回落 |
| 中分块 vs 固定分块 | **策略可选，默认 heuristic** | 中文无空格，纯长度切分易在句中切断 |
| Rerank 是否进 v1 | **接口预留，非强制** | 依赖外部 rerank 服务，未配置时跳过，不阻塞主链路 |
