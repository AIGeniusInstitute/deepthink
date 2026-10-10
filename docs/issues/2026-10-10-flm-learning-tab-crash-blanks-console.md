# 「学习沉淀」页签一行 `undefined.toFixed()` 打白整个反馈与学习控制台

- 日期：2026-10-10
- 模块：反馈与学习自进化（FLM）· F4 学习沉淀（AC-F4.6 数据回流）
- 严重级别：**高**（单格数据缺失 → 7 个页签全部不可用，整个 FLM 控制台无法操作）
- 发现方式：Playwright 验收脚本 ui_test 阶段，TC-18 截图整页空白

---

## 1. 用户现象

在控制台里点开「学习沉淀」页签，**整个页面变成一片空白**。不是这一页空白 —— 是连同上面那排页签一起消失，返回/刷新后重进还是白屏，只有硬刷新并切回别的页签才能恢复。

也就是说：**只要用户点过一次「学习沉淀」，他就再也用不了这个控制台了**，包括反馈、评价、策略、看板等全部 6 个本来正常的页签。

自动化验收脚本里表现为一串与之无关的连锁超时：

```
TC-18 从归因结论生成策略版本草稿   → 超时（截图 output/flm-acceptance/16-TC-18-...-FAILED.png 为纯白）
TC-17 / TC-20 / TC-19             → 同样超时
TC-28 案例库                       → 报「案例库为空」（库里其实有 14 条）
```

## 2. 问题描述

`web/src/pages/FeedbackLearningPage.tsx` 渲染偏好对表格时，对 `similarity` 字段无条件调 `.toFixed()`：

```tsx
<td ...>{p.similarity.toFixed(2)}</td>
```

而 `/api/flm/admin/data-feedback` 返回的 pair 对象**没有 `similarity` 这个键**：

```
pair keys = ["pairId", "goal", "chosen", "rejected", "generatedAt"]
```

于是 `undefined.toFixed(2)` 抛 `TypeError`。React 渲染期抛出的异常没有错误边界接住，**整棵组件树被卸载**，所以死的不只是这一格、这一个页签，而是整个 `FeedbackLearningPage`（它内部用一套 state 承载全部 7 个页签）。

浏览器控制台实录：

```
tab=feedback     body=  4498 flm-page=1
tab=evaluations  body=  5152 flm-page=1
PAGE ERROR: TypeError: Cannot read properties of undefined (reading 'toFixed')
tab=learning     body=     0 flm-page=0     ← body 被清空，flm-page 根节点消失
```

### 2.1 同一页签上的第二处同类缺陷：案例检索「相似度 NaN%」

同一个「学习沉淀」页签里，案例检索的命中卡片渲染的是**三个同样不存在的字段**：

```tsx
{hits.map((h) => (
  <div key={h.case_id}>                                    {/* 接口给的是 caseId */}
    <span>{h.title}</span>                                 {/* 接口没有 title */}
    <span>相似度 {(h.score * 100).toFixed(1)}%</span>       {/* 接口给的是 similarity */}
    <div>{h.goal}</div>                                    {/* ← 只有这个是对的 */}
  </div>
))}
```

`hits` 的类型被写成 `Array<FlmCase & { score: number }>` —— 这是**列表接口**的形状（snake_case、有 `title`/`score`），而**检索接口**返回的是 `searchCases()` 算出来的 `CaseHit`（camelCase、有 `similarity`，**没有 `title`**）。实盘核对：

```
hit keys = ['caseId','taskId','sampleType','goal','summary','attributionStage',
            'similarity','cosineScore','lexicalScore','reuseCount']
  case_id    -> None      ← React key 也是 undefined
  title      -> None      ← 标题渲染空白
  score      -> None
  goal       -> '把使用手册，提交push'
  similarity -> 0.4684    ← 真实值一直都在，只是取错了名字
```

所以这一块 UI 三个字段里两个是坏的：**标题空白 + 「相似度 NaN%」**。

它和 §2 的崩溃是**同一个根因、两种症状**：`undefined * 100` → `NaN`，而 `NaN.toFixed(1)` 返回字符串 `"NaN"` 而非抛异常 —— 于是这次没有崩，只是安静地显示了一个假数值。**崩溃反而更容易被发现。**

更要紧的是**验收脚本自己放行了它一整轮**：TC-17 的旧判据是

```js
passed: hits > 0 && /相似度/.test(text)      // 只要求页面上出现「相似度」三个字
```

