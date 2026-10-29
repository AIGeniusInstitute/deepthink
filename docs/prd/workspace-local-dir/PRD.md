# PRD — Agent 工作区目录支持选择用户本机目录

> 文档版本：v1.0 · 编写日期：2026-10-29 · Owner：Code Agent
> 关联：`docs/tech_solution/workspace-local-dir/`

## 1. 背景与目标

### 1.1 现状
DeepThink 中每个 Agent 工作区（`RegisteredGroup`）的工作目录默认固定为平台托管目录 `data/groups/{folder}/`。已有半成品的「自定义工作目录」能力（`registered_groups.custom_cwd`）：

- **宿主机模式（host）**：创建时可传 `custom_cwd`，Agent 进程直接以该本机目录为 cwd 工作（admin 专属，`config/mount-allowlist.json` 白名单校验，前端有 `DirectoryBrowser` 目录选择器）。
- **容器模式（container）**：工作区固定 `data/groups/{folder}` → bind mount 到容器 `/workspace/group`，**无法**把工作区指向本机目录；只有「复制本地目录」（`init_source_path`）能在创建时把本机目录**拷贝**进工作区，是一次性副本，不是「以本机目录为工作区」。

### 1.2 问题
1. 容器模式（默认推荐模式）不能选本机目录作为工作区，用户想让 Agent 直接在本机真实项目目录（如 `~/projects/my-app`）上工作时，只能：
   - 放弃容器隔离改用宿主机模式；或
   - 用「复制本地目录」得到副本，Agent 的修改不落在真实目录，还要手动同步。
2. `custom_cwd` 只能在**创建时**设置，创建后无法修改（`PATCH /api/groups/:jid` 不支持 `custom_cwd`）。连 admin 主容器（`web:main`）都没有 API 能配置 `custom_cwd`——而系统设置「禁用 DeepThink 记忆层」的前置校验（`src/routes/config.ts`）恰恰要求先给 `web:main` 配好 `custom_cwd`，该前置条件目前实际不可满足。
3. 工作区根目录解析规则（`customCwd || data/groups/{folder}`）在后端散落 5 处重复实现，且 `src/script-runner.ts` 直接使用 `data/groups/{folder}`——自定义工作区的定时脚本任务 cwd 落在错误目录。

### 1.3 目标
让「选择用户本机目录作为工作区」成为**两种执行模式通用、创建后可改**的一等能力：

1. 创建工作区时可选任意（白名单内）本机目录作为工作区根目录，容器模式与宿主机模式均支持；
2. 创建后可随时修改 / 恢复默认工作区目录；
3. Agent 运行、文件面板、工作区 Skills/MCP 配置等所有消费点对「工作区目录」的理解一致；
4. 安全边界不放宽：沿用挂载白名单（`config/mount-allowlist.json`）+ 敏感路径黑名单 + 运行时二次校验。

### 1.4 非目标
- 不放宽权限模型：`custom_cwd` 仍为 **admin 专属**（与 `init_source_path` / 宿主机模式同级）。让 member 把服务器本机目录挂进自己的容器属于权限放大，需单独安全评审，不在本期。
- 不做「用户浏览器本地目录」（Web 端 File System Access API）——本需求的「本机」指 DeepThink 服务所在宿主机。
- 不改变平台运行时数据（`logs/`、`downloads/`、`conversations/`、`sessions/` 等）的存放位置——它们继续留在 `data/groups/{folder}/` 等平台目录，不写进用户本机目录。
- 不支持 per-Agent（AgentDefinition）粒度的工作区目录——粒度仍是 per-工作区（group）。

## 2. 用户画像与场景

| 用户类型 | 场景 |
|---------|------|
| 个人开发者（admin） | 把工作区指向本机 `~/projects/my-app`，Agent 直接读写真实项目代码，容器模式下也无需同步副本 |
| 个人开发者（admin） | 工作区创建时没选目录，事后在工作区菜单里把工作目录改到真实项目 |
| 平台管理员（admin） | 给 admin 主容器 `web:main` 配置 `custom_cwd`，以满足「禁用 DeepThink 记忆层」开关的前置条件 |
| 普通成员（member） | 不受影响（权限不变）；其容器工作区仍为平台托管目录 |

## 3. 关键假设（请审阅时确认或推翻）

> 用户在需求对齐阶段未指定边界，按推荐默认推进，以下假设可在评审时推翻。

