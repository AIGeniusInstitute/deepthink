# 技术方案: 斜杠命令 / 推理深度 effort / 执行过程 DAG 可视化

- **分支**: `feat/slash-effort-dag`
- **关联 PRD**: `docs/prd/slash-effort-dag/PRD.md`

## 0. 设计原则

严格遵守 4 原则：
1. **Think Before Coding**：本方案先明确假设与边界，再写代码。
2. **Simplicity First**：能复用现有表的字段不新建表；能用 Zustand 内存状态不引入全局 store；reactflow 走动态 import 不进主 bundle。
3. **Surgical Changes**：只改与三特性直接相关的文件，不顺手重构相邻代码。
4. **Goal-Driven Execution**：每模块列成功条件，PRD §5 为最终验收。

## 1. 关键假设

| 编号 | 假设 | 验证方式 |
|------|------|---------|
| A1 | SDK `supportedCommands()` 可在 agent-runner 启动时调用并返回当前 provider 下可用命令 | 在 agent-runner init 阶段 try/catch 调用，失败时不阻塞主流程 |
| A2 | SDK `query()` 接受 `options.effort` 字段（`'low'\|'medium'\|'high'\|'xhigh'\|'max'`） | sdk.d.ts:87、1613 已确认 |
| A3 | `traceNode` 字段当前未被 stream-processor 填充，需我们手动发射 | grep traceNode in stream-processor.ts 为空 |
| A4 | `loop_trace_nodes` 表存在但强绑定 `loop_run_id`，不能直接用于普通对话 DAG | db.ts:379 schema 校验 |
| A5 | reactflow 体积约 200KB gzip，动态 import 后不影响首屏 | Vite splitChunks 自动拆分 |
| A6 | 主进程 `src/index.ts` 的 stream_event 处理路径已能透传 traceNode 到前端 | shared/stream-event.ts 字段已存在，主进程只做 passthrough |

## 2. 总体架构

```
┌────────────────────────────────────────────────────────────┐
│ 前端 (web/)                                                │
│  ├─ MessageInput.tsx       [新增] / 触发 Popover + 键盘交互│
│  ├─ ContainerEnvPanel.tsx  [修改] 新增 effort 下拉选择器   │
│  ├─ ChatView.tsx           [修改] 右侧侧栏新增 "DAG" Tab   │
│  ├─ DagView.tsx            [新增] reactflow 画布           │
│  ├─ DagNodeDetail.tsx      [新增] 节点详情 + 编辑 + 重跑   │
│  ├─ chat.ts (store)        [修改] 缓存 supportedCommands、 │
│  │                               traceNodes、当前 effort   │
│  └─ slash-commands.ts      [新增] 命令列表合并工具         │
└────────────────────────────────────────────────────────────┘
                         ↑ HTTP / WS
┌────────────────────────────────────────────────────────────┐
│ 后端 (src/)                                                │
│  ├─ routes/chat.ts (或groups.ts) [修改] /api/chat/trace    │
│  │      - GET  /:chatJid/nodes  列出节点                  │
│  │      - PUT  /:chatJid/nodes/:id/annotation 保存注解     │
│  │      - POST /:chatJid/nodes/:id/rerun  重跑/续跑        │
│  ├─ db.ts                  [修改] 新增 chat_trace_nodes 表 │
│  └─ chat-trace-store.ts    [新增] 节点持久化纯函数          │
└────────────────────────────────────────────────────────────┘
                         ↑ IPC / env file
┌────────────────────────────────────────────────────────────┐
│ Agent Runner (container/agent-runner/)                     │
│  ├─ index.ts               [修改] 启动调用 supportedCommands│
│  │      发送 init 事件携带 commands[]                       │
│  │      query() options 读取 CLAUDE_EFFORT                  │
│  ├─ stream-processor.ts    [修改] 在 tool_use_start/end、   │
│  │      task_start、subagent 事件中填充 traceNode           │
│  └─ types.ts               [修改] 新增 SlashCommandList     │
│      stream event                                           │
└────────────────────────────────────────────────────────────┘
```

## 3. 模块详细设计

