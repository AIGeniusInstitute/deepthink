# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with code in this repository.

---

# DeepThink — AI 协作者指南

本文档帮助 AI 和工程协作者快速理解项目架构、关键机制与修改边界。

## 1. 项目定位

DeepThink, 企业级自主 Agent 超级智能体自进化平台，从 Harness Engineering 到 Loop Engineering 范式的先行者，是面向企业客户的新一代 AI 基础设施(AI Infra)。DeepThink 平台以多 Agent 协作框架为核心，融合 AI 自主编程（AI Coding）、自主进化（Self-Evolving）、全栈可观测性（Full-Stack Observability）、Bug 自修复闭环（Bug Auto-Fix Loop） 与 程序员-Agent 共生协作（Human-Agent Symbiosis），构建一个能持续学习、自我改进、最终成长为超级智能体的企业级 AI 系统：
• AI 自主研发平台——Agent 独立完成软件研发全生命周期，无需人类工程师介入常规编码任务；
• 自进化智能体引擎——Agent 持续从错误中学习、从代码库中吸收知识、从用户反馈中进化；
• 程序员-Agent 协作中枢——每位程序员拥有个人"开发项目"，内含多个并行会话，中央调度防止并发冲突；
• 企业级 SaaS 平台——多租户隔离、权限分级、计费弹性、企业集成（飞书/钉钉/企微/LDAP）；
• 超级智能体孵化器——通过持续进化，单一 Agent 最终具备完整软件团队综合能力。

> "让每一家企业都拥有一支永不停歇、持续进化的 AI 超级研发团队——从工具使用者，到代码创造者，最终成长为可自我繁衍的超级智能体。让我们在通往 AGI 的道路上一起前行。"


## 2. 核心架构

### 2.0 三个横切面（改动执行或状态前先读）

下面三层不属于任何单个模块，但几乎所有改动都会碰到，且**光看目录结构看不出来**。

**① 多 Agent 执行引擎** —— `RegisteredGroup.engine`（类型见 `src/types.ts` 的 `AgentEngine`）决定这个群组用哪个引擎跑 Agent，共 5 个：

| engine | 运行时 | adapter |
|---|---|---|
| `claude`（默认） | Claude Agent SDK（内置完整 Claude Code CLI 运行时） | `container/agent-runner/src/index.ts` 的 SDK 分支 |
| `atomcode` | AtomCode 自带 HTTP/SSE daemon | `atomcode-engine.ts` + `src/atomcode-daemon-manager.ts` |
| `codex` | OpenAI Codex | `codex-engine.ts` |
| `opencode` | OpenCode | `opencode-engine.ts` |
| `pi` | pi（stdio JSONL RPC） | `pi-engine.ts` |

分发是**懒加载动态 import**：agent-runner 读 `ContainerInput.engine`，非 `claude` 时 branch 到对应 `*-engine.ts`，各 adapter 产出**同一套 `StreamEvent`**。所以上层（容器管理、流式管道、WebSocket 广播）对引擎无感知——**新增引擎只写一个 adapter，不要改上层管道**；容器内每个引擎的 CLI 与凭据注入在 `src/container-runner.ts`。配置入口是 `/engines` 页面 + 设置页对应 tab。

**② 图谱引擎（`src/graph-engineering/`，12 个文件）** —— 平台唯一的 DAG 编排内核，被多个业务面复用：Team Builder、Agent Workflow 可视化编排、Orchestrator-Workers、Agent 群组（Swarm）、Loop Engineering、Harness Eval。定义、调度、执行、校验、恢复分别对应 `graph-registry` / `graph-scheduler` / `graph-runner` / `json-schema-validator` / `graph-recovery`，加性扩展点通过 `GraphDeps` 回调注入（如 `onNodeSettled` / `onNodeStream`，未接线即 no-op）。**新增编排能力优先扩这个引擎，不要另起一条并行执行链路**——v1.4.0 的 Swarm 曾另起一套 Redis 链路，结果从未跑通（`docs/issues/2026-09-23-agent-group-message-no-response.md`），v1.5.0 的修复就是把它删掉、改回这个引擎。

**③ 可插拔状态层** —— 默认单机开箱即用；设了环境变量即切到分布式，**代码路径不变**：

| 关注点 | 默认 | 切换开关 | 实现要点 |
|---|---|---|---|
| 数据库 | SQLite（WAL），Bun 下用 `bun:sqlite` | `DATABASE_URL=postgresql://…` | `src/sqlite-compat.ts` 是唯一的后端选择点；`src/pg-sync-driver.ts` 用 worker_threads + `Atomics.wait` 把**异步 pg 同步桥接**回 better-sqlite3 的同步 API（`db.ts` 有 400+ 同步调用点，是这套设计的根本原因）；SQL 方言由 `src/sql-translator.ts` 运行时翻译 |
| 跨 Pod 协调 | 进程内 | `REDIS_URL` | `src/redis-client.ts`（未配置时全部函数降级为 no-op）、`src/redis-bus.ts`：WS 广播 pub/sub、调度器选主租约、共享并发计数器 |
| 大文件 / trace IO | 本地文件系统 | `OBJECT_STORE_PROVIDER=s3` | `src/object-store.ts`；`output_ref` 统一为绝对路径或 `s3://bucket/key`，读写两端必须走同一处保持对称 |
| 向量检索 | sqlite-vec（`vec0` 虚表） | PostgreSQL → pgvector | `src/embedding.ts`；两者都加载失败时回落线性扫描，未配置 embedding 时回落 FTS5 |
| IM 长连接归属 | 本进程独占 | Redis 选主 | 多 Pod 下只有一个 Pod 接管 IM 长连接：`deepthink:im-leader` 租约（30s TTL，续约失败即让位），见 `src/index.ts`。同一套租约原语（`src/redis-client.ts` 的 `acquireLease`）也用于调度器单写者 |

**改 `db.ts` 或任何持久化路径时，必须同时保证 SQLite 与 PostgreSQL 两种后端可用**（PG 模式禁用 SQLite 专有语法，如 `ADD COLUMN IF NOT EXISTS` 的语义差异曾导致迁移中断），并以 `make test` 兜底。

> `src/db-adapter.ts` 是一个**未被任何代码引用**的早期抽象（其注释自称 "Phase 2 not yet implemented"），真实实现是 `src/sqlite-compat.ts`。不要基于它做设计。

### 2.1 后端模块

> 下表是**选择性索引，不是全量清单**——`src/` 顶层现有 113 个模块、`src/routes/` 有 45 个路由文件、另有 14 个业务子系统目录（分列在下方两张表）。路由的挂载点在 `src/web.ts`，找某个 API 时从那里反查，不要只看这张表。

