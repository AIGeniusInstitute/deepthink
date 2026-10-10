# 加载失败被渲染成「暂无数据」：列表为空时无法区分"没有"与"没拉到"

- 日期：2026-10-10
- 模块：反馈与学习自进化（FLM）· 控制台全部页签（本例实测于「策略与灰度」）
- 严重级别：**中**（不损坏数据，但会向运营陈述一件不真实的事，且失败痕迹 4 秒后消失）
- 发现方式：Playwright 验收脚本 TC-24 失败，失败截图为空态
- 关联：[[2026-10-10-flm-learning-tab-crash-blanks-console]]（同属"页面把异常渲染成一种看似正常的状态"）

---

## 1. 用户现象

点开「策略与灰度」页签，页面显示：

```
暂无策略版本 —— 先在「学习沉淀」生成策略建议
```

而此刻库里**有 53 个策略版本**。用户按提示去「学习沉淀」再生成一遍，回来还是这句 —— 因为问题不在数据，在这一屏没有把数据拉回来。

更麻烦的是**没有任何线索留下**：失败时会弹一条 `加载失败：...` 的 toast，**4 秒后自动消失**；页面随后长期停留在"暂无数据"上。用户离开工位再回来，只看到一个自信的空列表。

这件事最早是从一条**看起来毫不相关**的报错暴露的：

```
TC-24 灰度中版本回滚到上一稳定版本（留痕） — 异常：page.click: Timeout 20000ms exceeded.
Call log:
  - waiting for locator('[data-testid="flm-canary-10-strat_6bcdd48e-5901-4069-9aeb-4e4d97d2534f"]')
```

"按钮找不到"与真实的根因（列表压根没加载出来）之间没有任何提示。

## 2. 问题描述

`web/src/pages/FeedbackLearningPage.tsx` 的 `loadTab()` 把**所有**页签的数据加载包在一个 try 里，catch 分支只发 toast、**不改变任何 state**：

```tsx
} else if (which === 'strategies') setStrategies((await flm.listStrategies()).strategies);
...
} catch (e) {
  toast.error(`加载失败：${e instanceof Error ? e.message : String(e)}`);
}
```

`setStrategies(...)` 的**实参先求值**：`listStrategies()` 一 reject，这行赋值就永远不会执行，`strategies` 保持初始值 `[]`。

而渲染层只看数组长度：

```tsx
{strategies.length === 0 ? (
  <Empty text="暂无策略版本 —— 先在「学习沉淀」生成策略建议" />
) : ( ...列表... )}
```

于是**"请求失败"与"库里真的为空"渲染成同一屏，且文案断言的恰好是后者**。

实盘证据（TC-24 失败时的截图 `23-TC-24-...-FAILED.png`）：页签处于选中态、页面无错误横幅，列表区域就是那句"暂无策略版本" —— 与真实空库无法区分。

对照同一时刻的接口：

```
GET /api/flm/admin/strategies → 200, 53 个版本, 60261B, 6ms
```

**接口是好的，页面也没崩（与缺陷 4 的整页白屏不同），它只是安静地说了一句假话。**

### 2.1 这不是"偶发网络问题"，是"失败无痕"的结构问题

触发这次失败的是一个**瞬时**的请求失败（重放同一时序 10 次均成功：`probe-tc24.cjs` 实测点击耗时 2.1s）。瞬时失败本身不可避免，**问题在于失败之后页面留下的状态与"空库"完全一致**：

| | 库里真的为空 | 这次加载失败 |
|---|---|---|
| 列表区域 | 「暂无策略版本…」 | 「暂无策略版本…」**（完全相同）** |
| 持久痕迹 | 无 | 无（toast 4 秒后消失） |
| 用户可采取的动作 | 去生成策略 | 去生成策略（**无效**） |

**一个把失败状态设计成与成功状态同形的界面，等于让偶发故障变成永久误解。**

> **诚实边界**：这次瞬时失败的**触发原因未能定位** —— 服务端日志没有对应的请求记录（无访问日志、无 ECONNRESET 记录），单机重放不可复现。本 issue 不声称知道它为什么失败，只处理"失败之后页面说了什么"。

## 3. 根因

