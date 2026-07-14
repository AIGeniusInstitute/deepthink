# PRD：引入 AtomCode 作为 DeepThink 第二 Agent 执行引擎

- **版本**：v1.0
- **创建日期**：2026-07-14
- **负责人**：DeepThink 团队
- **分支**：`feat/atomcode-engine`（基于 `main`）

## 1. 背景与目标

### 1.1 背景

DeepThink 目前的 Agent 执行引擎是 Anthropic 官方的 **Claude Agent SDK**（通过 `container/agent-runner` 内部调用 `query()`），仅支持 Claude 系列模型与 Anthropic 兼容端点。

开源项目 **AtomCode**（`~/atomcode`，Rust 实现）提供了一套独立的 Coding Agent 运行时：

- 通过 `atomcode-daemon` 暴露 HTTP/SSE API（默认 `127.0.0.1:13456`）
- 支持 OpenAI / Claude / DeepSeek / GLM / Qwen / Ollama 等 **OpenAI 兼容** provider
- 自带工具集（`read_file` / `write_file` / `edit_file` / `bash` / `grep` / `glob` / `list_directory` / `web_search` / `web_fetch` / `search_replace` / `diagnostics` / `use_skill`）
- 自带 session 管理（`~/.atomcode/sessions/`）、provider 配置（`~/.atomcode/config.toml`）、MCP 配置（`~/.atomcode/mcp.json`）、Skills、Hooks

### 1.2 目标

把 AtomCode 作为 DeepThink 的 **第二 Agent 执行引擎** 接入主聊天对话流，使用户可以：

1. 在主对话框中**无缝切换** Claude 引擎与 AtomCode 引擎
2. 在 Web 设置界面**配置 AtomCode**：二进制路径、daemon 端口、Provider 管理、连接测试

### 1.3 非目标（明确排除）

- ❌ 跨引擎会话历史连续性（详见 §3.1 假设 A2）
- ❌ AtomCode 调用 DeepThink 内置 MCP 工具的桥接（首版不实现，详见 §3.1 假设 A3）
- ❌ 在 Docker 容器内烤入 atomcode 二进制（首版只支持宿主机 bind-mount，详见 §3.1 假设 A1）
- ❌ AtomCode Skills / Hooks / Auth OAuth 的 Web 管理 UI（首版仅做 Provider 管理）
- ❌ 替换 Claude SDK 作为默认引擎（AtomCode 作为可选第二引擎，默认仍是 Claude）

## 2. 用户故事

### US-1：主对话切换引擎

**作为** DeepThink 用户，  
**我希望** 在主对话页面顶部通过下拉选择器切换 Agent 执行引擎（Claude / AtomCode），  
**以便** 在同一对话窗口内尝试不同引擎的输出，对比编码效果。

**验收标准**：
- 对话页头部有引擎切换器，默认显示 "Claude"
- 切换到 "AtomCode" 后，后续发送的消息由 AtomCode 引擎处理
- 切换不丢失对话历史展示（UI 上历史消息仍可见，来自 DB）
- 切换引擎后首条消息提示 "已切换至 X 引擎，新会话开始"
- 切换器状态持久化到该会话（`registered_groups.engine`），刷新页面后保持

### US-2：AtomCode 配置

**作为** DeepThink 管理员，  
**我希望** 在系统设置页配置 AtomCode 二进制路径、daemon 端口、Provider（含 API Key），  
**以便** 不离开 Web 界面即可完成 AtomCode 的全部配置。

**验收标准**：
- 设置页新增 "AtomCode 引擎" 独立区块
- 二进制路径、端口、enable 开关可保存到 `data/config/atomcode.json`
- "测试连接" 按钮可一键 health-check + 列出可用 providers/models
- Provider 管理：列表展示、新增、编辑、删除、设为默认（透传 atomcode-daemon 的 `/providers` API）
- API Key 字段脱敏显示（`has_api_key: true/false`，编辑时才暴露明文输入）

### US-3：引擎不可用时的降级

**作为** 用户，  
**当** 切换到 AtomCode 引擎但 daemon 不可达时，  
**我希望** 收到明确的错误提示，  
**以便** 知道发生了什么而不是看到卡死。