| 模块 | 职责 |
|------|------|
| `src/index.ts` | 入口：管理员引导、消息轮询（2s）、IPC 监听（1s）、容器生命周期 |
| `src/web.ts` | Hono 框架：路由挂载、WebSocket 升级、HMAC Cookie 认证、静态文件托管 |
| `src/routes/auth.ts` | 认证：登录 / 登出 / 注册、`GET /api/auth/me`（含 `setupStatus`）、设置向导、RBAC、邀请码 |
| `src/routes/groups.ts` | 群组 CRUD、消息分页、会话重置（重建工作区）、群组级容器环境变量 |
| `src/routes/files.ts` | 文件上传（默认 50MB 限制，见 `MAX_FILE_SIZE_MB`）/ 下载 / 删除、目录管理、路径遍历防护 |
| `src/routes/config.ts` | Claude / 飞书配置（AES-256-GCM 加密存储）、连通性测试、批量应用到所有容器、per-user IM 通道配置（`/api/config/user-im/feishu`、`/api/config/user-im/telegram`、`/api/config/user-im/qq`、`/api/config/user-im/dingtalk`、`/api/config/user-im/whatsapp`） |
| `src/routes/monitor.ts` | 系统状态：容器列表、队列状态、健康检查（`GET /api/health` 无需认证） |
| `src/routes/memory.ts` | 记忆文件读写（`groups/global/` + `groups/{folder}/`）、全文检索 |
| `src/routes/tasks.ts` | 定时任务 CRUD + 执行日志查询 |
| `src/routes/skills.ts` | Skills 列表与管理 |
| `src/routes/admin.ts` | 用户管理、邀请码、审计日志、注册设置 |
| `src/routes/browse.ts` | 目录浏览 API（`GET/POST /api/browse/directories`，受挂载白名单约束） |
| `src/routes/agents.ts` | Sub-Agent CRUD（`GET/POST/DELETE /api/groups/:jid/agents`） |
| `src/routes/mcp-servers.ts` | MCP Servers 管理（CRUD + `POST /api/mcp-servers/sync-host`，per-user） |
| `src/routes/plugins.ts` | Claude Code Plugins 管理（catalog + per-user enable + versioned runtime）：admin 通过 `POST /api/plugins/catalog/scan` 触发宿主机扫描共享导入 catalog；用户从 catalog enable（`PATCH /api/plugins/enabled/:fullId`，自动 materialize runtime）；`DELETE /api/plugins/marketplaces/:name` 仅清除调用者自己的 enabled refs，不删 catalog |
| `src/plugin-utils.ts` | Plugin 加载工具：`loadUserPlugins(userId, {runtime})` → `SdkPluginConfig[]`；per-user enable refs 在 `data/plugins/users/{userId}/plugins.json`，runtime materialize 到 `data/plugins/runtime/{userId}/snapshots/{snapshotId}/{marketplace}/{plugin}/` |
| `src/plugin-dependency-check.ts` | Plugin 依赖 best-effort 预检：扫描 plugin 目录下 `commands/*.md` frontmatter 的 `allowed-tools: Bash()` + `hooks/hooks.json` 的 command 第一 token；`config/plugin-deps-override.json` 人工覆盖表优先级最高 |
| `src/feishu.ts` | 飞书连接工厂（`createFeishuConnection`）：WebSocket 长连接、消息去重（LRU 1000 条 / 30min TTL）、富文本卡片、Reaction；`file` 消息下载到工作区；`post` 图文消息仅提取文字 |
| `src/telegram.ts` | Telegram 连接工厂（`createTelegramConnection`）：Bot API Long Polling、Markdown → HTML 转换、长消息分片（3800 字符）；`message:photo` 下载为 base64 供 Vision；`message:document` 下载文件到工作区 |
| `src/qq.ts` | QQ 连接工厂（`createQQConnection`）：Bot API v2 WebSocket 长连接、OAuth Token 管理、C2C 私聊 + 群聊 @Bot、消息去重（LRU 1000 条 / 30min TTL）、Markdown → 纯文本、长消息分片（5000 字符）、图片下载为 base64 供 Vision |
| `src/dingtalk.ts` | 钉钉连接工厂（`createDingTalkConnection`）：Stream 协议长连接、消息去重（LRU 1000 条 / 30min TTL）；支持 `text`、`picture`（通过 downloadCode 下载）和 `image`（通过 contentUrl 下载）；图片超过 5MB 不发 base64，仅保存到 `downloads/dingtalk/` |
| `src/whatsapp.ts` | WhatsApp 连接工厂（`createWhatsAppConnection`）：基于 `@whiskeysockets/baileys` 的 WhatsApp Web 协议；`useMultiFileAuthState` 持久化登录态；QR 经 `qrcode` 渲染 PNG data URL 推前端；自动 3s 重连（logged_out 不重连避免 QR 风暴）；`messages.upsert` 转发文本 + 媒体（image/video/audio/document）下载到 `downloads/whatsapp/{date}/`；小图片附 base64 attachment 供 Vision；`group-participants.update` 触发 onBotAddedToGroup / onBotRemovedFromGroup；群组 `require_mention` 通过 `mentionedJid` 与 `sock.user.id` 比对。详见 [`docs/channels/whatsapp.md`](docs/channels/whatsapp.md) |
| `src/wechat.ts` | 微信连接工厂（`createWeChatConnection`）：基于 iLink Bot API 的长轮询接收 + context-token 发送 + typing indicator，LRU 消息去重；图片从微信 CDN 下载后用 AES-128-ECB 解密（密钥/逻辑在 `wechat-crypto.ts`），上传携带 iLink app-identity 头。与飞书/DingTalk/QQ/Discord/Telegram 并列的独立 IM 通道适配器 |
| `src/discord.ts` | Discord 连接工厂：基于 `discord.js` 的 Gateway WS 适配器，支持 guild/DM、附件、2000 字符分片、ack Reaction |
| `src/discord-streaming-edit.ts` | Discord 流式响应控制器：镜像钉钉 Card API 接口（`feedStreamEventToCard()`），让流式事件驱动逻辑可复用；500ms 节流编辑 + 代码块安全分片 |
| `src/dingtalk-streaming-card.ts` | 钉钉 AI Card 流式响应控制器（打字机效果） |
| `src/im-safety/` | IM 安全原语模块（vendored 自 lark SDK `feature/channel`）：短 TTL `ProcessingLock` 覆盖事件进入去重 LRU 前的 in-flight 窗口；`stale-detector` 丢弃 30 分钟以上旧消息作为重连后兜底过滤。被所有 IM 通道适配器共享 |
| `src/im-downloader.ts` | IM 文件下载工具：`saveDownloadedFile()` 将 Buffer 写入 `downloads/{channel}/{YYYY-MM-DD}/`，支持 `feishu`/`telegram`/`qq`/`dingtalk` 通道，处理路径安全、文件名冲突和大小限制（默认 50MB，见 `MAX_FILE_SIZE_MB`） |
| `src/im-manager.ts` | IM 连接池管理器（`IMConnectionManager`）：per-user 飞书/Telegram/QQ/钉钉/Discord/WhatsApp/微信 连接管理、热重连、批量断开 |
| `src/container-runner.ts` | 容器生命周期：Docker run + 宿主机进程模式、卷挂载构建（isAdminHome 区分权限）、环境变量注入 |
| `src/agent-output-parser.ts` | Agent 输出解析：OUTPUT_MARKER 流式输出解析、stdout/stderr 处理、进程生命周期回调（从 container-runner.ts 提取的共享逻辑） |
| `src/group-queue.ts` | 并发控制：最大 20 容器 + 最大 5 宿主机进程、会话级队列、任务优先于消息、指数退避重试 |
| `src/runtime-config.ts` | 配置存储：AES-256-GCM 加密、分层配置（容器级 > 全局 > 环境变量）、变更审计日志 |
| `src/provider-pool.ts` | 多提供商负载均衡：round-robin / weighted-round-robin / failover 三种策略，健康状态纯内存管理，配置由 runtime-config V4 注入；`sessions.provider_id` 字段用于 sticky 选择，避免跨 OAuth 账号 thinking block 签名失效 |
| `src/supervisor.ts`、`src/supervisor-config.ts` | Supervisor SubAgent：用户消息派发前的轻量意图解析器（**不**调用工具），输出严格 JSON 决策（`clarify` 询问用户 / `delegate` 转发原文 / `auto` 重写指令 / `accept` / `retry`）；对应全局 CLAUDE.md 中的 Supervisor Agent 强制约束；超时 60s |
| `src/atomcode-daemon-manager.ts` | AtomCode 守护进程生命周期：AtomCode 自带 HTTP/SSE daemon（`/chat`、`/providers`），为每个 agent-runner 进程在随机 loopback 端口拉起一个、驱动会话、退出时拆除；config 路由也复用此管理器做临时 provider 管理 daemon —— 容器/宿主机 runner 之外的第三种 provider/runner 面 |
| `src/task-scheduler.ts` | 定时调度：60s 轮询、cron / interval / once 三种模式、group / isolated 上下文 |
| `src/file-manager.ts` | 文件安全：路径遍历防护、符号链接检测、系统路径保护（`logs/`、`CLAUDE.md`、`.claude/`、`conversations/`） |
| `src/mount-security.ts` | 挂载安全：白名单校验、黑名单模式匹配（`.ssh`、`.gnupg` 等）、非主会话只读强制 |
| `src/db.ts` | 数据层：SQLite WAL 模式、Schema 版本校验（v1→v24）、核心表定义 |
| `src/auth.ts` | 密码工具：bcrypt 哈希/验证、Session Token 生成、用户名/密码校验 |
| `src/permissions.ts` | 权限常量和模板定义（`ALL_PERMISSIONS`、`PERMISSION_TEMPLATES`） |
| `src/schemas.ts` | Zod v4 校验 schema：API 请求体校验 |
| `src/utils.ts` | 工具函数：`getClientIp()`（TRUST_PROXY 感知） |
| `src/web-context.ts` | Web 共享状态：`WebDeps` 依赖注入、群组访问权限检查、WS 客户端管理 |
| `src/middleware/auth.ts` | 认证中间件：Cookie Session 校验、权限检查中间件工厂 |
| `src/channel-prefixes.ts` | IM channel type → JID prefix 映射（`CHANNEL_PREFIXES` + `getChannelFromJid()`）。**是 `shared/channel-prefixes.ts` 的构建产物，勿直接编辑**——新增渠道要改源头那份，见 §3.2 |
| `src/im-channel.ts` | 统一 IM 通道接口（`IMChannel`）、Feishu/Telegram 适配器工厂 |
| `src/commands.ts` | Web 端斜杠命令处理器（`/clear` 重置会话） |
| `src/im-command-utils.ts` | IM 斜杠命令纯函数工具：`formatWorkspaceList()`、`formatContextMessages()` |
| `src/telegram-pairing.ts` | Telegram 配对码：6 位随机码，5 分钟过期 |
| `src/terminal-manager.ts` | Docker 容器终端管理（node-pty + pipe fallback，WebSocket 双向通信） |
| `src/message-attachments.ts` | 图片附件规范化（MIME 检测、Data URL 解析） |
| `src/image-detector.ts` | 图片 MIME 检测（magic bytes），由 `shared/image-detector.ts` 同步 |
| `src/script-runner.ts` | 脚本任务执行器（`exec()` + 并发限制 + 超时 + 1MB 输出缓冲） |
| `src/reset-admin.ts` | 管理员密码重置脚本入口 |
| `src/config.ts` | 常量：路径、超时、并发限制、会话密钥（优先级：环境变量 > 文件 > 生成，0600 权限） |
| `src/logger.ts` | 日志：pino + pino-pretty |

**业务子系统目录**（`src/` 下的子目录，按业务面划分）：

| 模块 | 职责 |
|------|------|
| `src/graph-engineering/` | 图谱引擎内核（12 文件），见 §2.0 ② |
| `src/agent-group/` | Agent 群组（Swarm）：`swarm-definition.ts`（席位 → `graph_definition`，节点 id 前缀 `seat-`）、`swarm-runner.ts`（触发运行 + 席位输出回写 + 席位级流式事件） |
| `src/agent-team/` | Team Builder：`team-builder.ts` 组队、`team-plan` / `team-prompt` / `team-commands`、`collaboration-builder.ts` 协作工作区 |
| `src/agent-orchestration/` | 编排者-工作者模式：`orchestrator-plan.ts`（选人计划）、`orchestrator-runner.ts` |
| `src/autonomy/` | 自主层：事件总线 / 能力注册 / 指标 / 学习与教训注入 / 自愈 / 适配 |
| `src/eval-center/` | 评测中心：用例与运行、漂移检测、评分（自带 `eval-schema.sql`） |
| `src/mcp-registry/` | MCP Server Registry：把任意 HTTP API 注册成标准 MCP 工具（OpenAPI 解析、凭据加密、限流、治理） |
| `src/open-platform/` | 开放平台：API Key、MaaS（`/v1/chat/completions`）、Agent-as-a-Service、计费与结果校验 |
| `src/sandbox/` | 沙箱：Docker 代码执行 + 浏览器自动化（`browser-agent.ts`）、安全策略 |
| `src/feishu-cards/` | 飞书卡片构建（builder / sections / length / status-theme），被所有飞书卡片与流式卡片复用 |
| `src/im-safety/` | IM 安全原语（见上表） |

