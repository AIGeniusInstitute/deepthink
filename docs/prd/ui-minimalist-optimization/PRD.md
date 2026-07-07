# DeepThink 主对话框 UI 极简优化

> 需求 ID: ui-minimalist-optimization
> 分支: `feat/ui-optimization-minimalist`（基于 main）
> 创建日期: 2026-07-07

## 一、需求背景

DeepTalk 主对话框当前顶部状态栏堆积了"主 Agent / Agent / 协作人数 / 执行模式胶囊 / IM 渠道状态绿点"等元信息，视觉噪音过重，背离项目"月白青黛黑极简风"设计原旨；侧栏菜单中"Claude 提供商"字眼暴露底层技术栈，违背品牌口径；desktop 启动动画过于朴素（单个闪烁圆点），缺乏酷炫高级感；执行过程折叠过多，用户难以实时感知 Agent 在做什么；研究报告类产物当前以 markdown 文本交付，缺乏交互性和视觉表现力。

## 二、目标（Goal-Driven）

将主对话框改造为**极简、扁平、青黛黑+素白**风格，让工作区与产物文件成为视觉焦点；让执行过程更实时地透出；让 Agent 默认用 HTML 形式交付复杂产物。

### 成功标准（可验证）

1. ✅ 主对话框顶部仅保留：群名 + 思考状态指示 + 主题切换 + 显示模式切换 + 面板开关，移除所有冗余胶囊
2. ✅ 设置菜单中 "Claude 提供商" 文本全部改为 "模型服务商"（grep 验证 0 处残留）
3. ✅ desktop splash 重新设计：极简 + 至少 2 个高级动画效果（渐入+进度条+微光呼吸），介绍文本优化
4. ✅ StreamingDisplay 中工具调用卡片默认展开显示参数；子 Agent 卡片显示 running/completed/error 状态
5. ✅ FilePanel 支持 .html 文件 iframe 内嵌预览；Agent 全局提示词模板增加"研究报告默认用 HTML 交付"指令

## 三、五大改造项

### 1. 顶部状态栏极简化

**当前**：`web/src/components/chat/ChatView.tsx:555-640` Header 区，展示群名+状态文本+协作人数+执行模式胶囊+IM 渠道状态绿点+主题切换+显示模式+面板开关

**目标**：仅保留
- 群名（主标题，加大、加粗、突出）
- 思考状态指示（"正在思考..." 文本 + 极简动画点）
- 桌面端：主题切换 / 显示模式切换 / 面板开关（保留）

**移除**：
- ❌ "主 Agent / Agent" 状态文本
- ❌ 协作人数 (`group.member_count`)
- ❌ execution mode 胶囊（宿主机/Docker）
- ❌ IM 渠道状态绿点列表（飞书/Telegram 等）

**保留**：
- ✅ IM 渠道未配置 banner（首次引导，可关闭，行 643-664）
- ✅ 移动端返回按钮 / 更多操作按钮

### 2. 侧栏菜单去 Claude 字眼

**当前**：
- `web/src/components/settings/SettingsNav.tsx:31` — `{ key: 'claude', label: 'Claude 提供商', ... }`
- `web/src/pages/SettingsPage.tsx:107` — `claude: 'Claude 提供商'`

**目标**：两处文本改为 `模型服务商`，不修改 key 名（`claude` 作为内部 key 保留，避免影响路由与配置存储）

### 3. Desktop Splash 动画与文本优化

**当前**：`desktop/src/splash.ts` — 480×320 窗口，"DeepThink" 大字 + "本地 AI Agent · 思考的深度" 副标 + 单个 pulse 圆点 + "正在启动…" 文本

**目标**：
- **介绍文本优化**：副标改为更精炼的产品定位（如 "Loop Engineering · 本地优先"），状态文本改为更有节奏感的"正在唤醒思考…" 或 "Initializing…"
- **动画极简 + 酷炫**：
  - 渐入动画：DeepThink 字符逐字渐入 + 字间距收拢动画
  - 进度条：底部 1px 极简进度条，2s 内从 0% → 100%
  - 微光呼吸：logo 字下方一层柔和光晕，呼吸式 opacity 变化
  - 不引入花哨色彩，保持素白底 + 青黛黑字 + 单一 accent
- 窗口尺寸略增（如 520×360），给动画留呼吸空间

### 4. 流式执行过程透出

**当前**：
- `StreamingDisplay.tsx` 已有 ToolActivityCard / TaskAgentBlock / TodoProgressPanel / AgentContextPanel
- 工具卡 ToolActivityCard 默认紧凑展示工具名+耗时，参数需点击展开
- 子 Agent 卡 TaskAgentBlock 展示 running/error 状态但无进度百分比
- 思考链 thinkingText 默认展开（`thinkingExpanded = true`，行 664）

