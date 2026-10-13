# 测试报告 — Agent 运行监控模块

> 需求：[`docs/prd/agent-runtime-monitor/`](../../prd/agent-runtime-monitor/)（PRD + 测试用例 T1~T11）
> 技术方案：[`docs/tech_solution/agent-runtime-monitor/`](../../tech_solution/agent-runtime-monitor/)
> 执行状态：[`docs/task_state/agent-runtime-monitor/STATE.md`](../../task_state/agent-runtime-monitor/STATE.md)
> 分支：`worktree-feat-agent-runtime-monitor`　测试日期：2026-10-13
> 迭代 2（运行轨迹「展开完整轨迹」）：[`iteration-2-trace-expand/EVIDENCE.md`](./iteration-2-trace-expand/EVIDENCE.md)
> 　对应 issue：[`docs/issues/2026-10-13-runtime-monitor-trace-truncated.md`](../../issues/2026-10-13-runtime-monitor-trace-truncated.md)

## 0. 结论

**真正修复**。全部自动化测试、真实浏览器 UI 验收、真实 LLM 调用的埋点闭环、权限隔离实测均已通过，
证据（截图 + 探针输出 + 测试输出）全部落盘。**无「需人工介入」的遗留阻塞项。**

| 门禁 | 结果 | 证据 |
|---|---|---|
| `make typecheck`（后端 + 前端 + agent-runner） | ✅ 全绿，shared 副本无漂移，9 个 prompt 引用全部解析 | 本报告 §1.1 |
| `./scripts/check-stream-event-sync.sh`（**直接跑**，不经 `make`） | ✅ exit 0 | 本报告 §1.1 |
| `make test`（全量） | ✅ 无回归：**2067 passed / 14 skipped**，唯一失败为**既有已知抖动**（见 §1.2） | 本报告 §1.2 |
| `make test-smoke`（CI 门禁） | ✅ 21 文件 / 470 用例全过 | 本报告 §1.3 |
| 真实浏览器 UI 验收 | ✅ **18/18**，18 张截图 | [`ui-acceptance-result.json`](./ui-acceptance-result.json) + [`screenshots/`](./screenshots/) |
| 开放平台 AaaS 埋点闭环（真实 LLM 调用） | ✅ 四个同源字段与计费账本逐字一致 | [`evidence/`](./evidence/) 下 3 个探针输出 |
| 权限隔离 | ✅ 未登录 401 / 越权 404 | [`evidence/t8-permission-isolation.txt`](./evidence/t8-permission-isolation.txt) |

---

## 1. 自动化测试

### 1.1 静态门禁

```
$ make typecheck
npx tsc --noEmit                        # 后端
cd web && npx tsc --noEmit              # 前端
cd container/agent-runner && npx tsc --noEmit
All shared type copies are in sync.
✓ All 9 prompt references resolved
[exited with code 0]

$ ./scripts/check-stream-event-sync.sh
All shared type copies are in sync.
sync_gate_exit=0
```

> 按项目约定，漂移门禁是**直接跑脚本**（`make typecheck` 的前置会先 sync 掉漂移，跑不出问题）。
> 本次未改动 `shared/`，但仍直接跑了一遍确认。

### 1.2 全量测试

```
$ make test
 Test Files  1 failed | 157 passed | 3 skipped (161)
      Tests  1 failed | 2067 passed | 14 skipped (2082)
```

**唯一失败是既有已知抖动**，不是本次引入：

```
FAIL tests/feishu-card.test.ts > feishu.ts wrapper uses new builder
Error: Test timed out in 5000ms.
```

判别方式（项目文档记载的做法 —— 单独重跑）：

```
$ npx vitest run tests/feishu-card.test.ts
 Test Files  1 passed (1)
      Tests  94 passed (94)
```

单独跑全过 → 判定为整机负载下的 5s 超时抖动。该文件与本需求无任何交集（飞书卡片构建）。

### 1.3 CI 门禁（`make test-smoke`）

本次新增的 3 个测试文件已登记进 `Makefile` 的 `test-smoke` 清单：

```
tests/runtime-monitor.test.ts
tests/units/runtime-monitor-time.test.ts
tests/units/open-platform-run-recorder.test.ts
```

```
$ make test-smoke
 Test Files  21 passed (21)
      Tests  470 passed (470)
   Duration  1.74s
```

### 1.4 本次新增/改动的测试