**其他横切模块**：

| 模块 | 职责 |
|------|------|
| `src/sqlite-compat.ts`、`src/pg-sync-driver.ts`、`src/sql-translator.ts` | 多后端数据层，见 §2.0 ③ |
| `src/redis-client.ts`、`src/redis-bus.ts`、`src/object-store.ts` | 分布式状态层，见 §2.0 ③ |
| `src/supervisor-agent.ts` | **长驻** Supervisor Agent：独立 DB 表 + 调度循环 + 决策审计 + 心跳 + 启动恢复。与 `src/supervisor.ts`（无状态的派发前意图解析器）**是两个不同的东西**，勿混 |
| `src/loop-orchestrator.ts`、`src/loop-commands.ts` | Loop Engineering：长任务循环编排，状态机 `pending → running → reviewing → iterating → completed/failed/cancelled` |
| `src/harness-registry.ts`、`src/harness-eval.ts`、`src/harness-meta-loop.ts` | Harness Engineering：注册表 / 评估断言 / 元循环 |
| `src/sdk-query.ts` | 轻量文本进-文本出 SDK 封装（`maxTurns=1`、无工具），**替代所有 `claude --print` CLI 调用**，复用设置页配置的 provider 认证 |
| `src/agent-ai.ts`、`src/skill-ai.ts` | AI 生成/优化 Agent 与 Skill（基于 `sdk-query.ts`） |
| `src/cross-group-acl.ts`、`src/owner-gate.ts`、`src/group-owner.ts` | 跨组访问授权、群组 owner 生命周期与运行时门禁（owner 被禁用/删除后立即停响应） |
| `src/embedding.ts`、`src/document-parser.ts`、`src/office-converter.ts` | 知识库：向量化、文档解析、Office 转换 |
| `src/billing.ts`、`src/provider-pool.ts` | 计费（套餐/余额/配额/兑换码/月度聚合）与多提供商负载均衡 |
| `src/task-routing.ts` | 定时任务 IM 路由的纯函数（依赖注入、无副作用，便于单测） |
| `src/url-safety.ts`、`src/file-manager.ts`、`src/mount-security.ts` | SSRF 防护 / 文件路径与系统路径保护 / 挂载白名单 |

### 2.2 前端

| 层次 | 技术 |
|------|------|
| 框架 | React 19 + TypeScript + Vite 6 |
| 状态 | Zustand 5，`web/src/stores/` 下 **32 个 store**（每个业务面一个：`chat`、`chat-mounts`、`auth`、`groups`、`agent-group`、`graph`、`workflow-editor`、`tasks`、`skills`、`mcp-servers`、`mcp-registry`、`knowledge-bases`、`files`、`sandbox`、`marketplace`、`billing`、`usage`、`opc`、`staff`、`team`、`collaborations`、`harness`、`loops`、`autonomous`、`supervisor`、`plugins`、`agents-paas`、`agent-definitions`、`workspace-config`、`container-env`、`users`、`monitor`） |
| 样式 | Tailwind CSS 4（teal 主色调，`lg:` 断点响应式，移动端优先） |
| 路由 | React Router 7（AuthGuard + SetupPage 重定向） |
| 通信 | 统一 API 客户端（8s 超时，FormData 120s）、WebSocket 实时推送 + 指数退避重连 |
| 渲染 | react-markdown + remark-gfm + rehype-highlight（代码高亮）、mermaid（图表渲染）、@tanstack/react-virtual（虚拟滚动） |
| UI 组件 | radix-ui + lucide-react |
| PWA | vite-plugin-pwa（生产构建始终启用，开发模式通过 `VITE_PWA_DEV=true` 启用） |

#### 前端路由表

**路由的单一真相源是 `web/src/App.tsx`**——新增页面先看那里，不要在别处维护副本。页面组件在 `web/src/pages/`。当前一级导航按业务面分组，**约 45 条路由**，主要面如下：

| 分组 | 路径（代表） | 说明 |
|------|------|------|
| 公开 / 首次运行 | `/setup`、`/setup/providers`、`/setup/channels`、`/login`、`/register`、`/share/:token` | 设置向导与分享页；`/setup` 仅未初始化时可达 |
| 对话 | `/chat/:groupFolder?` | 主聊天界面（懒加载） |
| Agent 工作台 | `/agents`（Agent Studio）、`/agent-definitions`、`/agent-groups`、`/agent-groups/:jid`、`/team`、`/collaborations`、`/opc` | Agent 群组（Swarm）在 `/agent-groups` |
| 编排 | `/workflows`、`/workflows/:id`、`/graphs`、`/loops`、`/harness`、`/supervisor` | 全部构建在图谱引擎之上，见 §2.0 ② |
| 能力与资源 | `/skills`、`/mcp-servers`、`/knowledge-bases`、`/plugins`、`/marketplace`、`/tools`、`/sandbox`、`/disk`、`/memory` | `/mcp-registry` 重定向到 `/mcp-servers?tab=registry` |
| 运行与治理 | `/tasks`、`/eval-center`、`/billing`、`/engines`、`/open-platform` | `/engines` 是 5 个 Agent 引擎的开关与配置入口（见 §2.0 ①） |
| 设置 | `/settings`（含 tabs） | `/groups`、`/monitor`、`/usage` 均重定向进 `/settings?tab=…` |
| 管理 | `/users` | 需 `manage_users` / `manage_invites` / `view_audit_log` |

### 2.3 容器 / 宿主机执行

Agent Runner（`container/agent-runner/`）在 Docker 容器或宿主机进程中执行：

- **输入协议**：stdin 接收初始 JSON（`ContainerInput`：prompt、sessionId、groupFolder、chatJid、isHome、isAdminHome），IPC 文件接收后续消息
- **输出协议**：stdout 输出 `OUTPUT_START_MARKER...OUTPUT_END_MARKER` 包裹的 JSON（`ContainerOutput`：status、result、newSessionId、streamEvent）
- **流式事件**：`text_delta`、`thinking_delta`、`tool_use_start/end`、`tool_progress`、`hook_started/progress/response`、`task_start`、`task_notification`、`status`、`init` —— 通过 WebSocket `stream_event` 消息广播到 Web 端
- **文本缓冲**：`text_delta` 累积到 200 字符后刷新，避免高频小包
- **会话循环**：`query()` → 等待 IPC 消息 → 再次 `query()` → 直到 `_close` sentinel
- **MCP Server**：**36 个工具**，通过 SDK `createSdkMcpServer()` 以同进程模式注册，IPC 文件通信。按域分组：**对话与文件**（`send_message`、`send_file`、`send_image`、`web_fetch`、`web_search`）；**定时任务**（`schedule_task`、`list_tasks`、`update_task`、`pause_task`、`resume_task`、`cancel_task`）；**记忆**（`memory_append`、`memory_get`、`memory_search`）；**Skills**（`install_skill`、`uninstall_skill`、`create_skill`）；**知识库**（`kb_search`）；**群组**（`register_group`）；**网盘**（`disk_upload`、`disk_download`、`disk_list`、`disk_search`、`disk_move`、`disk_delete`、`disk_create_folder`）；**沙箱**（`sandbox_run_code`、`sandbox_close`、`sandbox_browser_navigate`、`sandbox_browser_click`、`sandbox_browser_type`、`sandbox_browser_screenshot`、`sandbox_browser_evaluate`）；**Discord**（`discord_get_channel_info`、`discord_get_history`、`discord_get_server_info`）。新增工具的步骤见 [`docs/howto/add-mcp-tool.md`](docs/howto/add-mcp-tool.md)
- **Hooks**：PreCompact 钩子在上下文压缩前归档对话到 `conversations/` 目录
- **敏感数据过滤**：StreamEvent 中的 `toolInputSummary` 会过滤 `ANTHROPIC_API_KEY` 等环境变量名
- **预定义 SubAgent**：`agent-definitions.ts` 定义 `code-reviewer`（代码审查）和 `web-researcher`（网页研究）两个 SubAgent，通过 SDK `agents` 选项注册到 query() 会话中

**Agent Runner 模块结构**（`container/agent-runner/src/`，共 22 个文件）：

