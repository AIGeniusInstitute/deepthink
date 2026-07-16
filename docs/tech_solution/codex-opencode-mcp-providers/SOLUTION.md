# 技术方案：Codex/OpenCode 引擎扩展 — MCP 桥接 + Bun 自动安装 + Provider 内置

## 1. 架构总览

```
┌─────────────────────────────────────────────────────────────┐
│ DeepThink 主进程 (src/index.ts)                              │
│  ├─ IPC 文件监听器 (data/ipc/{folder}/messages/, tasks/)      │
│  ├─ mcp-bridge 响应器（新增）                                  │
│  │   └─ 监听 data/ipc/{folder}/mcp-bridge/requests/*.json      │
│  │       工具执行后写 {requestId}.response.json                 │
│  └─ Bun 安装器 (src/bun-installer.ts)                         │
└─────────────────────────────────────────────────────────────┘
                              ↑ IPC 文件
                              │
┌─────────────────────────────────────────────────────────────┐
│ agent-runner 进程 (container/agent-runner/)                  │
│  ├─ codex-engine.ts / opencode-engine.ts                     │
│  │   └─ 启动前生成临时 config 文件                              │
│  │       - $CODEX_HOME/config.toml                           │
│  │       - $OPENCODE_CONFIG (opencode.jsonc)                  │
│  │   └─ 通过 env 注入 mcp-bridge.js 路径                       │
│  └─ mcp-bridge.ts (独立 stdio MCP server)                     │
│      ├─ stdin/stdout JSON-RPC 2.0                            │
│      ├─ 实现 12 个 DeepThink 工具                             │
│      └─ 通过 IPC 文件与主进程通信                              │
└─────────────────────────────────────────────────────────────┘
                              ↑ stdio
                              │
              ┌───────────────┴───────────────┐
              │                                 │
        codex CLI                       opencode serve
        (subprocess)                    (subprocess)
```

## 2. 模块设计

### 2.1 mcp-bridge.ts — 独立 stdio MCP Server

**位置**：`container/agent-runner/src/mcp-bridge.ts`

**职责**：作为 Codex/OpenCode 引擎与 DeepThink 主进程之间的 MCP 协议桥接器。

**接口设计**：

```typescript
// MCP 协议入口
import { Server } from '@modelcontextprotocol/sdk/server/index.js';
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js';

const server = new Server(
  { name: 'deepthink-bridge', version: '1.0.0' },
  { capabilities: { tools: {} } }
);

server.setRequestHandler(ListToolsRequestSchema, () => ({
  tools: TOOL_DEFINITIONS
}));

server.setRequestHandler(CallToolRequestSchema, async (req) => {
  const { name, arguments: args } = req.params;
  return await handleToolCall(name, args ?? {});
});

const transport = new StdioServerTransport();
await server.connect(transport);
```

**工具实现模式**（统一通过 IPC 文件）：

```typescript
async function callViaIPC(toolName: string, args: any): Promise<any> {
  const requestId = `${toolName}-${Date.now()}-${Math.random().toString(36).slice(2,8)}`;
  const requestFile = path.join(IPC_DIR, 'mcp-bridge', 'requests', `${requestId}.json`);
  const responseFile = path.join(IPC_DIR, 'mcp-bridge', 'responses', `${requestId}.json`);
  
  await fs.mkdir(path.dirname(requestFile), { recursive: true });
  await fs.writeFile(requestFile, JSON.stringify({
    requestId, tool: toolName, args, groupFolder: GROUP_FOLDER,
    isHome: IS_HOME, isAdminHome: IS_ADMIN_HOME, timestamp: Date.now()
  }));
  
  // 轮询响应文件，30s 超时
  const start = Date.now();
  while (Date.now() - start < 30000) {
    try {
      const data = await fs.readFile(responseFile, 'utf8');
      await fs.unlink(responseFile).catch(() => {});
      return JSON.parse(data);
    } catch (e) {
      if (e.code !== 'ENOENT') throw e;
      await new Promise(r => setTimeout(r, 100));
    }
  }
  throw new Error(`MCP bridge timeout: ${toolName}`);
}
```

**12 个工具定义**（与 `mcp-tools.ts` 完全对齐，参数 schema 复用）：

| 工具 | 参数 | 返回 |
|------|------|------|
| send_message | text | { ok: true } |
| schedule_task | schedule_type, schedule_value, prompt, ... | { task_id } |
| list_tasks | - | { tasks: [...] } |
| pause_task | task_id | { ok: true } |
| resume_task | task_id | { ok: true } |
| cancel_task | task_id | { ok: true } |
| register_group | jid, name, folder | { ok: true } (admin only) |
| install_skill | package | { ok: true } |
| uninstall_skill | skill_id | { ok: true } |
| memory_append | content, date? | { ok: true } |
| memory_search | query, max_results? | { results: [...] } |
| memory_get | file, from_line?, lines? | { content } |

