# 技术方案：Codex 与 OpenCode 引擎接入 DeepThink

- **版本**：v1.0
- **创建日期**：2026-07-16
- **分支**：`feat/codex-opencode-engine`

## 1. 架构总览

```
┌──────────────────────────────────────────────────────────────────┐
│  DeepThink 主进程 (src/index.ts)                                 │
│  - routes/config.ts: /api/config/codex/*, /api/config/opencode/* │
│  - runtime-config.ts: getCodexConfig/saveCodexConfig              │
│                        getOpencodeConfig/saveOpencodeConfig       │
│  - container-runner.ts: 根据 group.engine 分发                   │
│    engine ∈ {claude, atomcode, codex, opencode}                  │
└───────────────────┬──────────────────────────────────────────────┘
                    │ stdin: ContainerInput {engine:'codex'|'opencode', ...}
                    │ env: CODEX_BINARY_PATH, OPENCODE_BUN_PATH, ...
                    ▼
┌──────────────────────────────────────────────────────────────────┐
│  Agent Runner (container/agent-runner)                            │
│  index.ts main() 分支:                                           │
│    if engine === 'codex':    → codex-engine.ts                   │
│    if engine === 'opencode': → opencode-engine.ts                │
│    if engine === 'atomcode': → atomcode-engine.ts                │
│    else:                      → 现有 Claude SDK query()           │
└───────────────────┬──────────────────────────────────────────────┘
        ┌───────────┴───────────┐
        ▼                       ▼
┌───────────────────┐   ┌───────────────────────────────┐
│  codex exec --json │   │  opencode serve --port <port>  │
│  (CLI, JSONL stdout)│   │  (HTTP Server, REST + SSE)     │
└───────────────────┘   └───────────────────────────────┘
```

## 2. 模块变更清单

### 2.1 数据库层（`src/db.ts`）

**新增列**：
```ts
ensureColumn('sessions', 'codex_thread_id', 'TEXT');
ensureColumn('sessions', 'opencode_session_id', 'TEXT');
```

**Schema 版本**：`v51 → v52`

**新增 helper 函数**（参照 `getAtomcodeSessionId`/`setAtomcodeSessionId` 模式）：
```ts
// Codex session helpers
export function getCodexThreadId(groupFolder: string, agentId?: string | null): string | undefined;
export function setCodexThreadId(groupFolder: string, threadId: string, agentId?: string | null): void;
export function clearCodexThreadId(groupFolder: string, agentId?: string | null): void;

// OpenCode session helpers
export function getOpencodeSessionId(groupFolder: string, agentId?: string | null): string | undefined;
export function setOpencodeSessionId(groupFolder: string, sessionId: string, agentId?: string | null): void;
export function clearOpencodeSessionId(groupFolder: string, agentId?: string | null): void;
```

**类型扩展**：
- `RegisteredGroupRow.engine` 解析扩展为 `'claude' | 'atomcode' | 'codex' | 'opencode'`
- `parseGroupRow` 第 3896 行扩展：
  ```ts
  engine: ['atomcode', 'codex', 'opencode'].includes(row.engine ?? '') 
    ? (row.engine as 'atomcode' | 'codex' | 'opencode') 
    : 'claude',
  ```

### 2.2 配置存储（`src/runtime-config.ts`）

**Codex 配置**（参照 `AtomcodeConfig` 模式）：
```ts
export interface CodexConfig {
  enabled: boolean;
  binaryPath: string;     // 默认自动探测
  defaultModel: string;   // 默认 'gpt-5.1-codex'
  workingDir: string;     // 默认 '/workspace/group'
  updatedAt: string | null;
}

const CODEX_CONFIG_FILE = path.join(CLAUDE_CONFIG_DIR, 'codex.json');
const DEFAULT_CODEX_CONFIG: CodexConfig = {
  enabled: false,
  binaryPath: '',
  defaultModel: 'gpt-5.1-codex',
  workingDir: '/workspace/group',
  updatedAt: null,
};

export function getCodexConfig(): CodexConfig;
export function saveCodexConfig(cfg: CodexConfig): void;
export function toPublicCodexConfig(cfg: CodexConfig): CodexConfig;
```