| 文件 | 职责 |
|------|------|
| `index.ts` | 主入口：stdin 读取、会话循环、query() 调用、IPC 轮询、**引擎分发**（§2.0 ①）；`claude` 引擎的 SDK 分支内联在此 |
| `atomcode-engine.ts`、`codex-engine.ts`、`opencode-engine.ts`、`pi-engine.ts` | 四个非 Claude 引擎 adapter，各自把引擎输出翻译成统一 `StreamEvent` |
| `agent-definitions.ts` | 预定义 SubAgent（code-reviewer、web-researcher） |
| `types.ts`、`utils.ts` | 共享类型定义（ContainerInput、ContainerOutput 等，re-export StreamEvent）；纯工具函数（字符串截断、敏感数据脱敏、文件名清理等） |
| `stream-processor.ts` | StreamEventProcessor 类：流式事件缓冲、工具状态追踪、SubAgent 消息转换 |
| `mcp-tools.ts` | MCP 工具定义：36 个工具通过 SDK `tool()` 注册，IPC 文件通信 |
| `mcp-bridge.ts` | MCP server 桥接（宿主 / 容器两种模式下的连接与生命周期） |
| `redis-ipc.ts` | 分布式模式下的 IPC（Redis 消息驱动，替代文件 IPC 轮询） |
| `session-history.ts`、`history-image-prune.ts` | 会话历史读写与历史图片裁剪 |
| `reminder-engine.ts` | Agent Reminder：长任务中周期性 / 事件驱动地重注入任务目标，防上下文漂移 |
| `autonomy-recovery.ts`、`gap-resolver.ts` | 全自主恢复：终态刹车恢复、知识缺口自解（`install_skill` / `web_search`） |
| `trace-node-allocator.ts` | trace 节点编号分配（与宿主端 `trace_steps` 对齐） |
| `channel-prefixes.ts`、`i18n-directive.ts` | 渠道前缀（构建时同步）、多语言指令注入 |
| `image-detector.ts` | 图片 MIME 检测（由 `shared/image-detector.ts` 构建时同步生成，勿直接编辑） |
| `stream-event.types.ts` | StreamEvent 类型（由 `shared/stream-event.ts` 构建时同步生成，勿直接编辑） |

### 2.4 执行模式

每个注册群组可选择执行模式（`RegisteredGroup.executionMode`）：

| 模式 | 行为 | 适用对象 | 前置依赖 |
|------|------|---------|---------|
| `host` | Agent 作为宿主机进程运行，通过 `claude` CLI 直接访问宿主机文件系统 | admin 主容器（`folder=main`） | Claude Agent SDK（自动安装） |
| `container` | Agent 在 Docker 容器中运行，通过卷挂载访问文件，完全隔离 | member 主容器（`folder=home-{userId}`）及其他群组 | Docker Desktop + 构建镜像 |

**is_home 模型**：每个用户在注册时自动创建一个 `is_home=true` 的主容器。`loadState()` 启动时强制执行模式：admin 的主容器（`folder=main`）设为 `host`，member 的主容器（`folder=home-{userId}`）设为 `container`。

宿主机模式通过 `node container/agent-runner/dist/index.js` 启动 agent-runner 进程，agent-runner 内部调用 `@anthropic-ai/claude-agent-sdk`，SDK 内置了完整的 Claude Code CLI 运行时（`cli.js`），无需全局安装。

宿主机模式支持 `customCwd` 自定义工作目录，使用 `MAX_CONCURRENT_HOST_PROCESSES`（默认 5）作为独立的并发限制。

### 2.5 Docker 容器构建

容器镜像（`container/Dockerfile`）基于 `node:22-slim`：

- 安装 Chromium + 系统依赖（用于 `agent-browser` 浏览器自动化）
- 全局安装 `agent-browser` 和 `@anthropic-ai/claude-code`（始终最新版本）
- 局部安装 `@anthropic-ai/claude-agent-sdk`（`"*"` 版本 + 无 lock file = 每次构建安装最新）
- entrypoint.sh：加载环境变量 → 发现 Skills（符号链接）→ 编译 TypeScript → 从 stdin 读取 → 执行
- 以 `node` 非 root 用户运行
- 构建命令：`./container/build.sh`（`CACHEBUST` 参数确保跳过缓存）

### 2.6 桌面版 Electron 壳

DeepThink 桌面端是 Electron 应用（`desktop/` 目录），把后端 + Web 前端 + Agent Runner 打包成单机可执行的 `.dmg` / `.exe` / `.AppImage`，让非开发者用户能"双击即用"。

详细架构（模块结构 / 启动流程 / 资源路径策略 / 用户数据目录 / 进程守护要点 / 平台构建 / 图标资产 / Makefile 目标）见 [`docs/desktop-architecture.md`](docs/desktop-architecture.md)。

## 3. 数据流

### 3.1 消息处理

```
飞书/Telegram/钉钉/Web 消息 → storeMessageDirect(db) + broadcastNewMessage(ws)
     → index.ts 轮询 getNewMessages()（2s 间隔）→ 按 chat_jid 分组去重
     → queue.enqueueMessageCheck() 判断容器/进程状态
         ├── 空闲 → runContainerAgent() 启动容器/进程
         ├── 运行中 → queue.sendMessage() 通过 IPC 文件注入
         └── 满载 → waitingGroups 排队等待
     → 流式输出 → onOutput 回调
         → imManager.sendFeishuMessage()/sendTelegramMessage()/sendDingTalkMessage() + broadcastToWebClients() + db.storeMessageDirect()
```

### 3.2 流式显示管道

```
Agent SDK query() → 流式事件 (text_delta, tool_use_start, ...)
  → agent-runner 缓冲文本（200 字符阈值），向 stdout 发射 StreamEvent JSON
  → container-runner.ts 解析 OUTPUT_MARKER，通过 WebSocket stream_event 广播
  → 前端 chat store handleStreamEvent()，更新 StreamingDisplay 组件
  → 系统错误 (agent_error, container_timeout) 通过 new_message 事件清除流式状态
```

StreamEvent 类型以 `shared/stream-event.ts` 为单一真相源，构建时通过 `scripts/sync-stream-event.sh` 同步到三处副本：
- `container/agent-runner/src/stream-event.types.ts`（agent-runner 内的 `types.ts` re-export）
- `src/stream-event.types.ts`（后端 `types.ts` re-export）
- `web/src/stream-event.types.ts`（前端 `chat.ts` import）

修改 StreamEvent 类型时，只需编辑 `shared/stream-event.ts`，然后运行 `make sync-types`（`make build` 会自动触发）。`make typecheck` 会通过 `scripts/check-stream-event-sync.sh` 校验同步状态。

`shared/image-detector.ts` 同样通过 `make sync-types` 同步到两处副本：
- `src/image-detector.ts`（后端）
- `container/agent-runner/src/image-detector.ts`（agent-runner）

`shared/channel-prefixes.ts` 是**第三个**同步源，`scripts/sync-stream-event.sh` 一并处理，同步到两处副本：
- `src/channel-prefixes.ts`（后端）
- `container/agent-runner/src/channel-prefixes.ts`（agent-runner）

**通用规则**：`shared/` 下任何一个文件都是**单向同步源**，它在 `src/`、`web/src/`、`container/agent-runner/src/` 下的同名副本会在 `make build` / `make sync-types` 时被**无条件覆盖**。改副本 = 白改。改完源头跑 `make sync-types`；`make typecheck` 会校验一致性。

### 3.3 IPC 通信

| 方向 | 通道 | 用途 |
|------|------|------|
| 主进程 → 容器 | `data/ipc/{folder}/input/*.json` | 注入后续消息 |
| 主进程 → 容器 | `data/ipc/{folder}/input/_close` | 优雅关闭信号 |
| 容器 → 主进程 | `data/ipc/{folder}/messages/*.json` | Agent 主动发送消息（`send_message` MCP 工具） |
| 容器 → 主进程 | `data/ipc/{folder}/tasks/*.json` | 任务管理（创建 / 暂停 / 恢复 / 取消） |

文件操作使用原子写入（先写 `.tmp` 再 `rename`），读取后立即删除。IPC 通信使用 `fs.watch` 事件驱动（50-100ms debounce）+ 5s 后备轮询。

### 3.4 容器挂载策略

| 资源 | 容器路径 | admin 主容器 | member 主容器/其他 |
|------|---------|-------------|-------------------|
| 工作目录 `data/groups/{folder}/` | `/workspace/group` | 读写 | 读写（仅自己） |
| 项目根目录 | `/workspace/project` | 读写 | 不可访问 |
| 用户全局记忆 `data/groups/user-global/{userId}/` | `/workspace/global` | 读写 | 读写（仅自己） |
| Claude 会话 `data/sessions/{folder}/.claude/` | `/home/node/.claude` | 读写 | 读写（仅自己） |
| IPC 通道 `data/ipc/{folder}/` | `/workspace/ipc` | 读写 | 读写（仅自己） |
| 项目级 Skills `container/skills/` | `/workspace/project-skills` | 只读 | 只读 |
| 用户级 Skills `~/.claude/skills/` | `/workspace/user-skills` | 只读 | admin 创建的会话可读 |
| feishu-cli OAuth 状态 `data/config/user-cli/{userId}/feishu-cli/` | `/home/node/.feishu-cli` | 读写 | 读写（仅自己） |
| 环境变量 `data/env/{folder}/env` | `/workspace/env-dir/env` | 只读 | 只读 |
| 持久 extra 目录 `data/extra/{folder}/` | `/workspace/extra` | 读写 | 读写（仅自己） |
| 额外挂载（白名单内） | `/workspace/extra/{name}` | 按白名单 | 按白名单（`nonMainReadOnly` 时强制只读） |
| 持久化 npm 全局包 `data/extra/{folder}/.npm-global/` | `/workspace/extra/.npm-global` | 读写 | 读写（仅自己） |

> **npm 全局包持久化**：容器内 npm prefix 由 entrypoint.sh 指向 `/workspace/extra/.npm-global/`，PATH 也包含该目录的 `bin/`。Agent 在容器内执行 `npm install -g <pkg>`（如 `lark-cli`、`@fanfanv5/feishu-cli`、各类 npx 风格的 MCP server 包）会自动持久化到 host 端 `data/extra/{folder}/.npm-global/`，下次新容器启动直接可用，不会因 `docker run --rm` 销毁而丢失。Per-user 隔离（每个 home folder 有独立 extra 目录）。注意：跨 CPU 架构迁移时（如 ARM64 ↔ x86_64）带 native module 的包会失效，纯 JS 包不影响。
>
> 注意：本机制依赖 `container/entrypoint.sh`，更新后需通过 `./container/build.sh` 重建镜像才能生效。

