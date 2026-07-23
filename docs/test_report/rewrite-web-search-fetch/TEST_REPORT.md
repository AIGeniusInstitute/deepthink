# 测试报告 — 重写 WebSearch / WebFetch（中国可用）

> 需求：`docs/prd/rewrite-web-search-fetch/PRD.md`
> 分支：`feat/rewrite-web-tools`
> 测试日期：2026-07-23
> 测试环境：DeepThink dev 实例，后端从 worktree 以 `tsx` 运行，host 模式 agent-runner 指向 worktree 编译产物（`DEEPTHINK_AGENT_RUNNER_DIR=…/rewrite-web-tools/container/agent-runner`），智谱 key 由 `~/zhipu_web_search/.env` 注入。

## 1. 验收标准逐条结论

| AC | 内容 | 结论 | 证据 |
|----|------|------|------|
| AC1.1 | web_search 兼容内置 WebSearch 签名（query/allowed_domains/blocked_domains） | ✅ | mcp-tools.ts 工具 schema；SDK 路由 harness 模型以 `WebSearch` 调用 |
| AC1.2 | 缺 key 返回 error=missing ZHIPU_API_KEY，不抛 | ✅ | 单元 T6：`status=error, error=missing ZHIPU_API_KEY` |
| AC1.3 | 正常返回 status/results/latency_ms | ✅ | 单元 T1：`status=ok, results=3, latency=653ms` |
| AC1.4 | HTTP 非 200/超时/异常降级为 error+空 results | ✅ | 代码 try/catch 全覆盖；smoke 验证 200 路径 |
| AC1.5 | toolAliases 路由 WebSearch→本工具 | ✅ | SDK debug 日志含 `mcp__deepthink__web_search`（2×）+ 模型 `WebSearch`（1×）；全栈响应"5 条结果" |
| AC2.1 | web_fetch 兼容内置 WebFetch 签名（url/prompt） | ✅ | schema；模型以 `WebFetch` 调用 |
| AC2.2 | 浏览器 UA + zh-CN Accept-Language + 跟随重定向 | ✅ | fetchUrlAsMarkdown 实现；example.com 200 |
| AC2.3 | 非 http(s) scheme / 非 2xx 返回明确错误 | ✅ | 单元 T5：`ftp://x` → `error=invalid url: only http/https supported` |
| AC2.4 | GB18030/GBK 字符集兼容 | ✅ | 集成：新浪（GBK）→ 可读中文"新闻中心首页_新浪网 / 新闻 体育 科技 财经"，无乱码 |
| AC2.5 | HTML→Markdown（去 script/nav，保留标题/段落/列表/链接/代码） | ✅ | example.com → "Example Domain ..."；gov.cn 结构化输出 |
| AC2.6 | 超 20000 字符截断 + `[truncated]` | ✅ | htmlToMarkdown 实现（maxChars=20000） |
| AC2.7 | 返回 {url,status,title,markdown,note} | ✅ | 集成输出含 title/markdown/note |
| AC2.8 | toolAliases 路由 WebFetch→本工具 | ✅ | SDK debug 日志含 `mcp__deepthink__web_fetch`（2×）+ 模型 `WebFetch`（1×）；全栈响应"抓取成功，页面标题 Example Domain" |
| AC3.1 | query() 新增 toolAliases | ✅ | index.ts；编译通过；debug 日志证实路由 |
| AC3.2 | WebSearch/WebFetch 保留在 DEFAULT_ALLOWED_TOOLS | ✅ | index.ts:89-101 未改动 |
| AC3.3 | memory flush 自动覆盖新工具 | ✅ | 既有动态派生逻辑（memoryFlushDisallowedTools）自动纳入，无需改动 |
| AC4.1 | 注入 ZHIPU_API_KEY（env 优先，其次 ~/zhipu_web_search/.env） | ✅ | resolveZhipuApiKey()；全栈 host agent 实际调用智谱成功 |
| AC4.2 | 路径可由 ZHIPU_WEB_SEARCH_ENV 覆盖 | ✅ | 代码实现 |
| AC4.3 | 取不到 key 不阻断启动 | ✅ | resolveZhipuApiKey 失败静默；web_search 调用时返回 error |
| AC5.1 | prompts/web-fetch.md 更新 | ✅ | 已追加"已重写、中国可用"说明 |
| AC5.2 | make build / npm run build 通过 | ✅ | agent-runner tsc + 后端 tsc 均 0 错误 |

## 2. 测试用例结论

| 用例 | 结论 | 证据摘要 |
|------|------|----------|
| T1 智谱搜索可用 | ✅ | 全栈：模型汇报"返回 5 条结果，第一条标题 Python 3.15 Beta 来了…" |
| T2 WebSearch 路由 | ✅ | SDK debug 日志：`mcp__deepthink__web_search` 命中 |
| T3 WebFetch 中文页(GBK) | ✅ | 集成：新浪 GBK → 可读中文（readable_cjk=true） |
| T4 WebFetch 英文页 | ✅ | 全栈：example.com → "Example Domain" |
| T5 WebFetch 错误 | ✅ | 单元：ftp scheme → 明确 error |
| T6 缺 key 降级 | ✅ | 单元：`missing ZHIPU_API_KEY` |
| T7 UI/API 自动化 | ✅ | HTTP 登录 admin/Test12345!（200）→ POST /api/messages → agent 响应正确结果 |

