# PRD — 重写 Claude Code 引擎的 WebSearch / WebFetch 工具（中国可用）

> 需求独立文件夹：`docs/prd/rewrite-web-search-fetch/`
> 创建日期：2026-07-23
> 分支：`feat/rewrite-web-tools`（worktree: `.claude/worktrees/rewrite-web-tools`）

## 1. 背景

DeepThink Agent 的 Claude Code 引擎（`container/agent-runner`）基于 `@anthropic-ai/claude-agent-sdk` 的 `query()` 运行。其内置的 `WebSearch` 与 `WebFetch` 工具由 Claude Code CLI 原生实现：

- `WebSearch`：使用仅限美国地区的搜索后端，**中国国内不可用**。
- `WebFetch`：在中国国内网络环境下大量站点抓取失败 / 内容为空，**不可用**。

这导致国内用户使用 DeepThink Agent 进行联网检索、网页读取时功能缺失。

## 2. 目标

重写这两个工具，使其在中国国内网络环境下可用：

1. **WebSearch** → 采用 `/home/me/zhipu_web_search` 项目中的智谱 paas v4 `web_search` 联网检索能力。
2. **WebFetch** → 重新实现，适配中国国内网络的数据获取（直连抓取 + HTML→Markdown + 字符集兼容）。

## 3. 范围

### 3.1 In Scope

- 在 `container/agent-runner/src/mcp-tools.ts` 新增两个进程内 MCP 工具：
  - `mcp__deepthink__web_search`：调用智谱 paas v4 `web_search` API。
  - `mcp__deepthink__web_fetch`：直连抓取 URL，HTML→Markdown，兼容 GB18030/GBK 等中文字符集。
- 在 `container/agent-runner/src/index.ts` 的 `query()` 选项中加入 `toolAliases`，将内置 `WebSearch`/`WebFetch` 重定向到上述两个 MCP 工具（SDK 官方覆盖机制）。
- 在 `src/container-runner.ts` 中向 agent-runner 容器注入 `ZHIPU_API_KEY` 环境变量（复用 `/home/me/zhipu_web_search/.env` 中已有的 key）。
- 更新 `container/agent-runner/prompts/web-fetch.md` 提示词，说明已重写、中国可用。
- 重新编译 agent-runner（`dist/`）。

### 3.2 Out of Scope

- 不改动 host 侧 DeepThink MCP server（`src/` 下 web_search/web_fetch 不走 IPC）。
- 不引入新的外部 npm 依赖（不引入 Cheerio/Turndown 等；用 Node 内置能力 + 最小手写转换）。
- 不改动 codex / atomcode / opencode 引擎。
- 不新增系统设置 UI / DB schema；key 复用既有 `.env` 文件。

## 4. 功能点与验收标准

### F1. `web_search` 工具（智谱后端）

**描述**：调用智谱 paas v4 `web_search`，返回标题/正文/链接/发布日期/媒体。

**验收标准**：
- AC1.1 工具签名兼容内置 `WebSearch`：接受必填 `query: string`；接受可选 `allowed_domains?: string[]`、`blocked_domains?: string[]`（存在时按域名过滤结果，不存在则不过滤）。
- AC1.2 缺 `ZHIPU_API_KEY` 时返回 `status=error`、`error="missing ZHIPU_API_KEY"`，不抛异常。
- AC1.3 正常调用返回 JSON：`{status:"ok"|"empty", query, results:[{title,content,link,publish_date,media}], latency_ms, error}`。
- AC1.4 HTTP 非 200 / 超时 / 异常均降级为 `status=error` + 空 results + error 字段，不抛异常。
- AC1.5 通过 `toolAliases` 在模型调用 `WebSearch` 时路由到本工具执行。

### F2. `web_fetch` 工具（中国可用抓取）

**描述**：直连抓取 URL，转为 Markdown，兼容中文字符集，回答调用方传入的 `prompt`。

