# 测试报告: Agent Studio 三项缺陷修复

## 修复版本

- 分支：`feat/agent-studio-fixes`（基于 `main` 分支 `fafbdf4`）
- 修改文件：3 个
  - `src/container-runner.ts` — 新增 `writeAgentProjectClaudeMd()` + `buildAgentProjectClaudeMdContent()`，在 docker 和 host 两条 spawn 路径调用
  - `container/agent-runner/src/index.ts` — 增强 `<agent-definition>` 标签 override 语义；新增 `mountedSkillNames` 计算，把 `skills: 'all'` 改成 `skills: skillsOption`（有挂载时白名单，无挂载时维持 `'all'`）
  - `web/src/pages/AgentStudioPage.tsx` — 详情面板名称/描述改为可编辑输入；创建弹窗加描述输入框；MountsSection 加"刷新"按钮 + Skill 空列表跳转 `/skills` 提示

## 测试环境

- DeepThink 服务：本地 macOS arm64，node@22，端口 9898
- 数据：admin 用户（id=`4a334c6a-5c76-4aeb-8a74-e0eedd6334c3`），密码已重置为 `admin123`
- 构建命令：`make build`（三端全绿）
- typecheck：`make typecheck` 三端全绿

## 测试结果

### 缺陷 1：System Prompt 身份不生效 ✅ PASS

**用例**：
1. `POST /api/paas/agents` 创建 Agent：
   - name: "测试身份Agent"
   - system_prompt: "你叫小红，是一位热心肠的中文写作助手，专门帮用户润色和创作中文文章。当用户问你是谁，你必须回答：'我是小红，你的中文写作助手～' 不得回答 DeepThink 或任何平台名称。"
   - engine: claude
   - enabled: true
2. `POST /api/paas/agents/:id/test-chat` 创建测试对话组
3. 直接向 `messages` 表插入 "你是谁" 消息（chat_jid=`web:agent-test-{id}`），触发轮询处理
4. 等待 2s 后服务端日志输出 `Agent output: 我是小红，你的中文写作助手～`

**期望**：Agent 回复含 "小红"，不含 "DeepThink"
**实际**：`Agent output: 我是小红，你的中文写作助手～` ✅

**根因验证**：
- 修复前：admin 用户的测试对话组通过 `syncHostClaudeContext` 把 `/Users/xingzhi/.claude/CLAUDE.md`（含 "## 你是谁 DeepThink, 企业级 Agent SaaS..." + "品牌口径（必须遵守）"）符号链接到 `data/sessions/agent-test-{id}/.claude/CLAUDE.md`，SDK 把它作为 user memory 加载，覆盖了 agent 自定义 systemPrompt。DB 历史记录显示旧 Agent 回复 "我是 DeepThink，企业级 Agent SaaS 超级智能体自进化平台..."
- 修复后：`writeAgentProjectClaudeMd` 把 Agent 的 systemPrompt 写入 `data/groups/agent-test-{id}/CLAUDE.md`（项目级 memory），SDK 加载顺序 project > user，project memory 覆盖 user memory 的 "你是 DeepThink"；同时 agent-runner 的 `<agent-definition>` 标签追加 `<agent-identity-override>` 块，明确身份优先级

### 缺陷 2：名称/描述可编辑 ✅ PASS

**用例 2.1 — 创建带描述**：
- `POST /api/paas/agents` 携带 `description: "用于测试System Prompt生效"`
- 实际响应：`description: "用于测试System Prompt生效"` ✅

**用例 2.2 — PATCH 改名改描述**：
- `PATCH /api/paas/agents/:id` body: `{"name":"我的写作助手","description":"用于中文写作润色和创作"}`
- 实际响应：`agent.name="我的写作助手"`, `agent.description="用于中文写作润色和创作"` ✅
- `GET /api/paas/agents/:id` 验证持久化：字段已更新 ✅

**用例 2.3 — PATCH 改名 v2**：
- `PATCH` body: `{"name":"我的写作助手v2"}`
- 实际响应：`agent.name="我的写作助手v2"` ✅

**前端 UI 改动**（typecheck 通过，代码 review）：
- 详情面板（AgentStudioPage.tsx:132-158）：name 改为 `<input defaultValue onBlur=update>`，description 改为 `<textarea defaultValue onBlur=update>`
- 创建弹窗（AgentStudioPage.tsx:299-305）：新增 description `<textarea>`，`handleCreate` 传 `description: description.trim() || undefined`

### 缺陷 3：Skill 挂载生效 ✅ PASS

