# 测试报告：Codex/OpenCode 引擎扩展 — MCP 桥接 + Bun 自动安装 + Provider 内置

## 概述

本测试报告覆盖三个扩展需求的实现验证：

1. **MCP 工具桥接**：Codex / OpenCode 引擎下可用 DeepThink 内置 MCP 工具（send_message / schedule_task / memory_*）
2. **Bun 自动安装**：OpenCode 引擎依赖 Bun 运行时，默认自动安装到 `data/bin/`
3. **Provider 配置 UI 内置**：把 `~/.codex/config.toml` 和 `opencode.jsonc` 的 provider 配置内置到 DeepThink UI，动态生成临时 config

## 测试环境

- 项目：`~/deep-think`
- 分支：`feat/codex-opencode-mcp-providers`（基于 main `72d00fb`）
- 日期：2026-07-16
- Node：v22.x
- 平台：darwin 25.2.0（macOS arm64）
- vitest：4.1.1

## 测试矩阵

### 1. TypeScript 类型检查（三端）

**命令**：`make typecheck`

**范围**：
- 后端 `src/`（`npx tsc --noEmit`）
- 前端 `web/`（`npx tsc --noEmit`）
- Agent Runner `container/agent-runner/`（`npx tsc --noEmit`）
- StreamEvent 类型同步校验（`scripts/check-stream-event-sync.sh`）
- prompt 引用解析校验（9 个 prompt 文件）

**结果**：✅ EXIT=0，三端全绿，类型同步校验通过，9/9 prompt 引用解析。

### 2. vitest 测试套件

**命令**：`make test`

**结果**：
- Test Files：92 passed (92)
- Tests：1199 passed (1199)
- Duration：3.39s
- 零回归

### 3. mcp-bridge standalone MCP server 冒烟测试

**命令**：
```bash
DT_CHAT_JID=test:smoke \
DT_GROUP_FOLDER=test \
DT_IS_HOME=true \
DT_IS_ADMIN_HOME=true \
DT_IPC_DIR=/tmp/dt-smoke \
DT_WORKSPACE_GROUP=/tmp/dt-smoke/group \
DT_WORKSPACE_GLOBAL=/tmp/dt-smoke/global \
DT_WORKSPACE_MEMORY=/tmp/dt-smoke/memory \
node dist/mcp-bridge.js
```

**输入**（JSON-RPC over stdio）：
```json
{"jsonrpc":"2.0","id":1,"method":"initialize","params":{"protocolVersion":"2025-06-18","capabilities":{},"clientInfo":{"name":"test","version":"1.0"}}}
{"jsonrpc":"2.0","method":"notifications/initialized"}
{"jsonrpc":"2.0","id":2,"method":"tools/list"}
```

**验证点**：
- ✅ `initialize` 响应 `protocolVersion: 2025-06-18`，`serverInfo.name: deepthink-mcp-bridge`
- ✅ `tools/list` 返回 12 个工具定义（含完整 inputSchema）
- ✅ IS_HOME=true 时 `memory_append` 工具可见
- ✅ IS_HOME=false 时 `memory_append` 隐藏（仅 11 个工具）

**返回的工具列表**：
1. `send_message`
2. `schedule_task`
3. `list_tasks`
4. `pause_task`
5. `resume_task`
6. `cancel_task`
7. `register_group`
8. `install_skill`
9. `uninstall_skill`
10. `memory_append`（条件：IS_HOME && !DISABLE_MEMORY_LAYER）
11. `memory_search`（条件：!DISABLE_MEMORY_LAYER）
12. `memory_get`（条件：!DISABLE_MEMORY_LAYER）

### 4. Bun 自动安装器验证

**实现**：`src/bun-installer.ts`

**关键函数**：
- `ensureBunInstalled(forceCheck?)`：异步下载 `bun-v1.3.14/bun-{os}-{arch}.zip` 到 `data/bin/bun-v1.3.14/`，使用 `unzip` 解压，`chmod 0o755`
- `detectSystemBun()`：通过 `spawn('which', ['bun'])` 检测系统 bun
- `getPlatformAsset()`：`darwin-arm64` → `bun-darwin-arm64.zip`，`linux-x64` → `bun-linux-x64.zip`

