# DeepThink 企业级 Agent PaaS 平台 — 技术方案

**版本**: v1.0
**分支**: `feat/agent-paas-platform`
**作者**: ai-coder
**日期**: 2026-07-15

---

## 1. 架构概览

```
┌───────────────────────────────────────────────────────────┐
│ 前端 SPA (React + Zustand + Tailwind)                      │
│  /agents        /knowledge-bases    /marketplace           │
│       │                │                    │              │
│  AgentStudioStore  KBStore          MarketplaceStore       │
└─────────────┬──────────────────────────────────────────────┘
              │ REST API + WebSocket
┌─────────────▼──────────────────────────────────────────────┐
│ DeepThink 主进程 (Hono + better-sqlite3)                    │
│                                                              │
│  src/routes/                                                 │
│    agent-definitions.ts (新)                                  │
│    knowledge-bases.ts    (新)                                 │
│    marketplace.ts        (新)                                 │
│  src/routes/groups.ts (扩展 agent_def_id)                    │
│                                                              │
│  src/db.ts (v44 → v48 migration)                             │
│  src/runtime-config.ts (无变更)                              │
└────┬──────────────────┬─────────────────────────┬───────────┘
     │ IPC files         │ env vars                 │ DB
     │                  │                          │
┌────▼──────────────────▼──────────────────────────▼───────────┐
│ Container / Host Agent Runner (Claude SDK / AtomCode)        │
│                                                              │
│  ContainerInput.agentDefinition = {                          │
│    systemPrompt, model, engine, maxTurns,                    │
│    mounts: [{type, id, ...payload}]                          │
│  }                                                           │
│                                                              │
│  mcp-tools.ts:                                               │
│    - kb_search MCP 工具 (IPC → 主进程 FTS5 检索)              │
│                                                              │
│  index.ts main():                                            │
│    - if agentDefinition.mounts: 仅加载挂载的 MCP/Skill         │
│    - 用 agentDefinition.systemPrompt 替换默认 prompt           │
│    - agentDefinition.model → 覆盖 CLAUDE_MODEL                │
└──────────────────────────────────────────────────────────────┘
```

---

## 2. 模块改动清单

### 2.1 数据层 — `src/db.ts`

**Schema 升级 v44 → v48**，新增 5 张表 + 2 个字段。

