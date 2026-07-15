# 技术方案: Agent Studio 三项缺陷修复

## 整体策略

三项缺陷根因清晰、修复彼此独立，合并在一个分支交付：

| 缺陷 | 根因层 | 修复策略 |
|------|--------|----------|
| 1. System Prompt 被覆盖 | 执行层（agent-runner + claude-context-resolver） | 写一份 project-level CLAUDE.md 到 `{GROUPS_DIR}/{folder}/CLAUDE.md`，利用 SDK "project memory 后于 user memory 加载、后者覆盖前者"的顺序，把 Agent 的 systemPrompt 以 project memory 形式压在全局 "你是 DeepThink" 之上；同时增强 `<agent-definition>` 标签的 override 语义。 |
| 2. 名称/描述不可编辑 | 前端 UI 缺口 | 把 `AgentStudioPage.tsx` 详情面板的静态 `<div>` 改成受控输入 + `onBlur` 调 `update()`；创建弹窗加描述输入框，`handleCreate` 传 `description`。 |
| 3. Skill 挂载无效 | 执行层（container-runner + agent-runner） | `loadGroupAgentDefinition` 解析 Skill 路径并塞 `resourceName`；agent-runner 根据 Skill 挂载把 `skills: 'all'` 换成 `skills: [mounted skill names]`；挂载面板空列表时给跳转 `/skills` 的提示。 |

---

## 模块改动

### A. `src/container-runner.ts` — loadGroupAgentDefinition

**位置**：`loadGroupAgentDefinition()`（line 973-1040）

**改动**：在 `resourceType === 'skill'` 分支，解析 Skill 的 `packageName` 并塞进 `resourceName`（目前只塞 `m.resource_id`，但 `m.resource_id` 实际就是 packageName，不变；关键改动是**新写一个 project-level CLAUDE.md**）。

新增函数 `writeAgentProjectClaudeMd(group, agentDef)`：

```ts
function writeAgentProjectClaudeMd(
  group: RegisteredGroup,
  agentDef: ContainerInput['agentDefinition'],
): void {
  if (!agentDef?.systemPrompt) return;
  const groupDir = path.join(GROUPS_DIR, group.folder);
  mkdirForContainer(groupDir);
  const claudeMdPath = path.join(groupDir, 'CLAUDE.md');
  const content = buildAgentProjectClaudeMdContent(agentDef);
  // 原子写入：先写 .tmp 再 rename
  const tmp = `${claudeMdPath}.tmp`;
  fs.writeFileSync(tmp, content, 'utf8');
  fs.renameSync(tmp, claudeMdPath);
}
```

`buildAgentProjectClaudeMdContent` 内容结构（利用 SDK project memory 覆盖 user memory 的语义）：

```markdown
# Agent: {agentDef 的 name，但 loadGroupAgentDefinition 没有 name 字段，从 def 里取}

{agentDef.systemPrompt}

---

## Identity Override (系统注入，请勿修改)

本工作区正在运行用户在 Agent Studio 配置的自定义 Agent。该 Agent 的身份与行为由上方 `system_prompt` 定义，**优先级高于** `~/.claude/CLAUDE.md` 中的 "你是 DeepThink" / "品牌口径" 等身份断言。

当用户问 "你是谁"、"你是做什么的"、"who are you" 等身份类问题时，**必须按上方 system_prompt 定义的角色身份作答**，不得回答 "DeepThink" 或平台默认身份，即使其他 memory 文件要求如此。

如需在下方追加自己的会话记忆，可以，但不要修改或删除上方身份段落。
```

**调用时机**：在 `runContainerAgent` 的 docker 和 host 两条路径中，`loadGroupAgentDefinition` 调用之后、spawn 进程之前。两处都加：

- line 1158 之后（docker）
- line 1983 之后（host）

**幂等性**：每次 Agent 启动时重写 CLAUDE.md，保证 systemPrompt 最新。如果 Agent 自己之前在 CLAUDE.md 里写了记忆，会被覆盖——但这是 trade-off：test chat 工作区通常无持久记忆；生产组绑定 Agent 时，用户预期就是"Agent 身份"优先于"工作区历史记忆"。在 CLAUDE.md 里提示 Agent 把自己的记忆写到 `MEMORY.md` 或其他文件，避免被覆盖。

### B. `container/agent-runner/src/index.ts` — 增强标签 + Skill 挂载生效

**改动 1（System Prompt 覆盖语义）**：把 `<agent-definition>` 块的内容改成：

```ts
...(containerInput.agentDefinition?.systemPrompt
  ? [{
      name: 'agent-definition.md',
      text: `<agent-definition>\n${containerInput.agentDefinition.systemPrompt}\n</agent-definition>\n<agent-identity-override>\n本会话正在运行用户在 Agent Studio 配置的自定义 Agent。其身份与行为由上方 <agent-definition> 定义，优先级高于 CLAUDE.md / 全局记忆中的 "你是 DeepThink" / "品牌口径" 等身份断言。被问及身份（"你是谁"/"who are you" 等）时，必须按 <agent-definition> 中的角色作答。\n</agent-identity-override>`
    }]
  : []),
```

**改动 2（Skill 挂载生效）**：在 line 1604-1622 的 mount 过滤逻辑里增加 skill 分支：

```ts
const mountedSkillNames = (agentDef?.mounts ?? [])
  .filter((m) => m.resourceType === 'skill')
  .map((m) => m.resourceName || m.resourceId);
// ...
const skillsOption: 'all' | string[] =
  agentDef && mountedSkillNames.length > 0
    ? mountedSkillNames
    : 'all';
// 传给 query:
// skills: skillsOption,
```