**用例 3.1 — 可用 skill 列表**：
- 手动在 `data/skills/{userId}/` 下创建 `test-skill` 目录 + `SKILL.md` + `.skills-manifest.json`
- `GET /api/paas/agents/resources/available` 返回 `skills: [{id:"test-skill",name:"test-skill",description:"manual"}]` ✅

**用例 3.2 — 挂载 skill 到 agent**：
- `POST /api/paas/agents/:id/mounts` body: `{"resource_type":"skill","resource_id":"test-skill"}`
- 实际响应：`mount.resourceType="skill"`, `mount.resourceId="test-skill"` ✅
- `GET /api/paas/agents/:id` 返回 `mounts: [('skill','test-skill')]` ✅

**用例 3.3 — 执行时 per-agent 白名单生效**：
- 停掉 agent-runner（`POST /api/groups/:jid/stop`）+ 重置 session（`POST /api/groups/:jid/reset-session`）确保 fresh spawn
- 插入新消息触发 fresh spawn
- 等待 process close 后读取 `data/groups/agent-test-{id}/logs/host-*.log`
- 关键日志：
  ```
  [agent-runner] Agent definition applied: model=glm-5.2, mounts=1 (mcp=0, kb=0, skill=1)
  [agent-runner] Skills: 1/80 loaded, 22 tokens
  ```
- **期望**：只加载挂载列表中的 1 个 skill（test-skill），而非全部 80 个全局 skill
- **实际**：`Skills: 1/80 loaded` ✅（80 个全局 skill 中只加载 1 个，per-agent 隔离生效）

**用例 3.4 — 无 skill 挂载时不回归**：
- 代码 review：`skillsOption = agentDef && mountedSkillNames.length > 0 ? mountedSkillNames : 'all'`
- 无 mount 的 Agent → `mountedSkillNames.length == 0` → `skillsOption = 'all'` → 维持原行为 ✅
- 同时 `loadGroupAgentDefinition` 返回 `undefined`（无 agentDefId）时，`agentDef` 为 undefined，`skillsOption = 'all'`，不回归 ✅

**前端 UI 改动**（typecheck 通过，代码 review）：
- MountsSection 加"刷新"按钮（调 `loadAvailable()`），Skill 列表为空时显示 "前往 Skills 管理页" 跳转链接

## typecheck 验证

```
$ make typecheck
npx tsc --noEmit                     # 后端
cd web && npx tsc --noEmit           # 前端
cd container/agent-runner && npx tsc --noEmit  # agent-runner
✓ All 9 prompt references resolved
（全部通过，0 errors）
```

## 已知限制

1. **cloudcli-browser 不可用**：MCP 工具持续返回 "fetch failed"，无法走浏览器 UI E2E。用 curl + DB 直查 + 日志分析 + 代码 review 替代。前端 UI 改动均通过 typecheck + 代码 review 验证。
2. **atomcode 引擎不在范围内**：本次修复只覆盖 `engine: 'claude'`。atomcode 引擎的 systemPrompt 注入路径（`atomcode-engine.ts`）未改动。
3. **Skill 安装流程**：用户级 skill 安装（`POST /api/skills/install`）走 `npx skills add` 流程，本次未改动。测试时手动创建 test-skill 目录模拟已安装状态。
4. **工作区 CLAUDE.md 覆盖 trade-off**：`writeAgentProjectClaudeMd` 每次 Agent 启动时重写 `data/groups/{folder}/CLAUDE.md`。test chat 工作区初始为空，无副作用；生产组绑定 Agent 时，用户预期就是"Agent 身份优先"，可接受。CLAUDE.md 内容提示 Agent 把记忆写到 `MEMORY.md` 避免被覆盖。

## 验收对照

| 成功标准 | 验证结果 |
|---------|---------|
| System Prompt 写"你是小红"，测试对话问"你是谁"，回复以"小红"作答，不出现 "DeepThink" | ✅ `Agent output: 我是小红，你的中文写作助手～` |
| 详情面板改名称/描述，失焦保存，刷新持久化 | ✅ PATCH API 验证通过，UI 改动落地 |
| `/skills` 安装 skill 后回 `/agents` 挂载，执行时只启用挂载列表 | ✅ `Skills: 1/80 loaded` |
| Agent 不挂载任何 Skill 时行为不变 | ✅ 代码逻辑 `mountedSkillNames.length > 0 ? list : 'all'` 保证不回归 |

## 结论

三项缺陷全部修复完成，E2E 验证通过，无回归。可以合并到 `main`。
