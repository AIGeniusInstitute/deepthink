# 运行详情 · 运行轨迹只能看到 3 行，无法展开完整数据

- 日期：2026-10-13
- 影响面：`/runtime-monitor` 单次运行详情抽屉的「运行轨迹」区（8 条来源全都受影响）
- 严重度：功能缺口（数据没丢，但用户看不到；是上一版 `7b3dad9` 交付的监控模块的可用性缺陷）
- 结论：**真正修复**（真实浏览器 A/B 验证，见 §6.3）

---

## 1. 用户现象

在 `http://localhost:9999/runtime-monitor` 的运行列表里点开任意一条运行，右侧抽屉的
「运行轨迹」每一步都显示「入参 / 出参」，但**每段文字都被截断成 3 行并以 `…` 结尾**，
界面上没有任何可以展开的入口。用户原话：

> 运行列表 - 点击一个，展开 运行详情： 运行轨迹 现在是有截断省略的展示的，
> 我需要能够展开，看到完整的轨迹数据。

实测这不是个别现象：隔离快照里 7 天窗口的 **20 条运行中有 12 条**的轨迹存在被截掉的文本；
被抽样的那条长运行（4518 步）**1595 个字段被裁**，累计隐藏 **192080 px** 内容。

## 2. 问题描述

`RunDetailPanel.tsx` 里轨迹行的入参/出参用 Tailwind `line-clamp-3` 渲染：

```tsx
<div className="... whitespace-pre-wrap break-words line-clamp-3">
```

`line-clamp-3` 展开后是 `display:-webkit-box; -webkit-line-clamp:3; overflow:hidden`，
即**固定 3 行 + 溢出裁掉**。文本本身在 DOM 里是完整的（`textContent` 拿得到全文），
但视觉上被裁，且组件没有提供任何切换开关 —— 用户没有任何手段把被裁的部分显示出来。

## 3. 根因

**纯展示层问题，数据没有丢**：轨迹 payload 里 `inputSummary` / `outputSummary` 是完整的，
是 CSS 把它裁成了 3 行且不可逆。

所以本次不改后端、不改数据库、不改写入路径 —— 只给展示层加一个展开开关。

### 3.1 顺带查清的写入侧边界（本次**不**动，但必须让用户知道）

「展开」只能展开到**库里存了的内容**。以下是实测的写入侧上限，全部是既有设计，本次未改：

| 来源 / 步类型 | 字段 | 写入时上限 | 位置 | 生产实测 |
|---|---|---|---|---|
| 对话 · `thinking` 步 | output_summary | **500** | `container/agent-runner/src/trace-node-allocator.ts:316,324` | `trace_steps` 中 119 行，**108 行已触顶**（长度恰为 500） |
| 对话 · `turn` 步 | output_summary | **400** | `container/agent-runner/src/index.ts:2413` | `chat_trace_nodes` 实测 out 最大 406 |
| 开放平台 AaaS | input/output_summary | **500** | `src/open-platform/run-recorder.ts:26`（`SUMMARY_MAX`，注释写明"监控表不该成为用户数据的第二份副本"） | 生产 `open_platform_runs` **0 行**；探针快照 9 步实测 0 触顶（最长 175） |
| 对话 · 工具原始 I/O | input/output_json | 读侧 **500** | `src/runtime-monitor/queries.ts:367-368` | `trace_tool_calls` 23878 行**全部未触顶**（in 最大 2、out 最大 406），该截断目前是空转 |

> 结论要说清楚：**对话的 `thinking` 步展开后最多也只能看到 500 字符**，因为更长的部分
> 在 agent-runner 侧就没落库（`slice(0, 500)`）。这是容器运行时的既有决策，改它要动
> agent-runner 与对话存储量，按 Surgical Changes 原则**不在本次范围内**，仅登记。
> `queries.ts:367-368` 的读侧 500 截断经实测 0 行触顶，属于"有损但目前不生效"，
> 同样未动（去掉它会让响应体失去上界，需要另设一个同样武断的新上限，属于臆测性改动）。

## 4. 复现路径

1. 打开 `http://127.0.0.1:9999/runtime-monitor`（或隔离实例 `:9997`），用 `admin / 88888888` 登录；
2. 默认 7 天窗口，在「运行列表」里点任意一条 **对话 / IM Agent** 来源的运行；
3. 右侧抽屉拉到底部的「运行轨迹」；
4. 观察每一步的「入参 / 出参」：**最多 3 行**，超出部分以 `…` 结尾；
5. 把鼠标移到文字上、点一下、按键盘 —— 都不会展开，页面上也没有任何"展开"控件。

## 5. 诊断方法