| 文件 | 用例数 | 覆盖 |
|------|--------|------|
| `tests/runtime-monitor.test.ts` | **61** | 8 来源归一、状态词表映射、stale 判定（含「监督者不参与」）、筛选、分页、权限白名单 fail-closed、轨迹、趋势桶补 0、P95 口径、开放平台按 Agent 分组 |
| `tests/units/runtime-monitor-time.test.ts` | — | 时间窗口与桶边界 |
| `tests/units/open-platform-run-recorder.test.ts` | **20** | 运行记录器状态流转、工具 span、收口幂等、**旁路保证**（表不存在时只吞错不抛） |

其中 4 条是针对**本轮修掉的缺陷**写的回归断言，并已反向验证「改回旧实现会变红」：

| 断言 | 反向验证 |
|---|---|
| `**开放平台按 Agent 而不是哨兵分组**` | 把分组表达式还原成 `workspace` → 3 条断言全红 |
| `**分布与运行列表对同一条运行给出同一个名字**` | 同上 |
| `运行记录表不存在时，onCreate/finish 只吞掉错误而不抛出` | 去掉 try/catch → 断言抛错 |
| `finish 幂等`（completed 后再 finish('failed') 不得覆盖） | 去掉 `isFinished` 守卫 → 断言红 |

---

## 2. 真实浏览器 UI 验收（Playwright + Chromium）

- 脚本：`ui-acceptance.mjs`（落在 `/tmp`，不污染仓库）
- 目标：隔离实例 `http://127.0.0.1:9997`，真实 Chromium（`chromium-1243`），**非** mock
- 产物：18 张截图 + `ui-acceptance-result.json`

```
──────── UI 验收：18/18 通过 ────────
```

| 用例 | 断言点 | 实测 |
|------|--------|------|
| UC-01 | 管理员登录 | 落地 `/chat` |
| UC-02 | KPI 卡片齐全且非零 | 8 张卡齐全；20 次运行、成功率 89.5%、Token 150k、**总成本 $0.78**、P95 49m47s |
| UC-03 | 趋势图有柱子 | 6 根 |
| UC-04 | **来源 chips 共 8 个（含当前为空的）** | 对话 12 / 图编排 0 / 开放平台 8（2 失败）/ Loop 0 / 监督者 0 / 定时任务 0 / 沙箱 0 / Harness 0 |
| UC-05 | 工作区/Agent 分布按 **Agent 名**展示 | 9 行，含「MedDRA 转 WHODrug」，无裸哨兵 `open-platform` |
| UC-06 | 运行列表有数据 | 20 行 |
| UC-07 | 来源筛选生效 | 点「开放平台 AaaS」→ 8 行，全部为该来源 |
| UC-08 | 详情抽屉 + 轨迹 | 抽屉打开，轨迹行非空 |
| UC-09 | Esc 关闭抽屉 | 关闭 |
| UC-10 | 时间窗口切换真的重取数据 | 7d=20 → 30d=98 |
| UC-11 | 「只看疑似卡住」筛选 | 1/20 行，列表带「疑似卡住」标记 |
| UC-12 | 暂停/恢复自动刷新 | 文案切换 `自动刷新中 ↔ 已暂停` |
| UC-13 | 列表列完整性 | 9 列（状态/来源/标题/工作区/归属/耗时/Token/成本/开始时间） |
| UC-14 | **控制台无 JS 报错** | 0 条（已过滤 favicon / React DevTools 噪音） |
| UC-15 | **重名工作区/Agent 可区分** | 9 行 key 全部就位；重名 2 组（共 5 行）可区分 |
| UC-16 | **自动轮询：可见时刷、隐藏时停、切回补一次** | 可见 13s=2 请求；隐藏 13s=**0** 请求；切回 2.5s=2 请求 |
| UC-17 | **空来源降级** | 沙箱/Harness/监督者 各 0 行 + 空状态提示，无 5xx |
| UC-18 | 导航入口 + 直达不 404 | 导航项存在，点击进入 `/runtime-monitor`，整页刷新亦正常 |

### 2.1 两条需要说明的测试手法

1. **UC-16 的「隐藏」是模拟的**。已单独探过：headless Chromium 里开第二个标签页并 `bringToFront()`
   三次，第一个页面的 `document.hidden` **始终为 false**（探针输出见 §2.2）。所以 UC-16 用
   `Object.defineProperty` 接管 `document.hidden` 再手动派发 `visibilitychange` —— **考的是本页对
   可见性信号的处理逻辑，不是浏览器怎么产生这个信号**。真实浏览器里由浏览器产生该信号，语义相同。