```sql
-- v45: agent_definitions
CREATE TABLE IF NOT EXISTS agent_definitions (
  id TEXT PRIMARY KEY,
  user_id TEXT NOT NULL,
  name TEXT NOT NULL,
  description TEXT NOT NULL DEFAULT '',
  system_prompt TEXT NOT NULL DEFAULT '',
  model TEXT,
  engine TEXT NOT NULL DEFAULT 'claude',
  avatar_emoji TEXT,
  avatar_color TEXT,
  max_turns INTEGER,
  temperature REAL,
  enabled INTEGER NOT NULL DEFAULT 1,
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL
);
CREATE INDEX idx_agent_defs_user ON agent_definitions(user_id);

-- v46: agent_mounts
CREATE TABLE IF NOT EXISTS agent_mounts (
  id TEXT PRIMARY KEY,
  agent_def_id TEXT NOT NULL,
  resource_type TEXT NOT NULL,
  resource_id TEXT NOT NULL,
  created_at TEXT NOT NULL,
  UNIQUE (agent_def_id, resource_type, resource_id),
  FOREIGN KEY (agent_def_id) REFERENCES agent_definitions(id) ON DELETE CASCADE
);

-- v47: knowledge_bases + kb_documents + FTS5
CREATE TABLE IF NOT EXISTS knowledge_bases (
  id TEXT PRIMARY KEY,
  user_id TEXT NOT NULL,
  name TEXT NOT NULL,
  description TEXT NOT NULL DEFAULT '',
  doc_count INTEGER NOT NULL DEFAULT 0,
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL
);
CREATE INDEX idx_kb_user ON knowledge_bases(user_id);

CREATE TABLE IF NOT EXISTS kb_documents (
  id TEXT PRIMARY KEY,
  kb_id TEXT NOT NULL,
  user_id TEXT NOT NULL,
  filename TEXT NOT NULL,
  content TEXT NOT NULL,
  content_hash TEXT NOT NULL,
  size_bytes INTEGER NOT NULL,
  created_at TEXT NOT NULL,
  FOREIGN KEY (kb_id) REFERENCES knowledge_bases(id) ON DELETE CASCADE
);
CREATE INDEX idx_kb_docs_kb ON kb_documents(kb_id);

CREATE VIRTUAL TABLE IF NOT EXISTS kb_documents_fts USING fts5(
  filename, content, content='kb_documents', content_rowid='rowid'
);
-- 同步触发器
CREATE TRIGGER IF NOT EXISTS kb_docs_ai AFTER INSERT ON kb_documents BEGIN
  INSERT INTO kb_documents_fts(rowid, filename, content) VALUES (new.rowid, new.filename, new.content);
END;
CREATE TRIGGER IF NOT EXISTS kb_docs_ad AFTER DELETE ON kb_documents BEGIN
  INSERT INTO kb_documents_fts(kb_documents_fts, rowid, filename, content) VALUES('delete', old.rowid, old.filename, old.content);
END;
CREATE TRIGGER IF NOT EXISTS kb_docs_au AFTER UPDATE ON kb_documents BEGIN
  INSERT INTO kb_documents_fts(kb_documents_fts, rowid, filename, content) VALUES('delete', old.rowid, old.filename, old.content);
  INSERT INTO kb_documents_fts(rowid, filename, content) VALUES (new.rowid, new.filename, new.content);
END;

-- v48: marketplace_items
CREATE TABLE IF NOT EXISTS marketplace_items (
  id TEXT PRIMARY KEY,
  item_type TEXT NOT NULL,
  name TEXT NOT NULL,
  description TEXT NOT NULL DEFAULT '',
  author_name TEXT NOT NULL DEFAULT '',
  tags TEXT NOT NULL DEFAULT '[]',
  payload TEXT NOT NULL,
  installed_count INTEGER NOT NULL DEFAULT 0,
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL
);
CREATE INDEX idx_market_type ON marketplace_items(item_type);

-- 字段扩展
ALTER TABLE registered_groups ADD COLUMN agent_def_id TEXT;
ALTER TABLE users ADD COLUMN agent_quota INTEGER NOT NULL DEFAULT 10;
```

新增 DB 访问函数（参考现有 `getRegisteredGroup`/`setRegisteredGroup` 模式）：

```ts
// agent_definitions
export function listAgentDefinitions(userId: string): AgentDefinitionRow[]
export function getAgentDefinition(id: string, userId: string): AgentDefinitionRow | null
export function createAgentDefinition(userId: string, input: NewAgentDefinition): AgentDefinitionRow
export function updateAgentDefinition(id: string, userId: string, patch: PatchAgentDefinition): AgentDefinitionRow | null
export function deleteAgentDefinition(id: string, userId: string): boolean

// agent_mounts
export function listAgentMounts(agentDefId: string): AgentMountRow[]
export function addAgentMount(agentDefId: string, type: string, resourceId: string): AgentMountRow
export function deleteAgentMount(id: string, agentDefId: string): boolean

// knowledge_bases + kb_documents
export function listKnowledgeBases(userId: string): KBRow[]
export function createKnowledgeBase(userId: string, name: string, desc: string): KBRow
export function deleteKnowledgeBase(id: string, userId: string): boolean
export function addKbDocument(kbId: string, userId: string, filename: string, content: string): KbDocRow
export function listKbDocuments(kbId: string, userId: string): KbDocRow[]
export function deleteKbDocument(docId: string, userId: string): boolean
export function searchKbDocuments(kbIds: string[], query: string, limit: number): Array<{doc_id: string, kb_id: string, filename: string, snippet: string, rank: number}>

// marketplace
export function listMarketplaceItems(itemType?: string): MarketplaceItemRow[]
export function getMarketplaceItem(id: string): MarketplaceItemRow | null
export function incrementInstallCount(id: string): void
export function createMarketplaceItem(input: NewMarketplaceItem): MarketplaceItemRow  // admin only

// registered_groups 扩展
export function setGroupAgentDefId(jid: string, agentDefId: string | null): void
```

