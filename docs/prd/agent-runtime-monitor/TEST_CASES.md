# 测试用例 — Agent 运行监控模块

> 与 [`PRD.md`](./PRD.md) 的 AC 编号一一对应。
> **验收基线**：隔离实例 `make start-prod PORT=9998`，数据目录由生产 `~/.deepthink-9999` **复制**而来
> （保证 12005 行 `chat_trace_nodes` 等真实数据在位），页面 `http://127.0.0.1:9998/runtime-monitor`。
>
> **⚠️ 实际执行勘误（2026-10-13）**：实测跑在 **`PORT=9997` + 数据目录 `/tmp/deepthink-rm-9997`**
> （生产库用 `sqlite3 .backup` 快照 + `rsync` 复制的等价副本），页面 `http://127.0.0.1:9997/runtime-monitor`。
> 下文命令里的 `9998` / `~/.deepthink-9998` 请按此替换后再执行，其余步骤与断言不变。
> 换端口/换目录的原因：9998 已被本机另一个实例占用，且探针实例需与生产 IM 通道隔离（已把
> `config/user-im` 改名为 `user-im.disabled`，并确认 `scheduled_tasks` 为 0，避免触发真实用户的任务）。
> **期望值的取法**：凡涉及计数/求和的用例，期望值一律**在测试时用等价 SQL 现算**（不硬编码），
> 以保证用例长期有效；仅对结构性事实（字段存在、路由存在）做硬编码断言。

---

## 0. 生产基线（2026-10-13 实测，供参考与回归对照）

| 指标 | 值 |
|---|---|
| `chat_trace_nodes` 总行数 | 12005 |
| chat 运行数（`node_type='turn' AND parent_node_id IS NULL`） | **78**（done 73 / running 5） |
| `graph_runs` | **15**（completed 13 / failed 2） |
| `graph_node_runs` | 43 |
| `trace_tool_calls` | 23878 |
| chat 运行数 · 近 30 天 | 75 |
| 全部 5 个 `running` chat 运行的 `started_at` | 2026-10-10 及更早 → **全部为「疑似卡住」** |
| `usage_records` | 323（全部 `source='agent'`；`open-platform` 为 0，本次埋点后产生） |
| `loop_runs` / `supervisor_sessions` / `task_run_logs` / `sandbox_executions` / `harness_eval_runs` | 均为 0 |

> 预期首屏：总运行数 = chat 78 + graph 15 = **93**（`open-platform` 埋点产生前）。
> 若与页面不符即为缺陷。

---

## T1 — 总览 KPI 正确性（对 AC-F1.1 / F1.2 / F1.3 / F1.4）

**步骤**
1. 打开 `http://127.0.0.1:9998/runtime-monitor`
2. 记录「运行中」「总运行数」「失败数」「总 tokens」四项
3. 用 SQL 现算对照：

```bash
DB=~/.deepthink-9998/db/messages.db
# 运行中（chat + graph 两个有数据的来源）
sqlite3 -readonly "$DB" "
  select (select count(*) from chat_trace_nodes where node_type='turn' and parent_node_id is null and status='running')
       + (select count(*) from graph_runs where status='running')"
# 总运行数
sqlite3 -readonly "$DB" "
  select (select count(*) from chat_trace_nodes where node_type='turn' and parent_node_id is null)
       + (select count(*) from graph_runs)
       + (select count(*) from open_platform_runs)"
# 失败数
sqlite3 -readonly "$DB" "
  select (select count(*) from chat_trace_nodes where node_type='turn' and parent_node_id is null and status='failed')
       + (select count(*) from graph_runs where status='failed')"
```

**期望**：页面数值与 SQL 结果一致（窗口选择「全部」或与 SQL 同窗口）。

**通过判据**：三项全部相等；「疑似卡住」> 0 且为警色。

---

## T2 — 趋势桶自洽（对 AC-F2.1 / F2.4）

**步骤**
1. 选窗口 `7d`，记录趋势图各桶的「运行数」之和
2. 与同窗口 KPI「总运行数」比较

**期望**：桶之和 == KPI 总运行数（允许窗口边界 1 个运行的差异）。

**通过判据**：差值 ≤ 1；x 轴无塌陷（无数据的桶显示 0 而非缺列）。

---

## T3 — 来源筛选正确性（对 AC-F3.2）

**步骤**
1. 来源筛选选「图编排」
2. 页面显示条数记为 `n`

```bash
sqlite3 -readonly ~/.deepthink-9998/db/messages.db "select count(*) from graph_runs"
```

