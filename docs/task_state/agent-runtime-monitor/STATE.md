# 执行状态 — Agent 运行监控模块

> 需求：把平台里可观测的全部 agent 运行 trace 数据汇总展示 —— 运行轨迹、状态、趋势，
> 含开放平台 AaaS 的 agent service 运行记录。
> 分支：`worktree-feat-agent-runtime-monitor`（worktree：`.claude/worktrees/feat-agent-runtime-monitor`）
> 起止：2026-10-12 ~ 2026-10-13

---

## 1. 阶段进度

| # | 阶段 | 产物 | 状态 |
|---|------|------|------|
| 0 | worktree + 原始意图 | `docs/intent/agent-runtime-monitor/` | ✅ |
| 1 | PRD + 验收标准 + 测试用例 | `docs/prd/agent-runtime-monitor/`（PRD.md / TEST_CASES.md） | ✅ |
| 2 | 技术方案 | `docs/tech_solution/agent-runtime-monitor/` | ✅ |
| 3 | 编码实施 | 见 §2 改动清单 | ✅ |
| 4 | 测试与修复循环 | 见 §3、`docs/test_report/agent-runtime-monitor/` | ✅ |
| 5 | 测试报告（含截图） | `docs/test_report/agent-runtime-monitor/` | ✅ |
| 6 | 合并 main 并 push | — | 见 §6 |

## 2. 改动清单

### 2.1 新增（后端）

| 文件 | 行数 | 职责 |
|------|------|------|
| `src/runtime-monitor/types.ts` | 209 | `RunSummary` / `TraceItem` / `RunFilter` 等统一抽象 |
| `src/runtime-monitor/sources.ts` | 332 | 8 个来源的注册表：各自的原生表 SQL 片段 + 状态归一 + 是否参与「疑似卡住」判定 |
| `src/runtime-monitor/queries.ts` | 690 | `UNION ALL` 统一视图 + KPI / 来源分布 / 工作区分布 / 趋势桶 / 单次运行详情 |
| `src/runtime-monitor/time.ts` | 86 | 时间窗口与桶边界（小时 / 天），时区处理 |
| `src/routes/runtime-monitor.ts` | — | 4 个只读端点：`overview` / `runs` / `runs/:id` / 来源元数据 |
| `src/open-platform/run-recorder.ts` | — | 开放平台 AaaS 运行记录器（新建 / 累积 / 收口，旁路失败不影响主链路） |

### 2.2 新增（前端）

| 文件 | 行数 | 职责 |
|------|------|------|
| `web/src/pages/RuntimeMonitorPage.tsx` | — | 监控页：KPI 七卡 + 趋势图 + 来源 chips + 工作区/Agent 分布 + 运行列表 |
| `web/src/stores/runtime-monitor.ts` | — | Zustand store：筛选、分页、轮询、详情加载 |
| `web/src/components/runtime-monitor/RunDetailPanel.tsx` | 178 | 单次运行的分步轨迹抽屉 |
| `web/src/components/runtime-monitor/format.ts` | 125 | 耗时 / Token / 成本 / 百分比 / 相对时间 / 状态徽章 |

### 2.3 修改（既有文件，共 8 个；`+118 / -20`）

| 文件 | 改动 |
|------|------|
| `src/db.ts` | 新增 `open_platform_runs` 表（schema v72）+ 读写函数 |
| `src/open-platform/agent-service.ts` | `runAgent` / `streamAgent` 两条链路接入 `run-recorder`（`resolveAgent` 通过之后才建行） |
| `src/routes/open-platform.ts`、`open-platform-debug.ts` | 把 `runId` 透出到响应体，便于页面跳转 |
| `src/web.ts` | 挂载 `/api/runtime-monitor/*` |
| `web/src/App.tsx`、`nav-items.ts` | 新增 `/runtime-monitor` 路由与导航项 |
| `Makefile` | `test-smoke` 加入 3 个新测试文件 |

> 设计原则：**归一化只发生在读侧**。除开放平台 AaaS 新增运行记录表外，不改任何既有写入路径
> —— 8 条来源链路的写入行为零改动，监控挂掉不影响业务。

## 3. 测试与缺陷修复记录

### 3.1 测试资产

| 文件 | 用例数 | 覆盖 |
|------|--------|------|
| `tests/runtime-monitor.test.ts` | 60 | 8 来源归一、KPI、趋势桶、筛选、分页、权限隔离、开放平台按 Agent 分组 |
| `tests/units/runtime-monitor-time.test.ts` | — | 时间窗口与桶边界 |
| `tests/units/open-platform-run-recorder.test.ts` | 20 | 运行记录器：状态流转、工具 span、幂等收口、**旁路保证**（表不存在时不抛错） |

`Makefile` 的 `test-smoke`（CI 门禁）已加入上述 3 个文件。

### 3.2 本轮修掉的问题（详见测试报告 §6）

