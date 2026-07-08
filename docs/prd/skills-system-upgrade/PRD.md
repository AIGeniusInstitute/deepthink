# DeepThink 技能体系升级 PRD

## 1. 背景

DeepThink 当前技能系统是纯文件系统驱动：
- 技能存储在 `data/skills/<userId>/<skillId>/SKILL.md`（YAML frontmatter + Markdown body）
- 用户只能从 skills.sh registry 安装（`POST /api/skills/install`）、启用/停用（rename `SKILL.md` ↔ `SKILL.md.disabled`）、删除
- 无创建、编辑、上传、AI 生成、AI 优化、在线调试能力
- Web 端 `SkillsPage` 只展示只读详情

技能是 Claude Code 原生能力的一部分，DeepThink 的核心理念是"不重新实现 Agent 能力，直接复用 Claude Code"。本次升级要让用户可以**自助创建、协作编辑、上传分发、AI 辅助优化**技能，让技能真正成为可沉淀、可演进的资产。

## 2. 目标

| 目标 | 衡量标准 |
|------|---------|
| 用户可创建自己的技能 | Web 端可填写需求描述，AI 生成 SKILL.md 并注册到技能列表 |
| 支持在线编辑和保存 | Web 端可编辑 SKILL.md 全文，保存后立即生效（下次会话加载新内容） |
| 支持上传 zip 压缩包 | 上传 zip 后自动校验、解压、注册到技能体系 |
| 支持在线调试 | 可在 Web 端输入测试 prompt，实际调用 Claude（加载该技能）执行一次，返回输出 |
| 支持 AI 自动优化 | 可点击"AI 优化"按钮，附反馈，AI 改写 SKILL.md，预览 diff 后确认应用 |
| AI 可在对话中自动创建技能 | Agent 在对话上下文中调用 `install_skill`（扩展现有 MCP 工具）即可创建新技能 |

## 3. 非目标

- 不实现技能版本管理（历史版本、回滚）—— 第一版只保留当前内容，优化前自动备份一份到 `.bak`
- 不实现技能市场/分享功能 —— 用户之间不能互相安装技能
- 不实现技能的跨用户同步 —— 每个用户的技能目录相互隔离
- 不修改 Claude Code SDK 内置的技能发现机制（`/home/node/.claude/skills/` 符号链接扫描）

## 4. 用户故事

### US-1: 用户用 AI 生成新技能
> 作为 DeepThink 用户
> 我希望在 Web 技能页点"创建技能"，用自然语言描述需求（如"每天爬取 GitHub trending 仓库并汇总到飞书"）
> 让 AI 帮我生成完整的 SKILL.md
> 生成的技能立即可在技能列表看到、可启用、可编辑

**验收标准**：
- 输入：`description_prompt`（必填，≥10 字符）+ `name`（可选，不填则 AI 自动 slugify）
- 输出：包含 YAML frontmatter（`name`、`description`、`user-invocable`、`allowed-tools`、`argument-hint`）+ Markdown 正文
- 自动注册到 `data/skills/<userId>/<skillId>/SKILL.md`
- 同名技能 ID 冲突时自动加 `-2`、`-3` 后缀
- 生成失败时返回明确错误（API 不可用 / 内容校验失败）

### US-2: 用户在线编辑技能
> 作为 DeepThink 用户
> 我希望点击技能后能在右侧编辑 SKILL.md 全文
> 保存后下次会话即可生效

**验收标准**：
- 编辑器展示当前 SKILL.md 完整内容（含 frontmatter）
- 保存时校验：frontmatter 可解析、`name` 字段非空、`description` 非空
- 校验失败时返回行号 + 错误描述，不写入
- 仅 user 级技能可编辑；project/external 级只读
- 保存成功后刷新详情

### US-3: 用户上传 zip 技能包
> 作为 DeepThink 用户
> 我希望把别人打包好的 zip 技能压缩包上传到我的技能体系

**验收标准**：
- 接受 `.zip` 文件，大小 ≤ 10MB
- 解压后顶层必须包含 `SKILL.md`（或解压后单目录、目录内含 `SKILL.md`）
- 校验 frontmatter 完整性
- 路径遍历防护：禁止 `../`、绝对路径、符号链接
- 解压目标：`data/skills/<userId>/<skillId>/`，skillId 取自 frontmatter `name` 或 zip 文件名（slugified）
- 同名冲突时提示用户选择：覆盖 / 重命名 / 取消（第一版直接报错，要求用户改名）

### US-4: 用户在线调试技能
> 作为 DeepThink 用户
> 我希望选中技能后输入测试 prompt，点"调试"
> 系统用当前技能配置调用 Claude 执行一次，返回输出

**验收标准**：
- 输入：`test_input`（必填）
- 后端使用 `sdkQuery`，将 SKILL.md 内容作为系统 prompt 注入，test_input 作为用户输入
- 返回：`output`（Claude 文本回复）+ `usage`（token 用量）+ `duration_ms`
- 调试不修改技能内容
- 调试过程有超时（默认 60s）

