# PRD：Codex/OpenCode 引擎扩展 — MCP 工具桥接 + Bun 自动安装 + Provider 配置内置

## 1. 背景

在第一阶段（commit `e1e120c` / merge `72d00fb`）中，我们已成功将 Codex 与 OpenCode 作为 DeepThink 的第三、第四执行引擎接入。但实际使用中暴露出 3 个阻塞问题：

### 1.1 问题一：DeepThink 内置 MCP 工具不可用

Claude 引擎下 Agent 可使用 12 个 DeepThink 内置 MCP 工具（`send_message` / `schedule_task` / `list_tasks` / `pause_task` / `resume_task` / `cancel_task` / `register_group` / `install_skill` / `uninstall_skill` / `memory_append` / `memory_search` / `memory_get`），通过 SDK `createSdkMcpServer()` 以同进程模式注册。

Codex CLI 与 OpenCode serve 各自有自己的 MCP 配置机制，无法直接复用 SDK MCP server。当前实现中：
- Codex 引擎调用 `codex exec`，不会加载 DeepThink MCP 工具
- OpenCode 引擎调用 `bun run ... serve`，同样不会加载 DeepThink MCP 工具

结果：用户在 Codex/OpenCode 引擎下无法主动发消息、无法设定时任务、无法写入长期记忆，引擎能力被严重削弱。

### 1.2 问题二：OpenCode 依赖 Bun 运行时需用户预装

OpenCode 引擎要求宿主机预装 Bun 运行时（`bun --version` 可用），用户必须手动从 https://bun.sh 安装。这违反「开箱即用」原则，未提供 Bun 的机器无法启用 OpenCode 引擎。

### 1.3 问题三：Provider 配置割裂

Codex 和 OpenCode 都需要 LLM provider 配置：
- Codex 通过 `~/.codex/config.toml` 配置 model provider（API key、base URL、model name 等）
- OpenCode 通过 `opencode.jsonc` 的 `provider` 字段配置

当前 DeepThink 设置页只配置了引擎二进制路径，用户仍需手动编辑 `~/.codex/config.toml` 和 `opencode.jsonc`，体验割裂。更严重的是，多用户/多群组场景下 `~/.codex` 与 `opencode.jsonc` 是全局共享的，无法做到 per-user 隔离。

## 2. 目标

### 2.1 目标一：MCP 工具桥接

让 Codex/OpenCode 引擎下的 Agent 也能调用 DeepThink 内置 MCP 工具（至少 `send_message` / `schedule_task` / `memory_*` 三个核心类别）。

### 2.2 目标二：Bun 自动安装

OpenCode 引擎启动前若检测到 Bun 缺失，自动从 GitHub Releases 下载安装到 DeepThink data 目录，无需用户手动操作。

### 2.3 目标三：Provider 配置内置

将 Codex/OpenCode 的 LLM provider 配置（apiKey、baseURL、model）内置到 DeepThink 设置页：
- 设置页提供表单管理 provider 配置
- 引擎启动时动态生成临时 config 文件（`config.toml` / `opencode.jsonc`）
- 通过环境变量 `CODEX_HOME` / `OPENCODE_CONFIG` 指向 DeepThink 生成的文件，实现 per-user 隔离

## 3. 功能需求

### 3.1 MCP 工具桥接

#### 3.1.1 独立 stdio MCP Server

在 `container/agent-runner/src/` 下新建 `mcp-bridge.ts`，作为独立可执行进程：

- 通过 stdin/stdout 实现 MCP 协议（JSON-RPC 2.0）
- 实现以下工具（与 `mcp-tools.ts` 对齐，但通过 IPC 文件与主进程通信）：
  - `send_message` (text)
  - `schedule_task` (schedule_type, schedule_value, prompt, ...)
  - `list_tasks` / `pause_task` / `resume_task` / `cancel_task`
  - `register_group` (admin only)
  - `install_skill` / `uninstall_skill`
  - `memory_append` / `memory_search` / `memory_get`
- 读取环境变量 `DT_GROUP_FOLDER` / `DT_IS_HOME` / `DT_IS_ADMIN_HOME` / `DT_IPC_DIR` 获取上下文
- 通过 IPC 文件（`data/ipc/{folder}/messages/*.json` / `tasks/*.json`）与主进程通信，等待响应文件出现
- 响应文件命名约定：`{requestId}.response.json`，读取后立即删除
- 超时 30s 无响应则返回错误

#### 3.1.2 Codex 引擎注入 MCP 配置

`codex-engine.ts` 启动 codex 进程前，生成临时 `$CODEX_HOME/config.toml`：

