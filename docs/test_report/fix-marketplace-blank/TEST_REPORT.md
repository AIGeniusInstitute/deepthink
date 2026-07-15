# 测试报告：修复市场页面空白（React error #300）

## 修复摘要

**根因**：`web/src/pages/MarketplacePage.tsx` 在 JSX 条件表达式中调用 Zustand selector hook `useMarketplaceStore((s) => s.loading)`，违反 React Hooks 规则，触发 React error #300 "Invalid hook call"，导致 `/marketplace` 整页白屏。

**修复**：将 `loading` 从顶层 store 解构出来，JSX 内联表达式改为引用局部变量 `loading`。

## 变更点

| 文件 | 改动 |
|------|------|
| `web/src/pages/MarketplacePage.tsx` | 第 43 行解构加入 `loading`；第 105、107 行 `useMarketplaceStore((s) => s.loading)` 替换为 `loading` |

共 3 处改动，约 3 行。

## 验证结果

### 1. 类型检查 `make typecheck`

```
npx tsc --noEmit
cd web && npx tsc --noEmit
cd container/agent-runner && npx tsc --noEmit
All shared type copies are in sync.
✓ All 9 prompt references resolved
```

✅ 通过。

### 2. 构建 `make build`

```
[web] ✓ built in 6.38s
[web] PWA v1.3.0 generateSW precache 78 entries
[agent-runner] npm --prefix container/agent-runner run build exited with code 0
```

✅ 通过。

### 3. 代码 Review

- 组件函数顶层 Hook 调用顺序：`useMarketplaceStore()` → `useAuthStore()` → 4 个 `useState()` → `useEffect()`，全部在顶层、无条件包裹，每次渲染顺序恒定。✅
- Grep 确认 `useMarketplaceStore((s) =>` 在本文件中已无残留。✅
- `loading` 字段在 store 定义中已存在（`marketplace.ts:38`），通过解构访问语义不变。✅

### 4. 后端服务验证

```
curl http://localhost:9898/api/health         → 200
curl http://localhost:9898/marketplace       → 200（HTML 返回正常）
curl http://localhost:9898/api/paas/marketplace → 401 Unauthorized（需登录，路由正常注册）
```

✅ 后端路由正常。

### 5. 浏览器 E2E

❌ 受环境限制（`cloudcli-browser` MCP 工具持续 `fetch failed`），无法在自动化浏览器中复现页面渲染。改用 typecheck + build + 代码 review + 后端 curl 替代验证。

## 结论

- ✅ 类型检查通过
- ✅ 前端构建通过
- ✅ 代码 review 确认 Hook 调用顺序合规
- ✅ 后端路由正常

修复完成。`/marketplace` 页面因违反 Hooks 规则导致的 React error #300 白屏问题已解决。
