# PRD：Loop Engineering v2 — 主对话框长程任务自主循环

分支：`feat/loop-engineering-v2`  
需求来源：用户 2026-07-08 飞书指令  
作者：AI Coder  
日期：2026-07-08

## 0. 背景与问题

`feat/loop-engineering` 已交付后端闭环（`loop-orchestrator.ts` 587 行 + `loop-commands.ts` 319 行 + `/api/loops` 路由 + DB 三表 `loop_runs / loop_iterations / loop_trace_nodes`），4 种循环 `/goal /loop /schedule /proactive` 可从主对话框以斜杠命令触发。

但用户实际体验是「Loop Engineering 菜单啥功能都没有，就是一个文本展示」。根因诊断：

| 现象 | 根因 |
|------|------|
| /loops 页面与主对话框割裂 | 循环只在独立路由 `LoopsPage` 展示，主对话框发循环只能敲斜杠命令，看不到实时 DAG |
| 空状态只见文字 | `LoopsPage` 没循环时只渲染 `<p>暂无循环记录</p>` + 命令提示，无可视化入口 |
| DAG 是树不是图 | `LoopDagPanel` 用缩进列表模拟树，无边无箭头，节点不可编辑 |
| 无 Supervisor 概念 | 只有桌面端 `BackendSupervisor`（进程守护），无 agentic 监督 |
| 顶栏「admin Home」 | `ChatView.tsx:564` 直接渲染 `group.name`，未走侧边栏的 `displayName` 归一化 |

## 1. 需求拆解（逐条还原用户指令）

### 需求 1：主对话框内建 Loop Engineering 四类循环

> "你要在 DeepThink 主对话框里实现下面的核心功能（指令快键功能？对话模式切换？你要仔细深度思考这个功能的设计！！！）"
> - 轮次循环 Turn-based loops
> - 目标循环 Goal-based loop
> - 时间循环 Time-based loop（/loop 和 /schedule）
> - 主动循环 Proactive loops

**设计决策（混合方案，非二选一）：**

主对话框输入区新增**模式切换器（Mode Switcher）**，与斜杠命令**并存**：

| 入口 | 适用 | 设计 |
|------|------|------|
| 模式切换器（UI 按钮） | 新手、可视化操作 | 输入框上方 4 个 chip：💬 对话 / 🎯 目标 / 🔄 时间 / 🤖 主动；选中后输入框展开对应字段（goal/successCriteria/maxTurns/cron/workflow） |
| 斜杠命令 `/goal /loop /schedule /proactive` | 熟手、IM 渠道 | 保持现状，不变 |

**为什么不二选一：** 模式切换器降低门槛但每次要点选；斜杠命令快但需记忆。两者复用同一后端 `loop-commands.ts` handler，零重复。

四类循环对比表（PRD 内嵌，用户要求"表格对比"）：

| 维度 | 轮次循环 (Turn-based) | 目标循环 (Goal-based) | 时间循环 (Time-based /loop + /schedule) | 主动循环 (Proactive) |
|------|----------------------|----------------------|----------------------------------------|---------------------|
| 触发 | `/goal X max_turns=N` | `/goal X`（不设 N 或大 N） | `/loop 5m X` 或 `/schedule cron X` | `/proactive cron X workflow=parallel` |
| 停止条件 | 达 N 轮 | 评审通过 / max_turns 上限 | 时间到 / cron 结束 | 主动撤销 / cron 失效 |
| 评审 | 每轮 sdkQuery 评审 | 每轮 sdkQuery 评审 | 不评审（单次执行） | 每轮 sdkQuery 评审 |
| 调度 | 立即 | 立即 | 间隔 / cron | cron 驱动 |
| 并行 | 否 | 否 | 否 | 可选 parallel |
| 适用 | 固定迭代调试 | "直到通过"型目标 | 周期巡检 | 周期 + 自主决策 |
| 本期落地 | ✅ | ✅ | ✅ | ✅ |

> 说明：Turn-based 与 Goal-based 在 `loop-orchestrator` 里复用 `kind='goal'`，差异仅为 `max_turns` 是否显式指定。本期保持后端 kind 不变，前端 UI 分两个 chip 以对应文档语义。