**OpenCode 配置**：
```ts
export interface OpencodeConfig {
  enabled: boolean;
  bunPath: string;         // bun 二进制路径
  opencodePath: string;    // opencode 源码入口路径（packages/opencode/src/index.ts）
  host: string;            // 默认 '127.0.0.1'
  basePort: number;        // 默认 15000
  portRange: number;       // 默认 100
  password: string;        // opencode serve 密码（加密存储）
  providerID: string;      // 默认 'anthropic'
  modelID: string;         // 默认 'claude-sonnet-4-6'
  workingDir: string;      // 默认 '/workspace/group'
  updatedAt: string | null;
}

const OPENCODE_CONFIG_FILE = path.join(CLAUDE_CONFIG_DIR, 'opencode.json');
const DEFAULT_OPENCODE_CONFIG: OpencodeConfig = {
  enabled: false,
  bunPath: '',
  opencodePath: '',
  host: '127.0.0.1',
  basePort: 15000,
  portRange: 100,
  password: '',
  providerID: 'anthropic',
  modelID: 'claude-sonnet-4-6',
  workingDir: '/workspace/group',
  updatedAt: null,
};

export function getOpencodeConfig(): OpencodeConfig;
export function saveOpencodeConfig(cfg: OpencodeConfig): void;
export function toPublicOpencodeConfig(cfg: OpencodeConfig): PublicOpencodeConfig; // password → has_password: boolean
```

### 2.3 API 路由（`src/routes/config.ts`）

**Codex 路由**（均要求 `systemConfigMiddleware`）：

```ts
configRoutes.get('/codex', ...);     // 获取脱敏配置
configRoutes.put('/codex', ...);     // 保存配置
configRoutes.post('/codex/test', ...); // spawn codex --version，验证 binaryPath 可用
```

**OpenCode 路由**（均要求 `systemConfigMiddleware`）：

```ts
configRoutes.get('/opencode', ...);     // 获取脱敏配置（password → has_password）
configRoutes.put('/opencode', ...);     // 保存配置
configRoutes.post('/opencode/test', ...); // 启动临时 opencode serve，验证可用
```

**注意**：Codex 和 OpenCode 不需要 provider 管理路由（与 atomcode 不同）。Codex 的 provider 由 `~/.codex/config.toml` 管理，OpenCode 的 provider 由 `opencode.jsonc` 管理。用户可直接编辑配置文件。

### 2.4 Groups 路由（`src/routes/groups.ts`）

**`GroupPatchSchema` 扩展**（`src/schemas.ts` 第 237 行）：
```ts
engine: z.enum(['claude', 'atomcode', 'codex', 'opencode']).optional(),
```

**`GroupPayloadItem.engine` 类型扩展**（第 126 行）：
```ts
engine?: 'claude' | 'atomcode' | 'codex' | 'opencode';
```

### 2.5 Container-Runner（`src/container-runner.ts`）

**`ContainerInput.engine` 类型扩展**（第 248 行）：
```ts
engine?: 'claude' | 'atomcode' | 'codex' | 'opencode';
```

**Docker 路径**（`buildContainerEnvLines`，第 819 行附近）：
- 当 `engine === 'codex'`：注入 `CODEX_BINARY_PATH`、`CODEX_DEFAULT_MODEL`
- 当 `engine === 'opencode'`：注入 `OPENCODE_BUN_PATH`、`OPENCODE_SOURCE_PATH`、`OPENCODE_PASSWORD`

**Host 路径**（第 1680 行附近）：
- 同理注入环境变量到 `hostEnv`
- session 分流（第 2028 行附近）：
  ```ts
  const engineSessionId =
    groupEngine === 'atomcode' ? getAtomcodeSessionId(...) :
    groupEngine === 'codex' ? getCodexThreadId(...) :
    groupEngine === 'opencode' ? getOpencodeSessionId(...) :
    input.sessionId;
  ```

