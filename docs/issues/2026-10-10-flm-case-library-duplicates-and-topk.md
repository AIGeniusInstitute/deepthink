# 案例库随每次「沉淀」无限膨胀，Top-K 检索被同一目标的拷贝占满

- 日期：2026-10-10
- 模块：反馈与学习自进化（FLM）· F4.3 经验记忆 / F4.4 案例检索 / F6.3 案例库
- 严重级别：**高**（AC-F4.4「Top5 命中率 ≥ 80%」不可度量；案例库单调膨胀且无上限）
- 发现方式：验收脚本 TC-17 修复「相似度 NaN%」后，暴露出 5 条命中相似度完全相同

---

## 1. 用户现象

「学习沉淀」页签里做案例检索，返回的 **Top-5 是 5 条一模一样的案例** —— 同样的目标、同样的摘要、同样的相似度（实测 `62.4% × 5`）：

```
检索命中 5 条，相似度 62.4/62.4/62.4/62.4/62.4%
  sim=0.4684 cos=0.5522 lex=0.2727  把使用手册，提交push
  sim=0.4684 cos=0.5522 lex=0.2727  把使用手册，提交push
  sim=0.4684 cos=0.5522 lex=0.2727  把使用手册，提交push
  sim=0.4684 cos=0.5522 lex=0.2727  把使用手册，提交push
  sim=0.4684 cos=0.5522 lex=0.2727  把使用手册，提交push
```

对一个用来「复用经验」的检索功能来说，5 个结果位全被同一条占满 = **等于只返回了 1 条**。运营看不到其它候选，也就无法比较、无法选择。

同时案例库在无提示地持续变大：

```
flm_cases: 137 条 → 只对应 12 个不同目标、12 个不同任务
```

## 2. 问题描述

两层重复叠加：

| 层 | 实盘数据 | 成因 |
|---|---|---|
| 评价层 | `flm_evaluations` **70 行**，只有 **12 个不同 task_id**（9 个任务有多行） | 对同一任务重复评价 → 每次生成新 `eval_id` → 新行 |
| 案例层 | `flm_cases` **137 行**，只有 **70 个不同 eval_id**（单条评价最多 4 条案例） | 每次「从评价中沉淀」→ 对**全部**评价重新建案例 |

两层相乘，于是一条真实案例在库里最多有 4 份拷贝，而检索把它们全部当作独立候选返回。

**检索本身是好的** —— 用不同查询验证过，分值和排序都正确：

```
query="使用手册"            → sim=0.4684（命中正确目标）
query="部署 生产环境"        → sim=0.1413（命中正确目标，降序）
query="zzz完全不相关的词"    → sim=0.0687（噪声，正确压低）
```

坏的只是**返回集合的构成**：没有去重。

## 3. 根因

### 3.1 案例沉淀没有幂等性

`src/flm/flm-learn.ts` 的 `learnFromEvaluations()` 对**传入的每一条评价**无条件建案例：

```ts
for (const e of evaluations) {
  const g = goalByTask.get(e.task_id);
  if (!g) continue;
  cases.push(buildCaseFromEvaluation(e, { goal: g.goal, summary: g.summary }));  // ← 无存在性检查
}
persistCases(cases);
```

而 `buildCaseFromEvaluation()` 每次都发一个新主键：

```ts
case_id: `case_${randomUUID()}`,
```

**案例是评价的纯派生物** —— 同一条评价沉淀两次，两行内容逐字段相同。于是重复沉淀不带来任何新信息，只带来行数。

### 3.2 检索没有去重

`searchCases()` 把全表打分后直接排序切片：

```ts
hits.sort((a, b) => b.similarity - a.similarity);
return { indexMode, hits: hits.slice(0, topK) };
```

`topK` 被理解成"前 K **行**"，而不是前 K **个候选**。库里有多少份拷贝，返回里就有多少份。

### 3.3 为什么这违反 PRD 而不是"历史记录"

- **AC-F4.4**：「案例检索 Top5 命中率 ≥ 80%（用标注命中集合实测，记入报告）」—— 命中率的分母是"标注应命中的案例"，5 个槽位被同一条占满时，这个指标**在语义上就无法成立**。
- **TC-FLM-17**：「返回 Top-K **相似案例**」——复数是"案例"，不是"行"。
- **AC-F1.1.5 / AC-F2.5** 已把幂等定为模块级原则：「重复评价为**更新**而非新增」「一次行为不重复计分」。案例沉淀属于同一族操作，理应同口径。

## 4. 复现路径

1. 登录控制台 → 反馈与学习 → 学习沉淀。
2. 点「从评价中沉淀」**两次**（中间无需任何其它操作）。
3. 在案例检索框里输入一个案例的目标文本，检索。
4. 观察 Top-5：**出现重复目标的拷贝**。

