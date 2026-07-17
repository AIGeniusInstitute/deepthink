# Codex 引擎对话无响应：`__dirname is not defined`

- 日期：2026-07-18
- 影响范围：Web 端 /chat 选择 Codex 引擎时全部对话失败；OpenCode 引擎同样受影响
- 严重级别：P0（Codex 引擎完全不可用）
- 状态：已修复

## 1. 用户现象

在 http://localhost:5173/chat 切换到 Codex 引擎后，发送任何消息（你好 / 你是谁 / 你能干什么）都
**没有响应**，前端转圈停留在「DeepThink 正在思考...」，随后弹出系统消息：

```
系统错误
Codex engine error: __dirname is not defined
```

并伴随：

```
admin Home 处理失败，已达最大重试次数
```

对比之下，AtomCode 引擎同样位置可以正常对话、调用技能工具、生成会话产物。

## 2. 问题描述

agent-runner 容器侧的 codex-engine.ts 在准备 Codex 运行时配置时，通过 `__dirname` 拼接 MCP bridge
脚本路径：

```ts
const mcpBridgePath = path.join(__dirname, 'mcp-bridge.js');
```

但 agent-runner 子包的 package.json 声明 type: module，且 tsconfig.json 为
module: NodeNext，编译产物 dist/codex-engine.js 以 **ESM** 方式运行。在 ESM 模块作用域中
`__dirname` / `__filename` 并不存在（它们是 CommonJS 注入的全局变量），求值时抛出
ReferenceError: __dirname is not defined。

该异常发生在 runCodex() 主流程的最早阶段（生成 $CODEX_HOME/config.toml 之前），因此整个 turn 直接
失败、没有任何流式输出，前端表现为「对话没反应」。

OpenCode 引擎（opencode-engine.ts）存在完全相同的缺陷，因同样的 type: module 约束而同样不可用。
AtomCode 引擎（atomcode-engine.ts）不引用 MCP bridge / __dirname，因此不受影响——这也是用户对照
「AtomCode 能用、Codex 不能用」的原因。

## 3. 根因

- 代码层面：container/agent-runner/src/codex-engine.ts:490 与
  container/agent-runner/src/opencode-engine.ts:628 使用了 CommonJS 专属全局变量 `__dirname`。
- 模块系统层面：container/agent-runner/package.json 设置 type: module，tsconfig.json
  设置 module: NodeNext，导致 .js 产物按 ESM 求值；ESM 中 __dirname 未定义。
- 同仓库内已有正确范式：container/agent-runner/src/index.ts:140 使用
  `path.dirname(fileURLToPath(import.meta.url))`，并在注释中明确说明「用 fileURLToPath 而非
  new URL(...).pathname，后者在 Windows host 模式下返回 /E:/... 导致路径错误」。本次两处引擎
  代码未沿用该范式，属于历史遗留。

外部依据：
- Node.js 官方文档：ESM 中 __dirname / __filename 不可用，需用 import.meta.url +
  fileURLToPath 替代。https://nodejs.org/api/esm.html#esm_no_filename_or_dirname

## 4. 复现路径

1. 启动 DeepThink 后端与前端（npm run dev:all），并使 agent-runner 容器可用。
2. 浏览器访问 http://localhost:5173/chat ，引擎选择 Codex。
3. 发送任意一句话（如「你好」）。
4. 前端一直转圈，随后弹窗「Codex engine error: __dirname is not defined」，
   后端 agent-runner 日志可见同一 ReferenceError。

最小代码级复现（无需启动全栈）：

```bash
cd container/agent-runner
node --input-type=module -e "console.log(__dirname)"   # 抛 ReferenceError: __dirname is not defined
```

## 5. 诊断方法

```bash
# 1) 确认源码与编译产物都残留 __dirname
grep -rn "__dirname" container/agent-runner/src container/agent-runner/dist

# 2) 确认 agent-runner 为 ESM（type: module）
grep '"type"' container/agent-runner/package.json

# 3) 直接复现运行时异常
cd container/agent-runner && node --input-type=module -e "console.log(__dirname)"
```