**目标**：
- **工具调用全展开**：ToolActivityCard 默认展示工具名 + 关键参数（path/cmd/pattern）+ 耗时，不再默认折叠参数
- **子 Agent 进度可视化**：TaskAgentBlock 在 running 状态下展示已完成步骤数/总步骤数（若 taskStates 中有 todos 数据）+ 状态胶囊（执行中/已完成/出错）
- **思考链保持可见**：保持默认展开（已是该行为，确认不退化）
- **不引入**：实时 token 速率、模型名展示（避免顶部再次复杂化，违背极简原则）

### 5. HTML 产物交付

**UI 改造**：
- `web/src/components/chat/FilePanel.tsx` — 在 `handleItemClick` 行 871-895 新增 `html` 分支，使用 iframe 内嵌预览（参考 PdfPreview 行 604-623 的实现模式）
- 在 `PreviewState` 类型行 180-188 新增 `{ kind: 'html'; file: FileEntry }`
- FileIcon 行 137-156 为 .html 文件新增专属图标（如 `Globe` 或 `Code`，使用 emerald 色）

**Agent 提示词改造**：
- `config/global-claude-md.template.md` — 新增章节"产物交付规范"，明确：
  - 研究报告、复杂交互产物默认用 HTML + 内嵌 CSS + 内嵌 JS 交付（单文件，无外链）
  - 报告需包含：标题/目录/章节/图表（用 SVG 或 CSS 实现）/动画
  - 文件命名：`{topic}-report.html`，存入 `docs/research/` 或工作区根目录
  - 简短结论可继续用 markdown，复杂内容强制 HTML

## 四、假设与待确认项

> 用户未在 AskUserQuestion 环节明确选择，以下为基于最合理推断的假设。如不符合预期，PRD 评审时纠正。

1. **执行过程透出深度** — 假设：工具调用参数全展开 + 子 Agent 状态可视化 + 思考链保持可见。**不引入**：实时 token 速率、模型名展示（违背极简原则）。
2. **HTML 产物交付范围** — 假设：UI 端 HTML 预览 + Agent 提示词改造，两者闭环。仅做 UI 预览或仅改提示词都不形成闭环。
3. **顶部"飞书状态"是否彻底移除** — 假设：彻底移除 IM 渠道状态绿点（用户原话"不展示飞书状态"）。仅保留 IM 未配置 banner（首次引导）。
4. **菜单"Claude 提供商"是否改 key** — 假设：仅改 label，不改 `claude` 这个 key（避免影响路由 / 配置存储 / 已有用户数据）。

## 五、非目标（Out of Scope）

- ❌ 不重做整体配色或字体（项目已是月白青黛黑极简风，本次只在现有基础上做减法）
- ❌ 不重构 ChatPage 三栏布局结构
- ❌ 不修改后端 API、数据库 schema
- ❌ 不修改 Agent SDK 调用层逻辑
- ❌ 不引入新的设计系统或 UI 库

## 六、影响面分析

| 文件 | 改动类型 | 风险 |
|------|---------|------|
| `web/src/components/chat/ChatView.tsx` | 删除 Header 元素 | 低 — 纯 UI |
| `web/src/components/settings/SettingsNav.tsx` | 文本替换 | 极低 |
| `web/src/pages/SettingsPage.tsx` | 文本替换 | 极低 |
| `desktop/src/splash.ts` | 重写 HTML/CSS | 低 — 独立模块 |
| `web/src/components/chat/StreamingDisplay.tsx` | 调整默认展开 | 低 — 纯 UI |
| `web/src/components/chat/ToolActivityCard.tsx` | 调整默认展示 | 低 — 纯 UI |
| `web/src/components/chat/FilePanel.tsx` | 新增 html 预览分支 | 中 — 新增 iframe，需注意 sandbox |
| `config/global-claude-md.template.md` | 新增章节 | 低 — 仅文本 |

**跨仓影响**：无。本次改造全部在 deep-think 仓库内。

**回归风险**：
- FilePanel iframe 预览 HTML 需 `sandbox` 属性，避免脚本逃逸
- splash 动画在低性能机器上可能卡顿，需保持 CSS GPU 加速（transform/opacity）

## 七、验收方式

1. 启动 web dev server，进入主聊天界面，确认顶部仅剩群名+思考状态+三按钮
2. 进入设置页，确认菜单显示"模型服务商"
3. 启动 desktop 应用，观察 splash 动画效果
4. 触发一次 Agent 任务，观察 StreamingDisplay 中工具卡参数是否默认展开
5. 在工作区放一个 .html 文件，点击预览，确认 iframe 内嵌渲染
6. `grep -r "Claude 提供商" web/` 返回 0 结果
7. `make typecheck` 通过
