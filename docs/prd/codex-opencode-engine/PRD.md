# PRD：引入 Codex 与 OpenCode 作为 DeepThink 第三、第四 Agent 执行引擎

- **版本**：v1.0
- **创建日期**：2026-07-16
- **负责人**：DeepThink 团队
- **分支**：`feat/codex-opencode-engine`（基于 `main`）

## 1. 背景与目标

### 1.1 背景

DeepThink 目前已接入两个 Agent 执行引擎：

1. **Claude Agent SDK**（默认引擎）—— 通过 `container/agent-runner` 内部调用 `query()`
2. **AtomCode**（第二引擎）—— 通过 `atomcode-daemon` HTTP/SSE API 接入，已在 `feat/atomcode-engine` 中完成

社区还有两个优秀的 Coding Agent 引擎：

- **OpenAI Codex CLI**（`~/codex`，Rust 实现，v0.134.0）：OpenAI 官方 Coding Agent，提供 `codex exec --json` CLI 模式（JSONL 事件流）和 `codex app-server` JSON-RPC 模式。支持 GPT-5.1-codex 等模型，具备完整的工具集（文件编辑、Shell 执行、MCP、多 Agent 协作、Web 搜索等）。
- **OpenCode**（`~/opencode`，Bun + TypeScript + Effect 实现）：社区开源 Coding Agent，提供 `opencode serve` HTTP 服务器（REST + SSE），支持 Anthropic/OpenAI/Google/xAI 等 30+ provider，具备完整工具集（文件编辑、Shell、Task、LSP、Web 搜索等）。

### 1.2 目标

把 Codex 和 OpenCode 作为 DeepThink 的**第三、第四 Agent 执行引擎**接入主聊天对话流，使用户可以：

1. 在主对话框中**无缝切换** Claude / AtomCode / Codex / OpenCode 四种引擎
2. 在 Web 设置界面**配置** Codex 和 OpenCode：二进制路径、端口、连接测试

### 1.3 非目标（明确排除）

- ❌ 跨引擎会话历史连续性（与 atomcode 一致，切换引擎即开新会话）
- ❌ Codex/OpenCode 调用 DeepThink 内置 MCP 工具的桥接（首版不实现）
- ❌ 在 Docker 容器内烤入 codex/opencode 二进制（首版只支持宿主机 bind-mount）
- ❌ Codex/OpenCode Provider 的 Web 管理 UI（首版仅做引擎配置 + 连接测试）
- ❌ 替换 Claude SDK 作为默认引擎

## 2. 用户故事

### US-1：主对话切换引擎（扩展）

**作为** DeepThink 用户，
**我希望** 在主对话页面顶部通过下拉选择器切换 Agent 执行引擎（Claude / AtomCode / Codex / OpenCode），
**以便** 在同一对话窗口内尝试不同引擎的输出。

**验收标准**：
- 引擎切换器新增 "Codex" 和 "OpenCode" 选项
- 切换到 Codex/OpenCode 后，后续消息由对应引擎处理
- 切换不丢失对话历史展示（UI 上历史消息仍可见，来自 DB）
- 切换引擎后首条消息提示 "已切换至 X 引擎，新会话开始"
- 切换器状态持久化到该会话（`registered_groups.engine`），刷新页面后保持

### US-2：Codex 配置

**作为** DeepThink 管理员，
**我希望** 在系统设置页配置 Codex 二进制路径和默认参数，
**以便** 不离开 Web 界面即可完成 Codex 的配置。

**验收标准**：
- 设置页新增 "Codex 引擎" 独立区块
- 二进制路径、默认模型、enable 开关可保存到 `data/config/codex.json`
- "测试连接" 按钮可验证 codex 二进制可用（`codex --version`）

### US-3：OpenCode 配置

**作为** DeepThink 管理员，
**我希望** 在系统设置页配置 OpenCode 路径（bun + opencode 源码）、服务端口和密码，
**以便** 不离开 Web 界面即可完成 OpenCode 的配置。

