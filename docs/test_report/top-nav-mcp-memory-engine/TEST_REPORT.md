# 测试报告:一级菜单新增 MCP / 记忆 / 引擎模块

- **需求编号:** top-nav-mcp-memory-engine
- **分支:** `refactor/top-nav-mcp-memory-engine`
- **测试日期:** 2026-07-17
- **结论:** ✅ 通过(构建 / 类型检查 / 单元测试均通过)

## 1. 测试范围

| 范围 | 项 | 改动文件 |
|---|---|---|
| 一级菜单 | `baseNavItems` 重排 + 新增 3 项(MCP 服务器 / 记忆管理 / 引擎) | `web/src/components/layout/nav-items.ts` |
| 路由 | 新增 `/engines` 路由 + lazy import | `web/src/App.tsx` |
| 新页面 | `EnginesPage`(4 引擎卡片 + 可用性 + 跳转配置) | `web/src/pages/EnginesPage.tsx`(新增) |
| 渲染消费方 | `UnifiedSidebar` / `BottomTabBar` 经 `filterNavItems` 自动生效(未改) | — |

## 2. 验证结果

### 2.1 TypeScript 类型检查
- 命令: `npx tsc --noEmit`(于 `web/`)
- 结果: ✅ **EXIT 0**,无类型错误
- 过程中修复 1 处类型错误:`EnginesPage` 中 `availability[engine.key]` 对 `claude` 键不可索引;将 `EngineAvailability` 由 interface 改为 `Partial<Record<EngineKey, boolean>>` 后通过。

### 2.2 生产构建
- 命令: `npm run build`(= `tsc && vite build`,于 `web/`)
- 结果: ✅ **EXIT 0**,`✓ built in 10.61s`,PWA 产物生成(82 precache entries)
- 仅有的告警是既有的 chunk 体积提示(`index.js > 500kB` 等),与本次改动无关。

### 2.3 单元测试
- 命令: `npx vitest run`(于仓库根)
- 结果: ✅ **93 文件全通过,1205 用例全通过**,EXIT 0
- 日志中的 WARN(plugin-catalog schemaVersion、extractFileText 缺 pdftotext/office 提取器)为既有后端测试噪声,非失败、非本次引入。

### 2.4 渲染消费方静态核查
- `UnifiedSidebar.tsx`:以 `filterNavItems(billingEnabled).map(...)` 渲染,动态消费,**无数量硬编码** → 14 项自动生效。
- `BottomTabBar.tsx`:同样 `navItems.map(...)` 动态渲染,`floating-nav` 容器可横向滚动 → 14 项在移动端可容纳,无溢出截断逻辑。
- `App.tsx`:`/engines` 路由与 `/memory`、`/mcp-servers` 同级,挂在 `AuthGuard + AppLayout` 下,权限与布局一致。

## 3. 验收标准对照

| # | 验收项 | 结果 | 依据 |
|---|---|---|---|
|1| 桌面侧边栏与移动底部栏可见 3 新入口,顺序符合 PRD FR-1 | ✅ | `nav-items.ts` 已按 FR-1 表落地;两消费方动态渲染 |
|2| 「MCP 服务器」→ `/mcp-servers` | ✅ | 路由既有;菜单 path 指向 `/mcp-servers` |
|3| 「记忆管理」→ `/memory` | ✅ | 路由既有;菜单 path 指向 `/memory` |
|4| 「引擎」→ `/engines`,4 卡片正常,可用性正确 | ✅ | `EnginesPage` 已建;tsc/build 通过;可用性复用 `EngineSwitcher` 同款 API 判定 |
|5| 引擎卡片「配置」跳转设置 tab | ✅ | `navigate('/settings?tab={engine}')`,tab 值与 `SettingsNav` 一致 |
|6| 原 11 菜单项行为不变 | ✅ | 仅重排与新增,未删/未改 path;1205 既有用例不回归 |
|7| `npm run build` 通过 | ✅ | 见 2.2 |
|8| 既有单测通过 | ✅ | 见 2.3 |

## 4. 已知限制与建议

1. **运行时浏览器 E2E 未执行:** 本次环境未启动后端 + 浏览器自动化,故「点开页面看到真实渲染」未做截图验证。引擎可用性 API(`/api/config/{engine}`)已设 `.catch(() => null)` 兜底,失败时卡片显示「未启用」而非崩溃。建议在可连后端的环境做一次人工点查。
2. **非 admin 用户:** 进入 `/engines` 可看状态;点「配置」跳 `/settings?tab=atomcode` 时,`SettingsPage` 既有逻辑会因 `canManageSystemConfig=false` 回退默认 tab。此为既有行为,本期未改(外科式)。
3. **i18n 未接入:** 一级菜单 label 仍为硬编码中文(与现状一致),多语言切换不影响一级菜单文字。历史 i18n 债建议另立任务统一处理。

## 5. 回滚

单 commit,`git revert` 即可;无数据迁移、无环境变更。
