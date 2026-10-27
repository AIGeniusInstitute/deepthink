# 技术方案：WebSearch 浏览器搜索后端（免 API Key）

对应 PRD：`docs/prd/websearch-browser-backend/PRD.md`

## 1. 总体设计

在 `shared/web-search.ts` 的可插拔后端清单中新增第 6 个后端 `browser`：用平台已内置的 `agent-browser` CLI 驱动真实 Chromium 打开 Bing 搜索结果页，渲染完成后在页面上下文抽取结果卡片，输出与现有后端相同的记录形状，复用既有的 `normalizeItem` / `decodeBingRedirect` / `filterByDomain` 归一化管线。

**为什么用 agent-browser 而不是 puppeteer/playwright**：

- 容器镜像（`container/Dockerfile`）与宿主机（`scripts/install-host-tools.sh`）都已安装 agent-browser + Chromium，零新增依赖；
- 有 `--session <id>` 命名会话（每个 session 独立浏览器实例），搜索可用独立 session，**不干扰 Agent 自己正在用的浏览器**；
- 有 `eval --stdin`（JS 从 stdin 传入），抽取脚本不需要 shell 转义。

**为什么留在 `shared/web-search.ts`（同步源）**：宿主设置页自检（`src/web-search-config.ts` → `runWebSearch`）与容器内实调（`mcp-tools.ts` → `runWebSearch`）必须是同一份实现，否则会出现"自检通过、真调用失败"。本文件原约束是"零 import"，其动机是三端模块布局不同；`node:child_process` 是 Node 内置模块，两个副本（`src/`、`container/agent-runner/src/`）都在 Node ESM 工程内，逐字复制仍然成立。文件头注释同步修订为"仅允许 node: 内置模块"。

## 2. 关键流程

```
runWebSearch('browser', params, creds, timeoutMs)
  └─ searchBrowser()                     # 进程内串行（promise chain，防并发互踩）
      ├─ agent-browser --session websearch-<pid> open <baseUrl>/search?q=<enc(query)>
      ├─ agent-browser --session websearch-<pid> eval --stdin   ← 抽取脚本，stdout 输出 JSON
      ├─ Node 侧：JSON.parse → decodeBingRedirect(url) → {title,url,snippet,site}[]
      └─ finally: agent-browser --session websearch-<pid> close
```

- **session 命名** `websearch-${process.pid}`：agent-browser 的 session 是机器级共享 daemon 的命名空间，加 pid 保证两个宿主进程（如两个 host 模式 agent-runner）互不抢占；同一进程内的并发调用用模块级 promise chain 串行。
- **抽取脚本**（页面上下文执行）：取 `li.b_algo` 卡片（Bing 有机结果卡，含 b_algoBigWiki 等变体——选择器用前缀匹配 `li[class*="b_algo"]`），每张卡取 `h2 a` 的 textContent/href 与 `.b_caption p` 摘要，`JSON.stringify` 后经 stdout 回传。条数上限 `count` 由 Node 侧注入数字字面量。
- **解析 stdout**：先整体 `JSON.parse(trim)`，失败则截取首个 `[` 到末个 `]` 之间的子串再试（容错 CLI 附加日志）；再失败按工具错误处理。
- **超时**：总预算 `timeoutMs`（默认 20s），每步 execFile 的 timeout 取剩余预算，超时 AbortSignal/kill 后返回 `status:'error'`，error 含 `timeout`。
- **错误映射**：ENOENT → `agent-browser_not_installed: npm i -g agent-browser（或 scripts/install-host-tools.sh）`；exit code 非 0 → `browser_cli_failed: <stderr 摘要>`；空结果 → `status:'empty'`。全程不抛异常（`runWebSearch` 的既有契约）。

## 3. Windows 兼容

Windows 上 `execFile('agent-browser', …)` 无法直接跑 npm 的 `.cmd` shim（Node ≥20 对 .bat/.cmd 无 shell 直接 spawn 抛 EINVAL）。处理：

- POSIX：`execFile('agent-browser', args, { timeout })`；
- win32：`execFile(process.env.ComSpec ?? 'cmd.exe', ['/d', '/s', '/c', cmdline])`，cmdline 由 `quoteWinArg()` 逐参加双引号拼接；**参数中的 `%` 一律翻倍**（cmd 按批处理语义做 `%VAR%` 展开，URL 编码里的 `%20` 会被吃掉，`%%` 才还原为字面 `%`）。参数不含双引号（eval 脚本走 stdin，URL 经过 encodeURIComponent），无需转义引号。

## 4. 配置与默认值

| 位置 | 改动 |
|------|------|
| `shared/web-search.ts` | 新增 `browser` provider 元数据 + `searchBrowser()` + `parseEvalJson()` + `quoteWinArg()` + 进程内串行锁；`import { execFile } from 'node:child_process'`（唯一 import） |
| `src/web-search-config.ts` | `resolveWebSearchEnv()` 无配置兜底 `provider = 'bing'` → `'browser'` |
| `container/agent-runner/src/mcp-tools.ts` | `resolveWebSearchProvider()` 未注入 env 时默认：有遗留 `ZHIPU_API_KEY` 仍走 zhipu，否则 `'browser'` |
| `web/src/components/settings/WebSearchSettingsSection.tsx` | 无需改动（providers 列表由 API `providersMeta` 驱动，`needsKey:false` 自动免 key 输入框、显示"（免 key）"） |

Provider 元数据：

```ts
{
  id: 'browser',
  label: 'Bing 浏览器搜索（免费）',
  needsKey: false,
  defaultBaseUrl: 'https://www.bing.com',
  hint: '免 key：驱动本机 agent-browser 打开 Bing 抓取结果。需已安装 agent-browser（容器内置；宿主机跑 scripts/install-host-tools.sh）。可把 baseUrl 改为 https://cn.bing.com。',
}
```

## 5. 测试策略

- `tests/web-search.test.ts` 新增 `browser` 组：`vi.mock('node:child_process')` 桩掉 execFile，断言调用序列 / URL 编码 / session 唯一性 / 结果归一化 / `/ck/a` 解码 / ENOENT / 超时 / 非法 JSON / 空结果；provider 清单断言 5 → 6。
- `tests/units/web-search-config.test.ts`：无配置兜底断言 `bing` → `browser`。
- 手工集成：隔离实例 `make start-prod PORT=9999`，`POST /api/config/web-search/test`（provider=browser）验证真实搜索。

## 6. 风险与回退

| 风险 | 缓解 |
|------|------|
| Bing 改版导致抽取为空 | 抽取器选择器容忍 `b_algo*` 变体；失败时 `status:'empty'/'error'` 明确提示；fetch 版 `bing` 后端仍在，可在设置页手动切回 |
| 宿主机没装 agent-browser | 错误信息给出安装命令；不影响其他后端 |
| 冷启动 Chromium 慢（2-5s） | session 内 `open` 复用已启动实例；仅首次搜索付启动成本（close 后下次重建；如实际使用中嫌慢，后续可做 idle 保活，本期不做） |
| 搜索结果反爬 | 真实 Chromium + 正常 UA，与用户手工访问一致；仍被拦时错误信息带页面摘要便于定位 |