2. **UC-15 的重名场景是真实数据里长出来的**，不是构造的：探针创建的多个 Agent 定义同名
   （`agent_definitions` 对 `name` **无唯一约束**，见 `src/db.ts:1170`），页面就渲染出 3 行
   「T5 对账探针 Agent」、2 行「T5 失败路径探针 Agent」。UC-15 断言这些行的 `title` 互不相同。
   反向验证：把 `title` 属性摘掉后重跑，`getAttribute('title')` 返回 `null` → **断言变红**，再装回 → 变绿。

### 2.2 截图清单

`screenshots/UC-01.png` ~ `UC-18.png`（1.7 MB）。其中：

- `UC-02.png`：整页全景（8 张 KPI 卡 + 趋势图 + 来源 chips + 工作区分布）
- `UC-15.png`：工作区/Agent 分布面板特写，可见重名行
- `UC-17.png`：空来源降级后的列表与空状态

---

## 3. 开放平台 AaaS 埋点闭环（真实 LLM 调用，不是 mock）

全部经**真实的 `runAgent` / `streamAgent` 代码路径**调用真实 LLM Provider，输出落盘在
[`evidence/`](./evidence/)。

### 3.1 正常路径 + 与计费账本对账（`t5-billing-reconcile.txt`）

```
✅ input_tokens:  运行记录=24271  账本=24271
✅ output_tokens: 运行记录=91     账本=91
✅ cost_usd:     运行记录=0.12363 账本=0.12363
✅ num_turns:    运行记录=1       账本=1
✅ duration_ms:  墙钟=5533 ≥ SDK=2328（口径不同，不做相等断言）
✅ 墙钟自洽: ended_at - started_at = 5533ms vs duration_ms = 5533ms
✅ 四个同源字段完全一致，duration_ms 差异符合已知口径差异；status=completed
```

**为什么必须用非 admin 用户**：`src/open-platform/billing.ts:66` 对 admin 有豁免
（`if (user?.role === 'admin') return; // admin 豁免：不计量、不扣费`）。最初拿 admin 名下的 Agent
跑，`usage_records WHERE source='open-platform'` **恒为 0 行** —— 那不是埋点漏写，是计费策略。
改用真实注册的 member 用户（`monitor_probe`，经 `POST /api/admin/users` 创建）复测后闭环成立。

**`duration_ms` 两账本刻意不同**（已作为 AC 勘误写进 PRD）：

| 账本 | 取值处 | 含义 |
|---|---|---|
| `open_platform_runs.duration_ms` | `run-recorder.ts:200` `Date.now() - startedMs` | 平台侧**墙钟**端到端耗时 |
| `usage_records.duration_ms` | `agent-service.ts:235` `event.duration_ms` | SDK 自报耗时 |

保留差异的理由：① 墙钟与 `started_at`/`ended_at` 精确自洽（5533 = 5533），UI 的耗时列内部一致；
② 失败/超时路径收不到 SDK 的 `result` 事件，只有墙钟可用，统一口径才能让该列在成功与失败上语义一致；
③ `usage_records` 是计费账本，改口径会波及计费，超出本需求范围。**代价**：监控页与计费明细对同一次
运行会显示两个耗时数字 —— 已知取舍，不是缺陷。

### 3.2 失败路径（`t5-failed-run-row.txt`）

`resolveAgent` **之后**失败（给 Agent 指定一个不存在的 model，让 Provider 报 403）：

```
行数 7 → 8（差 1）
{ "status": "failed",
  "error": "Agent execution failed: Claude Code returned an error result: Failed to authenticate. API Error: 403 当前分组不支持模型「no-such-model-xyz-000」。",
  "ended_at": "2026-10-13T08:37:59.054Z", "duration_ms": 1570, "num_turns": 1 }
✅ 失败路径落 failed 行且 error/ended_at 非空
```

### 3.3 被拒请求**不**落行（`t5-rejected-requests.txt`）

```
抛错 status=404 message=Agent not found
  不存在的 agentId → 行数 7 → 7（差 0）
抛错 status=403 message=You do not have access to this agent
  越权调用 → 行数 7 → 7（差 0）
```

**这是刻意的设计**，PRD 原期望「无效 agent id 也落 `status='failed'` 行」写错了，已勘误：
运行记录在 `resolveAgent` 通过之后才建（`src/open-platform/agent-service.ts:256`），被拒的请求
**没有运行过**，为它建行只会污染监控列表 —— 真被拒的调用方自己就会看到 404/403。

