# Agent PaaS 平台 Phase 2 技术方案

**分支**：`feat/agent-paas-phase2`
**日期**：2026-07-15
**前置**：Phase 1 已合并（commit `bc9ae74`），DB schema v48

---

## 1. 架构总览

```
┌─────────────────────────────────────────────────────────────┐
│ Frontend (web/)                                              │
│  KnowledgeBasesPage  MarketplacePage  UsersPage  AgentStudio │
└─────────────────────────────────────────────────────────────┘
                              ↕ HTTP /api/paas/*
┌─────────────────────────────────────────────────────────────┐
│ Backend (src/)                                               │
│  routes/paas-knowledge-bases.ts  (PDF/DOCX/URL + 混合检索)  │
│  routes/paas-marketplace.ts       (审核 + 评论)              │
│  routes/paas-agents.ts            (版本管理)                 │
│  routes/paas-admin.ts             (配额管理 — 新文件)       │
│  document-parser.ts  embedding.ts  (新模块)                  │
└─────────────────────────────────────────────────────────────┘
                              ↕
┌─────────────────────────────────────────────────────────────┐
│ SQLite (data/db/messages.db)                                │
│  v49: kb_documents.embedding / marketplace_items.status     │
│       + marketplace_reviews + agent_definition_versions     │
└─────────────────────────────────────────────────────────────┘
```

---

## 2. DB Schema 变更（v48 → v49）

### 2.1 列变更

```sql
-- kb_documents：嵌入向量存储
ALTER TABLE kb_documents ADD COLUMN embedding BLOB;
ALTER TABLE kb_documents ADD COLUMN embedding_model TEXT;

-- marketplace_items：审核流
ALTER TABLE marketplace_items ADD COLUMN status TEXT NOT NULL DEFAULT 'approved';
ALTER TABLE marketplace_items ADD COLUMN submitted_by TEXT;
CREATE INDEX IF NOT EXISTS idx_marketplace_status ON marketplace_items(status);
```

### 2.2 新表

```sql
-- 评分评论
CREATE TABLE IF NOT EXISTS marketplace_reviews (
  id TEXT PRIMARY KEY,
  item_id TEXT NOT NULL,
  user_id TEXT NOT NULL,
  rating INTEGER NOT NULL,  -- 1-5
  comment TEXT,
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL,
  UNIQUE(item_id, user_id)
);
CREATE INDEX IF NOT EXISTS idx_reviews_item ON marketplace_reviews(item_id);

-- Agent 版本快照
CREATE TABLE IF NOT EXISTS agent_definition_versions (
  id TEXT PRIMARY KEY,
  agent_def_id TEXT NOT NULL,
  version INTEGER NOT NULL,
  snapshot_json TEXT NOT NULL,
  created_at TEXT NOT NULL,
  created_by TEXT,
  UNIQUE(agent_def_id, version),
  FOREIGN KEY (agent_def_id) REFERENCES agent_definitions(id) ON DELETE CASCADE
);
CREATE INDEX IF NOT EXISTS idx_agent_versions_def ON agent_definition_versions(agent_def_id);
```

### 2.3 数据迁移

- 现有 `marketplace_items` 默认 `status='approved'`（种子模板立即可见）
- 现有 `kb_documents.embedding` 默认 NULL（按需嵌入）
- 不需要回填 — 向后兼容

---

## 3. 模块设计

### 3.1 `src/document-parser.ts`（新）

```ts
export async function parsePdf(buf: Buffer): Promise<string> {
  // 用 pdf-parse（纯 JS，无系统依赖）
  // 失败抛错；返回纯文本
}

export async function parseDocx(buf: Buffer): Promise<string> {
  // 用 mammoth.extractRawText({ buffer })
}

export async function fetchUrlContent(url: string): Promise<string> {
  // fetch + cheerio.load → 提取 article/main/body 文本
  // 15s 超时，1MB 文本上限
  // 仅 http/https，禁止 file/ftp
}

export function detectParser(filename: string, mimeType: string): 'pdf' | 'docx' | 'text' | 'markdown' | null
```

依赖：
- `pdf-parse`（~50KB）
- `mammoth`（前端已用，可共享）
- `cheerio`（~80KB）

### 3.2 `src/embedding.ts`（新）

