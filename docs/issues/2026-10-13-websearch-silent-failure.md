# WebSearch 长期静默失效：凭据路径硬编码 + 单后端依赖

- **日期**：2026-10-13
- **类型**：Bug / 架构缺陷
- **影响面**：所有走 `claude` 引擎的 Agent 会话中的 `WebSearch` 工具
- **技术方案**：[`docs/tech_solution/web-search-pluggable/`](../tech_solution/web-search-pluggable/README.md)

## 1. 用户现象

Agent 在会话里调用 `WebSearch` 时，拿不到任何搜索结果。工具返回的是一段 JSON：

```json
{"status":"error","query":"...","results":[],"error":"missing ZHIPU_API_KEY"}
```

从用户视角看到的是：**Agent 明明"搜了"，却一律说搜不到 / 答非所问**。没有任何报错弹窗、没有容器启动失败、没有日志告警——`web_search` 取不到凭据是**非致命**的，容器照常启动，Agent 照常继续推理，只是每次搜索都拿到一个空结果 + 一句 error。所以这个状态可以持续数周无人发现。

平台内置的 `WebSearch` 本身就是自实现的（见 §2），所以这里不存在"回落到底层内置搜索"的可能——**自实现挂了就是彻底挂了**。

## 2. 问题描述

平台为了绕开「内置 WebSearch/WebFetch 在国内不可用」，在 `container/agent-runner/src/mcp-tools.ts` 里用 SDK `tool()` 注册了进程内 MCP 工具 `mcp__deepthink__web_search`，再由 `index.ts` 的 `toolAliases` 把模型 emit 的 `WebSearch` 路由过去。

这个自实现工具存在三个叠加的缺陷：

1. **凭据发现路径硬编码**：`src/container-runner.ts` 的 `resolveZhipuApiKey()` 只认 `process.env.ZHIPU_API_KEY`，否则读 `/home/me/zhipu_web_search/.env`（最初那台 Linux 开发机的绝对路径）。别的机器上文件永远不存在，函数返回 `undefined`，容器照常启动，`web_search` 每次调用都返回 `missing ZHIPU_API_KEY`。
2. **单后端写死**：`web_search` 的实现里直接 `fetch('https://open.bigmodel.cn/api/paas/v4/web_search')`。换后端要改代码；上游欠费 / 限流 / 改接口 = 平台搜索能力整体归零，且**没有任何兜底**。
3. **无配置入口、无自检**：凭据只能靠环境变量或那个硬编码文件，管理员在设置页看不到、改不了，也没有任何「按一下看通不通」的手段。

此外还有两个顺带发现的问题：

4. **域名过滤用裸 `endsWith`**：`filterByDomain()` 用 `host.endsWith(domain)` 判断，`notexample.com` 会被 `example.com` 白名单**误放行**（详见 §6）。
5. **容器侧契约是单一实现**：`mcp-tools.ts` 里写死智谱的请求体 / 响应字段（`search_result`、`publish_date`），换个后端要连归一化逻辑一起改。

## 3. 根因

### 3.1 直接原因：硬编码的绝对路径

`src/container-runner.ts`（改造前）：

```ts
function resolveZhipuApiKey(): string | undefined {
  if (process.env.ZHIPU_API_KEY) return process.env.ZHIPU_API_KEY.trim();
  const envPath = process.env.ZHIPU_WEB_SEARCH_ENV || '/home/me/zhipu_web_search/.env';
  try {
    const txt = fs.readFileSync(envPath, 'utf8');
    const m = txt.match(/^ZHIPU_API_KEY\s*=\s*(\S+)/m);
    if (m) return m[1].trim();
  } catch {
    /* file absent / unreadable — skip silently */
  }
  return undefined;
}
```

`/home/me/...` 只存在于最初的 Linux 开发机。本机（macOS）的真实路径是 `~/zhipu_web_search/.env`：

```
$ test -f "$HOME/zhipu_web_search/.env" && echo exists
exists
```

唯一能覆盖这个路径的开关 `ZHIPU_WEB_SEARCH_ENV` **在整个仓库里只被读取、没有任何地方设置**，所以等于没有。取不到 key 又是**静默**的（`catch` 里什么都不做），失败一路传导到 `web_search` 的 `missing ZHIPU_API_KEY`。

### 3.2 深层原因：把所有鸡蛋放在一个后端上

