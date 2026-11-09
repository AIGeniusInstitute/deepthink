# 技术方案：Agent Runtime SDK —— 把「用户 Agent + DeepThink 运行时」打包成可依赖的 SDK

> 状态：已评审立项（2026-11-09）。PRD 见 [`docs/prd/agent-runtime-sdk/PRD.md`](../../prd/agent-runtime-sdk/PRD.md)（M0 = MVP 完整可用）。
> 命题：Agent Studio 创建的 agent 目前只能通过开放平台 HTTP 接口对外服务，外部客户被迫依赖 DeepThink 平台部署。目标是把「用户自定义 agent + 完整运行时（agentloop + skills + MCP 工具能力包）」整体打包成 SDK，客户直接依赖即可使用。

---

## 0. 结论先行

**可行性高，且代码基础比预期好**：

1. 开放平台 AaaS 的执行核（`src/open-platform/agent-service.ts`）只有约 200 行（`resolveAgent` + `buildQueryOptions` + SDK `query()`），**与平台调度面（group-queue / container-runner / Redis）完全解耦**，天然适合抽库。
2. agent-runner 中约 60% 的代码（stream-processor、reminder-engine、autonomy-recovery、gap-resolver、session-history、trace-node-allocator）**完全自包含**，是 agentloop 能力包的最佳来源。
3. Desktop / Android 两条打包先例已经解决了「Node 运行时 + native ABI + claude CLI 依赖链」的全部难题，打包清单可直接复用。

**但不能简单搬目录**，需要一次「切面抽取」：

- 执行层抽 4 个接口：**HostBridge**（工具回连）/ **OutputSink**（输出协议）/ **MemoryStore**（记忆持久化）/ **PromptPack**（身份与提示词）；
- 发布物抽 1 个格式：**AgentBundle**（agent 定义 + **内联资源本体**，消除现有 export 只复制指针的缺口）。

推荐形态：**npm SDK 核心（进程内嵌入）+ 可选 sidecar 运行时包（跨语言）**，两者共享同一 AgentBundle 格式。M0（MVP）只交付前者，但四接口的抽象边界在 M0 就定型，避免后续重构。

---

## 1. 现状调研结论（源码证据）

### 1.1 今天有两条执行路径，耦合度天差地别

| | Web/IM 路径 | 开放平台 AaaS 路径 |
|---|---|---|
| 链路 | `/api/messages` → group-queue（Redis LPUSH）→ `container-runner.ts`（2829 行）→ `container/agent-runner`（独立进程，stdin/stdout + 文件 IPC） | `POST /v1/agents/:id/chat/completions`（`src/routes/open-platform.ts:227`）→ `agent-service.ts` **进程内**直接 SDK `query()` |
| 执行核 | `container/agent-runner/src/index.ts`（3694 行，会话循环 + resume + 截断续写 + autonomous + 引擎分发） | `agent-service.ts:137-222,276`（约 200 行） |
| 能力覆盖 | 完整：38 个 MCP 工具、skills/KB 注入、多轮会话、5 引擎 | 部分：MCP + workers 注入；**skill/KB 不注入**（`agent-service.ts:81` 只取 `mcp_server` mount）；**多轮不透传**（只取 messages 最后一条 user 文本，`open-platform.ts:244-248`，无 session 续接） |
| 平台依赖 | DB + Redis + 容器调度 + IPC 消费者 | 仅 DB 读定义 + 本地工作区 + LLM 凭据（+ 可选 MCP 子进程）；计费/监控/校验均为可剥离旁路 |

**SDK 执行核选型结论**：以 AaaS 的装配层（`resolveAgent`/`buildQueryOptions`）+ agent-runner 的会话循环能力（resume、截断续写、压缩后续写、reminder、autonomous 刹车）合成 SDK core——即「轻装配 + 重会话」，补齐 AaaS 的 skill/KB/多轮缺口。

### 1.2 agent-runner 平台耦合矩阵（SDK 化改造的靶子）