**Docker 路径 session 分流**（第 1206 行附近，补充 atomcode 也缺失的逻辑）：
```ts
if (engine === 'codex') {
  const tid = getCodexThreadId(group.folder, input.agentId || '');
  if (tid) dockerInput.sessionId = tid;
} else if (engine === 'opencode') {
  const sid = getOpencodeSessionId(group.folder, input.agentId || '');
  if (sid) dockerInput.sessionId = sid;
} else if (engine === 'atomcode') {
  const sid = getAtomcodeSessionId(group.folder, input.agentId || '');
  if (sid) dockerInput.sessionId = sid;
}
```

### 2.6 主进程 session 写回（`src/index.ts`）

在现有 `setAtomcodeSessionId` 分流点（第 4890、4980、7810、8392 行）扩展：
```ts
if (group.engine === 'codex') {
  setCodexThreadId(group.folder, output.newSessionId, agentId);
} else if (group.engine === 'opencode') {
  setOpencodeSessionId(group.folder, output.newSessionId, agentId);
} else if (group.engine === 'atomcode') {
  setAtomcodeSessionId(group.folder, output.newSessionId, agentId);
} else {
  setSession(group.folder, output.newSessionId, agentId);
}
```

### 2.7 Agent-Runner 引擎分支（`container/agent-runner/src/index.ts`）

扩展现有分支（第 2233 行）：
```ts
const engine = (containerInput.engine ?? 'claude') as 'claude' | 'atomcode' | 'codex' | 'opencode';
if (engine === 'codex') {
  const { runCodexEngine } = await import('./codex-engine.js');
  await runCodexEngine({ containerInput, writeOutput, log });
  process.exit(0);
}
if (engine === 'opencode') {
  const { runOpencodeEngine } = await import('./opencode-engine.js');
  await runOpencodeEngine({ containerInput, writeOutput, log });
  process.exit(0);
}
if (engine === 'atomcode') {
  // 现有逻辑
}
```

### 2.8 Codex 引擎适配器（`container/agent-runner/src/codex-engine.ts`，新文件）

**核心函数签名**：
```ts
export async function runCodexEngine(opts: {
  containerInput: ContainerInput;
  writeOutput: (out: ContainerOutput) => void;
  log: (message: string) => void;
}): Promise<void>;
```

**流程**：
1. 读取环境变量 `CODEX_BINARY_PATH`、`CODEX_DEFAULT_MODEL`
2. 构造 prompt（与 atomcode 一致：定时任务前缀 + drain IPC pending）
3. `runOneTurn(message, threadId?)`：
   - 构造命令：`codex exec --json [--model M] [--cd DIR] [resume <threadId>] [prompt]`
   - spawn 子进程，stdout 逐行解析 JSONL
   - 事件映射（见下表）
   - 返回 `{ threadId, fullText, toolCalls, error }`
4. emit `init` status：`Codex 引擎已启动 (model=...)`
5. `await runOneTurn(prompt)` → 输出 result
6. IPC polling loop（与 atomcode 一致）
7. 清理：SIGINT/SIGTERM 处理

**JSONL 事件映射**：

