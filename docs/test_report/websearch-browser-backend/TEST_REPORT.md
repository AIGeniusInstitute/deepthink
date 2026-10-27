# 测试报告：WebSearch 浏览器搜索后端（免 API Key）

- 需求：`docs/prd/websearch-browser-backend/PRD.md`（验收标准 A1-A10）
- 执行环境：Windows 11 Pro（开发机），Node 22，agent-browser 0.39.4 + 本机 Chromium
- 日期：2026-10-28
- 结论：**全部验收通过，零回归**（新增 18 用例全绿；全量失败集合与纯净 HEAD 基线逐条一致）

## 1. 自动化测试

### 1.1 新增用例（tests/web-search.test.ts + tests/units/web-search-config.test.ts）

| 用例 | 对应验收 | 结果 |
|------|---------|------|
| 一次 batch 调用按序执行 open→抽取→close，session 名 `websearch-<pid>`，URL 正确编码 | A1 A2 A3 | ✅ |
| baseUrl 覆盖生效（cn.bing.com） | F2 | ✅ |
| 结果归一化为 WebSearchResultItem（title/content/link/publish_date/media） | A1 F4 | ✅ |
| `/ck/a` 跳转链接解码为真实 URL | A1 F4 | ✅ |
| count 超限收敛到 50 并注入抽取脚本 | A4 | ✅ |
| allowed_domains 过滤生效 | A4 | ✅ |
| 空结果页 → `status: 'empty'` | F7 | ✅ |
| open 失败 → `browser_open_failed`（含页面错误） | F7 | ✅ |
| eval 载荷非法 → `unparsable` 工具错误（不抛异常） | F7 | ✅ |
| agent-browser 未安装（ENOENT）→ `agent-browser_not_installed` + 安装指引 | A5 | ✅ |
| CLI 非 0 退出 → `browser_cli_failed`（带 stderr） | F7 | ✅ |
| 超时 → `browser_timeout`（标注预算 ms） | A6 | ✅ |
| batch 输出带日志噪音仍可解析 | F7 | ✅ |
| 并发搜索串行（maxActive=1） | F3 | ✅ |
| parseJsonTolerant：裸 JSON / 字符串包裹 / 噪音切片 / 拒绝垃圾与空 | F7 | ✅ |
| 无配置兜底 `resolveWebSearchEnv() → 'browser'`（含 env 注入、不注空 key） | A7 F5 | ✅ |
| 设置页自检默认目标 `browser`（testWebSearchConnection） | A8 | ✅ |

统计：新增 18 个用例（web-search.test.ts +14，web-search-config.test.ts 改 2 增 2），全部通过。

### 1.2 全量回归（`npx vitest run`，本机 Windows）

| | 用例总数 | 通过 | 失败 | 跳过 |
|---|---|---|---|---|
| 纯净 HEAD 基线（`git archive HEAD` 导出独立目录） | 2501 | 2472 | 15 | 14 |
| 本分支 | 2519 | 2490 | 15 | 14 |

**失败集合 diff 结果：`IDENTICAL FAILURE SETS`（逐条一致）**——15 个失败全部是本机 Windows 环境的既有失败，与本次改动无关（机械验证：失败文件均不 import 本次改动的模块）。典型原因：

- `os.homedir()` 在 Windows 不读 `HOME`（resolveZhipuApiKey 用例）
- Windows 无 POSIX 文件 mode 位（web-search-config 0600 用例）
- 缺 pdftotext / textutil / pandoc（kb 抽取器用例）
- plugin-importer 临时目录 / 流式卡片 mock 等平台差异

`make typecheck` 通过（exit 0）。`./scripts/check-stream-event-sync.sh` 通过（副本一致）。

> 注：CLAUDE.md 记录的全绿基线（1734 用例）为 POSIX 环境数据；本机 15 个失败建议另行立 issue 处理，不在本需求范围。

## 2. 真实端到端集成验证（A1 铁证）

真实调用 `runWebSearch('browser', …)`（tsx 脚本直跑 `src/web-search.ts`，未 mock 任何东西），驱动本机 agent-browser + Chromium 打开 Bing：

```
status: 'ok', provider: 'browser', query: 'DeepThink AI agent platform', latency_ms: 1859
results: 5 条真实结果（示例）：
  { title: 'DeepSeek | Into the Unknown', link: 'https://www.deepseek.com/', media: 'deepseek.com', … }
  { title: 'DeepThink - AI 科研与自然语言数据分析平台', link: 'http://deepthink.top/', … }
```

- 搜索 URL 经 encodeURIComponent 编码 ✅
- 结果为 http(s) 直链（非 `/ck/a` 跳转）✅
- title/content/media 归一化正确 ✅
- session 隔离 + close（无残留进程）✅
- Windows `shell:true` 调用链（cmd shim）验证可用 ✅

## 3. 设置页 / API 验证（A8，隔离实例真实点击路径）

隔离实例 `make start-prod PORT=9911`（独立数据目录 `$HOME/.deepthink-9911`，未触碰 9999 生产），setup 管理员后经 HTTP API 等价验证设置页行为：

```
$ curl -b cookie http://localhost:9911/api/config/web-search
providersMeta 含：
  { "id": "browser", "label": "Bing 浏览器搜索（免费）", "needsKey": false,
    "defaultBaseUrl": "https://www.bing.com", "hint": "免 key：驱动 agent-browser 打开 Bing 抓取结果，…" }

$ curl -b cookie -X POST http://localhost:9911/api/config/web-search/test -d '{"provider":"browser"}'
{ "status": "ok", "provider": "browser", "query": "DeepThink AI agent platform",
  "results": [ 5 条真实 Bing 结果（title/content/link/media 归一化正确）], "error": null }
```

- providers 列表由 `WEB_SEARCH_PROVIDERS` 驱动（`src/routes/web-search.ts:32-43`），`WebSearchSettingsSection.tsx` 按 `needsKey` 通用渲染（免 key 显示"（免 key）"、无 key 输入框），无 provider 特判——API 返回即 UI 渲染数据源。
- 自检即服务端真实执行 `runWebSearch('browser')`：驱动 agent-browser 完成真实搜索，`status: 'ok'`。

## 4. 影子问题记录（非本需求范围）

- 本机 `make start-prod` 误报"启动失败：端口被 pid 占着"（实际服务正常启动并服务请求），`make stop-prod` 误报"端口未被占用"（实际写入停止标记后 watchdog 正常关停）——Windows 下 pid/端口检测的脚本问题，与 e892387 修复的领域同源，建议后续在 Windows 隔离实例脚本的 issue 中一并处理。
- 修复过程中发现并消除：Node 22 对 `execFile(shell: true, args)` 的 DEP0190 弃用警告——最终实现改用 `cmd.exe /d /s /c` + 静态命令行（动态内容全部走 stdin JSON），日志无警告。

（执行记录见 docs/task_state/websearch-browser-backend/TASK_STATE.md）