### 2.2 主进程 IPC 响应器扩展

**位置**：`src/index.ts`（扩展）+ 新建 `src/mcp-bridge-handler.ts`

**逻辑**：

```typescript
// 监听 data/ipc/{folder}/mcp-bridge/requests/
function watchMcpBridgeRequests(folder: string) {
  const reqDir = path.join(IPC_ROOT, folder, 'mcp-bridge', 'requests');
  fs.mkdir(reqDir, { recursive: true });
  
  const watch = () => {
    fs.readdir(reqDir, (err, files) => {
      if (err) return;
      for (const f of files) {
        if (!f.endsWith('.json')) continue;
        const reqPath = path.join(reqDir, f);
        fs.readFile(reqPath, 'utf8', async (e, data) => {
          if (e) return;
          const req = JSON.parse(data);
          // 复用 mcp-tools.ts 中的 handler 实现
          const result = await handleMcpToolCall(req.tool, req.args, {
            groupFolder: folder,
            isHome: req.isHome,
            isAdminHome: req.isAdminHome
          });
          const resPath = path.join(IPC_ROOT, folder, 'mcp-bridge', 'responses', req.requestId + '.json');
          await fs.writeFile(resPath, JSON.stringify(result));
          await fs.unlink(reqPath).catch(() => {});
        });
      }
    });
  };
  
  fs.watch(reqDir, { persistent: false }, () => watch());
  setInterval(watch, 1000);  // 后备轮询
}
```

**关键复用**：把 `mcp-tools.ts` 中的工具实现抽取为纯函数 `handleMcpToolCall(tool, args, ctx)`，agent-runner 内 MCP SDK 注册和 mcp-bridge 两条路径都调用它。

### 2.3 Codex 引擎注入 MCP + Provider 配置

**位置**：`container/agent-runner/src/codex-engine.ts`（扩展）

**临时 config.toml 生成**：

```typescript
async function writeCodexConfig(env: Record<string, string>, providers: CodexProvider[]) {
  const codexHome = path.join(SESSION_DIR, '.codex');  // data/sessions/{folder}/.codex
  await fs.mkdir(codexHome, { recursive: true });
  
  const configPath = path.join(codexHome, 'config.toml');
  const lines: string[] = [];
  
  // Provider 配置
  lines.push(`model = "${env.DEFAULT_MODEL ?? 'gpt-5.1-codex'}"`);
  if (providers.length > 0) {
    lines.push(`model_provider = "deepthink-provider-0"`);
    providers.forEach((p, i) => {
      lines.push(``);
      lines.push(`[model_providers.deepthink-provider-${i}]`);
      lines.push(`name = "deepthink-provider-${i}"`);
      lines.push(`base_url = "${p.baseURL}"`);
      lines.push(`env_key = "DEEPTHINK_CODEX_API_KEY_${i}"`);
      // 通过 env 注入对应 apiKey
      env[`DEEPTHINK_CODEX_API_KEY_${i}`] = p.apiKey;
    });
  }
  
  // MCP bridge 配置
  lines.push(``);
  lines.push(`[mcp_servers.deepthink]`);
  lines.push(`command = "node"`);
  lines.push(`args = ["${MCP_BRIDGE_PATH}"]`);
  lines.push(`env_vars = { DT_GROUP_FOLDER = "${env.DT_GROUP_FOLDER}", DT_IPC_DIR = "${env.DT_IPC_DIR}", DT_IS_HOME = "${env.DT_IS_HOME}", DT_IS_ADMIN_HOME = "${env.DT_IS_ADMIN_HOME}" }`);
  
  await fs.writeFile(configPath, lines.join('\n'), { mode: 0o600 });
  await fs.chmod(configPath, 0o600);
  
  env.CODEX_HOME = codexHome;
}
```

**调用点**：`runCodexEngine` 启动前，从环境变量 `CODEX_PROVIDERS_JSON`（由主进程注入）解析 providers，生成 config 后再 spawn codex。

### 2.4 OpenCode 引擎注入 MCP + Provider 配置

**位置**：`container/agent-runner/src/opencode-engine.ts`（扩展）

**临时 opencode.jsonc 生成**：

