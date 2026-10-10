# 「数据回流」接口同步重算 2.3 万次嵌入，把整个平台的事件循环冻住 4 秒

- 日期：2026-10-10
- 模块：反馈与学习自进化（FLM）· F4.6 数据回流（AC-F4.6、TC-FLM-19）
- 严重级别：**高**（**跨模块**：不是 FLM 自己变慢，而是整个 Node 进程内**所有**请求被冻结）
- 发现方式：验收脚本出现一批"互相不相关却同时失败"的用例（TC-17/TC-28/TC-29 + 一次 `read ECONNRESET`），顺着"为什么它们同时挂"追到此处

---

## 1. 用户现象

打开「反馈与学习 → 学习沉淀」页签的瞬间，**整个平台**卡住几秒：

- 同一页签的「案例检索」点了没反应，几秒后才出结果（看上去像"搜不到"）；
- 别的页签（策略与灰度）点进去是空的「暂无策略版本」，十几秒都不出来；
- 页面右下角反复弹「**已恢复连接**」——WebSocket 心跳被卡断，前端以为自己掉线了；
- 正在跑的验收脚本里出现 `异常：read ECONNRESET`，以及一堆「案例库为空」「无命中」的误判。

关键在于这些现象**互不相关且随机**：换一次跑，挂的用例就换一批。所以最开始一直被当成"验收脚本不稳 / 环境互扰"。

## 2. 问题描述

`GET /api/flm/admin/data-feedback` 实测耗时 **4.24 秒**（同一份数据下，`/api/flm/health` 只要 1.5 毫秒）。

而在这 4 秒里，**同进程的其它请求全部排队**（实测：并发发起 `health` 与 `admin/strategies`，两者都变成 3.51 秒）：

```
health(期间)          3.512s  bytes=238      ← 平时 0.0016s
strategies(期间)      3.513s  bytes=60261    ← 平时 0.0033s
data-feedback         3.815s  bytes=45535
```

**原因不是"这个接口慢"，而是"这个接口慢的方式是错的"** —— 它做的是**同步** CPU 计算，独占 Node 的单线程事件循环。在它算完之前，服务器读不了下一个请求、发不出 WebSocket 心跳、甚至连 `/health` 都不响应。

这不是 FLM 一个模块的问题：同一进程里跑着聊天、Agent 会话、飞书 webhook、看板。**任何一个用户点开「学习沉淀」，全平台所有人的请求都要停 4 秒。**

## 3. 根因

### 3.1 直接原因：正 × 负双重循环里，每次比较都现场重算嵌入

`src/flm/flm-learn.ts` 的 `buildDataFeedback()`：

```ts
for (const p of positive) {
  const pg = goalByTask.get(p.task_id)!.goal;
  for (const n of negative) {
    const ng = goalByTask.get(n.task_id)!.goal;
    const sim = 0.7 * cosine(embed(pg), embed(ng)) + 0.3 * lexicalOverlap(pg, ng);
    //                    ↑ 每次比较重算 pg        ↑ 每次比较重算 ng
  }
}
```

`pg` 在外层循环里是**常量**，却在内层被重算 `|negative|` 次；`ng` 也没有任何缓存。而 `embed` / `lexicalOverlap` 都是 **O(文本长度)** 的：

```ts
for (let i = 0; i < norm.length; i++) {
  add(norm[i], 1);                    // 每字一次 sha1
  if (i + 1 < norm.length) add(norm.slice(i, i + 2), 1.5);   // 每字一次子串切分 + sha1
}
```

目标文本最长 300 字（`taskGoalText` 的上限），**一次 embed = 600 次 sha1 + 600 次子串分配**。

实盘数据量（`~/.deepthink-9999/db/messages.db`）：

| 量 | 值 |
|---|---|
| `flm_evaluations` | 220 行（achieved 90 / failed 130） |
| 不同 `task_id` | **12** |
| 不同目标文本 | **12** |
| 配对比较次数 | 90 × 130 = **11 700** |
| `embed` 调用次数 | ≈ **23 400** |

**同一个目标文本被向量化了上千次，而全库只有 12 个不同的目标。** 这就是那 4 秒。

### 3.2 为什么它冻结的是整个进程

Node 是单线程事件循环。`buildDataFeedback` 是**同步函数**，路由里直接调用（`src/routes/flm.ts:580`）：