**集成点验证**：
- ✅ `src/index.ts` `loadState()` 后非阻塞 `void ensureBunInstalled()` 预热
- ✅ `src/container-runner.ts` 宿主机模式 `runHostAgent` 调用 `await ensureBunInstalled()`
- ✅ 容器模式 `buildVolumeMounts` 在 bunPath 为空时抛 helpful error

### 5. Provider 配置 UI 验证

#### 5.1 CodexEngineSection.tsx

**改动文件**：`web/src/components/settings/CodexEngineSection.tsx`

**验证点**：
- ✅ 新增 `CodexProvider` interface（name / apiKey / baseURL / model）
- ✅ `CodexConfig` 新增 `providers: CodexProvider[]` 字段
- ✅ Provider CRUD UI：add / remove / update
- ✅ 第一个 Provider 标记 "(主)"
- ✅ apiKey 密码输入框，已保存显示 `****<last4>` placeholder
- ✅ save/load 处理 providers 数组
- ✅ 说明文本更新："Provider 配置在 DeepThink 内管理"

#### 5.2 OpencodeEngineSection.tsx

**改动文件**：`web/src/components/settings/OpencodeEngineSection.tsx`

**验证点**：
- ✅ 新增 `OpencodeProvider` interface（id / name / apiKey / baseURL / models[] / hasApiKey?）
- ✅ `OpencodeConfig` 新增 `providers: OpencodeProvider[]` 字段
- ✅ Provider CRUD UI：add / remove / update
- ✅ models 字段以逗号分隔输入
- ✅ apiKey 密码输入框，hasApiKey=true 时显示 placeholder
- ✅ save/load 处理 providers 数组
- ✅ Bun 路径 placeholder 更新："留空让 DeepThink 自动安装"
- ✅ 说明文本更新："Provider 配置在 DeepThink 内管理" + "Bun 未安装时宿主机模式自动下载"

### 6. 后端 API + Zod schema 验证

#### 6.1 runtime-config.ts

**验证点**：
- ✅ `CodexProvider` interface + `providers: CodexProvider[]` 加入 `CodexConfig`
- ✅ `OpencodeProvider` interface + `providers: OpencodeProvider[]` 加入 `OpencodeConfig`
- ✅ `PublicOpencodeConfig` providers 类型：`Array<Omit<OpencodeProvider, 'apiKey'> & { hasApiKey: boolean }>`
- ✅ `sanitizeProviders()` / `sanitizeOpencodeProviders()` helper
- ✅ `toPublicCodexConfig`：apiKey → `****<last4>` 掩除
- ✅ `toPublicOpencodeConfig`：apiKey → `hasApiKey: boolean`

#### 6.2 schemas.ts

**验证点**：
- ✅ `CodexProviderSchema`：name / apiKey / baseURL / model 全 required
- ✅ `OpencodeProviderSchema`：id / name / apiKey / baseURL / models[] 全 required
- ✅ `CodexConfigSchema` / `OpencodeConfigSchema` 新增 `providers` 字段

#### 6.3 routes/config.ts

**验证点**：
- ✅ PUT `/api/config/codex`：provider apiKey 为空或 `****` 开头时保留原值
- ✅ PUT `/api/config/opencode`：同上

### 7. container-runner env 注入验证

**验证点**（grep 容器模式 + 宿主机模式）：
- ✅ `CODEX_PROVIDERS_JSON` 注入（envLines + hostEnv）
- ✅ `OPENCODE_PROVIDERS_JSON` 注入（envLines + hostEnv）
- ✅ `DT_CHAT_JID=web:${folder}` 默认值（agent-runner override 为 containerInput.chatJid）
- ✅ `DT_IPC_DIR` / `DT_GROUP_FOLDER` / `DT_IS_HOME` / `DT_IS_ADMIN_HOME` 注入
- ✅ `DT_WORKSPACE_GROUP` / `DT_WORKSPACE_GLOBAL` / `DT_WORKSPACE_MEMORY` 注入