| 耦合度 | 模块 | 说明 |
|---|---|---|
| 自包含（直接复用） | `stream-processor.ts`、`reminder-engine.ts`、`autonomy-recovery.ts`、`gap-resolver.ts`、`session-history.ts`、`trace-node-allocator.ts`、`utils.ts` 部分 | 纯逻辑 + 回调注入，零 I/O 或仅本地 fs |
| 低耦合 | `web-search.ts`（shared 同步源，可插拔 provider）、`image-detector.ts`、`i18n-directive.ts`、4 个备选引擎 adapter | 配置注入即可 |
| 高耦合（需抽象） | `mcp-tools.ts`（38 工具中 22 个回连宿主 IPC）、`mcp-bridge.ts`（与 mcp-tools 约 300 行 ×2 重复实现）、`index.ts` 编排层、`prompts/*.md`（DeepThink 品牌身份） | 见 §3 四接口抽取 |
| 隐性平台依赖 | MCP Registry 自注入（`src/mcp-utils.ts:99-110` 自动挂平台自身 HTTP MCP）、`redis-ipc.ts` 频道命名 | SDK 中条件裁剪 |

### 1.3 Agent 定义打包的最大缺口：mounts 是指针不是本体

现有三套「导出」机制（版本快照 `agent_definition_versions`、marketplace `agent_template`、share install）**同构**：都是 `{def 字段, mounts:[{resource_type, resource_id}]}` 的**指针复制**。资源本体分散在：

| 能力 | 引用 | 本体物理位置 |
|---|---|---|
| Skills | `agent_mounts` | `DATA_DIR/skills/{userId}/{skillId}/SKILL.md(+files)`、`container/skills/`、DB `skills` 表 |
| MCP servers | `agent_mounts` | `DATA_DIR/mcp-servers/{userId}/servers.json`（env 常含密钥） |
| 知识库 | `agent_mounts` | DB `knowledge_bases/kb_documents/kb_chunks`（含 embedding BLOB） |
| Plugins | **无 per-agent 维度**（仅用户级 `plugins.json`） | `DATA_DIR/plugins/catalog/.../versions/{contentHash}/` 不可变快照 |
| Workers（编排） | `agent_worker_links` | 各自 `agent_definitions` 行 |

跨用户/跨环境安装后 `resource_id` 悬空（share install 注释自认 "mount records are just pointers"，`src/routes/paas-share.ts:93-102`）。**AgentBundle 必须内联资源本体**，这是 SDK 自包含的前提。

### 1.4 打包先例可复用清单（Desktop / Android / Docker 已趟平的坑）

1. **资产五件套**：backend dist（含 `copy-runtime-assets.cjs` 显式枚举的 `pty-worker.cjs` 等隐性资产）+ agent-runner dist/prompts/package.json + node_modules + config 模板——`desktop/build/*.json` extraResources 与 android payload staging 两套清单互相印证；
2. **启动契约**：`spawn(nodeBinary, [entry])` + `DEEPTHINK_*` env + `/api/health` 就绪探针 + Supervisor 崩溃退避（`desktop/src/backend-supervisor.ts`）；
3. **Node 运行时分发**：官方 node 二进制版本锁定 + native 模块 `npm rebuild` ABI 对齐 + **binding 加载自检**三步曲（`docs/issues/2026-08-21-desktop-dmg-better-sqlite3-missing.md` 教训）；
4. **claude CLI 依赖链**：`@anthropic-ai/claude-code` npm 落盘（postinstall 可能被 allow-scripts 拦成 ~500 字节 stub，`resolveBundledClaudeCli`/`isRealExecutable` 魔数校验是必备防御，`index.ts:214-255`）+ PATH 顺序（`.bin` 前置）+ `CLAUDE_CONFIG_DIR`/`IS_SANDBOX` 环境契约 + 非 glibc 平台 patchelf 配方；
5. **外部工具位图**：agent-browser / feishu-cli / uv / headroom（`scripts/install-host-tools.sh` 是现成的「宿主工具补齐清单」）；
6. **教训**：SDK `"*"` + 无 lock 的永远最新策略是最大不稳定性来源；国内镜像三件套；隐性运行资产必须显式化。