页面写着「相似度 NaN%」时这条断言**照样通过**。判据没咬住数值，等于没验。

## 3. 根因

### 3.1 直接原因：契约字段在生产端被算出来又丢掉

`src/flm/flm-learn.ts` 的 `buildDataFeedback()` 里，相似度**确实算了**，而且它就是配对判据本身：

```ts
const sim = 0.7 * cosine(embed(pg), embed(ng)) + 0.3 * lexicalOverlap(pg, ng);
if (sim >= minSimilarity && (best == null || sim > best.sim)) best = { neg: n, sim };
...
preferencePairs.push({
  pairId: `pair_${randomUUID()}`,
  goal: pg,
  chosen:   { ... },
  rejected: { ... },
  generatedAt: Date.now(),
});          // ← sim 在这里被丢掉了，没进对象
```

`best.sim` 一直活在作用域里，只是拼返回对象时漏了。**不是缺数据，是漏搬了一次。**

### 3.2 为什么类型系统没拦住：`apiFetch<T>` 是无校验断言

`web/src/api/flm.ts` 里前端 `PreferencePair` **凭空声明了** `similarity: number`：

```ts
export interface PreferencePair {
  pairId: string; goal: string;
  chosen: {...}; rejected: {...};
  similarity: number;      // ← 后端从来没有这个字段
  generatedAt: number;
}
```

这行声明让它通过了编译，而 `apiFetch<T>` 是 `JSON.parse(...) as T` 这类无校验断言 —— **TS 类型在此处不产生任何运行时检查**，它只是把谎话写进了类型里，顺手让编译器闭嘴。

同一文件里的 `SftSample` 也是同类谎话：

| 字段 | 前端声明 | 后端实际（`flm-learn.ts`） |
|---|---|---|
| 标识 | `taskId: string \| null` | `sampleId: string` |
| 正文 | `completion: string` | `response: string` |
| 来源 | 无 | `source: string`（`task:<id>`） |

这一处目前没炸，纯粹因为 UI 只读了 `sftSamples.length`、导出走的是服务端生成的 `jsonl` 字符串。**是运气，不是设计。**

### 3.3 为什么单测全绿

单元测试测的是 `buildDataFeedback()` 的**后端产出**，断言的是 `chosen.outcome` / `rejected.outcome` / `count` / `generatedAt` —— 没有任何一条断言 `similarity`。而崩的是**前端消费**，前后端之间那一层（HTTP + 类型断言）恰好是单测覆盖不到的地方。

这和本模块此前两起缺陷（评价从不落库、工具失败信号无人识别）是**同一个盲区**：`tests/` 里的测试替真实链路补上了它没做的那一环。

## 4. 复现路径

1. 打开 `http://127.0.0.1:9999/login`，用 `admin / 88888888` 登录。
2. 进入「反馈与学习」控制台。
3. 造出至少一组偏好对（同一目标下既有成功又有失败的评价），点「从评价中沉淀」。
4. 点「学习沉淀」页签 → **整页变白**，顶部页签栏一并消失。
5. 刷新页面重进 → 仍是白屏；切到其它页签才恢复。

> 判据是"点一次学习沉淀页签就整页空白"，不是某个接口报错 —— 接口自始至终返回 200。

## 5. 诊断方法

```bash
# 1. 后端返回的 pair 到底有哪些键（这一步就能定案）
curl -s -b "$COOKIE" 'http://127.0.0.1:9999/api/flm/admin/data-feedback' \
  | python3 -c 'import json,sys; d=json.load(sys.stdin); print(list(d["preferencePairs"][0].keys()))'
# → ['pairId', 'goal', 'chosen', 'rejected', 'generatedAt']      ← 没有 similarity

# 2. 前端在哪儿无条件用了它
grep -rn "similarity" ~/deepthink/web/src/

# 3. 前端类型声明的字段 vs 后端接口定义的字段
sed -n '/^export interface PreferencePair/,/^}/p' ~/deepthink/web/src/api/flm.ts
sed -n '/^export interface PreferencePair/,/^}/p' ~/deepthink/src/flm/flm-learn.ts

# 4. 浏览器控制台（最直接）
#    PAGE ERROR: TypeError: Cannot read properties of undefined (reading 'toFixed')
```

## 6. 修复方案

**主修：把已经算出来的 `similarity` 带出去（生产端补齐契约）。**

