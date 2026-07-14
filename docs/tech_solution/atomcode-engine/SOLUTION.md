# 技术方案：AtomCode 引擎接入 DeepThink

- **版本**：v1.0
- **创建日期**：2026-07-14
- **分支**：`feat/atomcode-engine`

## 1. 架构总览

```
┌────────────────────────────────────────────────────────────┐
│  DeepThink 主进程 (src/index.ts)                          │
│  - routes/config.ts: /api/config/atomcode/* (admin)       │
│  - routes/groups.ts: PATCH /api/groups/:jid (含 engine)    │
│  - atomcode-daemon-manager.ts: 启动/停止 daemon (配置用)  │
│  - runtime-config.ts: getAtomcodeConfig/saveAtomcodeConfig │
│  - container-runner.ts: 根据 group.engine 分发             │
└───────────────────┬────────────────────────────────────────┘
                    │ stdin: ContainerInput {engine:'atomcode', ...}
                    │ env: ATOMCODE_BINARY_PATH, ATOMCODE_HOME, ...
                    ▼
┌────────────────────────────────────────────────────────────┐
│  Agent Runner (container/agent-runner)                      │
│  index.ts main() 分支:                                    │
│    if engine === 'atomcode':                              │
│       → atomcode-engine.ts:runAtomcodeEngine()             │
│    else:                                                   │
│       → 现有 Claude SDK query()                            │
└───────────────────┬────────────────────────────────────────┘
                    │ spawn atomcode-daemon --port <random>
                    │ POST /chat (SSE)
                    ▼
┌────────────────────────────────────────────────────────────┐
│  atomcode-daemon (Rust)                                    │
│  - HTTP/SSE on 127.0.0.1:<port>                           │
│  - ATOMCODE_HOME=~/.atomcode (独立 sessions/providers)     │
│  - /chat SSE: text/reasoning/tool_*/tokens/done/error    │
└────────────────────────────────────────────────────────────┘
```

## 2. 模块变更清单

### 2.1 数据库层（`src/db.ts`）

**新增列**：
```ts
ensureColumn('registered_groups', 'engine', "TEXT DEFAULT 'claude'");
ensureColumn('sessions', 'atomcode_session_id', 'TEXT');
```

**Schema 版本**：`v43 → v44`

**类型扩展**（`RegisteredGroup`、`SessionRow`）：增加 `engine`、`atomcodeSessionId` 字段。

**`getRegisteredGroup` / `setRegisteredGroup`**：读写 `engine` 字段。

**`getSession` / `setSession`**：扩展为按 engine 读写对应 session_id 列。新增 `getAtomcodeSessionId(groupFolder, agentId)` / `setAtomcodeSessionId(groupFolder, agentId, sid)` 工具函数。

### 2.2 配置存储（`src/runtime-config.ts`）

```ts
export interface AtomcodeConfig {
  enabled: boolean;
  binaryPath: string;        // 默认 '/usr/local/bin/atomcode-daemon' (容器) 或 ~/.cargo/bin/atomcode-daemon (host)
  host: string;              // 默认 '127.0.0.1'
  basePort: number;         // 默认 14000
  portRange: number;        // 默认 100
  atomcodeHome: string;     // 默认 ''，空则使用容器默认 ~/.atomcode
  defaultProvider?: string; // 可选，写入 config.toml 的 default_provider
}

export function getAtomcodeConfig(): AtomcodeConfig;
export function saveAtomcodeConfig(cfg: AtomcodeConfig): void;
export function toPublicAtomcodeConfig(cfg: AtomcodeConfig): PublicAtomcodeConfig; // 脱敏版
```

文件位置：`data/config/atomcode.json`，AES-256-GCM 加密（复用现有 `encryptConfigFile`/`decryptConfigFile`）。

### 2.3 Daemon 管理器（`src/atomcode-daemon-manager.ts`，新文件）

