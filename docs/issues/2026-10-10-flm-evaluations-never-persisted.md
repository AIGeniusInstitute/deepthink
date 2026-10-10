# FLM 三层评价算完即丢，F3→F6 整条链在运行实例上空转

- 日期：2026-10-10
- 模块：反馈与学习自进化（FLM）· F3 三层评价
- 严重级别：**致命**（功能整体不可用，且所有接口都返回 200）
- 发现方式：FLM UI 验收脚本数据准备阶段（`scripts/e2e/flm-acceptance.cjs`）

---

## 1. 用户现象

控制台上每一处都「正常」——接口全 200、页面全渲染、无任何错误提示。但：

- 「评价工作台」点「执行三层评价」→ 弹「已评价 4 个任务」→ **评价记录表依旧是空的**；
- 「学习沉淀」点「从评价中沉淀案例与策略」→ **案例库 0 条、策略版本 0 个**；
- 「数据回流」永远显示「暂无可回流样本」；
- 总览的**任务成功率恒为 0.0%**、失败归因分布恒为「暂无未达成样本」；
- 灰度劣化自动回滚**永远不会触发**。

一句话：**F3 评价 → F4 学习 → F5 闭环 → F6 看板，整条链在运行实例上是死的，但界面不报任何错。**

## 2. 问题描述

`POST /api/flm/admin/evaluate` 返回：

```json
{"ok":true,"evaluated":4,"results":[{"evalId":"eval_f7f1f9b0-...","outcome":"achieved",...}, ...]}
```

看着完全成功。但同一时刻库里：

```sql
SELECT count(*) FROM flm_evaluations;  -- 0
```

评价被算出来、写进了 HTTP 响应、然后**被丢弃**。响应里那个 `evalId` 是一个从未在任何表里存在过的 UUID。

## 3. 根因

`src/routes/flm.ts` 的 `/admin/evaluate` 路由只做了三步：`evaluateTask()` → `results.push()` → `c.json()`。

**从未调用 `insertEvaluation()`。**

核对全仓调用点：

```bash
grep -rn "insertEvaluation" src/
# src/flm/flm-db.ts:377:export function insertEvaluation(...)  ← 只有定义，零调用
```

`insertEvaluation` 在整个 `src/` 目录下**没有任何调用点**，只出现在测试文件里。

### 为什么单测全绿也没发现

`tests/units/flm-collect.test.ts` 与 `tests/units/flm-console-routes.test.ts` 都是自己调用 `insertEvaluation(...)` 来造种子数据的：

```ts
// 测试文件里
const mkEval = (evalId, taskId, outcome, stage) => insertEvaluation({ ... });
mkEval('eval-console-ok', TASK_OK, 'achieved', null);
```

也就是说，**测试把生产代码漏掉的那根线在测试里补上了**，然后断言后续逻辑工作正常。种子是测试自己塞的，所以永远测不到"生产路径到底写不写库"。

这是典型的「测试覆盖了函数，没覆盖接线」—— 单元测试证明 `insertEvaluation` 能用，但没有任何一条用例证明**调用方真的调了它**。

## 4. 复现路径

1. 登录 `http://127.0.0.1:9999`（admin / 88888888）。
2. 打开「反馈与学习」→「反馈流」，提交任意一条反馈，确认事件出现、拿到 taskId。
3. 切到「评价工作台」，填入该 taskId，点「执行三层评价」→ 提示「已评价 1 个任务」。
4. 观察下方「评价记录」表：**仍然显示「暂无评价记录」**。
5. 切到「学习沉淀」点「从评价中沉淀」→ 案例库仍为「暂无案例」。

## 5. 诊断方法

```bash
C=$(curl -s -i -X POST http://127.0.0.1:9999/api/auth/login \
      -H 'Content-Type: application/json' \
      -d '{"username":"admin","password":"88888888"}' \
    | grep -i '^set-cookie' | sed 's/^[Ss]et-[Cc]ookie: //' | cut -d';' -f1 | tr -d '\r')

TASK=$(sqlite3 ~/.deepthink-9999/db/messages.db \
  "SELECT task_id FROM flm_events WHERE task_id IS NOT NULL LIMIT 1;")

# 接口说 evaluated=1
curl -s -X POST http://127.0.0.1:9999/api/flm/admin/evaluate -H "Cookie: $C" \
  -H 'Content-Type: application/json' -d "{\"taskIds\":[\"$TASK\"],\"useLlm\":false}"

# 库里还是 0 —— 这就是判据
sqlite3 ~/.deepthink-9999/db/messages.db "SELECT count(*) FROM flm_evaluations;"

# 旁证：定义存在但零调用
grep -rn "insertEvaluation" ~/deepthink/src/
```