命令行复现同一现象：

```bash
# 对同一批评价连续跑两次 learn，案例数会翻倍
for i in 1 2; do curl -s -b "$COOKIE" -X POST .../api/flm/admin/learn -d '{"limit":200}'; done
sqlite3 "$DB" "SELECT count(*) FROM flm_cases;"   # 第二次后接近翻倍
```

## 5. 诊断方法

```bash
DB=~/.deepthink-9999/db/messages.db

# 1. 案例数与"不同目标数"的落差 —— 一眼看出重复
sqlite3 "$DB" "SELECT count(*) total, count(DISTINCT goal) goals, count(DISTINCT task_id) tasks FROM flm_cases;"
# → 137|12|12        ← 137 条案例只有 12 个目标

# 2. 单条评价被沉淀了几次
sqlite3 "$DB" "SELECT count(*) c, substr(eval_id,1,28) FROM flm_cases GROUP BY eval_id ORDER BY c DESC LIMIT 5;"
# → 4|eval_d2fc1a14-...   （一条评价 4 份拷贝）

# 3. 上游评价本身是否也重复
sqlite3 "$DB" "SELECT count(*) total, count(DISTINCT task_id) tasks FROM flm_evaluations;"
# → 70|12                 （70 条评价只有 12 个任务）

# 4. 检索是否真的在返回拷贝（打接口，不要只看页面）
curl -s -b "$COOKIE" --get --data-urlencode 'q=使用手册' --data-urlencode 'topK=5' \
  .../api/flm/admin/cases/search | python3 -c 'import json,sys
for h in json.load(sys.stdin)["hits"]: print(h["similarity"], h["goal"][:30])'
# → 五行完全相同的 similarity 与 goal
```

## 6. 修复方案

**修复一：案例沉淀改为按评价幂等（`flm-learn.ts` + `flm-db.ts`）。**

```diff
 // src/flm/flm-db.ts
+/** 已经沉淀过案例的评价 ID 集合 —— 供 learnFromEvaluations 做幂等去重。 */
+export function caseEvalIds(): Set<string> {
+  const rows = getDb()
+    .prepare('SELECT DISTINCT eval_id FROM flm_cases WHERE eval_id IS NOT NULL')
+    .all() as Array<{ eval_id: string }>;
+  return new Set(rows.map((r) => r.eval_id));
+}
```

```diff
 // src/flm/flm-learn.ts
+  const already = caseEvalIds();
   const cases: FlmCaseRow[] = [];
   for (const e of evaluations) {
     const g = goalByTask.get(e.task_id);
     if (!g) continue;
+    if (already.has(e.eval_id)) continue; // 幂等：一次评价只沉淀一次
     cases.push(buildCaseFromEvaluation(e, { goal: g.goal, summary: g.summary }));
   }
```

**修复二：Top-K 去重（`flm-learn.ts`）。**

```diff
   hits.sort((a, b) => b.similarity - a.similarity);
-  return { indexMode: hasEmbedding ? 'embedding' : 'keyword', hits: hits.slice(0, topK) };
+  // 同目标只保留相似度最高的那条（已降序，首次出现即最优）
+  const seenGoals = new Set<string>();
+  const distinct: CaseHit[] = [];
+  for (const h of hits) {
+    const key = h.goal.toLowerCase().replace(/\s+/g, ' ').trim();
+    if (seenGoals.has(key)) continue;
+    seenGoals.add(key);
+    distinct.push(h);
+    if (distinct.length >= topK) break;
+  }
+  return { indexMode: hasEmbedding ? 'embedding' : 'keyword', hits: distinct };
```

**选型理由：**

- **幂等用"跳过已沉淀的 eval_id"，不用"按 case_id 覆盖"**：案例上挂着运营的人工修正（`attribution_stage`，AC-F6.3）、`verified`、`reuse_count`。整行 `INSERT OR REPLACE` 会把这些运营成果抹掉 —— 那是比重复更严重的损失。跳过则只增不改。
- **去重放在检索层，不只靠修复一**：修复一只能阻止**将来**的新增，无回填 —— 库里已有的 137 行不会自动收敛。检索层去重是唯一能立刻让 Top-K 恢复可用的位置，且对存量数据同样生效。
- **去重键用规范化后的 goal 文本**：判据是"运营看到的是否是同一条候选"。同一目标的两条拷贝在卡片上无法区分（显示 goal + summary），所以按 goal 归并。保留最优而非任意丢弃 —— 去重不能降低检索质量。
- **不做存量数据清理**：删除已有行是不可逆操作，且可能连带删掉运营改过归因的案例。留作平台侧的运维决策（见下）。

