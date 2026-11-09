# PRD：Agent Runtime SDK —— 把「用户 Agent + DeepThink 运行时」打包成 SDK（M0 = MVP 完整可用）

| 项 | 值 |
|---|---|
| 需求名 | agent-runtime-sdk |
| 里程碑 | **M0 —— MVP 完整可用**（本 PRD 为 M0 的立项范围；M1+ 见 §8 路线图） |
| 状态 | 已立项（2026-11-09） |
| 技术方案 | [`docs/tech_solution/agent-runtime-sdk/TECH_SOLUTION.md`](../../tech_solution/agent-runtime-sdk/TECH_SOLUTION.md) |
| 分支 | `worktree-agent-runtime-sdk` |

---

## 1. 背景

Agent Studio 创建的 agent 目前对外服务只有「开放平台 HTTP 接口」（`/v1/agents/:id/chat/completions`）一种方式，外部服务被迫依赖 DeepThink 平台的部署、鉴权、计费与网络可达性。

需求：把用户自己创建的 agent，连同 DeepThink 的运行时（agentloop + skills + MCP 工具能力包）**整体打包成 SDK**，客户在自己的应用里 `npm install` 后直接依赖即可使用，**无需部署 DeepThink 平台**。

调研结论（详见技术方案 §1）：执行核（`src/open-platform/agent-service.ts`，约 200 行）与平台调度面完全解耦；agent-runner 约 60% 代码自包含；打包所需资产清单已被 Desktop/Android 先例验证。可行性高，MVP 可在现有代码基础上抽取成型。

## 2. 目标与成功标准

**目标**：客户仅凭 Node.js ≥ 22 与 LLM API key，在干净环境中完成「安装 SDK → 载入 Agent Bundle → 流式多轮对话并调用 skill / MCP 工具」的完整闭环，全程不接触 DeepThink 平台。

**MVP 整体成功标准**（Goal-Driven，可验证）：

> 一名没接触过 DeepThink 的 Node.js 开发者，按 `examples/quickstart` 文档操作，**30 分钟内**：
> ① `npm install` SDK（tarball）；② 载入从 Agent Studio 导出的 Agent Bundle；③ 跑通一场**流式、多轮**对话；④ 观察到 agent 至少调用了 1 个 skill 和 1 个 MCP 工具；⑤ 杀掉进程重开后对话上下文可续接（resume）。
> 全程零 DeepThink 部署、零 IPC、零平台 HTTP 调用。

## 3. 角色与场景

| 角色 | 场景 |
|---|---|
| Agent 作者（DeepThink 用户） | 在 Agent Studio 配好 agent（prompt + skills + MCP），点「导出 SDK Bundle」拿到 `.tar.gz` 交给集成方 |
| 集成方开发者 | 在自己的 Node 服务/CLI 里 `import { Agent } from '@deepthink/agent-sdk'`，载入 bundle，把 agent 能力嵌进自己的产品 |
| 平台管理员 | 不需要为外部客户提供平台部署；开放平台 HTTP 接口继续保留（两条服务形态并存） |

## 4. MVP 范围（T0 核心 agentloop + T1 能力包）

**本里程碑交付**：AgentBundle 格式与导出 + `@deepthink/agent-sdk` 核心库 + skills/MCP/自包含工具 + 文档示例。

### 4.1 功能点与验收标准

> 每个功能点的验收标准为**硬性退出条件**，逐条可验证；测试用例见 §5。

#### F1 AgentBundle 格式 v1（发布物序列化）

- 内容：`manifest.json`（schemaVersion、requires.tier、secrets 引用声明、sdkRange、contentHash；**预留 Android 字段** `runtime.platform` / `runtime.mcpDeps`——只写不消费，向前兼容）、`agent.json`（agent 定义全字段 + validation 5 字段）、`prompts/system.md`（最终 system prompt，所见即所得）、`skills/{skillId}/`（SKILL.md 全文 + 目录文件）、`mcp/servers.json`（McpServerEntry 本体，env 值脱敏为 `${ENV:VAR}` 引用）。
- **验收标准**：
  - A1.1 目录结构与 manifest schema 符合规范（提供 JSON schema 并校验）。
  - A1.2 contentHash 覆盖全部资源文件；任一文件被篡改后 `fromBundle` 拒绝加载并报明确错误。
  - A1.3 bundle 内**不出现明文密钥**：导出时 MCP env/headers 值全部替换为 `${ENV:...}` 引用，且有自动化断言兜底。

