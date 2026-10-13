# Intent — Agent 运行监控模块（Agent Runtime Monitor）

> 用户原始意图，2026-10-13 会话任务目标原文转写，不做解读。

## 用户原始需求

> 为 deepthink 系统开发一个 agent 运行监控模块：把可观测的全部运行 trace 数据展示出来，
> 监控全部 agent 的运行轨迹、状态、趋势汇总等。包括：开放平台的 agent service 的运行记录。

## 意图拆解

| 编号 | 意图要点 | 关键词 |
|------|---------|--------|
| I1 | **全量**可观测 trace 数据都要能展示 | "把**可观测的全部**运行 trace 数据展示出来" |
| I2 | 要能看到**运行轨迹**（单次运行内部的步骤链路） | "运行轨迹" |
| I3 | 要能看到**状态**（成功/失败/运行中/卡住） | "状态" |
| I4 | 要有**趋势汇总**（跨时间、跨维度的统计） | "趋势汇总" |
| I5 | 覆盖**全部 agent**，不限于某一个业务面 | "监控**全部** agent" |
| I6 | **开放平台 AaaS 的 agent service 运行记录**必须包含 | "包括：开放平台的 agent service 的运行记录" |

## 用户已确认的设计口径（2026-10-13 决策点澄清）

用户对两处工程岔路做了明确选择：

### 决策 A — 开放平台 AaaS 记录口径：**补埋点，记录状态与轨迹**（非只读透传）

现状：`POST /v1/agents/:id/chat/completions` 每次调用**只在 `usage_records` 落一行**
（`source='open-platform'`，含 model/tokens/cost/duration/num_turns），**没有 status、没有 error、没有轨迹**。
`agent-service.ts` 自己消费 SDK 流，从不调用 trace 持久化。

用户选择：**新增 `open_platform_runs` 表 + 在 `agent-service.ts` 补埋点**，记录状态与轨迹，
使 AaaS 的运行记录具备「状态 / 轨迹 / 趋势」三个可监控维度。

### 决策 B — 页面组织方式：**统一运行列表 + 来源筛选**（非分来源多面板）

用户选择把所有来源抽象成同一张「运行」列表（时间、来源、Agent/工作区、状态、耗时、tokens、成本），
可按来源/状态/时间/Agent 筛选；点进去看该次运行的时间线轨迹；上方是 KPI + 趋势汇总。

## 边界（本次明确不做）

- ❌ 不做实时分布式 tracing（OpenTelemetry Collector）——沿用现有表 + 轮询刷新
- ❌ 不改 Eval Center 的 PG-only `agent_trace`/`trace_span` 表（见 PRD §2 数据源边界）
- ❌ 不做告警推送（邮件/IM）——只做页面内「疑似卡住」标识
- ❌ 不做历史数据回填/迁移（除新表 `open_platform_runs` 建表）
- ❌ 不做自定义仪表盘 / 拖拽面板