### 2.2 类型层 — `src/types.ts`

```ts
export type AgentEngine = 'claude' | 'atomcode';
export type ResourceType = 'mcp_server' | 'skill' | 'knowledge_base';
export type MarketplaceItemType = 'agent_template' | 'mcp_template' | 'skill_template' | 'kb_template';

export interface AgentDefinition {
  id: string;
  userId: string;
  name: string;
  description: string;
  systemPrompt: string;
  model: string | null;
  engine: AgentEngine;
  avatarEmoji: string | null;
  avatarColor: string | null;
  maxTurns: number | null;
  temperature: number | null;
  enabled: boolean;
  createdAt: string;
  updatedAt: string;
  mounts?: AgentMount[]; // 嵌套返回
}

export interface AgentMount {
  id: string;
  agentDefId: string;
  resourceType: ResourceType;
  resourceId: string;
  resourceName?: string; // 展平显示名（MCP 名 / Skill 名 / KB 名）
  createdAt: string;
}

export interface KnowledgeBase { /* ... */ }
export interface KbDocument { /* ... */ }
export interface MarketplaceItem { /* ... */ }

// RegisteredGroup 扩展
export interface RegisteredGroup {
  // ...existing fields...
  agentDefId?: string | null;
}
```

### 2.3 Schema 校验 — `src/schemas.ts`

```ts
export const AgentDefinitionSchema = z.object({
  name: z.string().min(1).max(80),
  description: z.string().max(500).optional(),
  systemPrompt: z.string().max(20000).optional(),
  model: z.string().max(100).optional(),
  engine: z.enum(['claude', 'atomcode']).optional(),
  avatarEmoji: z.string().max(20).optional(),
  avatarColor: z.string().max(50).optional(),
  maxTurns: z.number().int().min(1).max(200).optional(),
  temperature: z.number().min(0).max(2).optional(),
  enabled: z.boolean().optional(),
});

export const AgentMountSchema = z.object({
  resourceType: z.enum(['mcp_server', 'skill', 'knowledge_base']),
  resourceId: z.string().min(1).max(200),
});

export const KnowledgeBaseSchema = z.object({
  name: z.string().min(1).max(80),
  description: z.string().max(500).optional(),
});

export const MarketplaceInstallSchema = z.object({
  // 可选覆盖字段
  name: z.string().max(80).optional(),
}).optional();
```

### 2.4 后端路由 — 新增 3 个路由文件

#### `src/routes/agent-definitions.ts`

```
GET    /api/agent-definitions                  列出我的 Agent
POST   /api/agent-definitions                  创建
GET    /api/agent-definitions/:id              详情（含 mounts + resourceName 展平）
PATCH  /api/agent-definitions/:id              更新
DELETE /api/agent-definitions/:id              删除（级联删 mounts）
POST   /api/agent-definitions/:id/mounts      挂载资源
DELETE /api/agent-definitions/:id/mounts/:mountId  卸载
```

鉴权：`authMiddleware` + 用户只能操作自己的（admin 可操作任意）。
配额：POST 创建时检查 `user.agent_quota`，超出返回 402 + 错误信息。

#### `src/routes/knowledge-bases.ts`

```
GET    /api/knowledge-bases                    列出
POST   /api/knowledge-bases                   创建
GET    /api/knowledge-bases/:id              详情
PATCH  /api/knowledge-bases/:id              更新
DELETE /api/knowledge-bases/:id              删除（级联删 docs + FTS）
GET    /api/knowledge-bases/:id/documents    文档列表
POST   /api/knowledge-bases/:id/documents    上传文档（multipart, .md/.txt only, 5MB 上限）
DELETE /api/knowledge-bases/:id/documents/:docId  删除文档
POST   /api/knowledge-bases/:id/search       检索 body: {query, limit?}
```