```bash
# ① 隔离实例上直接启动一个可反复重启的验收环境（不要碰生产 :9999）
#    纯 UI 验收不需要容器能力，可跳过 docker 镜像重建，直接手起：
cd <worktree>
DEEPTHINK_DATA_DIR=/tmp/deepthink-rm-9997 WEB_PORT=9997 nohup node dist/index.js > /tmp/rm-e2e/instance.log 2>&1 &

# ② 用真实浏览器脚本量「到底裁掉了多少」（脚本见测试报告目录，结构选择器，新旧代码通用）
node /tmp/rm-e2e/expand-trace.mjs http://127.0.0.1:9997 /tmp/rm-e2e/out-9997

# ③ 关键判据在脚本里是这几行（不是在 DOM 里搜文本 —— textContent 被裁时也是全文，
#    只搜文本会得到"看起来没问题"的假阳性）：
#    折叠态：getComputedStyle(el).webkitLineClamp === '3' 且 el.scrollHeight > el.clientHeight
#    展开态：getComputedStyle(el).webkitLineClamp === 'none' 且 el.scrollHeight <= el.clientHeight

# ④ 复现写入侧边界（生产库只读查询）
sqlite3 -readonly ~/.deepthink-9999/db/messages.db \
  "SELECT node_type, COUNT(*), SUM(CASE WHEN length(output_summary)>=500 THEN 1 ELSE 0 END), MAX(length(output_summary)) FROM trace_steps GROUP BY node_type;"

# ⑤ 收尾：只杀监听进程（不加 -sTCP:LISTEN 会连 OrbStack/Docker 网络代理一起杀掉）
lsof -ti:9997 -sTCP:LISTEN | xargs kill
```

## 6. 修复方案

### 6.1 关键改动（`web/src/components/runtime-monitor/RunDetailPanel.tsx`，+53 / -8，单文件）

```diff
-function TraceRow({ item, totalMs }: { item: TraceItem; totalMs: number | null }) {
+function TraceRow({ item, totalMs, expanded }: { item: TraceItem; totalMs: number | null;
+  /** 展开态下不再钳制行数，入参/出参照原样铺开。 */
+  expanded: boolean;
+}) {
+  const clamp = expanded ? '' : ' line-clamp-3';
   return (
     ...
-        <div className="mt-1 ml-4.5 text-xs text-muted-foreground whitespace-pre-wrap break-words line-clamp-3">
+        <div data-testid="trace-input"
+             className={`mt-1 ml-4.5 text-xs text-muted-foreground whitespace-pre-wrap break-words${clamp}`}>
```

```diff
 export function RunDetailPanel() {
+  // 记的是「哪条运行被展开了」而不是一个裸 boolean：换一条运行天然回到紧凑视图，
+  // 不需要额外的 effect 去重置（也就不会有一帧残留的展开态）。
+  const [expandedRunId, setExpandedRunId] = useState<string | null>(null);
   ...
+  const expanded = detail !== null && expandedRunId === detail.run.runId;
+  // task / sandbox / harness-eval 是原子运行记录，入参出参都为空 —— 展开它们不会有
+  // 任何变化，索性不给一个点了没反应的按钮。
+  const expandable = detail !== null && detail.trace.some((t) => t.inputSummary || t.outputSummary);
```

```diff
-              <h3 className="text-sm font-semibold text-foreground mb-1">
+              <h3 className="mb-1 flex items-center gap-2 text-sm font-semibold text-foreground">
                 运行轨迹
+                {expandable && (
+                  <Button variant="ghost" size="sm" className="ml-auto"
+                          data-testid="trace-expand-toggle"
+                          onClick={() => setExpandedRunId(expanded ? null : detail.run.runId)}>
+                    {expanded ? <ChevronsDownUp .../> : <ChevronsUpDown .../>}
+                    {expanded ? '收起' : '展开完整轨迹'}
+                  </Button>
+                )}
```

### 6.2 选型理由

- **为什么是"整条轨迹一个开关"而不是"每一行一个展开按钮"**：实测 7 天窗口里
  **12/20 条运行的轨迹存在被裁文本**、抽样运行的 6669 个字段里 1595 个被裁 —— 需要展开的
  几乎是每一行。逐行按钮等于让用户点几十次，且会在绝大多数行上挂一个按钮噪声。
  一个 `展开完整轨迹 / 收起` 按钮一次解决整段轨迹，状态只有一个，代码最少。
- **为什么状态存 `expandedRunId` 而不是 `boolean`**：抽屉会在不关闭的情况下被切换运行
  （点列表另一行）。存 runId 天然表达"只有这条运行处于展开态"，不需要 `useEffect` 去重置，
  也不会出现"换了一条运行但还停在展开态"的残留帧。
- **为什么加 `expandable` 判空**：`task / sandbox / harness-eval` 是原子运行记录，
  入参出参都是空 —— 给它们渲染展开按钮会得到一个"点了没反应"的死按钮。
