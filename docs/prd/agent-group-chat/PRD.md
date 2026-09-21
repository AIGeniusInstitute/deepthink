# 需求规格说明书 (PRD)：DeepThink 多 Agent 群组协作与 Pipeline 可追溯执行面板

**文档版本**: v1.0  
**需求类型**: 平台级新功能  
**关联模块**: Orchestrator–Workers, Team Graph, Agent Studio, GroupQueue, StreamEventProcessor, registered_groups  
**目标版本**: v1.3.0  
**日期**: 2026-09-21  

---

## 目录

1. [背景与问题](#1-背景与问题)
2. [目标与非目标](#2-目标与非目标)
3. [名词定义](#3-名词定义)
4. [典型用户故事](#4-典型用户故事)
5. [功能需求](#5-功能需求)
6. [数据模型](#6-数据模型)
7. [接口与事件协议](#7-接口与事件协议)
8. [状态机](#8-状态机)
9. [关键技术方案要点](#9-关键技术方案要点)
10. [非功能需求](#10-非功能需求)
11. [埋点与成功指标](#11-埋点与成功指标)
12. [风险与对策](#12-风险与对策)
13. [验收标准与测试用例](#13-验收标准与测试用例)
14. [里程碑](#14-里程碑)

---

## 1. 背景与问题

### 1.1 现状盘点

DeepThink v1.2.0 已经具备多智能体能力，但缺少面向人的协作交互层。

**已可复用的资产**：

| 已有能力 | 归属版本 | 本需求如何复用 |
|---------|---------|-------------|
| Orchestrator–Workers 主从编排（agent_workers 表、环检测、buildWorkerAgents） | v1.2.0 | 直接作为群组的执行内核 |
| Team Graph 的 graph_* WS 事件、Gantt 视图、边数据流动画、trace 快照序列 + scrubber | v1.2.0 | Pipeline 面板的事件源与动画基础 |
| graph_definitions（含 owner_user_id）、GraphDefinition 草稿模式 | v1.2.0 | 群组 → 执行图的映射载体 |
| Agent Studio 的 Agent 定义与版本快照（最多 20 版） | v1.2.0 | 群组成员的来源与 pin 版本依据 |
| StreamEventProcessor（30+ 事件、text_delta 200 字缓冲） | v1.0+ | 扩展 group_* 事件族 |
| PreCompact Hook + conversations/ 归档 + sessions/ 持久化 | v1.1.0 | 上下文重建与回放的数据基础 |
| Harness 版本化 manifest + snapshot/diff/eval/promote/rollback | v1.1.0 | 节点 prompt 快照与 fingerprint 计算依据 |
| registered_groups + GroupQueue + IM 连接池 | v1.0+ | 群组的持久化与调度载体（扩展而非新建） |

### 1.2 核心痛点

- **P1 协作不可见**：多 Agent 并行时输出混在单一流里，用户分不清"哪句话是谁说的、基于什么说的"，Agent 之间缺少显式的交接（handoff）语义
- **P2 过程不可追溯**：只有最终产物，中间推理、工具调用、失败重试散落在容器日志里
- **P3 试错成本极高**：链路中第 5 个节点失败 → 只能整条重跑，前面 4 个节点的 token 与时间全部浪费

### 1.3 产品命题

把"用户 ↔ 一个 Agent"的单线对话，升级为"用户 ↔ 一群 Agent"的群聊式协作；并把后台的任务执行链路，以 Pipeline 节点的形式实时呈现在主对话右侧，每个节点可点开看完整 Trace，可从任意节点重跑或回放。

---

## 2. 目标与非目标

### 2.1 目标

- **G1 群组化**：支持创建包含多个 Agent 的协作群组，成员来自 Agent Studio 的已定义 Agent，可 pin 版本、可配职责与权限
- **G2 群聊化**：主对话区以微信群/飞书群的形态呈现多 Agent 协作过程，支持 @ 点名、发言权调度、人类随时插话打断
- **G3 链路可见**：右侧面板实时呈现任务 Pipeline 的节点状态、耗时、成本与负责 Agent，失败节点一眼可见
- **G4 全程可追溯**：任意节点可点开查看完整 Trace（思考、工具调用、上下文、产物、副作用、成本）
- **G5 可定点重跑与回放**：支持从任意节点回放（只读）与重跑（原样 / 编辑后 / 从此处继续），并把副作用控制在可回滚范围内

### 2.2 非目标（本期明确不做）

- 不做运行时由 LLM 自动生成 Agent 角色
- 不做跨租户群组、群组市场与分享
- 不做模型训练、微调或自研推理引擎
- 不承诺跨引擎重跑一致性（仅保证 Claude Code 引擎）
- 不替代 Team Graph 的全屏编排画布

---

## 3. 名词定义

| 名词 | 定义 |
|------|------|
| 群组（Agent Group） | 一个持久化的多 Agent 协作单元，包含 1 个编排者 + N 个成员席位，绑定一个 GraphDefinition |
| 席位（Seat） | 群组中一个 Agent 成员，绑定 Agent 定义 ID + 版本号 + 职责 prompt + 挂载 + 发言策略 |
| 编排者（Orchestrator） | 群组内负责拆解任务、分派 Worker 的 Agent |
| 发言权（Floor） | 某一时刻允许输出的席位，由发言策略调度 |
| Run | 一条消息触发的一次完整链路执行，拥有唯一 run_id |
| Node / NodeRun | Pipeline 中的节点定义 / 该节点在某次 Run 中的一次执行实例 |
| Trace | 一个 NodeRun 的完整执行轨迹事件序列 |
| Replay | 只读回放，按 trace 快照序列逐帧播放 |
| Rerun | 从某节点重新执行，是写操作 |
| Run Fingerprint | 由模型、参数、harness 版本、挂载 hash、工具版本计算的执行指纹 |

---

## 4. 典型用户故事

**S1 协作出方案**：在群组里说"给我出一份 A 功能的 PRD 和技术方案"，@产品经理Agent @架构师Agent @测试Agent。三个 Agent 依次发言、互相补充，右边 Pipeline 显示"需求拆解 → PRD 撰写 → 技术方案 → 测试计划"四个节点进度。

**S2 定点纠偏**："技术方案"节点产出不认可 → 点开节点看完整 Trace → 发现漏洞 → 在群聊里 @架构师Agent "补充对比" → 编辑后重跑该节点 → 下游自动继承新产物。

**S3 失败止损**：第 4 个节点调用外部 API 连续失败 → 面板标红暂停 → 查看 Trace 中 tool_result → 修正后 continue-from-here → 前 3 个节点产物全部复用。

**S4 复盘审计**：一周后回看这次 Run，逐帧回放每个 Agent 的思考链路。

---

## 5. 功能需求

### FR-1 群组创建与成员管理

**FR-1.1 创建入口与方式**
- 入口：工作台「+ 新建」→「多 Agent 群组」；或从 Agent Studio 勾选多个 Agent →「组成群组」
- 三种初始化方式：①空白群组手动添加成员 ②从群组模板创建 ③编排 Agent 生成 GraphDefinition 草稿 + 席位建议 → draft 模式 → 用户确认后保存

**FR-1.2 席位属性**

| 属性 | 说明 |
|------|------|
| Agent 定义 + 版本 | 必填，来自 Agent Studio；默认 pin latest，可 pin 到具体快照版本 |
| 职责 Prompt | 席位级补充人设，与 Agent 定义自身的 system prompt 叠加 |
| 挂载 | MCP Server、Skill、知识库，席位级最小授权 |
| 发言策略 | auto / mention_only / silent |
| 预算上限 | 单次 Run 内 max_turns、token 上限、时间上限 |
| 并发上限 | 该席位同时处理的节点数（默认 1） |

**FR-1.3 编排者配置**
- 每个群组必须且仅有一个编排者
- 成员关联复用 agent_workers 表
- 群组扩展 registered_groups 表：新增 `group_kind` 字段区分 `chat` 与 `swarm`

**FR-1.4 群组管理**
- 成员的增/删/改、席位顺序调整
- 群组模板：保存为模板（含席位配置 + GraphDefinition + 挂载），支持导出/导入 JSON
- 群组级默认配置：默认模型/Provider、默认发言策略、是否允许人类插话

### FR-2 群聊式交互（主对话区）

**FR-2.1 消息气泡类型**

| 类型 | 呈现 |
|------|------|
| 用户消息 | 右侧气泡，支持文本/文件/@提及 |
| Agent 消息 | 左侧气泡，带 Agent 头像、名称、席位角色标签、状态、耗时与 token |
| 系统消息 | 居中灰条：Run 开始/结束、席位加入、预算熔断、人工介入提示 |
| 工具卡片 | 折叠卡片：工具名、入参摘要、结果摘要、耗时、可展开看 raw |
| 交接卡（Handoff） | 显式记录 A → B 的交接 |
| Pipeline 事件卡 | 轻量内联卡片：节点开始/完成/失败 |

**FR-2.2 @ 提及与路由**
- 输入 @ 唤起席位列表
- 明确 @ 一个或多个席位 → 仅被点名者响应
- 未 @ → 交给编排者拆解分派
- @all → 广播

**FR-2.3 发言权调度（Floor Control）**
- orchestrator_driven（默认）：编排者决定下一个发言者
- round_robin：按席位顺序轮询
- free：并行输出，不做顺序控制
- 死循环防护：同一席位连续 N 轮无新增有效产物 → 强制让出并提示

**FR-2.4 人类介入**
- 随时插话：用户新消息 → 在当前节点结束后注入
- 打断/终止：「暂停 / 继续 / 终止」控制
- 定向纠正：@某席位 + 指令 → 补充执行

**FR-2.5 IM 渠道降级策略**
- Web/桌面：完整群聊 + Pipeline 面板
- 飞书/Telegram/QQ/钉钉/微信：降级为线性播报

### FR-3 右侧 Pipeline 面板

**FR-3.1 布局与形态**
- 主对话区右侧常驻面板，默认宽 400px，可折叠、可拖拽调宽
- 面板顶部：Run 概览条——状态、进度、总耗时、总成本、失败数、控制按钮

**FR-3.2 节点卡片**
- 每个节点显示：序号、节点名、负责席位、状态徽标、耗时、token、重试次数、产物摘要
- 状态枚举：pending / running / success / failed / skipped / awaiting_human / cancelled / stale
- 拓扑呈现：线性链路（竖向步骤条）、并行组（并排卡片）、DAG 分支（缩进树）

**FR-3.3 节点操作**
- 悬浮/右键菜单：查看 Trace / 重跑此节点 / 编辑后重跑 / 从此处继续 / 跳过 / 查看产物

### FR-4 节点 Trace 详情

点击节点后的详情面板，默认 720px，分 6 个 Tab：
- **Tab 1 概览**：节点输入/输出契约、执行结果摘要、耗时拆分
- **Tab 2 完整 Trace**：thinking / text / tool_use / tool_result / subagent_call / retry / error 时间线
- **Tab 3 上下文**：执行时上下文窗口内容
- **Tab 4 产物**：diff 视图呈现文件变更
- **Tab 5 副作用与风险**：外部副作用列表
- **Tab 6 成本**：token 明细、模型成本

### FR-5 任意节点重跑与回放

**FR-5.1 回放 Replay（只读，零风险）**
- 基于 trace 快照序列，逐帧/自动播放，播放速度 0.5x–4x

**FR-5.2 重跑 Rerun**
- as-is 原样重跑：同输入、同参数、同挂载
- edit 编辑重跑：允许修改 prompt / 模型 / 参数后执行
- continue 从此处继续：以该节点输出为起点重跑下游

**FR-5.3 作用域**
- node_only / downstream / full
- 下游节点重跑后标记为 stale，用户决定是否级联刷新

**FR-5.4 副作用风险分级**
- 绿（只读）：检索、读取、搜索
- 黄（工作区内写）：自动创建工作区快照
- 红（外部副作用）：弹窗二次确认

---

## 6. 数据模型

### 6.1 表变更概要

**扩展表**：
- `registered_groups`：新增 `group_kind`、`orchestrator_agent_id`、`graph_definition_id`、`floor_policy`、`default_context_mode`、`status`

**新增表**：
- `group_seats`：群组席位
- `group_messages`：群组消息记录
- `pipeline_runs`：Pipeline 执行记录
- `pipeline_node_runs`：节点执行记录
- `trace_events`：Trace 事件（大对象外置）
- `workspace_snapshots`：工作区快照
- `idempotency_keys`：幂等键记录

### 6.2 详细 DDL

```sql
-- v52 migration: register groups extension
ALTER TABLE registered_groups ADD COLUMN group_kind TEXT NOT NULL DEFAULT 'chat' CHECK(group_kind IN ('chat', 'swarm'));
ALTER TABLE registered_groups ADD COLUMN orchestrator_agent_id INTEGER;
ALTER TABLE registered_groups ADD COLUMN graph_definition_id INTEGER;
ALTER TABLE registered_groups ADD COLUMN floor_policy TEXT NOT NULL DEFAULT 'orchestrator_driven' CHECK(floor_policy IN ('orchestrator_driven', 'round_robin', 'free'));
ALTER TABLE registered_groups ADD COLUMN default_context_mode TEXT NOT NULL DEFAULT 'isolated' CHECK(default_context_mode IN ('isolated', 'inherited', 'full_replay'));
ALTER TABLE registered_groups ADD COLUMN swarm_status TEXT DEFAULT 'active' CHECK(swarm_status IN ('active', 'archived'));

-- v52: group_seats
CREATE TABLE IF NOT EXISTS group_seats (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    group_id INTEGER NOT NULL REFERENCES registered_groups(id) ON DELETE CASCADE,
    agent_definition_id INTEGER NOT NULL,
    agent_version TEXT NOT NULL DEFAULT 'latest',
    role_prompt TEXT DEFAULT '',
    speak_policy TEXT NOT NULL DEFAULT 'auto' CHECK(speak_policy IN ('auto', 'mention_only', 'silent')),
    mounts TEXT DEFAULT '{}',
    max_turns INTEGER DEFAULT 10,
    token_budget INTEGER DEFAULT 100000,
    time_budget_ms INTEGER DEFAULT 600000,
    max_parallel INTEGER DEFAULT 1,
    seat_order INTEGER DEFAULT 0,
    created_at TEXT NOT NULL DEFAULT (datetime('now')),
    UNIQUE(group_id, agent_definition_id)
);

CREATE INDEX IF NOT EXISTS idx_group_seats_group ON group_seats(group_id);

-- v52: group_messages
CREATE TABLE IF NOT EXISTS group_messages (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    group_id INTEGER NOT NULL REFERENCES registered_groups(id) ON DELETE CASCADE,
    run_id TEXT,
    node_run_id TEXT,
    sender_type TEXT NOT NULL CHECK(sender_type IN ('user', 'agent', 'system')),
    sender_seat_id INTEGER REFERENCES group_seats(id),
    msg_type TEXT NOT NULL DEFAULT 'text' CHECK(msg_type IN ('text', 'tool_card', 'handoff', 'pipeline_event', 'system')),
    content_ref TEXT,
    mentions TEXT DEFAULT '[]',
    parent_msg_id INTEGER,
    status TEXT DEFAULT 'completed' CHECK(status IN ('thinking', 'tool_exec', 'completed', 'failed')),
    token_in INTEGER DEFAULT 0,
    token_out INTEGER DEFAULT 0,
    duration_ms INTEGER DEFAULT 0,
    created_at TEXT NOT NULL DEFAULT (datetime('now'))
);

CREATE INDEX IF NOT EXISTS idx_group_msgs_group ON group_messages(group_id, created_at);
CREATE INDEX IF NOT EXISTS idx_group_msgs_run ON group_messages(run_id);

-- v53: pipeline_runs
CREATE TABLE IF NOT EXISTS pipeline_runs (
    id TEXT PRIMARY KEY,
    group_id INTEGER NOT NULL REFERENCES registered_groups(id) ON DELETE CASCADE,
    graph_definition_id INTEGER,
    trigger_message_id INTEGER REFERENCES group_messages(id),
    status TEXT NOT NULL DEFAULT 'created' CHECK(status IN ('created','planning','running','paused','completed','failed','cancelled','awaiting_human')),
    context_mode TEXT NOT NULL DEFAULT 'isolated',
    fork_from_run_id TEXT,
    fork_from_node_run_id TEXT,
    total_cost_usd REAL DEFAULT 0,
    total_tokens INTEGER DEFAULT 0,
    started_at TEXT,
    ended_at TEXT,
    created_at TEXT NOT NULL DEFAULT (datetime('now'))
);

CREATE INDEX IF NOT EXISTS idx_pipeline_runs_group ON pipeline_runs(group_id, created_at);

-- v53: pipeline_node_runs
CREATE TABLE IF NOT EXISTS pipeline_node_runs (
    id TEXT PRIMARY KEY,
    run_id TEXT NOT NULL REFERENCES pipeline_runs(id) ON DELETE CASCADE,
    node_id TEXT NOT NULL,
    seat_id INTEGER REFERENCES group_seats(id),
    status TEXT NOT NULL DEFAULT 'pending' CHECK(status IN ('pending','queued','running','success','failed','skipped','cancelled','stale')),
    attempt INTEGER DEFAULT 0,
    input_ref TEXT,
    output_ref TEXT,
    prompt_snapshot_hash TEXT,
    harness_version TEXT,
    model TEXT,
    provider TEXT,
    token_in INTEGER DEFAULT 0,
    token_out INTEGER DEFAULT 0,
    token_cache INTEGER DEFAULT 0,
    duration_ms INTEGER DEFAULT 0,
    error_code TEXT,
    error_message TEXT,
    fingerprint TEXT,
    started_at TEXT,
    ended_at TEXT,
    created_at TEXT NOT NULL DEFAULT (datetime('now'))
);

CREATE INDEX IF NOT EXISTS idx_node_runs_run ON pipeline_node_runs(run_id, node_id);
CREATE INDEX IF NOT EXISTS idx_node_runs_status ON pipeline_node_runs(status);

-- v53: trace_events  
CREATE TABLE IF NOT EXISTS trace_events (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    node_run_id TEXT NOT NULL REFERENCES pipeline_node_runs(id) ON DELETE CASCADE,
    seq INTEGER NOT NULL,
    ts TEXT NOT NULL DEFAULT (datetime('now')),
    event_type TEXT NOT NULL,
    payload_inline TEXT,
    payload_ref TEXT,
    duration_ms INTEGER DEFAULT 0,
    UNIQUE(node_run_id, seq)
);

CREATE INDEX IF NOT EXISTS idx_trace_events_node ON trace_events(node_run_id, seq);

-- v54: workspace_snapshots
CREATE TABLE IF NOT EXISTS workspace_snapshots (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    group_id INTEGER NOT NULL REFERENCES registered_groups(id) ON DELETE CASCADE,
    run_id TEXT REFERENCES pipeline_runs(id),
    node_run_id TEXT REFERENCES pipeline_node_runs(id),
    snapshot_type TEXT NOT NULL DEFAULT 'git' CHECK(snapshot_type IN ('git', 'tar')),
    snapshot_ref TEXT NOT NULL,
    created_at TEXT NOT NULL DEFAULT (datetime('now'))
);

-- v54: idempotency_keys
CREATE TABLE IF NOT EXISTS idempotency_keys (
    key TEXT PRIMARY KEY,
    node_run_id TEXT NOT NULL REFERENCES pipeline_node_runs(id),
    tool_name TEXT,
    first_called_at TEXT NOT NULL DEFAULT (datetime('now')),
    response_ref TEXT
);
```

---

## 7. 接口与事件协议

### 7.1 REST API（新增/扩展）

| 方法 | 路径 | 说明 |
|------|------|------|
| POST | `/api/agent-groups` | 创建群组（含席位与编排者） |
| GET/PATCH/DELETE | `/api/agent-groups/:id` | 群组的查/改/删 |
| GET/POST/PATCH/DELETE | `/api/agent-groups/:id/seats` | 席位管理 |
| POST | `/api/agent-groups/:id/messages` | 发言 |
| GET | `/api/agent-groups/:id/messages` | 分页拉取历史 |
| POST | `/api/agent-groups/:id/runs` | 启动一次链路执行 |
| POST | `/api/runs/:id/control` | pause/resume/cancel |
| GET | `/api/runs/:id/nodes` | Run 的节点状态列表 |
| GET | `/api/node-runs/:id` | 节点执行详情 |
| GET | `/api/node-runs/:id/trace` | 分页/流式获取 trace 事件 |
| POST | `/api/node-runs/:id/rerun` | 节点重跑 |
| GET | `/api/node-runs/:id/diff/:otherId` | 两次执行的输出 diff |
| GET | `/api/runs/:id/lineage` | 血缘树 |
| POST | `/api/runs/:id/snapshots/rollback` | 回滚工作区 |

### 7.2 WebSocket 事件（group_* 族）

- `group_message_created` / `group_message_delta` / `group_message_done`
- `group_seat_status`（idle→thinking→tool→done/failed）
- `group_floor_changed`（发言权转移）
- `run_started` / `run_status_changed` / `run_completed`
- `node_status_changed` / `node_progress` / `node_completed` / `node_failed`
- `trace_event_appended`（节流 100ms）
- `rerun_started` / `rerun_completed` / `snapshot_created`

---

## 8. 状态机

**Run**：`created → planning → running → (paused) → completed | failed | cancelled | awaiting_human`

**NodeRun**：`pending → queued → running → success | failed | skipped | cancelled → (stale)`

**Seat**：`idle → thinking → tool_exec → waiting → done | failed | muted(超预算) | offline`

---

## 9. 关键技术方案要点

1. **与 Orchestrator–Workers 边界**：群组 = 持久化的 orchestrator + 预定义 workers + 群聊交互壳
2. **重跑上下文重建**：依赖 PreCompact Hook + conversations/ + sessions/ + 节点 I/O 快照
3. **非确定性治理**：run_fingerprint 落库 + 差异提示
4. **副作用治理**：工具按风险分级 + 幂等键 + 二次确认
5. **并发与配额**：扩展 GroupQueue，新增群组级并发上限
6. **性能**：Trace 异步批量写 + WS 事件节流 + 前端虚拟滚动

---

## 10. 非功能需求

| 类别 | 要求 |
|------|------|
| 性能 | 节点 Trace 首屏 < 1s；消息列表 60fps；WS 延迟 < 300ms |
| 容量 | 单 Run ≥ 50 节点、单节点 ≥ 5000 trace 事件 |
| 存储 | Trace 大对象外置 + 30 天冷归档 |
| 安全 | 席位级最小权限；群组资源 ACL；所有重跑/回滚审计日志；红色副作用二次确认 |
| 兼容 | 既有单 Agent 会话（chat）零回归 |

---

## 11. 埋点与成功指标

| 指标 | 目标 |
|------|------|
| 群组采用率 | 3 个月内 ≥ 25% 用户创建过群组 |
| 定点重跑占比 | ≥ 60% |
| 失败定位耗时 | 较现状下降 ≥ 70% |
| Token 节省 | ≥ 40% |
| 人工介入率 | < 15% |

---

## 12. 风险与对策

| 风险 | 对策 |
|------|------|
| 重跑结果不一致 | fingerprint + diff 对比 |
| 外部副作用不可逆 | 风险分级 + 幂等键 + 二次确认 |
| 多 Agent 抢话 | Floor Control + 无进展检测 + 预算熔断 |
| 改造 registered_groups 引入回归 | group_kind 兼容开关，老数据默认 chat |

---

## 13. 验收标准与测试用例

### AC-1：群组创建与成员管理

**测试用例 TC-1.1**：创建含 3 个 Agent 席位的群组
- 前置条件：Agent Studio 中已有至少 3 个 Agent 定义
- 步骤：
  1. 访问群组创建页面
  2. 填写群组名称、描述
  3. 选择 3 个 Agent 成员（编排者 + 2 个 Worker）
  4. 为每个席位配置发言策略（auto/mention_only/silent）
  5. 为每个席位设置 token 预算
  6. 点击保存
- 期望结果：群组创建成功，可在群组列表中看到，各席位配置正确

**测试用例 TC-1.2**：席位版本 Pin
- 前置条件：某 Agent 有多个版本快照
- 步骤：
  1. 编辑已有群组的席位
  2. 将 Agent 版本从 "latest" 改为具体版本号
  3. 保存
- 期望结果：席位版本更新成功，显示为 pin 的版本号

### AC-2：群聊交互与 @ 路由

**测试用例 TC-2.1**：@ 特定 Agent 发言
- 前置条件：群组中有 Agent-A 和 Agent-B
- 步骤：
  1. 在群组对话中 @Agent-A 发送消息
  2. 等待响应
- 期望结果：只有 Agent-A 响应，Agent-B 不响应

**测试用例 TC-2.2**：未 @ 时由编排者分派
- 前置条件：群组配置为 orchestrator_driven
- 步骤：
  1. 在群组对话中输入消息（不 @ 任何人）
  2. 等待响应
- 期望结果：编排者接收任务并分派给合适的 Worker

### AC-3：人类介入控制

**测试用例 TC-3.1**：暂停与继续
- 前置条件：群组正在执行 Run
- 步骤：
  1. 点击「暂停」按钮
  2. 确认 Run 已暂停
  3. 点击「继续」
- 期望结果：Run 暂停后状态变为 paused，继续后恢复 running

**测试用例 TC-3.2**：插话
- 前置条件：群组正在执行 Run
- 步骤：
  1. 在 Run 进行中发送新消息
  2. 观察行为
- 期望结果：消息在当前节点完成后被注入处理

### AC-4：Pipeline 面板实时状态

**测试用例 TC-4.1**：节点实时更新
- 前置条件：群组开始执行 Run
- 步骤：
  1. 打开右侧 Pipeline 面板
  2. 观察节点状态变化
- 期望结果：节点状态从 pending→running→success 实时更新，显示耗时和 token

**测试用例 TC-4.2**：失败节点标红
- 前置条件：Run 中有节点执行失败
- 步骤：
  1. 观察 Pipeline 面板
- 期望结果：失败节点标红，面板顶部显示失败数

### AC-5：节点 Trace 查看

**测试用例 TC-5.1**：查看完整 Trace
- 前置条件：Run 已完成
- 步骤：
  1. 点击 Pipeline 面板中某个节点
  2. 打开 Trace 详情
  3. 切换到「完整 Trace」Tab
- 期望结果：显示 thinking/tool_use/tool_result 等事件序列

**测试用例 TC-5.2**：Trace 搜索与筛选
- 前置条件：Trace 详情已打开
- 步骤：
  1. 在搜索框输入关键字
  2. 切换事件类型筛选
- 期望结果：列表正确过滤，搜索结果高亮

### AC-6：节点重跑

**测试用例 TC-6.1**：as-is 重跑
- 前置条件：Run 已完成，某节点为 failed
- 步骤：
  1. 对失败节点发起 as-is 重跑
  2. 观察重跑结果
- 期望结果：节点重新执行，产生新的输出，Pipeline 更新

**测试用例 TC-6.2**：edit 重跑
- 前置条件：Run 已完成
- 步骤：
  1. 对某节点发起 edit 重跑
  2. 修改 prompt 或参数
  3. 确认执行
- 期望结果：按修改后的配置执行，下游节点标记为 stale

### AC-7：副作用控制

**测试用例 TC-7.1**：红色副作用二次确认
- 前置条件：节点涉及外部 HTTP 写操作
- 步骤：
  1. 对该节点发起重跑
- 期望结果：弹窗二次确认，列出受影响目标

**测试用例 TC-7.2**：工作区快照与回滚
- 前置条件：重跑前
- 步骤：
  1. 发起重跑
  2. 系统自动创建快照
  3. 如需要，点击回滚
- 期望结果：快照创建成功，回滚后工作区恢复到快照状态

### AC-8：回放模式

**测试用例 TC-8.1**：只读回放
- 前置条件：Run 已完成，trace 有数据
- 步骤：
  1. 对某节点发起回放
  2. 观察回放过程
- 期望结果：逐帧播放 Trace，面板显示"回放模式 · 只读"，不产生任何执行

### AC-9：血缘树与 Diff

**测试用例 TC-9.1**：查看血缘树
- 前置条件：Run 有多次重跑
- 步骤：
  1. 查看 Run 的血缘树
- 期望结果：展示分叉关系，可看到不同分支

**测试用例 TC-9.2**：Diff 对比
- 前置条件：同一节点在不同分支有两次执行
- 步骤：
  1. 对比两次执行的输出
- 期望结果：并排展示 diff，差异高亮

### AC-10：既有功能零回归

**测试用例 TC-10.1**：单 Agent 会话
- 步骤：
  1. 访问普通聊天会话（group_kind=chat）
  2. 发送消息
  3. 验证 Agent 正常响应
  4. 查看消息列表、文件面板等功能
- 期望结果：所有既有功能正常

**测试用例 TC-10.2**：IM 渠道
- 步骤：
  1. 通过飞书等 IM 渠道与 Agent 交互
- 期望结果：消息正常收发，无报错

---

## 14. 里程碑

| 阶段 | 范围 | 交付物 | 验收标准 |
|------|------|--------|---------|
| **M1** | 群组 + 席位管理 + 群聊交互 + Pipeline 面板（实时状态）+ 节点 Trace 查看 | 可用 MVP | AC-1~5, AC-10 |
| M2 | 重跑（as-is/edit）+ 工作区快照回滚 + 风险分级确认 | 重跑功能 | AC-6, AC-7 |
| M3 | 回放 + 血缘树 + diff 对比 + continue-from-here | 完整链路可观测 | AC-8, AC-9 |
| M4 | 面板内编排编辑、群组模板、成本治理与配额中心 | 增强项 | 后续定义 |

**本期交付范围：M1（MPV）**

---

## 附录 A：决策记录

| # | 决策项 | 决策 | 理由 |
|---|--------|------|------|
| 1 | 群组复用 registered_groups | ✅ 采纳 | 复用既有 IM 绑定、工作区、消息表与 GroupQueue 路径 |
| 2 | 并行席位同时输出气泡 | ✅ 采纳 | 每个 Agent 独立气泡，并行时自然呈现 |
| 3 | 重跑默认作用域 | downstream | 最符合"纠偏后刷新下游"的场景 |
| 4 | 工作区快照机制 | git commit（非 git 目录退化为 tar） | git 是最自然的工作区快照工具 |
| 5 | Trace 保留策略 | 默认永久保留，允许用户配置 | 复盘审计需要完整历史 |