**验收标准**：
- 发送消息时若 daemon 未启动/不可达，Agent 在 10 秒内返回明确错误流式消息："AtomCode daemon 不可达：[原因]。请在设置页检查配置。"
- 不影响 Claude 引擎正常使用

## 3. 关键假设与权衡

### 3.1 假设清单（Think Before Coding 原则）

| ID | 假设 | 原因 | 影响 |
|----|------|------|------|
| A1 | AtomCode 二进制通过宿主机 bind-mount 进 Docker 容器，不在镜像内编译 | 现有 happyclaw agent-browser/claude-code 都是 host-binary 模式；镜像编译 Rust 工具链 + 依赖会让构建时间增加 3-5 分钟，体积 +50MB，迭代成本高 | Docker 部署需要宿主机预装 atomcode；host 模式无影响 |
| A2 | 切换引擎即开新会话（不重放历史） | AtomCode session 格式与 Claude SDK 不兼容；跨引擎重放需要把历史消息灌给新引擎，token 成本高且工具调用上下文会丢失 | 切换引擎后，新引擎不持有对方引擎的会话上下文，但 UI 历史展示不丢失 |
| A3 | AtomCode 引擎不调用 DeepThink 内置 MCP（send_message/schedule_task/memory_*） | AtomCode 有自己的工具集，与 DeepThink MCP 协议不兼容；首版不实现 MCP 桥接 | AtomCode 引擎下，定时任务/记忆系统/主动推送功能不可用；定时任务调度本身仍由主进程执行，但 Agent 输出无法主动 `send_message` |
| A4 | 每个 agent-runner 进程在用 AtomCode 时启动自己的 `atomcode-daemon` 子进程（独立端口） | 简化生命周期管理，避免共享 daemon 的并发会话冲突；启动开销 ~1s 可接受 | 多个 AtomCode 会话并发时会有多个 daemon 进程，端口随机分配 |
| A5 | AtomCode session ID 独立存储（`sessions` 表新增 `atomcode_session_id` 列） | AtomCode session ID 与 Claude SDK session ID 格式不同，不能复用同一字段 | sessions 表 schema 变更，向后兼容（默认 NULL） |
| A6 | Provider 配置由 AtomCode daemon 自己管理（`~/.atomcode/config.toml`），DeepThink 仅做 UI 透传 | AtomCode 有自己的 provider 概念，与 DeepThink Claude provider 池不重合；混合管理会引入映射复杂性 | 设置页的 AtomCode Provider 区与 Claude Provider 区独立 |

### 3.2 权衡

**为什么不在 main 进程启动一个共享 atomcode-daemon？**  
共享 daemon 需要处理多会话并发、会话→端口路由、生命周期跨多个 agent-runner 进程，复杂度大幅上升。每进程独占 daemon 的开销（~30MB 内存 + ~1s 启动）在 DeepThink 当前的并发上限（20 容器）下可接受。

**为什么用 bind-mount 而不是烤镜像？**  
happyclaw 已有先例：`agent-browser` 和 `@anthropic-ai/claude-code` 都是 host-binary + 镜像内全局安装。Rust 工具链 + atomcode 的全部 crate 依赖会让镜像构建时间从 90s 涨到 4-5 分钟，不划算。后续可加 `make build-atomcode-image` 单独提供镜像版本。

## 4. 功能需求

### 4.1 后端

#### F-B-1：数据库 Schema 变更

- `registered_groups` 新增列 `engine TEXT DEFAULT 'claude'`（取值 `'claude' | 'atomcode'`）
- `sessions` 新增列 `atomcode_session_id TEXT`（默认 NULL）
- Schema 版本号 `v43 → v44`

#### F-B-2：AtomCode 配置存储

- 文件：`data/config/atomcode.json`（AES-256-GCM 加密，复用 runtime-config 模式）
- 字段：
  ```json
  {
    "enabled": false,
    "binaryPath": "/Users/xingzhi/.cargo/bin/atomcode-daemon",
    "host": "127.0.0.1",
    "basePort": 14000,
    "portRange": 100,
    "workingDir": "/workspace/group",
    "atomcodeHome": ""
  }
  ```
- `enabled=false` 时，前端切换器置灰，后端拒绝 `engine=atomcode` 的请求