```ts
router.get('/admin/data-feedback', adminRoleMiddleware, safe((c) => {
  const artifact = buildDataFeedback(evals, goalByTask);   // ← 同步、无 await、无分片
  return c.json({ ...artifact, jsonl: toJsonl(artifact) });
}));
```

没有 `await`，也就没有任何让出事件循环的机会。计算期间到达的 TCP 连接只能待在 accept 队列里，已经建立的连接读不到数据 ——
客户端表现就是**超时 / 连接被重置 / WebSocket 心跳失败**，于是：

- 验收脚本的 Node HTTP 客户端复用了一条 keep-alive 连接，服务端正忙时连接被关闭 → `read ECONNRESET`；
- 前端 `loadTab()` 里排在后面的请求迟迟不回，脚本的**固定睡眠**（`goFlmTab` 只等 1.2 秒）早已走完 → 断言时数据还没渲染 →「无命中」「案例库为空」「对比卡片未渲染」；
- WebSocket 心跳超时 → 前端判定掉线 → 弹「已恢复连接」。

### 3.3 为什么单测没发现

单测调用 `buildDataFeedback` 用的夹具是 **3 条评价 / 3 个目标**：循环只跑 2 次，恒为微秒级。
**复杂度缺陷在"正确的、小的"夹具下完全不可见** —— 它不是行为错误，是**量级**错误，只有真实数据量才能暴露。

同一族的判据缺口还有一条：**「接口耗时」从来不在任何断言里**。整个 FLM 的 203 条单测没有一条对响应时间设上限，因此这条缺陷可以一路走到验收阶段。

## 4. 复现路径

1. 对任何有真实评价数据的实例（本机 `~/.deepthink-9999`，220 条评价）：

```bash
# 一个终端：反复打这个接口
while true; do curl -s -o /dev/null -w "data-feedback %{time_total}s\n" -b "$COOKIE" \
  http://127.0.0.1:9999/api/flm/admin/data-feedback; done
```

2. 另一个终端：同时打**任何别的**接口

```bash
curl -s -o /dev/null -w "health %{time_total}s\n" -b "$COOKIE" http://127.0.0.1:9999/api/flm/health
# 平时 0.0016s；上面那条在跑时变成 3~4s
```

3. 或直接打开控制台「学习沉淀」页签，观察页面右下角是否弹出「已恢复连接」——心跳被卡断的标志。

**判据是"别的接口被拖慢"，不是"这个接口慢"** —— 单看这一个接口的耗时，很容易被归成"数据量大，正常"。

## 5. 诊断方法

```bash
COOKIE=$(curl -s -i -X POST http://127.0.0.1:9999/api/auth/login \
  -H 'Content-Type: application/json' -d '{"username":"admin","password":"88888888"}' \
  | grep -i '^set-cookie' | sed 's/^[Ss]et-[Cc]ookie: //' | cut -d';' -f1)

# 1. 单独打这个接口：拿到"慢"这个事实
curl -s -o /dev/null -w "http=%{http_code} time=%{time_total}s\n" -b "$COOKIE" \
  http://127.0.0.1:9999/api/flm/admin/data-feedback
# → time=4.24s

# 2. 并发打：拿到"拖垮别人"这个事实（这一步才定案）
#    一个在算 data-feedback，另一个打 health —— health 也变成 3.5s，说明是同步阻塞，不是 IO 等待
python3 - "$COOKIE" <<'PY'
import sys, threading, time, urllib.request
cookie = sys.argv[1]
def timed(path, label, out):
    t0 = time.time()
    r = urllib.request.Request('http://127.0.0.1:9999' + path, headers={'Cookie': cookie})
    urllib.request.urlopen(r, timeout=60).read()
    out.append((label, round(time.time()-t0, 3)))
out = []
t = threading.Thread(target=timed, args=('/api/flm/admin/data-feedback', 'data-feedback', out)); t.start()
time.sleep(0.3)
for p, l in (('/api/flm/health','health'), ('/api/flm/admin/strategies','strategies')):
    threading.Thread(target=timed, args=(p, l, out)).start()
t.join(); time.sleep(5)
for l, s in sorted(out, key=lambda x: x[1]): print(f'{l:<16}{s}s')
PY
# → health 3.5s / strategies 3.5s / data-feedback 3.8s

# 3. 算一下冗余倍数（说明"该有多快"）
sqlite3 ~/.deepthink-9999/db/messages.db \
  "SELECT (SELECT count(*) FROM flm_evaluations WHERE outcome='achieved')
        * (SELECT count(*) FROM flm_evaluations WHERE outcome<>'achieved') AS pairs,
          count(DISTINCT task_id) AS distinct_tasks FROM flm_evaluations;"
# → 11700|12   ← 一万多次比较，只有 12 个不同目标
```

