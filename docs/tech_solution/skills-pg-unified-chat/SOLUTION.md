# 技术方案 — skills-pg-unified-chat

## 架构判断

### FP1：数据存储层
DeepThink 已有 PG 兼容层（`sqlite-compat.ts` + `pg-sync-driver.ts` worker_threads 同步桥 + `sql-translator.ts` 方言翻译）。`DATABASE_URL=postgresql://` 触发 PG 模式。**无需新建数据层**——真实缺口是缺 `skills` 表。

**决策**：
- skills 全量入 PG（新建 `skills` 表 + 6 个内置种子）。
- 工作区产物 blob 不入 PG（反模式），元数据入 `workspace_artifacts` 表，blob 留对象存储（MinIO，已 bind-mount）。
- Docker 数据盘改 bind-mount（`./data/pg`、`./data/deepthink`、`./data/redis`、`./data/minio`）。

### FP2：运行时挂载注入——5 点管线
核心约束：per-turn 挂载（对话下拉选的）需到达**冷启动路径**（agent-runner stdin JSON）。复用既有 `agentDefinition.mounts` 通道（MCP/KB）+ systemPrompt 内容注入（skills）。

**为何 skills 走 systemPrompt 而非 skillsOption 白名单**：agent-runner 的 `skillsOption` 白名单需容器内磁盘 SKILL.md 文件（`resourceName=packageName`→`~/.claude/skills/`）。DB 存的内置办公技能在容器内无磁盘文件，只能把 content 注入 systemPrompt。

**数据流**（in-memory 桥，免 DB 列变更）：
```
Web 下拉 → chat-mounts store（persist）
  → sendMessage POST body.selectedMounts
  → schemas.ts 校验
  → web.ts handleWebUserMessage opts.selectedMounts
  → deps.setPendingTurnMounts(msgId)  [in-memory Map，免 DB 列]
  → index.ts processGroupMessages popPendingTurnMounts(lastProcessed.id)
  → ContainerInput.turnMounts
  → container-runner applyTurnMounts(agentDef, turnMounts, ownerUserId)
    - skills → getSkillContents() → append systemPrompt
    - mcp → loadUserMcpServers() → mounts[]
    - kb → getKnowledgeBase() 所有权校验 → mounts[]
  → agent-runner 消费 agentDefinition.mounts + systemPrompt（零改动）
```

**为何 in-memory Map 而非 DB 列**：`autonomous` 字段走 DB 列需 7 站点改动（schema/storeMessage/getMessagesSince/normalize/types/ContainerInput）。`selectedMounts` 是结构化对象（非 0/1 标量），存 JSON TEXT 列 + 全链路解析成本高。in-memory Map 仅 4 站点（WebDeps/index.ts/container-runner + type），web-UI-only 来源无需持久化，进程重启丢失可接受（与 autonomous 同 cold-start 语义）。

### FP3：UI 外科手术
- 删 `LoopModeSwitcher` 渲染 + `LoopForm` 分支（6 模式 chip 消失；/goal /loop /proactive /adaptive /skill_evolution slash 命令仍可用）。
- `ChatToolbar` = OfficeSkillsBar（6 快捷按钮）+ 3 MultiSelectDropdown。
- `MessageInput` 加 `prefillSignal` prop（nonce 触发追加文本+聚焦）。

## 关键设计决策
1. **Surgical Changes**：不重构 turn_start drain（M18 HTTP self-call 先例），agent-runner 零改动（mounts + systemPrompt 既有消费通道）。
2. **Simplicity First**：in-memory Map 免 DB 列变更；skills 内容注入免磁盘 SKILL.md；不引入 forwardRef（用 prefillSignal prop）。
3. **zustand 稳定引用**：selector 返回稳定 EMPTY 常量，避免 React #185 无限重渲染。

## 文件清单
| 文件 | 改动 |
|---|---|
| `deploy/docker/docker-compose.yml` | PG bind-mount + DATABASE_URL |
| `deploy/local/docker-compose.yml` | bind-mount |
| `src/db.ts` | skills 表 + workspace_artifacts 表 + seedBuiltinSkills + 4 helpers + SCHEMA_VERSION=61 |
| `src/routes/skills.ts` | GET /api/skills/builtin + Skill source='builtin' |
| `src/schemas.ts` | MessageCreateSchema.selectedMounts |
| `src/web-context.ts` | WebDeps.setPendingTurnMounts + SelectedMounts 类型 |
| `src/web.ts` | handleWebUserMessage opts.selectedMounts + setPendingTurnMounts 调用 |
| `src/index.ts` | pendingTurnMounts Map + popPendingTurnMounts + processGroupMessages 注入 turnMounts |
| `src/container-runner.ts` | ContainerInput.turnMounts + applyTurnMounts() + docker/host 接线 |
| `web/src/stores/chat-mounts.ts` | 新建 per-group 挂载 store |
| `web/src/stores/chat.ts` | sendMessage selectedMounts |
| `web/src/stores/skills.ts` | Skill source + quick 字段 |
| `web/src/components/chat/ChatToolbar.tsx` | 新建 办公快捷栏 + 3 下拉 |
| `web/src/components/chat/ChatView.tsx` | 删 LoopModeSwitcher + 加 ChatToolbar + prefillSignal |
| `web/src/components/chat/MessageInput.tsx` | prefillSignal prop |
| `web/src/components/skills/SkillCard.tsx` | SOURCE_LABELS 加 builtin |
| `tests/units/skills-db.test.ts` | 新建 6 用例回归 |