**回归测试（判别力已实测）：**

- `tests/units/flm-learn.test.ts` → 新增 2 条：
  - 「Top-K 不返回同一目标的拷贝」：同一目标沉淀 5 条 → 检索只返回 1 条，且仍是 Top-1（验证"去重保优"）。
  - 「同一评价重复沉淀不产生重复案例」：同批评价跑两次 → 第二次 `cases === 0`，库里恰好 2 条（2 条评价），而不是 4 条。
- **同时撤掉两处修复 → 2 条全红；恢复 → 48 条全绿。**

**顺带补齐（TC-FLM-17）**：命中卡片此前只显示目标与相似度，**没有样本类型**。TC-FLM-17 明确要求「含正负样本类型与相似度」，已补 `positive` / `negative` 徽标。

### 仍无法修复的部分（需人工介入 / 产品决策）

**上游的"评价是否应该按任务幂等"是一个产品决策，不是缺陷判定。**

`flm_evaluations` 用 `INSERT OR REPLACE` 但主键是调用方新生成的 `eval_id`，所以重复评价 = 新行。实盘 70 行 / 12 个任务。两种读法都说得通：

1. **评价是历史记录**（倾向保留）：`eval_time` 与索引 `idx_flm_eval_outcome(outcome, eval_time DESC)` 暗示要按时间看质量趋势。此时重复评价是**正确行为**，问题只在案例侧 —— 已由修复一/二解决。
2. **评价是任务当前状态**（倾向幂等）：那么应改用稳定的主键（如 `task_id`），让重复评价更新而非新增。

**支持读法 2 的一条具体证据**：`flm_evaluations` 上挂着运营工作流状态 `needs_review` / `review_status` / `review_note`。重复评价会生成一条 `review_status='none'` 的新行，**同一个任务于是重新出现在复核队列里，运营此前签过的结论在列表上看起来"没了"**。这个副作用与 AC-F1.1.5 的幂等精神相冲突。

**因此本条不擅自修改** —— 改主键会改变评价的生命周期语义，属于平台侧决策。建议由产品/架构确认走读法 1 还是读法 2；若选 2，改动点在 `insertEvaluation` 的调用方（用 `task_id` 派生稳定 `eval_id`）。

**存量数据（137 条案例）无自动回填**。检索层去重已使 Top-K 立刻恢复可用，但库内冗余行仍在。

## 7. 处理卡住的状态（如适用）

不适用 —— 该缺陷不产生卡住的运行态，不影响已落库的评价与反馈。

## 8. 经验沉淀 / 预防

- **"派生物"必须有幂等键。** 案例是评价的派生物、偏好对是评价的派生物 —— 凡是"由 X 计算出来的东西"，都要能回答：同一个 X 算两次会怎样？本次答案是"多一行"，而正确答案是"什么都不发生"。**给派生表一个来自源实体的确定性唯一键（这里是 `eval_id`），是成本最低的防线。**
- **`slice(0, topK)` 是"前 K 行"，不是"前 K 个候选"。** 任何 Top-K 检索在切片之前都应问一句：这些行彼此**互不相同**吗？一个只做排序不做去重的检索，在有重复数据的库上会静默退化成"前 1 个候选"。
- **验收判据要能区分"5 条候选"与"1 条候选的 5 份拷贝"。** TC-17 原来只断言"有命中、有相似度字样"，两种情况下都通过。**渲染列表的用例，判据里要含"互异性"检查**（本次已改为读取每条命中的目标文本、比较去重后数量）。
- **修完一个缺陷后，立刻在同一屏找它的同类。** 本起与「相似度 NaN%」是同一个 TC-17 里前后脚暴露的：先把 NaN 修好，重复候选才显形。**前一个缺陷常常是后一个缺陷的遮挡物。**
- **区分"缺陷"与"产品决策"是必要的自律。** 案例重复有唯一正确解（派生数据不该重复）→ 直接修；评价重复有两种合理语义 → 记录证据、给出建议、**不擅自改**。把后者当缺陷硬改，是在用代码替产品做决定。
- **巡检建议**：把"派生表的行数 / 源实体的不同值数"做成比值告警，显著大于 1 即说明幂等键缺失。
  ```bash
  sqlite3 "$DB" "SELECT 'cases/evals', (SELECT count(*) FROM flm_cases)*1.0 /
                        (SELECT count(DISTINCT eval_id) FROM flm_cases);"
  # → 1.96   （>1.5 就该查）
  ```

相关：[[2026-10-10-flm-learning-tab-crash-blanks-console]]、[[2026-10-10-flm-evaluations-never-persisted]]、[[2026-10-10-flm-toolcall-failure-signal-never-detected]]
