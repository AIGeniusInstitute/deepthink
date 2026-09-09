# Intent: Skills 迁 PostgreSQL + 对话挂载控件 + 办公技能快捷按钮

> 用户原始意图（2026-09-10），逐字记录，不改写。

## 任务目标

### 1、系统内置的公共通用技能清单
本机 `~/.claude/skills` 目录下有全部技能列表。请把 Agent、技能、MCP、知识库、工作区产物等等系统中全部的数据存储，都存储到 PostgreSQL 数据库中，然后，docker 里的数据库的数据盘要挂载到本机磁盘，这样重新部署应用，确保 PostgreSQL 数据库里的数据全部都在。

### 2、Agent 对话输入框挂载控件
Agent 对话输入框，做一个单独的技能下拉搜索框，支持用户直接下拉选择存储在 PostgreSQL 数据库中的技能，搜索技能，多选选中技能，然后，加载选中的技能，实时进行对话。同时，也做一个 MCP 工具下拉搜索选择区域，知识库下拉搜索选择区域，Agent 对话时，技能、MCP 工具、知识库检索等都可以挂载运行时使用。

### 3、办公技能快捷指令按钮
当前 DeepThink 系统中的 Agent 对话框的输入框上面的这些按钮（💬对话 🎯目标循环 🔄时间循环 🤖主动循环 🧬自适应 🧪技能自进化）隐藏，然后，把通用办公技能【PPT 制作 / Excel 表格 / PDF 处理 / 图片 OCR / WORD 文档 / Markdown 文档】内置到系统里（把这些技能直接初始化到系统数据库的 skill 表里），每个用户都能用。然后放到 Agent 对话框的输入框上面的快捷技能指令按钮。用户选择指令，输入框里自动选中对应技能，然后，Agent 运行时加载运行。

## 工作流
intent → prd → tech_solution → coding → test → ui_test (playwright) → (loop: bugfix issue workflow) → write_test_report (with usecase pass screenshots) → merge worktree to main, push main.

## 关键约束（Think Before Coding 待澄清项，探查代码后定）
- "全部数据存储迁 PG" 范围边界：是仅指技能/Agent/MCP/KB/产物这几类元数据+内容，还是指整库（消息/会话/用户）全部从 SQLite 迁 PG？需在 PRD 明确范围（避免过度工程）。
- 现有 PG 兼容链路（k8s-stateless-completion/sqlite-compat/pg-sync-driver/sql-translator）是否可复用，还是本次走全新 PG-only 部署。
- 办公技能(PPT/Excel/PDF/OCR/Word/Markdown)是否已有现成 skill 内容（openclaw/既有 skills），还是需新写 SKILL.md。
- 对话挂载控件的运行时接线：技能/MCP/KB 选中后如何注入 agent turn（system_prompt / tool / RAG 三条路径）。