```ts
export interface EmbeddingConfig {
  baseUrl: string;
  apiKey: string;
  model: string;        // 默认 "text-embedding-3-small"
  dimensions: number;   // 默认 1536
}

export function getEmbeddingConfig(): EmbeddingConfig | null {
  // 从 runtime-config.ts 读：data/config/embedding.json (AES-256-GCM 加密)
  // 未配置返回 null
}

export async function embedText(text: string): Promise<Float32Array | null> {
  // 调用 POST {baseUrl}/embeddings
  // body: { model, input }
  // resp: { data: [{ embedding: number[] }] }
  // 失败返回 null（不抛错，调用方决定 fallback）
}

export async function embedBatch(texts: string[]): Promise<(Float32Array | null)[]>

export function cosineSim(a: Float32Array, b: Float32Array): number {
  // 纯 JS 实现，线性扫描
  // 1536 维 × 1000 文档 ≈ 3M 次乘加，< 50ms
}

export function float32ToBuffer(arr: Float32Array): Buffer
export function bufferToFloat32(buf: Buffer): Float32Array
```

### 3.3 混合检索

```ts
// src/db.ts
export function hybridSearchKbDocuments(
  kbIds: string[],
  query: string,
  limit: number,
  queryEmbedding: Float32Array | null,
): Array<{ doc_id, kb_id, filename, snippet, rank, source: 'fts' | 'vector' | 'hybrid' }>

// 实现：
// 1. FTS5 top-N (limit * 2)
// 2. 向量 top-N (limit * 2) — 仅当 queryEmbedding != null
// 3. 归一化分数（min-max），加权 0.5/0.5 求和
// 4. 去重后按融合分数取 top-limit
```

### 3.4 文档上传流程（修改）

```ts
// paas-knowledge-bases.ts POST /:id/documents
async (c) => {
  const formData = await c.req.formData();
  const file = formData.get('file');
  // ...
  const parserType = detectParser(file.name, file.type);
  let content: string;
  if (parserType === 'pdf') content = await parsePdf(buf);
  else if (parserType === 'docx') content = await parseDocx(buf);
  else content = buf.toString('utf8');  // MD / TXT
  
  const result = addKbDocument(id, user.id, file.name, content);
  
  // 异步触发嵌入（不阻塞响应）
  triggerEmbeddingAsync(result.row.id, content).catch(err => 
    logger.error({ err, docId: result.row.id }, 'Embedding failed')
  );
  
  return c.json({ document: meta }, 201);
}
```

### 3.5 嵌入触发器

```ts
// embedding.ts
export async function triggerEmbeddingAsync(docId: string, content: string): Promise<void> {
  const config = getEmbeddingConfig();
  if (!config) return;  // 未配置，跳过
  
  const emb = await embedText(content.slice(0, 8000));  // 截断到 8K 字符避免 API 限制
  if (!emb) return;
  
  updateDocEmbedding(docId, emb, config.model);
}

export function updateDocEmbedding(docId: string, embedding: Float32Array, model: string): void {
  // db.prepare('UPDATE kb_documents SET embedding=?, embedding_model=? WHERE id=?').run(...)
}
```

### 3.6 kb_search MCP 工具升级

```ts
// mcp-tools.ts kb_search 改为调 hybridSearch
const result = await pollIpcResult(TASKS_DIR, {
  type: 'kb_search',
  requestId, groupFolder, kbIds: ctx.kbIds,
  query: args.query, limit,
  // 新增：是否启用向量检索由主进程决定（看是否配置 embedding）
}, 'kb_search_result', 15_000);  // 超时从 10s → 15s（向量检索更慢）
```

主进程 `handleKbSearch` 改为调 `hybridSearchKbDocuments`：
- 先尝试 `embedText(query)` 得到 queryEmbedding
- 若失败或未配置 → queryEmbedding=null → 仅 FTS5
- 若成功 → 混合检索

### 3.7 用户发布 + 审核

```ts
// paas-marketplace.ts

// 用户提交
paasMarketplaceRoute.post('/submit', async (c) => {
  const user = c.get('user');
  const body = await c.req.json();
  // 复用 MarketplaceItemCreateSchema 校验
  const row = createMarketplaceItem({
    item_type: body.item_type,
    name: body.name,
    description: body.description,
    author_name: body.author_name ?? user.username,
    tags: body.tags,
    payload: body.payload,
    status: 'pending',
    submitted_by: user.id,
  });
  return c.json({ item: serializeItem(row) }, 201);
});

// admin 审核
paasMarketplaceRoute.post('/:id/approve', adminRoleMiddleware, async (c) => {
  setMarketplaceItemStatus(id, 'approved');
});
paasMarketplaceRoute.post('/:id/reject', adminRoleMiddleware, async (c) => {
  setMarketplaceItemStatus(id, 'rejected');
});

// 列表过滤
paasMarketplaceRoute.get('/', (c) => {
  const status = c.get('user').role === 'admin' 
    ? (c.req.query('status') ?? 'approved')
    : 'approved';
  const rows = listMarketplaceItems(status);
  // ...
});
```

### 3.8 配额管理路由

新文件 `src/routes/paas-admin.ts`：

