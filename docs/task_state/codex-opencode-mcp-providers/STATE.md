# 任务状态：Codex/OpenCode 引擎扩展 — MCP 桥接 + Bun 自动安装 + Provider 内置

## 当前进度

- [x] PRD 文档：`docs/prd/codex-opencode-mcp-providers/PRD.md`
- [x] 技术方案：`docs/tech_solution/codex-opencode-mcp-providers/SOLUTION.md`
- [x] 创建分支 `feat/codex-opencode-mcp-providers`（基于 main `72d00fb`）
- [x] Phase 1：MCP bridge standalone server
- [x] Phase 2：Codex/OpenCode 引擎注入 MCP 配置
- [x] Phase 3：Bun 自动安装
- [x] Phase 4：Provider 配置 UI + 动态 config 生成
- [x] Phase 5：测试 + 文档 + 提交

## 实施记录

### Step 1：mcp-bridge.ts 独立 MCP server
- 新增 `container/agent-runner/src/mcp-bridge.ts`（~450 行）
- 基于 `@modelcontextprotocol/sdk` 的 `Server` + `StdioServerTransport`
- 12 个工具：send_message / schedule_task / list/pause/resume/cancel_task / register_group / install/uninstall_skill / memory_append(IS_HOME && !DISABLE_MEMORY_LAYER) / memory_search/get(!DISABLE_MEMORY_LAYER)
- 三类实现：Fire-and-forget（messages 目录）、Request-response（tasks 目录 + `{type}_result_{requestId}.json` 轮询）、Direct-file（memory_* 直接 fs）
- **主进程无需改动**：主进程 `src/index.ts` 已有对 `data/ipc/{folder}/messages/` 和 `data/ipc/{folder}/tasks/` 的轮询，mcp-bridge 只需以相同格式写入文件即可
- 环境变量读取：`DT_CHAT_JID / DT_GROUP_FOLDER / DT_IS_HOME / DT_IS_ADMIN_HOME / DT_IPC_DIR / DT_WORKSPACE_GROUP / DT_WORKSPACE_GLOBAL / DT_WORKSPACE_MEMORY / DT_DISABLE_MEMORY_LAYER`

### Step 2：Codex 引擎注入 MCP + Provider 配置
- `container/agent-runner/src/codex-engine.ts`：
  - 新增 `CodexProviderInput` 接口和 `writeCodexConfig()` 函数
  - 生成 `data/sessions/{folder}/.codex/config.toml`：`[model_providers.deepthink]` + `env_key` 机制（apiKey 通过 env 注入）+ `[mcp_servers.deepthink]`（command="node", args=[mcp-bridge.js], env_vars={DT_*}）
  - `runCodexEngine`：override `DT_CHAT_JID` 为 `containerInput.chatJid`（container-runner 的默认值是 `web:{folder}`），调用 writeCodexConfig，设置 `CODEX_HOME` env

### Step 3：OpenCode 引擎注入 MCP + Provider 配置
- `container/agent-runner/src/opencode-engine.ts`：
  - 新增 `OpencodeProviderInput` 接口和 `writeOpencodeConfigFile()` 函数
  - 生成 `data/sessions/{folder}/.opencode/opencode.jsonc`：`provider.{id}` + `mcp.deepthink`（type:"local", command:["node", mcp-bridge.js], environment:{DT_*}）
  - `runOpencodeEngine`：override `DT_CHAT_JID`，调用 writeOpencodeConfigFile，设置 `OPENCODE_CONFIG` env

### Step 4：Bun 自动安装器
- 新增 `src/bun-installer.ts`：
  - `BUN_VERSION = '1.3.14'`，`BUN_INSTALL_ROOT = join(DATA_DIR, 'bin', 'bun-v1.3.14')`
  - `ensureBunInstalled(forceCheck?)`：异步，检查存在 → 下载 zip → `unzip` 解压 → `chmod 0o755` → 缓存路径
  - `detectSystemBun()`：`which bun` via spawn
  - `getPlatformAsset()`：`process.platform`/`process.arch` → asset name 映射
- `src/container-runner.ts` 宿主机模式：`await ensureBunInstalled()` 自动安装，路径保存到 config
- `src/index.ts` `loadState()` 后：非阻塞 `void ensureBunInstalled()` 预热
- 容器模式（同步 buildVolumeMounts）：bunPath 为空时抛 helpful error，引导用户到设置页

### Step 5：Provider 配置 UI + 动态 config 生成
- `web/src/components/settings/CodexEngineSection.tsx`：
  - `CodexProvider` interface + `providers: CodexProvider[]` 加入 `CodexConfig`
  - Provider CRUD：add/remove/update，grid 布局（name/model），baseURL input，password input for apiKey
  - apiKey 掩除码显示：`****<last4>`，已保存显示 placeholder
  - save/load 处理 providers 数组