**验收标准**：
- 设置页新增 "OpenCode 引擎" 独立区块
- Bun 路径、OpenCode 源码路径、端口、密码、enable 开关可保存到 `data/config/opencode.json`
- "测试连接" 按钮可验证 opencode serve 能正常启动

### US-4：引擎不可用时的降级

**作为** 用户，
**当** 切换到 Codex/OpenCode 引擎但对应二进制/服务不可达时，
**我希望** 收到明确的错误提示。

**验收标准**：
- 发送消息时若引擎不可用，Agent 在 10 秒内返回明确错误流式消息
- 不影响 Claude/AtomCode 引擎正常使用

## 3. 关键假设与权衡

### 3.1 假设清单

| ID | 假设 | 原因 | 影响 |
|----|------|------|------|
| A1 | Codex 通过 `codex exec --json` CLI 模式接入，不启动 daemon | `codex exec --json` 提供 JSONL 事件流（每行一个 ThreadEvent），与 atomcode SSE 模式类似；app-server JSON-RPC 模式更复杂且需要额外 session 管理 | 每个 Codex 会话对应一个 `codex exec` 子进程，生命周期由 agent-runner 管理 |
| A2 | Codex session 通过 `codex exec --json resume <threadId>` 续接 | CLI 子命令 `resume` 接收位置参数 SESSION_ID（UUIDv7 或 thread 名），可选 PROMPT 位置参数；threadId 从首轮 `thread.started` 事件中提取 | sessions 表新增 `codex_thread_id` 列 |
| A3 | OpenCode 通过 `opencode serve --port` HTTP 服务器模式接入 | REST + SSE API 与 atomcode daemon 模式高度相似；CLI `opencode run` 不支持 session 续接 | 每个 agent-runner 进程启动独立的 opencode serve 实例（随机端口） |
| A4 | OpenCode session 通过 `POST /session` 创建，`sessionID` 持久化 | OpenCode API 原生支持 session CRUD + 持久化到 `~/.local/share/opencode/storage/`，进程重启不丢 | sessions 表新增 `opencode_session_id` 列 |
| A5 | 切换引擎即开新会话（不重放历史） | 与 atomcode 假设 A2 一致；各引擎 session 格式不兼容 | 见 PRD §1.3 |
| A6 | 引擎不调用 DeepThink 内置 MCP | 与 atomcode 假设 A3 一致 | 见 PRD §1.3 |
| A7 | OpenCode 需要 Bun 运行时 | OpenCode 是 Bun + TypeScript + Effect 项目，package.json 要求 `bun@1.3.14`；不能直接编译为独立二进制 | 宿主机需预装 bun；Docker 模式需 bind-mount bun + opencode 源码 |
| A8 | Codex 必须显式 `--model` 参数 | 默认模型由 bundled catalog `models.json` 动态选取首个 `visibility=list` 项（当前 `gpt-5.6-sol`），不能假设固定 | `codex-engine.ts` 必须从 `CODEX_DEFAULT_MODEL` env 读取并传 `--model` |
| A9 | OpenCode `POST /session/:id/message` 必须带 `providerID` 和 `modelID` | OpenCode API schema 要求 PromptPayload 含 `providerID`、`modelID`、`parts` | `opencode-engine.ts` 从 env 读取默认 provider/model |

### 3.2 引擎对比

| 特性 | Claude SDK | AtomCode | Codex | OpenCode |
|------|-----------|----------|-------|----------|
| 实现语言 | TypeScript (SDK) | Rust | Rust | TypeScript (Bun) |
| 接入模式 | SDK `query()` | daemon HTTP/SSE | CLI `exec --json` | HTTP Server REST+SSE |
| 进程模型 | 同进程 | 子进程 daemon | 子进程 CLI | 子进程 HTTP Server |
| Session 续接 | SDK 内置 | SSE `session_id` | `resume <threadId>` | `POST /session/:id/message` |
| Provider 模型 | Anthropic 兼容 | OpenAI 兼容 | OpenAI Codex | 30+ providers |
| 工具集 | SDK 内置 | 12 个工具 | 20+ 个工具 | 15+ 个工具 |