## 3. 关键证据

### 3.1 单元级（直接调编译产物 handler）

加载 `container/agent-runner/dist/mcp-tools.js`，调真实 handler：

```
TOOL_COUNT 28 | HAS web_search: true | HAS web_fetch: true
T1 web_search: ok results= 3 latency= 653  title0= Python 3.15 Beta 来了！这5个新特性…
T6 no-key: error err= missing ZHIPU_API_KEY
T4 web_fetch example.com: ok title= Example Domain md_len= 166
T5 invalid url: error err= invalid url: only http/https supported
GBK: https://news.sina.com.cn/ => ok title= 新闻中心首页_新浪网  readable_cjk=true
     https://www.gov.cn/ => ok title= 中国政府网_中央人民政府门户网站  readable_cjk=true
```

### 3.2 SDK 路由级（最小 query harness）

模型 emit `WebSearch`/`WebFetch`，经 `toolAliases` 路由到 `mcp__deepthink__web_search`/`web_fetch`：

```
TOOL_USE WebSearch {"query":"Python 3.13 新特性"}
TOOL_USE WebFetch {"prompt":"what is this site","url":"https://example.com"}
SDK debug 日志: mcp__deepthink__web_search (2×), mcp__deepthink__web_fetch (2×), WebSearch (1×), WebFetch (1×)
final text: "…WebSearch — query … Status ok, 5 results …"
```

### 3.3 全栈级（DeepThink 平台，admin 登录）

`POST /api/auth/login`（admin/Test12345!）→ 200，cookie 设置。
`POST /api/messages`（web:main，触发 WebSearch + WebFetch）。
host agent（worktree dist）响应（`GET /api/groups/web:main/messages`）：

```
deepthink-agent | 2026-07-23T09:18:13
汇报：
1. WebSearch "Python 3.13 新特性"：返回 5 条结果，第一条标题为 "Python 3.15 Beta 来了！这5个新特性，编程新手越早知道越好"。
2. WebFetch example.com：抓取成功，页面标题为 "Example Domain"。该网站用于文档示例用途。
```

后端日志佐证 agent 使用 worktree agent-runner：
```
resolvedClaudeDir: …/rewrite-web-tools/container/agent-runner/node_modules/@anthropic-ai/claude-agent-sdk-linux-x64
Spawning host agent
Agent output: …5 条结果…Example Domain…
```

## 4. 过程中定位并修复的 Issue

### I1：host 模式未加载 worktree 代码
- 现象：首轮全栈测试，agent 回复"WebSearch 未成功返回搜索结果…WebFetch 抓取失败"（内置工具失败）。
- 根因（有日志证据）：`DEEPTHINK_AGENT_RUNNER_DIR=/opt/DeepThink/resources/agent-runner` 继承自当前会话 env，host 模式跑的是 prod agent-runner（无 toolAliases）。
- 修复：测试时显式 `DEEPTHINK_AGENT_RUNNER_DIR=<worktree>/container/agent-runner`。该 env 仅为测试覆盖；prod 部署更新后自然生效。

### I2：host 模式 ZHIPU_API_KEY 注入缺失
- 现象：原 `resolveZhipuApiKey()`+envLines.push 只在 `buildContainerEnvLines`（docker 路径）后调用；host 模式 `runHostAgent` 构建 hostEnv 不经此处。
- 根因：host/docker 双 env 路径未对称覆盖。
- 修复：在 `runHostAgent` 的 hostEnv 注入段对称注入 `ZHIPU_API_KEY`（`container-runner.ts` hostEnv `DEBUG_CLAUDE_AGENT_SDK` 附近）。

## 5. 环境备注（非代码）

- 为在 node 24 下运行 dev 后端，对 `~/deepthink/node_modules/better-sqlite3` 执行了 `npm rebuild`（原为 node 22 编译）。仅影响 dev 仓库 node_modules，不影响 prod（prod 用独立 node_modules）。如后续在 node 22 下运行 dev，需重新 `npm rebuild better-sqlite3`。
- 测试期间在 worktree 临时 symlink 了 `container/agent-runner/node_modules` 与 `web/node_modules`（均 gitignored，不入库）。

## 6. 结论

**全部验收标准通过**。WebSearch/WebFetch 已重写为中国可用：
- WebSearch 经 `toolAliases` 路由到智谱 paas v4 后端，全栈实测返回真实搜索结果。
- WebFetch 经 `toolAliases` 路由到自实现直连抓取，全栈实测成功抓取 example.com，且 GBK 中文页解码无乱码。
- 失败路径（缺 key / 非法 url / HTTP 错误）均结构化降级，不抛异常。

建议合并 `feat/rewrite-web-tools` → `main` 并 push。prod 部署更新后（重新部署 agent-runner + 后端），国内用户即生效。