### 3.5 配置优先级

容器环境变量生效顺序（从低到高）：

1. 进程环境变量
2. 全局 Claude 配置（`data/config/claude-provider.json`）
3. 全局自定义环境变量（`data/config/claude-custom-env.json`）
4. 群组级覆盖（`data/config/container-env/{folder}.json`）

最终写入 `data/env/{folder}/env` → 只读挂载到容器 `/workspace/env-dir/env`。

### 3.6 WebSocket 协议

详细消息类型表（`WsMessageOut` / `WsMessageIn`）见 [`docs/API.md`](docs/API.md) 的 WebSocket 章节。

### 3.7 IM 连接池架构

`IMConnectionManager`（`src/im-manager.ts`）管理 per-user 的 IM 连接：

- 每个用户可独立配置飞书、Telegram、QQ 和钉钉连接（存储在 `data/config/user-im/{userId}/feishu.json`、`telegram.json`、`qq.json`、`dingtalk.json`）
- `feishu.ts`、`telegram.ts`、`qq.ts`、`dingtalk.ts` 均为工厂模式（`createFeishuConnection()`、`createTelegramConnection()`、`createQQConnection()`、`createDingTalkConnection()`），返回无状态的连接实例
- 系统启动时 `loadState()` 遍历所有用户，加载已保存的 IM 配置并建立连接
- 首次启动时自动迁移系统级 IM 配置到 admin 的 per-user 配置（`migrateSystemIMToPerUser()`）
- 系统级 API（`/api/config/feishu`、`/api/config/telegram`）已标记 deprecated，新代码应使用 `/api/config/user-im/*`
- 收到 IM 消息时，通过 `onNewChat` 回调自动注册到该用户的主容器（`home-{userId}`）
- 支持热重连（`ignoreMessagesBefore` 过滤渠道关闭期间的堆积消息）
- 优雅关闭时 `disconnectAll()` 批量断开所有连接

## 4. 认证与授权

### 4.1 认证机制

- 密码哈希：bcrypt 12 轮（`bcryptjs`）
- 会话有效期：30 天
- Cookie 认证：HMAC 签名，`HttpOnly` + `SameSite=Lax`
- 会话密钥持久化：`data/config/session-secret.key`（0600 权限），优先级：环境变量 > 文件 > 自动生成
- 登录频率限制：5 次失败后锁定 15 分钟（可通过环境变量调整）

### 4.2 RBAC 权限

角色：`admin`（管理员）、`member`（普通成员）

6 种权限（`src/permissions.ts` 的 `ALL_PERMISSIONS`）：

| 权限 | 说明 |
|------|------|
| `manage_system_config` | 管理系统配置（Claude / 引擎 / IM） |
| `manage_group_env` | 管理群组级容器环境变量 |
| `manage_users` | 用户管理（创建 / 禁用 / 删除） |
| `manage_invites` | 邀请码管理 |
| `view_audit_log` | 查看审计日志 |
| `manage_billing` | 计费管理（套餐 / 余额 / 兑换码） |

权限模板：`admin_full`、`member_basic`、`ops_manager`、`user_admin`

### 4.3 审计事件

完整的审计事件类型（`AuthEventType`）：`login_success`、`login_failed`、`logout`、`password_changed`、`profile_updated`、`user_created`、`user_disabled`、`user_enabled`、`user_deleted`、`user_restored`、`user_updated`、`role_changed`、`session_revoked`、`invite_created`、`invite_deleted`、`invite_used`、`recovery_reset`、`register_success`

### 4.4 用户隔离

每个用户拥有独立的资源空间：

| 资源 | admin | member |
|------|-------|--------|
| 主容器 folder | `main` | `home-{userId}` |
| 执行模式 | `host`（宿主机） | `container`（Docker） |
| IM 通道 | 独立的飞书/Telegram/QQ/钉钉连接 | 独立的飞书/Telegram/QQ/钉钉连接 |
| 全局记忆写入 | 可读写 | 只读 |
| 项目根目录挂载 | 读写 | 不可访问 |
| 跨组 MCP 操作 | `register_group`、跨组任务管理 | 仅限自己的群组 |
| AI 外观 | 可自定义 `ai_name`、`ai_avatar_emoji`、`ai_avatar_color` | 同左 |
| Web 终端 | 可访问自己的容器终端 | 可访问自己的容器终端 |

用户注册后自动创建主容器（`POST /api/auth/register` → `ensureUserHomeGroup()`）。

## 5. 数据库表

默认 SQLite WAL 模式（`DATABASE_URL=postgresql://` 时切 PostgreSQL，见 §2.0 ③）。Schema 经历 **v1→v70** 演进，权威版本号是 `src/db.ts` 的 `SCHEMA_VERSION`——**改动前先读那里**，不要相信本节的数字。

建表语句有**两处**，改 schema 时别漏：
- `src/db.ts`：96 张表（`CREATE TABLE IF NOT EXISTS`），另建 `kb_documents_fts` / `kb_documents_vec` 两张虚表
- `src/eval-center/eval-schema.sql`：评测中心独立的 16 张表（`eval_*` / `agent_trace` / `trace_span`），由 `eval-center/eval-db.ts` 加载

迁移方式见 [`docs/howto/modify-db-schema.md`](docs/howto/modify-db-schema.md)。

表按业务面分族：**核心会话**（`chats` / `messages` / `registered_groups` / `sessions` / `router_state`）、**群组协作**（`group_members` / `group_seats` / `group_messages` / `user_pinned_groups`）、**认证计费**（`users` / `user_sessions` / `invite_codes` / `auth_audit_log` / `billing_*` / `redeem_*`）、**图谱编排**（`graph_definitions` / `graph_runs` / `graph_node_runs` / `graph_node_run_locks`）、**Agent**（`agents` / `agent_definitions` / `agent_definition_versions` / `agent_mounts` / `agent_shares` / `agent_worker_links` / `agent_collaborators`）、**Skills 与知识库**（`skills` / `skill_versions` / `knowledge_bases` / `kb_documents` / `kb_documents_vec`）、**MCP**（`mcp_server_configs` / `mcp_registry_*`）、**可观测**（`trace_steps` / `trace_tool_calls` / `chat_trace_nodes` / `tool_call_audit_log` / `tool_call_idempotency`）、**用量计费**（`usage_records` / `usage_daily_summary` / `daily_usage` / `monthly_usage` / `model_pricing`）、**自主与 Harness**（`autonomy_*` / `loop_*` / `harness_*` / `supervisor_*`）、**业务面**（`opc_*` / `sw_*` / `sandbox_*` / `collaborations` / `marketplace_*` / `file_trash` / `file_versions` / `workspace_artifacts` / `workflow_builds` / `team_builds` / `provider_configs` / `api_keys`）。

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

## 6. 目录约定

所有运行时数据统一在 `data/` 目录下，启动时自动创建（`mkdirSync recursive`），无需手动初始化。旧版 `store/` 和 `groups/` 目录在首次启动时自动迁移到 `data/` 下。

```
data/
  db/messages.db                           # SQLite 数据库（WAL 模式）
  groups/{folder}/                         # 会话工作目录（Agent 可读写）
  groups/{folder}/CLAUDE.md                # 会话私有记忆（Agent 自动维护）
  groups/{folder}/logs/                    # Agent 容器日志
  groups/{folder}/conversations/           # 对话归档（PreCompact Hook 写入）
  groups/{folder}/downloads/{channel}/     # IM 文件/图片下载目录（feishu / telegram / dingtalk，按日期分子目录）
  groups/user-global/{userId}/             # 用户级全局记忆目录
  groups/user-global/{userId}/CLAUDE.md    # 用户全局记忆（Agent 自动维护，per-user 隔离）
  sessions/{folder}/.claude/               # Claude 会话持久化（隔离）
  ipc/{folder}/input/                      # IPC 输入通道
  ipc/{folder}/messages/                   # IPC 消息输出
  ipc/{folder}/tasks/                      # IPC 任务管理
  env/{folder}/env                         # 容器环境变量文件
  memory/{folder}/                         # 日期记忆
  config/                                  # 加密配置文件
  config/claude-provider.json              # Claude API 配置
  config/feishu-provider.json              # 飞书配置
  config/claude-custom-env.json            # 自定义环境变量
  config/container-env/{folder}.json       # 群组级环境变量覆盖
  config/user-im/{userId}/feishu.json      # 用户级飞书 IM 配置（AES-256-GCM 加密）
  config/user-im/{userId}/telegram.json    # 用户级 Telegram IM 配置（AES-256-GCM 加密）
  config/user-im/{userId}/qq.json          # 用户级 QQ IM 配置（AES-256-GCM 加密）
  config/user-im/{userId}/dingtalk.json   # 用户级钉钉 IM 配置（AES-256-GCM 加密）
  config/user-cli/{userId}/feishu-cli/     # 用户级 feishu-cli OAuth 状态（token.json + config.yaml，bind-mount 到容器 /home/node/.feishu-cli）
  config/registration.json                 # 注册设置（开关、邀请码要求）
  config/session-secret.key                # 会话签名密钥（0600 权限）
  config/system-settings.json              # 系统运行参数（容器超时、并发限制等）
  extra/{folder}/                            # 容器持久 extra 目录（bind-mount 到 /workspace/extra/）
  streaming-buffer/                         # 流式文本磁盘缓冲（崩溃恢复用，自动清理）
  skills/{userId}/                         # 用户级 Skills 数据
  mcp-servers/{userId}/servers.json        # 用户 MCP Servers 配置
  plugins/catalog/index.json                                            # 共享 catalog 索引（admin 扫描后所有用户可见）
  plugins/catalog/marketplaces/{mp}/plugins/{plugin}/versions/{contentHash}/   # admin 共享 catalog 的 immutable snapshot（内容 hash 寻址）
  plugins/users/{userId}/plugins.json                                   # per-user enable refs（only-v2 schemaVersion=1）
  plugins/runtime/{userId}/snapshots/{snapshotId}/{mp}/{plugin}/        # per-user materialized runtime（versioned；Docker 只读挂载到 /workspace/plugins/）

config/default-groups.json                 # 预注册群组配置
config/mount-allowlist.json                # 容器挂载白名单
config/global-claude-md.template.md        # 全局 CLAUDE.md 模板

container/skills/             # 项目级 Skills（挂载到所有容器）

shared/                       # 跨项目共享「单向真相源」，只改这里（见 §3.2）
  stream-event.ts             # StreamEvent 类型（同步到 src/、web/src/、agent-runner/src/）
  image-detector.ts           # 图片 MIME 检测（同步到 src/、agent-runner/src/）
  channel-prefixes.ts         # IM 渠道前缀映射（同步到 src/、agent-runner/src/）

scripts/                      # 构建辅助脚本
  sync-stream-event.sh        # 将 shared/ 下的三个真相源同步到各子项目（make sync-types / make build）
  check-stream-event-sync.sh  # 校验三个副本是否一致（make typecheck 时调用，不一致即失败）
  check-agent-runner-prompts.sh  # 校验 agent-runner 源码引用的 prompt 文件真实存在（make typecheck 时调用；否则要到容器启动 readFileSync 才 ENOENT）
```