---

## 2. 总体架构

### 2.1 三层产物

```
┌────────────────────────────────────────────────────────┐
│  AgentBundle（发布物，.tar.gz / 目录）                    │
│  agent 定义 + 内联 skills/MCP/KB/plugins/workers         │
│  + manifest（能力声明、密钥引用、运行时约束）              │
└────────────────────────┬───────────────────────────────┘
                         │ Agent.fromBundle()
┌────────────────────────▼───────────────────────────────┐
│  @deepthink/agent-sdk（npm 核心库，进程内嵌入）           │
│  agentloop 核心：会话循环 / resume / 流式 / 压缩续写      │
│  / reminder / autonomous 刹车 / StreamEvent 事件流       │
│  + 4 个可注入接口（HostBridge/OutputSink/MemoryStore/    │
│    PromptPack）+ 内置自包含工具集                         │
└────────────────────────┬───────────────────────────────┘
                         │ 可选包装
┌────────────────────────▼───────────────────────────────┐
│  Runtime Kit（可选，sidecar 形态）                        │
│  Node 二进制 + claude CLI + 平台工具（browser/搜索等）    │
│  → 跨语言客户（Python/Java/Go）经 stdio/本地 HTTP 调用    │
└────────────────────────────────────────────────────────┘
```

- **AgentBundle**：解决「用户 agent 是什么」的自包含序列化（§4）。
- **@deepthink/agent-sdk**：解决「怎么跑」的可嵌入运行时（§3），Node.js 进程内库，客户 `npm i` 即用。
- **Runtime Kit**：解决「非 Node 客户 / 不想管依赖」的场景（§5.3），本质是 android/desktop 先例的通用化——带 Node 的自包含 sidecar。M0 不交付，但 bundle 格式与启动契约为其预留。

### 2.2 能力分级（Tier 0/1/2，决定 bundle 体积与依赖面）

| Tier | 能力 | 依赖 | 工具来源 | M0 |
|---|---|---|---|---|
| **T0 核心 agentloop** | prompt+model+流式+多轮会话+resume+压缩续写+reminder | 仅 `@anthropic-ai/claude-agent-sdk` + `@anthropic-ai/claude-code` | 自包含工具：`web_fetch`、`web_search`、`disk_*`、`memory_*`（纯本地实现，零 IPC） | ✅ |
| **T1 能力包** | + skills 发现/调用 + 用户 MCP servers（stdio/http/sse） | + skills 目录装配 + MCP 子进程 | SDK 装配 | ✅ |
| **T2 平台工具** | + `send_message`/`schedule_task`/`sandbox_*`/`install_skill` 等宿主工具 | HostBridge 回调由客户实现 | 未实现即不注册 | ❌ 接口预留 |

分级即白名单：SDK 启动时按「bundle 要求 ∩ 客户实现」生成工具集，**未实现的 HostBridge 能力对应的工具直接不注册**（而不是注册后报错），符合 Simplicity First。

---

## 3. SDK 核心：四个切面接口（源码级改造）

### 3.1 接口定义