#### F2 平台导出（API + UI）

- 内容：`POST /api/paas/agents/:id/export` 返回 bundle `.tar.gz` + sha256；AgentDetailPage 增加「导出 SDK Bundle」按钮；导出展开 `agent_mounts` 的资源本体（skill 目录、MCP 配置）。
- **验收标准**：
  - A2.1 对「挂载 ≥1 个 skill + ≥1 个 MCP server」的 agent，一次导出得到可加载的完整 bundle。
  - A2.2 权限：仅 agent 所有者或 admin 可导出；他人调用返回 403。
  - A2.3 确定性：同一 agent 状态下重复导出，contentHash 一致（打包时间戳等可变字段不参与 hash）。

#### F3 SDK 核心运行时（加载 + 会话 + resume）

- 内容：`Agent.fromBundle(path, { credentials, workspace, onEvent, host? })`；`agent.start({ prompt, images? })` 返回 session；`session.send()`（同会话注入）、`session.wait()`、`session.interrupt()`、`session.close()`；`agent.run(prompt)` 一次性调用。会话状态（sessionId、transcript）持久化在 `workspace/` 下。
- **验收标准**：
  - A3.1 单轮调用返回最终文本与 usage，错误（key 无效等）有明确可编程错误类型。
  - A3.2 多轮：同一 session 连续 3 轮对话，agent 能引用第 1 轮内容（上下文保持）。
  - A3.3 `interrupt()` 中断当前回合后 `send()` 可继续，不丢消息。
  - A3.4 resume：同一 `workspace/` 重新 `fromBundle` + `start`，能续接此前会话上下文（跨进程）。
  - A3.5 运行全程不依赖任何 DeepThink 平台进程/端口/数据库（可断网至仅 LLM API 可达时验证）。

#### F4 流式事件（StreamEvent）

- 内容：`onEvent` 回调接收 `StreamEvent`（沿用 `shared/stream-event.ts` 单一真相源，构建时同步进 sdk/），至少覆盖 `text_delta`、`thinking_delta`、`tool_use_start/end`、`tool_progress`、`status`、`result`。
- **验收标准**：
  - A4.1 流式过程中客户端可持续渲染增量文本（事件序列完整、有序、结束有终态事件）。
  - A4.2 `shared/stream-event.ts` 与 sdk 内副本一致性由 `./scripts/check-stream-event-sync.sh` 校验（CI 直跑）。

#### F5 Skills 能力

- 内容：bundle 内联 skill 装配进运行时（对应 agent_runner 的 `options.skills` 白名单消费逻辑），agent 可发现并调用 skill；保持 SKILL.md 的 `allowed-tools` 约束。
- **验收标准**：
  - A5.1 agent 在会话中能触发 bundle 内联 skill 并按 skill 指令完成任务（e2e 可观测到 skill 调用事件）。
  - A5.2 bundle 外的 skill 不可见（白名单收敛）。

#### F6 MCP 工具能力

- 内容：bundle 内联 MCP servers 装配（stdio 与 http/sse 两种 transport），`${ENV:...}` 密钥引用在 `fromBundle` 时解析注入。
- **验收标准**：
  - A6.1 stdio 型 MCP server 的工具在会话中可被调用并返回结果（e2e 可观测到工具调用）。
  - A6.2 http/sse 型 MCP server 至少一种 transport 跑通用例。
  - A6.3 必需 secret 缺失时 `fromBundle` 显式报错并列缺失引用清单（不静默降级）。

#### F7 自包含工具包（零 IPC）

- 内容：`web_fetch`、`web_search`（可选凭据，复用 `shared/web-search.ts` 可插拔 provider）、`disk_*`（工作区文件操作，含路径穿越防护）、`memory_*`（workspace 内文件记忆）。
- **验收标准**：
  - A7.1 四类工具在无宿主环境下全部可用（本地实现，无 IPC 回连）。
  - A7.2 `disk_*` 对 `../` 路径穿越尝试拒绝并报错（复用/对齐现有防护语义）。

#### F8 PromptPack 身份中性