```ts
export interface AtomcodeDaemonInstance {
  baseUrl: string;          // http://127.0.0.1:<port>
  process: ChildProcess;
  port: number;
}

export async function startAtomcodeDaemon(opts: {
  binaryPath: string;
  port: number;
  atomcodeHome?: string;
  workingDir?: string;
  logFile?: string;
  timeoutMs?: number;       // 默认 30000
}): Promise<AtomcodeDaemonInstance>;

export async function stopAtomcodeDaemon(inst: AtomcodeDaemonInstance): Promise<void>;

export async function checkAtomcodeHealth(baseUrl: string, timeoutMs?: number): Promise<{
  ok: boolean;
  version?: string;
  error?: string;
}>;
```

**生命周期**：
- `startAtomcodeDaemon` spawn `atomcode-daemon --host 127.0.0.1 --port <port>`，环境变量注入 `ATOMCODE_HOME`
- 每 200ms poll `/health`，30s 超时
- stderr 写入 `data/groups/{folder}/logs/atomcode-daemon.log`
- `stopAtomcodeDaemon`：SIGTERM → 10s → SIGKILL

### 2.4 API 路由（`src/routes/config.ts`）

新增路由（均要求 `systemConfigMiddleware`）：

```ts
configRoutes.get('/atomcode', ...);    // 获取脱敏配置
configRoutes.put('/atomcode', ...);    // 保存配置
configRoutes.post('/atomcode/test', ...); // 启动临时 daemon + health + 列 providers
configRoutes.get('/atomcode/providers', ...);  // 透传 daemon GET /providers
configRoutes.post('/atomcode/providers', ...); // 透传 daemon POST /providers
configRoutes.patch('/atomcode/providers/:name', ...);
configRoutes.delete('/atomcode/providers/:name', ...);
configRoutes.post('/atomcode/providers/:name/default', ...);
configRoutes.get('/atomcode/models', ...);     // 透传 GET /models
```

**Provider 管理流程**：
1. 启动一个临时 daemon 实例（`ATOMCODE_HOME` 指向用户配置的 home 目录），端口随机
2. 等待 health 就绪
3. 转发请求到该 daemon
4. 关闭 daemon（`stopAtomcodeDaemon`）

### 2.5 Groups 路由（`src/routes/groups.ts`）

扩展 `PATCH /:jid`：接受 `engine` 字段，写入 `registered_groups.engine`。

切换 engine 时**清空该 group 的 session**（因为新引擎需要新 session）：
```ts
if (engine !== undefined && engine !== existing.engine) {
  deleteSession(group.folder, input.agentId);
  // setSession 会在新引擎首次运行时自动写入对应 session_id
}
```

### 2.6 Container-Runner（`src/container-runner.ts`）

**`ContainerInput` 接口**：新增 `engine?: 'claude' | 'atomcode'`。

**`runContainerAgent` / `runHostAgent`**：
- 从 `group.engine ?? 'claude'` 读取，写入 `input.engine`
- 当 `engine === 'atomcode'`：
  - 注入环境变量：
    ```
    ATOMCODE_BINARY_PATH=<binaryPath>
    ATOMCODE_BASE_PORT=<basePort>
    ATOMCODE_PORT_RANGE=<portRange>
    ATOMCODE_HOME=<home 或 ''>
    ATOMCODE_WORKING_DIR=<groupDir>
    ```
  - session 查询使用 `atomcode_session_id` 列（通过 `getAtomcodeSessionId`）；运行结束后 `setAtomcodeSessionId`
  - 跳过 Claude SDK 相关的 preflight（`resolveBundledClaudeCli` 等），但仍允许 atomcode-engine.ts 在容器内调用

### 2.7 Agent-Runner 引擎分支（`container/agent-runner/src/index.ts`）

在 `main()` 中，读取 stdin 后立即分支：

```ts
const engine = (containerInput.engine ?? 'claude') as 'claude' | 'atomcode';
if (engine === 'atomcode') {
  // 不需要 CLAUDE_MODEL 检查，也不需要 Claude SDK MCP
  await runAtomcodeEngine({ containerInput, writeOutput, /* emit, processor */ });
  process.exit(0);
}
// 原有 Claude SDK 路径
if (!CLAUDE_MODEL) { ... fail-fast ... }
```