```typescript
async function writeOpencodeConfig(env: Record<string, string>, providers: OpencodeProvider[]) {
  const opencodeDir = path.join(SESSION_DIR, '.opencode');
  await fs.mkdir(opencodeDir, { recursive: true });
  const configPath = path.join(opencodeDir, 'opencode.jsonc');
  
  const config: any = {
    provider: {},
    mcp: {}
  };
  
  providers.forEach((p, i) => {
    const key = i === 0 ? 'deepthink-provider-0' : `deepthink-provider-${i}`;
    config.provider[key] = {
      name: p.name,
      api_key: p.apiKey,
      base_url: p.baseURL,
      models: { [p.models[0] ?? 'claude-sonnet-4-6']: { name: p.models[0] ?? 'claude-sonnet-4-6' } }
    };
  });
  
  config.mcp.deepthink = {
    type: 'local',
    command: ['node', MCP_BRIDGE_PATH],
    environment: {
      DT_GROUP_FOLDER: env.DT_GROUP_FOLDER,
      DT_IPC_DIR: env.DT_IPC_DIR,
      DT_IS_HOME: env.DT_IS_HOME,
      DT_IS_ADMIN_HOME: env.DT_IS_ADMIN_HOME
    }
  };
  
  await fs.writeFile(configPath, JSON.stringify(config, null, 2), { mode: 0o600 });
  await fs.chmod(configPath, 0o600);
  
  env.OPENCODE_CONFIG = configPath;
}
```

### 2.5 Bun 自动安装

**位置**：新建 `src/bun-installer.ts`

```typescript
import { spawn } from 'child_process';
import { mkdir, chmod, stat, writeFile, readFile } from 'fs/promises';
import { join } from 'path';

const BUN_VERSION = '1.3.14';
const BUN_INSTALL_DIR = join(DATA_ROOT, 'bin', `bun-${BUN_VERSION}`);

function getPlatformAsset(): string {
  const platform = process.platform;  // darwin / linux
  const arch = process.arch;          // arm64 / x64
  const osMap: Record<string, string> = { darwin: 'darwin', linux: 'linux' };
  const archMap: Record<string, string> = { arm64: 'arm64', x64: 'x64' };
  return `bun-${osMap[platform]}-${archMap[arch]}.zip`;
}

export async function ensureBunInstalled(): Promise<{ bunPath: string; installed: boolean }> {
  // 1. 已安装直接返回
  if (await pathExists(BUN_INSTALL_DIR)) {
    return { bunPath: join(BUN_INSTALL_DIR, 'bun'), installed: false };
  }
  
  await mkdir(BUN_INSTALL_DIR, { recursive: true });
  const assetName = getPlatformAsset();
  const url = `https://github.com/oven-sh/bun/releases/download/bun-v${BUN_VERSION}/${assetName}`;
  
  // 2. 下载 zip
  const zipPath = join(BUN_INSTALL_DIR, 'bun.zip');
  await downloadFile(url, zipPath);
  
  // 3. 解压
  await extractZip(zipPath, BUN_INSTALL_DIR);
  
  // 4. 找到 bun 二进制（解压后通常在 bun-xxx/bun）
  const extracted = await findBunBinary(BUN_INSTALL_DIR);
  await chmod(extracted, 0o755);
  
  // 5. 清理 zip
  await unlink(zipPath).catch(() => {});
  
  return { bunPath: extracted, installed: true };
}

async function downloadFile(url: string, dest: string): Promise<void> {
  // 用 fetch（Node 18+ 内置）或 https 模块
  const res = await fetch(url);
  if (!res.ok) throw new Error(`Bun download failed: ${res.status}`);
  const buf = Buffer.from(await res.arrayBuffer());
  await writeFile(dest, buf);
}

async function extractZip(zipPath: string, destDir: string): Promise<void> {
  // 用 system unzip 命令（macOS/linux 都有）或 unzipper 库
  await new Promise<void>((resolve, reject) => {
    const proc = spawn('unzip', ['-o', zipPath, '-d', destDir]);
    proc.on('exit', code => code === 0 ? resolve() : reject(new Error(`unzip exit ${code}`)));
    proc.on('error', reject);
  });
}
```

**调用时机**：

1. **`src/index.ts` `loadState()`**：异步调用 `ensureBunInstalled()`，不阻塞启动
2. **`getOpencodeConfig()`**：`bunPath` 为空时同步等待 `ensureBunInstalled()` 完成，写入 config
3. **`POST /api/config/opencode/test`**：调用前确保已安装

### 2.6 Provider 配置 UI

**位置**：`web/src/components/settings/CodexEngineSection.tsx` + `OpencodeEngineSection.tsx`

**CodexEngineSection 扩展**：

```tsx
interface CodexProvider {
  name: string;
  apiKey: string;       // 显示 masked
  baseURL: string;
  model: string;
}