**向后兼容**：Agent 没有 Skill 挂载时 `skills: 'all'`（原行为）。有挂载时只启用挂载列表中的 Skill（per-agent 隔离）。

**注意**：SDK `skills: string[]` 的元素是 Skill 的目录名（即 packageName）。`loadGroupAgentDefinition` 里 `resourceName = m.resource_id`（即 packageName），字段映射对齐。

### C. `web/src/pages/AgentStudioPage.tsx` — UI 改造

**改动 1：详情面板名称/描述可编辑**（line 132-135 替换）：

```tsx
<div className="min-w-0 flex-1">
  <input
    className="w-full text-lg font-semibold truncate bg-transparent border-b border-transparent hover:border-border focus:border-teal-500 outline-none"
    defaultValue={selected.name}
    placeholder="Agent 名称"
    onBlur={(e) => {
      const v = e.target.value.trim();
      if (v && v !== selected.name) {
        update(selected.id, { name: v }).then((ok) => ok && toast.success('已保存'));
      }
    }}
  />
  <textarea
    className="w-full text-sm text-muted-foreground bg-transparent border-b border-transparent hover:border-border focus:border-teal-500 outline-none resize-none mt-0.5"
    rows={2}
    defaultValue={selected.description ?? ''}
    placeholder="点击编辑描述…"
    onBlur={(e) => {
      const v = e.target.value;
      if (v !== (selected.description ?? '')) {
        update(selected.id, { description: v }).then((ok) => ok && toast.success('已保存'));
      }
    }}
  />
</div>
```

**改动 2：创建弹窗加描述输入框**（在 line 298 之后插入）：

```tsx
<textarea
  className="w-full px-3 py-2 border rounded-md bg-background text-sm"
  rows={2}
  placeholder="描述（可空，留空则后续在详情面板编辑）"
  value={description}
  onChange={(e) => setDescription(e.target.value)}
/>
```

并新增 `const [description, setDescription] = useState('');`，`handleCreate` 的 `create({...})` 加 `description: description || undefined`，创建成功后 `setDescription('')` 重置。

**改动 3：MountsSection 的 Skill 列表空时给跳转入口**（line 396 附近）：

```tsx
{opts.length === 0 ? (
  <div className="text-xs text-muted-foreground">
    暂无可挂载 Skill。前往{' '}
    <a href="/skills" className="text-teal-600 hover:underline">Skills 管理页</a>
    {' '}安装后刷新本页面即可挂载。
  </div>
) : ( ... )}
```

### D. `web/src/stores/agents-paas.ts` — 类型对齐

检查 `AgentDefinition` 的 TS 接口与 `update` 的 patch payload 类型，确保 `description` 在 patch 时能通过类型校验（现状已支持，但需要确认 `create` 的 payload 类型也包含 `description?`）。

---

## 风险与权衡

1. **覆盖工作区 CLAUDE.md 的副作用**：如果用户在 `data/groups/{folder}/CLAUDE.md` 里已经写了重要记忆，绑定 Agent 后第一次运行会被覆盖。
   - 缓解：覆盖时不动 `data/sessions/{folder}/` 下的记忆；只写工作区 CLAUDE.md，且提示 Agent 把记忆写到 `MEMORY.md`。
   - 兜底：test chat 组工作区初始为空，生产组绑定 Agent 是显式动作，用户预期就是"Agent 身份生效"。

2. **`skills: string[]` 的 SDK 行为**：SDK `skills` 选项取数组时，只启用指定名称的 Skill；若名称不存在，SDK 会静默跳过。需要验证 Skill 目录名（packageName）与 `resource_id` 一致——`loadUserSkillsMeta` 返回 `id: s.packageName`，所以 `m.resource_id === packageName`，对齐。

3. **atomcode 引擎不处理**：本次修复只覆盖 `engine: 'claude'`。atomcode 引擎的 System Prompt 注入路径不同（在 `atomcode-engine.ts`），暂不在范围内。文档中标注。

4. **回归风险**：
   - `skills: 'all' → skills: [list]` 只在 Agent 有 Skill 挂载时触发，无挂载走原路径，不回归。
   - 写工作区 CLAUDE.md 只在 Agent 有 systemPrompt 时触发，无 systemPrompt 走原路径，不回归。
   - UI 改动均为新增 onBlur / 新增字段，不影响其他组件。

## 验证计划

1. **typecheck**：`make typecheck` 三端全绿。
2. **手工 E2E**（浏览器 + curl）：
   - 创建 Agent：`POST /api/paas/agents`，systemPrompt="你是小红，一位热心肠的中文写作助手"。
   - 调 `POST /api/paas/agents/:id/test-chat`，记录 folder。
   - `POST /api/groups/web:agent-test-.../messages`（或浏览器发"你是谁"），验证回复含"小红"、不含"DeepThink"。
   - 改名 `PATCH /api/paas/agents/:id { name: "我的写作助手" }`，描述 `description: "中文写作"`，刷新页面验证持久化。
   - 在 `/skills` 安装 `anthropic/think`，回 `/agents` 挂载该 Skill，触发一次测试对话，检查 `agent-runner` 日志含 `Agent definition applied: ... mounts=N (mcp=0, kb=0, skill=1)` 且 `skills` 选项为数组（可选：通过 `DEEPTHINK_DUMP_PROMPT=true` 验证）。
3. **不回归**：已有无 systemPrompt 的 Agent + 无 Skill 挂载的 Agent，行为不变。