```ts
// ===== HostBridge：工具回连（合并 mcp-tools.ts 与 mcp-bridge.ts 的两份重复实现）=====
interface HostBridge {
  // fire-and-forget（原 IPC messages/ 目录）
  notify(channel: 'message' | 'image' | 'file' | 'group-register', payload: unknown): void
  // 请求-响应（原 IPC tasks/ 目录 + 30s 超时语义）
  request<T>(type: 'schedule_task' | 'list_tasks' | 'kb_search' | 'sandbox_*' | ...,
             payload: unknown, opts?: { timeoutMs?: number }): Promise<T>
  // 输入与 sentinel（原 input/ 目录 + _close/_drain/_interrupt）
  onMessage(handler: (msg: InjectedMessage) => void): Unsubscribe
  onSignal(sig: 'close' | 'drain' | 'interrupt', handler: () => void): Unsubscribe
}
// M0：只定义接口 + 一个 no-op 默认实现（T2 工具不注册）；
// M1：FileHostBridge（现有文件 IPC 协议，兼容旧容器模式）+ 客户自定义实现。

// ===== OutputSink：输出协议（替代 stdout marker 流）=====
interface OutputSink {
  emit(out: ContainerOutput): void   // status/result/streamEvent/newSessionId/...
}
// M0 实现：CallbackSink（onEvent/onResult 回调）——即 SDK API 本体
// M1 补：AsyncIterableSink；进程包装器 StdoutMarkerSink（兼容现有 container-runner）

// ===== MemoryStore：记忆与持久化布局 =====
interface MemoryStore {
  appendDaily(date: string, content: string): Promise<void>      // memory_append
  searchDaily(query: string): Promise<MemoryHit[]>               // memory_search
  editGlobalMemory(content: string): Promise<void>               // 全局 CLAUDE.md flush
  archiveConversation(md: string): Promise<void>                 // PreCompact 归档
}
// M0 实现：FileMemoryStore（{workspaceGlobal, workspaceMemory, workspaceGroup} 三路径文件布局）

// ===== PromptPack：身份与提示词（去 DeepThink 品牌耦合）=====
interface PromptPack {
  baseSystemPrompt(): string                 // 替代 prompts/*.md 硬编码身份
  identityOverride(agentDef): string         // <agent-definition> + identity-override 拼装
  channelGuidelines?(jid: string): string    // 渠道格式提示（IM 场景可选）
}
// M0 实现：NeutralPromptPack（无品牌；system prompt 以 bundle prompts/system.md 为准）
// M1：DeepThinkPromptPack（平台自用，行为不变）
```

### 3.2 源码改造映射

| 改造点 | 现状 | 目标 | M0 动作 |
|---|---|---|---|
| 执行核复用 | `agent-service.ts` 装配层 + agent-runner 会话循环 | SDK core 共享源码（不复制） | 抽 `sdk/` 子项目，import 复用或搬移自包含模块 |
| OutputSink | `index.ts:628-646 writeOutput` stdout marker | 事件回调为一等公民 | CallbackSink 即 API |
| MemoryStore | memory_* 工具直写 `{workspaceMemory}` 目录 | 接口化，默认文件实现 | FileMemoryStore |
| PromptPack | `prompts/*.md` 12 个 + DeepThink 身份 | 参数化生成器 | NeutralPromptPack + bundle 固化 prompt |
| HostBridge | mcp-tools/mcp-bridge 两份重复实现 | 合并单一 `host-bridge.ts` | 仅接口 + no-op；T2 工具不进 MVP |
| SDK 版本 | `"*"` + 无 lock | semver 锁定 + lock | M0 起锁定 |
| AaaS 缺口 | skill/KB 不注入、无多轮续接 | 走 agent-runner 的 mount 消费逻辑 + MessageStream 多轮 | skill/MCP 注入 + 多轮进 MVP |
| 导出 | 三套指针复制机制 | AgentBundle 内联本体 | `POST /api/paas/agents/:id/export` + 按钮 |

### 3.3 SDK API 形态（客户视角）

```ts
import { Agent } from '@deepthink/agent-sdk'

// 1) 加载 bundle（一次）
const agent = await Agent.fromBundle('./my-agent.bundle', {
  credentials: { apiKey: process.env.ANTHROPIC_API_KEY, baseUrl?, model? },
  workspace: './data/my-agent',          // 文件布局：sessions/conversations/memory
  onEvent: (e) => renderStream(e),        // StreamEvent（shared/stream-event.ts 原类型）
  // host: {...}                          // T2 工具 M1 起按需实现，不实现则不暴露
})

// 2) 会话（多轮）
const session = await agent.start({
  prompt: '帮我分析这份报告',
  images: [{ data, mimeType }],
})
const reply1 = await session.wait()       // { text, usage, sessionId, ... }
session.send('继续，重点看第三节')          // 同会话注入（原 IPC input 语义）
session.interrupt()                        // 原 _interrupt 语义
await session.close()                      // 原 _close 语义；resume 跨进程续接

// 3) 一次性调用（对应今天 AaaS 的语义）
const r = await agent.run('一句话总结')
```

