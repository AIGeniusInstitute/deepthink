# 切一次页签后「上传目录」静默失效：`webkitdirectory` 只挂在首次挂载的节点上

- 日期：2026-10-16
- 影响范围：知识库「上传目录」入口（P2 新增）
- 严重级别：中（功能静默失效，不报错、不提示，用户只会觉得"点了没反应"）
- 引入时间：P2 开发期间，由 P2 自己的 e2e（`tests/e2e/kb-p2-ingest.mjs`）在验收阶段抓出

---

## 1. 用户现象

在知识库详情页，**先去「检索测试台」看一眼，再切回「文档」页签**，然后点「上传目录」：

- 弹出的不再是「选择文件夹」对话框，而是普通的**多选文件**对话框
- 选了文件夹里的文件之后，上传列表里文件名没有目录段（相对路径全丢）
- 更常见的表现是：用户按提示去选目录，对话框里根本选不中目录，只好放弃，
  得出"上传目录坏了"的结论

全过程**没有任何报错**，控制台干净，请求也不发。

## 2. 问题描述

`webkitdirectory` 是非标准 DOM 属性，React 的 JSX 不认它（写在 `<input>` 上会被忽略），
所以 `KnowledgeBaseDetailPage.tsx` 用它把普通文件框改造成"选目录"框时，只能挂载后
手动 `setAttribute`。

最初的写法是：

```tsx
useEffect(() => {
  if (dirInputRef.current) dirInputRef.current.setAttribute('webkitdirectory', '');
}, []);          // ← 空依赖，只在组件首次挂载时跑一次
```

而文档页签的内容是**条件渲染**的：

```tsx
{tab === 'documents' && ( ... 这里含那个 input ... )}
```

切到「检索测试台」时整个面板（连同这个 `<input>`）被卸载；切回来时 React 创建一个
**新的 DOM 节点**并重新挂载。但页面组件本身没有卸载过，`[]` 依赖的 effect 不会再跑 ——
新节点上没有 `webkitdirectory`，于是它退化成一个普通的多选文件框。

## 3. 根因

**代码层面**：把"给 DOM 节点打补丁"这件事绑在了**组件**的生命周期上，而真正需要
重新打补丁的时机是**DOM 节点**的生命周期。

`useEffect(fn, [])` 的语义是"这个组件挂载时跑一次"，它不追踪 `ref.current` 指向的
节点是否换过。对于**始终挂载**的节点这没问题；对于会被条件渲染反复卸载/重挂的节点，
两者就不再等价 —— 这正是本缺陷。

**为什么测试没拦住**：`collectFromInput()` / `isHiddenPath()` 这些纯函数有好覆盖
（e2e 的目录上传就是走它们），但它们**都不碰挂载** —— "属性还在不在"这件事，
纯函数层面根本看不见。而 e2e 最初把「上传目录」写成了一条"点一下、看框弹没弹"的
独立探针，那条探针**恰恰跑在首次挂载后的第一屏**，那时属性还在，所以是绿的。
真正暴露它的是后来把目录上传挪到"从检索测试台切回来之后"执行的那次重排。

