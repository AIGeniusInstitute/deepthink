# 联网搜索（WebSearch）可插拔后端 —— 技术方案

> 关联 Issue：[`docs/issues/2026-10-13-websearch-silent-failure.md`](../../issues/2026-10-13-websearch-silent-failure.md)
> 需求性质：**缺陷修复 + 能力扩展**。缺陷是「WebSearch 长期静默返回 error」，扩展是「单一智谱后端 → 可插拔多后端」。

## 1. 背景与问题

平台的 `WebSearch` 是**自实现**的：内置 WebSearch/WebFetch 在国内不可用，所以 `container/agent-runner/src/mcp-tools.ts` 用 SDK `tool()` 注册了进程内 MCP 工具 `web_search`，再由 `index.ts` 的 `toolAliases` 把模型 emit 的 `WebSearch` 路由过去。

改造前的问题：

1. **后端写死智谱一家**。`mcp-tools.ts` 里直接 `fetch('https://open.bigmodel.cn/.../web_search')`，换后端要改代码。
2. **凭据发现路径硬编码**。`src/container-runner.ts` 的 `resolveZhipuApiKey()` 只认 `process.env.ZHIPU_API_KEY`，否则读 `/home/me/zhipu_web_search/.env`——那个路径只存在于最初的 Linux 开发机。任何其他机器都取不到 key，`web_search` 永远返回 `missing_api_key`，且**不阻断容器启动**，所以没人注意到。
3. **无凭据配置入口**。key 只能靠环境变量或那个硬编码文件，管理员在设置页看不到、也改不了。
4. **配置错误无反馈**。欠费、key 过期、网络不通，Agent 只会拿到一个 error 字符串，管理员没有自检手段。

改造目标：后端可插拔（智谱 / Tavily / 博查 / Serper / Bing 抓取），设置页可配 + 连通性自检，且**未配置任何后端时搜索依然可用**。

## 2. 设计

### 2.1 分层

```
设置页 (React)                →  GET/PUT /api/config/web-search, POST .../test
   ↓
src/routes/web-search.ts      路由（manage_system_config 鉴权 + key 掩码）
   ↓
src/web-search-config.ts      配置读写 + 后端选择 + 自检     [宿主侧，独有]
   ↓
src/web-search.ts  ── 同步副本 ──  shared/web-search.ts      [两端共用，单向真相源]
   ↑
container/agent-runner/src/web-search.ts
   ↓
container/agent-runner/src/mcp-tools.ts   web_search 工具真正执行的地方
```

### 2.2 为什么把 provider 实现放进 `shared/`

宿主侧要跑「连通性自检」，容器侧要跑真正的搜索——同一个请求、同一套归一化逻辑，必须只有一份实现，否则自检通过而实际调用失败（或反之）就毫无意义。

因此 `shared/web-search.ts` 成为**第四个单向真相源**（前三个是 `stream-event.ts` / `image-detector.ts` / `channel-prefixes.ts`），由 `scripts/sync-stream-event.sh` 同步到：

- `src/web-search.ts`（宿主）
- `container/agent-runner/src/web-search.ts`（容器）

同步与校验脚本同时扩了第三对。**修改只改 `shared/`，改副本会被 `make sync-types` 无条件覆盖**；漂移门禁在 CI（`./scripts/check-stream-event-sync.sh`），不要用 `make typecheck` 自查（前置依赖会先 sync 掉漂移）。

该文件**不 import 任何东西**——三个项目的模块布局与 `package.json` 都不同，零依赖是它能被逐字复制的前提（`fetch` / `AbortSignal` / `Buffer` 都是 Node 全局）。

### 2.3 统一契约

```ts
type WebSearchProviderId = 'zhipu' | 'tavily' | 'bocha' | 'serper' | 'bing';

runWebSearch(provider, params, creds, timeoutMs = 20_000): Promise<WebSearchResponse>
```

`runWebSearch` **永不抛异常**，所有失败模式（缺 key / 超时 / 非 2xx / 返回体畸形）都归一成 `status: 'error'` + 可读的 `error` 字符串。这是刻意的：工具抛异常时 Agent 只能看到栈，而一个结构化的 error 字符串它能读懂并换策略（比如改用别的 query）。