| # | 现象 | 根因 | 处理 |
|---|------|------|------|
| 1 | 同一批 AaaS 运行，KPI 分布里叫 `open-platform`、运行列表里叫 Agent 名；多个 Agent 被压成一行 | `byWorkspace` 直接按 `workspace` 分组，而开放平台的 `workspace` 是常量哨兵 | 分组表达式改为 `CASE WHEN source='open-platform' THEN agent_id ELSE workspace END`；3 条回归测试，反向验证已确认会红 |
| 2 | 页面渲染不出「总成本」，尽管后端已算好 `kpis.costUsd` | 前端漏渲染 | 补一张 KPI 卡（共 8 张，与 AC-F1.1 对齐） |
| 3 | 来源分布只显示有数据的来源，用户**无法**点选当前为空的来源（T6 场景不可达） | 前端只有 `overview.bySource`，没有完整来源清单 | 新增只读端点 `GET /api/runtime-monitor/sources`；chips 以注册表为骨架 |
| 4 | `document.hidden` 时仍每 10s 打后端 | 轮询未处理页签可见性（AC-F6.3 写了没实现） | 照 `ChatView.tsx` 既有模式加可见性守卫 |
| 5 | `run-recorder.ts:138` 注释声称非流式路径收不到流式事件 | 事实错误：两条路径共用 `buildQueryOptions`，`includePartialMessages` 恒为 true | 修正注释，并以实测 tool span 佐证 |
| 6 | PRD T5 三条期望与实现不符 | 见 §3.3 | 已按实测修订 PRD 与 TEST_CASES 并留证 |

### 3.3 文档与现实不符的三处（均已实测修订，非代码缺陷）

1. **对账必须用非 admin 用户**：`billing.ts:66` 对 admin 豁免计费，admin 名下 Agent 的
   `usage_records` 恒为 0 行。已改用真实 member 用户复测，四个同源字段完全一致。
2. **`duration_ms` 两个账本刻意不同**：运行记录是平台侧墙钟，账本是 SDK 自报耗时。
   保留差异的理由见 PRD T5 勘误。
3. **被拒请求不建行**：404 / 403 在 `resolveAgent` 阶段就返回，不会在监控里留痕 —— 这是
   刻意的（被拒的请求没有运行过）。真正需要留痕的是 `resolveAgent` 之后失败的运行，
   已用「不存在的 model」实测确认会落 `status='failed'` 且 `error` 非空。

### 3.4 已知未处理项（不在本需求范围内）

- 生产库里有 **5 条对话轮次自 2026-10-10 起停在 `running`**，被监控页正确地标为「疑似卡住」。
  这是本次新面板**照出来的既有问题**，不是本次引入的 —— 修它属于另一条链路，按 Surgical
  Changes 原则不动，仅在此登记。
- 标签解析的既有粗糙处：`web:swarm:*` 这类 jid 与 `swarm-*` 目录在既无注册群组也无 chat
  记录时会显示成原始 key；两个不同工作区可能共享同一展示名。均为既有数据问题，未改。
- 测试基线文档漂移：`CLAUDE.md` 写「150 个测试文件 / 1734 用例」，实测为 **161 文件 / 2078 用例**。
  属既有文档漂移，未在本次改动中一并修改。

## 4. 验收基线（隔离实例，不碰生产）

| 项 | 值 |
|---|---|
| 端口 | `9997`（9998 已被本机另一个 `node dist/index.js` 占用） |
| 数据目录 | `/tmp/deepthink-rm-9997`（生产 `~/.deepthink-9999` 的 `sqlite3 .backup` + `rsync` 快照） |
| 隔离措施 | `config/user-im` 已改名 `user-im.disabled`（不接管真实用户 IM 长连接）；`scheduled_tasks` 计数为 0（不会触发真实定时任务） |
| 页面 | `http://127.0.0.1:9997/runtime-monitor` |
| 账号 | `admin / 88888888` |

> ⚠️ 该实例是手工前台起的（无 watchdog），**停止必须用**：
> `lsof -ti:9997 -sTCP:LISTEN | xargs kill`
> （只杀监听进程；不加 `-sTCP:LISTEN` 会连带杀掉连到该端口的 OrbStack/Docker 网络代理。）

## 5. 结论

**真正修复**。全部 8 条来源的归一化展示、开放平台 AaaS 埋点闭环、前端页面与真实浏览器
UI 验收（**18/18**）均已通过，证据（18 张截图 + 4 份探针输出 + 测试结果）全部落盘在
`docs/test_report/agent-runtime-monitor/`。无「需人工介入」的遗留阻塞项。
覆盖缺口已在测试报告 §7 明确列出（移动端视口未实测）。

## 6. 合并