### 3.1 斜杠命令（Slash Commands）

#### 3.1.1 数据源

Agent Runner 启动时调用 SDK `supportedCommands()`，结果合并到 init 流式事件：

```ts
// container/agent-runner/src/index.ts (新增片段，在 init system message 处理后)
let cachedSlashCommands: { name: string; description: string; argumentHint: string }[] = [];
try {
  const cmds = await query({}) /* ❌ 不可行 — supportedCommands 是 SDK 实例方法 */
} catch {}
```

实际上 `supportedCommands()` 是 SDK `internal` 模块的方法，agent-runner 当前通过 `query()` 单一入口与 SDK 交互，未持有 SDK 实例。**对策**：改用更轻量的路径——前端在加载 Skills 时已获取 user/project/external skills 列表（含 `name`、`description`、`argumentHint`），直接作为斜杠命令数据源；SDK 内置命令（`/clear`、`/cost` 等）使用一份静态 fallback 列表，避免引入 SDK 内部 API 依赖。

```ts
// web/src/lib/slash-commands.ts (新增)
const BUILTIN_SLASH_COMMANDS = [
  { name: 'clear', description: '清空当前会话上下文', argumentHint: '' },
  { name: 'cost', description: '查看本次会话 token 消耗', argumentHint: '' },
  { name: 'skills', description: '列出当前可用 Skills', argumentHint: '' },
  { name: 'recall', description: '总结最近对话', argumentHint: '' },
  { name: 'list', description: '查看所有工作区', argumentHint: '' },
  { name: 'status', description: '查看当前工作区状态', argumentHint: '' },
];

export function buildSlashCommandList(skills: Skill[]): SlashCommandItem[] {
  const fromSkills = skills
    .filter(s => s.userInvocable)
    .map(s => ({
      name: s.name,
      description: s.description,
      argumentHint: s.argumentHint || '',
      source: 'skill' as const,
    }));
  return [
    ...BUILTIN_SLASH_COMMANDS.map(c => ({ ...c, source: 'builtin' as const })),
    ...fromSkills,
  ];
}
```

#### 3.1.2 输入框交互

修改 `web/src/components/chat/MessageInput.tsx`：

```tsx
// 新增状态
const [slashOpen, setSlashOpen] = useState(false);
const [slashIndex, setSlashIndex] = useState(0);
const slashCommands = useMemo(() => buildSlashCommandList(skills), [skills]);
const slashFiltered = useMemo(() => {
  const text = inputValue;
  // 检查光标前是否是 / 开头的命令片段
  const uptoCursor = text.slice(0, cursorPos);
  const match = uptoCursor.match(/(?:^|\s)(\/[a-zA-Z0-9_-]*)$/);
  if (!match) return [];
  const q = match[2].slice(1).toLowerCase(); // 去掉 /
  return slashCommands.filter(c => c.name.toLowerCase().startsWith(q));
}, [inputValue, cursorPos, slashCommands]);

// handleKeyDown 新增
if (slashOpen && slashFiltered.length > 0) {
  if (e.key === 'ArrowDown') { e.preventDefault(); setSlashIndex(i => (i + 1) % slashFiltered.length); return; }
  if (e.key === 'ArrowUp')   { e.preventDefault(); setSlashIndex(i => (i - 1 + slashFiltered.length) % slashFiltered.length); return; }
  if (e.key === 'Tab' || (e.key === 'Enter' && !slashIMEComposing)) {
    e.preventDefault();
    const cmd = slashFiltered[slashIndex];
    const text = inputValue;
    const uptoCursor = text.slice(0, cursorPos);
    const match = uptoCursor.match(/(?:^|\s)(\/[a-zA-Z0-9_-]*)$/)!;
    const prefix = uptoCursor.slice(0, match.index! + match[1].length - match[2].length);
    const newInput = prefix + '/' + cmd.name + (cmd.argumentHint ? ' ' : '') + text.slice(cursorPos);
    setInputValue(newInput);
    setSlashOpen(false);
    return;
  }
  if (e.key === 'Escape') { e.preventDefault(); setSlashOpen(false); return; }
}
```

