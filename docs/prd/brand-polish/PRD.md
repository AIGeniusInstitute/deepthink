# PRD — DeepThink 品牌与体验打磨 (brand-polish)

> 状态：已确认 · 版本：v1.0 · 日期：2026-07-07
> 分支：`feature/brand-polish`（基于 `main`）

## 1. 背景

DeepThink 当前处于产品打磨阶段，需要在用户首次接触的几个触点上建立一致的品牌心智：

- 用户问「你是谁 / 你能干什么」时，Agent 的回答散落在 `CLAUDE.md` 模板和系统行为中，且会透露底层实现（"Claude Agent SDK"、"Claude Code"等），不符合"只讲产品、不讲底层"的品牌口径。
- 默认主题色为暖橙 `theme-orange`（背景 `#FAF9F5`），与产品名"DeepThink"应有的克制、理性、素白调性不符。
- 对话框中的报错信息（`Host agent exited with code 1`、`处理失败，已达最大重试次数` 等）无法被删除，破坏了对话流的整洁性，用户被强制看到错误痕迹直至刷新。

## 2. 目标

1. **品牌宣推**：产出一份对外可发布的 DeepThink 品牌宣推介绍文档，作为对外宣讲与官网/手册附页的素材。
2. **品牌心智**：Agent 在被问及自我身份时，给出统一的、纯产品视角的 DeepThink 介绍，不透露底层模型、SDK、第三方依赖。
3. **主题色**：默认配色改为"素白浅色"（`theme-neutral`，纯白背景 + 中性灰主色）。
4. **消息删除**：对话框中所有消息（含报错信息）均支持删除。

## 3. 非目标

- 不重写品牌 VI 系统、不动 logo、不改产品名。
- 不删除已有的 `theme-orange` / `theme-default`（月白）配色，用户仍可在设置中切换。
- 不修改报错信息的产生逻辑、不静默吞错；只是让用户能在 UI 上主动清掉。
- 不调整系统消息的存储模型（仍写入 `messages` 表，`sender='__system__'`、`is_from_me=true`）。

## 4. 关键决策与假设

> 用户未在 AskUserQuestion 中选择，按以下默认假设推进，并在此明示。

| 决策点 | 默认选择 | 理由 |
|---|---|---|
| feature 命名 | `brand-polish` | 涵盖品牌心智+主题色+消息删除三项，命名中性、可复用 |
| 主题色 | `neutral`（纯白 `#ffffff`） | "素白"字面意义最贴切；`default`（月白）偏青调，不如纯白"素" |
| 删除权限 | 所有用户可删 `source='system'` 消息 | 需求原文"对话框中的消息…都支持删除"，不限制 admin |
| 模板更新范围 | 仅模板（无现有用户） | `data/groups/` 为空，开发环境未运行过；生产部署时按既有逻辑由 `index.ts:2695-2723` 自动补齐模板给存量用户 |

## 5. 功能详述

### 5.1 品牌宣推文档

- 路径：`docs/prd/brand-polish/BRAND-INTRO.md`
- 用途：对外宣讲素材，可被 README、官网、手册引用
- 内容：产品定位、核心能力、技术亮点、适用场景、品牌调性

### 5.2 品牌心智模板

- 文件：`config/global-claude-md.template.md`
- 修改首段「你是 DeepThink」段落，扩展为产品视角的能力清单
- 增加一条行为约束：被问及"你是谁/你能干什么/底层用什么实现"时，只回答 DeepThink 产品功能，不透露 SDK / 模型供应商 / 第三方依赖
- 保留现有的用户信息、偏好、定时任务规则、内部思考等段落不动

### 5.3 默认主题色

- 文件：`web/src/hooks/useTheme.ts`
- 默认 `ColorScheme` 由 `'orange'` 改为 `'neutral'`
- `setColorScheme` 的"默认值不写 localStorage"对称语义改为以 `neutral` 为默认
- CSS 层不动（`theme-neutral` 块已存在于 `globals.css:217-245`）

### 5.4 报错信息删除

**前端**：