- 内容：SDK 默认使用无品牌 `PromptPack`（neutral）；导出时把最终 system prompt 固化进 `prompts/system.md`。
- **验收标准**：
  - A8.1 运行时系统提示词与 bundle 内 `prompts/system.md` 一致；无 DeepThink 平台身份/品牌泄漏（自动化断言扫描关键字）。

#### F9 文档与示例（快速上手闭环）

- 内容：`sdk/README.md`（安装、鉴权、能力分级、HostBridge 指南占位）、`examples/quickstart`（10 分钟跑通示例）、bundle 导出→消费操作手册。
- **验收标准**：
  - A9.1 一名测试执行人**只按文档**（不看源码）完成 §2 成功标准的 ①–⑤ 全流程。
  - A9.2 示例代码可直接复制运行（含错误处理示范：secret 缺失、bundle 篡改）。

#### F10 回归保障（平台行为不变）

- 内容：本次改造对平台是**加性**的（导出为新端点；执行核抽取不改变 container-runner / agent-runner 行为）。
- **验收标准**：
  - A10.1 `make test` 全绿（基线：150 文件 / 1734 用例，1719 passed / 14 skipped；已知抖动仅 `tests/feishu-card.test.ts` 偶发超时）。
  - A10.2 `make typecheck` 三端（后端/前端/agent-runner）通过；新增 sdk/ 后端口无破坏。

### 4.2 非目标（M0 明确不做）

| 非目标 | 推迟至 |
|---|---|
| T2 平台宿主工具（`send_message`/`schedule_task`/`sandbox_*`/`kb_search` 等 HostBridge 回调工具） | M1（接口预留，M0 不注册这些工具） |
| 知识库（KB）内联与本地检索 | M2 |
| Plugins 打包（per-agent 粒度） | M2/M4 |
| Orchestrator-Workers（多 agent 编排）递归打包 | M2 |
| Runtime Kit sidecar（Python/Java/Go 跨语言） | M4 |
| npm registry 正式发布管线（M0 以 `npm pack` tarball 消费） | M3 |
| Bundle 签名、版本快照随包 | M4 |
| 非 Claude 引擎（atomcode/codex/opencode/pi） | 暂不支持（manifest `runtime.engines: ["claude"]`） |
| Android 端专门开发（bundle 在 M0 仅格式预留 `platform`/`mcpDeps` 字段） | android-single-apk M2 后另行立项（bundle 纯数据可直接被嵌入式 libnode 运行时 + 同一 npm SDK 消费，见技术方案 §4.2） |

## 5. 测试用例

> TC 编号与功能点对应；执行方式：vitest（单测）+ `tests/e2e/` 脚本（e2e，需真实 API key，CI 可选跑）。P0 = MVP 阻塞项。

