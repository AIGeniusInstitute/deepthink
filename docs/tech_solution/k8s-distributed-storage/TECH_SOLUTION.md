# 技术方案：K8s 分布式存储改造

## 版本
v1.0 — 2026-09-14

## 1. 架构概览

```
┌──────────────────────────────────────────────────────────────────────┐
│                        K8s Cluster (kind-desktop)                    │
│  namespace: deepthink                                                 │
│                                                                       │
│  ┌─────────────────────┐    ┌─────────────────────┐                  │
│  │   Pod A (deepthink) │    │   Pod B (deepthink) │                  │
│  │   ┌───────────────┐ │    │   ┌───────────────┐ │                  │
│  │   │ Web Server    │ │    │   │ Web Server    │ │                  │
│  │   │ :9898         │ │    │   │ :9898         │ │                  │
│  │   └──┬───┬───┬───┘ │    │   └──┬───┬───┬───┘ │                  │
│  │      │   │   │      │    │      │   │   │      │                  │
│  └──────┼───┼───┼──────┘    └──────┼───┼───┼──────┘                  │
│         │   │   │                  │   │   │                          │
│         ▼   ▼   ▼                  ▼   ▼   ▼                          │
│  ┌─────────┐ ┌───────┐ ┌───────┐                                     │
│  │PostgreSQL│ │ MinIO │ │ Redis │                                     │
│  │ (配置/   │ │(工作区│ │(IPC/  │                                     │
│  │  元数据/ │ │ 文件/ │ │ 锁/   │                                     │
│  │  消息)   │ │ 产物) │ │ 广播) │                                     │
│  └─────────┘ └───────┘ └───────┘                                     │
└──────────────────────────────────────────────────────────────────────┘
```

## 2. 存储分层策略

| 层 | 存储 | 数据 | 读模式 | 写模式 |
|----|------|------|--------|--------|
| L1 配置 | PostgreSQL | Provider configs, system settings, IM configs | DB-first, file fallback | DB + file write-through |
| L2 元数据 | PostgreSQL | Users, groups, sessions, messages, skills, MCP servers | DB only | DB only |
| L3 工作区文件 | MinIO (S3) | GROUPS_DIR 文件树, 产物, 版本快照, 回收站 | S3-first, local fallback | S3 + 本地缓存 |
| L4 IPC/实时 | Redis | Agent stdin/stdout 队列, 流式缓冲, 分布式锁 | Redis only | Redis only |

## 3. 详细设计

### 3.1 Provider Configs（✅ 已完成）

**模式**：DB-first read + file write-through cache

```typescript
// runtime-config.ts 中的通用模式
function readConfig<T>(key: string, userId = ''): T | null {
  const fromDb = readProviderConfigFromDb<T>(key, userId);
  if (fromDb) return fromDb;
  return readFromFile(key); // fallback
}

function writeConfig<T>(key: string, userId: string, data: T): void {
  writeToFile(key, data);        // 本地缓存
  writeProviderConfigToDb(key, userId, data); // 主存储
}
```

**DB Schema**（v65 migration）：
```sql
CREATE TABLE IF NOT EXISTS provider_configs (
  config_key TEXT NOT NULL,
  user_id TEXT NOT NULL DEFAULT '',
  config_data TEXT NOT NULL,
  created_at TEXT NOT NULL DEFAULT (datetime('now')),
  updated_at TEXT NOT NULL DEFAULT (datetime('now')),
  PRIMARY KEY (config_key, user_id)
);
```

**已迁移的配置域**：21 个（飞书/Telegram/Claude V3/Claude V4/系统设置/外观/提醒/注册/AtomCode/Codex/OpenCode/Pi + 用户级飞书/Telegram）

### 3.2 用户级 IM 配置（P0-2，待完成）

**目标**：补齐 QQ、WeChat、DingTalk、Discord、WhatsApp 共 5 个渠道的全局 + 用户级配置迁移。

**方案**：复用 3.1 完全相同的 DB-first 模式。每个渠道两个 key：
- `{channel}-provider`（全局默认配置）
- `{channel}-provider:{userId}`（用户级覆盖）

**改动文件**：
- `src/runtime-config.ts`：每个渠道新增 `readStored{Channel}Config()` 和 `save{Channel}ProviderConfig()`
- 无需 DB schema 变更

### 3.3 工作区文件迁移到 MinIO（P0-3）

**现状**：
- 文件存储在 `GROUPS_DIR/{folder}/` 本地文件系统
- `file-manager.ts` 直接操作 fs
- 回收站 `.trash/`、版本快照 `.versions/` 均在本地