### 8. agent-runner 配置文件生成验证

#### 8.1 codex-engine.ts

**验证点**：
- ✅ `writeCodexConfig(providersJson, mcpBridgePath, log)` 生成 `data/sessions/{folder}/.codex/config.toml`
- ✅ `[model_providers.deepthink]` 配置 `env_key` 机制（apiKey 通过 env 注入）
- ✅ `[mcp_servers.deepthink]` 配置 `command="node"` `args=[mcp-bridge.js]` `env_vars={DT_*}`
- ✅ `runCodexEngine` 设置 `CODEX_HOME` env 指向生成的临时目录
- ✅ override `DT_CHAT_JID` 为 `containerInput.chatJid`

#### 8.2 opencode-engine.ts

**验证点**：
- ✅ `writeOpencodeConfigFile(providersJson, mcpBridgePath, log)` 生成 `data/sessions/{folder}/.opencode/opencode.jsonc`
- ✅ `provider.{id}` 配置 entries
- ✅ `mcp.deepthink` 配置 `type:"local"` `command:["node", mcp-bridge.js]` `environment:{DT_*}`
- ✅ `runOpencodeEngine` 设置 `OPENCODE_CONFIG` env
- ✅ override `DT_CHAT_JID` 为 `containerInput.chatJid`

## 已知限制

1. **MCP `cloudcli-browser` 工具持续 fetch failed**：浏览器 UI E2E 走查不可用，用 typecheck + vitest + standalone smoke test + 代码 review 替代。
2. **Bun 自动安装仅在宿主机模式**：容器模式 `buildVolumeMounts` 是 sync 函数无法 `await`，容器模式在 bunPath 为空时抛 helpful error 引导用户到设置页。
3. **Provider apiKey 文件存储明文**：使用 0600 权限文件存储（与既有 password 存储模式一致），未做 AES-256-GCM 加密。
4. **DT_CHAT_JID 双重设置**：container-runner 注入默认值 `web:{folder}`，agent-runner 在生成 config 前 override 为 `containerInput.chatJid`。这是 design choice，因为 `buildVolumeMounts` scope 无法访问 containerInput。

## 退出条件

- [x] `make typecheck` EXIT=0
- [x] `make test` 1199/1199 通过零回归
- [x] mcp-bridge standalone smoke test 通过（12 工具正确暴露）
- [x] CodexEngineSection UI Provider CRUD 完整
- [x] OpencodeEngineSection UI Provider CRUD 完整
- [x] container-runner env 注入完整（CODEX_PROVIDERS_JSON / OPENCODE_PROVIDERS_JSON / DT_*）
- [x] agent-runner 生成临时 config.toml / opencode.jsonc 并设置 CODEX_HOME / OPENCODE_CONFIG
- [x] bun-installer 实现完整（下载 + 解压 + chmod 0o755）
- [x] src/index.ts loadState() 后非阻塞预热 Bun

## 结论

✅ **所有三个扩展需求实现完成，测试通过**：

1. **MCP 工具桥接**：mcp-bridge standalone stdio MCP server 实现，12 个 DeepThink 内置工具可通过 IPC 文件桥接到 Codex / OpenCode 引擎。主进程无需改动（已有 IPC 轮询）。
2. **Bun 自动安装**：`ensureBunInstalled()` 实现，宿主机模式自动下载到 `data/bin/bun-v1.3.14/`，后端启动时非阻塞预热。
3. **Provider 配置 UI 内置**：CodexEngineSection / OpencodeEngineSection 新增 Provider CRUD UI，agent-runner 引擎启动时动态生成临时 `config.toml` / `opencode.jsonc`，通过 `CODEX_HOME` / `OPENCODE_CONFIG` env 注入。

零回归：1199/1199 vitest 通过，三端 typecheck 全绿。