预期：步骤 1 命中 codex-engine.{ts,js} 与 opencode-engine.{ts,js}；步骤 2 输出 type: module；
步骤 3 抛 ReferenceError。

## 6. 修复方案

沿用 index.ts 已有范式，用 `import.meta.url` + `fileURLToPath` 在 ESM 下取得等价 `__dirname`。
仅触碰两处必需代码，未改动周边逻辑（Surgical Changes）。

**container/agent-runner/src/codex-engine.ts**

```diff
 import * as readline from 'node:readline';
+import { fileURLToPath } from 'node:url';
+
 import type { ContainerInput, ContainerOutput, StreamEvent } from './types.js';
 ...
-  const mcpBridgePath = path.join(__dirname, 'mcp-bridge.js');
+  const mcpBridgePath = path.join(path.dirname(fileURLToPath(import.meta.url)), 'mcp-bridge.js');
```

**container/agent-runner/src/opencode-engine.ts**

```diff
 import net from 'node:net';
+import { fileURLToPath } from 'node:url';
 ...
-  const mcpBridgePath = path.join(__dirname, 'mcp-bridge.js');
+  const mcpBridgePath = path.join(path.dirname(fileURLToPath(import.meta.url)), 'mcp-bridge.js');
```

选型理由：
- 与同仓库 index.ts:140 完全一致，避免引入第二种路径范式；注释也提示该写法在 Linux 容器
  与 Windows host 模式下都正确，跨平台安全。
- 不引入 polyfill（如 `const __dirname = ...` 顶层常量），最小侵入；两处各仅一次使用，内联即可读。

验证：

```bash
cd container/agent-runner
npx tsc --noEmit                         # typecheck 通过
npm run build                            # 编译产出 dist
grep -n "mcpBridgePath" dist/codex-engine.js dist/opencode-engine.js
# 产物中 __dirname 已被 fileURLToPath(import.meta.url) 替换
```

运行时验证（在 dist 目录下执行修复后的路径计算）：

```bash
cd container/agent-runner/dist && node --input-type=module -e '
import path from "node:path"; import fs from "node:fs"; import { fileURLToPath } from "node:url";
const p = path.join(path.dirname(fileURLToPath(import.meta.url)), "mcp-bridge.js");
console.log(p, fs.existsSync(p));'
# 输出: .../dist/mcp-bridge.js true
```

## 7. 处理卡住的状态

本 issue 不涉及已 stuck 的运行态（异常在 turn 起始即抛出，进程未进入 IPC 轮询）。用户侧表现
「一直转圈」是前端未收到 turn 终止事件所致——前端切换引擎或刷新页面、后端重启 agent-runner 即恢复。
修复后无需手动救活任何会话状态。

## 8. 经验沉淀 / 预防

- 根因类型：ESM 迁移遗漏。仓库顶层与 agent-runner 子包都已是 type: module，但引擎适配代码
  仍残留 CommonJS 全局变量（`__dirname` / `__filename` / `require`）。本次修了两处，但仓库内
  可能还有同类残留。
- 巡检脚本（建议加入 CI / pre-commit）：

```bash
# 在 ESM 包内禁止出现 CommonJS 专属全局
! grep -rn "__dirname\|__filename" container/agent-runner/src || { echo "found CJS global in ESM"; exit 1; }
```

- 已有正确范式（index.ts 的 fileURLToPath 注释）应在新写引擎适配时直接复用，避免再次踩坑。
- 告警建议：agent-runner 在 runCodex/runOpencode 顶层 try/catch 输出 error 时，当前消息
  「Codex engine error: __dirname is not defined」已包含原始异常信息，定位友好；但前端
  「admin Home 处理失败，已达最大重试次数」提示不够明确，后续可考虑把引擎层异常码透传到前端，
  便于用户快速判断是引擎故障而非会话故障。