`status` 三态：

| status | 含义 |
|---|---|
| `ok` | 拿到了结果 |
| `empty` | 请求成功但解析出 0 条（含被域名过滤清空） |
| `error` | 任何失败，`error` 字段给出原因 |

### 2.4 后端选择优先级

`resolveWebSearchEnv(legacyZhipuApiKey?)` 四分支，**从高到低**：

| 优先级 | 条件 | 结果 |
|---|---|---|
| 1 | `data/config/web-search.json` 存在且 `active` 合法 | 用它选的 provider + 该 provider 的 key/baseUrl |
| 2 | 进程环境变量 `WEB_SEARCH_PROVIDER` 合法 | 用它 + `WEB_SEARCH_API_KEY` / `WEB_SEARCH_BASE_URL` |
| 3 | 旧的 `legacyZhipuApiKey` 能解析出来 | `zhipu` + 该 key |
| 4 | 以上都没有 | **`bing`（免 key）** |

分支 3 保证纯智谱部署零改动升级；分支 4 是本次改造的关键兜底——**「什么都没配」不再等于「搜索不可用」**。

显式选中一个 `needsKey` 的后端却没给 key 时，**不做静默降级**，只打一条 warn 日志（`resolveWebSearchEnv`）。静默降级的失败是「搜出来是别家的结果」，比直接报错更难排查。

### 2.5 凭据注入（宿主机 → 容器/进程）

`resolveWebSearchEnv().env` 产出三个变量：

```
WEB_SEARCH_PROVIDER=<id>
WEB_SEARCH_API_KEY=<key>       # 仅当有 key；免 key 后端不注入空值
WEB_SEARCH_BASE_URL=<url>      # 留空则用该后端默认地址
```

两条注入路径必须**对称**（`src/container-runner.ts`）：

- **docker**（`buildVolumeMounts`，~L897）：push 进 `envLines` → 写 `data/env/{folder}/env`（0600）→ 只读挂载到容器 `/workspace/env-dir/env` → `entrypoint.sh` 载入
- **host**（`runHostAgent`，~L2329）：写进 `hostEnv` → spawn agent-runner 子进程时传入

容器侧 `mcp-tools.ts` 的 `resolveWebSearchProvider()` 读这三个变量；`WEB_SEARCH_PROVIDER` 缺失时回落到 `zhipu`，以兼容改造前部署的旧契约（只注入 `ZHIPU_API_KEY`）。

> ⚠️ 另外，`ZHIPU_API_KEY` 仍会**无条件**注入（只要 `resolveZhipuApiKey()` 有结果），即使当前激活的是别的后端。这是保留改造前行为，避免破坏其它潜在消费者——属于既有行为，本次不动。

### 2.6 各后端实现

| provider | 端点 | 鉴权 | 取结果数组 | 备注 |
|---|---|---|---|---|
| `zhipu` | `POST {base}/web_search` | `Authorization: Bearer` | `search_result[]` | `{search_query, search_engine:'search_std', count, content_size:'medium'}` |
| `tavily` | `POST {base}/search` | `Authorization: Bearer` | `results[]` | `{query, max_results, include_answer:false}`；日期字段是 `published_date` |
| `bocha` | `POST {base}/web-search` | `Authorization: Bearer` | `data.webPages.value[]` | 套的是 Bing Web Search v7 信封 |
| `serper` | `POST {base}/search` | `X-API-KEY` 头 | `organic[]` | 返回 Google 结果；国内直连通常不通 |
| `bing` | `GET {base}/search?q=&count=` | 无 | HTML 抓取 | 免 key 兜底 |

响应字段名各家不一致（`link`/`url`、`title`/`name`、`content`/`snippet`/`summary`、`publish_date`/`published_date`/`date`/`datePublished`/`dateLastCrawled`），统一由 `normalizeItem()` 收敛成：

```ts
{ title, content, link, publish_date, media }
```

`media` 缺失时回落到链接的 hostname。