| Codex JSONL 事件 | DeepThink StreamEvent |
|------------------|----------------------|
| `{"type":"thread.started","thread_id":"..."}` | 捕获 thread_id → `onSessionId` |
| `{"type":"turn.started"}` | （内部状态） |
| `{"type":"item.started","item":{"type":"agent_message","text":"..."}}` | `text_delta`（初始文本） |
| `{"type":"item.updated","item":{"type":"agent_message","text":"..."}}` | `text_delta`（增量文本） |
| `{"type":"item.completed","item":{"type":"agent_message",...}}` | 文本结束 |
| `{"type":"item.started","item":{"type":"command_execution","command":"..."}}` | `tool_use_start`（toolName=command, toolInput=command） |
| `{"type":"item.updated","item":{"type":"command_execution","aggregated_output":"..."}}` | `tool_progress` |
| `{"type":"item.completed","item":{"type":"command_execution","exit_code":0,...}}` | `tool_use_end` |
| `{"type":"item.started","item":{"type":"reasoning","text":"..."}}` | `thinking_delta` |
| `{"type":"item.started","item":{"type":"file_change","path":"...","diff":"..."}}` | `tool_use_start`（toolName=file_change） |
| `{"type":"turn.completed","usage":{...}}` | `status` + 触发 result 输出 |
| `{"type":"turn.failed","error":{...}}` | `status` (错误) + result 输出 |
| `{"type":"error","message":"..."}` | `status` (错误) |

**JSONL 解析**：逐行读取 stdout，每行 `JSON.parse(line)` 得到 `CodexThreadEvent`。

### 2.9 OpenCode 引擎适配器（`container/agent-runner/src/opencode-engine.ts`，新文件）

**核心函数签名**：
```ts
export async function runOpencodeEngine(opts: {
  containerInput: ContainerInput;
  writeOutput: (out: ContainerOutput) => void;
  log: (message: string) => void;
}): Promise<void>;
```

**流程**：
1. 读取环境变量 `OPENCODE_BUN_PATH`、`OPENCODE_SOURCE_PATH`、`OPENCODE_BASE_PORT`、`OPENCODE_PORT_RANGE`、`OPENCODE_PASSWORD`
2. 选随机端口：`basePort + Math.floor(Math.random() * portRange)`
3. 启动 `opencode serve` 子进程：
   ```bash
   OPENCODE_SERVER_PASSWORD=<pwd> bun run <sourcePath> serve --port <port> --hostname 127.0.0.1
   ```
4. poll `GET /doc` 直到就绪（最多 30s）
5. 创建 session：`POST /session` → 得到 `sessionID`
6. 订阅 SSE：`GET /event?directory=<workDir>`，异步消费事件流
7. `runOneTurn(message)`：
   - 调 `POST /session/:id/message`（同步），body 含 `parts: [{type: "text", text: message}]`
   - 等待 SSE 事件流中的 `session.status` (idle) 或 `session.error`
   - 事件映射（见下表）
   - 返回 `{ fullText, toolCalls, error }`
8. emit `init` status：`OpenCode 引擎已启动 (port=...)`
9. `await runOneTurn(prompt)` → 输出 result
10. IPC polling loop
11. 清理：stop opencode serve，SIGINT/SIGTERM 处理

**SSE 事件映射**：

| OpenCode SSE 事件 | DeepThink StreamEvent |
|-------------------|----------------------|
| `message.updated` | （内部状态，追踪 message 元数据） |
| `message.part.updated` (type=text) | `text_delta`（累加 fullText） |
| `message.part.updated` (type=reasoning) | `thinking_delta` |
| `message.part.updated` (type=tool, state=running) | `tool_use_start` |
| `message.part.updated` (type=tool, state=pending) | `tool_progress` |
| `message.part.updated` (type=tool, state=completed) | `tool_use_end` |
| `message.part.updated` (type=step-start) | （内部状态） |
| `message.part.updated` (type=step-finish) | （内部状态） |
| `session.status` (type=idle) | 触发 result 输出 |
| `session.error` | `status` (错误) + result 输出 |

**SSE 解析**：复用 `atomcode-engine.ts` 的 `parseSseStream` 模式（async generator，按 `\n\n` 分块）。

### 2.10 前端 API & Store

**`web/src/api.ts`**（新增方法）：
```ts
export const codexApi = {
  getConfig: () => api.get('/api/config/codex'),
  saveConfig: (cfg) => api.put('/api/config/codex', cfg),
  test: () => api.post('/api/config/codex/test'),
};

export const opencodeApi = {
  getConfig: () => api.get('/api/config/opencode'),
  saveConfig: (cfg) => api.put('/api/config/opencode', cfg),
  test: () => api.post('/api/config/opencode/test'),
};
```

