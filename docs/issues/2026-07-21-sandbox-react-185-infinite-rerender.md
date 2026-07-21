# Sandbox 页面 React error #185（无限重渲染）

- **日期**：2026-07-21
- **影响页面**：`/sandbox`（`SandboxPage` → `BrowserUsePanel`）
- **严重度**：P0（沙箱页面整页崩溃，终端/浏览器视图不可用）
- **状态**：已修复

## 1. 用户现象

打开 `http://127.0.0.1:5173/sandbox`，控制台抛出 Minified React error #185，页面渲染卡死/白屏。浏览器控制台堆栈顶部为：

```
Uncaught Error: Minified React error #185
    at getRootForUpdatedFiber (react-dom_client.js:2117)
    at enqueueConcurrentRenderForLane (react-dom_client.js:2105)
    at forceStoreRerender (react-dom_client.js:3833)
    at updateStoreInstance (react-dom_client.js:3815)
    at commitHookEffectListMount (react-dom_client.js:6492)
    ...
```

## 2. 问题描述

React #185 = "Maximum update depth exceeded"。堆栈中 `forceStoreRerender → updateStoreInstance → commitHookEffectListMount` 是 `useSyncExternalStore` 的被动 effect 检测到"快照已变化"后强制重渲染的路径。某个组件的 store selector 在连续两次 `getSnapshot` 调用中返回了**不同引用**，React 判定 store 变化 → 触发重渲染 → 再次 getSnapshot → 又返回新引用 → 无限循环，最终命中更新深度上限抛出 #185。

## 3. 根因

`web/src/components/sandbox/BrowserUsePanel.tsx:21` 的 Zustand selector：

```ts
const steps = useSandboxStore((s) => s.agentSteps[sessionId] ?? []);
```

- store 初始 `agentSteps: {}`（见 `web/src/stores/sandbox.ts:54`），因此任意 `sessionId` 在 Agent 未运行时对应值均为 `undefined`。
- `?? []` 的 fallback `[]` 是一个**数组字面量**：每次 selector 被调用时都会新建一个数组对象，引用每次都不同。
- Zustand v5 基于 `useSyncExternalStore`，用 `Object.is` 比较前后快照。新 `[]` ≠ 旧 `[]` → 判定变化 → `forceStoreRerender` → 无限循环 → #185。

外部依据：
- React #185：https://react.dev/errors/185
- React 文档明确要求 useSyncExternalStore 的 getSnapshot 返回值必须被缓存（稳定引用），否则会触发无限重渲染：https://react.dev/reference/react/useSyncExternalStore#caveats

## 4. 复现路径

1. `cd ~/deepthink/web && npm run dev`，启动前端（默认 5173）。
2. 浏览器打开 `http://127.0.0.1:5173/sandbox`。
3. 在工具栏勾选"启动浏览器" → 新建沙箱（使 `activeSession.browserEnabled=true`，从而渲染 `BrowserUsePanel`）。
   - 此时该会话尚未运行 Browser Use Agent，`agentSteps[sessionId] === undefined`。
4. 控制台立即抛出 React error #185，页面卡死。

> 不勾选浏览器时 `BrowserUsePanel` 不渲染，故不会触发——这也是为何该 bug 仅在"启用浏览器的沙箱"场景下复现。

## 5. 诊断方法

纯逻辑回归测试直接锁定根因（`tests/sandbox-steps-selector-stability.test.ts`）：

```bash
cd ~/deepthink
npx vitest run tests/sandbox-steps-selector-stability.test.ts
```

其中"错误 selector"用例断言：连续两次调用 `(s) => s.agentSteps['sb-x'] ?? []` 返回的引用**不相等**（`expect(a).not.toBe(b)`），即复现 #185 的快照抖动；"正确 selector"用例断言稳定 fallback 返回**同一引用**。

也可在线上直接验证：浏览器控制台执行
```js
const s = window.__sandboxStore?.getState?.() ?? null; // 如有暴露
```
或直接观察 React DevTools 中 `BrowserUsePanel` 在未运行 Agent 时持续重渲染。

## 6. 修复方案

将不稳定 fallback `[]` 替换为模块级稳定常量 `EMPTY_STEPS`，使 `getSnapshot` 在 `agentSteps[sessionId]` 未定义时始终返回同一引用，消除 `Object.is` 判定的"假变化"。

```diff
 interface Props {
   sessionId: string;
 }

+// 稳定空数组引用：避免在 selector 中每次返回新的 [] 导致 useSyncExternalStore
+// 判定快照变化而触发无限重渲染（React error #185）。
+const EMPTY_STEPS: never[] = [];

 export function BrowserUsePanel({ sessionId }: Props) {
-  const steps = useSandboxStore((s) => s.agentSteps[sessionId] ?? []);
+  const steps = useSandboxStore((s) => s.agentSteps[sessionId] ?? EMPTY_STEPS);
```

**选型理由**：
- 仅改 1 行 + 1 个常量，最小改动（Surgical Changes）。
- 不引入 `useShallow`/`shallow` 等额外依赖——`steps` 就是一个数组引用，用稳定常量 fallback 即可，无需浅比较。
- 同仓库内扫描确认其它 sandbox selector 均返回基本类型或 store 内稳定引用（如 `s.sessions`、`s.subscribedSessions.has(...)` 布尔），无同类 `?? []` / `?? {}` 隐患。

## 7. 处理卡住的状态（如适用）

不涉及。崩溃发生在前端运行态，刷新页面并在 Agent 运行前不会再触发（因为 Agent 运行后 `agentSteps[sessionId]` 有值，`??` 不走 fallback）。但只要会话处于"已启用浏览器、Agent 未运行"的默认态，刷新即复现——必须靠本修复根除。

## 8. 经验沉淀 / 预防

**规则**：在 Zustand（及任何基于 useSyncExternalStore 的状态库）的 selector 中，**禁止用 `?? []` / `?? {}` / `?? new X()` 等返回新引用的表达式作为 fallback**。fallback 必须是模块级稳定常量。

**巡检脚本**（列出所有可疑 selector）：

```bash
cd ~/deepthink
grep -rn "useSandboxStore\|use[A-Z]\w*Store" web/src \
  --include="*.tsx" --include="*.ts" \
  | grep -E "\?\? (\[\]|\{\}|new )"
# 期望输出为空；若有命中则需替换为稳定常量。
```

**Lint 建议**：可后续在 ESLint 自定义规则或 code review checklist 中加入：selector 返回值不得为字面量集合类型 fallback。短期内靠巡检脚本兜底。

**回归测试**：`tests/sandbox-steps-selector-stability.test.ts` 常驻 CI，锁定"未定义 per-session 键 + 稳定 fallback"不变量，防止回退。