## 4. 功能需求

### 4.1 后端

#### F-B-1：数据库 Schema 变更

- `registered_groups.engine` 扩展取值：`'claude' | 'atomcode' | 'codex' | 'opencode'`
- `sessions` 新增列 `codex_thread_id TEXT`（默认 NULL）
- `sessions` 新增列 `opencode_session_id TEXT`（默认 NULL）
- Schema 版本号 `v51 → v52`

#### F-B-2：Codex 配置存储

- 文件：`data/config/codex.json`（AES-256-GCM 加密）
- 字段：
  ```json
  {
    "enabled": false,
    "binaryPath": "/opt/homebrew/lib/node_modules/@openai/codex/node_modules/@openai/codex-darwin-arm64/vendor/aarch64-apple-darwin/bin/codex",
    "defaultModel": "gpt-5.1-codex",
    "workingDir": "/workspace/group"
  }
  ```

#### F-B-3：OpenCode 配置存储

- 文件：`data/config/opencode.json`（AES-256-GCM 加密）
- 字段：
  ```json
  {
    "enabled": false,
    "bunPath": "/opt/homebrew/bin/bun",
    "opencodePath": "/Users/xingzhi/opencode/packages/opencode/src/index.ts",
    "host": "127.0.0.1",
    "basePort": 15000,
    "portRange": 100,
    "password": "",
    "providerID": "anthropic",
    "modelID": "claude-sonnet-4-6",
    "workingDir": "/workspace/group"
  }
  ```

#### F-B-4：Codex 引擎适配器（agent-runner 侧）

- `container/agent-runner/src/codex-engine.ts`：
  - `runCodexEngine(containerInput, emit, onSessionId)` 主入口
  - 首轮：spawn `codex exec --json --model M --cd DIR "<prompt>"`
  - 续接：spawn `codex exec --json --model M --cd DIR resume <threadId> "<prompt>"`
  - stdin 输入：对长 prompt 改用 `codex exec --json -` 读 stdin，避免命令行参数过长
  - JSONL 事件映射：

    | Codex JSONL 事件（ThreadEvent.tag="type"） | DeepThink StreamEvent |
    |-----------|----------------------|
    | `thread.started` (含 `thread_id`) | 捕获 `thread_id` → `onSessionId` |
    | `turn.started` | （内部状态） |
    | `item.started` (details.type=`agent_message`) | `text_delta`（初始文本，按 item.id 去重累计） |
    | `item.updated` (details.type=`agent_message`) | `text_delta`（增量文本） |
    | `item.completed` (details.type=`agent_message`) | 文本结束 |
    | `item.started` (details.type=`command_execution`) | `tool_use_start`（toolName=command, toolInput=command） |
    | `item.updated` (details.type=`command_execution`) | `tool_progress`（aggregated_output） |
    | `item.completed` (details.type=`command_execution`) | `tool_use_end`（exit_code==0 为 success） |
    | `item.started` (details.type=`reasoning`) | `thinking_delta` |
    | `item.started` (details.type=`file_change`) | `tool_use_start`（toolName=file_change, toolInput=path 列表） |
    | `item.completed` (details.type=`file_change`) | `tool_use_end` |
    | `item.started` (details.type=`mcp_tool_call`) | `tool_use_start`（toolName=tool, toolInput=arguments） |
    | `item.completed` (details.type=`mcp_tool_call`) | `tool_use_end`（error 字段非空时 success=false） |
    | `item.started` (details.type=`web_search`) | `tool_use_start`（toolName=web_search, toolInput=query） |
    | `item.completed` (details.type=`web_search`) | `tool_use_end` |
    | `turn.completed` (含 `usage`) | `status`（tokens: input/output/cached） + 触发 result 输出 |
    | `turn.failed` (含 `error.message`) | `status` (错误) + result 输出 |
    | `error` (含 `message`) | `status` (错误) + result 输出 |

- 进入 IPC 轮询循环（与 Claude 路径一致）：监听 `/workspace/ipc/input/`，有新消息时 spawn 新 `codex exec --json --model M --cd DIR resume <threadId> "<prompt>"`