1. **catch 分支不表达失败**：只 toast，不落 state。toast 是"事件"，state 才是"状态"；用事件去表达一个持续存在的状态，注定会丢。
2. **空态文案是一个事实断言**：「暂无策略版本」断言的是"库里没有版本"，而渲染条件只证明了"本地数组为空"。**渲染条件与文案断言的不是同一件事** —— 这是本缺陷的核心。
3. **`setX(await f())` 的赋值即陷阱**：赋值语句自身承担了"成功才有值"的语义，catch 一旦介入就没有任何补偿。凡 `setX(await ...)` 的地方都有这个形状。

## 4. 复现路径

1. 登录 `http://127.0.0.1:9999`，进入「反馈与学习」。
2. 使 `/api/flm/admin/strategies` 在一次页面加载中失败（瞬时网络错误即可；也可用 devtools 对该请求设 `Block request URL`，效果等价且必然复现）。
3. 点「策略与灰度」页签 → **显示「暂无策略版本」**。
4. 等 4 秒，toast 消失 → 页面上再也看不出刚才失败过。
5. 对照接口可证明库里并不是空的：
   ```bash
   curl -s -b "$COOKIE" .../api/flm/admin/strategies | python3 -c 'import json,sys; print(len(json.load(sys.stdin)["strategies"]))'
   # → 53
   ```

## 5. 诊断方法

```bash
# 1. 失败截图里看到的是"空态"而不是白屏 —— 先区分"崩了"和"安静地说假话"
open output/flm-acceptance/23-TC-24-*-FAILED.png

# 2. 同一时刻打接口，证明库里并不空（这一步就能定案）
curl -s -b "$COOKIE" .../api/flm/admin/strategies | python3 -c 'import json,sys; print(len(json.load(sys.stdin)["strategies"]))'

# 3. 代码：catch 是否落 state
sed -n '/} catch (e) {/,/^  }, \[loadOverview/p' web/src/pages/FeedbackLearningPage.tsx
#   修复前只有 toast.error 一行 —— 没有任何 setX

# 4. 空态渲染条件 vs 文案断言
grep -n '暂无策略版本' -B 2 web/src/pages/FeedbackLearningPage.tsx

# 5. 重放时序证明不是稳定复现（避免误判成产品必现缺陷）
node scripts/e2e/probe-tc24.cjs     # 点击 2.1s 成功
```

## 6. 修复方案

**把失败写进 state，并让它一直可见（toast 会消失，横幅不会）。**

```diff
 // web/src/pages/FeedbackLearningPage.tsx
+  /** 最近一次 loadTab 的失败原因（成功后清空）。用于把"加载失败"与"确实没有数据"分开。 */
+  const [loadError, setLoadError] = useState<string | null>(null);

   const loadTab = useCallback(async (which: string) => {
     try {
+      setLoadError(null);
       ...
     } catch (e) {
-      toast.error(`加载失败：${e instanceof Error ? e.message : String(e)}`);
+      const msg = e instanceof Error ? e.message : String(e);
+      setLoadError(msg);
+      toast.error(`加载失败：${msg}`);
     }
   }, [loadOverview, days, attrStage, eventSource]);
```

```diff
+  {loadError && <LoadErrorBanner message={loadError} onRetry={() => void loadTab(tab)} />}
   {enabled === false && <DegradedBanner what="控制台" />}
```

新增的 `LoadErrorBanner`（与既有 `DegradedBanner` 同构，带「重试」按钮）：

```tsx
function LoadErrorBanner({ message, onRetry }) {
  return (
    <div data-testid="flm-load-error" className="... border-red-300 bg-red-50 text-red-800">
      <AlertTriangle className="w-4 h-4 shrink-0" />
      <span className="flex-1">
        加载失败：{message} —— 下面的列表可能是空的，但**这不代表库里没有数据**。
      </span>
      <Button variant="outline" size="sm" onClick={onRetry}>重试</Button>
    </div>
  );
}
```

**空态文案不再断言"没有数据"：**

```diff
-<Empty text="暂无策略版本 —— 先在「学习沉淀」生成策略建议" />
+<Empty text={loadError
+  ? `策略列表加载失败（${loadError}），这不代表库里没有版本 —— 请点上方「重试」`
+  : '暂无策略版本 —— 先在「学习沉淀」生成策略建议'} />
```

**验收脚本侧：把"点击超时"换成"明确结论"。**