- [x] `make typecheck` 全绿（后端 + 前端 + agent-runner，且 shared 副本无漂移）
- [x] `./scripts/check-stream-event-sync.sh` 直接跑 exit 0
- [x] `make test`：2067 passed / 14 skipped，唯一失败为**既有已知抖动**（`tests/feishu-card.test.ts`，单独重跑 94/94 全过）
- [x] `make test-smoke` 全绿（21 文件 / 470 用例）
- [x] 真实浏览器 UI 验收 18/18
- [x] 合并 `worktree-feat-agent-runtime-monitor` → `main`（fast-forward 到 `7b3dad9`）
- [x] push 到 main（`f58aa28..7b3dad9`，atomgit + github 两个 remote 均已推送）
- [x] 隔离验收实例已停止（`lsof -ti:9997 -sTCP:LISTEN | xargs kill`）

---

## 7. 迭代 2 —— 运行轨迹「展开完整轨迹」（2026-10-13，交付后用户反馈）

> 用户反馈：`/runtime-monitor` 运行详情 → 运行轨迹**有截断省略**，需要能展开看完整数据。
> 走 **Issue 修复任务工作流程**（不是新需求），issue 文档：
> [`docs/issues/2026-10-13-runtime-monitor-trace-truncated.md`](../../issues/2026-10-13-runtime-monitor-trace-truncated.md)

### 7.1 改动

`web/src/components/runtime-monitor/RunDetailPanel.tsx` **单文件，+53 / -8**。

- 轨迹行的 `line-clamp-3` 改为按 `expanded` 条件施加；
- 轨迹区标题栏加一个 `展开完整轨迹 / 收起` 按钮（`data-testid="trace-expand-toggle"`）；
- 展开态记的是 `expandedRunId`（不是裸 boolean）—— 换一条运行天然复位，不需要额外 effect；
- `task / sandbox / harness-eval` 等无入参出参的原子运行**不渲染按钮**，避免死按钮。

**只改展示层**：后端 / 数据库 / 写入路径零改动。截断的根因是 CSS，数据本身没丢。

### 7.2 验证（同数据 A/B）

| 项 | 结果 |
|---|---|
| 真实浏览器验收（隔离快照） | **12/12 通过**（[`iteration-2-trace-expand/`](../../test_report/agent-runtime-monitor/iteration-2-trace-expand/EVIDENCE.md)，9 张截图） |
| 旧代码同数据复跑（patch 掉改动重建） | 前 5 步同样通过（现象复现：扫 20 条中 12 条有裁切、1595 个元素被裁、隐藏 192080px），第 6 步**红在「没有展开按钮」** |
| **部署后在用户实际访问的 `localhost:9999` 复测** | 同一脚本再跑一遍**同样全绿**（生产扫 12 条全部有裁切）；仅 `定时任务/沙箱/评测` 分支因生产窗口内 0 条而 SKIP，该分支由隔离快照种子数据验证 |
| 展开后 | 6669 个元素全部 `line-clamp: none`，溢出 0；1595 个原被裁元素可视高度全部变大 |
| 内容完整性 | 6669 个非空字段与后端 payload **逐字一致**（最长 406 字符） |
| 可逆 / 换运行复位 / 死按钮 | 全部通过 |
| `make typecheck` / `make test-smoke` / 漂移门禁 / `make test` | 全绿（同 §6，唯一失败仍是 `feishu-card` 已知抖动） |

### 7.3 合并与部署

- [x] 合并 `worktree-feat-agent-runtime-monitor` → `main`（fast-forward `03fc6c1..c7b8cfe`）
- [x] `make start-prod PORT=9999` 重启生产实例（自动停旧实例 → 编译 → 构建前端 → watchdog 守护）
      旧 watchdog `58956`/node `58959` → 新 watchdog `28117`/node `28121`，`/api/health` 200
- [x] 生产 `:9999` 用同一验收脚本复测全绿（见 §7.2），截图 `08-production-collapsed.png` /
      `09-production-expanded.png`
- [x] 停掉隔离验收实例 `:9997`（`lsof -ti:9997 -sTCP:LISTEN | xargs kill`）
- [x] push 到 main（atomgit + github 两个 remote）

### 7.4 登记（未改，见 issue §3.1）

- 对话 `thinking` 步写入侧上限 **500**（`trace-node-allocator.ts:316,324`，生产 119 行中 108 行已触顶），
  `turn` 步 **400**（`agent-runner/src/index.ts:2413`）—— 这些步展开后仍只能看到库里的那 500/400 字符。
- 读侧 `queries.ts:367-368` 的 `truncate(...,500)` 实测 0/23878 行触顶，属"有损但不生效"，未动。
- 生产 `open_platform_runs` 当前 **0 行**，页面上可见的 8 条 AaaS 运行均为探针产物、只在隔离快照里。
- 移动端视口未实测。
- 验收脚本里 "N/20" 的分母曾写死为扫描上限，在生产只有 12 行时会虚报成 12/20。
  已改为运行时量出的「扫描 N 条，其中 M 条」，生产实为 **12/12**。