**期望**：`n == 15`（或 SQL 现算值）；列表内不出现 chat 来源的行。

**通过判据**：相等且来源列全为「图编排」。

---

## T4 — 运行详情轨迹行数（对 AC-F4.2）

**步骤**
1. 在「对话」来源里选一条工具调用较多的运行（生产基线中 `chat_jid='web:main'`, node id 701 为典型）
2. 打开详情，记录时间线条目数 `m`
3. SQL 现算期望：

```bash
DB=~/.deepthink-9998/db/messages.db
JID='web:main'; NODE=701
# turn 子树（含自身）
sqlite3 -readonly "$DB" "
  with recursive t(id) as (
    select $NODE
    union all
    select c.id from chat_trace_nodes c join t on c.parent_node_id = t.id
    where c.chat_jid='$JID'
  ) select count(*) from t"
# 时间窗内 tool calls
sqlite3 -readonly "$DB" "
  select count(*) from trace_tool_calls
  where chat_jid='$JID'
    and started_at >= (select started_at from chat_trace_nodes where chat_jid='$JID' and id=$NODE)
    and started_at <= coalesce((select ended_at from chat_trace_nodes where chat_jid='$JID' and id=$NODE), '9999')"
```

**期望**：`m` 与「turn 子树节点数 + 时间窗内 tool call 数」一致（两者去重后）。

**通过判据**：条目数相等；按 `startedAt` 升序；有 `parentSpanId` 的条目层级可辨。

---

## T5 — 开放平台 AaaS 埋点闭环（对 AC-F5.1 ~ F5.4）

**步骤**
1. 记录埋点前 `open_platform_runs` 行数 `b`
2. 通过调试台触发一次 Agent 调用（页面 `/open-platform` 的调试面板，或 API）：

```bash
curl -s -b /tmp/dtk-cookies.txt -X POST http://127.0.0.1:9998/api/open-platform/debug/agent \
  -H 'content-type: application/json' \
  -d '{"agentId":"<某个 agent_def id>","message":"ping，请只回复 pong"}' | head -c 500
```

3. 查询：

```bash
sqlite3 -readonly ~/.deepthink-9998/db/messages.db \
  "select id, agent_id, status, duration_ms, input_tokens, output_tokens, cost_usd, num_turns, error
   from open_platform_runs order by started_at desc limit 1"
# 与同批 usage_records 对照
sqlite3 -readonly ~/.deepthink-9998/db/messages.db \
  "select input_tokens, output_tokens, cost_usd, duration_ms, num_turns
   from usage_records where source='open-platform' order by created_at desc limit 1"
```

**期望**
- 行数 `b+1`，`status='completed'`
- tokens / cost / num_turns 与 `usage_records` 同批行**一致**
- 监控页来源筛「开放平台」可查到该运行，详情时间线非空

**通过判据**：上述全部成立；且埋点前后 AaaS 接口返回体**无变化**（AC-F5.5）。

### T5 实测勘误（2026-10-13，两条原期望与实现不符，已按实测修订）

**(1) 对账必须用非 admin 用户，否则 `usage_records` 根本没有行。**
`src/open-platform/billing.ts:66` 对 admin 有豁免（`if (user?.role === 'admin') return; // admin 豁免：不计量、不扣费`）。
本用例最初拿 admin 名下的 Agent 跑，`usage_records WHERE source='open-platform'` 恒为 0 行 —— **不是埋点漏写，是计费策略**。
修订后的执行方式：admin 用 `POST /api/admin/users`（`role: member`）建一个真实 member 用户，用其名下 Agent 跑一次，再对账：

```bash
# member 名下 Agent 的真实调用（实测结果）
#   open_platform_runs: input=24267 output=87 cost=0.12351 turns=1 duration=4619ms status=completed
#   usage_records:      input=24267 output=87 cost=0.12351 turns=1 duration=2228ms
```

**(2) `duration_ms` 两个账本**不等**，且这是刻意的，不是缺陷。**
两者量的不是同一个东西：

| 账本 | 取值 | 含义 |
|---|---|---|
| `open_platform_runs.duration_ms` | `run-recorder.ts:200` 的 `Date.now() - startedMs` | 平台侧**墙钟**端到端耗时（含连接、重试、收尾） |
| `usage_records.duration_ms` | `agent-service.ts:235` 的 `event.duration_ms` | SDK 自报耗时 |