## 7. Web API

> **完整 API 端点列表见 [`docs/API.md`](docs/API.md)**。新增或修改 Web 路由前请先阅读该文档。
> 拆分原因：原 §7 整段约 3.5 KB / ~900 tokens 是只在新增/修改 API 时才需要的参考清单，
> 强制每请求加载到 cache_read 不划算。详细清单按需 Read，下表保留路由文件入口作为快速锚点。

| 模块 | 入口文件 |
|------|---------|
| 认证 | `src/routes/auth.ts` |
| 群组 | `src/routes/groups.ts` |
| 文件 | `src/routes/files.ts` |
| 记忆 | `src/routes/memory.ts` |
| 配置（Claude / IM / 系统设置） | `src/routes/config.ts` |
| 任务 | `src/routes/tasks.ts` |
| 管理（用户 / 邀请码 / 审计） | `src/routes/admin.ts` |
| Sub-Agent | `src/routes/agents.ts` |
| 目录浏览 | `src/routes/browse.ts` |
| MCP Servers | `src/routes/mcp-servers.ts` |
| Claude Code Plugins | `src/routes/plugins.ts` |
| 用量统计 | `src/routes/usage.ts` |
| 监控 / 健康检查 | `src/routes/monitor.ts`（`GET /api/health` 无需认证） |

WebSocket：`/ws`（协议详见 [`docs/API.md`](docs/API.md) 的 WebSocket 章节）。

## 8. 关键行为

### 8.1 设置向导

首次启动时，`GET /api/auth/status` 返回 `initialized: false`（无任何用户）。前端 `AuthGuard` 检测到未初始化状态后重定向到 `/setup`，引导创建管理员账号（自定义用户名 + 密码，调用 `POST /api/auth/setup`）。创建后自动登录并跳转到 `/setup/providers` 完成 Claude API 和飞书配置。

新用户注册后跳转到 `/setup/channels` 引导配置个人 IM 通道（飞书/Telegram），可跳过直接使用 Web 聊天。

不存在默认账号。`POST /api/auth/setup` 仅在用户表为空时可用。

### 8.2 IM 自动注册

未注册的飞书/Telegram/QQ/钉钉群组首次发消息时，通过 `onNewChat` 回调自动注册到该用户的主容器（`folder='home-{userId}'`，admin 则为 `folder='main'`）。支持多个 IM 群组映射到同一个 folder。QQ 通道需先通过配对码绑定（`/pair <code>`），钉钉通道无需配对。

### 8.3 无触发词

架构层面已移除触发词概念。注册会话中的新消息直接进入处理流程。

### 8.4 会话隔离

每个会话拥有独立的 `groups/{folder}` 工作目录、`data/sessions/{folder}/.claude` 会话目录、`data/ipc/{folder}` IPC 命名空间。非主会话只能发消息给自己所在的群组。

### 8.5 主容器权限层级

每个用户的主容器（`is_home=true`）拥有基础权限，admin 主容器额外拥有特权：

**所有主容器（isHome=true）**：
- 记忆回忆能力（`memory_search`、`memory_get`、`memory_append`）
- 自己群组的 IPC 消息发送

**admin 主容器（isAdminHome=true，`folder=main`）额外权限**：
- 挂载项目根目录（读写）
- 全局记忆读写（其他会话只读）
- 跨会话操作（`register_group` MCP 工具）
- IPC 消息可发送到任意群组
- 跨组任务管理（暂停/恢复/取消其他群组的任务）

### 8.6 回复路由

主容器在 Web 与 IM 共用历史（通过 `normalizeHomeJid` 映射飞书/Telegram/QQ/钉钉 JID → `web:{folder}`）。IM 来源的消息回复到对应 IM 渠道，Web 来源的消息仅在 Web 展示。

### 8.7 并发控制

- 最多 20 个并发容器 + 最多 5 个并发宿主机进程（独立计数）
- 任务优先于普通消息
- 失败后指数退避重试（5s→10s→20s→40s→80s，最多 5 次）
- 优雅关闭：`_close` sentinel → `docker stop`（10s） → `docker kill`（5s）
- 容器超时：默认 30 分钟（`CONTAINER_TIMEOUT`）
- 空闲超时：默认 30 分钟（`IDLE_TIMEOUT`），最后一次输出后无新消息则关闭

### 8.8 Per-user 主容器自动创建

用户注册时（`POST /api/auth/register`）自动调用 `ensureUserHomeGroup()` 创建主容器：
- admin：folder=`main`，执行模式=`host`
- member：folder=`home-{userId}`，执行模式=`container`
- 同时创建 `web:{folder}` 的 chat 记录和 `registered_groups` 记录（`is_home=1`）

### 8.9 Per-user AI 外观

用户可通过 `PUT /api/auth/profile` 自定义 AI 外观：
- `ai_name`：AI 助手名称（默认使用系统 `ASSISTANT_NAME`）
- `ai_avatar_emoji`：头像 emoji（如 `🐱`、`🤖`）
- `ai_avatar_color`：头像背景色（CSS 颜色值）

前端 `MessageBubble` 组件根据消息来源的群组 owner 显示对应的 AI 外观。

### 8.10 IM 通道热管理

通过 `PUT /api/config/user-im/feishu`、`PUT /api/config/user-im/telegram`、`PUT /api/config/user-im/qq`、`PUT /api/config/user-im/dingtalk` 或 `PUT /api/config/user-im/whatsapp` 更新 IM 配置后：
- 保存配置到 `data/config/user-im/{userId}/` 目录（AES-256-GCM 加密）
- 断开该用户的旧连接
- 如果新配置有效（`enabled=true` 且凭据非空），立即建立新连接
- `ignoreMessagesBefore` 设为当前时间戳，避免处理堆积消息

### 8.11 IM 斜杠命令

飞书/Telegram/QQ/钉钉 中以 `/` 开头的消息会被拦截为斜杠命令（未知命令继续作为普通消息处理）。命令在主服务进程的 `handleCommand()` 中分发，纯函数逻辑在 `im-command-utils.ts` 中（便于单测）。

| 命令 | 缩写 | 用途 |
|------|------|------|
| `/list` | `/ls` | 查看所有工作区和对话列表，标记当前位置，显示 Agent 短 ID |
| `/status` | - | 查看当前所在的工作区/对话状态 |
| `/recall` | `/rc` | 调用 Claude CLI（`--print` 模式）总结最近 10 条消息，API 不可用时 fallback 到原始消息列表 |
| `/clear` | - | 清除当前对话的会话上下文 |
| `/require_mention` | - | 切换群聊响应模式：`/require_mention true`（需要 @机器人）或 `/require_mention false`（全量响应） |

`/recall` 通过 `execFile('claude', ['--print'])` + stdin 管道调用 Claude CLI，复用与 Agent Runner 相同的 OAuth 认证机制。

### 8.12 群聊 Mention 控制

飞书群聊支持 per-group 的 @mention 控制，类似 OpenClaw 的 `resolveGroupActivationFor()` 机制：

- **默认模式**（`require_mention=false`）：群聊中所有消息都会被处理
- **Mention 模式**（`require_mention=true`）：群聊中只有 @机器人 的消息才会被处理
- 通过 `/require_mention true|false` 命令切换
- 私聊不受此控制影响，始终响应

**实现原理**：连接飞书时通过 Bot Info API 获取 bot 的 `open_id`，收到群消息后检查 `mentions[].id.open_id` 是否包含 bot。如果 bot 未被 @mention 且该群 `require_mention=true`，则静默丢弃该消息。

**前置条件**：飞书应用需要 `im:message.group_msg` 敏感权限（实时接收群里所有消息）。`im:message:readonly` 仅控制 REST API 读取历史消息，不影响 WebSocket 实时推送。没有 `im:message.group_msg` 权限时，平台层只推送 @消息，`require_mention=false` 无法生效。

### 8.13 WhatsApp 通道

