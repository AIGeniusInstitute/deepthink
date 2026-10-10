# 工具调用失败信号全链路无人识别，F3 三条归因分支在线上从未触发

- 日期：2026-10-10
- 模块：反馈与学习自进化（FLM）· F3 过程层 / F3.4 失败归因 / F1.2 系统来源派生
- 严重级别：**高**（功能不报错但结构性失效；过程层对"工具失败"永久失明）
- 发现方式：真实轨迹评价结果核查（6 个失败任务里 4 个 `attributionStage: null`）

---

## 1. 用户现象

控制台上一切正常，接口全 200。但对**真实**轨迹跑三层评价时：

- 失败任务大量归因不出来 —— 6 个真实失败任务里 4 个 `attributionStage` 为 `null`，证据只有 1 条；
- 「失败归因分布」里**永远只会出现「意图理解」和「总结」两类**，执行 / 参数生成 / 工具选择三类一次都没出现过；
- 「工具失败统计」（F6 看板）恒为空；
- 系统来源反馈里从来没有过 `system_error` 的**工具**维度 —— 只有节点维度。

一句话：**线上任何一次"工具调用失败"都不会被系统看见。**

## 2. 问题描述

FLM 判定工具调用是否失败，用的是 `FAIL_STATUS`：

```ts
const FAIL_STATUS = new Set(['failed', 'error', 'timeout', 'aborted']);
```

而上游写入方给 `trace_tool_calls.status` 写的终态只有两个：

```ts
// src/chat-trace-persist.ts:244
status: event.permissionDenied ? 'denied' : 'success',
```

**两边的取值集合交集为空**（`denied` 也没被收进来）。于是 `isFail()` 在真实数据上恒为 `false`。

实盘核对（`~/.deepthink-9999/db/messages.db`）：

```
trace_tool_calls.status  →  success 15259 | running 5832         （合计 21091，失败态 0 行）
chat_trace_nodes.status  →  done 9022 | running 370 | failed 16
```

注意两者的差别：**节点表确实有 `failed`（16 行），工具调用表一行都没有**。所以：

- 归因分支 3/4/5（执行环境 / 参数生成 / 工具选择）依赖 `failTools` —— 恒为空，**线上从未触发**；
- `judgeOutcome` 的 `failureRate === 1`（全链路失败）分支同样依赖它，从未触发；
- `deriveSystemDrafts` 的 `failedCall`（`system_error` 的工具维度）恒为 0。

真正能跑通的只有：`答非所问` 标签 → intent、首个 turn 节点失败 → intent、`stepCount > 40` → planning、全绿但结果未达成 → summary。**六条分支里只有四条活着，且都绕开了"工具真的失败了"这个最典型的原因。**

## 3. 根因

### 3.1 上游：tool-call 落库没有失败分支

`src/chat-trace-persist.ts` 里工具结果只在 `event.toolResult !== undefined` 时写一次终态，判断条件是 `event.permissionDenied`，否则一律 `success`。

这里的语义是「**工具函数返回了**」而不是「**工具成功了**」。MCP 工具返回错误载荷时并不抛异常，所以照样记 `success`：

```jsonc
// 实盘 success 行里的真实内容
{"status":"error","query":"逸文科技 ...","results":[],"error":"missing ZHIPU_API_KEY"}
{"result":"{\"status\": \"error\", \"total_results\": 0, ... \"error\": \"http_429: 余额不足...\"}"}
```

也就是说，**失败信息在 `output_json` 里是有的**（`loadEvalContext` 也已经把它读进了 `EvalToolCallInput.output`），但它不在 `status` 列上，而 FLM 的门槛看的正是 `status`。

### 3.2 下游："什么算失败"被盗版了三份，且互不一致

| 位置 | 判据 | 问题 |
|---|---|---|
| `flm-evaluate.ts:84` | `{failed,error,timeout,aborted}` | 漏 `denied`；与实盘零交集 |
| `flm-collect.ts:357`（改前） | `status === 'error' \|\| status === 'failed'` | 又少 `timeout`/`aborted`/`denied` |
| `flm-llm-judge.ts:32-33`（改前） | `status !== 'success'` | 把 `running` 也算成失败 |

同一个概念三份定义、三种口径，谁都不是按上游真实产物写的。

### 3.3 为什么单测全绿

`tests/units/flm-evaluate.test.ts` 的三条工具归因用例喂的是：

```ts
toolCalls: [tc({ status: 'error',   output: 'Request timeout after 30s' })]
toolCalls: [tc({ status: 'failed',  output: 'invalid argument: ...' })]
toolCalls: [tc({ status: 'failed',  output: 'unexpected result shape' })]
```