### US-5: 用户用 AI 优化技能
> 作为 DeepThink 用户
> 我希望点"AI 优化"按钮，可选填写反馈（如"描述太笼统，希望更聚焦于错误处理"）
> AI 返回优化后的内容预览
> 我可以对比 diff，决定应用或放弃

**验收标准**：
- 输入：`feedback`（可选）
- AI 读取当前 SKILL.md 全文 + 用户反馈，返回优化后的完整内容
- 前端展示 diff（新增行绿色、删除行红色）
- 用户点"应用"→ 保存为新内容（原内容自动备份到 `SKILL.md.bak.{timestamp}`）
- 用户点"放弃"→ 不做任何修改
- 优化失败时返回错误，不影响原内容

### US-6: Agent 在对话中自动创建技能
> 作为 DeepThink Agent
> 我希望在对话中识别到用户反复要求某类操作
> 可以调用 MCP 工具创建一个技能来沉淀这个能力

**验收标准**：
- 扩展 `install_skill` MCP 工具签名，支持 `{package: string}` 原语义 + `{name, description_prompt}` 新语义
- 或新增 `create_skill` MCP 工具
- IPC 处理器在主进程调用 `installSkillForUser`（原）或新 `createSkillForUser`（新）
- 创建后 Agent 可以在后续会话中加载该技能

**第一版决策**：新增 `create_skill` MCP 工具，不破坏 `install_skill` 语义。

## 5. 功能清单

### 后端新增 API

| 方法 | 路径 | 用途 |
|------|------|------|
| POST | `/api/skills/create` | AI 生成新技能 |
| PUT | `/api/skills/:id/content` | 在线编辑保存 |
| POST | `/api/skills/:id/optimize` | AI 优化预览（不应用） |
| POST | `/api/skills/:id/optimize/apply` | 应用优化后的内容 |
| POST | `/api/skills/upload` | 上传 zip 技能包 |
| POST | `/api/skills/:id/debug` | 在线调试 |

### 后端新增 MCP 工具

| 工具 | 用途 |
|------|------|
| `create_skill` | Agent 在对话中自动创建技能 |

### 前端新增 UI

- `CreateSkillDialog`：描述输入 + 可选名称 + 生成按钮
- `UploadSkillDialog`：文件选择 + 上传按钮
- `SkillEditor`：textarea 编辑器 + 保存按钮
- `SkillDebugger`：测试输入 + 执行按钮 + 输出展示
- `OptimizeSkillDialog`：反馈输入 + diff 预览 + 应用/放弃

## 6. 数据结构

### 技能文件结构（不变）

```
data/skills/<userId>/<skillId>/
  SKILL.md              # 启用状态
  SKILL.md.disabled     # 停用状态（rename 切换）
  SKILL.md.bak.<ts>     # 优化前的备份
  scripts/              # 可选辅助脚本
  *.json                # 可选资源文件
```

### Manifest 扩展

`data/skills/<userId>/.skills-manifest.json` 增加 `sourceType` 字段：

```json
{
  "skills": {
    "my-skill": {
      "packageName": "local",
      "installedAt": "2026-07-08T10:00:00Z",
      "source": "skills.sh",        // 原有：registry 安装
      "sourceType": "generated"     // 新增：generated | uploaded | edited | registry
    }
  }
}
```

## 7. 安全约束

- zip 解压前后均做路径遍历校验（禁止 `../`、绝对路径、符号链接）
- zip 内文件数 ≤ 100，解压后总大小 ≤ 20MB
- AI 生成/优化内容写入前做 frontmatter 校验（`name` 非空、`description` 非空）
- AI 调试不执行实际工具调用（`allowedTools: []` + `maxTurns: 1`），只返回文本
- 所有写操作仅限 user 级技能（project/external 只读）

## 8. 测试场景

| 场景 | 期望 |
|------|------|
| 创建技能（描述=10字） | 成功，返回 skill_id |
| 创建技能（描述=5字） | 400 错误 |
| 创建技能（同名已存在） | 自动加后缀 `-2` |
| 编辑保存（合法 frontmatter） | 200，刷新后内容更新 |
| 编辑保存（缺 name） | 400 错误 |
| 上传 zip（含 SKILL.md） | 成功注册 |
| 上传 zip（无 SKILL.md） | 400 错误 |
| 上传 zip（含 `../`） | 400 错误 |
| 调试（合法 test_input） | 返回 output |
| 优化预览 | 返回 optimized_content |
| 优化应用 | 备份 .bak 文件 + 写入新内容 |
| Agent 调用 create_skill MCP | 成功创建 |

## 9. 里程碑

- M1: 后端 6 个 API + 1 个 MCP 工具
- M2: 前端 5 个 Dialog/组件 + SkillsPage 集成
- M3: typecheck 通过 + 手动 E2E 走查 + 测试报告
- M4: 合并 main、push