**Bing 抓取**：`parseBingHtml()` 按 `/<li class="b_algo[^"]*"/` 切卡片（Bing 有多种 `b_algo*` 变体，不能写死一种 class），每段截断 20000 字符防畸形尾部串味；`/ck/a?...&u=a1<base64url>` 形式的跳转由 `decodeBingRedirect()` 解出真实 URL。这是爬虫式实现，Bing 改版或限流会失效——所以设置页的 hint 里明说了。

### 2.7 域名过滤的修复

改造前 `mcp-tools.ts` 里的 `filterByDomain` 用 `host.endsWith(domain)`：

```js
// 旧：'notexample.com'.endsWith('example.com') === true → 误放行
```

新实现按 **label 边界**匹配：

```ts
host === domain || host.endsWith('.' + domain)
```

`example.com` 命中 `example.com` 与 `news.example.com`，不再命中 `notexample.com` / `evil-example.com`。同时容忍注册表里写成 `www.example.com` 或 `.example.com`。

### 2.8 配置存储

`data/config/web-search.json`（0600，原子写 `.tmp` + rename），格式：

```json
{ "active": "tavily", "providers": { "tavily": { "apiKey": "...", "baseUrl": "https://proxy.local/v2" } } }
```

`baseUrl` 可选，用于走代理或自建网关。读取带 mtime 缓存（照抄 `src/embedding.ts` 的既有模式）。

### 2.9 API

| 方法 | 路径 | 说明 |
|---|---|---|
| `GET` | `/api/config/web-search` | 当前后端 + 各后端凭据（key 一律返回 `'<masked>'`）+ `providersMeta` |
| `PUT` | `/api/config/web-search` | 保存。**请求体里省略 `apiKey` 字段 = 保留已存的 key**（UI 就是这么提交「管理员没重打 key」的） |
| `POST` | `/api/config/web-search/test` | 连通性自检。接受 `{provider?, apiKey?, baseUrl?}` 覆盖，**可以测还没保存的凭据**——管理员问的就是「我刚粘的这个 key 行不行」 |

全部三个端点走 `systemConfigMiddleware`（即 `manage_system_config`）。自检失败返回 400，`empty` 返回 200（是成功但不是错误）。

### 2.10 前端

`web/src/components/settings/WebSearchSettingsSection.tsx`，挂在 `设置 → 系统配置 → 联网搜索`（`SettingsTab` 新增 `'web-search'`，同步登记进 `VALID_TABS` / `SYSTEM_TABS` / 移动端 tab / `sectionTitle` / `SettingsNav.systemItems`）。

自检按钮通过 `api.post(path, body, 25_000)` 显式放大超时：客户端默认 8s，而后端给每个 provider 的预算是 20s，不放大就会在请求还在飞的时候先 abort，把「成功」报成「超时失败」。

## 3. 成功判据

1. `shared/web-search.ts` 的三个副本始终一致（CI `check-stream-event-sync.sh` 通过）
2. 未配置任何后端时，`data/env/{folder}/env` 注入 `WEB_SEARCH_PROVIDER=bing`，且**不注入** `WEB_SEARCH_API_KEY`
3. 配了后端时，注入对应 provider + key + baseUrl；`GET` 接口不泄露明文 key
4. 自检对每个后端给出 `ok` / `empty` / `error` 三态，错误原因可读
5. `allowed_domains` / `blocked_domains` 按 label 边界匹配
6. `make test` / `make test-smoke` 全绿；三端 `tsc --noEmit` 无错

## 4. 不做的事

- **不做自动故障转移**（某后端挂了自动换下一家）：后端选择是显式的管理员决策，静默换后端会让人拿到来源不明的结果。当前只有「没配 → bing」这一条兜底，且它是**配置层面**的、可预期的。
- **不引入搜索 SDK**：五家都是普通 HTTP + JSON（Bing 是 HTML），`fetch` 足够；引 SDK 会让 `shared/` 文件无法保持零依赖。
- **Bing 抓取不做反爬对抗**：它是免费兜底，不是主推方案，设置页已明确提示其脆弱性。
