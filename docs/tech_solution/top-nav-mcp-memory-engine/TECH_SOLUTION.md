# 技术方案:一级菜单新增 MCP 服务器 / 记忆管理 / 引擎模块

- **需求编号:** top-nav-mcp-memory-engine
- **创建日期:** 2026-07-17
- **技术栈:** React 19 + react-router-dom 7 + zustand 5 + Vite 6 + Tailwind 4 + shadcn/radix + lucide-react
- **置信度:** 高

## 1. 现状关键事实(来自探查)

| 关注点 | 现状 |
|---|---|
| 一级菜单定义 | `web/src/components/layout/nav-items.ts` 的 `baseNavItems`,11 项,硬编码中文 |
| 菜单消费方 | `UnifiedSidebar.tsx`(桌面)+ `BottomTabBar.tsx`(移动),均经 `filterNavItems(billingEnabled)` 取列表 |
| MCP 顶级页 | 已有 `McpServersPage` + 路由 `/mcp-servers`,**未进菜单** |
| 记忆顶级页 | 已有 `MemoryPage` + 路由 `/memory`,**未进菜单** |
| 引擎配置 | 仅设置页 tab `atomcode/codex/opencode/claude` + 聊天页 `EngineSwitcher`;**无顶级聚合页** |
| 设置 tab 跳转 | `/settings?tab={SettingsTab}`,SYSTEM_TABS 需 `canManageSystemConfig`(admin),否则回退默认 tab |
| 引擎可用性 API | `GET /api/config/atomcode|codex|opencode` → `{ enabled?: boolean }`(已验证于 `EngineSwitcher`) |

## 2. 方案设计

### 2.1 改动文件清单(外科式)

| 文件 | 改动类型 | 说明 |
|---|---|---|
| `web/src/components/layout/nav-items.ts` | 修改 | 重排+新增 3 项 |
| `web/src/App.tsx` | 修改 | 新增 `EnginesPage` lazy import + `/engines` 路由 |
| `web/src/pages/EnginesPage.tsx` | 新增 | 引擎聚合页 |
| `docs/...` | 新增 | PRD/技术方案/状态/测试报告 |

不改 `UnifiedSidebar` / `BottomTabBar` / `AppLayout` —— 它们经 `filterNavItems` 自动拿到新项。

### 2.2 nav-items.ts

```ts
import {
  MessageCircle, Clock4, Puzzle, Wallet, User, Repeat, GitBranch,
  Bot, BookOpen, ShoppingBag, Boxes, Server, BrainCircuit, Cpu,
} from 'lucide-react';

export const baseNavItems = [
  { path: '/chat', icon: MessageCircle, label: '工作台' },
  { path: '/agents', icon: Bot, label: 'Agent' },
  { path: '/skills', icon: Puzzle, label: 'Skill' },
  { path: '/knowledge-bases', icon: BookOpen, label: '知识库' },
  { path: '/marketplace', icon: ShoppingBag, label: '市场' },
  { path: '/mcp-servers', icon: Server, label: 'MCP 服务器' },
  { path: '/memory', icon: BrainCircuit, label: '记忆管理' },
  { path: '/engines', icon: Cpu, label: '引擎' },
  { path: '/sandbox', icon: Boxes, label: '沙箱' },
  { path: '/tasks', icon: Clock4, label: '任务' },
  { path: '/loops', icon: Repeat, label: '循环' },
  { path: '/harness', icon: GitBranch, label: 'Harness' },
  { path: '/billing', icon: Wallet, label: '账单', requiresBilling: true },
  { path: '/settings', icon: User, label: '设置' },
];
```

### 2.3 App.tsx 路由

在 lazy 块新增:
```ts
const EnginesPage = lazy(() => import('./pages/EnginesPage').then(m => ({ default: m.EnginesPage })));
```
在 AppLayout 子路由区(与 `/memory`、`/mcp-servers` 同级)新增:
```tsx
<Route path="/engines" element={<Suspense fallback={null}><EnginesPage /></Suspense>} />
```

### 2.4 EnginesPage.tsx(聚合页)

**设计要点(简单优先):**
- 复用 `PageHeader`(`@/components/common/PageHeader`)与 `Card`/`CardContent`(`@/components/ui/card`),风格与 `McpServersPage` 一致。
- 引擎静态数组 `ENGINES`:4 项,每项含 `key/label/description/settingsTab`。
- 可用性:`useEffect` 并发 `api.get('/api/config/{atomcode|codex|opencode}')`,Claude 默认可用。
- 卡片「配置」:`useNavigate()` → `/settings?tab={settingsTab}`。
- 无 group 上下文 → 不做默认引擎切换(留给聊天页 `EngineSwitcher`)。

**组件骨架:**
```tsx
const ENGINES = [
  { key: 'claude',    label: 'Claude Code', settingsTab: 'claude',    desc: '默认引擎,基于 Claude 模型的 Code Agent。', alwaysOn: true },
  { key: 'atomcode',  label: 'AtomCode',    settingsTab: 'atomcode',  desc: '本地化部署的代码引擎。' },
  { key: 'codex',     label: 'Codex',        settingsTab: 'codex',     desc: 'OpenAI Codex 代码引擎。' },
  { key: 'opencode',  label: 'OpenCode',     settingsTab: 'opencode',  desc: '开源代码引擎。' },
];
```
- 渲染:标题 + 副标题 + `grid sm:grid-cols-2 xl:grid-cols-4` 卡片网格;每卡片含图标、状态徽章(绿/灰)、描述、「配置」按钮。

## 3. 边界与权限

- 非 admin 用户进入 `/engines`:卡片可显示状态(只读),点「配置」跳 `/settings?tab=atomcode` 时,`SettingsPage` 既有逻辑会因 `canManageSystemConfig=false` 回退到默认 tab。此为既有行为,本期不改(符合外科式)。
- 非 admin 用户仍可看到 MCP/记忆/引擎三个菜单项;MCP 页内部本身有 `isAdmin` 分支控制,记忆页同理,无需菜单层再过滤。

## 4. 风险与回滚

| 风险 | 影响 | 缓解 |
|---|---|---|
| lucide 图标名拼错 | 构建失败 | 已确认 `Server/BrainCircuit/Cpu` 均为标准导出;`npm run build` 会暴露 |
| 重排顺序影响用户肌肉记忆 | 低 | 顺序按结构化认知,用户已确认 |
| 引擎 API 404/失败 | 卡片状态显示「未启用」 | `api.get(...).catch(() => null)` 兜底,与 `EngineSwitcher` 一致 |

**回滚:** 单 commit 即可 `git revert`;菜单数据是纯数组,无数据迁移。

## 5. 验证策略

1. `npm run build` 通过。
2. `npx tsc --noEmit` 无新增类型错误(若项目有 typecheck 脚本则用之)。
3. `npm run test` 既有用例不回归。
4. 人工:启动 dev server,核对菜单 14 项顺序与 3 新入口可点击进入正确页面。