基于 `@whiskeysockets/baileys`（社区维护的 WhatsApp Web 协议逆向库）。登录 / 消息接收 / 群聊门控 / 消息发送 / 群组事件 / 风险提示的完整说明见 [`docs/channels/whatsapp.md`](docs/channels/whatsapp.md)。

## 9. 环境变量

| 变量 | 默认值 | 说明 |
|------|--------|------|
| `ASSISTANT_NAME` | `DeepThink` | 助手名称 |
| `WEB_PORT` | `9898` | 后端端口 |
| `WEB_SESSION_SECRET` | 自动生成 | 会话签名密钥 |
| `DATABASE_URL` | 空 → SQLite | 数据后端开关：`postgresql://…` 切 PostgreSQL（同步桥接），`sqlite://path` 指定 SQLite 路径。详见 §2.0 ③ |
| `REDIS_URL` | 空 → 进程内 | 分布式协调开关：WS 广播 pub/sub、调度器选主、共享并发计数器。空值时全部降级为 no-op |
| `OBJECT_STORE_PROVIDER` | `fs` | `s3` 时启用 S3/MinIO 对象存储（trace 大 IO + 工作区文件同步）；需装可选依赖 `@aws-sdk/client-s3`，并配 `S3_ENDPOINT` / `S3_BUCKET` / `S3_WS_BUCKET` / `S3_REGION` / `S3_ACCESS_KEY_ID` / `S3_SECRET_ACCESS_KEY` / `S3_FORCE_PATH_STYLE` |
| `FEISHU_APP_ID` | - | 飞书应用 ID |
| `FEISHU_APP_SECRET` | - | 飞书应用密钥 |
| `CONTAINER_IMAGE` | `deepthink-agent:latest` | Docker 镜像名称 |
| `CONTAINER_TIMEOUT` | `1800000`（30min） | 容器最大运行时间（可通过设置页覆盖） |
| `CONTAINER_MAX_OUTPUT_SIZE` | `10485760`（10MB） | 单次输出最大字节（可通过设置页覆盖） |
| `MAX_FILE_SIZE_MB` | `50` | 文件大小上限（MB）。Web 文件面板上传与 IM 渠道收文件共用（Web 下载为流式返回，不受此限制）；在 `config.ts` 统一定义，`file-manager.ts` 与 `im-downloader.ts` re-export |
| `IDLE_TIMEOUT` | `1800000`（30min） | 容器空闲超时（可通过设置页覆盖） |
| `MAX_CONCURRENT_CONTAINERS` | `20` | 最大并发容器数（可通过设置页覆盖） |
| `MAX_CONCURRENT_HOST_PROCESSES` | `5` | 宿主机模式并发上限（可通过设置页覆盖） |
| `MAX_LOGIN_ATTEMPTS` | `5` | 登录失败锁定阈值（可通过设置页覆盖） |
| `LOGIN_LOCKOUT_MINUTES` | `15` | 锁定持续时间（分钟）（可通过设置页覆盖） |
| `AUTO_COMPACT_WINDOW` | `0`（禁用，使用 SDK 默认 ~1M） | Claude Agent SDK 自动对话压缩触发点（tokens），0 = 关闭，>0 范围 [10000, 2000000]（可通过设置页覆盖） |
| `TASK_BACKFILL_GRACE_MS` | `300000`（5min） | 定时任务逾期容忍窗口（毫秒）。停机重启后 `next_run` 距今超过该窗口的任务直接跳过本次（推到下一次触发），避免跨天积压任务集体 fire 刷屏。0 = 关闭旧行为（可通过设置页覆盖） |
| `TRUST_PROXY` | `false` | 信任反向代理的 `X-Forwarded-For` 头（启用后从代理头获取客户端 IP） |
| `CORS_ALLOWED_ORIGINS` | 空（仅放行 localhost） | 公网域名访问**必须**配置：WebSocket upgrade 有 Origin 纵深防御（防 CSWSH），非 localhost 的 Origin 不在白名单会被 **403** 拒绝 → 前端 WS 连不上、无流式卡片。设为逗号分隔的域名（如 `https://claw.example.com`）或 `*`（放行所有，关闭该防御）。可写入项目根 `.env`（启动时由 `src/load-env.ts` 自动加载） |
| `TZ` | 系统时区 | 定时任务时区 |

## 10. 开发约束

- **不要重新引入"触发词"架构**
- **会话隔离是核心原则**，避免跨会话共享运行时目录
- 当前阶段允许不兼容重构，优先代码清晰与行为一致
- 修改容器 / 调度逻辑时，优先保证：不丢消息、不重复回复、失败可重试
- **Git commit message 使用简体中文**，格式：`类型: 简要描述`（如 `修复: 侧边栏下拉菜单无法点击`）
- **Issue / PR 规范**见下方 §10.2
- 系统路径不可通过文件 API 操作：`logs/`、`CLAUDE.md`、`.claude/`、`conversations/`
- `shared/` 下的文件（`stream-event.ts`、`image-detector.ts`、`channel-prefixes.ts`）都是**单向真相源**，只改源头，改完跑 `make sync-types`（`make build` 自动触发，`make typecheck` 通过 `scripts/check-stream-event-sync.sh` 校验一致性）。**不要编辑 `src/`、`web/src/`、`container/agent-runner/src/` 下的同步副本**——它们会被无条件覆盖
- Claude SDK / CLI 和容器内置的第三方工具始终使用最新版本：
  - `@anthropic-ai/claude-agent-sdk` 在 `agent-runner/package.json` 用 `"*"` + 无 lock file + `CACHEBUST` 触发每次 `npm install` 重跑
  - `feishu-cli` 在 `container/Dockerfile` 通过 `github.com/riba2534/feishu-cli/releases/latest` 的 **302 redirect Location header** 提取 tag 动态下载（不走 `api.github.com` 规避 rate limit），binary 和 skills 共享同一 `$VERSION` 确保一致
  - 通过 `make update-sdk` 手动触发一次更新
- 容器内以 `node` 非 root 用户运行，需注意文件权限
- **关闭服务时禁止 `lsof -ti:PORT | xargs kill`**，该命令会杀掉所有连接到该端口的进程（包括 OrbStack/Docker 网络代理），导致 Docker daemon 崩溃。正确做法：`lsof -ti:PORT -sTCP:LISTEN | xargs kill`（仅杀监听进程）
- **Claude Code Plugin 接入**：完整约束（注入方式 / 路径 / 依赖检测 / Marketplace / 运行时行为 / catalog immutable / runtime versioned snapshot / API 设计 / 已废弃 endpoint）见 [`docs/plugin-development.md`](docs/plugin-development.md)。关键铁律：禁止原地 mutate `ContainerInput.plugins`；plugin 目录路径必须是已展开的绝对路径（不允许 `~`）；运行中 agent **不**热加载 plugin 变化，UI 必须提示"下次新会话生效"

### 10.1 Issue 修复流程

bug 修复 / 线上事故 / CI 故障等 issue 处理 **不**走 PRD → tech_solution → test_report 那条线（不是新需求开发）。流程：

1. 定位根因：必须有证据（日志、API 输出、测试结果），禁止主观判断下结论
2. 把本次 issue 处理经验沉淀到 `docs/issues/{YYYY-MM-DD}-{slug}.md`，文件结构必须包含：
   - `## 1. 用户现象`：从用户/外部视角描述看到了什么
   - `## 2. 问题描述`：从技术视角简述发生了什么
   - `## 3. 根因`：代码层面 / 基础设施层面的具体原因，附外部依据链接
   - `## 4. 复现路径`：步骤化，让不熟悉代码的人也能复现
   - `## 5. 诊断方法`：能复制粘贴的命令（curl / grep / 内部脚本）
   - `## 6. 修复方案`：diff 形式呈现关键改动 + 选型理由
   - `## 7. 处理卡住的状态`（如适用）：如何救活已 stuck 的运行态
   - `## 8. 经验沉淀 / 预防`：未来怎么避免同类问题、巡检脚本、告警建议
3. 执行编码修复，与 issue 文档一并 commit
4. push 到 main

参考样本：`docs/issues/2026-07-10-macos-13-runner-retired.md`（GitHub Actions macos-13 runner 下线导致 x64 dmg 构建 job 永久排队的修复）。

### 10.2 Issue / PR 规范

**Issue 标题**：`类型: 简要描述`，类型使用小写英文前缀：

| 前缀 | 用途 | 示例 |
|------|------|------|
| `bug:` | Bug 报告 | `bug: 已取消的定时任务仍从 GroupQueue 执行` |
| `feat:` | 功能请求 | `feat: 支持 Latex 渲染` |
| `perf:` | 性能问题 | `perf: 大量消息时虚拟滚动卡顿` |

**Issue 正文模板**：见 [`.github/ISSUE_TEMPLATE/bug.md`](.github/ISSUE_TEMPLATE/bug.md)（Bug）与 [`.github/ISSUE_TEMPLATE/feature.md`](.github/ISSUE_TEMPLATE/feature.md)（Feature）。在 GitHub "New issue" 页面会自动弹出模板选择。

**PR 分支干净性**：目标是 PR 只含本次要提的 commit，不夹带其它本地 commit。

提 PR 前先 `git fetch upstream`，再用 `git log upstream/main..HEAD` 自查——输出应只含本次要提的 commit。

- 若本地 `main` 与 `upstream/main` 对齐，从本地 `main` 切分支没问题；
- 若本地 `main` 有未合并到上游的 commit（之前提的 PR 未 merge / 被关闭等），从它切会把这些 commit 一并带进新 PR。这种情况要么直接从 `upstream/main` 切（`git fetch upstream && git checkout -b fix/xxx upstream/main`），要么修正：`git checkout -B <branch> upstream/main && git cherry-pick <你的 commit>` 后 `git push --force-with-lease fork <branch>`（force push 自己的功能分支需用户确认，但属于必要清理）。