`status: 'error'` / `'failed'` **正是生产端从不产出的值**。测试喂什么就一直绿 —— 与「评价从不落库」是同一类盲区：测试替生产代码补上了它没做的那一环。

## 4. 复现路径

1. 挑一个**真实**失败任务（工具确实报错的那种），拿到 taskId。
2. `POST /api/flm/admin/evaluate` 评价它。
3. 看返回的 `attributionStage`：不是 `null`，就是 `summary` / `intent` —— 永远不会是 `execution` / `param_gen` / `tool_selection`。
4. 对全库跑一遍，统计 `attribution_stage` 的取值分布，只会看到 `intent` 和 `summary`。

> 判据不是"页面报错"，而是**归因取值的分布**。接口一直返回 200。

## 5. 诊断方法

```bash
DB=~/.deepthink-9999/db/messages.db

# 1. 上游到底会写哪些终态 —— 这一步就能定案
sqlite3 "$DB" "SELECT status, count(*) FROM trace_tool_calls GROUP BY status ORDER BY 2 DESC;"
# → success 15259 | running 5832        （失败态 0 行）

sqlite3 "$DB" "SELECT status, count(*) FROM chat_trace_nodes GROUP BY status ORDER BY 2 DESC;"
# → done 9022 | running 370 | failed 16 （节点有 failed，工具调用没有）

# 2. 上游写入代码里有没有失败分支
grep -n "permissionDenied\|status: 'success'\|status: 'running'" ~/deepthink/src/chat-trace-persist.ts
# → 244:status: event.permissionDenied ? 'denied' : 'success',   ← 没有 failed/error 分支

# 3. 失败信息实际藏在哪（在 output_json 里，不在 status 上）
sqlite3 "$DB" "SELECT substr(output_json,1,160) FROM trace_tool_calls
               WHERE status='success' AND output_json LIKE '%\"error\"%' LIMIT 5;"

# 4. FLM 归因取值分布 —— 只会有 intent / summary
sqlite3 "$DB" "SELECT COALESCE(attribution_stage,'(null)'), count(*)
               FROM flm_evaluations GROUP BY 1 ORDER BY 2 DESC;"

# 5. "什么算失败"有几份定义
grep -rn "FAIL_STATUS\|status === 'failed'\|status !== 'success'" ~/deepthink/src/flm/
```

## 6. 修复方案

**本次修复（FLM 侧，可确证的部分）：把判据收敛成一份，并收进上游真的会写的 `denied`。**

```diff
 // src/flm/flm-evaluate.ts
-/** 失败状态。 */
-const FAIL_STATUS = new Set(['failed', 'error', 'timeout', 'aborted']);
+/** 失败状态。必须覆盖上游写入方真正会写的值。 */
+const FAIL_STATUS = new Set(['failed', 'error', 'timeout', 'aborted', 'denied']);
 
-function isOk(status) { ... }
-function isFail(status) { ... }
+export function isOk(status) { ... }   // 导出给 flm-collect 复用
+export function isFail(status) { ... } // "什么算失败"只允许有一处定义
```

```diff
 // src/flm/flm-collect.ts
-  const okNode = nodes.filter((n) => n.status === 'done').length;
-  const failedNode = nodes.filter((n) => n.status === 'failed').length;
-  const okCall = calls.filter((c) => c.status === 'success').length;
-  const failedCall = calls.filter((c) => c.status === 'error' || c.status === 'failed').length;
+  const okNode = nodes.filter((n) => isOk(n.status)).length;
+  const failedNode = nodes.filter((n) => isFail(n.status)).length;
+  const okCall = calls.filter((c) => isOk(c.status)).length;
+  const failedCall = calls.filter((c) => isFail(c.status)).length;
```

```diff
 // src/flm/flm-llm-judge.ts
-  const failedNodes = ctx.nodes.filter((n) => n.status === 'failed');
-  const failedCalls = ctx.toolCalls.filter((c) => c.status !== 'success');
+  const failedNodes = ctx.nodes.filter((n) => isFail(n.status));
+  const failedCalls = ctx.toolCalls.filter((c) => isFail(c.status));
```

**选型理由：**

