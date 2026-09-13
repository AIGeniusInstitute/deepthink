# PRD：K8s 分布式存储改造

## 版本
v1.0 — 2026-09-14

## 1. 背景与问题

DeepThink 已部署到 K8s kind 集群（2 Pod，namespace `deepthink`）。系统当前存在大量文件级存储（JSON 配置文件、工作区文件树、会话状态、IPC 队列等），这些文件依赖 RWO PVC 挂载，在多 Pod 环境下有如下问题：

| 问题 | 影响 | 严重度 |
|------|------|--------|
| 配置不同步 | Pod A Web UI 保存后 Pod B 读不到，飞书配置/模型商配置等漂移 | P0 |
| 工作区不可达 | Agent 工作区文件落在单 Pod，其他 Pod 无法读写 | P0 |
| IPC 消息丢失 | Agent Runner 与主服务的 stdin/stdout 队列是本地文件目录 | P0 |
| 会话状态不一致 | Claude SDK 的会话恢复数据在不同 Pod 上不一致 | P1 |
| 技能/MCP 配置漂移 | servers.json/skills 目录存本地文件，多 Pod 不同步 | P1 |

## 2. 目标

将 DeepThink **全部持久化存储**从本地文件迁移到云原生基础设施：

- **PostgreSQL**：结构化配置、元数据、消息、用户、会话、技能注册表
- **MinIO (S3)**：工作区文件、产物、版本快照、回收站、Trace I/O 大对象
- **Redis**：IPC 消息队列、流式缓冲、会话临时状态、分布式锁（已有基础设施）

## 3. 范围

### 3.1 在范围内（P0 — 必须完成）

#### P0-1：Provider Config 全面迁移到 PostgreSQL ✅ 已完成
- 21 个配置域全部 DB-first read + file write-through cache
- 飞书、Telegram、Claude Provider V3/V4、系统设置、外观、提醒、注册、AtomCode、Codex、OpenCode、Pi、用户级飞书/Telegram
- v65 migration `provider_configs` 表

#### P0-2：用户级 IM 配置补齐（剩余 5 渠道）
- QQ、WeChat、DingTalk、Discord、WhatsApp 全局 + 用户级配置迁移
- 与飞书/Telegram 相同的 DB-first 模式

#### P0-3：工作区文件迁移到 MinIO
- `GROUPS_DIR/{folder}/` 文件树 → MinIO bucket `deepthink-workspaces`
- 读写通过 `object-store.ts` S3 backend
- 文件列表/搜索/回收站/版本快照适配 MinIO

#### P0-4：Agent 会话状态迁移
- Claude SDK sessions 目录 → PostgreSQL `agent_sessions` 表
- Agent IPC 队列（stdin/stdout）→ Redis List/Stream

#### P0-5：MCP 工具配置迁移
- `servers.json` → PostgreSQL `mcp_server_configs` 表
- MCP registry tokens → PostgreSQL（已有基础设施，校验数据一致性）

### 3.2 在范围内（P1 — 应该完成）

#### P1-1：技能（Skills）配置迁移
- Skills 目录 → PostgreSQL `skills_registry` 表 + MinIO skill 脚本文件

#### P1-2：Supervisor 模式标志迁移
- Supervisor mode flags 文件 → PostgreSQL 或 Redis

#### P1-3：Plugin 目录迁移
- Plugin catalog → PostgreSQL `plugin_registry` 表

### 3.3 不在范围内（后续迭代）
- Litestream WAL 备份（已有 K8s CronJob）
- 多集群灾备（已有 Velero 方案）
- FTS5 全文搜索 → pg_trgm（已有实现）
- sqlite-vec → pgvector（已有实现）

## 4. 验收标准（Acceptance Criteria）

| ID | 验收条件 | 验证方式 |
|----|---------|---------|
| AC1 | 通过 Web UI 修改飞书配置后，任意 Pod 的 `/api/providers/feishu` 返回最新值 | curl 两次命中不同 Pod |
| AC2 | 通过 Web UI 修改模型服务商配置后，任意 Pod 发起对话使用新配置 | 不同 Pod 的 turn 验证 |
| AC3 | Agent 在 Pod A 创建工作区文件，Pod B 能读取 | 两次 API 调用 |
| AC4 | 飞书消息在任意 Pod 成为 Leader 后正常收发 | 杀 Leader Pod 触发故障转移 |
| AC5 | 前端对话流式输出正常（跨 Pod WebSocket） | UI 截图 |
| AC6 | 技能加载执行正常 | Studio 页面测试 |
| AC7 | 文件回收站/版本快照跨 Pod 可用 | 上传→删除→恢复→验证 |
| AC8 | 系统重启不丢配置（所有配置从 DB 加载） | 删除 config/ 目录后重启 |
| AC9 | 25 项核心功能回归通过 | 系统测试脚本 |

## 5. 非功能需求

- **性能**：配置读取延迟 < 10ms（DB 查询 + JSON parse）
- **可用性**：PostgreSQL/MinIO/Redis 单点故障时服务降级不崩溃
- **安全**：MinIO access key 存 K8s Secret，不入镜像/代码
- **兼容性**：SQLite 单机模式保持不变，DB-first read + file fallback

## 6. 依赖与约束

- PostgreSQL 已部署（`deepthink-postgres` StatefulSet）
- MinIO 已部署（`deepthink-minio` StatefulSet）
- Redis 已部署（`deepthink-redis` Deployment）
- Kind 集群 `kind-desktop`，namespace `deepthink`
- `ANTHROPIC_API_KEY` 严禁入 git 仓库

## 7. 风险

| 风险 | 缓解措施 |
|------|---------|
| MinIO S3 API 兼容性 | object-store.ts 已有 S3 backend 验证 |
| 文件→对象存储语义差异 | 保留本地文件缓存层 |
| 大规模文件迁移耗时 | 增量迁移 + 文件不存在时回退本地 |
| PG 同步桥性能瓶颈 | 配置读取走 querySync 直接返回 |