Popover 渲染：相对 textarea 的绝对定位浮层，当前选中项高亮。

#### 3.1.3 命令执行

补全后用户按 Enter 发送，命令作为普通文本进入消息流。后端 `src/index.ts` 的 `handleCommand()` 已处理 `/clear`、`/list`、`/recall` 等；其他命令名（如 Skills）按普通消息处理，由 Agent 自行识别并触发对应 Skill。**不引入新的命令分发逻辑**。

### 3.2 推理深度 effort

#### 3.2.1 前端选择器

修改 `web/src/components/chat/ContainerEnvPanel.tsx`：

```tsx
const EFFORT_ENV_KEY = 'CLAUDE_EFFORT';
const EFFORT_OPTIONS = [
  { value: 'low', label: 'Low (快速回答)' },
  { value: 'medium', label: 'Medium (默认)' },
  { value: 'high', label: 'High (深度思考)' },
  { value: 'xhigh', label: 'XHigh (极深推理)' },
  { value: 'max', label: 'Max (最大预算)' },
];

// 在 state 加载时特殊处理 EFFORT_ENV_KEY（与 MODEL_ENV_KEY 同级特殊处理）
// 在面板渲染时新增一个下拉选择器，紧邻模型选择器
```

`saveCustomEnv` 把 `CLAUDE_EFFORT` 写入 `customEnv`，走现有 `PUT /api/groups/:jid/container-env` 路径，无需新增后端接口。

#### 3.2.2 Agent Runner 读取

修改 `container/agent-runner/src/index.ts`：

```ts
const CLAUDE_EFFORT = (process.env.CLAUDE_EFFORT?.trim() || '') as
  | '' | 'low' | 'medium' | 'high' | 'xhigh' | 'max';

// query() 调用处
const q = query({
  prompt: stream,
  options: {
    // ... 现有字段
    model: CLAUDE_MODEL,
    ...(CLAUDE_EFFORT ? { effort: CLAUDE_EFFORT } : {}),
    // ... 其他字段
  },
});
```

**校验**：`effort` 仅在非空时传入，避免覆盖 SDK 默认行为。

### 3.3 DAG 可视化

#### 3.3.1 数据库

新增表 `chat_trace_nodes`（`src/db.ts` schema migration v→v+1）：

```sql
CREATE TABLE IF NOT EXISTS chat_trace_nodes (
  id INTEGER PRIMARY KEY AUTOINCREMENT,        -- 与 stream event nodeId 一致
  chat_jid TEXT NOT NULL,
  session_id TEXT,
  parent_node_id INTEGER,
  node_type TEXT NOT NULL CHECK(node_type IN ('turn','tool','review','goal_check','skill','subagent')),
  title TEXT,
  input_summary TEXT,
  output_summary TEXT,
  tokens INTEGER NOT NULL DEFAULT 0,
  status TEXT,
  annotation_input TEXT,                       -- 用户编辑的输入注解
  annotation_output TEXT,                      -- 用户编辑的输出注解
  started_at TEXT NOT NULL,
  ended_at TEXT,
  UNIQUE(chat_jid, id)
);
CREATE INDEX IF NOT EXISTS idx_chat_trace_jid ON chat_trace_nodes(chat_jid, started_at);
CREATE INDEX IF NOT EXISTS idx_chat_trace_parent ON chat_trace_nodes(parent_node_id);
```

注：`id` 列由 agent-runner 在单次会话内自增分配（与 stream event `traceNode.nodeId` 对齐），主进程持久化时直接使用该 id，`UNIQUE(chat_jid, id)` 约束保证幂等 upsert。

#### 3.3.2 traceNode 发射

修改 `container/agent-runner/src/stream-processor.ts`：

- 在 `tool_use_start` 处理分支：分配新 nodeId，parentNodeId 取当前 turn 的 nodeId，`nodeType='tool'`，`status='running'`，`inputSummary=toolInputSummary`。
- 在 `tool_use_end` 处理分支：更新该 tool 节点 `status='done'`，`outputSummary=toolOutputSummary`，`ended_at`，`tokens`。
- 在 `task_start` 处理分支：分配新 nodeId，`nodeType='subagent'`，`status='running'`。
- 在 turn 开始（系统消息 init 之后第一条 assistant 消息）：分配 `nodeType='turn'` 根节点。