**目标架构**：
```
MinIO Bucket: deepthink-workspaces
├── groups/{groupFolder}/
│   ├── files/           ← 工作区文件树
│   ├── .trash/          ← 软删除文件
│   └── .versions/       ← 版本快照
└── trace-io/            ← 已有（object-store.ts S3 backend）
```

**方案**：
1. 扩展 `object-store.ts` 增加通用文件操作（list/read/write/delete/move/copy）
2. `file-manager.ts` 新增 `s3FileBackend` 包装层：S3 读写优先，本地文件作为缓存
3. 文件列表操作通过 S3 ListObjectsV2
4. 回收站/版本快照元数据已在 `file_trash`/`file_versions` PG 表，内容迁移到 MinIO

**改动文件**：
- `src/object-store.ts`：通用文件操作 API
- `src/file-manager.ts`：S3 backend 集成
- `src/routes/files.ts`：适配 S3 路径
- `deploy/k8s/minio.yaml`：已有，确认 bucket 创建

**关键决策**：
- 文件内容用 MinIO，元数据（路径/大小/MIME/版本号）存在 PostgreSQL `file_trash`/`file_versions` 表
- 本地缓存目录 `/data/file-cache/` 挂载到 PVC（加速热文件访问）
- 写入策略：先写 MinIO → 成功后再写本地缓存（防丢数据）

### 3.4 Agent 会话状态（P0-4）

**现状**：
- Claude SDK sessions 目录：`{DATA_DIR}/sessions/`
- Agent IPC 队列：`{DATA_DIR}/ipc/{groupFolder}/`

**目标**：
- Sessions → PostgreSQL `agent_sessions` 表
- IPC 队列 → Redis List（已有 `deepthink:ipc:{folder}` 频道）

**Sessions 表设计**：
```sql
CREATE TABLE IF NOT EXISTS agent_sessions (
  id TEXT PRIMARY KEY,
  group_folder TEXT NOT NULL,
  session_data TEXT NOT NULL,  -- JSON blob
  created_at TEXT NOT NULL DEFAULT (datetime('now')),
  updated_at TEXT NOT NULL DEFAULT (datetime('now'))
);
CREATE INDEX IF NOT EXISTS idx_agent_sessions_group ON agent_sessions(group_folder);
```

**IPC 队列**：已有 Redis bridge（`redis-bus.ts` + `redis-ipc.ts`），验证跨 Pod 消息可靠性。

### 3.5 MCP 工具配置（P0-5）

**现状**：
- `servers.json` 文件存储 MCP server 配置
- `mcp_registry_tokens` 已在 PG

**方案**：
- 新增 `mcp_server_configs` 表
- 读取：DB-first，文件 fallback
- 写入：DB + 文件 write-through

```sql
CREATE TABLE IF NOT EXISTS mcp_server_configs (
  server_name TEXT NOT NULL,
  user_id TEXT NOT NULL DEFAULT '',
  config_data TEXT NOT NULL,  -- JSON: {command, args, env, ...}
  created_at TEXT NOT NULL DEFAULT (datetime('now')),
  updated_at TEXT NOT NULL DEFAULT (datetime('now')),
  PRIMARY KEY (server_name, user_id)
);
```

## 4. 实施步骤

| 步骤 | 描述 | 优先级 | 预估 |
|------|------|--------|------|
| Step 1 | 补齐 5 个 IM 渠道配置迁移 | P0 | 30min |
| Step 2 | 工作区文件 MinIO 集成 | P0 | 2h |
| Step 3 | Agent 会话 PG 迁移 | P0 | 1h |
| Step 4 | MCP 服务器配置 PG 迁移 | P0 | 30min |
| Step 5 | Skills/Plugin 注册表迁移 | P1 | 1h |
| Step 6 | 重新构建 Docker 镜像 | - | 10min |
| Step 7 | 部署到 K8s + 冒烟测试 | - | 30min |
| Step 8 | 浏览器全量回归测试 + 截图 | - | 1h |
| Step 9 | 测试报告 HTML | - | 30min |
| Step 10 | 合并 worktree → main → push | - | 10min |

## 5. 回滚策略

- 所有新表使用 `CREATE TABLE IF NOT EXISTS`，幂等
- File fallback 保留：DB/MinIO 不可用时自动回退本地文件
- 配置写入保留 file write-through：即使 DB 失败文件仍然有效
- 可通过 K8s ConfigMap 环境变量禁用新特性：`STORAGE_BACKEND=file`