文档上传：
- 接收 multipart `file` 字段
- 限制 MIME: `text/markdown`, `text/plain`, `text/x-markdown`
- 大小: ≤ 5MB
- content: UTF-8 decoded
- content_hash: sha256
- 重复 hash 直接返回 409 + 已有 doc_id

检索:
- SQL: `SELECT doc_id, kb_id, filename, snippet(content, 5, '[', ']', '…') as snippet, bm25() as rank FROM kb_documents_fts WHERE kb_id IN (...) AND content MATCH ? ORDER BY rank LIMIT ?`
- 参数化 query，转义 FTS5 特殊字符

#### `src/routes/marketplace.ts`

```
GET    /api/marketplace                       列表 (?item_type=...)
GET    /api/marketplace/:id                   详情
POST   /api/marketplace/:id/install           安装模板到我的资源
POST   /api/marketplace                       (admin only) 发布新模板
```

install 行为按 item_type 分派:
- `agent_template` → 复制 payload 到 `agent_definitions` (user_id=当前用户)，复制 payload.mounts 到 agent_mounts
- `mcp_template` → 写入 `data/mcp-servers/{userId}/servers.json` 新条目
- `skill_template` → 调用 `install_skill` MCP 工具
- `kb_template` → 创建 KB + 复制 payload.documents 为 kb_documents

### 2.5 群组绑定 — `src/routes/groups.ts`

PATCH 端点扩展:
- 接收 `agent_def_id` 字段 (string | null)
- 校验: agent_def_id 必须属于当前用户（或 admin）
- 写入 `registered_groups.agent_def_id`

群组序列化增加 `agentDefId` + 嵌套 `agentDefinition?: {id, name, avatarEmoji}` 展平字段。

### 2.6 主进程注入 — `src/container-runner.ts`

`ContainerInput` 扩展:
```ts
interface ContainerInput {
  // ...existing...
  agentDefinition?: {
    id: string;
    systemPrompt: string;
    model: string | null;
    engine: AgentEngine;
    maxTurns: number | null;
    temperature: number | null;
    mounts: Array<{
      resourceType: string;
      resourceId: string;
      resourceName?: string;
      // MCP: 展平的完整 MCP 配置
      mcpConfig?: { command?: string; args?: string[]; env?: Record<string,string>; url?: string; type: string };
      // Skill: 展平的 skill name
      skillName?: string;
      // KB: 展平的 KB id + name
      kbId?: string;
      kbName?: string;
    }>;
  };
}
```

`runContainerAgent`/`runHostAgent` 加载群组时:
1. 如果 `group.agentDefId` 非空，查 `agent_definitions` + `agent_mounts`
2. 对每个 mount，展平 resource payload（MCP 配置从 `data/mcp-servers/{userId}/servers.json` 读，Skill 从 manifest 读，KB 从 `knowledge_bases` 读）
3. 注入到 `ContainerInput.agentDefinition`
4. 注入 env `AGENT_KB_IDS=kb1,kb2`（给 `kb_search` MCP 工具用）

### 2.7 agent-runner — `container/agent-runner/src/`

#### `types.ts`

扩展 `ContainerInput` 加 `agentDefinition` 字段。

#### `index.ts` main()

```ts
if (containerInput.agentDefinition) {
  // 1. 替换 system prompt
  systemPromptOverride = containerInput.agentDefinition.systemPrompt;
  
  // 2. 替换 model
  if (containerInput.agentDefinition.model) {
    process.env.CLAUDE_MODEL = containerInput.agentDefinition.model;
  }
  
  // 3. 过滤 MCP servers — 仅加载 mounts[type=mcp_server]
  const mountedMcpIds = new Set(
    containerInput.agentDefinition.mounts
      .filter(m => m.resourceType === 'mcp_server')
      .map(m => m.resourceId)
  );
  userMcpServers = userMcpServers.filter(s => mountedMcpIds.has(s.id));
  
  // 4. KB ids 注入到 MCP 工具环境
  const kbIds = containerInput.agentDefinition.mounts
    .filter(m => m.resourceType === 'knowledge_base')
    .map(m => m.kbId);
  process.env.AGENT_KB_IDS = kbIds.join(',');
}
```