| 编号 | F | 级别 | 用例 | 步骤摘要 | 预期 |
|---|---|---|---|---|---|
| TC-1.1 | F1 | P0 | bundle 结构与 schema | 导出样例 agent → 校验目录结构 + manifest schema | 全部必含项存在且合法 |
| TC-1.2 | F1 | P0 | 篡改检测 | 构造 bundle → 改动 skills 一字节 → fromBundle | 加载失败，错误含 contentHash 不匹配 |
| TC-1.3 | F1 | P0 | 密钥脱敏 | 构造含 `API_KEY=sk-real` 的 MCP env → 导出 → 全文扫描 | 包内无 `sk-real` 明文；manifest.secrets 声明该引用 |
| TC-2.1 | F2 | P0 | 导出 API happy path | 登录 owner → POST /export | 200，tar.gz + sha256，可被 fromBundle 加载 |
| TC-2.2 | F2 | P0 | 导出越权 | 其他 member 调用 | 403 |
| TC-2.3 | F2 | P1 | 导出确定性 | 同状态导出两次比对 contentHash | 一致 |
| TC-3.1 | F3 | P0 | 单轮调用 | fromBundle → run('…') | 返回文本 + usage；无效 key 抛凭证错误 |
| TC-3.2 | F3 | P0 | 多轮上下文 | 同 session 3 轮，第 1 轮埋一个独特词 | 第 3 轮 agent 能复述该词 |
| TC-3.3 | F3 | P0 | 中断与继续 | 长任务中 interrupt() → send('继续') | 中断生效、后续消息被处理、无消息丢失 |
| TC-3.4 | F3 | P0 | 跨进程 resume | 跑 2 轮 → 进程退出 → 新进程同 workspace start | 第 3 轮能引用第 1 轮内容 |
| TC-3.5 | F3 | P0 | 无平台依赖 | 断网（仅放行 LLM API 域名）跑全流程 | 正常完成 |
| TC-4.1 | F4 | P0 | 流式事件序列 | onEvent 记录完整一回合 | 事件有序、text_delta 可拼出全文、有终态 |
| TC-4.2 | F4 | P0 | 类型同步门禁 | 直跑 `./scripts/check-stream-event-sync.sh` | exit 0 |
| TC-5.1 | F5 | P0 | skill 调用 | bundle 含「格式化输出」类 skill，提问触发 | e2e 可见 skill 调用事件，输出符合 skill 约定 |
| TC-5.2 | F5 | P1 | skill 白名单 | 同机放置 bundle 外 skill | 会话中不可发现 |
| TC-6.1 | F6 | P0 | stdio MCP | bundle 含 stdio MCP（如 echo server）提问触发 | 工具调用成功、结果回传 |
| TC-6.2 | F6 | P1 | http MCP | bundle 含 http MCP server | 同上 |
| TC-6.3 | F6 | P0 | secret 缺失 | 移除必需 env 后 fromBundle | 显式报错 + 缺失清单 |
| TC-7.1 | F7 | P0 | 自包含工具 | 分别触发 web_fetch / web_search / disk_list / memory_append | 四类工具均可用（web_search 无凭据时明确降级提示） |
| TC-7.2 | F7 | P0 | 路径穿越防护 | disk_download 传 `../../etc/passwd` | 拒绝并报错 |
| TC-8.1 | F8 | P0 | 身份中性 | 抓取运行时 system prompt 断言 | 与 prompts/system.md 一致，无 DeepThink 品牌词 |
| TC-9.1 | F9 | P0 | 文档可用性 | 按 §2 成功标准由测试执行人走全流程 | 30 分钟内完成 ①–⑤ |
| TC-10.1 | F10 | P0 | 平台回归 | `make test` + `make typecheck` | 全绿（基线允许项除外） |

## 6. 里程碑与验收节奏（M0 内部）

| 阶段 | 内容 | 出口条件 |
|---|---|---|
| M0.1 | F1 + F2（bundle 格式 + 导出） | TC-1.x、TC-2.x 通过 |
| M0.2 | F3 + F4 + F8（SDK 核心 + 流式 + 身份中性） | TC-3.x、TC-4.x、TC-8.1 通过 |
| M0.3 | F5 + F6 + F7（skills + MCP + 自包含工具） | TC-5.x、TC-6.x、TC-7.x 通过 |
| M0.4 | F9 + F10（文档示例 + 回归） | TC-9.1、TC-10.1 通过 → **MVP 验收** |

MVP 验收 = §5 全部 P0 用例通过 + §2 成功标准由真人按文档复核一遍（记录到 `docs/test_report/agent-runtime-sdk/`）。

## 7. 风险

| 风险 | 应对 |
|---|---|
| Claude Agent SDK `"*"` 版本漂移破坏会话/resume 私有行为 | SDK 内 semver 锁定 + 锁文件；升级走显式 PR + 兼容性用例 |
| 密钥泄漏进 bundle | 导出器强制脱敏 + TC-1.3 全文扫描断言 + 校验脚本 |
| 执行核抽取意外改变平台行为 | 加性改造原则 + TC-10.1 全量回归门禁 |
| claude CLI postinstall 被 allow-scripts 拦成 stub | 保留魔数自检（`isRealExecutable` 语义）+ 文档明示 + 可操作报错 |
| 文档走查失败（30 分钟目标） | M0.4 由非开发执行人实测，失败回补文档再验 |

## 8. 路线图（M0 之后，非本次交付）

M1：HostBridge/OutputSink/MemoryStore 四接口全量抽取、T2 平台工具回调、mcp-tools/mcp-bridge 去重 → M2：KB/plugins/workers 打包 → M3：npm 发布管线 → M4：Runtime Kit sidecar / 签名。详见技术方案 §6。

## 9. 测试用例与验收记录

执行结果与证据（命令输出、e2e 日志、文档走查记录）统一写入 `docs/test_report/agent-runtime-sdk/TEST_REPORT.md`，执行状态写入 `docs/task_state/agent-runtime-sdk/TASK_STATE.md`。