- `web/src/components/settings/OpencodeEngineSection.tsx`：
  - `OpencodeProvider` interface（含 `models: string[]`）
  - Provider CRUD：id/name/apiKey/baseURL/models（逗号分隔）
  - hasApiKey boolean 标记
  - save/load 处理 providers 数组

### Step 6：后端 API + Zod schema 扩展
- `src/runtime-config.ts`：
  - `CodexProvider` interface + `providers: CodexProvider[]` 加入 `CodexConfig`
  - `OpencodeProvider` interface + `providers: OpencodeProvider[]` 加入 `OpencodeConfig`
  - `PublicOpencodeConfig` 类型：`providers: Array<Omit<OpencodeProvider, 'apiKey'> & { hasApiKey: boolean }>`
  - `sanitizeProviders()` / `sanitizeOpencodeProviders()` helper
  - `toPublicCodexConfig`：apiKey → `****<last4>`
  - `toPublicOpencodeConfig`：apiKey → `hasApiKey: boolean`
- `src/schemas.ts`：
  - `CodexProviderSchema`（name/apiKey/baseURL/model 全 required）
  - `OpencodeProviderSchema`（id/name/apiKey/baseURL/models[] 全 required）
  - `CodexConfigSchema` / `OpencodeConfigSchema` 新增 `providers` 字段
- `src/routes/config.ts`：
  - PUT `/api/config/codex`：provider apiKey 保留逻辑（apiKey 为空或 `****` 开头时保留原值）
  - PUT `/api/config/opencode`：同上

### Step 7：主进程注入 providers env
- `src/container-runner.ts`：
  - 容器模式 `buildVolumeMounts`（sync）：`CODEX_PROVIDERS_JSON` / `OPENCODE_PROVIDERS_JSON` / `DT_CHAT_JID=web:{folder}` / `DT_IPC_DIR=/workspace/ipc` / `DT_GROUP_FOLDER` / `DT_IS_HOME` / `DT_IS_ADMIN_HOME` / `DT_WORKSPACE_GROUP` / `DT_WORKSPACE_GLOBAL` / `DT_WORKSPACE_MEMORY`
  - 宿主机模式 `runHostAgent`（async）：同样 env 注入到 `hostEnv`；OpenCode 自动调用 `ensureBunInstalled()`
  - `DT_CHAT_JID` 默认 `web:{folder}`，由 agent-runner 在启动时 override 为 `containerInput.chatJid`

### Step 8：typecheck + vitest
- `make typecheck` ✅ 三端全绿（后端 + 前端 + agent-runner）
- `make test` ✅ 1199/1199 通过，零回归
- `container/agent-runner/src/mcp-bridge.ts` 编译为 `dist/mcp-bridge.js`（30KB）
- Standalone smoke test：通过 JSON-RPC `initialize` + `tools/list` 验证，返回 12 个工具定义

## 阻塞与决策

### 1. 主进程 IPC 响应器无需改动
**决策**：原计划在 `src/index.ts` 中新增 IPC 响应器，但分析发现主进程已轮询 `data/ipc/{folder}/messages/` 和 `data/ipc/{folder}/tasks/` 目录并处理所有 `{type}_result_{requestId}.json` 响应模式。mcp-bridge 只需以相同格式写入文件，主进程会自动处理。

### 2. Zod v4 zodToJsonSchema 不兼容
**问题**：原计划用 `zodToJsonSchema()` 把 Zod schema 转 JSON schema，但 Zod 4 内部结构变了（`_def.typeName` 不存在）。
**决策**：替换为纯 JSON schema builder helpers（`sString / sNumber / sEnum / sObj`），避免依赖 Zod 内部字段。

### 3. Bun 自动安装仅在宿主机模式
**问题**：容器模式 `buildVolumeMounts` 是 sync 函数，无法 `await`。
**决策**：宿主机模式 `runHostAgent`（async）自动调用 `ensureBunInstalled()`；容器模式在 bunPath 为空时抛 helpful error，引导用户到设置页。

### 4. DT_CHAT_JID 默认值
**问题**：`container-runner.ts` 的 `buildVolumeMounts` scope 无法访问 `containerInput.chatJid`。
**决策**：默认注入 `web:{folder}`，由 `agent-runner` 在生成 config 时 override 为 `containerInput.chatJid`。

## 退出条件验证

- [x] `make typecheck` EXIT=0
- [x] `make test` 1199/1199 通过
- [x] mcp-bridge standalone smoke test 通过（12 工具暴露）
- [x] CodexEngineSection UI 包含 Provider CRUD
- [x] OpencodeEngineSection UI 包含 Provider CRUD
- [x] container-runner 注入 `CODEX_PROVIDERS_JSON` / `OPENCODE_PROVIDERS_JSON` / `DT_*` env vars
- [x] agent-runner 生成临时 `config.toml` / `opencode.jsonc` 并设置 `CODEX_HOME` / `OPENCODE_CONFIG`
- [x] bun-installer 下载 + 解压 + chmod 0o755 实现完成
- [x] `src/index.ts` loadState() 后非阻塞预热 Bun