**`web/src/stores/chat.ts`**（扩展 `switchEngine`）：
```ts
switchEngine: async (jid: string, engine: 'claude' | 'atomcode' | 'codex' | 'opencode') => { ... }
```

**`web/src/types.ts`**（扩展 `GroupInfo.engine`）：
```ts
engine?: 'claude' | 'atomcode' | 'codex' | 'opencode';
```

### 2.11 前端 UI

**EngineSwitcher.tsx**（扩展引擎列表）：
```ts
const ENGINES: Array<{ key: EngineType; label: string }> = [
  { key: 'claude', label: 'Claude' },
  { key: 'atomcode', label: 'AtomCode' },
  { key: 'codex', label: 'Codex' },
  { key: 'opencode', label: 'OpenCode' },
];
```

**SettingsPage.tsx**（新增 tab）：
- `VALID_TABS` 加 `'codex'` 和 `'opencode'`
- `SYSTEM_TABS` 加 `'codex'` 和 `'opencode'`
- 新增 `{activeTab === 'codex' && <CodexEngineSection />}`
- 新增 `{activeTab === 'opencode' && <OpencodeEngineSection />}`

**CodexEngineSection.tsx**（新组件，~150 行）：
- 启用开关、二进制路径、默认模型、保存、测试连接
- 测试结果展示：版本号、可用性

**OpencodeEngineSection.tsx**（新组件，~200 行）：
- 启用开关、Bun 路径、OpenCode 源码路径、端口范围、密码（脱敏）、保存、测试连接
- 测试结果展示：serve 启动成功、版本号

**SettingsNav.tsx**（扩展导航）：
- 新增 "Codex 引擎" 和 "OpenCode 引擎" 导航项

## 3. 关键代码片段

### 3.1 Codex JSONL 事件解析（codex-engine.ts 核心）