- **为什么不顺手改 `Field`（工作区 / Agent）的 `truncate`**：用户说的是「运行轨迹」，
  且这些字段实测都很短（轨迹标题最长 38 字符），按 Surgical Changes 不动。
- **为什么不动写入侧的 500/400 上限**：见 §3.1 —— 既有设计 + 改它会牵动 agent-runner 与
  对话存储量，且**已经落库的行也救不回来**。

### 6.3 验证（A/B：同一份数据，旧代码必红）

| 项 | 结果 |
|---|---|
| 真实浏览器验收（12 步，含截图） | **12/12 通过**，脚本与产物见 `docs/test_report/agent-runtime-monitor/iteration-2-trace-expand/` |
| **A/B 判别**：把改动 patch 掉重建 web、对**同一份数据**再跑同一脚本 | 前 5 步照常通过（现象复现：1595 个字段被裁、隐藏 192080px），第 6 步**红**在「轨迹区没有『展开完整轨迹』按钮（旧代码即此状态，用户无路可走）」 |
| 展开后是否真的没有视觉裁切 | 6669 个入参/出参元素全部 `-webkit-line-clamp: none`，`scrollHeight > clientHeight` 的元素 **0 个**；1595 个被裁元素的可视高度全部变大 |
| 内容是否是**完整原文** | 6669 个非空字段与后端 `runs/:runId` payload **逐字一致**（最长 406 字符） |
| 可逆 | 再点一次「收起」→ 6669 个元素全部回到 `line-clamp:3` |
| 换运行自动复位 | 切到另一条运行 → 展开态已重置，无元素停留在展开态 |
| 死按钮 | `定时任务` 来源的成功运行（无入参/出参）**不渲染**展开按钮 |
| `make typecheck` / `make test-smoke` / shared 漂移门禁 | 全绿（`test-smoke` 21 文件 / 470 用例；漂移脚本直接跑 exit 0） |
| `make test` | 2067 passed / 14 skipped，唯一失败是既有已知抖动 `tests/feishu-card.test.ts`（5s 超时；单独重跑 **94/94 全过**） |

## 7. 处理卡住的状态

不适用 —— 本次是展示层改动，不涉及运行态、队列或数据修复。已停的只是验收用的隔离实例
（`lsof -ti:9997 -sTCP:LISTEN | xargs kill`，进程 93003）。

## 8. 经验沉淀 / 预防

1. **`line-clamp-N` 是"单向"的截断**：它让文本看起来像"正常换行"，很容易在 review 时
   被当成样式细节放过。**长文本展示必须同时交付一个展开入口** —— 或者干脆别用 clamp。
   检查清单：凡是渲染用户/Agent 产出的自由文本（入参、出参、错误、日志），
   都问一句"超出 N 行之后用户怎么办"。
2. **验"文本有没有被裁"不能搜 DOM 文本**。`textContent` 在 CSS 裁剪下依然是全文，
   断言"页面上有这段文字"会在截断存在时照样通过 —— 这是本次差点踩进去的坑：
   第一版脚本的判据是"存在 `line-clamp:3` 的元素"，结果选中了一条**一个字都没被裁**的运行，
   `隐藏 0px`，等于什么都没验。**正确判据是几何量**：`scrollHeight > clientHeight`
   才算真的被裁，展开后要求 `scrollHeight <= clientHeight`。
3. **A/B 的选择器必须两边都存在**。第一版脚本用本次新加的 `data-testid` 去选元素，
   结果在旧代码上"红"的理由是"选择器找不到元素"——这种红没有信息量，证明不了用户看不到入口。
   改成结构选择器（轨迹列表内、只有一个标签子元素、文本以"入参/出参"开头）后，
   旧代码才如实红在"没有展开按钮"这一步。同理，断言新功能时**先断言用户可见的文案/角色**，
   再断言自动化钩子。
4. **验收实例要能构造边界样本**。本机生产库里 `定时任务 / 沙箱 / 评测` 三个来源一条运行都没有，
   "不渲染死按钮"这条分支在真实数据上永远走不到。往**隔离快照**里插一行种子数据
   （`scheduled_tasks` + `task_run_logs`，`status='success'`、`error=NULL`）就把它跑通了 ——
   隔离快照本来就是一次性的，比让分支裸奔更划算。
5. **顺手记一笔数据现实**：生产库当前 `open_platform_runs` 是 **0 行**，监控页上能看到的
   8 条 AaaS 运行全部由上一轮的探针调用产生、只存在于隔离快照里。也就是说开放平台
   埋点链路虽有单测与探针覆盖，**尚未被真实流量压过**；后续上线后应回头复核 AaaS 轨迹的
   字段长度分布是否触到 `SUMMARY_MAX = 500`。