#### F-B-5：OpenCode 引擎适配器（agent-runner 侧）

- `container/agent-runner/src/opencode-engine.ts`：
  - `runOpencodeEngine(containerInput, emit, onSessionId)` 主入口
  - 启动 `opencode serve` 子进程：
    - 命令：`bun run <opencodePath> serve --hostname 127.0.0.1 --port <port>`
    - 环境变量：`OPENCODE_SERVER_PASSWORD=<pwd>`、`OPENCODE_SERVER_USERNAME=opencode`
    - 端口在 `[basePort, basePort+portRange)` 内随机选可用端口
  - poll `GET /doc` 直到就绪（最多 30s）
  - 创建 session：`POST /session`（body 可空）→ 得到 `sessionID`（前缀 `ses_`）
  - 订阅 SSE：`GET /event?directory=<workDir>`，异步消费事件流（事件名固定 `message`，data 是 JSON `{id, type, properties}`）
  - 调 `POST /session/:id/message` 发 prompt：body `{ providerID, modelID, parts: [{type:"text", text: message}] }`，鉴权 `Authorization: Basic base64("opencode:<password>")`
  - SSE 事件映射：

    | OpenCode SSE 事件（type 字段） | DeepThink StreamEvent |
    |---------------|----------------------|
    | `message.part.updated` (part.type=`text`) | `text_delta`（累加 fullText） |
    | `message.part.updated` (part.type=`reasoning`) | `thinking_delta` |
    | `message.part.updated` (part.type=`tool`, state.status=`running`) | `tool_use_start` |
    | `message.part.updated` (part.type=`tool`, state.status=`pending`) | `tool_progress` |
    | `message.part.updated` (part.type=`tool`, state.status=`completed`) | `tool_use_end`（success） |
    | `message.part.updated` (part.type=`tool`, state.status=`error`) | `tool_use_end`（failure） |
    | `message.part.updated` (part.type=`step-start`) | （内部状态） |
    | `message.part.updated` (part.type=`step-finish`) | （内部状态） |
    | `session.status` (status.type=`idle`) | 触发 result 输出 |
    | `session.status` (status.type=`busy`/`retry`) | （内部状态，可选 `status` streamEvent） |
    | `session.error` | `status` (错误) + result 输出 |

  - 进入 IPC 轮询循环：监听 `/workspace/ipc/input/`，有新消息时调 `POST /session/:id/message`

#### F-B-6：API 路由

**Codex**：

| 方法 | 路径 | 鉴权 | 说明 |
|------|------|------|------|
| GET | `/api/config/codex` | `manage_system_config` | 获取 Codex 配置（脱敏） |
| PUT | `/api/config/codex` | `manage_system_config` | 保存 Codex 配置 |
| POST | `/api/config/codex/test` | `manage_system_config` | 测试 codex 二进制可用性 |

**OpenCode**：

| 方法 | 路径 | 鉴权 | 说明 |
|------|------|------|------|
| GET | `/api/config/opencode` | `manage_system_config` | 获取 OpenCode 配置（脱敏，password 返回 `has_password: true/false`） |
| PUT | `/api/config/opencode` | `manage_system_config` | 保存 OpenCode 配置 |
| POST | `/api/config/opencode/test` | `manage_system_config` | 测试 opencode serve 启动 |

**引擎切换**（复用现有）：

| 方法 | 路径 | 鉴权 | 说明 |
|------|------|------|------|
| PATCH | `/api/groups/:jid` | group owner | 接受 `engine: 'codex' \| 'opencode'` |

#### F-B-7：Container-Runner 分发

- `runContainerAgent` / `runHostAgent`：
  - 扩展 engine 类型：`'claude' | 'atomcode' | 'codex' | 'opencode'`
  - 当 `engine === 'codex'`：注入 `CODEX_BINARY_PATH`、`CODEX_DEFAULT_MODEL` 环境变量
  - 当 `engine === 'opencode'`：注入 `OPENCODE_BUN_PATH`、`OPENCODE_SOURCE_PATH`、`OPENCODE_PORT`、`OPENCODE_PASSWORD` 环境变量
  - sessions 表查询按 engine 选对应 session_id 列