- **`denied` 是必须补的**：它是上游**唯一**会写出来的非成功终态（权限被拒 = 一次没拿到结果的行为）。漏掉它，等于上游写出来的失败态没有任何一个能被识别。这一条是纯粹的契约不一致，不是猜测。
- **不做 `output_json` 文本嗅探**：虽然错误载荷在 `output_json` 里（如 `{"status":"error"}`），但为它写启发式等于把"工具特定"的解析塞进评价器，误报面大（任何正常输出里含 "error" 字样都会中招）。`attribute()` 里已有的输出正则是在**已确认失败**之后做细分，性质不同 —— 那是分类，不是判定。
- **三份定义合并成一份**：`flm-collect` 只从 `flm-evaluate` 做了 `import type`，改成值导入不会产生运行时循环（`flm-evaluate` 只依赖 `flm-types`）。

**回归测试（判别力已实测）：**

- `tests/units/flm-evaluate.test.ts` → 新增 `FLM F3 · 上游状态契约`：`denied` 必须驱动归因、`denied`+超时线索细分到 execution、`running` 不算失败。撤掉修复 → 前两条转红。
- `tests/units/flm-collect.test.ts` → 新增用例：**节点全绿** + 工具调用 `denied` 仍须派生出 `system_error`（逼失败事件只能由工具调用驱动）。撤掉修复 → 转红。

### 仍无法修复的部分（需人工介入 / 平台侧决策）

**工具调用的失败信号在整条管线里根本没有结构化表达。** `event.toolResult` 是字符串（`src/stream-event.types.ts:116`），`permissionDenied` 是唯一的结构化异常位，工具返回错误载荷时没有任何 `is_error` 位可用。因此：

- **本次修复的实际线上收益是 0 行** —— 实盘 `denied` 也是 0 行。修复消除的是契约不一致，**没有解除结构性失明**；
- 要真正解除，需要平台侧决策其一：
  1. **上游补结构位**（推荐）：在 `stream-event.types.ts` 给 tool_result 事件加 `isError?: boolean`（由 SDK 的 `tool_result.is_error` 透传），`chat-trace-persist.ts:244` 改写为 `permissionDenied ? 'denied' : isError ? 'error' : 'success'`。受益方不止 FLM —— `autonomy-learning.ts:107`、`agent-groups.ts:556`（轨迹查看器）读的是同一张表；
  2. 在评价器里对 `output_json` 做文本嗅探（不推荐，理由见上）。
- **无回填**：历史 21091 行无法追溯当时的成败，只能对修复后新产生的轨迹生效。
- **附带发现（同样需决策）**：`running` 且有 5832 行未结束。对**已结束**的任务范围来说，"启动了但从未结束"本身就是异常（执行被中断），这是当前最大的一块未被利用的失败信号。但评价窗口可能与仍在执行的任务重叠，直接判失败会误报，需要区分"窗口已闭合"再定论。

## 7. 处理卡住的状态（如适用）

不适用 —— 该缺陷不产生卡住的运行态，也不影响已落库数据。历史评价的 `attribution_stage` 保持原值即可（它们是当时数据的真实结论）。

## 8. 经验沉淀 / 预防

- **判据必须按上游**真实产物**写，而不是按我们期望它写的值写。** 本次 `OK_STATUS` 的注释里明明白白写着"取值来自实盘数据（nodes 用 done，tool_calls 用 success）"—— 说明作者查过成功态，却没查失败态，于是失败态整组落空。**成功态和失败态要一起对着生产库核对。**
- **同一个概念只允许一份定义。** 三份盗版判据里有两份连彼此都不一致，任何一份错了另外两份都不会报错。合并成本很低（一次值导入），收益是口径不可能再漂移。
- **巡检建议（可直接放进日常巡检）**：对"生产者取值集合"与"消费者取值集合"做交集检查，交集为空即告警。
  ```bash
  # 通用形态：上游出现过的 status 值 vs 代码里认的 status 值
  sqlite3 "$DB" "SELECT DISTINCT status FROM trace_tool_calls;"
  grep -rn "FAIL_STATUS\s*=\s*new Set" ~/deepthink/src/flm/
  ```
- **测试用例里的"魔法状态值"要标注来源。** 凡是 `status: 'xxx'` 这类字面量，都应能回答"上游哪个代码写的它"。答不上来的，用例就是在替生产代码补接线 —— 本次与「评价从不落库」两起缺陷都栽在这里。
- **"接口 200 + 页面正常"不等于功能生效。** 本缺陷和上一起一样，全程零报错。唯一可靠的判据是**结果分布**：归因取值只有两类、工具失败统计恒空 —— 这种"分布上的畸形"比任何异常日志都更早暴露问题。

相关：[[2026-10-10-flm-evaluations-never-persisted]]、[[2026-10-10-flm-feedback-dedup-collapses-distinct-messages]]