**兼容承诺**：`StreamEvent` 沿用 `shared/stream-event.ts` 单一真相源（`make sync-types` 增加 `sdk/src/` 同步目标，CI 直跑 `./scripts/check-stream-event-sync.sh`）。

---

## 4. AgentBundle 格式（发布物序列化）

### 4.1 目录布局

```
my-agent.bundle/                  # 发布时打 .tar.gz + sha256
  manifest.json                   # schemaVersion / 能力声明 / 密钥引用 / 兼容 SDK 版本范围
  agent.json                      # AgentSnapshot 扩展（db.ts:13595 起的形状 + validation）
  prompts/system.md               # 最终 system prompt（导出时已拼装 <agent-definition> 块）
  skills/{skillId}/SKILL.md[+files]# skill 本体内联（含 userInvocable/allowedTools 元数据）
  mcp/servers.json                # McpServerEntry 本体；env 值 → "${ENV:VAR_NAME}" 引用
  knowledge/{kbId}/...            # （M2）KB 文档内联
  plugins/...                     # （M2/M4）catalog snapshot 内联
  agents/{workerId}.json          # （M2）workers 递归定义
  SIGNATURE                       # （M4）发布方签名
```

### 4.2 manifest.json 关键字段

```jsonc
{
  "schemaVersion": 1,
  "agent": { "id": "…", "name": "…", "kind": "assistant|orchestrator" },
  "requires": { "tier": "T0|T1", "hostTools": [] },
  "secrets": [ { "ref": "${ENV:MY_API_KEY}", "usedBy": "mcp/foo", "optional": false } ],
  "runtime": {
    "engines": ["claude"], "sdkRange": "^1.0.0", "nodeRange": ">=22",
    // —— Android/移动预留字段（M0 只写不消费，向前兼容）——
    "platform": "any|desktop|mobile",        // 资源可移植性声明，导出时可选「移动友好」过滤
    "mcpDeps": { "foo": "pure-js|node|native|system" }  // 每个 MCP server 的依赖形态
  },
  "contentHash": "sha256:…"       // 覆盖全部资源文件，安装时校验（确定性打包）
}
```

> **Bundle × Android 路径**：bundle 是纯数据（运行时无关），Android 端的执行运行时 = android-single-apk 的嵌入式 libnode（Node v22.23.2）+ `@deepthink/agent-sdk` 同一个 npm 包（在 runtime.tar.zst 的 node_modules 里）。即「android-single-apk 运行时包 + AgentBundle = Android 版 Agent SDK」，与 §5.3 Runtime Kit 是同一模式（带 Node 的自包含运行时 + bundle）的两个实例。适配点只有三个，且都不进 bundle 本体：① stdio MCP 需纯 JS（系统二进制型在设备上不可用，故 manifest 加 `mcpDeps` 声明）；② claude CLI 的 bionic/glibc patchelf 配方属于运行时包（android-on-device 已验证）；③ T2 平台工具与 sandbox/browser 在移动端同样裁剪。android-single-apk M2 之后可直接消费 bundle，M0 只做格式预留、不做专门开发。

### 4.3 导出与安装（平台侧新增）