### 需求 2：任务执行 DAG 实时渲染 + 节点可点击查看/编辑 Trace + 自适应循环 + 技能自进化循环

**2.1 实时 DAG 渲染**

- 在主对话框消息流中，当 `loop_run` 处于 `running/reviewing/iterating` 时，渲染一张**内联 LoopRunCard**：
  - 顶部：循环类型 emoji + 目标文本 + 进度 `turn N/M` + 状态徽章 + 取消按钮
  - 中部：**实时 DAG 图**（横向流程，非缩进树），节点按 `node_type` 着色，边表示父子关系，运行中节点带脉冲动画
  - 底部：token/cost 汇总
- DAG 节点点击 → 弹出 `TraceDetailDrawer`（复用并增强现有 `LoopDagPanel` 的抽屉）：
  - 展示 input/output 全文、toolUseSummary、tokens、duration、status
  - **新增编辑能力**：节点 output 旁加「✏️ 编辑」按钮，点击进入编辑态，保存后写回 `loop_trace_nodes.output_text`（仅对 `status='completed'` 且非运行中的循环开放，避免污染活跃执行）

**2.2 自适应循环（Adaptive Loop）**

新增 `kind='adaptive'`：
- `max_turns` 不固定，由评审器根据进度动态调整：每轮评审返回 `suggested_next_turns`（1~剩余上限），orchestrator 据此伸缩
- 停止条件：评审 `pass` 或连续 3 轮 `needs_improvement` 无进展 → `failed`
- 适用：探索型任务（"找到一个能跑通的架构方案"）

**2.3 技能自进化循环（Skill Self-Evolution Loop）**

新增 `kind='skill_evolution'`：
- 目标是让某个 Skill 通过自测：每轮迭代 = 生成/修改 skill 内容 → 跑 skill 的测试 fixture → 评审是否通过
- `success_criteria` 必须指向一个可执行的测试命令（如 `node tests/skills/foo.test.js`）
- 停止条件：测试通过 → `completed`；max_turns 用尽 → `failed`
- 适用：Skill 自我迭代优化

> 自适应 + 技能自进化作为本期新增 `kind`，需 DB schema 加 `kind` 枚举值（已有 `loop_runs.kind` 是 TEXT，无需 migration，仅前端 + orchestrator 增加分支）。

### 需求 3：Supervisor Agent（人类托管）

> "添加一个人类监督者 Supervisor Agent，人类托管给 Supervisor Agent，自主接管，自主判断 DeepThink 的输入输出，给出指令，驱动任务的完成。"

**设计决策：**

- 顶栏新增 **🧭 Supervisor 开关**（默认关）。
- 开启后：
  - 用户发送的消息 **先**注入 Supervisor SubAgent（Claude Agent SDK SubAgent，prompt 见 §3.2）
  - Supervisor 决策三选一：
    1. **delegate** — 把消息原样转发给主 Agent 执行，等主 Agent 回复后，Supervisor 复审输出，若不合格附 `review_reason` 重发指令
    2. **clarify** — 直接向用户提问澄清（不经过主 Agent）
    3. **auto** — Supervisor 自主生成优化后的指令发给主 Agent
  - Supervisor 消息在消息流中独立渲染：紫色头像 🧭 + 「Supervisor」标签
- 关闭时：保持现状，用户消息直奔主 Agent

**3.2 Supervisor SubAgent prompt 要点（写入 `agent-definitions.ts`）：**

```
你是 DeepThink 的 Supervisor。用户已将任务托管给你。
职责：
1. 解析用户意图，判断是否需要澄清；若需要，直接反问用户。
2. 不需要澄清时，生成一条结构化指令（目标 + 成功标准 + 约束）转发给主 Agent。
3. 主 Agent 返回后，评审输出是否满足用户原始意图：
   - 满足 → 转达用户
   - 不满足 → 附 review_reason 重新下达指令（最多 3 轮）
4. 全程用用户的语言（userLanguage）。
不直接写代码、不直接调工具，只做意图解析 + 指令下发 + 输出复审。
```

### 需求 4：顶栏去掉「admin Home」改哲学宣传语