发射的 StreamEvent 带 `traceNode` 字段，主进程 `src/index.ts` 的 stream_event 透传路径无需改动（已透传全部字段）。

主进程新增持久化钩子（在 stream_event 广播前调用）：

```ts
// src/index.ts (新增片段，在 stream_event 广播前)
if (event.type === 'tool_use_start' || event.type === 'tool_use_end' ||
    event.type === 'task_start' || event.type === 'text_delta') {
  if (event.traceNode) {
    upsertChatTraceNode(chatJid, event.traceNode).catch(err => log.warn(err));
  }
}
```

#### 3.3.3 后端 API

新增路由（挂在 `src/routes/groups.ts` 或新建 `src/routes/chat-trace.ts`）：

| 方法 | 路径 | 用途 |
|------|------|------|
| GET | `/api/groups/:jid/trace/nodes` | 列出该会话全部节点 |
| PUT | `/api/groups/:jid/trace/nodes/:id/annotation` | 保存 input/output 注解 |
| POST | `/api/groups/:jid/trace/nodes/:id/rerun` | 重跑或续跑（`{mode: 'rerun'\|'continue'}`） |

重跑实现：后端把节点的 `input_summary`（或 `annotation_input` 若存在）作为新的 user 消息入队 `queue.enqueueMessageCheck()`，与普通消息走同一处理路径。`mode='continue'` 时附带 metadata `continue_from_node_id` 写入消息附件字段（前端展示用，agent-runner 当前不消费该字段，UI 上标注即可）。

#### 3.3.4 前端 DAG Tab

修改 `web/src/components/chat/ChatView.tsx`：

```tsx
const SIDEBAR_TABS = [
  { id: 'files' as const, icon: FolderOpen, label: '文件管理' },
  { id: 'env' as const, icon: Variable, label: '环境变量' },
  { id: 'skills' as const, icon: Puzzle, label: '工作区 Skills' },
  { id: 'mcp' as const, icon: Server, label: '工作区 MCP' },
  { id: 'dag' as const, icon: Workflow, label: '执行 DAG' },  // 新增
  { id: 'members' as const, icon: Users, label: '成员' },
];
type SidebarTab = 'files' | 'env' | 'skills' | 'mcp' | 'dag' | 'members';
```

新增组件 `web/src/components/chat/DagView.tsx`：

```tsx
const ReactFlow = lazy(() => import('@xyflow/react').then(m => ({ default: m.ReactFlow })));

export function DagView({ chatJid }: { chatJid: string }) {
  const nodes = useChatStore(s => s.traceNodes[chatJid] || []);
  // 转换为 reactflow nodes/edges
  // 节点 type 自定义 NodeComponent，按 nodeType 上色
  // 点击节点 → setSelectedNodeId → 弹出 DagNodeDetail
}
```

Zustand store `chat.ts` 新增：

```ts
traceNodes: Record<string, TraceNode[]>;  // keyed by chatJid
selectedNodeId: number | null;
upsertTraceNode(chatJid, node);   // 流式事件增量 upsert
clearTraceNodes(chatJid);          // 切换会话时清理
```

#### 3.3.5 节点详情与编辑

新增 `web/src/components/chat/DagNodeDetail.tsx`：

- 展示 `nodeId / nodeType / parentNodeId / status / tokens / started_at / ended_at`
- `inputSummary` 和 `outputSummary` 为 textarea，初始值为 `annotation_input || inputSummary`
- "保存注解" 按钮 → `PUT /api/groups/:jid/trace/nodes/:id/annotation`
- "重跑此节点" 按钮 → 确认框 → `POST .../rerun { mode: 'rerun' }` → 切回 chat Tab
- "从此续跑" 按钮 → 确认框 → `POST .../rerun { mode: 'continue' }`

#### 3.3.6 reactflow 依赖

```bash
cd web && npm install @xyflow/react
```