即使把路径修好，**这台机器上的搜索依然不通**。直接用该文件里的 key 请求智谱端点：

```
HTTP 429
{"error":{"code":"1113","message":"余额不足或无可用资源包,请充值。"}}
```

也就是说，「修好路径」并不足以恢复能力。这暴露了真正的问题：平台把搜索能力绑定在**唯一一个需要付费的外部后端**上，既没有替代后端，也没有免凭据的兜底。上游一旦欠费 / 限流 / 改契约，平台搜索即整体失效——而失效方式又是静默的。

> 依据：`resolveZhipuApiKey()` 在 `src/container-runner.ts`；`web_search` 的内联智谱 fetch 在 `container/agent-runner/src/mcp-tools.ts`（改造前 ~L2540-2600）。

### 3.3 顺带发现的过滤缺陷

```js
// 旧实现
return allow.has(d) || [...allow].some((a) => d.endsWith(a));
```

`'notexample.com'.endsWith('example.com')` 为 `true`。`allowed_domains: ['example.com']` 会**放行 `notexample.com`、`evil-example.com`**，`blocked_domains` 同理会误杀、也会误放。这不是本次故障的成因，但在同一次改动里一并修掉了。

## 4. 复现路径

任一条即可复现（无需真实 LLM 调用）：

1. 打开任一 Agent 会话，让它调用一次 `WebSearch`（例如「搜索一下今天的 AI 新闻」）。
2. 观察工具返回的 JSON——`status` 恒为 `error`，`error` 为 `missing ZHIPU_API_KEY`，`results` 恒为空数组。
3. 对照 `~/zhipu_web_search/.env` 是否存在 → 存在；再对照 `resolveZhipuApiKey()` 里的候选路径 → `/home/me/...` 在本机不存在。

要让「连路径都找不到」这一条单独复现：

```
$ ls /home/me/zhipu_web_search/.env
ls: /home/me/zhipu_web_search/.env: No such file or directory
$ ls "$HOME/zhipu_web_search/.env"
/Users/edy/zhipu_web_search/.env
```

## 5. 诊断方法

**① 在会话记录里直接找那个 error 串**（最直接的证据，改造前产生的会话都留着）：

```
grep -rl "missing ZHIPU_API_KEY" "$HOME"/.deepthink-*/sessions
```

本次排查在这台机器上命中 **3 个 session transcript、共 7 处**，时间跨 **2026-10-09 → 2026-10-10**。命中行的形态：

```
... "type":"tool_result","content":[{"type":"text","text":"{\"status\":\"error\",
\"query\":\"multi-agent LLM marketing content generation case study one-person company\",
\"results\":[],\"error\":\"missing ZHIPU_API_KEY\"}"}]} ...
```

**② 确认候选路径与实际路径不符**：

```
grep -n "zhipu_web_search" src/container-runner.ts
test -f "$HOME/zhipu_web_search/.env" && echo "真实位置在 \$HOME"
```

**③ 确认上游后端本身是否可用**（关键：能区分「路径问题」和「账户问题」）：

```
KEY=$(grep -o 'ZHIPU_API_KEY=\S*' "$HOME/zhipu_web_search/.env" | cut -d= -f2)
curl -s -o /dev/stdout -w '\nHTTP %{http_code}\n' \
  -X POST https://open.bigmodel.cn/api/paas/v4/web_search \
  -H "Authorization: Bearer $KEY" -H 'Content-Type: application/json' \
  -d '{"search_query":"test","search_engine":"search_std","count":1,"content_size":"medium"}'
# HTTP 429 / {"error":{"code":"1113","message":"余额不足或无可用资源包,请充值。"}}
```

**④ 修复后自检**：设置页 → 系统配置 → 联网搜索 → 「测试连接」，或

```
curl -b <cookie> -X POST http://127.0.0.1:<port>/api/config/web-search/test \
  -H 'Content-Type: application/json' -d '{"provider":"bing"}'
```

> ⚠️ **`trace_tool_calls` 表不适合做这个诊断**。本次排查中该表里 `tool_name LIKE '%web_search%'` 的行**全部**停在 `status='running'` 且 `output_json` / `output_ref` 均为 NULL（`%search%` 口径下三个隔离实例各 28~29 行），看不到任何结果内容。要查历史搜索结果，走 §5① 的 session transcript。