#### F-B-3：AtomCode Daemon 生命周期

- `src/atomcode-daemon-manager.ts`：
  - `startDaemonForGroup(groupFolder, engineConfig)`：随机选端口，spawn `atomcode-daemon --host 127.0.0.1 --port <port>`，设置 `ATOMCODE_HOME`，poll `/health` 直到就绪，返回 `{ baseUrl, process }`
  - `stopDaemon(process)`：SIGTERM → 10s → SIGKILL
  - 健康检查超时：30 秒

#### F-B-4：Agent-Runner 引擎分支

- `container/agent-runner/src/atomcode-engine.ts`：
  - `runAtomcodeEngine(containerInput, emit, onSessionId)` 主入口
  - 启动 daemon → 调 `POST /chat` SSE → 翻译事件 → emit StreamEvent → 处理 IPC follow-up
  - SSE 事件映射：

    | AtomCode 事件 | DeepThink StreamEvent |
    |---------------|----------------------|
    | `text` | `text_delta` |
    | `reasoning` | `thinking_delta` |
    | `tool_start` | `tool_use_start` |
    | `tool_output` | `tool_progress` |
    | `tool_result` | `tool_use_end` |
    | `tokens` | `status` (token usage) |
    | `artifact_start/content/end` | `text_delta` (降级为文本) |
    | `done` | 触发 result 输出 + 捕获 session_id |
    | `error` | `status` (错误) + result 输出 |
    | `stopped` | result 输出 (interrupted) |

- `container/agent-runner/src/index.ts` 的 `main()`：在 Claude SDK `query()` 调用点前分支：
  ```ts
  if (containerInput.engine === 'atomcode') {
    await runAtomcodeEngine(containerInput, emit, ...);
  } else {
    // 现有 Claude SDK 路径
  }
  ```

#### F-B-5：API 路由

| 方法 | 路径 | 鉴权 | 说明 |
|------|------|------|------|
| GET | `/api/config/atomcode` | `manage_system_config` | 获取 AtomCode 配置（脱敏） |
| PUT | `/api/config/atomcode` | `manage_system_config` | 保存 AtomCode 配置 |
| POST | `/api/config/atomcode/test` | `manage_system_config` | 测试 daemon 可达性 |
| GET | `/api/config/atomcode/providers` | `manage_system_config` | 列出 AtomCode providers（透传 daemon `/providers`） |
| POST | `/api/config/atomcode/providers` | `manage_system_config` | 新建 provider（透传 daemon `POST /providers`） |
| PATCH | `/api/config/atomcode/providers/:name` | `manage_system_config` | 更新 provider |
| DELETE | `/api/config/atomcode/providers/:name` | `manage_system_config` | 删除 provider |
| POST | `/api/config/atomcode/providers/:name/default` | `manage_system_config` | 设为默认 |
| GET | `/api/config/atomcode/models` | `manage_system_config` | 列出可用模型 |
| PUT | `/api/groups/:jid/engine` | `manage_group_env` 或群 owner | 切换群的引擎 |

> **注**：Provider 管理接口会先在主进程内启动一个临时 daemon 实例（用 `ATOMCODE_HOME` 指向用户的 `~/.atomcode`），操作完即关闭。

#### F-B-6：Container-Runner 分发

- `runContainerAgent` / `runHostAgent`：
  - 读取 `group.engine`（默认 `'claude'`），写入 `ContainerInput.engine`
  - 若 `engine === 'atomcode'`：读取 atomcode 配置，通过环境变量 `ATOMCODE_BINARY_PATH` / `ATOMCODE_BASE_PORT` / `ATOMCODE_HOME` 注入容器
  - sessions 表查询时，按 engine 选 `session_id` 或 `atomcode_session_id`

### 4.2 前端

#### F-F-1：ChatPage 引擎切换器

- 位置：消息输入框上方工具栏，与 "清空对话" 按钮并列
- 组件：下拉选择器，选项 `Claude` / `AtomCode`
- 状态：绑定到 `useGroupsStore.currentGroupEngine`
- 切换时：调用 `PUT /api/groups/:jid/engine`，成功后更新本地状态
- 禁用：AtomCode 全局未 enable 时置灰 + tooltip "请在设置页启用 AtomCode 引擎"