```ts
interface CodexThreadEvent {
  type: string;  // thread.started | turn.started | turn.completed | turn.failed | item.started | item.updated | item.completed | error
  thread_id?: string;
  turn_id?: string;
  item?: {
    id?: string;
    type?: string;  // agent_message | reasoning | command_execution | file_change | mcp_tool_call | web_search | todo_list | error
    text?: string;
    command?: string;
    aggregated_output?: string;
    exit_code?: number | null;
    status?: string;  // in_progress | completed | failed | declined
    changes?: Array<{ path: string; kind: string }>;  // file_change
    tool?: string;    // mcp_tool_call
    arguments?: any;  // mcp_tool_call
    result?: { content?: any; structured_content?: any };
    error?: { message: string };  // mcp_tool_call
    query?: string;   // web_search
  };
  usage?: {
    input_tokens: number;
    output_tokens: number;
    cached_input_tokens?: number;
    reasoning_output_tokens?: number;
  };
  error?: { message: string };
  message?: string;
}

async function runOneTurn(
  binaryPath: string,
  model: string,
  workingDir: string,
  message: string,
  threadId: string | undefined,
  writeOutput: (out: ContainerOutput) => void,
  log: (m: string) => void,
  signal?: AbortSignal,
): Promise<{ threadId?: string; fullText: string; toolCalls: number; error?: string }> {
  // 构造参数：codex exec --json --model M --cd DIR [resume <threadId>] "<prompt>"
  const args = ['exec', '--json', '--model', model, '--cd', workingDir];
  if (threadId) {
    args.push('resume', threadId);
  }
  args.push(message);

  const proc = spawn(binaryPath, args, {
    stdio: ['ignore', 'pipe', 'pipe'],
    signal,
  });

  let fullText = '';
  let toolCalls = 0;
  let newThreadId: string | undefined;
  let lastItemText: Record<string, string> = {};  // item.id -> 上次累计的 text，用于增量

  const rl = readline.createInterface({ input: proc.stdout! });
  for await (const line of rl) {
    if (!line.trim()) continue;
    let ev: CodexThreadEvent;
    try { ev = JSON.parse(line); } catch { continue; }
    switch (ev.type) {
      case 'thread.started':
        newThreadId = ev.thread_id;
        break;
      case 'item.started':
      case 'item.updated':
        if (!ev.item) break;
        if (ev.item.type === 'agent_message' && ev.item.text) {
          const itemId = ev.item.id ?? '_anon';
          const prev = lastItemText[itemId] ?? '';
          const full = ev.item.text;
          const delta = full.startsWith(prev) ? full.slice(prev.length) : full;
          lastItemText[itemId] = full;
          fullText += delta;
          if (delta) writeOutput({ status: 'stream', streamEvent: { type: 'text_delta', content: delta } });
        } else if (ev.item.type === 'reasoning' && ev.item.text) {
          writeOutput({ status: 'stream', streamEvent: { type: 'thinking_delta', content: ev.item.text } });
        } else if (ev.item.type === 'command_execution' && ev.type === 'item.started') {
          toolCalls++;
          writeOutput({ status: 'stream', streamEvent: { type: 'tool_use_start', toolName: 'command', toolInputSummary: ev.item.command?.slice(0, 200) } });
        } else if (ev.item.type === 'command_execution' && ev.type === 'item.updated' && ev.item.aggregated_output) {
          writeOutput({ status: 'stream', streamEvent: { type: 'tool_progress', toolName: 'command', toolOutputSummary: ev.item.aggregated_output.slice(-1000) } });
        } else if (ev.item.type === 'file_change' && ev.type === 'item.started') {
          toolCalls++;
          const paths = (ev.item.changes ?? []).map(c => c.path).join(', ');
          writeOutput({ status: 'stream', streamEvent: { type: 'tool_use_start', toolName: 'file_change', toolInputSummary: paths.slice(0, 200) } });
        } else if (ev.item.type === 'mcp_tool_call' && ev.type === 'item.started') {
          toolCalls++;
          writeOutput({ status: 'stream', streamEvent: { type: 'tool_use_start', toolName: ev.item.tool ?? 'mcp_tool', toolInputSummary: JSON.stringify(ev.item.arguments ?? {}).slice(0, 200) } });
        } else if (ev.item.type === 'web_search' && ev.type === 'item.started') {
          toolCalls++;
          writeOutput({ status: 'stream', streamEvent: { type: 'tool_use_start', toolName: 'web_search', toolInputSummary: ev.item.query?.slice(0, 200) } });
        }
        break;
      case 'item.completed':
        if (!ev.item) break;
        if (ev.item.type === 'command_execution') {
          writeOutput({ status: 'stream', streamEvent: { type: 'tool_use_end', toolName: 'command', toolOutputSummary: ev.item.aggregated_output?.slice(-1000), toolSuccess: ev.item.exit_code === 0 } });
        } else if (ev.item.type === 'file_change') {
          writeOutput({ status: 'stream', streamEvent: { type: 'tool_use_end', toolName: 'file_change', toolSuccess: ev.item.status !== 'failed' } });
        } else if (ev.item.type === 'mcp_tool_call') {
          writeOutput({ status: 'stream', streamEvent: { type: 'tool_use_end', toolName: ev.item.tool ?? 'mcp_tool', toolSuccess: !ev.item.error } });
        } else if (ev.item.type === 'web_search') {
          writeOutput({ status: 'stream', streamEvent: { type: 'tool_use_end', toolName: 'web_search', toolSuccess: true } });
        }
        break;
      case 'turn.completed':
        writeOutput({ status: 'stream', streamEvent: { type: 'status', message: `Tokens: ${ev.usage?.input_tokens ?? 0}/${ev.usage?.output_tokens ?? 0}` } });
        break;
      case 'turn.failed':
      case 'error':
        return { threadId: newThreadId, fullText, toolCalls, error: ev.error?.message || ev.message };
    }
  }
  await new Promise<void>((resolve) => proc.on('close', () => resolve()));
  return { threadId: newThreadId, fullText, toolCalls };
}
```

