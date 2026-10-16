# 知识库「上传文档」点了没反应：label 不转发交互内容后代的点击

- 日期：2026-10-16
- 分支：`worktree-feat-kb-full-replica`
- 影响范围：`web/src/pages/KnowledgeBaseDetailPage.tsx:275-290`（文档页签上传工具条）
- 状态：已修复
- 引入提交：`dd8dc01`（知识库子系统首次落地，**非本轮 P1 引入**）

## 1. 用户现象

进入任一知识库详情页 →「文档」页签 → 点右上角**「上传文档」按钮，没有任何反应**：
不弹文件选择框、不报错、控制台无异常、按钮也没有 loading。整个知识库**无法通过界面上传任何文档**。

补充「URL 抓取」和「重建索引」两个按钮是好的，只有「上传文档」不动。

## 2. 问题描述

「上传文档」按钮是一个 `<button>`，被包在 `<label>` 里，而同一个 `<label>` 里还放着
真正的隐藏 `<input type="file">`：

```tsx
<label className="cursor-pointer">
  <input type="file" data-testid="kb-upload-input" accept="…" className="hidden" onChange={…} />
  <Button size="sm" data-testid="kb-upload-button">
    <Upload className="size-4 mr-1" /> 上传文档
  </Button>
</label>
```

这是"点标签转发给控件"的常见写法，但**对 `<button>` 不成立**：

> HTML 规范（`label` 的 activation behavior）：
> *The activation behavior of a `label` element for events targeted at **interactive content
> descendants** of a `label` element, and any descendants of those interactive content
> descendants, must be **to do nothing**.*

`<button>` 正是 interactive content。于是点击落在 `<button>` 上时，`<label>` 的转发被规范
**主动禁止**，`<input type="file">` 永远收不到这次点击；而 `<Button>` 自身没有 `onClick`，
所以整条链路到此为止 —— 既没有文件框，也没有任何反馈。

（同一个 `<label>` 内，labelable 元素按文档序是 `INPUT[file] → BUTTON[submit]`，
所以 `<label>` 的"被标注控件"确实是那个 file input；只是转发被 interactive-content 规则拦住了。）

## 3. 根因

**用 `<label>` 包裹 `<button>` 来触发文件选择，是规范明确禁止的组合。**

实测证据（探针脚本 `tests/e2e/_probe-upload.mjs`，真实 Chrome，只观测不做事）：

```
按钮可见: true
按钮 tag/类型: BUTTON / group/button inline-flex shrink-0 items-center justify-cente
按钮的祖先 label: label 内 labelable 元素顺序: INPUT[file] → BUTTON[submit]
filechooser 事件: ❌ 没触发
页面内计数: {"inputClicks":0,"btnClicks":1}      ← 按钮收到了点击，input 一次都没收到
直接点 input 后 filechooser: ✅ 触发过           ← input 本身是好的
```

`btnClicks: 1` 而 `inputClicks: 0`：点击确实到达了按钮，但 `<label>` **没有**把点击转发给 input。
最后一行是对照 —— 直接 `.click()` 那个隐藏 input，`filechooser` 立刻触发，证明问题在转发这一跳，
不在 input、不在 onChange、不在后端。

**这是一处"孤例写法"**：全仓库 6 个 `<input type="file">`，另外 5 个
（`ProfileSection.tsx:410/470`、`MessageInput.tsx:970/978`、`FileUploadZone.tsx:75/83`、
`BugReportDialog.tsx:373`、`UploadSkillDialog.tsx:95`）**全部**用

```tsx
<input ref={inputRef} type="file" className="hidden" onChange={…} />
<Button onClick={() => inputRef.current?.click()}>…</Button>
```

只有知识库这一处改用了 `<label>` 包裹 —— 而它恰好是唯一坏的那个。

## 4. 复现路径

1. 任意知识库详情页 →「文档」页签。
2. 点右上角「上传文档」。
3. 观察：**无文件选择框弹出、无 toast、无控制台报错**。（期望：弹出文件选择框。）

想 10 秒内确认不是浏览器缓存/构建问题：打开 DevTools，在页面里执行

```js
document.querySelector('[data-testid="kb-upload-button"]').closest('label') !== null
// → true，就是本文这个原因
```

## 5. 诊断方法

```bash
# ① 一键探针：看 filechooser 到底有没有触发（不做事，安全）
cd <repo> && DT_BASE=http://127.0.0.1:9999 DT_USER=admin DT_PASS='******' \
  node tests/e2e/_probe-upload.mjs

# ② 结构性判据：按钮的祖先里有没有 label
grep -n 'kb-upload-button' -B12 web/src/pages/KnowledgeBaseDetailPage.tsx | grep -n 'label'

# ③ 旁证：全仓库 file input 的触发方式，看这处是不是孤例
grep -rn 'type="file"' -A2 web/src | grep -c 'ref='
grep -rn 'inputRef.current?.click()\|ref.current?.click()' web/src
```

