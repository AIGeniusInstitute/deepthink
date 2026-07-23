# 技术方案 — 重写 WebSearch / WebFetch（中国可用）

> 独立文件夹：`docs/tech_solution/rewrite-web-search-fetch/`
> 对应 PRD：`docs/prd/rewrite-web-search-fetch/PRD.md`
> 分支：`feat/rewrite-web-tools`

## 1. 现状与定位

DeepThink 的 Claude Code 引擎 = `container/agent-runner`（Node 22，TypeScript，tsc 编译到 `dist/`）。它通过 `@anthropic-ai/claude-agent-sdk` 的 `query()` 驱动一次会话：

- 内置工具 `WebSearch` / `WebFetch` 由 Claude Code CLI 原生提供，列在 `index.ts` 的 `DEFAULT_ALLOWED_TOOLS`。
- DeepThink 自有的进程内 MCP 工具集 `mcp__deepthink__*` 在 `mcp-tools.ts` 中用 SDK 的 `tool()` 注册，经 `createSdkMcpServer` 挂到 `query({ options: { mcpServers: { deepthink: ... } } })`。
- SDK 提供 **`toolAliases`** 选项（`sdk.d.ts:1358-1382`）：当模型 emit 名为 `WebSearch` 的 `tool_use` 时，执行路径解析到映射目标 `mcp__deepthink__web_search`。官方示例：`toolAliases: { Bash: 'mcp__workspace__bash' }`。

**核心思路**：用 `toolAliases` 把内置 `WebSearch`/`WebFetch` 重定向到自实现的两个 MCP 工具。模型照常调用 `WebSearch`/`WebFetch`，执行落到中国可用的实现。无需改动任何引用这两个工具名的提示词/技能。

## 2. 模块改动清单

| # | 文件 | 改动 | 性质 |
|---|------|------|------|
| 1 | `container/agent-runner/src/mcp-tools.ts` | 新增 `web_search` 与 `web_fetch` 两个 `tool()` 定义 | 新增 |
| 2 | `container/agent-runner/src/index.ts` | `query()` options 增加 `toolAliases` | 新增（小） |
| 3 | `container/agent-runner/prompts/web-fetch.md` | 说明已重写、中国可用 | 文案 |
| 4 | `src/container-runner.ts` | 构建 env 时注入 `ZHIPU_API_KEY` | 新增（小） |
| 5 | `container/agent-runner/dist/*` | `npm run build` 重编译 | 产物 |

不改：`DEFAULT_ALLOWED_TOOLS`（保留 WebSearch/WebFetch 以维持自动审批与兼容引用）、`MEMORY_FLUSH_DISALLOWED_BUILTINS`（已含 WebSearch/WebFetch）、memory flush 动态派生逻辑（自动覆盖新 MCP 工具）。

## 3. 详细设计

### 3.1 `web_search` 工具（mcp-tools.ts）

端口自 `~/zhipu_web_search/client.py` 的逻辑为 TypeScript。签名兼容内置 `WebSearch`：

```ts
tool(
  'web_search',
  'Search the web (China-accessible, via Zhipu paas v4 web_search). Returns titles/content/links. Compatible with built-in WebSearch.',
  {
    query: z.string().describe('The search query'),
    count: z.number().optional().describe('Number of results (default 5)'),
    allowed_domains: z.array(z.string()).optional()
      .describe('Only include results from these domains'),
    blocked_domains: z.array(z.string()).optional()
      .describe('Never include results from these domains'),
  },
  async (args) => { /* ... */ },
);
```

实现要点：
- `apiKey = process.env.ZHIPU_API_KEY || ''`；为空 → 返回 `{status:'error', error:'missing ZHIPU_API_KEY', results:[]}`。
- `POST ${ZHIPU_BASE_URL}/web_search`（`https://open.bigmodel.cn/api/paas/v4`，可由 env `ZHIPU_WEB_SEARCH_BASE_URL` 覆盖），`Authorization: Bearer <key>`，body `{search_query, search_engine:'search_std', count, content_size:'medium'}`，超时 15s。
- 解析 `data.search_result ?? data.data ?? []`，归一化为 `{title,content,link,publish_date,media}`。
- 域名过滤：`allowed_domains`/`blocked_domains` 对 `link` 做包含/排除。
- 全程 try/catch：超时、非 200、异常均降级为 `{status:'error', error, results:[]}`，不抛。
- 返回 JSON 字符串（与内置 WebSearch 的「result blocks」兼容，模型可直接消费）。

并发限流：进程内 `Semaphore` 非必需（智谱 paas 单 agent-runner 并发量低，SDK 已串行化模型 tool_use）。保持简单，不引入。

### 3.2 `web_fetch` 工具（mcp-tools.ts）

签名兼容内置 `WebFetch`（`url` + `prompt`）：

```ts
tool(
  'web_fetch',
  'Fetch a URL and convert the page to Markdown (China-accessible direct fetch, GB18030/GBK aware). The calling Agent should answer `prompt` against the returned markdown.',
  {
    url: z.string().describe('The URL to fetch'),
    prompt: z.string().describe('What to extract/answer from the page'),
  },
  async (args) => { /* ... */ },
);
```

