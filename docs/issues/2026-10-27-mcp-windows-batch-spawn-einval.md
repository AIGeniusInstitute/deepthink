# bug: Windows 上以 .cmd 启动的 stdio MCP server 无法连接（spawn EINVAL → MCP error -32000: Connection closed）

## 1. 用户现象

Windows 桌面版用户在「MCP 服务器」设置页添加了一个 stdio 类型 MCP server（arxiv-paper-search），命令填 `C:\Users\<user>\arxiv-paper-search\run.cmd`。保存后：

- 设置页点「工具 刷新」报 `MCP error -32000: Connection closed`，工具列表为空；
- Agent 会话里同样无法连接该 MCP server，表现为 Connection closed。

同一台机器上手动执行 `run.cmd` 一切正常（venv 创建、依赖安装、server 启动、JSON-RPC 握手全通过）。

## 2. 问题描述

DeepThink 所有在 Windows 宿主进程内 spawn stdio MCP server 的路径（设置页工具列表/测试调用、宿主机模式的 agent、开放平台 query）底层都是 Node `child_process.spawn`（MCP SDK 的 `StdioClientTransport`、Claude Agent SDK 的内置 MCP 客户端同理）。Node 的 CVE-2024-27980 安全修复（18.20.0 / 20.12.0 / 21.7.0 起）禁止 `spawn` 直接启动 Windows 批处理（`.cmd` / `.bat`），会同步抛 `EINVAL`。spawn 起不来 → stdio transport 立即 close → MCP 客户端统一报 `MCP error -32000: Connection closed`，用户完全看不出真实原因。

## 3. 根因