```ts
paasAdminRoute.get('/quotas', adminRoleMiddleware, (c) => {
  const rows = listUserAgentQuotas();  // SELECT u.id, u.username, u.agent_quota, COUNT(ad.id) as used
  return c.json({ quotas: rows });
});

paasAdminRoute.put('/quotas/:userId', adminRoleMiddleware, async (c) => {
  const { quota } = await c.req.json();
  if (quota < 0 || quota > 1000) return c.json({ error: 'invalid quota' }, 400);
  updateUserAgentQuota(userId, quota);
  return c.json({ success: true });
});
```

### 3.9 评分评论

```ts
// 新增路由
paasMarketplaceRoute.post('/:id/reviews', async (c) => {
  const user = c.get('user');
  const { rating, comment } = await c.req.json();
  // rating: 1-5 整数
  // UPSERT 到 marketplace_reviews
  const row = upsertReview(id, user.id, rating, comment);
  return c.json({ review: serializeReview(row) }, 201);
});

paasMarketplaceRoute.get('/:id/reviews', (c) => {
  const rows = listReviews(id);
  return c.json({ reviews: rows.map(serializeReview) });
});

// serializeItem 加字段
function serializeItem(row): MarketplaceItem {
  const stats = getReviewStats(row.id);  // AVG(rating), COUNT(*)
  return { ...base, rating_average: stats.avg, rating_count: stats.count };
}
```

### 3.10 Agent 版本管理

```ts
// db.ts
export function saveAgentVersionSnapshot(agentDefId: string, beforeUpdate: AgentDefinitionRow): void {
  // 计算下一个 version = MAX(version) + 1
  // snapshot_json = JSON.stringify({ system_prompt, model, engine, max_turns, temperature, mounts })
  // INSERT
  // 删除超过 20 的最旧版本
}

export function listAgentVersions(agentDefId: string): Array<{ id, version, created_at, created_by }>

export function getAgentVersionSnapshot(versionId: string): { snapshot } | null

export function restoreAgentVersion(agentDefId: string, versionId: string): void {
  // 读快照 → UPDATE agent_definitions SET ... → 触发新版本快照（保存"回滚前"状态）
}

// updateAgentDefinition 修改
export function updateAgentDefinition(id, userId, patch): AgentDefinitionRow | null {
  const existing = getAgentDefinition(id, userId);
  if (!existing) return null;
  saveAgentVersionSnapshot(id, existing);  // 先快照
  // ... 原有更新逻辑
}
```

```ts
// paas-agents.ts 新增路由
paasAgentsRoute.get('/:id/versions', (c) => {
  const rows = listAgentVersions(id);
  return c.json({ versions: rows });
});

paasAgentsRoute.post('/:id/versions/:vid/restore', (c) => {
  restoreAgentVersion(id, vid);
  return c.json({ success: true });
});
```

---

## 4. 前端改动

### 4.1 KnowledgeBasesPage

- 上传组件 accept 增加 `.pdf,.docx`
- 新增"从 URL 抓取"按钮：弹出输入框，POST `/documents/url`
- 文档列表显示 `embedding_status`（✓ 已嵌入 / ✗ 未嵌入 / 加载中）

### 4.2 MarketplacePage

- 模板卡显示 ★4.5 (12)
- 详情页加评论区（列出评论 + 提交表单）
- 新增"提交到市场"按钮（如果用户有 Agent / KB / MCP 可分享）

### 4.3 UsersPage

- 新增"Agent 配额"列
- admin 可点击编辑 → `PUT /admin/quotas/:userId`

### 4.4 AgentStudioPage

- 选中 Agent 后显示"版本历史"按钮，抽屉式展示
- 每行有"回滚到此版本"按钮

---

## 5. 测试策略

| 层 | 验证 |
|----|------|
| 类型 | 三端 `tsc --noEmit` 全绿 |
| 构建 | `make build` 通过 |
| 单元 | `make test`（Phase 1 测试不回归） |
| 代码 review | 关键不变量核对 |
| API curl | 后端启动后冒烟（如果可行） |

---

## 6. 回滚

- `git revert` Phase 2 合并提交
- DB schema v49 是加法式迁移，旧代码忽略新列
- 新表 `marketplace_reviews` / `agent_definition_versions` 保留不删，下次升级可继续

---

## 7. 已知限制

1. 向量检索线性扫描，> 1000 文档/KB 时禁用
2. 嵌入 API 用户自配（OpenAI 兼容），不内嵌
3. PDF 扫描版（无文字层）解析返回空字符串
4. URL 抓取不处理 JS 渲染的 SPA
5. 评分评论无举报机制
6. 版本历史只保留 20 版本，超出自动删最旧