**外部依据**：
- [MDN — `HTMLInputElement.webkitdirectory`](https://developer.mozilla.org/en-US/docs/Web/API/HTMLInputElement/webkitdirectory)
  （非标准，仅能通过属性设置）
- [React — Refs and the DOM: Callback refs](https://react.dev/reference/react-dom/components/common#ref-callback)
  （节点挂载/卸载时回调会被调用）

## 4. 复现路径

1. 打开实例，登录，进入任意**文档库**
2. 停在「文档」页签 —— 此时点「上传目录」，弹的是**选择文件夹**
3. 切到「检索测试台」，再切回「文档」
4. 再点「上传目录」→ 弹的是**普通多选文件框**（缺陷）

命令行验属性是否还在（步骤 3 之后执行）：

```js
document.querySelector('[data-testid="kb-upload-dir-input"]').hasAttribute('webkitdirectory')
// 期望 true，缺陷态为 false
```

## 5. 诊断方法

```bash
# 1. e2e 里已经固化成一条断言（切页签回来后属性仍在），单独跑它：
cd ~/deepthink/.claude/worktrees/feat-kb-full-replica-p2
DT_BASE=http://127.0.0.1:9922 node tests/e2e/kb-p2-ingest.mjs 2>&1 \
  | grep -E "webkitdirectory|上传目录"

# 2. 手工验（浏览器 DevTools，在「切走再切回」之后执行）：
#      document.querySelector('[data-testid="kb-upload-dir-input"]')
#              .hasAttribute('webkitdirectory')      // 缺陷态 false
#    再点一次「上传目录」，看弹的是文件夹选择框还是多选文件框

# 3. 静态自查：还有没有别处"给非标准属性只在首次挂载打补丁"
grep -rn "setAttribute" web/src/ | grep -v "data-\|aria-"
#    本次查过，其余都是 data-*/aria-*，无同类问题
```

## 6. 修复方案

把补丁从 effect 挪到 **ref 回调**上 —— ref 回调在每次节点挂载时都会执行，
卸载时以 `null` 调用：

```diff
-  useEffect(() => {
-    if (dirInputRef.current) dirInputRef.current.setAttribute('webkitdirectory', '');
-  }, []);
+  const attachDirInput = useCallback((el: HTMLInputElement | null) => {
+    dirInputRef.current = el;
+    if (el) el.setAttribute('webkitdirectory', '');
+  }, []);
...
-                  <input ref={dirInputRef} type="file" ...
+                  <input ref={attachDirInput} type="file" ...
```

**选型理由**：也可以把 `tab` 加进 effect 的依赖数组，但那只对"页签切换"这一种
卸载原因有效；而这个 input 将来还可能因为权限变化、库类型变化等原因被条件渲染掉。
ref 回调表达的是真正的约束——**"这个节点存在期间必须有这个属性"**——与卸载原因无关。
`dirInputRef` 本身保留，因为点击处理函数仍要读它。

## 7. 处理卡住的状态

无卡住态：功能失效时不发请求、不留脏数据，用户重试即可。修复后无需任何数据迁移。

## 8. 经验沉淀 / 预防

### 8.1 这类缺陷的通用特征

**给非标准 DOM 属性 / 第三方 DOM 补丁时，用 component 生命周期代替 node 生命周期。**
`useEffect(..., [])` 与"节点存在期间总是有该属性"这两句话，只在节点永不卸载时才等价。
同类风险：给 `<canvas>` 设尺寸、给 `<video>` 设属性、给第三方图表库的容器挂实例。

判别式：**问一句"这个节点会不会被卸载重挂？"** —— 只要它出现在任何条件渲染
（`{cond && ...}`、页签、模态、虚拟列表）里，答案就是会，`useEffect([])` 就不够。

### 8.2 预防手段

1. **e2e 的用例顺序要"脏"**：先切走再切回、先建后删，别让每个用例都跑在
   "刚进页面"的干净初始态上。本缺陷就是被一次无意的重排抓出来的 ——
   这条顺序现在已经固定写在 `tests/e2e/kb-p2-ingest.mjs` 的 AC-6 段落里，
   并在断言里直接检查属性存在（`hasAttribute('webkitdirectory')`），
   而不是只依赖 Playwright 抛的那个看不懂的 `File input does not support directories`。
2. **Playwright 的报错不等于根因**：`setFiles` 对非目录 input 会抛
   `File input does not support directories` —— 这句话描述的是**症状**。
   显式加一条 `hasAttribute` 断言，报错时才指得到属性本身。
3. **同类写法全仓自查**：`grep -rn "setAttribute" web/src/` 看还有没有别的
   "只在首次挂载打补丁"的地方（本次查过，其余都是 `data-*`，无同类问题）。