### 4.2 前端

#### F-F-1：ChatPage 引擎切换器扩展

- 新增选项：`Codex` / `OpenCode`
- 禁用条件：对应引擎全局未 enable 时置灰 + tooltip "请在设置页启用 X 引擎"

#### F-F-2：SettingsPage 新引擎区块

- 新增 "Codex 引擎" Section：二进制路径、默认模型、启用开关、保存、测试连接
- 新增 "OpenCode 引擎" Section：Bun 路径、OpenCode 源码路径、端口范围、密码、启用开关、保存、测试连接

### 4.3 文档

- `docs/prd/codex-opencode-engine/PRD.md`（本文档）
- `docs/tech_solution/codex-opencode-engine/SOLUTION.md`
- `docs/test_report/codex-opencode-engine/TEST_REPORT.md`

## 5. 非功能需求

- **性能**：Codex CLI 进程启动 ≤ 3s；OpenCode serve 启动 ≤ 5s；首条消息端到端延迟 ≤ 5s
- **隔离**：每个 agent-runner 进程的引擎实例独立端口、独立工作目录，互不影响
- **安全**：OpenCode 密码通过 AES-256-GCM 加密存储；UI 脱敏显示
- **兼容**：Claude/AtomCode 引擎行为 100% 不变
- **可观测**：引擎日志写入 `data/groups/{folder}/logs/codex-engine.log` 和 `opencode-engine.log`
- **回滚**：`engine` 列新增取值不影响现有数据；配置文件不存在时默认 `enabled: false`

## 6. 验收标准（端到端）

1. ✅ 宿主机模式：在 admin 主容器（folder=main）中切换到 Codex 引擎，发送 "你好"，收到 Codex 的流式回复
2. ✅ 宿主机模式：切换到 OpenCode 引擎，发送 "你好"，收到 OpenCode 的流式回复
3. ✅ 切换回 Claude 引擎，同一群发消息，Claude SDK 正常工作
4. ✅ 设置页能配置 Codex 参数、测试连接
5. ✅ 设置页能配置 OpenCode 参数、测试连接
6. ✅ Codex 引擎不可用时，用户收到明确错误提示
7. ✅ OpenCode 引擎不可用时，用户收到明确错误提示
8. ✅ `make typecheck` 通过（三端：后端 + 前端 + agent-runner）
9. ✅ `make build` 通过

## 7. 风险

| 风险 | 缓解 |
|------|------|
| Codex CLI JSONL 协议变化 | 锁定 codex 版本；在 codex-engine.ts 加协议版本校验 |
| OpenCode HTTP API 变化 | 锁定 opencode 仓库 commit；在 opencode-engine.ts 加 API 版本校验 |
| OpenCode 需要 Bun 运行时 | 宿主机预装 bun；Docker 镜像需额外安装 bun |
| Codex CLI 每次 spawn 冷启动开销 | 首版接受每次 spawn；后续可优化为 app-server daemon 模式 |
| 不同引擎 session 串号 | sessions 表按 engine 区分查询；新增列默认 NULL，向后兼容 |
| Codex 没有主动 `send_message` 能力 | 与 atomcode 假设 A3 一致；UI 在非 Claude 引擎下隐藏相关提示 |

## 8. 里程碑

| 阶段 | 交付物 |
|------|--------|
| Phase 1：设计 | PRD + 技术方案 |
| Phase 2：后端 | DB 迁移 + runtime-config + routes + container-runner 分发 |
| Phase 3：Agent-Runner | codex-engine.ts + opencode-engine.ts + main() 分支 |
| Phase 4：前端 | ChatPage 切换器扩展 + SettingsPage 新引擎区块 |
| Phase 5：测试 | typecheck + build + E2E 走查 + 测试报告 |
| Phase 6：合并 | 提交 + 合并 main + push |