## 6. 修复方案

**主修：把"按目标文本"的中间量提到循环外记忆化（`flm-learn.ts`）。**

```diff
+  // 相似度是纯函数，按目标文本记忆化不改变任何数值，
+  // 只是把调用次数从 O(正×负) 降到 O(不同目标数)。
+  const vecCache = new Map<string, number[]>();
+  const gramCache = new Map<string, Set<string>>();
+  const vecOf = (t: string) => { let v = vecCache.get(t); if (v === undefined) { v = embed(t); vecCache.set(t, v); } return v; };
+  const gramOf = (t: string) => { let g = gramCache.get(t); if (g === undefined) { g = bigrams(t); gramCache.set(t, g); } return g; };
+
   for (const p of positive) {
     const pg = goalByTask.get(p.task_id)!.goal;
+    const pv = vecOf(pg);
+    const pGram = gramOf(pg);
     for (const n of negative) {
       const ng = goalByTask.get(n.task_id)!.goal;
-      const sim = 0.7 * cosine(embed(pg), embed(ng)) + 0.3 * lexicalOverlap(pg, ng);
+      const sim = 0.7 * cosine(pv, vecOf(ng)) + 0.3 * jaccard(pGram, gramOf(ng));
```

配套把 Jaccard 从 `lexicalOverlap` 里拆成可复用的集合版本（行为不变）：

```diff
+function jaccard(A: Set<string>, B: Set<string>): number {
+  if (A.size === 0 || B.size === 0) return 0;
+  let inter = 0;
+  for (const t of A) if (B.has(t)) inter++;
+  return inter / (A.size + B.size - inter);
+}
 export function lexicalOverlap(a: string, b: string): number {
-  const A = bigrams(a); const B = bigrams(b);
-  ... 同一段算法
+  return jaccard(bigrams(a), bigrams(b));
 }
```

**顺带修掉一处被本条缺陷掩盖的静默失败（`FeedbackLearningPage.tsx`）。**

`doSearch()` 原来没有 `catch`：检索请求失败时 `setHits` 不被调用，页面**既不报错也没有结果**，和"没有命中"长得一模一样 —— 这次的排查就先被它误导到了检索算法上。

```diff
 async function doSearch() {
   if (!query.trim()) return;
-  const r = await flm.searchCases(query, 5);
-  setHits(r.hits);
-  setIndexMode(r.indexMode);
+  try {
+    const r = await flm.searchCases(query, 5);
+    setHits(r.hits);
+    setIndexMode(r.indexMode);
+  } catch (e) {
+    toast.error(`案例检索失败：${e instanceof Error ? e.message : String(e)}`);
+  }
 }
```

**效果（同一份实盘数据，接口计时）：**

| | 修复前 | 修复后 |
|---|---|---|
| `/admin/data-feedback` | 4.24s | **0.012s** |
| 期间 `/api/flm/health` | 3.51s | **0.002s**（不再被拖累） |

**选型理由：**

- **选"记忆化"而不是"改成异步/分片/加缓存"**：这一处是纯粹的**重复计算**（同一输入算上千次），不是"计算本身太重"。消除重复后单次调用已是毫秒级，异步化、worker 线程、结果缓存带来的复杂度与失效问题在这里都不必要 —— 按"最小改动解决问题"取舍。
- **缓存放在函数内部、不放到模块级**：模块级 Map 会随目标文本无限增长且没有失效时机；`buildDataFeedback` 的调用边界天然就是缓存的生命周期。
- **结果必须逐位不变**：相似度是配对的**判据**（`sim >= minSimilarity` 才允许配对），数值一变，偏好对就可能变。所以补了一条"与朴素重算逐位一致"的回归用例，把"优化不能改结果"钉住。
- **不做"整个接口加结果缓存"**：AC-F4.6 的回流产物要求"生成时间 / 来源"随取随新，跨请求缓存会把陈旧数据发给下游训练管线。慢的根因既已消除，就不引入这一层。

**回归测试（判别力已实测）：**