- Node 修复 [CVE-2024-27980](https://nodejs.org/en/blog/vulnerability/april-2024-security-releases) 后，`child_process.spawn` 对 `.cmd`/`.bat` 一律抛 `spawn EINVAL`，必须显式经 `cmd.exe /c` 启动：
  - https://nodejs.org/api/child_process.html#spawning-bat-and-cmd-files-on-windows
  - https://github.com/nodejs/node/issues/52554
- MCP SDK 的 `StdioClientTransport`（`@modelcontextprotocol/sdk/client/stdio.js`）底层就是 `spawn(command, args)`；Claude Agent SDK 读 settings.json 的 `mcpServers` 后同样用 Node spawn 拉起。二者都不会对 Windows 批处理做适配。
- DeepThink 侧三个消费点均把用户配置的 `command` 原样透传，没有任何 `.cmd`/`.bat` 兼容处理：
  - `src/mcp-client.ts` `buildTransport`（设置页工具列表 / 测试调用）；
  - `src/container-runner.ts` `runHostAgent` 写入 settings.json（宿主机模式 agent）；
  - `src/open-platform/agent-service.ts` `resolveAgentMcpServers`（开放平台 query 的 mcpServers）。

外部依据（本机 Node 24 实测）：

```
Error: spawn EINVAL
    at ChildProcess.spawn (node:internal/child_process:487:11)
  errno: -4071, code: 'EINVAL', syscall: 'spawn'
```

## 4. 复现路径

1. Windows 机器准备任意以批处理启动的 stdio MCP server（如 `run.cmd` 内容为 `python server.py`）。
2. 启动 DeepThink（桌面版或 `make start`），进入「MCP 服务器」设置页。
3. 添加 stdio server：命令填 `C:\path\to\run.cmd`，保存。
4. 点「工具 刷新」→ 报 `MCP error -32000: Connection closed`。
5. 命令行等价复现（无需 DeepThink）：

```js
// node repro.mjs —— 必现 spawn EINVAL
import { spawn } from 'child_process';
spawn(String.raw`C:\path\to\run.cmd`, [], { stdio: ['pipe', 'pipe', 'pipe'] });
```

对照组：`spawn(String.raw`C:\path\to\run.cmd` ...)` 换成 `spawn('cmd', ['/c', String.raw`C:\path\to\run.cmd`])`，或直接指向 `python.exe` + `args: ['server.py']`，一切正常。

## 5. 诊断方法

```bash
# 1. 确认 Node 版本落在受影响范围（>= 18.20.0 均受影响）
node -v

# 2. 最小复现：裸 spawn .cmd vs cmd /c 包装
node -e "const {spawn}=require('child_process'); spawn(String.raw\`C:\path\to\run.cmd\`);"
node -e "const {spawn}=require('child_process'); spawn('cmd',['/c',String.raw\`C:\path\to\run.cmd\`]);"

# 3. 看 DeepThink 后端日志中 mcp listTools 的真实错误
grep -n "mcp listTools failed" logs/*.log
```

## 6. 修复方案

在 `src/mcp-client.ts` 新增 `wrapWinBatchCommand` / `wrapWinBatchServers`：win32 下把以 `.cmd`/`.bat` 结尾的 `command` 改写为 `cmd.exe /c <原命令> ...<原 args>`（保留 env；剥掉 command 外层引号；`.bat` 同样适用，大小写不敏感），非 win32 平台原样返回。三个消费点全部接入：

### `src/mcp-client.ts`（设置页工具列表 / 测试调用）

```diff
+  const wrapped = wrapWinBatchCommand(cfg);
   return new StdioClientTransport({
-    command,
-    args: cfg.args ?? [],
+    command: wrapped.command as string,
+    args: wrapped.args ?? [],
     env: { ...getDefaultEnvironment(), ...(cfg.env ?? {}) },
     stderr: 'ignore',
   });
```

同时 `toErrorMessage` 增加 `EINVAL` 分支，提示「Windows 批处理 .cmd/.bat 需通过 cmd /c 执行」，避免下次再以 Connection closed 的形态误导排查。

### `src/container-runner.ts`（宿主机模式 settings.json）

```diff
   const settingsFile = path.join(groupSessionsDir, 'settings.json');
-  const hostMcpServers = group.created_by ? loadUserMcpServers(group.created_by) : {};
-  ensureSettingsJson(settingsFile, hostMcpServers);
+  const hostMcpServers: Record<string, Record<string, unknown>> = group.created_by
+    ? loadUserMcpServers(group.created_by)
+    : {};
+  ensureSettingsJson(settingsFile, wrapWinBatchServers(hostMcpServers));
```

### `src/open-platform/agent-service.ts`（开放平台 query 的 mcpServers）

```diff
-    out[m.resource_id] = {
+    out[m.resource_id] = wrapWinBatchCommand({
       type: typeof cfg.type === 'string' ? cfg.type : 'stdio',
       ...
-    };
+    });
```

### 选型理由

三个候选：

1. **spawn 边界自动改写（本方案）**——用户配置不动，存量 `run.cmd` 类配置直接复活；对非 Windows 零影响（`platform !== 'win32'` 原样返回）。
2. UI 层禁止/转换 `.cmd` 输入——治标不治本，存量配置仍坏，且 UI 其实已支持 args/env，缺的是执行层兼容。
3. 仅文档提示用户改配置——把平台兼容成本转嫁给用户，且 `MCP error -32000` 根本指不到方向。

注意改写只作用于「命令将在 Windows 宿主进程 spawn」的三个路径；Docker 模式下 stdio 命令在 Linux 容器内执行（`loadUserMcpServers` 的容器注入路径不改写），避免误伤 Linux 下合法的同名可执行文件。

## 7. 处理卡住的状态

用户侧无需救运行态，升级后新会话自动生效。若暂未升级，可用任一等价绕过：

- 配置里命令指向真实 exe（如 `<repo>\.venv\Scripts\python.exe`，args 填 `<repo>\server.py`）——`servers.json` 的 `args` 字段后端本就支持，UI 添加表单也有「参数」区；
- 或命令改填 `cmd`，args 填 `["/c", "C:\\path\\to\\run.cmd"]`。

改动生效时机与现有约定一致：MCP 配置在容器/进程启动时注入，改配置后需新启动的容器/会话才会使用。

## 8. 经验沉淀 / 预防

1. **Windows 下 stdio 启动器一律约定 exe 或经 `cmd /c`**：凡文档/示例给用户的 Windows 启动脚本（`.cmd`/`.bat`），在平台里消费时都要假定它会被 Node 裸 spawn。本次已在 mcp-client 单点兜住，后续新增 spawn 用户配置命令的路径必须复用 `wrapWinBatchCommand`，不要各写各的。
2. **错误信息不要停在 `Connection closed`**：`toErrorMessage` 已补 `EINVAL` 映射。后续遇到 transport 层通用错误，优先把底层 `err.code` 透出到用户可见文案。
3. **巡检**：可在约束测试加一条「`wrapWinBatchCommand` 对 .cmd/.bat 的改写规则」回归（本次已加入 `tests/mcp-client.test.ts`，含非 win32 平台不变式）。
4. **同类风险面**：`container/agent-runner` 各引擎 adapter（codex/opencode 等）spawn 外部 CLI 时若接受用户配置命令，同样需要该兼容层；目前用户 MCP 配置只从上述三个路径进入，暂无第四个入口。