```diff
 // src/flm/flm-learn.ts
 export interface PreferencePair {
   pairId: string;
   goal: string;
   chosen:   { taskId: string | null; summary: string; outcome: Outcome };
   rejected: { taskId: string | null; summary: string; outcome: Outcome };
+  /** 配对用的目标相似度 —— 控制台「相似度」列展示的就是它。 */
+  similarity: number;
   generatedAt: number;
 }
```

```diff
       rejected: {
         taskId: best.neg.task_id,
         summary: goalByTask.get(best.neg.task_id)!.summary ?? '',
         outcome: best.neg.outcome,
       },
+      // 四舍五入到 4 位，避免把浮点尾巴抛给前端。
+      similarity: Number(best.sim.toFixed(4)),
       generatedAt: Date.now(),
```

**兜底：渲染层不允许单格数据异常升级成整页不可用。**

```diff
 // web/src/pages/FeedbackLearningPage.tsx
-<td className="px-2 py-1.5 text-right tabular-nums text-[11px]">{p.similarity.toFixed(2)}</td>
+<td className="px-2 py-1.5 text-right tabular-nums text-[11px]">
+  {Number.isFinite(p.similarity) ? p.similarity.toFixed(2) : '—'}
+</td>
```

**同批修掉案例检索的字段错配（§2.1）：给检索命中单独立一个与接口同形的类型。**

```diff
 // web/src/api/flm.ts —— 检索命中 ≠ 列表行，不能复用 FlmCase
+export interface CaseHit {
+  caseId: string; taskId: string | null; sampleType: string;
+  goal: string; summary: string | null;
+  attributionStage: AttributionStage | null;
+  similarity: number; cosineScore: number; lexicalScore: number; reuseCount: number;
+}
 export const searchCases = (q: string, topK = 5) =>
-  apiFetch<{ indexMode: string; hits: Array<FlmCase & { score: number }>; total: number }>(...);
+  apiFetch<{ indexMode: string; hits: CaseHit[]; total: number }>(...);
```

```diff
 // web/src/pages/FeedbackLearningPage.tsx
-{hits.map((h) => (
-  <div key={h.case_id} ...>
-    <span ...>{h.title}</span>
-    <span ...>相似度 {(h.score * 100).toFixed(1)}%</span>
-    <div ...>{h.goal}</div>
+{hits.map((h) => (
+  <div key={h.caseId} ...>
+    <span ...>{h.goal}</span>
+    <span ...>相似度 {Number.isFinite(h.similarity) ? (h.similarity * 100).toFixed(1) : '—'}%</span>
+    {h.summary && <div ...>{h.summary}</div>}
```

**并把验收脚本的判据从"看见标签"改成"咬住数值"：**

```diff
-passed: hits > 0 && /相似度/.test(text),
+const scores = [...text.matchAll(/相似度\s*([\d.]+)%/g)].map((m) => Number(m[1]));
+passed: hits > 0 && !/NaN|undefined|null/.test(text)
+        && scores.length > 0 && scores.every(Number.isFinite) && /使用手册/.test(text),
```

**顺带修正同源的假类型（`SftSample`），让类型重新等于事实。**

**选型理由：**

- **选"补字段"而不是"删列"**：相似度是这套配对算法的**判据本身**（`sim >= minSimilarity` 才允许配成对），把它删掉等于让运营看不到"这两条轨迹凭什么被配成一对"。信息本来就在，且 UI 早就有这一列，缺的只是搬运。
- **`Number(best.sim.toFixed(4))` 而不是直接 `best.sim`**：`0.7*cos + 0.3*overlap` 会产出 `0.7000000000000001` 这类尾巴，渲染再 `.toFixed(2)` 本身没事，但 JSONL 导出会带上噪声。在边界上收敛一次。
- **`Number.isFinite` 而不是 `??`**：`p.similarity ?? 0` 会显示 `0.00`，那是个**有意义的取值**（完全不相似），拿它冒充"字段缺失"是骗人。`—` 诚实地表达"未知"。
- **不加全局 ErrorBoundary（本轮）**：正确做法是把异常挡在这一个格子里，而不是让整页崩了再去兜。错误边界是另一件事（见 §8），不在本次修复范围。

**回归测试（判别力已实测）：**

- `tests/units/flm-learn.test.ts` → 新增 2 条：偏好对必带 finite 的 `similarity` 且等于配对判据（`0.5 ≤ sim ≤ 1`）；同目标配对的相似度 `> 0.8`。
- **撤掉 `similarity: Number(best.sim.toFixed(4))` 一行 → 2 条全部转红；恢复 → 全绿。**

