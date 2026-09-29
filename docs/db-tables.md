# DeepThink 数据库表

> 本文件是 [`CLAUDE.md`](../CLAUDE.md) §5 的完整版——表族划分与核心表字段说明。抽出的理由见
> [`docs/architecture-index.md`](architecture-index.md) 前言。
>
> ⚠️ **权威版本号是 `src/db.ts` 的 `SCHEMA_VERSION`**——**改动前先读那里**，不要相信任何文档里的版本数字。
> 迁移方式见 [`docs/howto/modify-db-schema.md`](howto/modify-db-schema.md)。

## 建表语句位置

建表语句有**两处**，改 schema 时别漏：

- `src/db.ts`：90 张表（`CREATE TABLE IF NOT EXISTS`），另建 `kb_documents_fts` / `kb_documents_vec` 两张虚表
- `src/eval-center/eval-schema.sql`：评测中心独立的 16 张表（`eval_*` / `agent_trace` / `trace_span`），由 `eval-center/eval-db.ts` 加载

> ⚠️ **`.sql` 不会被 `tsc` emit**，必须登记进 `scripts/copy-runtime-assets.cjs` 的 `ASSETS` 清单——详见 `CLAUDE.md` §5 的警告与
> [`docs/issues/2026-09-29-eval-center-schema-asset-missing.md`](issues/2026-09-29-eval-center-schema-asset-missing.md)。

## 表族（90 张表）

表按业务面分族：**核心会话**（`chats` / `messages` / `registered_groups` / `sessions` / `router_state`）、**群组协作**（`group_members` / `group_seats` / `group_messages` / `user_pinned_groups`）、**认证计费**（`users` / `user_sessions` / `invite_codes` / `auth_audit_log` / `billing_*` / `redeem_*`）、**图谱编排**（`graph_definitions` / `graph_runs` / `graph_node_runs` / `graph_node_run_locks`）、**Agent**（`agents` / `agent_definitions` / `agent_definition_versions` / `agent_mounts` / `agent_shares` / `agent_worker_links` / `agent_collaborators`）、**Skills 与知识库**（`skills` / `skill_versions` / `knowledge_bases` / `kb_documents` / `kb_documents_vec`）、**MCP**（`mcp_server_configs` / `mcp_registry_*`）、**可观测**（`trace_steps` / `trace_tool_calls` / `chat_trace_nodes` / `tool_call_audit_log` / `tool_call_idempotency`）、**用量计费**（`usage_records` / `usage_daily_summary` / `daily_usage` / `monthly_usage` / `model_pricing`）、**自主与 Harness**（`autonomy_*` / `loop_*` / `harness_*` / `supervisor_*`）、**业务面**（`opc_*` / `sw_*` / `sandbox_*` / `collaborations` / `marketplace_*` / `file_trash` / `file_versions` / `workspace_artifacts` / `workflow_builds` / `team_builds` / `provider_configs` / `api_keys`）。

## 核心表

改动前最常打交道的：

核心表（改动前最常打交道的）：

| 表 | 主键 | 用途 |
|-----|------|------|
| `chats` | `jid` | 群组元数据（jid、名称、最后消息时间） |
| `messages` | `(id, chat_jid)` | 消息历史（含 `is_from_me`、`source` 标识来源、`attachments`） |
| `scheduled_tasks` | `id` | 定时任务（调度类型、上下文模式、状态、`execution_type`、`script_command`、`created_by`） |
| `task_run_logs` | `id` (auto) | 任务执行日志（耗时、状态、结果） |
| `registered_groups` | `jid` | 注册的会话（folder 映射、容器配置、执行模式、`customCwd`、`is_home`、`init_source_path`、`init_git_url`、`selected_skills`、`require_mention`） |
| `sessions` | `(group_folder, agent_id)` | 会话 ID 映射（Claude session 持久化，支持 Sub-Agent 独立会话；`provider_id` 字段用于 ProviderPool sticky 选择，避免跨 OAuth 账号 thinking block 签名失效） |
| `router_state` | `key` | KV 存储（`last_timestamp`、`last_agent_timestamp`） |
| `users` | `id` | 用户账户（密码哈希、角色、权限、状态、`ai_name`、`ai_avatar_emoji`、`ai_avatar_color`、`avatar_emoji`、`avatar_color`、`ai_avatar_url`、`deleted_at`） |
| `user_sessions` | `id` | 登录会话（token、过期时间、最后活跃） |
| `invite_codes` | `code` | 注册邀请码（最大使用次数、过期时间） |
| `auth_audit_log` | `id` (auto) | 认证审计日志 |
| `group_members` | `(group_folder, user_id)` | 共享工作区成员（用户与群组的多对多关系） |
| `agents` | `id` | Sub-Agent（status、kind、prompt、result_summary，属于特定群组） |
| `usage_records` | `id` | Token 用量明细（per-model 拆行，关联 user_id、group_folder、message_id） |
| `usage_daily_summary` | `(user_id, model, date)` | 日维度用量预聚合（本地时区日期，增量 UPSERT） |
| `user_quotas` | `user_id` | 用户配额（预留，暂不写入数据） |

**注意**：`registered_groups.folder` 允许重复（多个飞书群组可映射到同一 folder）。`registered_groups.is_home` 标记用户主容器。