## 6. 修复方案

### 6.1 凭据路径：加 homedir 候选，并去掉静默

```diff
-function resolveZhipuApiKey(): string | undefined {
+export function resolveZhipuApiKey(): string | undefined {
   if (process.env.ZHIPU_API_KEY) return process.env.ZHIPU_API_KEY.trim();
-  const envPath = process.env.ZHIPU_WEB_SEARCH_ENV || '/home/me/zhipu_web_search/.env';
-  try {
-    const txt = fs.readFileSync(envPath, 'utf8');
-    const m = txt.match(/^ZHIPU_API_KEY\s*=\s*(\S+)/m);
-    if (m) return m[1].trim();
-  } catch { /* file absent / unreadable — skip silently */ }
+  const candidates = [
+    process.env.ZHIPU_WEB_SEARCH_ENV,
+    '/home/me/zhipu_web_search/.env',
+    path.join(os.homedir(), 'zhipu_web_search', '.env'),
+  ];
+  for (const envPath of candidates) {
+    if (!envPath) continue;
+    try {
+      const txt = fs.readFileSync(envPath, 'utf8');
+      const m = txt.match(/^ZHIPU_API_KEY\s*=\s*(\S+)/m);
+      if (m) return m[1].trim();
+    } catch { /* file absent / unreadable — try the next candidate */ }
+  }
   return undefined;
 }
```

选型理由：**保留** `/home/me/...` 候选（老部署可能真的在那）并**追加** `os.homedir()`，而不是直接替换——替换会让原本可用的机器失效。`os.homedir()` 每次调用读 `process.env.HOME`，在测试里可覆盖。

### 6.2 可插拔后端：抽出单一实现到 `shared/`

新建 `shared/web-search.ts`（**零 import**，可被逐字复制到三个项目），落地 5 个后端：

| provider | 端点 | 鉴权 | 免 key |
|---|---|---|---|
| `zhipu` | `POST {base}/web_search` | `Bearer` | ✗ |
| `tavily` | `POST {base}/search` | `Bearer` | ✗ |
| `bocha` | `POST {base}/web-search` | `Bearer` | ✗ |
| `serper` | `POST {base}/search` | `X-API-KEY` | ✗ |
| `bing` | `GET {base}/search?q=` | 无（HTML 抓取） | ✓ |

```ts
runWebSearch(provider, params, creds, timeoutMs = 20_000): Promise<WebSearchResponse>
```

**永不抛异常**——缺 key / 超时 / 非 2xx / 响应体畸形全部归一成 `status: 'error'` + 可读 `error` 串。Agent 能读懂结构化错误并换个 query 重试，读到异常栈则只能干瞪眼。

`shared/web-search.ts` 成为**第四个单向真相源**，同步到 `src/web-search.ts`（宿主自检用）与 `container/agent-runner/src/web-search.ts`（容器实际执行用）。宿主的「连通性自检」与容器的「真实搜索」共用同一份实现——否则自检通过而实际调用失败就毫无意义。`scripts/sync-stream-event.sh` / `check-stream-event-sync.sh` 同步扩了第三对。

容器侧替换掉整段内联智谱实现：

```diff
-const apiKey = (process.env.ZHIPU_API_KEY || '').trim();
-if (!apiKey) { return { ... JSON.stringify({ status: 'error', ..., error: 'missing ZHIPU_API_KEY' }) }; }
-const base = (process.env.ZHIPU_WEB_SEARCH_BASE_URL || 'https://open.bigmodel.cn/api/paas/v4')...;
-try { const resp = await fetch(`${base}/web_search`, { ... }); ... }
+const { provider, credentials } = resolveWebSearchProvider();
+const response = await runWebSearch(provider, args, credentials);
+if (response.status === 'error') {
+  console.error(`[mcp-tools] web_search failed: provider=${response.provider} error=${response.error}`);
+}
+return { content: [{ type: 'text' as const, text: JSON.stringify(response) }] };
```

同时删掉因此变为死代码的局部 `filterByDomain` / `domainOf`（本次改动造成的死代码，按「清理自己的烂摊子」处理）。

### 6.3 后端选择：四级优先级，最低一级免 key