## 6. 修复方案

在路由的 `evaluateTask()` 之后补上落库，把 `EvaluationOutput`（camelCase）映射为 `FlmEvaluationRow`（snake_case）：

```diff
 import {
   getStrategy,
+  insertEvaluation,
   insertObservation,
   ...
 } from '../flm/flm-db.js';

     const out = evaluateTask(ctx, { useLlm: body.useLlm === true, llmVerdict });
+    // 评价必须落库。此前这里只把结果塞进响应就返回 —— 控制台「评价记录」永远为空、
+    // 复核队列永远为空、learn 读不到评价所以案例/策略永远为 0、看板成功率恒为 0。
+    insertEvaluation({
+      eval_id: out.evalId,
+      task_id: out.taskId,
+      trace_id: out.traceId,
+      session_id: out.sessionId,
+      chat_jid: out.chatJid,
+      outcome: out.outcome,
+      outcome_reason: out.outcomeReason,
+      process_score: out.processScore,
+      path_conformity: out.pathConformity,
+      step_count: out.stepCount,
+      retry_count: out.retryCount,
+      first_anomaly_step: out.firstAnomalyStep,
+      duration_ms: out.durationMs,
+      quality_scores: JSON.stringify(out.qualityScores),
+      attribution_stage: out.attributionStage,
+      evidence_json: JSON.stringify(out.evidence),
+      evaluator: out.evaluator,
+      needs_review: out.needsReview ? 1 : 0,
+      review_status: 'pending',
+      review_note: null,
+      eval_time: out.evalTime,
+    });
     evaluations.push(out);
```

**选型理由：**

- **不动 `evaluateTask`**：它是刻意的纯函数（文件头注释写明「本函数只负责比对与标记，把调用模型留在外面，是为了让这个文件保持纯函数、可单测」）。把副作用塞进去会破坏这个设计，并影响 20+ 条纯函数单测。
- **落库放在路由层**：与 `POST /feedback` 的现有风格一致（路由负责编排：算 → 存 → 回响应）。
- `quality_scores` / `evidence_json` 一并序列化落库 —— 只落结果不落证据，会让「评价可解释」只在响应里成立，控制台的「取证」面板仍然拿不到东西。

**回归测试（`tests/units/flm-console-routes.test.ts`）：**

关键点是**只打 HTTP 接口、再去库里核对**，绝不在测试里自己调用 `insertEvaluation`：

```ts
test('POST /admin/evaluate 的评价真的写进 flm_evaluations 并能被列表接口读到', async () => {
  const res = await post('/api/flm/admin/evaluate', { taskIds: [TASK_OK], useLlm: false });
  const persisted = getDb().prepare('SELECT * FROM flm_evaluations WHERE task_id = ?').get(TASK_OK);
  expect(persisted).toBeTruthy();
  expect(persisted!.eval_id).toBe(body.results[0].evalId);
  ...
});

test('评价落库后 learn 才有输入：案例数 > 0', async () => { ... });
```

已实测判别力：撤掉修复后这两条用例转红，恢复后转绿。

## 7. 处理卡住的状态（如适用）

不适用 —— 缺陷不产生 stuck 运行态。修复前算出的评价无法追回（没有任何持久化痕迹，连 `evalId` 都只存在于已丢失的响应体里），**不能回填**；修复后重新触发评价即可。

## 8. 经验沉淀 / 预防

- **单测自己造种子 = 测不到生产接线。** 凡是"函数能被调用"的断言，都不能推出"生产代码真的调用了它"。这类缺陷只有在**从 HTTP/UI 入口打进去**的测试里才会暴露。这也是本次把 `flm-console-routes` 这一层补起来的原因。
- **接口返回 200 不等于功能生效。** 本缺陷全程零报错、零异常日志，唯一的判据是「响应说的」与「库里有的」是否一致。巡检应常规化这类对照：
  ```bash
  # 接口说评价数 vs 库里评价行数，长期背离即告警
  curl -s -H "Cookie: $C" 'http://127.0.0.1:9999/api/flm/admin/evaluations?limit=1'
  sqlite3 ~/.deepthink-9999/db/messages.db "SELECT count(*) FROM flm_evaluations;"
  ```
- **静态检查建议**：对 `insert*` / `persist*` / `save*` 这类写库函数，可用一条 lint 规则或 CI 脚本检查「导出但零调用」。本例中 `grep -rn "insertEvaluation" src/` 一条命令就能发现，成本极低。
- **UI 验收脚本必须断言"数据回来了"**，而不是"按钮点了、toast 弹了"。toast 是前端自己写的文案，与后端是否落库无关。