- `tests/units/flm-learn.test.ts` 新增 2 条：
  - 「记忆化不改变相似度数值」：按**原始公式**独立重算，与产物里的 `similarity` 逐位比对。
  - 「大输入下仍是线性量级」：80 正 × 80 负 × 300 字目标，**实测量级**必须 < 500ms。
- **撤掉记忆化两行 → 性能用例转红（实测 4191ms vs 阈值 500ms）；恢复 → 50 条全绿（总耗时 544ms）。**

### 仍无法修复的部分（需人工介入 / 架构决策）

**"同步 CPU 计算走请求路径"是这类故障的公共成因，本次只消除了具体那一处。**

平台里还有别处做同步重计算（本次未逐一排查）。彻底的解法是给请求路径定一条纪律：**超过 N 毫秒的 CPU 计算不进请求线程**（改预计算 / 缓存 / worker）。
这属于平台级取舍，不在本模块范围内。**建议的巡检**（可落地，无需改造）：

```bash
# 任何接口超过 200ms 就打日志告警 —— 本次这个接口 4.24s，本可以更早被发现
# 已具备的条件：运维侧已有 /api/flm/health 之类的轻接口可作"背景延迟探针"，
# 在重接口压测时同时打它，背景延迟被抬起来就说明是同步阻塞而非 IO 慢。
```

## 7. 处理卡住的状态（如适用）

**运行期**：该缺陷不留残留状态，计算结束后一切自动恢复，无需人工清理。

但它会**制造假故障**并因此卡住排查与自动化：本起事故中，一个正在跑的验收进程卡在最后一条用例上数分钟（服务端在同步计算，浏览器的请求永远不来），最终以 exit=1 结束且留下一批自相矛盾的证据。
**处置方式是"先看背景延迟，再信用例结论"**：`curl` 一个轻接口，如果它也慢，就不是被测功能的问题 —— 本次正是靠这一步把 8 个"飘忽的失败"收敛到 1 个根因。

## 8. 经验沉淀 / 预防

- **"慢"有两种，危害差一个数量级：IO 慢只慢自己，同步 CPU 慢会慢掉整个进程。** 排查性能问题时，第一步应该是"**同时**打一个轻接口"，而不是盯着慢接口本身的耗时做优化。区别是决定性的：前者可以慢慢优化，后者是**跨用户的生产事故**。
- **"一批互不相关的用例同时失败"是系统性线索，不是噪声。** TC-17（学习页签）、TC-28（学习页签）、TC-29（策略页签）、TC-32（设置页签）、`read ECONNRESET`（HTTP 客户端）—— 它们唯一的共同点就是"都要向同一个进程要数据"。**失败集合的交集，往往就是根因所在的层次。** 反过来，把它们逐条当"脚本不稳"处理（加睡眠、加重试）会同时掩盖缺陷与消耗排查时间。
- **复杂度缺陷在小夹具下不可见 —— 性能必须有"量级"判据，而不只有"行为"判据。** 3 条评价的夹具永远跑不出 4 秒。凡是 O(n²) 可能的路径（双重循环、逐条重算中间量），回归用例里都要有一份**接近真实规模**的输入，并断言**量级**（< 500ms），而不只是结果对不对。
- **"每次循环里重算一个循环不变量"是最典型的性能缺陷，也最容易在评审中滑过去。** 它在代码上完全"正确"：`cosine(embed(pg), ...)` 每次调用都返回正确值。审查双重循环时值得固定问一句：**内层用到的哪些量，只依赖外层变量？** 本次的 `pg` 就是其中一个，且占据了半数计算量。
- **不要用"固定睡眠"等待异步渲染，要等条件。** `goFlmTab` 的 `waitForTimeout(1200)` 是这次一连串误判的直接放大器：服务端被冻住时，1.2 秒远远不够，脚本却照常断言，于是"没渲染出来"被记成"功能没有"。**验收脚本里每一次固定睡眠，都是一条潜在的假阳性。**
- **静默失败会把排查引向错误的模块。** `doSearch()` 没有 `catch`，请求失败时的界面与"检索无结果"完全一致，导致第一轮怀疑对象是检索算法。**任何"异步动作失败后界面不变化"的地方，都要有一条显式的失败路径**（toast / 错误态），它的成本远低于一次误诊。
- **性能回归要有"判别力实测"。** 本次两处修复都做了撤销验证（撤掉 → 转红，恢复 → 全绿），确认用例真的咬得住，而不是在恒真的断言上收获虚假的安全感。