```diff
+  // 「策略与灰度」列表为空有两种含义完全不同的原因：库里真没有版本，或这一次加载失败。
+  const waitStrategiesList = async () => { /* 轮询列表是否渲染；未渲染则点「刷新」重试，最多 12s */ };
   await goFlmTab('strategies');
+  const loadedB = await waitStrategiesList();
+  if (!loadedB.ok) {
+    const err = await page.locator('[data-testid="flm-load-error"]').innerText().catch(() => '（无横幅）');
+    return { passed: false, details: `策略列表未能加载且重试无效，无法回滚；页面自述：${err}` };
+  }
   await page.click(`[data-testid="flm-canary-10-${stratB.version_id}"]`);
```

**选型理由：**

- **用持久横幅而不是更长的 toast**：toast 是"发生了一件事"，横幅是"现在处于一种状态"。要解决的恰恰是"失败之后页面长期撒谎"，所以必须让失败有**与页面同寿命**的表达。
- **`Retry` 直接复用 `loadTab(tab)`**：不引入新语义，重试就是再加载一次当前页签。
- **文案里明写"这不代表库里没有数据"**：把界面的**不确定性**如实告诉用户，比让他自己猜"是真空还是出错了"更省事。空态与错误态的差别必须写在脸上，不能只靠颜色。
- **不引入全局 ErrorBoundary**：那是另一个议题（见 [[2026-10-10-flm-learning-tab-crash-blanks-console]] §8）。本缺陷里页面**没有崩**，加错误边界解决不了"安静地说假话"。
- **只在有证据的页签上改空态文案**：其余页签（案例库/告警/审计）有同样形状的空态，但本轮只有「策略与灰度」拿到了失败证据。横幅是全局的，已经覆盖了"用户不会被误导"；逐页签改写属于代码整洁问题，**按既有的独立缺陷另行处理，不顺手重构**。

## 7. 处理卡住的状态（如适用）

不适用 —— 该缺陷不写库、不改配置。页面点「刷新」或重进页签即可恢复。

**但有一个真实后果需要人工处理**：验收脚本此前把它报成 `page.click: Timeout 20000ms exceeded`，看起来像"按钮选择器写错了"。排查时请注意先看**失败截图**：如果截图里是空态而非白屏，方向就是"数据没拉回来"，而不是"定位器不对"。

## 8. 经验沉淀 / 预防

- **空态是一句事实断言，不是一种样式。** 「暂无数据」这四个字在向用户担保"库里没有"。所以**渲染空态的条件必须与这句话等强**：只有当"确实查询成功且结果为空"时才允许展示。任何"本地数组为空"就渲染空态的写法，都在悄悄把加载失败升级成错误结论。
- **用事件（toast）表达状态（已失败）必然丢失。** 判断标准很简单：这个信息在用户**几分钟后**回来时还需要吗？需要就必须进 state。toast 只适合"刚刚发生、且不留后果"的确认类反馈。
- **`setX(await f())` 是"成功才有值"的隐式契约。** catch 必须给出补偿，否则 state 会停留在一个**有意义但错误**的取值上（空数组恰好是最危险的取值 —— 它合法、常见、且有专门的空态 UI 去"解释"它）。
- **"按钮找不到"和"列表没加载"是两件事，别让超时把它们混成一个。** 自动化里凡"等某个列表项再点它"的地方，都应**先断言列表容器已有内容**，否则失败信息会指向错误的方向。本次已把该断言补进 TC-23/TC-24。
- **瞬时失败不可消灭，但可以被"诚实化"。** 我们无法保证请求永不失败；能保证的是失败**不会伪装成正常**。这条与缺陷 4/5 是同一族：**当一个故障的表现形式与某种正常状态完全同形时，它的危害会被"看起来没问题"放大。**
- **巡检/自检建议**：给所有列表页签的接口加一条"失败即显式"的约束 —— 代码评审时搜 `catch` 分支里是否只有 `toast`，有则视为待修。本次修复后 `flm-load-error` 这个 testid 也可直接用于端到端断言"失败必可见"。

相关：[[2026-10-10-flm-learning-tab-crash-blanks-console]]、[[2026-10-10-flm-data-feedback-blocks-event-loop]]、[[2026-10-10-flm-case-library-duplicates-and-topk]]