```toml
[model_providers.deepthink]
name = "deepthink"
base_url = "..."  # 由 provider config 决定

[mcp_servers.deepthink]
command = "node"
args = ["/path/to/agent-runner/dist/mcp-bridge.js"]
env_vars = { DT_GROUP_FOLDER = "...", DT_IPC_DIR = "..." }
```

通过 `CODEX_HOME` 环境变量指向 DeepThink 生成的临时目录（`data/sessions/{folder}/.codex/`）。

#### 3.1.3 OpenCode 引擎注入 MCP 配置

`opencode-engine.ts` 启动 serve 前，生成临时 `opencode.jsonc`：

```jsonc
{
  "mcp": {
    "deepthink": {
      "type": "local",
      "command": ["node", "/path/to/mcp-bridge.js"],
      "environment": { "DT_GROUP_FOLDER": "...", "DT_IPC_DIR": "..." }
    }
  },
  "provider": { ... }
}
```

通过 `OPENCODE_CONFIG` 环境变量指向该文件路径。

#### 3.1.4 主进程 IPC 响应器扩展

`src/index.ts` 的 IPC 文件监听器扩展，识别 `mcp-bridge` 请求类型，在工具执行完成后写入响应文件。复用现有 `mcp-tools.ts` 中工具实现逻辑（通过抽取共享 handler）。

### 3.2 Bun 自动安装

#### 3.2.1 安装逻辑

在 `src/runtime-config.ts` 或新建 `src/bun-installer.ts` 中实现：

- `ensureBunInstalled(): Promise<{bunPath: string, installed: boolean}>`
- 检测现有 bun：优先 `getOpencodeConfig().bunPath`，其次 PATH 中的 `bun --version`
- 若缺失：从 `https://github.com/oven-sh/bun/releases/latest/download/bun-{os}-{arch}.zip` 下载
  - os/platform 判断：`process.platform` (`darwin`/`linux`) + `process.arch` (`arm64`/`x64`)
  - 下载到 `data/bin/bun-{version}/` 解压
  - 赋予执行权限 `0o755`
  - 返回路径 `data/bin/bun-{version}/bun`
- 安装失败时抛错，由调用方决定是否阻塞引擎启动

#### 3.2.2 调用时机

- 后端启动时（`src/index.ts` `loadState()`）：异步触发 `ensureBunInstalled()`，不阻塞启动
- OpenCode 引擎启动前：同步等待 `ensureBunInstalled()` 完成，写入 `bunPath` 到 config
- OpenCode 测试连通性按钮：调用前确保已安装

#### 3.2.3 配置自动填充

`getOpencodeConfig()` 在 `bunPath` 为空时，自动调用 `ensureBunInstalled()` 填充，并持久化保存。

### 3.3 Provider 配置内置

#### 3.3.1 Codex Provider 配置

扩展 `CodexConfig`：

```ts
interface CodexProvider {
  name: string;           // provider 名（如 anthropic / openai / deepseek）
  apiKey: string;         // AES-256-GCM 加密存储
  baseURL: string;        // API base URL
  model: string;          // 默认 model
}

interface CodexConfig {
  enabled: boolean;
  binaryPath: string;
  defaultModel: string;
  workingDir: string;
  providers: CodexProvider[];   // 新增
}
```

设置页 `CodexEngineSection` 增加 providers 列表（CRUD），apiKey 输入框（masked），baseURL/model 输入框。

#### 3.3.2 OpenCode Provider 配置

扩展 `OpencodeConfig`：

```ts
interface OpencodeProvider {
  id: string;              // provider ID（如 anthropic）
  name: string;            // 显示名
  apiKey: string;          // AES-256-GCM 加密存储
  baseURL: string;
  models: string[];        // 可选 model 列表
}

interface OpencodeConfig {
  // ... 原有字段
  providers: OpencodeProvider[];  // 新增
}
```

设置页 `OpencodeEngineSection` 增加 providers 管理。

#### 3.3.3 配置文件动态生成

**Codex**：

引擎启动前在 `data/sessions/{folder}/.codex/config.toml` 写入：

```toml
model = "<defaultModel>"
model_provider = "deepthink-provider-0"

[model_providers.deepthink-provider-0]
name = "deepthink-provider-0"
base_url = "<baseURL>"
env_key = "DEEPTHINK_CODEX_API_KEY"  # 通过 env 注入 apiKey

[mcp_servers.deepthink]
command = "node"
args = [".../mcp-bridge.js"]
env_vars = { DT_GROUP_FOLDER = "...", DT_IPC_DIR = "..." }
```

通过 `CODEX_HOME=data/sessions/{folder}/.codex` 注入。

**OpenCode**：

在 `data/sessions/{folder}/.opencode/opencode.jsonc` 写入：