#### `mcp-tools.ts`

新增 `kb_search` 工具:
```ts
tool({
  name: 'kb_search',
  description: '在当前 Agent 挂载的知识库中全文检索',
  schema: {
    query: z.string().describe('检索关键词'),
    limit: z.number().int().min(1).max(20).default(5).optional(),
  },
  handler: async ({ query, limit }) => {
    // 写 IPC 文件 → 主进程处理 → 轮询结果文件
    const requestId = randomUUID();
    const reqFile = path.join(IPC_REQUEST_DIR, `kb_search_${requestId}.json`);
    const resFile = path.join(IPC_RESPONSE_DIR, `kb_search_${requestId}.json`);
    fs.writeFileSync(reqFile, JSON.stringify({
      type: 'kb_search',
      query, limit: limit ?? 5,
      kbIds: process.env.AGENT_KB_IDS?.split(',').filter(Boolean) ?? [],
    }));
    // 等待结果文件出现（5s 超时）
    const result = await waitForFile(resFile, 5000);
    fs.unlinkSync(resFile);
    return result; // {results: [{filename, snippet, content}]}
  }
})
```

主进程 `src/index.ts` IPC handler 增加 `kb_search` 分支，调用 `searchKbDocuments`。

### 2.8 前端 — 新增 3 个页面 + Store

#### `web/src/stores/agent-definitions.ts` (Zustand)

```ts
interface AgentDefinitionsState {
  agents: AgentDefinition[];
  loading: boolean;
  error: string | null;
  loadAgents: () => Promise<void>;
  createAgent: (input: NewAgent) => Promise<AgentDefinition | null>;
  updateAgent: (id: string, patch: PatchAgent) => Promise<void>;
  deleteAgent: (id: string) => Promise<void>;
  addMount: (agentId: string, type: ResourceType, resourceId: string) => Promise<void>;
  removeMount: (agentId: string, mountId: string) => Promise<void>;
}
```

#### `web/src/stores/knowledge-bases.ts`

类似 pattern，加 `uploadDocument`, `search`。

#### `web/src/stores/marketplace.ts`

类似 pattern，加 `install`。

#### `web/src/pages/AgentStudioPage.tsx`

- 顶部：配额提示 `3/10 已使用`
- 卡片网格：每张卡片显示 name, description, avatar emoji, mount 数量徽章
- 新建按钮 → 滑出表单（侧边 sheet）：基础信息 + 三个 mount tab（MCP/Skill/KB）
- 卡片点击 → 编辑模式（同一表单）
- 删除按钮（带 confirm）

#### `web/src/pages/KnowledgeBasePage.tsx`

- 左侧：KB 列表（含 doc_count）
- 右侧：选中 KB 的文档列表 + 上传区（拖拽）+ 检索测试框

#### `web/src/pages/MarketplacePage.tsx`

- 顶部 tab: All / Agent / MCP / Skill / KB
- 卡片网格：name, description, author, tags, installed_count
- 安装按钮 → toast + 跳转到对应资源页

#### 路由 + 导航

`web/src/App.tsx` 加 3 条懒加载路由。
`web/src/components/Sidebar.tsx` 加 3 个 nav 项。

### 2.9 市场种子数据 — `scripts/seed-marketplace.ts`

预填 5 个模板:
1. `agent_template`: "代码审查专家" — system_prompt + 挂 code-reviewer skill
2. `agent_template`: "技术文档撰写" — system_prompt + 挂 web-researcher skill
3. `agent_template`: "客服 FAQ" — system_prompt + 挂 example-kb
4. `mcp_template`: "filesystem" — stdio command `npx -y @modelcontextprotocol/server-filesystem`
5. `skill_template`: "code-reviewer" — 引用现有 skill
6. `kb_template`: "DeepThink 使用手册" — 内置 1 个 MD 文档

主进程启动时如果 marketplace 表为空，自动执行 seed（幂等）。