```diff
+if (config)                     { provider = config.active; ... }      // 设置页
+else if (isWebSearchProviderId(envProvider)) { ... }                    // WEB_SEARCH_PROVIDER
+else if (legacyZhipuApiKey)     { provider = 'zhipu'; ... }             // 旧部署零改动升级
+else                            { provider = 'bing'; settings = {}; }   // 免 key 兜底
```

最低一级是本次改动的核心：**「什么都没配」不再等于「搜索不可用」**。

显式选中一个需要 key 的后端却没配 key 时，**不做静默降级**，只打 warn 日志——静默降级的失败形态是「搜出来是别家的结果」，比直接报错更难排查。

### 6.4 域名过滤：按 label 边界匹配

```diff
-  const allow = new Set(allowed.map((d) => d.replace(/^www\./, '').toLowerCase()));
-  return allow.has(d) || [...allow].some((a) => d.endsWith(a));   // notexample.com 被误放行
+  const matches = (host: string, domain: string): boolean =>
+    host === domain || host.endsWith(`.${domain}`);
```

`example.com` 命中 `example.com` 与 `news.example.com`，不再命中 `notexample.com` / `evil-example.com`；注册表里写成 `www.example.com` 或 `.example.com` 也能正确归一。

### 6.5 配置面与自检

新增 `data/config/web-search.json`（0600，原子写 `.tmp` + rename，mtime 缓存）、`src/web-search-config.ts`、`src/routes/web-search.ts`（`/api/config/web-search`，`GET` / `PUT` / `POST /test`，全部 `manage_system_config` 鉴权，key 一律掩码）与设置页 `设置 → 系统配置 → 联网搜索`。

自检接口接受**未保存**的凭据覆盖——管理员问的就是「我刚粘的这个 key 行不行」：

```
POST /api/config/web-search/test  {"provider":"tavily","apiKey":"<未保存的 key>"}
```

两条注入路径（docker 写 `data/env/{folder}/env`、host 写 `hostEnv`）保持对称，注入 `WEB_SEARCH_PROVIDER` / `WEB_SEARCH_API_KEY` / `WEB_SEARCH_BASE_URL`。

### 6.6 验证

- `tests/web-search.test.ts`（33 例）+ `tests/units/web-search-config.test.ts`（21 例），已加进 `make test-smoke` 门禁清单
- 三端 `tsc --noEmit` 无错；`make test` 2121 passed / 14 skipped（唯一失败是既有的 `feishu-card` 5s 超时抖动，单跑通过）
- 真机验证见 §8「验收证据」

## 7. 处理卡住的状态

**a. 已经在跑的 Agent 进程/容器不会自动获得新配置。** 后端与凭据是在**容器启动 / host 进程 spawn 时**注入的（`buildVolumeMounts` 写 `data/env/{folder}/env`、`runHostAgent` 写 `hostEnv`），运行中的会话不会重新读取 `data/config/web-search.json`。改配置后必须**开新会话**（设置页的提示文案已写明这一点）。要强制生效：等当前会话结束，或让容器超时/关闭后重新触发。

**b. 若曾手工设置过 `ZHIPU_WEB_SEARCH_ENV` 指向一个失效文件**，它会**继续排在候选列表第一位**并被优先尝试——不会因此变红，只是白读一次。想切到设置页配置，直接保存一次配置即可（配置优先级高于 `ZHIPU_WEB_SEARCH_ENV`）。

**c. `trace_tool_calls` 里堆积的 `status='running'` 行**是本次排查中观察到的**另一个**现象（诊断口径下三个隔离实例各 28~29 行 `%search%` 记录，`output_json` 全为 NULL）。本次**未**修复、也未定位，仅记录在此避免下次重复排查：

```
SELECT tool_name, status, started_at FROM trace_tool_calls WHERE status = 'running';
```

它影响的是运行轨迹展示，不影响搜索本身，需要单独立项。

## 8. 经验沉淀 / 预防

### 8.1 「缺配置」不能等于「功能永久失效」

这是本次故障的核心教训。凭据缺失是**非致命**的——容器照常起、Agent 照常跑，于是失败可以静默存在数周。两条规则：

- **凡是依赖外部凭据的能力，必须有一条「没有凭据也能工作」的兜底路径**（本次是免 key 的 Bing 抓取），把「失效」降级成「质量下降」；
- 兜底做不到时，**至少不能在 `catch` 里什么都不做**。改造前 `resolveZhipuApiKey()` 三个候选路径的失败全部被静默吞掉——如果当时打一行 warn，这个问题在第一次部署时就会被发现。