### 2.8 AtomCode 引擎适配器（`container/agent-runner/src/atomcode-engine.ts`，新文件）

核心函数：

```ts
export async function runAtomcodeEngine(opts: {
  containerInput: ContainerInput;
  writeOutput: (out: ContainerOutput) => void;
  workDir: string;
}): Promise<void>;
```

**流程**：
1. 读取环境变量 `ATOMCODE_BINARY_PATH` / `ATOMCODE_BASE_PORT` / `ATOMCODE_HOME`
2. 选随机端口：`basePort + Math.floor(Math.random() * portRange)`
3. 启动 `atomcode-daemon` 子进程，stderr 写日志文件
4. poll `/health` 直到就绪
5. 发首条消息：`POST /chat` with `{message, working_dir, session_id?}`
6. 解析 SSE 流，对每个事件调用对应的 `emit`：
   - `text` → emit `StreamEvent.text_delta`
   - `reasoning` → emit `StreamEvent.thinking_delta`
   - `tool_start` → emit `StreamEvent.tool_use_start`
   - `tool_output` → emit `StreamEvent.tool_progress`
   - `tool_result` → emit `StreamEvent.tool_use_end`
   - `tokens` → emit `StreamEvent.status` (token usage)
   - `done` → 捕获 `session_id`，emit final result via `writeOutput({status:'success', result:..., newSessionId:...})`
   - `error` → emit error result
   - `stopped` → emit interrupted result
7. 进入 IPC 轮询循环（与 Claude 路径一致）：监听 `/workspace/ipc/input/` 目录，有新消息时调 `POST /chat` 续聊
8. `_close` sentinel → 关闭 daemon → exit

**SSE 解析**：使用 Node 内置 `http`/`https` + 手写 SSE parser（避免新依赖；atomcode-daemon 是 loopback HTTP）。

**事件映射到 StreamEvent**：复用 `StreamEventProcessor` 的 `emit` 方法（如果可访问），或直接构造 StreamEvent JSON 通过 `writeOutput({streamEvent: ...})`。

### 2.9 前端 API & Store

**`web/src/api.ts`**（新增方法）：
```ts
export const atomcodeApi = {
  getConfig: () => api.get('/api/config/atomcode'),
  saveConfig: (cfg) => api.put('/api/config/atomcode', cfg),
  test: () => api.post('/api/config/atomcode/test'),
  listProviders: () => api.get('/api/config/atomcode/providers'),
  createProvider: (p) => api.post('/api/config/atomcode/providers', p),
  patchProvider: (name, p) => api.patch(`/api/config/atomcode/providers/${name}`, p),
  deleteProvider: (name) => api.delete(`/api/config/atomcode/providers/${name}`),
  setDefaultProvider: (name) => api.post(`/api/config/atomcode/providers/${name}/default`),
  listModels: () => api.get('/api/config/atomcode/models'),
};

export const groupsApi = {
  switchEngine: (jid, engine) => api.patch(`/api/groups/${jid}`, { engine }),
};
```

**`web/src/stores/groups.ts`**：扩展 group 类型含 `engine`，新增 `switchEngine(jid, engine)` action。

### 2.10 前端 UI

**ChatPage 引擎切换器**：
- 在 `MessageInput` 组件上方（或 ChatView header）加一个紧凑的下拉选择器
- 选项 `Claude` / `AtomCode`，禁用条件：AtomCode 全局未 enable
- 切换时调用 `switchEngine(jid, engine)`，成功后 toast 提示

**SettingsPage 新增 Section**：
- `AtomcodeEngineSection.tsx`：配置表单 + 测试按钮 + Provider 管理子组件
- `AtomcodeProviderList.tsx`：Provider 列表 + 增删改
- 注册到 `SettingsNav.tsx`（key `'atomcode'`）和 `SettingsPage.tsx` 的 tab 路由
- 类型扩展：`SettingsTab` union 加 `'atomcode'`