// 新增 providers 列表区域
{providers.map((p, i) => (
  <div key={i} className="border rounded p-3 space-y-2">
    <Input placeholder="Provider 名（如 anthropic）" value={p.name} ... />
    <Input type="password" placeholder="API Key" value={p.apiKey} ... />
    <Input placeholder="Base URL" value={p.baseURL} ... />
    <Input placeholder="Model" value={p.model} ... />
    <Button variant="ghost" onClick={() => removeProvider(i)}>删除</Button>
  </div>
))}
<Button variant="outline" onClick={() => addProvider()}>+ 添加 Provider</Button>
```

**OpencodeEngineSection 同样模式**。

### 2.7 后端 API 扩展

**`src/routes/config.ts`**：

```typescript
// PUT /api/config/codex body 增加字段
{
  enabled: boolean;
  binaryPath: string;
  defaultModel: string;
  workingDir: string;
  providers: [{ name, apiKey, baseURL, model }];  // 新增
}

// PUT /api/config/opencode body 增加字段
{
  // ... 原有
  providers: [{ id, name, apiKey, baseURL, models: [] }];  // 新增
}
```

**`src/schemas.ts`**：

```typescript
const CodexProviderSchema = z.object({
  name: z.string(),
  apiKey: z.string(),
  baseURL: z.string(),
  model: z.string()
});

const CodexConfigSchema = z.object({
  // ... 原有
  providers: z.array(CodexProviderSchema).default([])
});
```

### 2.8 主进程注入 providers 到 agent-runner 环境

**位置**：`src/container-runner.ts`

在构建 env 时增加：

```typescript
// Codex providers
const codexConfig = getCodexConfig();
if (engine === 'codex') {
  env.CODEX_PROVIDERS_JSON = JSON.stringify(codexConfig.providers.map(p => ({
    name: p.name,
    apiKey: decrypt(p.apiKey),  // 解密后明文给 agent-runner
    baseURL: p.baseURL,
    model: p.model
  })));
}

// OpenCode providers
const opencodeConfig = getOpencodeConfig();
if (engine === 'opencode') {
  env.OPENCODE_PROVIDERS_JSON = JSON.stringify(opencodeConfig.providers.map(p => ({
    id: p.id,
    name: p.name,
    apiKey: decrypt(p.apiKey),
    baseURL: p.baseURL,
    models: p.models
  })));
}
```

## 3. 数据库

无需新增 schema 版本（所有配置存于 `data/config/`，非 DB）。

## 4. 测试策略

### 4.1 单元测试

新增 `tests/units/mcp-bridge-ipc.test.ts`：
- 测试 IPC 文件协议（请求/响应格式）
- 测试 30s 超时
- 测试工具权限校验（admin only 工具）

新增 `tests/units/bun-installer.test.ts`：
- Mock fetch 测试平台 URL 生成
- 测试已安装直接返回

### 4.2 集成测试

`tests/units/codex-mcp-integration.test.ts`：
- 启动 codex-engine mock，调用 send_message，断言 IPC 文件生成

### 4.3 手动验证

1. 设置页配置 Codex provider，启用 Codex 引擎
2. 在 Codex 引擎下让 Agent 调用 `send_message`，验证消息送达
3. 在 OpenCode 引擎下同样验证
4. 清空 Bun，重新启用 OpenCode 引擎，验证自动安装

## 5. 实施步骤

| Step | 内容 | 涉及文件 |
|------|------|----------|
| 1 | 抽取 mcp-tools.ts 工具实现为纯函数 | `container/agent-runner/src/mcp-tools.ts` |
| 2 | 创建 mcp-bridge.ts 独立 MCP server | `container/agent-runner/src/mcp-bridge.ts` |
| 3 | 主进程 IPC 响应器 | `src/index.ts` + `src/mcp-bridge-handler.ts` |
| 4 | Codex 引擎注入 MCP + Provider 配置 | `container/agent-runner/src/codex-engine.ts` |
| 5 | OpenCode 引擎注入 MCP + Provider 配置 | `container/agent-runner/src/opencode-engine.ts` |
| 6 | Bun 自动安装器 | `src/bun-installer.ts` + `src/index.ts` loadState |
| 7 | Provider 配置 UI | `CodexEngineSection.tsx` + `OpencodeEngineSection.tsx` |
| 8 | 后端 API + Zod schema 扩展 | `src/routes/config.ts` + `src/schemas.ts` + `src/runtime-config.ts` |
| 9 | 主进程注入 providers env | `src/container-runner.ts` |
| 10 | 单元测试 | `tests/units/` |
| 11 | typecheck + vitest + 手动验证 | - |
| 12 | 文档 + 提交 | docs/test_report, git push |