### 3.2 OpenCode HTTP 客户端（opencode-engine.ts 核心）

```ts
async function createOpencodeSession(
  baseUrl: string,
  password: string,
  workingDir: string,
  log: (m: string) => void,
): Promise<string> {
  const auth = Buffer.from(`opencode:${password}`).toString('base64');
  const res = await fetch(`${baseUrl}/session?directory=${encodeURIComponent(workingDir)}`, {
    method: 'POST',
    headers: {
      'Authorization': `Basic ${auth}`,
      'Content-Type': 'application/json',
    },
    body: JSON.stringify({}),
  });
  const data = await res.json() as any;
  return data.id;
}

async function sendOpencodePrompt(
  baseUrl: string,
  sessionId: string,
  password: string,
  workingDir: string,
  providerID: string,
  modelID: string,
  message: string,
  log: (m: string) => void,
): Promise<Response> {
  const auth = Buffer.from(`opencode:${password}`).toString('base64');
  return fetch(
    `${baseUrl}/session/${encodeURIComponent(sessionId)}/message?directory=${encodeURIComponent(workingDir)}`,
    {
      method: 'POST',
      headers: {
        'Authorization': `Basic ${auth}`,
        'Content-Type': 'application/json',
      },
      body: JSON.stringify({
        providerID,
        modelID,
        parts: [{ type: 'text', text: message }],
      }),
    },
  );
}

// SSE 订阅：事件名固定 "message"，data 是 JSON {id, type, properties}
// 关键事件：message.part.updated (part.type=text/reasoning/tool/step-start/step-finish)
//         session.status (status.type=idle/busy/retry), session.error
// ToolPart.state.status: pending | running | completed | error
```

### 3.3 DB migration

```ts
// db.ts ensureColumn 区
ensureColumn('sessions', 'codex_thread_id', 'TEXT');
ensureColumn('sessions', 'opencode_session_id', 'TEXT');
```

## 4. 测试策略

### 4.1 单元测试
- `tests/units/codex-jsonl.test.ts`：JSONL 事件解析器单元测试（模拟 codex exec --json 输出）
- `tests/units/opencode-sse.test.ts`：SSE 事件解析器单元测试（模拟 opencode GET /event 输出）

### 4.2 集成测试
- `make typecheck`：三端类型一致性
- `make build`：全量构建通过
- 手动 E2E：
  1. 设置页配置 Codex 二进制路径
  2. 测试连接 → 收到版本号
  3. 主对话切换到 Codex 引擎 → 发送 "你好" → 收到流式回复
  4. 设置页配置 OpenCode 路径
  5. 测试连接 → serve 启动成功
  6. 主对话切换到 OpenCode 引擎 → 发送 "你好" → 收到流式回复
  7. 切换回 Claude → 发送消息 → 正常

### 4.3 验收标准
见 PRD §6。

## 5. 回滚策略

- DB 列默认 NULL 保证升级后现有群行为不变
- `engine` 字段缺失时（旧 client），后端默认 `'claude'`
- 配置文件 `codex.json`/`opencode.json` 不存在时，`getCodexConfig()`/`getOpencodeConfig()` 返回 `enabled: false`
- 前端切换器检测到 `enabled=false` 时置灰

## 6. 已知限制（首版）

1. Codex 每次 turn 需 spawn 新进程，冷启动开销 ~2-3s（后续可优化为 app-server daemon 模式）
2. OpenCode 需要 Bun 运行时，Docker 模式需额外安装
3. Codex/OpenCode 引擎下，DeepThink 内置 MCP 工具不可用
4. 跨引擎切换会话上下文不连续
5. Codex 的 `codex exec --json` 不支持图片输入（首版限制）
6. OpenCode 的 session 续接依赖 serve 进程存活，进程退出后 session 丢失