- `web/src/components/chat/MessageList.tsx:120-126`：调整 `__system__` 消息的 flat-map，让 `agent_error:` / `agent_max_retries:` / `system_error:` / `context_reset:` 等也保留 `messageId`，统一走 `MessageBubble` 渲染（带上 `MessageContextMenu`）。
- `web/src/components/chat/MessageBubble.tsx`：当前 `context_overflow:` 走 early-return（`:205-228`）渲染为红色 banner 但**没有**挂 context menu。调整为也挂上 `<MessageContextMenu>`，让所有 system 消息都有删除入口。

**后端**：

- `src/routes/groups.ts:1424`：当前非 admin 不能删除 `is_from_me=1` 的消息。改为：当 `source='system'` 时允许任何认证用户删除（系统消息是产品自身的状态提示，不属于任何人的发言，不应成为用户对话里的永久污点）。
- 普通消息（非 system）的删除权限规则不变。

## 6. 验收标准

| # | 验收点 | 验证方式 |
|---|---|---|
| 1 | `docs/prd/brand-polish/BRAND-INTRO.md` 存在且内容完整（≥ 5 个段落） | 文件检查 |
| 2 | `config/global-claude-md.template.md` 首段包含 DeepThink 产品能力清单，且不含"Claude Agent SDK"/"Claude Code"字样 | grep 验证 |
| 3 | `web/src/hooks/useTheme.ts` 默认 ColorScheme 为 `'neutral'` | grep 验证 |
| 4 | 全新浏览器（无 localStorage）首次打开，背景为纯白 `#ffffff` | 启动 `make dev-web` 验证 |
| 5 | 触发一次报错（如容器超时），报错信息出现后可通过右键菜单删除 | 手动 E2E |
| 6 | 删除后消息从对话流消失，刷新页面后不再出现 | 手动 E2E |
| 7 | 非 admin 用户也能删除报错信息（后端权限放开） | API 验证 |
| 8 | `make typecheck` 通过 | 命令验证 |
| 9 | `make test` 通过 | 命令验证 |

## 7. 影响面

| 模块 | 文件 | 改动类型 |
|---|---|---|
| 文档 | `docs/prd/brand-polish/BRAND-INTRO.md` | 新增 |
| 文档 | `docs/prd/brand-polish/PRD.md` | 新增（本文件） |
| 文档 | `docs/tech_solution/brand-polish/TECH_SOLUTION.md` | 新增 |
| 文档 | `docs/test_report/brand-polish/TEST_REPORT.md` | 新增 |
| Agent 模板 | `config/global-claude-md.template.md` | 修改首段 + 增加行为约束 |
| 前端 | `web/src/hooks/useTheme.ts` | 默认值改 neutral |
| 前端 | `web/src/components/chat/MessageList.tsx` | flat-map 保留 messageId |
| 前端 | `web/src/components/chat/MessageBubble.tsx` | system 消息挂 context menu |
| 后端 | `src/routes/groups.ts` | system 消息删除权限放开 |

## 8. 风险

- **R1 存量用户模板不自动更新**：本次开发环境无存量用户，生产环境存量用户的 `data/groups/user-global/*/CLAUDE.md` 不会因为模板更新而自动改写。`index.ts:2695-2723` 只在文件缺失时补齐，已存在则不动。
  - 缓解：发布说明里提示运营手动触发模板升级，或后续单独做一次"模板版本号 + 迁移"特性。
- **R2 报错信息被用户删除后，运营侧排查变难**：删除只是 UI 不显示，数据库 `messages` 表记录仍在（DELETE 接口当前是真删，需在 TECH_SOLUTION 中确认）。
  - 缓解：检查后端 DELETE 是真删还是软删；若真删，考虑改为软删（`deleted_at`）保留审计。**本期内不调整，保持现状**（需求未提）。

## 9. 里程碑

| 步骤 | 产物 |
|---|---|
| 1. PRD | 本文件 |
| 2. 技术方案 | `TECH_SOLUTION.md` |
| 3. 编码实施 | 5 个文件改动 |
| 4. 验证 | typecheck + test + 手动 E2E |
| 5. 测试报告 | `TEST_REPORT.md` |
| 6. 合并 | `feature/brand-polish` → `main`，push |