**验收标准**：
- AC2.1 工具签名兼容内置 `WebFetch`：接受必填 `url: string`、必填 `prompt: string`。
- AC2.2 使用浏览器风格 User-Agent + `Accept-Language: zh-CN,zh;q=0.9`，跟随重定向，单次抓取。
- AC2.3 非 http(s) scheme 返回明确错误；非 200 返回状态码 + 片段正文。
- AC2.4 字符集兼容：正确解码 UTF-8 与 GB18030/GBK（从 Content-Type charset 与 HTML meta 标签嗅探）。
- AC2.5 HTML→Markdown：移除 `script/style/nav/footer/aside`，保留标题/段落/列表/链接/代码块，输出纯 Markdown 文本。
- AC2.6 内容截断：超过上限（默认 20000 字符）截断并标注 `...[truncated]`。
- AC2.7 返回结构：`{url, status, title, markdown, note}`，其中 `note` 提示调用方 Agent 依据 `markdown` 自行回答 `prompt`（不在工具内部再调模型，保持简单）。
- AC2.8 通过 `toolAliases` 在模型调用 `WebFetch` 时路由到本工具执行。

### F3. toolAliases 重定向

**验收标准**：
- AC3.1 `query()` options 新增 `toolAliases: { WebSearch: 'mcp__deepthink__web_search', WebFetch: 'mcp__deepthink__web_fetch' }`。
- AC3.2 `WebSearch`/`WebFetch` 保留在 `DEFAULT_ALLOWED_TOOLS`（维持自动审批与既有提示词/技能引用兼容）。
- AC3.3 memory flush 阶段 `memoryFlushDisallowedTools` 自动覆盖新工具（既有动态派生逻辑无需改动即生效）。

### F4. ZHIPU_API_KEY 注入

**验收标准**：
- AC4.1 `container-runner.ts` 在构建容器 env 时注入 `ZHIPU_API_KEY`：优先取 host `process.env.ZHIPU_API_KEY`，其次解析 `/home/me/zhipu_web_search/.env` 中的 `ZHIPU_API_KEY=`。
- AC4.2 路径可通过 host 环境变量 `ZHIPU_WEB_SEARCH_ENV` 覆盖（默认 `/home/me/zhipu_web_search/.env`）。
- AC4.3 取不到 key 时不阻断容器启动，仅在 `web_search` 调用时返回明确 error。

### F5. 提示词与构建

**验收标准**：
- AC5.1 `prompts/web-fetch.md` 更新，说明 WebSearch/WebFetch 已重写为中国可用后端，模型可直接使用。
- AC5.2 `make build` / `npm run build`（agent-runner）通过，`dist/mcp-tools.js`、`dist/index.js` 产物更新。

## 5. 测试用例

| 用例 | 步骤 | 期望 |
|------|------|------|
| T1 智谱搜索可用 | 在 DeepThink 会话中让 Agent 用 `WebSearch` 搜「Python 3.13 新特性」 | 返回多条结果，含标题/链接，无 error |
| T2 WebSearch 路由 | 同上，确认日志/trace 显示调用的是 `mcp__deepthink__web_search` | 路由命中本工具 |
| T3 WebFetch 中文页 | 让 Agent 用 `WebFetch` 抓取一个 GBK 中文站点 | 返回可读中文 Markdown，非乱码 |
| T4 WebFetch 英文页 | 让 Agent 用 `WebFetch` 抓取一个常规英文页 | 返回 Markdown，含标题 |
| T5 WebFetch 错误 | 抓取不存在域名 / 非 http scheme | 返回明确 error，不崩 |
| T6 缺 key 降级 | 临时清空 ZHIPU_API_KEY 后搜索 | `status=error, error=missing ZHIPU_API_KEY` |
| T7 UI 自动化 | 浏览器登录 admin / Test12345!，发消息触发搜索与抓取 | 卡片正常展示结果 |

## 6. 非功能要求

- **不引入新依赖**：仅用 Node 内置 `fetch`（Node ≥18，agent-runner 已满足）与 `TextDecoder`（支持 `gb18030`）。
- **向后兼容**：既有引用 `WebSearch`/`WebFetch` 的提示词与技能无需改动即继续可用。
- **失败降级**：两个工具均不抛异常，错误以结构化字段返回。

## 7. 风险与取舍

- **toolAliases 仅对模型 tool_use 生效**：SDK 明确 harness 内部直调不经过别名。若某些 harness 内部直调 `WebFetch`（非模型发起），将走原内置实现。评估后认为检索/抓取均由模型发起，风险可接受。
- **保留内置工具可见性**：模型仍会看到内置 `WebSearch` 描述中的「US-only」字样，但调用会路由到智谱后端。通过 `web-fetch.md` 提示词澄清，风险可接受。
- **WebFetch 不在工具内部再调模型**：返回 Markdown 由调用方 Agent 自行回答 `prompt`，符合 Simplicity First；与内置 `WebFetch` 行为略有差异，已在 note 字段说明。