判据链条：①`inputClicks: 0` 且直接点 input 能触发 → ②按钮被 `<label>` 包着 →
③另外 5 处都不是这么写的 → 根因锁定。

## 6. 修复方案

改成与仓库其余 5 处**同一写法**（ref + 显式 `onClick`），不再依赖 `<label>` 的隐式转发：

```diff
--- a/web/src/pages/KnowledgeBaseDetailPage.tsx
+++ b/web/src/pages/KnowledgeBaseDetailPage.tsx
@@ 上传工具条
-                <label className="cursor-pointer">
-                  <input
-                    type="file"
-                    data-testid="kb-upload-input"
-                    accept=".md,.markdown,.txt,.pdf,.docx,.html,.htm,.csv,.tsv,.json"
-                    className="hidden"
-                    onChange={(e) => {
-                      const f = e.target.files?.[0];
-                      if (f) void handleUpload(f);
-                      e.target.value = '';
-                    }}
-                  />
-                  <Button size="sm" data-testid="kb-upload-button">
+                <div>
+                  <input
+                    ref={fileInputRef}
+                    type="file"
+                    data-testid="kb-upload-input"
+                    accept=".md,.markdown,.txt,.pdf,.docx,.html,.htm,.csv,.tsv,.json"
+                    className="hidden"
+                    onChange={(e) => {
+                      const f = e.target.files?.[0];
+                      if (f) void handleUpload(f);
+                      e.target.value = '';
+                    }}
+                  />
+                  <Button
+                    size="sm"
+                    data-testid="kb-upload-button"
+                    onClick={() => fileInputRef.current?.click()}
+                  >
                     <Upload className="size-4 mr-1" /> 上传文档
                   </Button>
-                </label>
+                </div>
```

外加 `const fileInputRef = useRef<HTMLInputElement>(null);`。

选型理由：

- **跟着仓库已有的 5 处写法走**，而不是"把 `<label>` 修得能转发"（比如给 `<Button>` 换成
  `<span>` 加 role）——显式 `ref.current?.click()` 不依赖规范细节、不挑内层元素类型、
  键盘可达性由 `<button>` 自己保证，且与全仓库一致。
- **`<Button>` 不带 `type="button"`** 是既存写法（其余 5 处也没带）。本次不顺手加 ——
  它不在本 bug 的因果链上（点击压根没走下去），改它属于"动了没坏的地方"。若以后这些按钮
  被放进 `<form>`，会退化成提交按钮，届时统一加。
- 保留 `data-testid="kb-upload-input"`：验收脚本还要用它做直接赋值（见 §8 的取舍）。

验证（真实 Chrome，走**真按钮**而不是直接塞文件）：

```
点击「上传文档」→ filechooser 事件 ✅ 触发
选文件 → toast「已上传，正在后台解析与分块」→ 文档列表出现该文档
```

验收脚本已改为用 `page.waitForEvent('filechooser')` + `fileChooser.setFiles(...)`
走真实入口，见 `tests/e2e/kb-p1-ui.mjs`。

## 7. 处理卡住的状态

不适用。

## 8. 经验沉淀 / 预防

- **`<label>` 只对"非交互内容"的后代转发点击。** 里面只要有一个 `<button>`、`<a>`、`<input>`
  之类的 interactive content，规范就要求 `<label>` **什么都不做**。这条规则的目标是避免
  "点一下触发两个控件"，但副作用是它把"label 包裹 button"这个看似顺手的写法变成了哑弹 ——
  而且**完全不报错**。
  触发文件选择一律用 `ref.current?.click()`。
- **这是一处孤例写法。** 全仓库 6 个 file input，5 个用 ref，只有这 1 个用 `<label>` ——
  而它恰好坏了。"和周围代码写得不一样"本身就是值得停下来看一眼的信号，
  尤其是当周围那 5 处都长得一模一样时。
- ⚠️ **本轮 17 项 UI 验收全绿，但没抓到这个 bug —— 这是验收方法本身的漏洞。**
  Playwright 的 `setInputFiles()` 是**直接给 input 赋值**，绕过了"用户点击按钮"这一跳；
  于是"按钮点不动"这个最直白的失败，恰好落在所有断言之外。已改为
  `waitForEvent('filechooser')` + `fileChooser.setFiles()`，让脚本必须**经过真实点击**
  才能拿到文件句柄 —— 修好前它会超时失败。
  **教训**：端到端脚本里凡是"设置 input 的值"的便捷 API，都要问一句
  「真实用户是怎么走到这一步的」。绕过的每一跳，都是缺陷的藏身处。
- 本 bug 引入于 `dd8dc01`（知识库首次落地），**在本轮 P1 之前就存在**，期间多轮单测、
  上一轮 UI 探路脚本都没碰到它 —— 因为都没有"点按钮上传"这一跳。