实现要点（全部用 Node 内置，零新依赖）：
1. 校验 `http(s):` scheme；否则返回 error。
2. `fetch(url, { headers: { 'User-Agent': browserUA, 'Accept-Language': 'zh-CN,zh;q=0.9', 'Accept': 'text/html,*/*' }, redirect: 'follow', signal: AbortSignal.timeout(20000) })`。
3. 非 2xx：返回 `{status:'error', http_status, snippet}`。
4. 取 `arrayBuffer()`，按以下优先级解码：
   - `Content-Type: ...; charset=xxx` → `TextDecoder(charset)`
   - HTML 前几 KB 内 `<meta charset=...>` / `<meta http-equiv content="...charset=...">` → 该 charset
   - 默认 `utf-8`
   - `TextDecoder` 支持 `gb18030`/`gbk`（Node 22 full ICU）。charset 不支持时回退 utf-8。
5. HTML→Markdown（手写最小转换器）：
   - 移除 `<script|style|nav|footer|aside|noscript|svg|head>` 整块。
   - 提取 `<title>` 为 `title`。
   - `<h1-h6>` → `#..######`；`<li>` → `- `；`<p|div|br>` → 换行；`<a href>` → `[text](href)`；`<pre|code>` → 代码块；`<img alt>` → `![alt]()`。
   - 去标签 + `decodeHTML`（`&amp; &lt; &gt; &quot; &#39; &nbsp;` 等基础实体）。
   - 压缩多余空白。
6. 截断到 `MAX_CHARS=20000`，超出追加 `\n...[truncated]`。
7. 返回 `{url, status:'ok', title, markdown, note:'Answer the prompt using the markdown above.'}`。

> 不在工具内再调 LLM 回答 `prompt`：调用方 Agent 本身即 LLM，看到 markdown 后自行回答。符合 Simplicity First，避免工具内嵌套模型调用的复杂度与 token 成本。

### 3.3 `toolAliases`（index.ts）

在 `query({ options: { ... } })` 中（`index.ts:1640` 区段）新增：

```ts
toolAliases: {
  WebSearch: 'mcp__deepthink__web_search',
  WebFetch: 'mcp__deepthink__web_fetch',
},
```

放在 `allowedTools` 附近，位置对称、可读。

### 3.4 ZHIPU_API_KEY 注入（src/container-runner.ts）

新增 helper：

```ts
function resolveZhipuApiKey(): string | undefined {
  // 1. host env 直配
  if (process.env.ZHIPU_API_KEY) return process.env.ZHIPU_API_KEY;
  // 2. ~/zhipu_web_search/.env
  const envPath = process.env.ZHIPU_WEB_SEARCH_ENV || '/home/me/zhipu_web_search/.env';
  try {
    const txt = fs.readFileSync(envPath, 'utf8');
    const m = txt.match(/^ZHIPU_API_KEY\s*=\s*(\S+)/m);
    if (m) return m[1];
  } catch { /* not present, skip */ }
  return undefined;
}
```

在构建 `envLines` 处（`container-runner.ts:819` 附近，`buildContainerEnvLines(...)` 之后）追加：

```ts
const zhipuKey = resolveZhipuApiKey();
if (zhipuKey) envLines.push(`ZHIPU_API_KEY=${zhipuKey}`);
```

取不到不阻断启动；`web_search` 调用时返回明确 error（AC4.3）。

> 路径默认硬编码为 `/home/me/zhipu_web_search/.env` 与任务指定的项目位置一致，并允许 `ZHIPU_WEB_SEARCH_ENV` 覆盖。

### 3.5 提示词（prompts/web-fetch.md）

在现有两行后追加说明：WebSearch/WebFetch 已重写为中国可用后端（智谱搜索 + 直连抓取），模型可直接使用，无需回避。

## 4. 编译与部署

- agent-runner 编译：`cd container/agent-runner && npm run build`（tsc → dist）。
- host（container-runner.ts）改动无需单独编译步骤？——`src/` 经根 `package.json` 的 `build:all` 编译到 `dist/`。需 `make build` 或 `npm run build`。
- 容器镜像：`container/Dockerfile` 未变，无需 rebuild 镜像（仅代码挂载/重编译）。
- 运行 DeepThink（pm2 / node 模式）后验证。

## 5. 验证策略

1. **单元级**：在 agent-runner 容器/进程内直接 `node` 跑一段脚本调用 `web_search`/`web_fetch` handler，确认智谱返回 200 且中文 GBK 页面解码正确。
2. **集成级（UI 自动化）**：浏览器登录 `admin / Test12345!`，在会话中分别触发搜索与抓取，确认卡片展示结果、trace 命中 `mcp__deepthink__web_search`/`mcp__deepthink__web_fetch`。
3. **降级级**：清空 key / 错误 URL，确认结构化 error、不崩。

## 6. 取舍记录

- **直连而非 host IPC**：agent-runner 容器已有出网（内置 WebFetch 本就用），工具逻辑就近实现，避免 host 侧新增 IPC handler，符合 Simplicity First。
- **不引入 Cheerio/Turndown**：手写最小 HTML→Markdown，零新依赖，满足中文字符集与基本结构提取需求。
- **保留内置工具可见 + alias**：比 `disallowedTools` 移除更外科，避免改动所有引用 `WebSearch`/`WebFetch` 的提示词/技能。代价是模型仍看到「US-only」描述，靠提示词澄清。
- **WebFetch 不内嵌模型**：返回 Markdown 给调用方 Agent 回答 `prompt`，简单且省 token。