### 8.2 不要硬编码开发者机器的绝对路径

`/home/me/...` 这类路径在写它的那台机器上 100% 可用，因此**永远测不出问题**。规则：涉及家目录一律 `os.homedir()`；配置路径一律从 `DATA_DIR` 派生；临时用环境变量兜底时，**要确认它在仓库里真的有人设置**（`ZHIPU_WEB_SEARCH_ENV` 只读不写，等于一个安慰剂开关）。

### 8.3 单一后端 = 单点故障，且是静默的

平台把搜索绑死在唯一一个付费后端上，欠费即全站搜索失效。多后端不只是"多几个选择"，本质是**把上游可用性风险从「平台能力」降级为「配置项」**。

### 8.4 外部依赖要有管理员可点的自检

凭据对不对、代理通不通、账户欠不欠费——这些问题的答案不应该由管理员从 Agent 的报错里猜。自检按钮要支持**未保存的凭据**，因为管理员点它的动机就是「先试试再决定要不要存」。

### 8.5 回归测试必须能区分新旧实现

本次为 `resolveZhipuApiKey` 的 homedir 回退补了用例，并**实测在旧实现上变红**：把函数体换回改造前的单路径版本，该用例失败（`expected undefined to be 'zk-from-home'`），其余 4 条 `resolveZhipuApiKey` 用例仍通过——即该断言精确指向被修的那个缺陷，而不是环境的产物。域名过滤同理：把 `matches` 换回 `endsWith`，7 条过滤用例里 4 条失败，其中一条正是 `notexample.com` 被误放行。**加完回归断言要回旧实现确认它会红**，否则可能只是写了一条永远为真的断言。

### 8.6 新增 `shared/` 真相源要同步扩两个脚本

`shared/web-search.ts` 是本仓库第 4 个单向真相源。新增时必须同时改：

- `scripts/sync-stream-event.sh`（同步到各副本）
- `scripts/check-stream-event-sync.sh`（CI 漂移门禁）

**漂移门禁在 CI，不要用 `make typecheck` 自查**——它的前置依赖 `sync-types` 会先无条件覆盖副本，那道 check 永远通过。本地自查要**直接跑** `./scripts/check-stream-event-sync.sh`。

### 8.7 验收证据（真机，2026-10-13）

全部在隔离实例上进行（独立端口 + 独立数据目录），未触碰生产实例：

| 验证项 | 方法 | 结果 |
|---|---|---|
| 根因修复（homedir 回退） | 走真实 `buildVolumeMounts` → 读生成的 `data/env/main/env` | `ZHIPU_API_KEY` 成功从 `~/zhipu_web_search/.env` 解析出来（shell 环境里并无该变量，证明是回退路径生效） |
| 未配置 → 免 key 兜底 | 同上，`HOME` 指向无 `.env` 的目录 | `WEB_SEARCH_PROVIDER='bing'`，且**不注入** `WEB_SEARCH_API_KEY` |
| 旧部署零改动升级 | 同上，无配置文件但有 key | `WEB_SEARCH_PROVIDER='zhipu'` + 解析出的 key + 智谱默认 base url |
| 设置页配置优先 | 同上，保存 `active=tavily` 后重跑 | `WEB_SEARCH_PROVIDER='tavily'` + 保存的 base url |
| 自检（真实网络） | 设置页点「测试连接」（Bing） | `✓ 连接成功：bing 返回 3 条结果（562ms）` |
| 上游错误可读 | 自检打真实 Tavily（假 key） | `http_401: {"detail":{"error":"Unauthorized: missing or invalid API key."}}` |
| 凭据不泄露 | `GET /api/config/web-search` | key 返回 `'<masked>'`；落盘文件权限 `0600` |
| 「省略字段=保留原值」 | `PUT` 不带 `apiKey` 再读盘 | 已存 key 原样保留 |
| 前端渲染与交互 | 无头 Chrome 走真实登录 → `/settings?tab=web-search` | 5 个后端选项、标题/按钮/侧栏入口齐备；Tavily 显示 Key 输入框、Bing 隐藏；保存后刷新仍为 tavily 且占位符显示「已保存，留空则不变」；**0 个页面错误** |