- `ChatView.tsx:564` 的 `{group.name}` 替换为 DeepThink 哲学宣传语，**轮播**展示（每 15s 切换，本地存储偏好）：
  - "深度思考，自主进化。"
  - "Think deep. Act autonomously."
  - "让任务自己跑完。"
  - "Loop until done."
  - "从指令到自治，从自治到超越。"
- 侧边栏仍保留 `group.name` 的归一化展示（`ChatGroupItem.tsx`），不动
- 当 `group.name` 非默认 home 名（如用户自定义了"我的实验室"）时，顶栏显示自定义名 + 宣传语副标题（两行），尊重用户命名

## 2. 成功标准（Goal-Driven）

| # | 验证项 | 验证方法 |
|---|--------|---------|
| S1 | 主对话框输入区可见 4 个模式 chip，点击 🎯 目标 后输入框出现 goal/successCriteria/maxTurns 字段 | 手动 UI 验证 |
| S2 | 在主对话框用 UI 启动一个 goal loop，消息流中实时出现 LoopRunCard + DAG，每轮更新 | 启动 `/goal 累加 1 到 10 max_turns=3` 等测试任务 |
| S3 | DAG 节点可点击，弹出抽屉显示完整 input/output；对已完成循环的 completed 节点可编辑 output 并保存 | 点击节点验证 |
| S4 | 顶栏不再出现 "admin Home"，显示哲学语；每 15s 轮播 | 进入主页观察 |
| S5 | 开启 Supervisor 开关后，发消息先见 🧭 Supervisor 头像的中间消息，再见主 Agent 回复 | 手动验证 |
| S6 | `kind='adaptive'` 与 `kind='skill_evolution'` 可通过 UI 或 `/adaptive` `/skill_evolution` 启动 | 斜杠命令 + UI |
| S7 | `make typecheck` 通过 | CI |
| S8 | `make test` 通过 | CI |
| S9 | 现有 `/loops` 页面不受影响，继续工作 | 回归 |

## 3. 非目标（Out of Scope）

- 不重写 `loop-orchestrator` 状态机（仅增加 adaptive / skill_evolution 分支）
- 不引入 react-flow 等重型图库（DAG 用 SVG + 自绘横向流程，保持 bundle 体积）
- 不做 Supervisor 的多轮自主外呼工具（Supervisor 只 delegate / clarify / auto，不直接调工具）
- 不改 IM 渠道的斜杠命令协议（向后兼容）

## 4. 风险与权衡

| 风险 | 缓解 |
|------|------|
| Supervisor 增加每条消息的延迟与 token 成本 | 默认关闭，用户显式开启；Supervisor 用轻量 model（haiku）做意图解析 |
| DAG 实时刷新频率高导致前端卡顿 | 复用现有 5s 轮询 + WebSocket stream_event，不新增长连接 |
| 节点编辑写回 DB 可能破坏 trace 完整性 | 仅对 `status='completed'` 的循环开放编辑，写入时记 `edited_at` 与原值备份 |
| 自适应循环 max_turns 失控 | 硬上限 `MAX_TURNS_HARD_LIMIT=10` 不变，adaptive 的 suggested_next_turns 受此约束 |

## 5. 里程碑

| 阶段 | 内容 | 估时 |
|------|------|------|
| M1 | 顶栏宣传语（Req4） | 30 min |
| M2 | 输入区模式切换器 + 表单展开（Req1 UI） | 2 h |
| M3 | 内联 LoopRunCard + 实时 DAG（Req2.1） | 3 h |
| M4 | DAG 节点抽屉 + 编辑回写（Req2.1） | 1.5 h |
| M5 | adaptive + skill_evolution 两个 kind（Req2.2/2.3） | 2 h |
| M6 | Supervisor SubAgent + 开关 + 消息路由（Req3） | 3 h |
| M7 | typecheck + test + 修复 | 1 h |
| M8 | 测试报告 + 提交合并 | 1 h |

总计 ~14 h，本期一次性交付。

## 6. 文档关联

- 技术方案：`docs/tech_solution/loop-engineering-v2/SOLUTION.md`
- 测试报告：`docs/test_report/loop-engineering-v2/REPORT.md`
- 历史 PRD：`docs/prd/loop-engineering/PRD.md`（v1，本期在其上增量）