`@xyflow/react` 是 reactflow 12 的官方包名。仅在 DagView 中动态 import，不进入主 bundle。

## 4. 改动文件清单

### 后端 (src/)
| 文件 | 改动 |
|------|------|
| `src/db.ts` | 新增 `chat_trace_nodes` 表 schema + migration |
| `src/chat-trace-store.ts` (新) | `upsertChatTraceNode`、`listChatTraceNodes`、`saveAnnotation` 纯函数 |
| `src/routes/chat-trace.ts` (新) | 3 个 API 路由 |
| `src/index.ts` | stream_event 透传时调用 upsertChatTraceNode |
| `src/web.ts` | 挂载 `/api/groups/:jid/trace` 路由 |

### Agent Runner (container/agent-runner/)
| 文件 | 改动 |
|------|------|
| `container/agent-runner/src/index.ts` | 读取 `CLAUDE_EFFORT` 环境变量并传入 `query({ effort })` |
| `container/agent-runner/src/stream-processor.ts` | 在 tool_use_start/end、task_start、turn 开始处填充 traceNode |

### 前端 (web/)
| 文件 | 改动 |
|------|------|
| `web/package.json` | 新增 `@xyflow/react` 依赖 |
| `web/src/lib/slash-commands.ts` (新) | `buildSlashCommandList` |
| `web/src/components/chat/MessageInput.tsx` | `/` 触发 Popover + 键盘交互 |
| `web/src/components/chat/ContainerEnvPanel.tsx` | effort 下拉选择器 |
| `web/src/components/chat/ChatView.tsx` | SIDEBAR_TABS 新增 `dag` |
| `web/src/components/chat/DagView.tsx` (新) | reactflow 画布 |
| `web/src/components/chat/DagNodeDetail.tsx` (新) | 节点详情与编辑 |
| `web/src/stores/chat.ts` | traceNodes 状态、upsertTraceNode |

### 测试 (tests/)
| 文件 | 改动 |
|------|------|
| `tests/chat-trace-store.test.ts` (新) | upsert、list、annotation 持久化 |
| `tests/slash-commands.test.ts` (新) | buildSlashCommandList 合并逻辑 |

## 5. 成功条件（每模块）

| 模块 | 验证 |
|------|------|
| 斜杠命令 | 输入 `/` 弹面板；`↑↓` 切换；`Tab` 补全；`Esc` 关闭；`/cl` 过滤到 clear/cost |
| effort | 切换 `low`/`high` 后 agent-runner 日志可见 `effort: '...'`；不传时无 effort 字段 |
| DAG 表 | `make migrate` 成功；`make test` 通过；upsert 幂等 |
| traceNode 发射 | 触发工具调用后 stream_event 中带 `traceNode.nodeId`；主进程 DB 中有行 |
| DAG 渲染 | 切到 DAG Tab 画布渲染；节点颜色按 nodeType 区分；流式实时增量 |
| 节点详情 | 点击节点弹出；编辑 input/output 保存后刷新仍可见 |
| 重跑 | 点击"重跑此节点"后对话页出现新回合，消息内容为节点 input |
| typecheck | `make typecheck` 三端通过 |
| 测试 | `make test` 全绿 |

## 6. 实施顺序

1. **DB 表 + chat-trace-store + 单测**（基础设施，不依赖其他模块）
2. **agent-runner effort 读取**（最小改动，独立可验）
3. **前端 effort 选择器**（与 2 联调）
4. **agent-runner traceNode 发射 + 主进程持久化**（基础设施）
5. **前端 slash 命令面板**
6. **前端 DAG Tab + DagView + DagNodeDetail**
7. **重跑/续跑 API + 前端按钮**
8. **E2E 验证 + test_report 文档**
9. **合并 main + push**

## 7. 回滚策略

- 三特性均通过环境变量 `CLAUDE_EFFORT`、前端 Tab 切换、流式事件字段控制，可独立开关。
- `chat_trace_nodes` 表新增不影响现有表；若需回滚，drop 该表即可。
- reactflow 动态 import，移除 DagView 后无副作用。
