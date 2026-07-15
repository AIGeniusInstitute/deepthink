# PRD: Agent Studio 三项缺陷修复

## 背景

DeepThink 的 Agent Studio（`/agents`）允许用户创建自定义 Agent，配置 System Prompt、模型、挂载 MCP/Skill/KB，并通过测试对话验证效果。近期用户反馈三项明确的缺陷，导致 Agent 无法正常使用。

## 用户现象

1. **System Prompt 身份不生效**：在 Agent Studio 创建一个 Agent，指定 System Prompt 描述角色身份（如"你是一位资深 AI Agent 架构师和面试官"），点击"测试对话"后问"你是谁"，Agent 回复的是"我是 DeepThink，企业级 Agent SaaS 超级智能体自进化平台……"，而不是 System Prompt 中定义的角色身份。
2. **名称/描述不可编辑**：创建好的 Agent，在详情面板里名称、描述是静态文本，无法修改；创建弹窗里也没有描述输入框，新建后描述始终为空。
3. **Skill 挂载无效**：创建好的 Agent，挂载面板有"Skill"按钮，可以选已安装的 Skill 加到挂载列表，但实际执行时这些挂载被完全忽略——SDK 始终用 `skills: 'all'` 加载用户全部 Skill，没有 per-agent 选择能力；用户也不知道如何为 Agent 安装 Skill。

## 问题描述

### 缺陷 1：System Prompt 被 CLAUDE.md 覆盖

- **数据流**：用户创建 Agent → DB `agent_definitions.system_prompt` 字段保存 → 用户点测试对话 → `paas-agents.ts:517` 创建/复用 `web:agent-test-{agentId}` 组并绑定 `agentDefId` → 用户发"你是谁" → `container-runner.ts:loadGroupAgentDefinition` 读取 `def.system_prompt` → 通过 `ContainerInput.agentDefinition` 传给 agent-runner → `agent-runner/src/index.ts:1487` 把它包成 `<agent-definition>...` 追加到 `systemPromptAppend` 末尾 → SDK `query({ systemPrompt: { type: 'preset', preset: 'claude_code', append: systemPromptAppend } })`。
- **覆盖发生处**：同时，`container-runner.ts:syncHostClaudeContext`（`claude-context-resolver.ts:236`）会把全局 CLAUDE.md 模板（路径 `/Users/xingzhi/.claude/CLAUDE.md`，内容包含 "## 你是谁 DeepThink, 企业级 Agent SaaS..." 和"品牌口径（必须遵守）"）符号链接到 `data/sessions/agent-test-{agentId}/.claude/CLAUDE.md`。SDK 的 `settingSources: ['project', 'user']` 会把这份 CLAUDE.md 当作 user memory 加载，**加载顺序在 systemPrompt append 之后**，导致 CLAUDE.md 里的 "你是 DeepThink" + "品牌口径"规则覆盖了 `<agent-definition>` 中的自定义身份。

### 缺陷 2：UI 缺少编辑入口

- **后端能力已具备**：`PATCH /api/paas/agents/:id`（`paas-agents.ts:151`）+ `AgentDefinitionPatchSchema`（`schemas.ts:261`）已支持 `name` / `description` / `system_prompt` 等字段；`updateAgentDefinition`（`db.ts`）也接受这两个字段。
- **前端缺口**：`AgentStudioPage.tsx:133-134` 把 `selected.name` / `selected.description` 渲染成静态 `<div>`，没有 `onBlur` / 没有输入框。创建弹窗（`AgentStudioPage.tsx:293-321`）只有名称 + System Prompt + 模型 + 引擎输入，**没有描述输入框**，`handleCreate`（line 57-63）也没有把 `description` 传给后端。

### 缺陷 3：Skill 挂载执行路径断裂

- **DB 层支持**：`agent_mounts.resource_type` 枚举包含 `'skill'`（`schemas.ts:275`），表结构 OK。
- **执行路径忽略**：`container-runner.ts:1022-1023` 对 `resourceType === 'skill'` 只设置 `base.resourceName = m.resource_id`，没有解析 Skill 的物理路径；`agent-runner/src/index.ts:1604-1617` 只过滤 `mcp_server` 和 `knowledge_base`，**skill 挂载完全被丢弃**。
- **Skill 加载方式**：`agent-runner/src/index.ts:1646` 用 `skills: 'all'` 启用全部已挂载的 Skill 目录（builtin / external / project / user 四源合并），与 per-agent 挂载选择无关。
- **可用列表源**：`loadUserSkillsMeta`（`paas-agents.ts:313`）从 `data/skills/{userId}/.skills-manifest.json` 读取已安装 Skill；若用户从未安装 Skill，挂载面板的"Skill"选择器会显示"无可挂载资源"。

## 期望行为

1. **System Prompt 生效**：Agent 有 `system_prompt` 时，"你是谁"必须回答该 Agent 配置的身份，**不得**回答 "DeepThink" 或平台默认身份。Agent 的 System Prompt 在优先级上高于全局 CLAUDE.md 的"你是谁"和"品牌口径"。
2. **名称/描述可编辑**：详情面板的名称改为单行输入，描述改为多行输入，失焦保存；创建弹窗新增描述输入框，创建时一并提交。
3. **Skill 挂载真实生效 + 可安装**：
   - 挂载面板的"Skill"按钮可以选择已安装的 Skill 加到挂载；
   - 当 Agent 有 Skill 挂载时，执行时只启用挂载列表中的 Skill（而非 `skills: 'all'`）；
   - 当 Agent 没有 Skill 挂载时，维持现有行为（`skills: 'all'`），保证向后兼容；
   - 挂载面板的"Skill"选择器为空时，给出明确提示与跳转到 `/skills` 页安装的入口。

## 影响

- **可用性**：缺陷 1 直接让 Agent Studio 的核心价值（定义角色）失效，用户写 System Prompt 等于白写；
- **数据完整性**：缺陷 2 让用户不得不删掉重建 Agent 才能改名字/补描述，已有挂载、绑定、版本历史会被无谓地扰动；
- **能力边界**：缺陷 3 让 per-agent Skill 隔离无法实现，所有 Agent 共享所有 Skill，无法做"最小权限"；
- **用户信任**：三项缺陷叠加，用户会判断 Agent Studio 整体不可用。

## 成功标准（验收）

- 在 `/agents` 新建 Agent，System Prompt 写"你是小红，一位热心肠的中文写作助手"，点测试对话，发"你是谁"，回复必须以"小红"身份作答，不得出现 "DeepThink"。
- 在详情面板改名称为"我的写作助手"、描述为"用于中文写作"，失焦后 toast 提示保存成功，刷新页面数据持久化。
- 在 `/skills` 安装一个 Skill（例如 `anthropic/think`），回到 `/agents` 详情面板的挂载区点"Skill"能看到该 Skill，挂载后该 Agent 执行时只启用挂载的 Skill（通过 `agent-runner` 日志或行为可验证）。
- Agent 不挂载任何 Skill 时，行为与当前完全一致（不回归）。

## 非目标（Out of Scope）

- 不重写 Skill 安装机制本身（沿用 `SkillsPage` 的 `npx skills add` 流程）；
- 不改动 atomcode 引擎路径的 System Prompt 注入（本次只处理默认 claude 引擎）；
- 不重构 CLAUDE.md 全局模板的内容；
- 不改动 MCP / KB 挂载执行路径（已工作）。