- **导出**：`POST /api/paas/agents/:id/export` → 读 `agent_definitions` + `agent_mounts` → **展开资源本体**（skill 目录全量、servers.json 条目脱敏）→ 确定性组装（固定文件顺序、mtime 归一，保证 contentHash 可重现）→ `.tar.gz` + sha256。AgentDetailPage 加「导出 SDK Bundle」按钮。
- **脱敏**：mcp env / headers 值导出时替换为 `${ENV:...}` 引用占位，manifest.secrets 声明客户需提供的凭据；TC-1.3 全文扫描兜底。
- **安装**：`Agent.fromBundle` 解压 → contentHash 校验 → secrets 解析 → 装配 skills / MCP → 就绪。secret 缺失显式报错列清单。

### 4.4 与现有机制的关系

| 现有机制 | 关系 |
|---|---|
| `AgentSnapshot`（版本快照） | Bundle 的 `agent.json` 是其超集（+validation +资源本体引用） |
| marketplace / share install | 继续走指针复制；同一导出器未来可服务「携带本体」模式（M2） |
| Plugins / KB / Workers | 非 M0 目标；bundle 格式预留目录位 |

---

## 5. 打包与分发

### 5.1 npm 核心包（主形态）

- **包名**：`@deepthink/agent-sdk`（新子项目 `sdk/`，与主服务/web/agent-runner/desktop 平级的第 5 个 Node 项目）。
- **依赖策略**：`@anthropic-ai/claude-agent-sdk` **semver 锁定 + lock 文件**（杜绝 `"*"` 漂移）；`@anthropic-ai/claude-code` 为依赖（T0 需要其 CLI），安装后跑 `isRealExecutable` 语义的自检 + 文档明示 allow-scripts。
- **native 模块**：M0 **零 native 依赖**（KB 不在范围；会话持久化用 JSONL 文件，不引 better-sqlite3）。
- **共享代码**：`make sync-types` 增加 `sdk/src/` 同步目标（shared/ 四真相源）。
- **M0 消费方式**：`npm pack` 产出 tarball（`make sdk-pack`），客户本地/私有 registry 安装；npm registry 正式发布管线属 M3。

### 5.2 与宿主代码的边界（避免行为漂移）

原则：**SDK core 与平台共用同一份执行核源码**，不复制。落法：

- 会话循环核心（runQuery + MessageStream + StreamEventProcessor + 自包含模块）抽为库形态（`sdk/` import agent-runner 的 lib 入口或共享包），agent-runner 的进程入口 `dist/index.js` 继续走 StdoutMarkerSink + FileHostBridge；
- 消除 AaaS/Web 已出现的能力漂移（skill/KB/多轮差异）在 SDK 上重演：**同一核心、两种包装**。

### 5.3 Runtime Kit（M4，可选 sidecar）

Node 二进制 + agent-sdk + claude CLI + bundle + 启动器；stdio JSONL 或本地 loopback HTTP（OpenAI 兼容子集）；就绪探针 + 崩溃退避照搬 `backend-supervisor.ts`。

### 5.4 平台工具与外部能力的裁剪

- T2 工具 M0 不注册；M1 起以 HostBridge 回调暴露；
- 可选能力包（后续）：`@deepthink/agent-tools-browser`、`@deepthink/agent-tools-search`；
- feishu-cli / IM 渠道能力**不进 SDK**（平台集成面）。

---

## 6. 分阶段实施路线

| 里程碑 | 内容 | 验收标准 |
|---|---|---|
| **M0 = MVP 完整可用（本次交付）** | F1 bundle 格式 + F2 导出 + F3 SDK 核心（会话/resume）+ F4 流式 + F5 skills + F6 MCP + F7 自包含工具 + F8 身份中性 + F9 文档示例 + F10 回归 | PRD §5 全部 P0 用例 + §2 成功标准真人走查（详见 PRD） |
| M0.1 | F1 + F2 | TC-1.x、TC-2.x |
| M0.2 | F3 + F4 + F8 | TC-3.x、TC-4.x、TC-8.1 |
| M0.3 | F5 + F6 + F7 | TC-5.x、TC-6.x、TC-7.x |
| M0.4 | F9 + F10 | TC-9.1、TC-10.1 → MVP 验收 |
| **M1** | HostBridge/OutputSink/MemoryStore 全量实现、T2 平台工具、mcp-tools/mcp-bridge 去重、DeepThinkPromptPack | 平台 `make test` 全绿 + T2 工具回调用例 |
| **M2** | KB/plugins/workers 打包、secrets 完备、bundle 校验脚本 | 复合 agent 全链路用例 |
| **M3** | npm 发布管线（CI 兼容矩阵）、正式发布 | 客户 10 分钟上手 |
| **M4** | Runtime Kit sidecar（Python SDK）、bundle 签名 | 跨语言客户跑通 |

