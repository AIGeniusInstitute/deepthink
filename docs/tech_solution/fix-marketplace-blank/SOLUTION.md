# 技术方案：修复市场页面空白（React error #300）

## 根因分析

`web/src/pages/MarketplacePage.tsx` 中 `MarketplacePage` 组件在 JSX 内联表达式中调用了 Zustand selector hook：

```tsx
// 第 105 行
{useMarketplaceStore((s) => s.loading) && <div className="...">加载中…</div>}

// 第 107 行
{filtered.length === 0 && !useMarketplaceStore((s) => s.loading) && (
  <div className="...">市场暂无内容。</div>
)}
```

Zustand 的 `useStore(selector)` 底层是 `useSyncExternalStore`，属于 React Hook。Hook 必须在组件函数顶层（无 if / && / 嵌套条件包裹）调用，每次渲染调用顺序、数量恒定。当前代码把 Hook 调用塞进短路表达式，第一次渲染时若 `filtered.length > 0`，React 调度到第二个表达式时短路返回，Hook 调用数少于前一次 → React error #300。

## 修复方案

把 `loading` 字段从顶层 store 解构出来，与已有的 `list / load / install` 同列：

```tsx
const { list, load, install, loading } = useMarketplaceStore();
```

随后 JSX 中的 `useMarketplaceStore((s) => s.loading)` 全部替换为局部变量 `loading`：

```tsx
{loading && <div className="...">加载中…</div>}
{filtered.length === 0 && !loading && (...)}
```

这样所有 Hook 调用都集中在组件函数顶部，数量与顺序恒定，不再违反 Hooks 规则。

## 变更范围

- 仅修改 `web/src/pages/MarketplacePage.tsx`
- 改动行数：~3 行（1 处解构 + 2 处替换）
- 不改 store 接口、不改其他组件

## 兼容性

- 行为完全等价：`loading` 字段已存在于 store（`marketplace.ts` 第 38 行），原本通过 selector 访问，改为通过解构访问，语义不变。
- 不影响 SSR / PWA / 已有交互逻辑。

## 验证步骤

1. `make typecheck` 通过。
2. `make build` 通过。
3. 启动后端 `make dev-backend`，浏览器访问 `/marketplace`，页面正常渲染、控制台无 error #300。
4. 走查加载态、空列表态、有数据态三种情况。