#### F-F-2：SettingsPage AtomCode 区块

- 位置：设置页新增独立 Section "AtomCode 引擎"
- 字段：
  - 启用开关（`enabled`）
  - 二进制路径（`binaryPath`，文件选择器 + 手动输入）
  - Daemon Host（默认 `127.0.0.1`）
  - 起始端口（`basePort`，默认 14000）
  - ATOMCODE_HOME（可选，留空使用容器默认 `~/.atomcode`）
- 操作按钮：
  - 保存
  - 测试连接（调用 `/test`，展示 health + providers 数量 + 默认模型）
- 子区块：Provider 管理（列表 + 新增表单 + 编辑/删除/设默认按钮）
  - 新增表单字段：name、type（openai/claude/ollama）、model、api_key、base_url、context_window、max_tokens、thinking_enabled、thinking_budget、set_default

#### F-F-3：API 客户端 & Store

- `web/src/api.ts`：新增 atomcode config + providers + engine switch 接口
- `web/src/store/groups.ts`（或新建 `engine.ts`）：追踪每个 group 的 `engine` 字段，切换后本地立即更新

### 4.3 文档

- `docs/prd/atomcode-engine/PRD.md`（本文档）
- `docs/tech_solution/atomcode-engine/SOLUTION.md`
- `docs/test_report/atomcode-engine/TEST_REPORT.md`

## 5. 非功能需求

- **性能**：AtomCode daemon 启动到 health 就绪 ≤ 5s；首条消息端到端延迟 ≤ 3s
- **隔离**：每个 agent-runner 进程的 daemon 独立端口、独立 `ATOMCODE_HOME`，互不影响
- **安全**：API Key 通过 AES-256-GCM 加密存储；UI 脱敏显示；Provider 操作仅 admin 可见
- **兼容**：Claude 引擎行为 100% 不变；不引入触发词、不改变现有消息路由
- **可观测**：atomcode-daemon 日志写入 `data/groups/{folder}/logs/atomcode-daemon.log`
- **回滚**：`engine` 列默认 `'claude'`，升级后所有现有群保持原行为；DB 迁移可逆（列保留不删）

## 6. 验收标准（端到端）

1. ✅ 宿主机模式：在 admin 主容器（folder=main）中切换到 AtomCode 引擎，发送 "你好"，收到 AtomCode 的流式回复
2. ✅ Docker 模式：bind-mount atomcode 二进制后，普通群切换 AtomCode 引擎发消息，收到流式回复
3. ✅ 切换回 Claude 引擎，同一群发消息，Claude SDK 正常工作（不受影响）
4. ✅ 设置页能配置 AtomCode binary path、测试连接、增删 Provider
5. ✅ AtomCode daemon 不可达时，用户收到明确错误提示而非卡死
6. ✅ `make typecheck` 通过（三端：后端 + 前端 + agent-runner）
7. ✅ `make build` 通过

## 7. 风险

| 风险 | 缓解 |
|------|------|
| AtomCode daemon SSE 协议变化 | 锁定 atomcode 仓库 commit；在 atomcode-engine.ts 加协议版本校验 |
| 不同引擎 session 串号 | sessions 表按 engine 区分查询；新增列默认 NULL，向后兼容 |
| Docker 容器内 atomcode 二进制路径与宿主机不一致 | bind-mount 到固定容器路径 `/usr/local/bin/atomcode-daemon`，代码读环境变量 `ATOMCODE_BINARY_PATH` |
| AtomCode 没有主动 `send_message` 能力（A3 假设） | UI 在 AtomCode 引擎模式下隐藏/禁用相关提示；定时任务执行时提示 "AtomCode 引擎不支持主动推送" |

## 8. 里程碑

| 阶段 | 交付物 |
|------|--------|
| Phase 1：设计 | PRD + 技术方案 |
| Phase 2：后端 | DB 迁移 + runtime-config + routes + container-runner 分发 |
| Phase 3：Agent-Runner | atomcode-engine.ts + main() 分支 |
| Phase 4：前端 | ChatPage 切换器 + SettingsPage AtomCode 区块 |
| Phase 5：测试 | typecheck + build + E2E 走查 + 测试报告 |
| Phase 6：合并 | 提交 + 合并 main + push |
