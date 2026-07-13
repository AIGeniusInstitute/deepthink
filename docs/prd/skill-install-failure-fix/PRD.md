# PRD — Skill 安装失败修复

## 背景

DeepThink 的 Skills 模块支持用户在 Web 界面搜索技能（来源于 skills.sh），点击「安装」将 skill 部署到自己用户级的 `~/.claude/skills/` 目录。最近一次反馈：

> 修复 DeepThink：skill 模块，搜索到技能之后，安装失败。报错：Failed to install skill。

## 用户现象

1. 用户进入 Skills 页面，搜索关键词（如 "memory"）。
2. 在搜索结果列表中点击「安装」按钮。
3. Web 端弹出红色错误提示：`Failed to install skill`。
4. 用户级 skills 目录 (`data/skills/{userId}/`) 没有新内容；反而 happyclaw 主进程的真实 `~/.claude/skills/`（即 `data/sessions/main/.claude/skills/`）被污染，出现一个意外的 skill 子目录。

## 问题描述

`src/routes/skills.ts` 中的 `installSkillForUser()` 使用临时目录 `tempHome` 作为 `HOME` 环境变量，希望 `npx skills add --global -a claude-code` 把内容装到 `tempHome/.claude/skills/`，然后再 copy 到用户级目录，避免并发竞争。

但 happyclaw 主进程的环境里设置了 `CLAUDE_CONFIG_DIR=/Users/xingzhi/deploy/happyclaw/data/sessions/main/.claude`。`skills` CLI 通过 `CLAUDE_CONFIG_DIR`（优先级高于 `HOME/.claude`）定位 claude-code 的配置目录，于是把 skill 装到了**真实**的 `data/sessions/main/.claude/skills/`，而代码后面去扫描 `tempHome/.claude/skills/`（空），命中 `installedEntries.length === 0` 分支，返回错误 `"No skills were installed — package may be invalid"`。

最终 Web 路由 `/api/skills/install`（`src/routes/skills.ts:858`）返回 500 + `{ error: 'Failed to install skill', details: 'No skills were installed — package may be invalid' }`，前端 SkillsPage 渲染为 "Failed to install skill"。

## 复现路径

1. 启动 happyclaw 主服务（环境变量包含 `CLAUDE_CONFIG_DIR=.../data/sessions/main/.claude`）。
2. 登录 Web，访问 `/skills` 页面。
3. 搜索 "memory" → 结果出现 `github/awesome-copilot/memory-merger`。
4. 点击「安装」。
5. **实际**：弹错误 "Failed to install skill"；同时 `data/sessions/main/.claude/skills/memory-merger` 出现脏文件。
6. **期望**：提示安装成功，用户级 `data/skills/{userId}/memory-merger` 出现新 skill。

## 根因

环境变量 `CLAUDE_CONFIG_DIR` 覆盖了 `HOME` 作为 Claude Code 配置目录的来源。`installSkillForUser()` 只重写了 `HOME`，没有重写 `CLAUDE_CONFIG_DIR`，导致临时 HOME 隔离失效。

## 影响

- **功能**：Skills 模块的安装流程完全不可用，所有用户、所有 skill 都装不上。
- **数据**：每次失败安装都会向 happyclaw 主进程的真实 `~/.claude/skills/` 写入脏文件，长期累积会污染主容器 Agent 的 skill 列表，可能触发非预期行为。
- **安全**：脏文件出现在 admin 主容器配置目录，等于在 admin 的 Agent 运行时多注入了未经审核的 skill。

## 修复范围

仅修复 `src/routes/skills.ts` 的 `installSkillForUser()` 函数：

- 在调用 `npx skills add` 时，把 `CLAUDE_CONFIG_DIR` 也指向 `tempHome/.claude`，与 `HOME` 保持一致。
- 不改 Web 路由、不改前端、不改 IPC 处理器、不改 MCP 工具。

## 验收标准

- 给定一个有效的 skills.sh 搜索结果 package（如 `github/awesome-copilot@memory-merger`），调用 `installSkillForUser()` 后：
  1. 返回 `{ success: true, installed: ['memory-merger'] }`。
  2. `data/skills/{userId}/memory-merger/SKILL.md` 存在且以 frontmatter 开头。
  3. happyclaw 主进程的真实 `~/.claude/skills/`（`data/sessions/main/.claude/skills/`）**没有**任何新增子目录。
- 调用 Web API `POST /api/skills/install` 返回 200 + `{ success: true }`。
- 前端 SkillsPage 不再弹 "Failed to install skill"。
- 已安装 skill 列表能看到刚装上的 skill。

## 非目标

- 不重构 skill 安装管线（继续使用 `npx skills add`）。
- 不引入新的 skill 包格式校验。
- 不修复历史已污染的 `data/sessions/main/.claude/skills/` 脏文件（由用户/运维手动清理，下文「修复遗留」一节给出建议）。

## 修复遗留（运维提示，不在本次代码内）

历史失败安装可能在 `data/sessions/main/.claude/skills/` 下残留若干 skill 子目录。这些目录不属于任何用户级配置，且 admin 主容器启动时会从 `~/.claude/skills/` 发现并加载，可能引入非预期行为。建议：

1. 修复上线后，运维比对 `data/skills/{userId}/` 下所有用户的 manifest 与 `data/sessions/main/.claude/skills/` 下的实际目录。
2. 删除 `data/sessions/main/.claude/skills/` 下不属于 admin 真实安装意图的目录。
