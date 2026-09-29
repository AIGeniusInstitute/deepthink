# DeepThink 模块索引

> 本文件是 [`CLAUDE.md`](../CLAUDE.md) §2.1 的完整版——三层模块索引表（后端模块 / 业务子系统目录 / 其他横切模块）。
>
> **抽出的理由与 §7 相同**：`CLAUDE.md` §7 把 API 端点清单移到 [`docs/API.md`](API.md) 时已说明过——这类"只在新增/修改某个面时才需要"的参考清单，
> 强制每次请求都加载进 cache_read 不划算。需要动某个模块时按需 Read 本文件。
>
> ⚠️ **这是选择性索引，不是全量清单**——`src/` 顶层现有 111 个模块、`src/routes/` 有 45 个路由文件、另有 14 个业务子系统目录。
> 找代码的起点是 `src/web.ts`（**路由挂载点**，找某个 API 从那里反查，不要只翻本文件）；入口 `src/index.ts`；数据层 `src/db.ts`；常量 `src/config.ts`。
> 改动执行或状态前，先读 `CLAUDE.md` §2.0 的三个横切面（多 Agent 执行引擎 / 图谱引擎 / 可插拔状态层）。

## 后端模块

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
| `src/whatsapp.ts` | WhatsApp 连接工厂（`createWhatsAppConnection`）：基于 `@whiskeysockets/baileys` 的 WhatsApp Web 协议；`useMultiFileAuthState` 持久化登录态；QR 经 `qrcode` 渲染 PNG data URL 推前端；自动 3s 重连（logged_out 不重连避免 QR 风暴）；`messages.upsert` 转发文本 + 媒体（image/video/audio/document）下载到 `downloads/whatsapp/{date}/`；小图片附 base64 attachment 供 Vision；`group-participants.update` 触发 onBotAddedToGroup / onBotRemovedFromGroup；群组 `require_mention` 通过 `mentionedJid` 与 `sock.user.id` 比对。详见 [`docs/channels/whatsapp.md`](channels/whatsapp.md) |
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

## 业务子系统目录

`src/` 下的子目录，按业务面划分：

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

## 其他横切模块

| 模块 | 职责 |
|------|------|
| `src/sqlite-compat.ts`、`src/pg-sync-driver.ts`、`src/sql-translator.ts` | 多后端数据层，见 §2.0 ③ |
| `src/redis-bus.ts`、`src/object-store.ts` | 分布式状态层，见 §2.0 ③ |
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