```jsonc
{
  "provider": {
    "deepthink-provider-0": {
      "name": "...",
      "api_key": "...",  // 明文写入临时文件，文件权限 0600
      "base_url": "..."
    }
  },
  "mcp": {
    "deepthink": {
      "type": "local",
      "command": ["node", ".../mcp-bridge.js"],
      "environment": { "DT_GROUP_FOLDER": "...", "DT_IPC_DIR": "..." }
    }
  }
}
```

通过 `OPENCODE_CONFIG=data/sessions/{folder}/.opencode/opencode.jsonc` 注入。

#### 3.3.4 隔离

- per-group 独立的 `data/sessions/{folder}/.codex/` 与 `.opencode/` 目录
- 多群组并发执行互不干扰
- 临时文件在引擎结束后保留（用于会话 resume），由后续清理逻辑处理

## 4. 非功能需求

### 4.1 安全

- apiKey 通过 AES-256-GCM 加密存储于 `data/config/`
- 临时 config 文件权限 0600，目录 0700
- mcp-bridge 进程不直接读取 `data/config/`，仅通过 IPC 与主进程通信
- IPC 响应文件路径通过 `DT_IPC_DIR` 环境变量注入，不可跨组访问

### 4.2 性能

- Bun 下载仅在首次启用 OpenCode 时触发，后续走缓存
- MCP 工具请求 30s 超时，避免 Agent 卡死
- 临时 config 文件仅在首次启动或配置变更时重写

### 4.3 兼容性

- 已有 Codex/OpenCode 配置（`~/.codex/config.toml`）保留，DeepThink 生成的临时配置优先级更高（通过 `CODEX_HOME` 整体覆盖）
- 用户仍可手动编辑 `~/.codex/config.toml` 用于自定义场景，DeepThink 不主动读取

### 4.4 可观测

- Bun 安装日志写入 `logs/bun-install.log`
- MCP 请求/响应记录到 `data/ipc/{folder}/mcp-bridge-logs/`（调试用，可关闭）
- 引擎启动时日志输出实际使用的 config 文件路径

## 5. 验收标准

### 5.1 MCP 工具桥接

- [ ] Codex 引擎下 Agent 调用 `send_message("hello")`，目标群组收到消息
- [ ] Codex 引擎下 Agent 调用 `schedule_task(schedule_type="once", ...)`，任务出现在 DeepThink 任务列表
- [ ] Codex 引擎下 Agent 调用 `memory_append("...")`，内容写入对应日期记忆文件
- [ ] OpenCode 引擎下同样三个工具可调用并生效
- [ ] MCP 工具请求 30s 超时机制生效（模拟无响应场景）

### 5.2 Bun 自动安装

- [ ] 在无 Bun 的机器上启用 OpenCode 引擎，5 分钟内自动完成下载安装
- [ ] 已有 Bun 的机器不重复下载
- [ ] 下载失败时 OpenCode 测试按钮明确报错
- [ ] `getOpencodeConfig()` 返回的 `bunPath` 自动填充

### 5.3 Provider 配置内置

- [ ] 设置页 Codex 区域可配置多个 provider（apiKey/baseURL/model）
- [ ] 设置页 OpenCode 区域可配置多个 provider
- [ ] Codex 引擎启动后，Agent 使用配置的 provider 完成对话
- [ ] OpenCode 引擎启动后，Agent 使用配置的 provider 完成对话
- [ ] per-group 隔离：两个群组配置不同 provider，互不串扰

### 5.4 回归

- [ ] `make typecheck` 三端通过
- [ ] `make test` 1199+ vitest 全过
- [ ] Claude/AtomCode 引擎行为无回归
- [ ] 数据库 schema v52（如需新增列）

## 6. 排期

| 阶段 | 内容 | 工时 |
|------|------|------|
| Phase 1 | MCP bridge standalone server + IPC 响应器 | 4h |
| Phase 2 | Codex/OpenCode 引擎注入 MCP 配置 | 2h |
| Phase 3 | Bun 自动安装 | 1.5h |
| Phase 4 | Provider 配置 UI + 动态 config 生成 | 3h |
| Phase 5 | 测试 + 文档 + 提交 | 2h |

总计：约 12.5h。

## 7. 风险

| 风险 | 概率 | 缓解 |
|------|------|------|
| MCP 协议版本不兼容 | 中 | 锁定 MCP SDK 版本，与 Claude Agent SDK 对齐 |
| Bun 下载 URL 变更 | 低 | 优先尝试 `releases/latest/download/` 302 重定向，失败再走 `api.github.com` |
| Codex config.toml schema 变更 | 中 | 用最小必需字段，不依赖可选字段 |
| OpenCode 临时 config 文件权限 | 低 | 文件创建后立即 `fs.chmod(0o600)` |
| apiKey 明文写入临时 config | 中 | 临时文件路径不可预测（含 folder hash），权限 0600，会话结束后可选清理 |