实测 4619ms vs 2228ms（同一次运行）。保留差异的理由：
① 墙钟与 `started_at`/`ended_at` 自洽（`ended_at - started_at = 4619ms` 精确相等），UI 的耗时列因此内部一致；
② 失败 / 超时路径根本收不到 SDK 的 `result` 事件，那时只有墙钟可用 —— 统一用墙钟才能让该列在成功与失败两种运行上语义一致；
③ `usage_records` 是计费账本，改它的口径会波及计费，超出本需求范围。
**代价**：监控页的耗时与计费明细的耗时对同一次运行会显示两个数。这是已知取舍，不是 bug。

**(3) 失败路径：原期望「新增行 `status='failed'`」写错了 —— 实际不建行。**
实测（`/tmp/rm-e2e/probe-t5.mts`）：

| 场景 | 返回 | `open_platform_runs` 行数 |
|---|---|---|
| 不存在的 `agentId` | 404 `Agent not found` | 3 → 3（**+0**） |
| 调用他人 Agent | 403 `You do not have access to this agent` | 3 → 3（**+0**） |

原因是刻意的设计：`agent-service.ts:256` 的注释写明「运行记录在 `resolveAgent` 通过之后才建：404 / 403 是无效请求，不该在监控里留痕」。
被拒的请求**没有运行过**，为它建行只会污染监控列表（真被拒的调用方自己会看到 404/403）。
**故修订后的失败路径期望**：`resolveAgent` 之前失败的请求 → **不新增行**；
`resolveAgent` 之后（SDK 抛错 / 超时 / 流提前关闭）失败的请求 → 新增行 `status='failed'` 且 `error` 非空（该分支由
`agent-service.ts` 两个 `catch` 与 `streamAgent` 的 `finally` 收口，已有单测 `@see tests/units/open-platform-run-recorder.test.ts` 覆盖）。

---

## T6 — 空来源降级（对 NFR-3）

**步骤**：来源筛选依次选 `Loop` / `监督者` / `定时任务` / `沙箱` / `Harness 评测`（live 均 0 行）

**期望**：全部返回空列表 + 空状态提示，HTTP 200，**不出现 5xx**。

```bash
for s in loop supervisor task sandbox harness-eval; do
  curl -s -o /dev/null -w "$s %{http_code}\n" -b /tmp/dtk-cookies.txt \
    "http://127.0.0.1:9998/api/runtime-monitor/runs?source=$s"
done
```

**通过判据**：5 个来源全部 200。

---

## T7 — 分页与筛选组合（对 AC-F3.3 / F3.4 / F3.5）

**步骤**
1. `limit=20&offset=0` 取第 1 页，`offset=20` 取第 2 页
2. 断言两页 `runId` 无交集
3. `status=failed` 筛选，计数与 SQL 一致
4. `q=swarm` 关键词搜索

**通过判据**：无重复、`total` 正确、`failed` 计数一致、关键词命中工作区或标题。

---

## T8 — 权限隔离（对 AC-F7.1 ~ F7.4）

**步骤**
1. 匿名请求 → 期望 401
2. 新建一个 member 账号（`/api/auth/register` 或管理员页），登录后请求 `/api/runtime-monitor/runs`
3. 用 admin 的 `runId`（他人运行）请求详情

**通过判据**
- 匿名 401
- member 结果集 ⊆ admin 结果集，且不含 `chat_jid='web:main'` / `feishu:oc_d002a8...` 的运行
- 越权详情请求 404/403

---

## T9 — 前端可访问性与导航（对 AC-F8.1 ~ F8.3）

**步骤**
1. 左侧导航出现「运行监控」
2. 点击 → URL 变 `/runtime-monitor`，页面渲染 KPI
3. 直接刷新 `http://127.0.0.1:9998/runtime-monitor` → 正常渲染（不 404）
4. 窄屏（375px）下布局不溢出

**通过判据**：全部成立，且每步留存截图。

---

## T10 — 实时刷新（对 AC-F6.1 ~ F6.3）

**步骤**：打开页面停留 15s，观察 Network 面板中 `/api/runtime-monitor/overview` 请求次数

**通过判据**：≥ 2 次；切到其他标签页后请求停止。

---

## T11 — 回归测试（对 NFR-5）

```bash
make typecheck
make test          # 全量 150 文件，基线全绿
make test-smoke    # CI 门禁
```

**通过判据**：全部通过；已知抖动 `tests/feishu-card.test.ts` 单独重跑通过即放过。

---

## 12. 一致性交叉验证（防止"看起来对"）

对每条计数类断言，**必须同时**用以下两条路径取数并比对，不允许只信页面：

1. 页面 UI 显示值（截图）
2. 直连 SQLite 的等值 SQL（终端输出）

二者不一致即为缺陷，按 Issue 修复流程处理。
