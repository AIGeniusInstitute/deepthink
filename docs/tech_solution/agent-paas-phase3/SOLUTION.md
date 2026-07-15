# Agent PaaS Phase 3 — 技术方案

## 1. 架构

```
┌────────────────────────────────────────────┐
│ Frontend (React)                          │
│  - SettingsPage.EmbeddingSettingsSection   │
│  - AgentStudioPage (share/collab/diff)    │
│  - MarketplacePage (review report)        │
│  - UsersPage (review reports tab)         │
│  - /share/:token (SharePage)              │
└──────────────┬─────────────────────────────┘
               │
┌──────────────▼─────────────────────────────┐
│ Backend (Hono)                             │
│  - /api/paas/agents (share/collab/diff)    │
│  - /api/paas/embedding-config             │
│  - /api/paas/share/:token (public)         │
│  - /api/paas/marketplace/reviews/:id/report│
│  - /api/paas/admin/review-reports         │
└──────────────┬─────────────────────────────┘
               │
┌──────────────▼─────────────────────────────┐
│ SQLite (WAL) + sqlite-vec extension        │
│  - kb_documents_vec (vec0 virtual table)   │
│  - agent_shares                            │
│  - agent_collaborators                     │
│  - marketplace_review_reports              │
└────────────────────────────────────────────┘
```

## 2. DB Schema v49 → v50

### 2.1 新表

```sql
-- sqlite-vec 向量索引（虚拟表，仅在扩展加载成功时创建）
CREATE VIRTUAL TABLE IF NOT EXISTS kb_documents_vec USING vec0(
  doc_id TEXT PRIMARY KEY,
  embedding FLOAT[1536]
);

-- Agent 分享
CREATE TABLE IF NOT EXISTS agent_shares (
  id TEXT PRIMARY KEY,
  agent_def_id TEXT NOT NULL,
  share_token TEXT NOT NULL UNIQUE,
  created_by TEXT NOT NULL,
  created_at TEXT NOT NULL DEFAULT (datetime('now')),
  expires_at TEXT,
  install_count INTEGER NOT NULL DEFAULT 0,
  FOREIGN KEY (agent_def_id) REFERENCES agent_definitions(id) ON DELETE CASCADE
);
CREATE INDEX IF NOT EXISTS idx_agent_shares_def ON agent_shares(agent_def_id);

-- Agent 协作者
CREATE TABLE IF NOT EXISTS agent_collaborators (
  agent_def_id TEXT NOT NULL,
  user_id TEXT NOT NULL,
  role TEXT NOT NULL DEFAULT 'viewer',  -- 'editor' | 'viewer'
  added_by TEXT NOT NULL,
  added_at TEXT NOT NULL DEFAULT (datetime('now')),
  PRIMARY KEY (agent_def_id, user_id),
  FOREIGN KEY (agent_def_id) REFERENCES agent_definitions(id) ON DELETE CASCADE
);

-- 评论举报
CREATE TABLE IF NOT EXISTS marketplace_review_reports (
  id TEXT PRIMARY KEY,
  review_id TEXT NOT NULL,
  reporter_id TEXT NOT NULL,
  reason TEXT NOT NULL,
  status TEXT NOT NULL DEFAULT 'pending',  -- 'pending' | 'dismissed' | 'resolved'
  created_at TEXT NOT NULL DEFAULT (datetime('now')),
  handled_by TEXT,
  handled_at TEXT,
  UNIQUE(review_id, reporter_id),
  FOREIGN KEY (review_id) REFERENCES marketplace_reviews(id) ON DELETE CASCADE
);
CREATE INDEX IF NOT EXISTS idx_review_reports_status ON marketplace_review_reports(status);
```

### 2.2 扩展加载

```ts
// src/db.ts
let vecExtensionLoaded = false;
try {
  const sqliteVec = await import('sqlite-vec');
  sqliteVec.load(db);
  vecExtensionLoaded = true;
  logger.info('sqlite-vec extension loaded — vector index enabled');
} catch (err) {
  logger.warn({ err }, 'sqlite-vec extension load failed — falling back to linear scan');
}
```

`kb_documents_vec` 表只在 `vecExtensionLoaded === true` 时创建。

### 2.3 向量检索 dispatch

```ts
export function vectorSearchKbDocuments(kbIds, queryEmbedding, limit) {
  if (vecExtensionLoaded) return vectorSearchViaVec(kbIds, queryEmbedding, limit);
  return vectorSearchKbDocumentsLinear(kbIds, queryEmbedding, limit);  // Phase 2 实现
}

async function vectorSearchViaVec(kbIds, queryEmb, limit) {
  const buf = float32ToBufferInDb(queryEmb);
  const placeholders = kbIds.map(() => '?').join(',');
  // sqlite-vec MATCH 返回所有，再 JOIN kb_documents 过滤 kb_id
  const rows = db.prepare(`
    SELECT v.doc_id, v.distance, d.kb_id, d.filename, d.content
    FROM kb_documents_vec v
    JOIN kb_documents d ON d.id = v.doc_id
    WHERE v.embedding MATCH ? AND d.kb_id IN (${placeholders})
    ORDER BY v.distance
    LIMIT ?
  `).all(buf, ...kbIds, limit);
  // distance 越小越相似，转换为 score = 1 - distance (余弦距离 0=完全相同, 2=完全相反)
  return rows.map(r => ({
    doc_id: r.doc_id, kb_id: r.kb_id, filename: r.filename,
    score: Math.max(0, 1 - r.distance), snippet: r.content.slice(0, 200)
  }));
}
```

