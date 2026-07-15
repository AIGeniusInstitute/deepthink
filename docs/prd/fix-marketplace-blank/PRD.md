# PRD：修复市场页面空白（React error #300）

## 背景

DeepThink Web UI 的 `/marketplace` 页面访问时整页空白，浏览器控制台报错：

```
Uncaught Error: Minified React error #300
  at j4 (index-DjV3pjHH.js:49:48923)
  at Hg (index-DjV3pjHH.js:49:48812)
  ...
```

React error #300 官方解释为 "Invalid hook call. Hooks can only be called inside the function body of a function component." 即在非顶层位置（条件分支、嵌套表达式）调用了 Hook，导致渲染阶段 Hook 调用顺序不一致。

## 问题定位

文件：`web/src/pages/MarketplacePage.tsx`

组件 `MarketplacePage` 在 JSX 渲染中，把 `useMarketplaceStore((s) => s.loading)` 作为短路条件写在表达式里：

- 第 105 行：`{useMarketplaceStore((s) => s.loading) && <div>...</div>}`
- 第 107 行：`{filtered.length === 0 && !useMarketplaceStore((s) => s.loading) && (...)}`

Zustand 的 `useStore(selector)` 在内部使用 `useSyncExternalStore`（React Hook）。在条件分支里调用 Hook，违反"Hook 必须在组件函数顶层无条件调用"的规则，触发 React error #300，整页抛出后白屏。

## 用户期望

- 访问 `/marketplace` 能正常渲染市场列表，不再白屏。
- 加载中、空列表、列表渲染三种状态的行为与原设计一致。
- 不影响其它页面、不改动 store 接口、不改变业务逻辑。

## 验收标准

1. `make typecheck` 通过。
2. `make build` 通过。
3. 本地启动后端后，浏览器访问 `http://localhost:9898/marketplace`，页面正常渲染（登录态、未登录态均可进入，不抛 React error #300）。
4. 控制台无 `Uncaught Error: Minified React error #300`。

## 非目标

- 不重构 MarketplacePage 的其它部分（只修违规 Hook 调用）。
- 不调整 store 接口。
- 不处理市场业务逻辑相关的其它 BUG。