## 7. 处理卡住的状态（如适用）

不适用 —— 该缺陷不写库、不改数据，纯前端渲染崩溃。刷新或切换页签即可恢复，无残留状态需要清理。

## 8. 经验沉淀 / 预防

- **「算了但没带出去」是一类独立的缺陷，别只盯"没算"。** 本次 `sim` 在作用域里活得好好的，只是拼返回对象时漏了。审查后端响应时，值得对着**算法里所有中间量**问一句：哪些是调用方需要的？`minSimilarity` 是这道闸的门槛，那么过了闸的**实测值**天然就该一起给出。
- **`apiFetch<T>` 的类型是"声明"不是"校验"。** 前端手写 interface 去描述后端响应，等于在关键接缝上写了一份**无人验证的文档**，而且写错的代价由编译期转移到运行期。低成本改进：对这份响应里的**每一个键**，都能指出后端哪一行写了它；指不出的就不要写进 interface。
- **渲染不可信数据时，`undefined` 只能影响它自己那一格。** 具体的 `.toFixed()` / `.map()` / 解构深取值都应在边界处做一次判断。**当前页面没有 ErrorBoundary，任何一个渲染期异常都会带走全部 7 个页签 —— 这个放大效应本身就是待办项**（建议单独排期：给控制台加一层错误边界，把"整页不可用"降级为"该页签报错"）。
- **⚠️ 这不是第一次，是同一个缺陷类的第二次发生 —— 上一次的修复方式就是它复发的原因。**
  2026-09-12 的 [[2026-09-12-eval-center-drift-tofixed-crash]] 记录的**是完全相同的故障链**：`EvalCenterPage.tsx` 对 `drift_score` 调 `.toFixed(2)`，而 `web/src/api/eval-center.ts` 把 PG `NUMERIC`（JSON 序列化后是**字符串**）声明成了 `number` → 渲染期 `TypeError` → DriftTab 整棵子树卸载为空白 → 连带其它 tab 一起变空白。

  两次的差别只在"字段为什么不是数字"：上次是 `string` vs `number`，这次是字段根本不存在。**相同的三要素一模一样：手写 interface 声明了与实际响应不符的类型 + 无校验的 `apiFetch<T>` 断言 + 渲染期直接调 `toFixed` 且无错误边界。**

  上次的修复是**就地修那个字段**——没有消除任何一项成因，于是 28 天后原样复发。**只修具体某个字段的实例，等于把同一颗雷留在原地。** 这类缺陷的根治项是那三条共同成因，特别是错误边界（它把"整页不可用"降级为"该页签报错"，无论下一个字段叫什么名字都能兜住）。建议把错误边界单独排期，而不是等第三次。
- **ui_test 阶段的价值在本次得到完整验证。** 该缺陷对单测 100% 不可见（测试覆盖的是后端产出），对接口冒烟也不可见（接口全程 200），只有**真的用浏览器点一遍**才会暴露。它与前两起缺陷一样：**"接口正常 + 测试全绿"完全不能推出"功能可用"**。
- **验收脚本的连锁超时是线索不是噪声。** TC-18/17/20/19 同时超时、TC-28 误报"案例库为空"，一开始很像脚本自身不稳；顺着"为什么这一簇用例同时挂"追下去，才定位到整页崩溃。**多个不相关用例同时失败时，先怀疑被测系统有共同的失效点。**
- **反过来也成立：用例「通过」不等于缺陷不存在 —— 判据太松会把缺陷放行。** TC-17 显示「相似度 NaN%」却判 ✅，因为判据只查了标签在不在。**凡是渲染数值的用例，判据必须解析出那个数值并检查它合理**（非 NaN、在值域内、有序）。一条只会 `test('相似度')` 的断言，和一个坏掉的页面，是可以同时成立的。
- **同一页签/同一文件的同类缺陷要一次查完。** §2 的崩溃修完就收工的话，§2.1 的 NaN 会被留在代码里。做法：定位到根因后，**在同一文件里把所有同型取值（`xx.yy.zz` 深取值 + 数值格式化）扫一遍**，逐个对着接口核对字段名。

相关：[[2026-10-10-flm-evaluations-never-persisted]]、[[2026-10-10-flm-toolcall-failure-signal-never-detected]]、[[2026-10-10-flm-feedback-dedup-collapses-distinct-messages]]