**PR 标题**：与 commit message 一致，`类型: 简要描述`（如 `修复: 定时任务运行时用户消息被吞掉的问题 (#151)`）。关联 Issue 时在末尾加 `(#issue号)`。

**PR 正文模板**：见 [`.github/PULL_REQUEST_TEMPLATE.md`](.github/PULL_REQUEST_TEMPLATE.md)，GitHub 创建 PR 时会自动加载。

## 11. 本地开发

### 常用命令

```bash
make dev           # 启动前后端（首次自动安装依赖和构建镜像）；若 pm2 托管了 deepthink 会自动暂停、退出后恢复
make dev-backend   # 仅启动后端（tsx 直跑 TS）；同样自动暂停/恢复 pm2
make dev-web       # 仅启动前端
make build         # 编译全部（后端 + 前端 + agent-runner，含 sync-types）
make start         # 一键启动生产环境：若 pm2 注册过 deepthink 则走 `pm2 restart`（端口由 PORT/WEB_PORT 控制），否则前台阻塞运行；启动前自动 `ensure-latest-sdk` 检测 SDK 新版
make status        # 查看服务运行状态（进程、端口、日志、Docker 容器）
make logs          # 实时查看日志（pm2 托管走 `pm2 logs`，否则需自行后台化）
make stop          # 停止服务：pm2 托管走 `pm2 stop`，否则 `lsof -ti:PORT -sTCP:LISTEN | xargs kill`（仅杀监听进程，保护 Docker daemon）
make sandbox-build # 构建沙箱镜像 deepthink-sandbox:latest（用于代码执行 + 浏览器自动化）
make admin-create  # 创建管理员账号（USERNAME=xxx [PASSWORD=xxx]）
make admin-passwd  # 改管理员密码（USERNAME=xxx [PASSWORD=xxx]，清掉该账号所有旧登录会话）
```

> **pm2 托管**：若用 pm2 注册过 `deepthink`，`make start`/`make stop`/`make logs` 会自动路由到 pm2，而非裸跑。`make dev`/`make dev-backend` 运行期间会暂停 pm2 中的 deepthink 避免端口冲突，退出时恢复。可用 `PORT=xxxx`/`WEB_PORT=xxxx` 指定端口。

**开发模式选择：**

| 场景 | 命令 | 说明 |
|------|------|------|
| 改完代码重启 | Ctrl+C 停止后再 `make start` | pm2 托管则 `pm2 restart`，否则前台阻塞 |
| 改完前端热更新 | `make dev-web`（另开终端） | Vite 热更新 |
| 改完后端快速验证 | `make dev-backend`（另开终端） | tsx watch |
| 生产环境运行 | `make start` | pm2 路由或前台阻塞；如需后台化请自行 `make start > /tmp/deepthink.log 2>&1 &` |

```bash
make typecheck     # TypeScript 全量类型检查（后端 + 前端 + agent-runner）
make test          # 约束测试（vitest，重构前/后必跑，详见下方"约束测试工程"节）
make format        # 格式化代码（prettier）
make install       # 安装全部依赖并编译 agent-runner
make clean         # 清理构建产物（dist/）
make test-smoke    # CI 门禁用最小回归集（10 个文件，< 60s）
make sync-types    # 同步 shared/ 下的真相源到各子项目（勿手改副本，见 §3.2）
make update-sdk    # 更新 agent-runner 的 Claude Agent SDK 到最新版本
make reset-init    # 重置为首装状态（清空数据库和配置，用于测试设置向导）
make backup        # 备份运行时数据到 deepthink-backup-{date}.tar.gz
make restore       # 从备份恢复数据（make restore 或 make restore FILE=xxx.tar.gz）
make help          # 列出所有可用的 make 命令
```

桌面版相关命令（详见 [`docs/desktop-architecture.md`](docs/desktop-architecture.md) 的 Makefile 目标节）：

```bash
make desktop-build      # 编译桌面版 Electron 壳（含后端 + 前端 + agent-runner 依赖构建）
make desktop-fetch-node # 拉取当前平台的 Node.js 二进制到 desktop/dev-resources/node
make desktop-dev        # 桌面版开发模式：启动 Electron 壳加载本机后端
make desktop-pack-mac   # 打包 macOS .dmg（仅 arm64，日常本地用）
make desktop-pack-mac-x64 # 打包 macOS .dmg（仅 x64，需在 intel Mac 上执行）
make desktop-pack-mac-all # 打包 macOS .dmg（arm64 + x64 双架构，发布用）
make desktop-pack-win   # 打包 Windows .exe（需在 Windows runner 执行）
make desktop-pack-linux # 打包 Linux AppImage/.deb（需在 Linux runner 执行）
```

### 端口

- 后端：9898（Hono + WebSocket）
- 前端开发服务器：5173（Vite，代理 `/api` 和 `/ws` 到后端）

### 四个独立的 Node 项目

| 项目 | 目录 | 用途 |
|------|------|------|
| 主服务 | `/`（根目录） | 后端服务 |
| Web 前端 | `web/` | React SPA |
| Agent Runner | `container/agent-runner/` | 容器/宿主机内执行引擎 |
| 桌面版 Electron 壳 | `desktop/` | 打包单机可执行应用（macOS/Windows/Linux） |

每个项目有独立的 `package.json`、`tsconfig.json`、`node_modules/`。此外，`shared/` 目录存放跨项目的共享类型定义（如 `stream-event.ts`），构建时通过 `make sync-types` 同步到各项目。桌面版通过 `desktop/build/{mac,win,linux}.json` 的 `extraResources` 把后端 `dist/`、`web/dist`、`container/agent-runner/` 和 Node 二进制一起打进安装包，运行时由 `BackendSupervisor` spawn 子进程方式启动后端（详见 [`docs/desktop-architecture.md`](docs/desktop-architecture.md)）。

### 约束测试工程

测试框架：vitest（`^4.1.1`），配置在 `vitest.config.ts`（显式排除 `data/`、`.claude/`、`.worktrees/`——`data/` 里是用户 Agent 的工作区，可能含自己的测试套件）。

当前 **148 个测试文件**，分三处：

| 位置 | 数量 | 内容 |
|------|------|------|
| `tests/*.test.ts` | 103 | 按**功能域或故事**组织的测试（图引擎、群队列、IM 渠道、trace、计费、沙箱……），文件名即主题 |
| `tests/units/*.test.ts` | 45 | 更细的单元级测试（自主层、Harness、Eval、MCP Registry、Supervisor、Swarm 等） |
| `tests/e2e/*.mjs` | 4 | 真实端到端脚本（不是 vitest 用例，需手工/CI 单独驱动） |

`tests/helpers/` 只放跨测试共享的辅助模块。

**两个测试入口，别混用**：

- `make test` = `vitest run`（全量，148 个文件）——**重构前/后必跑**
- `make test-smoke` = 10 个文件的固定清单（< 60s），**这是 CI 的 pull-request 门禁**，见 `Makefile` 的 `test-smoke` 目标；清单是写死的，**新增核心能力（trace / validation / eval 等）须同步加进这个清单**

**约束**：
- 修改渠道前缀（`shared/channel-prefixes.ts`）、`src/im-command-utils.ts`、任一 IM 通道文件前，必须先跑 `make test`
- 新增 IM 渠道时**唯一必须改的常量是 `shared/channel-prefixes.ts` 的 `CHANNEL_PREFIXES`**（不是测试文件——历史文档里提到的 `ALL_IM_CHANNELS` 及其所在测试文件都已不存在；也不是 `src/channel-prefixes.ts`——那是构建产物）。改完跑 `make sync-types`
- **基线并非全绿**：`make test` 有 2 个**预先存在的失败**，与你的改动无关，别去追：
  - `tests/units/super-agent-team-trace.test.ts` 与 `tests/units/workflows.test.ts`，都断言 `schema_version === '61'`，而当前是 `'70'`（断言写死了版本号，每次 bump schema 都会失败）
  - 判断回归要看**失败集合是否变化**，而不是"是否有失败"。全绿基线是 `1709 passed | 2 failed | 14 skipped`（148 文件 / 1725 用例）

### Howto 索引

下列"新增 X"步骤手册已从 CLAUDE.md 拆到 `docs/howto/` 下，按需 Read：

- [新增 Web 设置项](docs/howto/add-web-setting.md)
- [将环境变量迁移为 Web 可配置](docs/howto/migrate-env-to-web.md)
- [新增会话级功能](docs/howto/add-session-feature.md)
- [新增 MCP 工具](docs/howto/add-mcp-tool.md)
- [新增 Skills](docs/howto/add-skills.md)
- [启用 Headroom（token 压缩）](docs/howto/enable-headroom.md)
- [新增 StreamEvent 类型](docs/howto/add-streamevent-type.md)
- [新增 IM 集成渠道](docs/howto/add-im-channel.md)
- [修改数据库 Schema](docs/howto/modify-db-schema.md)
- [隔离环境开发（`dev-isolated`）](docs/howto/dev-isolated.md)

### 其他文档入口

- [完整 API 端点清单](docs/API.md)
- [K8s 部署指南](docs/deployment/DEEPTHINK_K8S_DEPLOYMENT_GUIDE.md)
- [桌面版架构](docs/desktop-architecture.md)
- [权限矩阵](docs/ACL-MATRIX.md)
- [Claude Code Plugin 开发约束](docs/plugin-development.md)
- [WhatsApp 通道](docs/channels/whatsapp.md)
- `docs/issues/`（故障复盘）、`docs/prd/` / `docs/tech_solution/` / `docs/test_report/` / `docs/task_state/`（需求开发流水线，按需求名分子目录）
