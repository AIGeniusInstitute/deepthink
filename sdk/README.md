# @deepthink/agent-sdk

把 Agent Studio 导出的 AgentBundle 嵌入任意 Node.js 应用——完整的 agentloop（多轮会话 / 流式 / resume）+ skills + MCP 工具能力包，**无需部署 DeepThink 平台**。

- Node.js ≥ 22
- 需要 Anthropic 兼容的 LLM API key

## 安装

```bash
npm install @deepthink/agent-sdk
# 或本地 tarball：npm install ./deepthink-agent-sdk-0.1.0.tgz
```

安装后建议自检 claude CLI 是否为真实二进制（npm allow-scripts 拦截 postinstall 会残留 stub）：

```bash
node -e "const p=require.resolve('@anthropic-ai/claude-code'); console.log('claude-code ok')"
```

## 快速上手（10 分钟）

```ts
import { Agent, createToolsServer } from '@deepthink/agent-sdk';

// 1) 加载 bundle（Agent Studio → Agent 详情页 → 「导出 SDK Bundle」得到 .zip）
const agent = await Agent.fromBundle('./my-agent.bundle.zip', {
  credentials: { apiKey: process.env.ANTHROPIC_API_KEY },
  workspace: './data/my-agent',            // 会话/记忆/产物都在这里
  secrets: { MY_MCP_TOKEN: process.env.MY_MCP_TOKEN }, // bundle 声明的 ${ENV:...} 密钥
  onEvent: (e) => {
    if (e.eventType === 'text_delta') process.stdout.write(e.text ?? '');
    else if (e.eventType === 'tool_use_start') console.log(`\n[tool] ${e.toolName}`);
  },
  toolsServer: createToolsServer({ workspace: './data/my-agent' }),
});

// 2) 一次性调用
const r = await agent.run('帮我总结这份报告的三个要点');
console.log(r.text, r.usage);

// 3) 多轮会话（自动 resume；跨进程续接同一 workspace）
const session = await agent.start({ prompt: '记住：项目代号是「灯塔」' });
console.log((await session.wait()).text);
session.send('项目代号是什么？');
console.log((await session.wait()).text);
session.interrupt();     // 可中断长任务
await session.close();
```

完整可运行示例见 [`examples/quickstart/`](../examples/quickstart/)。

## 能力分级（Tier）

| Tier | 能力 | 依赖 |
|---|---|---|
| T0 | agentloop：流式 + 多轮会话 + resume + 自包含工具（web_fetch / web_search / disk_* / memory_*） | 仅本包 |
| T1 | + bundle 内联 skills（自动装配到 `{workspace}/.claude/skills/`）+ MCP servers（stdio / http / sse） | bundle 资源 |
| T2（未含） | 平台宿主工具（send_message / schedule_task / sandbox_* 等） | 计划 M1 以 HostBridge 回调开放 |

未实现的能力**不会注册为工具**（不会出现「注册了但报错」的工具）。

## AgentBundle 是什么

Agent Studio 导出的自包含发布物（zip 或目录）：

```
manifest.json          # schema、能力声明、${ENV:...} 密钥引用、contentHash
agent.json             # agent 定义（prompt / model / temperature / 校验策略）
prompts/system.md      # 最终 system prompt（导出时固化，所见即所得）
skills/{id}/SKILL.md   # skill 本体内联
mcp/servers.json       # MCP 配置（env/header 值全部脱敏为 ${ENV:...}）
```

- **完整性**：加载时校验 contentHash，任何篡改即拒绝（可 `skipHashCheck: true` 仅限调试）。
- **密钥不进包**：导出时全部脱敏；加载时通过 `secrets` 选项或环境变量提供。必需密钥缺失会显式报错并列清单。

## API 摘要

| API | 说明 |
|---|---|
| `Agent.fromBundle(path, options)` | 加载 bundle（目录或 .zip），装配 skills/MCP |
| `agent.run(prompt)` | 一次性调用 |
| `agent.start({ prompt, images? })` | 开启会话（自动 resume 同 workspace 历史会话） |
| `session.send(prompt)` | 发送回合（排队，返回本回合结果） |
| `session.wait()` | 等最近回合完成 |
| `session.interrupt()` | 中断当前回合（排队消息不丢） |
| `session.close()` | 关闭会话 |
| `agent.resetSession()` | 清除 resume 状态，下次开新会话 |
| `createToolsServer(ctx)` | 自包含工具 MCP server（web/disk/memory） |
| `loadBundle(path, opts)` | 底层：只解包+校验，不建会话 |

### options

```ts
{
  credentials: { apiKey?, baseUrl?, model? },  // LLM 凭证
  workspace: string,                            // 必填：工作区目录
  onEvent?: (e: StreamEvent) => void,           // 流式事件（text_delta / tool_use_* / ...）
  secrets?: Record<string, string>,             // ${ENV:...} 密钥表（优先于 process.env）
  timeoutMs?: number,                           // 单回合超时（默认 30 分钟）
  extraMcpServers?, toolsServer?,               // MCP 叠加 / 自包含工具
}
```

### StreamEvent

与 DeepThink 平台 Web 流式卡片同一类型（`shared/stream-event.ts` 单一真相源）。常用事件：`init`、`text_delta`、`thinking_delta`、`tool_use_start` / `tool_use_end`、`status`（终态，含 usage）。

## 常见问题

**Q: 报 `missing required secrets: ${ENV:XXX}`？**
bundle 的 MCP 配置引用了密钥。通过 `secrets: { XXX: '...' }` 或环境变量 `XXX` 提供。

**Q: 报 `bundle integrity check failed`？**
bundle 文件被改动过（哪怕一个字节）。重新导出；调试时可 `skipHashCheck: true`。

**Q: web_search 返回 unavailable？**
未配置搜索凭据。传 `toolsServer` 时给 `createToolsServer({ webSearch: { provider: 'zhipu', apiKey } })`，或让 agent 用 `web_fetch`。

**Q: 会话想重新开始？**
`agent.resetSession()`（清除 workspace 内 `.deepthink-sdk/session.json`）。

## Android / 移动端

bundle 是纯数据，可直接打进 Android 应用（assets / 下载），由嵌入式 Node 运行时 + 本包执行（与 android-single-apk 的 libnode 路线兼容）。注意：stdio MCP 需纯 JS 实现；manifest `runtime.mcpDeps` 声明依赖形态。详见技术方案 §4.2。
