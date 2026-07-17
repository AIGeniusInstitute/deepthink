# PRD:一级菜单新增 MCP 服务器 / 记忆管理 / 引擎模块

- **需求编号:** top-nav-mcp-memory-engine
- **创建日期:** 2026-07-17
- **优先级:** 中(信息架构优化,非阻断性)
- **置信度:** 高(现状已探查,方案已与用户确认)

## 1. 背景与目标

DeepThink 顶级一级菜单当前 11 项,均偏「业务对象」(Agent/知识库/市场/Skill/沙箱/任务/循环/Harness/账单/设置/工作台)。
而三类**能力层资源**——MCP 服务器、记忆管理、引擎(Claude Code / Codex / OpenCode / AtomCode)——都已实现,却埋在「设置」二级 tab 或仅能通过 URL 访问,与它们在系统中的重要性不匹配。

**目标:** 将 MCP 服务器、记忆管理、引擎三模块提升为一级菜单,与 Agent/Skill/知识库/沙箱并列,形成清晰的「能力层」心智,整体结构简单清晰、符合结构化认知。

## 2. 用户故事

- 作为任意登录用户,我希望在左侧一级菜单直接看到「MCP 服务器」「记忆管理」「引擎」入口,一键进入,而不必先进设置再翻 tab。
- 作为开发者/运维,我希望「引擎」一级页面能一眼看到 4 个引擎(Claude/AtomCode/Codex/OpenCode)的可用性,并能跳转到各自的详细配置。

## 3. 范围

### 3.1 In Scope
- 在 `baseNavItems` 新增 3 个一级菜单项:MCP 服务器、记忆管理、引擎。
- 按结构化认知重排一级菜单顺序。
- 新增 `/engines` 路由与 `EnginesPage` 聚合页(4 引擎卡片 + 可用性 + 跳转配置)。
- 桌面侧边栏 `UnifiedSidebar` 与移动端 `BottomTabBar` 同步生效(均消费 `filterNavItems`,无需分别改)。

### 3.2 Out of Scope(本期不做,避免范围蔓延)
- 不改 MCP 服务器页 / 记忆管理页内部功能(已存在,仅加菜单入口)。
- 不从设置页移除这三类二级 tab(决策3:双入口保留,低风险)。
- 不重构一级菜单 i18n(决策4:沿用硬编码中文与现状一致;历史 i18n 债另立任务)。
- 不引入菜单分组标题(决策2:保持扁平)。
- 引擎聚合页不做「切换默认引擎」操作(切换依赖 group 上下文,留在聊天页 EngineSwitcher)。

## 4. 功能需求

### FR-1 一级菜单新增与重排
菜单项数据结构不变(`path/icon/label/[requiresBilling]`)。最终一级菜单顺序:

| # | path | label | icon | 备注 |
|---|---|---|---|---|
|1|`/chat`|工作台|MessageCircle||
|2|`/agents`|Agent|Bot||
|3|`/skills`|Skill|Puzzle|原第5,前移|
|4|`/knowledge-bases`|知识库|BookOpen|原第3,后移|
|5|`/marketplace`|市场|ShoppingBag||
|6|`/mcp-servers`|MCP 服务器|Server|**新增**|
|7|`/memory`|记忆管理|BrainCircuit|**新增**(避免与知识库 BookOpen 撞图标)|
|8|`/engines`|引擎|Cpu|**新增**|
|9|`/sandbox`|沙箱|Boxes||
|10|`/tasks`|任务|Clock4||
|11|`/loops`|循环|Repeat||
|12|`/harness`|Harness|GitBranch||
|13|`/billing`|账单|Wallet|requiresBilling|
|14|`/settings`|设置|User||

### FR-2 引擎聚合页 `/engines`
- 展示 4 张引擎卡片:Claude Code、AtomCode、Codex、OpenCode。
- 每张卡片:名称、可用性状态(可用/未启用)、一句话描述、「配置」按钮。
- 「配置」按钮跳转:
  - Claude → `/settings?tab=claude`
  - AtomCode → `/settings?tab=atomcode`
  - Codex → `/settings?tab=codex`
  - OpenCode → `/settings?tab=opencode`
- 可用性判定:Claude 始终可用;其余 3 个调用现有 `GET /api/config/{engine}`(`{ enabled?: boolean }`),`enabled===true` 即可用。复用 `EngineSwitcher` 已验证的判定逻辑。

### FR-3 路由
- `App.tsx` 新增 `/engines` 路由(lazy),挂在 `AppLayout` 下,与 `/memory`、`/mcp-servers` 同级。

## 5. 验收标准(可衡量)

1. 桌面侧边栏(lg+)与移动端底部 Tab Bar 均可见 3 个新入口,顺序符合 FR-1 表。
2. 点击「MCP 服务器」→ 进入 `/mcp-servers`(McpServersPage,功能不变)。
3. 点击「记忆管理」→ 进入 `/memory`(MemoryPage,功能不变)。
4. 点击「引擎」→ 进入 `/engines`,4 张引擎卡片正常渲染,可用性状态正确。
5. 引擎卡片「配置」按钮跳转到对应设置 tab。
6. 原 11 个菜单项点击行为不变。
7. `npm run build` 通过;`npm run typecheck`(或 `tsc --noEmit`)无新增类型错误。
8. 既有前端单测 `npm run test`(vitest)通过。

## 6. 非功能需求

- **最小改动:** 仅新增 3 菜单项 + 1 页面 + 1 路由,不重构既有组件(外科式改动)。
- **一致性:** 新页面风格沿用 `McpServersPage` 的 `PageHeader` + `Card` 布局。
- **图标无碰撞:** 同一菜单栏内无重复图标(故记忆用 BrainCircuit 而非 BookOpen)。