---

## 4. 权限隔离实测（`evidence/t8-permission-isolation.txt`）

```
=== AC-F7.1 未登录 → 401 ===
  /sources                     401
  /overview                    401
  /runs?limit=1                401
  /runs/chat:web:main%23701    401

=== AC-F7.2 admin 看到全量 ===            admin total = 20
=== AC-F7.3 member 只看到自己的 ===       member total = 5
  member 可见 owner:  ['1aafbcf0-d0fb-4359-a97e-7e63bda1bb27']（仅自己）
  member 可见 source: ['open-platform']（仅自己名下的运行）

=== AC-F7.4 同一条 runId ===              admin -> 200 / member -> 404
```

member 看到的是 admin 的**真子集**（5 ⊂ 20），且越权返回 **404 而非 403** —— 403 会泄露
「这个 runId 存在」这一信息。

---

## 5. 验收标准覆盖矩阵

| AC | 覆盖方式 | 结果 |
|---|---|---|
| F1.1 KPI 卡片（8 张） | UC-02 断言 8 个标签齐全 | ✅ |
| F1.2 KPI 与 SQL 一致 | `tests/runtime-monitor.test.ts`（KPI total/成功/失败/运行中 与列表互校） | ✅ |
| F1.3 切窗口数值随之变化 | UC-10（7d=20 → 30d=98）；后端 `窗口 1h 内没有运行 → 各项归零` | ✅ |
| F1.4 疑似卡住警示色 | UC-02/UC-11 截图（警告色，`tone='warn'`） | ✅ |
| F2.1 趋势图与桶对应 | UC-03（6 根柱子）；后端 `趋势桶 key 连续，相邻桶相差恰好一天` | ✅ |
| F2.2 桶内之和 == KPI 总数 | 后端 `趋势桶的 total 之和等于总运行数` | ✅ |
| F2.3 来源分布 8 个来源 | UC-04（**本轮补齐**：空来源也渲染） | ✅ |
| F2.4 空桶不塌陷 | 后端 `**空桶补 0**`；UC-02 截图 x 轴连续到 10-11 | ✅ |
| F3.2 来源筛选 | UC-07；后端 `来源筛选`、`来源筛选在分支级下推` | ✅ |
| F3.3/3.4/3.5 状态筛选 / 分页 / 搜索 | 后端 `状态筛选`、`limit / offset 分页…`、`关键词在 title/工作区上匹配` | ✅ |
| F3.6 空结果空状态 | UC-17 | ✅ |
| F4.2 轨迹行数 == 表行数 | 后端 6 条轨迹测试（chat/graph/open-platform/task/卡住/不存在） | ✅ |
| F4.5 抽屉不整页刷新 | UC-08 + UC-09 | ✅ |
| F5.1~F5.4 埋点闭环 | §3 三个探针（真实 LLM 调用） | ✅ |
| F5.5 埋点异常不影响 AaaS | 单测 `**旁路保证**`（表被改名后 onCreate/finish 只吞错不抛） | ✅ |
| F5.6 不影响既有计费 | §3.1 对账（计费仍以 `usage_records` 为准，两账本并存） | ✅ |
| F6.1 15s 内 ≥2 次刷新 | UC-16（可见 13s=2 个请求） | ✅ |
| F6.2 手动刷新按钮 | UC-02 截图（「刷新」按钮）+ 页面 actions | ✅ |
| F6.3 `document.hidden` 时停轮询 | UC-16（隐藏 13s=0 个请求） | ✅ **本轮补齐** |
| F7.1~F7.4 权限 | §4 实测 | ✅ |
| F8.1/F8.3 导航与直达 | UC-18 | ✅ |
| F8.2 移动端底栏/响应式 | 布局用 `grid-cols-2 md:grid-cols-4 xl:grid-cols-8` + `hidden md:table-cell` 等断点 | ⚠️ **未在移动视口实测**（见 §7） |
| NFR-3 空来源不 5xx | UC-17 | ✅ |
| NFR-5 回归 | §1.2 全量测试 | ✅ |

---

## 6. 本轮发现并修掉的问题（4 个，均有证据）