## 3. 后端路由

### 3.1 Embedding 配置（`src/routes/paas-embedding.ts`）

- `GET /api/paas/embedding-config`：
  - admin: `{ baseUrl, apiKey: '<masked>', model, dimensions, configured: boolean }`
  - member: `{ model, dimensions, configured: boolean }`
- `PUT /api/paas/embedding-config`（adminRoleMiddleware）：
  - body: `{ baseUrl, apiKey, model, dimensions }`
  - apiKey AES-256-GCM 加密写入 `data/config/embedding.json`
  - 触发 `embeddingConfigCache` 失效
- `POST /api/paas/embedding-config/test`（adminRoleMiddleware）：
  - 调用 `embedText('hello')` 验证，返回 `{ success: boolean, dimensions?: number, error?: string }`

### 3.2 Agent 分享（`src/routes/paas-agents.ts` + `src/routes/share.ts`）

- `POST /api/paas/agents/:id/share`（owner only）→ 生成 share_token，返回 `{ shareId, shareToken, shareUrl }`
- `GET /api/paas/agents/:id/shares`（owner only）→ 列出该 Agent 的所有 share
- `DELETE /api/paas/agents/:id/shares/:shareId`（owner only）→ revoke
- `GET /api/paas/share/:token`（公开，无 auth）→ 返回脱敏 agent 信息
- `POST /api/paas/share/:token/install`（auth required）→ 一键安装到当前用户

### 3.3 协作者（`src/routes/paas-agents.ts`）

- 权限检查 helper：`canEditAgent(userId, agentDefId)` = owner OR editor
- `POST /:id/collaborators`（owner only）body: `{ userId, role: 'editor'|'viewer' }`
- `DELETE /:id/collaborators/:userId`（owner only）
- `GET /:id/collaborators`（owner 或 collaborator）→ 列出
- `PATCH /:id` 和 mounts 路由加 `canEditAgent` 检查

### 3.4 版本 diff（`src/routes/paas-agents.ts`）

- `GET /:id/versions/:vid/diff`（owner + collaborators）：
  - 读取目标 version snapshot + 当前 agent + 当前 mounts
  - 字段级 diff：`system_prompt` / `model` / `max_turns` / `temperature` / `enabled` / `mounts`
  - systemPrompt 按行 diff（`diffLines` 简单 LCS 实现）
  - 返回 `{ fields: [{name, before, after, type}], promptDiff: [{op: '+'|'-'|'=', line}] }`

### 3.5 评论举报（`src/routes/paas-marketplace.ts` + `src/routes/paas-admin.ts`）

- `POST /api/paas/marketplace/reviews/:id/report`（auth）body: `{ reason }`
- `GET /api/paas/admin/review-reports`（admin）→ pending 列表（含 review 内容 + item 信息）
- `POST /api/paas/admin/review-reports/:id/resolve`（admin）body: `{ action: 'dismiss'|'delete_review' }`
  - `dismiss`: 标记 status='dismissed'
  - `delete_review`: 删除 review（CASCADE 删除 report 记录）

## 4. 前端

### 4.1 SettingsPage 新增 EmbeddingSettingsSection

- 字段：baseUrl / apiKey (password) / model / dimensions
- 「保存」→ PUT /api/paas/embedding-config
- 「测试连接」→ POST /api/paas/embedding-config/test，显示结果
- admin 可编辑，member 只读显示 model + dimensions

### 4.2 AgentStudioPage 增强

- 顶部 actions 区：分享 / 邀请协作者 / 版本对比
- `ShareDialog`：显示 shareUrl，可复制，可 revoke
- `CollaboratorsSection`：列表 + 邀请输入框 + 移除
- 版本历史行新增「对比」按钮 → `VersionDiffDialog`：
  - 字段级表格（before / after）
  - systemPrompt diff（+/=/- 标记）
  - 顶部「回滚」按钮

### 4.3 MarketplacePage 详情抽屉

- 每条评论右侧「举报」按钮 → `ReportDialog`：reason textarea + submit

### 4.4 UsersPage 新增「评论举报」tab（admin 可见）

- `ReviewReportsTab`：列出 pending 举报（review 内容 + item 信息 + reason + reporter）
- 每条：dismiss / delete_review 按钮

### 4.5 SharePage `/share/:token`（公开页）

- 无需 auth，从 `GET /api/paas/share/:token` 拉取 agent 信息
- 显示：name / description / systemPrompt 预览（前 200 字符）/ model / mounts 数量
- 「安装到我的账户」按钮：若未登录跳转 `/login?redirect=/share/:token`，登录后调用 install

## 5. 容错

1. sqlite-vec 加载失败 → 回退线性扫描，日志 WARN
2. embedding API 未配置 → 回退 FTS5-only
3. share token 不存在 / 已过期 → 公开页显示「链接已失效」
4. install 时用户配额不足 → 返回 402，前端提示

## 6. 依赖

- 新增 `sqlite-vec@0.1.9`（已安装）
- 无新增前端依赖