**门禁**：每阶段保持 `make test` 全绿（150 文件 / 1734 用例基线）；`./scripts/check-stream-event-sync.sh` 直跑（覆盖 sdk/ 新目标）。

---

## 7. 安全与凭据

1. **密钥不进包**：MCP env/headers 导出即脱敏为 `${ENV:...}`；manifest.secrets 声明；TC-1.3 全文扫描。
2. **权限模型**：不沿用 AaaS 的 `bypassPermissions`——SDK 默认 `default` 权限模式，客户可显式选择。
3. **bundle 完整性**：contentHash 必校验；确定性打包保证可重现；（M4）签名。
4. **供应链**：SDK 版本锁定 + `check-sdk-bundle.sh` 发布清单断言（必含项缺一即失败、禁含密钥明文，照 `scripts/check-android-payload.sh` 模式）。

## 8. 风险与对策

| 风险 | 等级 | 对策 |
|---|---|---|
| Claude Agent SDK API 漂移（`"*"` + 0.3.x 私有行为） | 高 | semver 锁定 + lock + 兼容性用例随版本升级跑 |
| SDK 与平台执行核行为漂移 | 高 | 同一核心源码两种包装（§5.2） |
| 密钥泄漏进 bundle | 高 | 强制脱敏 + TC-1.3 + 校验脚本 |
| claude CLI postinstall stub → ENOEXEC | 中 | 魔数自检 + 文档 + 可操作报错 |
| native ABI 不匹配 | 低（M0 零 native） | 后续引入时预编译 platform 包 + 加载自检 |
| 文档走查不达标（30 分钟） | 中 | M0.4 非开发执行人实测，失败回补再验 |

## 9. 决策记录

| 决策 | 结论 |
|---|---|
| M0 定位 | 从「spike」升级为「MVP 完整可用」（用户拍板 2026-11-09），范围 = T0+T1 |
| npm scope | `@deepthink/agent-sdk`（若企业发布需换 scope，M3 前可改） |
| KB/Plugins/Workers | 推迟 M2；bundle 格式预留目录位 |
| Runtime Kit | 无明确非 Node 客户前推迟 M4 |
| 多轮语义 | 走 MessageStream 会话循环（不是 AaaS 的「只取最后一条」） |
| bundle × Android | bundle 纯数据可直接进 Android；执行靠 android-single-apk 嵌入式 libnode 运行时 + 同一 npm SDK。M0 只做 manifest `platform`/`mcpDeps` 字段预留（只写不消费），Android 专门开发等 android-single-apk M2 后另行立项 |

## 附录：调研依据

- 开放平台 AaaS 链路：`src/routes/open-platform*.ts`、`src/open-platform/*`（执行核 `agent-service.ts` 仅 ~200 行；计费/监控/校验为旁路）
- agent-runner 依赖面：`container/agent-runner/src/*`（23 文件；6 个自包含模块；38 工具的 A/B/C/D 回连分类）
- Agent 定义与资源：`src/routes/paas-agents.ts`、`agent_mounts`（db.ts:1199）、`AgentSnapshot`（db.ts:13595）、marketplace/share 的指针复制语义
- 打包先例：`desktop/build/*.json` extraResources 五件套、`desktop/src/backend-supervisor.ts`、android-single-apk S1 spike（node 启动器 ELF）、`container/Dockerfile` + `entrypoint.sh` 环境契约、`scripts/install-host-tools.sh`