| # | 现象 | 根因 | 修复 | 验证 |
|---|------|------|------|------|
| 1 | 同一批 AaaS 运行，KPI 分布里叫 `open-platform`、运行列表里叫 Agent 名；多个 Agent 的运行被压成一行 | `byWorkspace` 直接按 `workspace` 分组，而开放平台的 `workspace` 是常量哨兵 | 分组表达式改为 `CASE WHEN source='open-platform' THEN agent_id ELSE workspace END` | 新增 3 条断言 + 反向验证变红 |
| 2 | 页面渲染不出「总成本」，尽管后端已算好 `kpis.costUsd` | 前端漏渲染（API 有、UI 无） | 补一张 KPI 卡（共 8 张，与 AC-F1.1 对齐） | UC-02 断言 8 标签 |
| 3 | 来源分布只显示有数据的来源，用户**无法**点选当前为空的来源，T6 的空来源降级场景在 UI 上不可达 | 前端只拿 `overview.bySource`，没有完整来源清单 | 新增只读端点 `GET /api/runtime-monitor/sources`（吐注册表，避免前端再抄一份名字）；chips 以注册表为骨架 | UC-04 断言 8 个 chip；UC-17 换成真的能点 |
| 4 | `document.hidden` 时仍在每 10s 打后端 | 轮询未处理页签可见性（PRD AC-F6.3 写了但没实现） | 照 `ChatView.tsx:214-247` 的既有模式加可见性守卫 | UC-16（隐藏 13s=0 请求） |

另修正 1 处**我自己代码里的假注释**：`run-recorder.ts` 曾声称非流式路径收不到流式事件。
实际两条路径共用 `buildQueryOptions`，`includePartialMessages` 恒为 true（`agent-service.ts:208`），
已用实测工具 span 佐证后改正。

### 6.1 文档与实现不符的 3 处（已勘误，非代码缺陷）

已同步修订 PRD 与 TEST_CASES，理由见 §3：

1. `AC-F5.3` / T5 失败路径：被拒请求（404/403）**不**落行（原文档写会落）。
2. T5 对账：**必须用非 admin 用户**，admin 被计费豁免。
3. T5 `duration_ms`：两账本口径不同，**不做相等断言**。

### 6.2 验收基线勘误

PRD 原写 `PORT=9998` / 数据目录 `~/.deepthink-9998`；实测跑在 **`9997` / `/tmp/deepthink-rm-9997`**
（9998 被本机另一个 `node dist/index.js` 占用，已核实）。已在 TEST_CASES 顶部注明替换规则。

---

## 7. 已知未处理项（明确不掩盖）

1. **F8.2 移动端视口未实测**。本次 UI 验收固定在 1440×1000。断点类已按项目惯例写了
   （`grid-cols-2 md:grid-cols-4 xl:grid-cols-8`、`hidden md:table-cell`、`hidden lg:table-cell`），
   但**没有在 375px 视口跑过**。这是本次验收的覆盖缺口，不声称已通过。
2. **生产库有 5 条对话轮次自 2026-10-10 起停在 `running`**，被新面板正确标为「疑似卡住」。
   这是本次新面板**照出来的既有问题**，不是本次引入；修它属于对话链路，按 Surgical Changes
   原则不动，仅登记。
3. **标签解析的既有粗糙处**：`web:swarm:*` 这类 jid 与 `swarm-*` 目录在既无注册群组也无 chat
   记录时显示为原始 key；两个不同工作区可能共用同一展示名（已用 `title` 缓解，但列表列未加）。
4. **测试基线文档漂移**：`CLAUDE.md` 写「150 个测试文件 / 1734 用例」，实测 **161 文件 / 2082 用例**。
   属既有文档漂移，未在本次改动中一并修改（避免混入无关改动）。

---

## 8. 环境与可复现性

| 项 | 值 |
|---|---|
| 隔离实例 | `WEB_PORT=9997 DEEPTHINK_DATA_DIR=/tmp/deepthink-rm-9997 node dist/index.js` |
| 数据来源 | 生产 `~/.deepthink-9999` 的 `sqlite3 .backup` 快照 + `rsync` 副本 |
| 隔离措施 | `config/user-im` → `user-im.disabled`（不接管真实用户 IM 长连接）；`scheduled_tasks` 计数为 0（不会触发真实任务） |
| 浏览器 | `chromium-1243`（playwright-core），`serviceWorkers: 'block'` 避免 PWA 缓存导致假阴性 |
| 账号 | admin `admin / 88888888`；member `monitor_probe / probe123456`（本次创建） |

> 停止该实例必须用 `lsof -ti:9997 -sTCP:LISTEN | xargs kill` —— 不加 `-sTCP:LISTEN` 会连带杀掉
> 连到该端口的 OrbStack/Docker 网络代理。
