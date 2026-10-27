# PRD：WebSearch 浏览器搜索后端（免 API Key）

## 1. 背景与目标

Agent 内置的 `WebSearch` 工具已被路由到平台自研的 `web_search` MCP 工具（实现见 `shared/web-search.ts`，可插拔后端）。当前 5 个后端中 4 个（zhipu / tavily / bocha / serper）必须提供搜索 API key，唯一免 key 的 `bing` 后端是纯 HTTP fetch 抓取 Bing HTML，容易被反爬拦截（返回验证页 / 空结果）。

用户没有任何搜索 API key，要求把 WebSearch 改造成：**操作真实浏览器打开搜索引擎完成搜索**。平台已有浏览器自动化基础设施 `agent-browser`（容器镜像内置 + 宿主机 `scripts/install-host-tools.sh` 安装，带 Chromium），直接复用。

**目标**：新增一个免 key 的"浏览器搜索"后端，无任何凭据时 `web_search` 默认走它，用户零配置即可联网搜索。

## 2. 需求范围

### 2.1 功能需求

| # | 功能点 | 说明 |
|---|--------|------|
| F1 | 新增 `browser` 搜索后端 | `WebSearchProviderId` 增加 `'browser'`，`needsKey: false`。通过 `agent-browser` CLI 打开 Bing 搜索结果页，渲染后抽取结果卡片 |
| F2 | 搜索引擎 | Bing（用户已确认）。默认 `https://www.bing.com`，`baseUrl` 可覆盖为 `https://cn.bing.com` 等镜像 |
| F3 | 浏览器会话隔离 | 搜索使用独立的 agent-browser session（`--session websearch-<pid>`），不干扰 Agent 自身正在使用的浏览器会话；搜索结束关闭该 session |
| F4 | 结果结构 | 与现有后端一致：`WebSearchResultItem`（title / content / link / publish_date / media），`/ck/a` 跳转链接解码为真实 URL，支持 `allowed_domains` / `blocked_domains` / `count` |
| F5 | 默认后端切换 | 无任何配置（无 settings 配置、无 env、无遗留 ZHIPU key）时，默认后端从 `bing`（fetch 爬虫）换成 `browser` |
| F6 | 设置页 | 新后端在 `/settings` 联网搜索配置中出现（列表来自 `WEB_SEARCH_PROVIDERS` API，免 key 显示"（免 key）"，无 key 输入框），支持连通性自检 |
| F7 | 错误可读 | `agent-browser` 未安装、超时、页面无结果等失败以 `status: 'error'` + 可读 error 返回，不抛异常、不崩工具 |

### 2.2 非目标

- 不支持百度 / DuckDuckGo 等其他搜索引擎（后续可扩展）
- 不改动 4 个付费 API 后端的实现
- 不删除 fetch 版 `bing` 后端（保留为轻量备选）
- 不改 `web_search` MCP 工具的入参/出参签名

## 3. 验收标准

| # | 验收标准 | 对应功能 |
|---|---------|---------|
| A1 | `WEB_SEARCH_PROVIDER=browser` 时，`runWebSearch('browser', {query})` 返回 `status: 'ok'`，`results` 非空，每条含 title/link（http(s) 直链，非 /ck/a 跳转）/content | F1 F4 |
| A2 | 查询词正确编码进搜索 URL（含中文、空格、`&` 等特殊字符） | F1 |
| A3 | 搜索全程使用名为 `websearch-<pid>` 的独立 session，结束后 close；不触碰 `default` session | F3 |
| A4 | `count` 生效（返回条数 ≤ count），`allowed_domains` / `blocked_domains` 过滤生效 | F4 |
| A5 | 未安装 agent-browser 时返回 `status: 'error'`，error 含安装提示；不抛异常 | F7 |
| A6 | 搜索超时（默认 20s）返回 `status: 'error'`，error 标明 timeout | F7 |
| A7 | `resolveWebSearchEnv()` 在无任何配置时 `provider === 'browser'` | F5 |
| A8 | 设置页 providers 列表含 `browser`（免 key），保存后 `data/config/web-search.json` 持久化，自检走浏览器后端 | F6 |
| A9 | `make sync-types` 后三处副本一致；`./scripts/check-stream-event-sync.sh` 通过 | — |
| A10 | `make test` 全量通过（基线 1719 passed / 14 skipped），`make typecheck` 通过 | — |

## 4. 测试用例

| 用例 | 类型 | 步骤 | 预期 |
|------|------|------|------|
| T1 | 单元 | mock `node:child_process`，断言调用序列：session 名唯一 → `open` 搜索 URL → `eval` 抽取脚本 → `close` | 序列正确，URL query 已编码 |
| T2 | 单元 | mock eval 输出为合法结果 JSON | 归一化为 `WebSearchResultItem`，`status: 'ok'` |
| T3 | 单元 | mock eval 输出含 `/ck/a` 跳转链接 | link 解码为真实 URL |
| T4 | 单元 | mock CLI 不存在（ENOENT） | `status: 'error'`，error 含 `agent-browser` 安装提示 |
| T5 | 单元 | mock eval 输出非法 JSON / 空数组 | 分别 `error` / `empty` |
| T6 | 单元 | mock 慢命令超过 timeoutMs | `status: 'error'`，error 含 timeout |
| T7 | 单元 | `resolveWebSearchEnv()` 无配置 | `provider === 'browser'`，env 含 `WEB_SEARCH_PROVIDER=browser` |
| T8 | 单元 | `filterByDomain` / `clampCount` 对 browser 后端生效 | 过滤、条数上限正确 |
| T9 | 回归 | 既有 `tests/web-search.test.ts`、`tests/units/web-search-config.test.ts` 更新后全绿（provider 清单从 5 → 6，fallback bing → browser） | 全绿 |
| T10 | 集成（手工/隔离实例） | 真实环境 `POST /api/config/web-search/test`（provider=browser） | `status: 'ok'`，返回真实搜索结果 |

## 5. 约束与依赖

- `shared/web-search.ts` 是单向同步源，改动后必须 `make sync-types`；禁止改 `src/`、`container/agent-runner/src/` 下的副本
- 该文件零第三方依赖（可引入 node 内置模块 `node:child_process`，两个副本均在 Node ESM 工程内）
- 运行环境：容器内 agent-browser 全局已装；宿主机需 `scripts/install-host-tools.sh` 装过；Windows 宿主机调用需 cmd 兼容的命令拼接
- 不引入 bun；不改 StreamEvent 类型