---

## 3. 关键代码片段

### 3.1 FTS5 检索 SQL

```ts
export function searchKbDocuments(
  kbIds: string[],
  query: string,
  limit: number = 5,
): Array<{doc_id: string; kb_id: string; filename: string; snippet: string; rank: number}> {
  if (kbIds.length === 0 || !query.trim()) return [];
  
  // 转义 FTS5 特殊字符：将 query 包装为 quoted string 避免注入
  const sanitized = query.replace(/["']/g, ' ').trim();
  if (!sanitized) return [];
  const ftsQuery = `"${sanitized}"`; // quoted phrase match
  
  const placeholders = kbIds.map(() => '?').join(',');
  const rows = db.prepare(`
    SELECT 
      kb_documents.id as doc_id,
      kb_documents.kb_id as kb_id,
      kb_documents.filename as filename,
      snippet(kb_documents_fts, 1, '[', ']', '…', 8) as snippet,
      bm25(kb_documents_fts) as rank
    FROM kb_documents_fts
    JOIN kb_documents ON kb_documents.id = kb_documents_fts.rowid
    WHERE kb_documents_fts MATCH ?
      AND kb_documents.kb_id IN (${placeholders})
    ORDER BY rank
    LIMIT ?
  `).all(ftsQuery, ...kbIds, limit);
  return rows;
}
```

注意: `bm25()` 越负越好（rank 升序）。`snippet()` 第二参数 `1` 指向 `content` 列（0=filename, 1=content）。

### 3.2 MCP 展平逻辑

```ts
function flattenMcpMount(
  mount: AgentMountRow,
  userMcpServers: McpServerConfig[]
): AgentMountFlattened {
  if (mount.resource_type !== 'mcp_server') return mount;
  const server = userMcpServers.find(s => s.id === mount.resource_id);
  if (!server) {
    return { ...mount, resourceName: '(MCP not found)' };
  }
  return {
    ...mount,
    resourceName: server.name,
    mcpConfig: {
      type: server.type,
      command: server.command,
      args: server.args,
      env: server.env,
      url: server.url,
    },
  };
}
```

### 3.3 kb_search IPC handler（主进程）

```ts
// src/index.ts IPC handler 增加
if (ipcMsg.type === 'kb_search') {
  const results = searchKbDocuments(ipcMsg.kbIds, ipcMsg.query, ipcMsg.limit ?? 5);
  const responseFile = path.join(IPC_RESPONSE_DIR, `kb_search_${ipcMsg.requestId}.json`);
  await atomicWriteFile(responseFile, JSON.stringify({ results }));
}
```

---

## 4. 测试策略

### 4.1 类型 + 构建
- `make typecheck`: 三端 EXIT=0
- `make build`: EXIT=0

### 4.2 后端 API curl 实测
- 登录 → 创建 Agent → 挂载 → 创建 KB → 上传 MD → 检索 → 安装市场模板 → 群组绑定 → 切换

### 4.3 向后兼容
- 不带 agent_def_id 的群组继续走老路径
- 老的 `agents` 表（任务实例）不动
- 现有 `/api/groups` 响应增加 agentDefId 字段，前端老代码忽略

### 4.4 数据完整性
- 删除 Agent → 级联删 mounts（外键约束）
- 删除 KB → 级联删 docs + FTS 同步触发器删 FTS 条目
- 删除 doc → 触发器删 FTS 条目

---

## 5. 回滚策略

- Schema 升级是 ADDITIVE（只新增表/字段，不修改老结构），无需 down migration
- 新代码路径全部用 `if (agentDefId)` 守卫，老路径不触发
- 紧急回滚: `git revert` + 重启即可，DB schema 不需要回滚（新表/新字段不影响老代码）

---

## 6. 已知限制（Phase 2）

- 无团队/组织层级
- 无用户自助发布
- 无向量检索
- 无 PDF/DOCX 解析
- 无 Agent 版本管理
- 每用户 KB 无硬配额
- kb_search 通过 IPC 文件通信，5s 超时（不适合大规模检索）