| 编号 | 假设 | 推翻的影响 |
|------|------|------------|
| A1 | `custom_cwd` 权限维持 **admin 专属**（`hasHostExecutionPermission`），两种执行模式一致 | 若放开给 member，需同步改 ACL 矩阵、browse API 权限，并评审「member 容器挂载宿主机目录」的隔离影响 |
| A2 | 修改工作区目录**不强制停止**运行中的 Agent：变更对**下一次运行**生效，文件面板立即切换到新目录 | 若要求立即一致，需在 PATCH 时强制 stop 该 folder 所有进程/容器（类似 clear-history），实现更重、可能打断长任务 |
| A3 | 「重建工作区」（clear-history）**不删除**本机目录中的文件，只清平台托管数据（会话/记忆/IPC/默认目录） | 若允许清空本机目录，属于对用户真实项目的破坏性操作，需单独的二次确认交互 |
| A4 | 平台运行时数据（`logs/`、IM `downloads/`、`conversations/` 归档、`sessions/`）继续放平台目录/会话目录，不随工作区迁移 | 若随迁，会往用户项目目录写入非项目文件（可被 git status 污染） |
| A5 | `custom_cwd` 不允许指向 DeepThink 数据目录（`DATA_DIR`）内部，防止工作区互相覆盖 / 与平台清理逻辑冲突 | — |
| A6 | 工作区根下已有用户 `CLAUDE.md` 时，Agent 定义身份注入**不覆盖**该文件（仅在文件不存在或确为系统写入时落盘） | 若强制覆盖，会毁掉用户项目自己的 CLAUDE.md |

## 4. 功能需求

### 4.1 核心功能（必做）

| ID | 功能 | 验收标准 |
|----|------|----------|
| F1 | 创建工作区可选本机目录（容器模式） | 新建工作区「高级选项 → 工作区来源」新增「使用本机目录」；选定后 Agent 的 `/workspace/group` 即该目录（读写挂载），文件面板以该目录为根 |
| F2 | 创建工作区可选本机目录（宿主机模式） | 维持现有行为（`custom_cwd` → 进程 cwd） |
| F3 | 创建后可修改工作区目录 | 工作区菜单提供「工作目录」入口：可浏览选择新目录 / 恢复默认目录；保存后对下一次 Agent 运行生效；非法路径（不存在 / 非绝对路径 / 白名单外 / 命中敏感路径黑名单）被拒绝并给出原因 |
| F4 | 白名单与安全校验 | 创建、修改、运行时三处校验一致：`config/mount-allowlist.json` 的 `allowedRoots` + `blockedPatterns`（含 `.ssh`/`.aws`/`credentials` 等默认黑名单）；拒绝 `DATA_DIR` 内部路径 |
| F5 | 消费点一致 | 文件面板、工作区 Skills/MCP（`.claude/`）、内联 `!` 命令、定时脚本任务 cwd 均以选定的工作区目录为准 |
| F6 | 不破坏用户本机文件 | 删除工作区、重建工作区均不删除本机目录及其内容；Agent 身份注入不覆盖用户已有的 `CLAUDE.md` |

### 4.2 体验与文案（必做）

| ID | 功能 | 验收标准 |
|----|------|----------|
| U1 | 目录选择器 | 复用 `DirectoryBrowser`（浏览 / 面包屑 / 新建文件夹），本机目录与复制来源共用同一交互 |
| U2 | 风险提示 | 宿主机模式提示维持；本机目录模式提示「Agent 将直接读写该目录」；修改目录提示「对下一次运行生效」 |
| U3 | 重建工作区文案 | 工作区目录为本机目录时，确认文案注明「本机目录中的文件不会被删除」 |

### 4.3 边界与约束

| ID | 场景 | 行为 |
|----|------|------|
| B1 | `custom_cwd` 与 `init_source_path` / `init_git_url` 同时传 | 400 拒绝（互斥：初始化拷贝/克隆的目标是默认工作区，与「以本机目录为工作区」语义冲突） |
| B2 | 路径为相对路径 / 不存在 / 非目录 | 400 拒绝 |
| B3 | 路径在白名单外 / 命中敏感黑名单 | 403 拒绝，提示检查 `config/mount-allowlist.json` |
| B4 | 修改后运行中的 Agent | 继续在旧目录运行至本轮结束；新运行使用新目录 |
| B5 | 容器内视角 | 不变：无论宿主机源目录是哪里，容器内均为 `/workspace/group` |
| B6 | 主容器（is_home） | 允许配置 `custom_cwd`（admin 主容器是「禁用记忆层」的前置条件）；执行模式仍不可改 |

## 5. 成功指标

- 容器模式工作区选定本机目录后，Agent 读写文件直接落在该目录（无需同步），文件面板所见即所得；
- `PATCH` 修改工作区目录后，下一条消息触发的 Agent 运行即使用新目录；
- `make test` 全绿，新增用例覆盖创建 / 修改 / 校验拒绝 / 消费点一致性。

## 6. 里程碑

| 阶段 | 内容 |
|------|------|
| M1 | 后端：`custom_cwd` 全模式支持 + PATCH 可改 + 校验收敛（`docs/tech_solution/workspace-local-dir/`） |
| M2 | 前端：创建对话框「使用本机目录」+ 「工作目录」编辑对话框 + 文案 |
| M3 | 测试与回归：新增测试 + `make test` 全量 + 文档同步（API.md / CLAUDE.md） |