## 3. 关键代码片段

### 3.1 SSE 流解析（atomcode-engine.ts 核心）

```ts
async function* parseSseStream(response: Response): AsyncGenerator<AtomcodeSseEvent> {
  const reader = response.body!.getReader();
  const decoder = new TextDecoder();
  let buffer = '';
  while (true) {
    const { done, value } = await reader.read();
    if (done) break;
    buffer += decoder.decode(value, { stream: true });
    const events = buffer.split('\n\n');
    buffer = events.pop() || '';
    for (const ev of events) {
      const lines = ev.split('\n');
      const dataLine = lines.find(l => l.startsWith('data:'));
      if (!dataLine) continue;
      const json = JSON.parse(dataLine.slice(5).trim());
      yield json as AtomcodeSseEvent;
    }
  }
}
```

### 3.2 Container-Runner engine 注入

```ts
// src/container-runner.ts 内 runHostAgent
const engine = (group.engine ?? 'claude') as 'claude' | 'atomcode';
const dockerInput: ContainerInput = { ...input, engine };
if (engine === 'atomcode') {
  const cfg = getAtomcodeConfig();
  hostEnv['ATOMCODE_BINARY_PATH'] = cfg.binaryPath;
  hostEnv['ATOMCODE_BASE_PORT'] = String(cfg.basePort);
  hostEnv['ATOMCODE_PORT_RANGE'] = String(cfg.portRange);
  hostEnv['ATOMCODE_HOME'] = cfg.atomcodeHome || '';
  hostEnv['ATOMCODE_WORKING_DIR'] = groupDir;
  // session: use atomcode_session_id
  const atomcodeSid = getAtomcodeSessionId(group.folder, input.agentId || '');
  if (atomcodeSid) dockerInput.sessionId = atomcodeSid;
}
```

### 3.3 DB migration

```ts
// db.ts ensureColumn 区
ensureColumn('registered_groups', 'engine', "TEXT DEFAULT 'claude'");
ensureColumn('sessions', 'atomcode_session_id', 'TEXT');
```

## 4. 测试策略

### 4.1 单元测试
- `tests/units/atomcode-sse.test.ts`：SSE 解析器单元测试（用模拟 SSE 流验证事件翻译）
- `tests/units/atomcode-config.test.ts`：配置文件加密/解密往返

### 4.2 集成测试
- `make typecheck`：三端类型一致性
- `make build`：全量构建通过
- 手动 E2E：
  1. 设置页配置 atomcode binary path（host 模式 `~/.cargo/bin/atomcode-daemon`）
  2. 测试连接 → 收到 health + providers 数量
  3. 添加一个 provider（openai-compatible，可指向 DeepThink 自身的 Claude provider base_url）
  4. 主对话切换到 AtomCode 引擎
  5. 发送 "你好" → 收到流式回复
  6. 切换回 Claude → 发送消息 → 正常
  7. 关闭 daemon 进程模拟 → 发消息 → 收到错误提示

### 4.3 验收标准
见 PRD §6。

## 5. 回滚策略

- DB 列默认值 `'claude'` 保证升级后现有群行为不变
- `engine` 字段缺失时（旧 client），后端默认 `'claude'`
- 配置文件 `atomcode.json` 不存在时，`getAtomcodeConfig()` 返回 `enabled: false`
- 前端切换器检测到 `enabled=false` 时置灰

## 6. 已知限制（首版）

1. AtomCode 引擎下，DeepThink 内置 MCP 工具（send_message/schedule_task/memory_*）不可用 —— atomcode 有自己的工具集，未做桥接
2. 跨引擎切换会话上下文不连续（详见 PRD §3.1 A2）
3. Docker 模式需要宿主机预装 atomcode 二进制并 bind-mount
4. Provider 管理 API 通过临时 daemon 实例操作，每次调用有 ~2s 启动开销
5. AtomCode session 不进入 DeepThink 的 `conversations/` 归档（PreCompact hook 是 Claude SDK 专属）
