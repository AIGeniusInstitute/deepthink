# PRD: 斜杠命令 / 推理深度 effort / 执行过程 DAG 可视化

- **分支**: `feat/slash-effort-dag`
- **基线**: `main` (commit 23f4eac 之后)
- **作者**: ai-coder
- **日期**: 2026-07-08

## 1. 背景

DeepThink 当前对话交互存在三处可补齐的体验缺口：

1. **输入框无斜杠命令补全**：Claude Code 终端原生支持 `/` 触发的命令面板（`/clear`、`/cost`、`/skills` 等以及用户自定义 Skill），SDK 已提供 `supportedCommands()` API 可枚举全部可用命令，但 Web 端输入框目前仅作为纯文本输入，用户无法发现和快速调用这些命令。
2. **无推理深度选择**：Claude Agent SDK 的 `query()` 支持 `effort` 选项（`'low'|'medium'|'high'|'xhigh'|'max'|number`），控制模型思考预算。当前 DeepThink 调用 `query()` 时未传该字段，全部使用默认值，用户无法按场景在"快速回答"与"深度推理"间切换。
3. **无执行过程可视化**：SDK 流式事件中已携带 `traceNode` 字段（`nodeId / parentNodeId / nodeType / title / inputSummary / outputSummary / tokens / status`），可以还原出完整的 DAG 执行图（工具调用、子 Agent、技能、回合等节点）。当前前端只渲染了线性的流式展示组件，没有图结构视图，用户难以理解 Agent 的执行路径，也无法针对单个节点进行"重跑"或"从此节点续跑"的调试操作。

## 2. 目标与非目标

### 目标

- **G1**：输入框输入 `/` 时弹出命令面板，列出 SDK `supportedCommands()` 返回的全部命令及当前会话可用 Skills，支持键盘上下选择、Tab/Enter 补全、参数提示。
- **G2**：在对话页右侧"环境变量"面板附近提供 `effort` 选择器，五档可选（low/medium/high/xhigh/max），切换后对该会话后续 query 生效。
- **G3**：右侧侧栏新增"DAG"Tab，以流程图画布展示当前会话的执行节点树，节点类型覆盖 `turn / tool / review / goal_check / skill / subagent`。
- **G4**：点击 DAG 节点弹出详情面板，展示 `inputSummary / outputSummary / tokens / status` 等全量上下文状态；输入输出字段支持编辑并保存为节点注解。
- **G5**：DAG 节点支持"单节点重跑"与"从此节点续跑"两个调试动作。

### 非目标

- 不在本期实现 DAG 节点的并行可视化布局算法调优（使用 reactflow 内置 dagre 自动布局即可）。
- 不在本期实现跨会话的 DAG 历史归档检索（仅当前会话实时展示）。
- 不自定义新建 Skill 的 `/create-skill` 之类命令实现（依赖 SDK 内置命令语义）。
- 不在本期实现 effort 的数值化（`number`）输入，仅暴露五档枚举。

## 3. 用户故事

### US-1: 斜杠命令发现与补全
> 作为 DeepThink 用户，我在输入框打 `/` 时希望看到当前会话可用的全部斜杠命令（含 Skills），并能键盘选择补全，省去记忆命令名的心智成本。

**验收**
- 输入 `/` 后 200ms 内弹出面板，列出命令名、描述、参数提示（`argumentHint`）。
- 面板支持 `↑/↓` 选中、`Tab` 或 `Enter` 补全到输入框；`Esc` 关闭。
- 继续输入字母时面板按前缀实时过滤。
- 选中带 `argumentHint` 的命令时，补全后光标停在命令后并保留空格，等待用户输入参数。
- 命令列表来源：SDK `supportedCommands()` + 已加载的 user/project/external Skills。

### US-2: 推理深度切换
> 作为 DeepThink 用户，我希望在"快速问答"和"深度推理"场景间切换 `effort`，避免简单问题浪费思考预算、复杂问题思考不足。

**验收**
- 环境变量面板新增 `EFFORT_ENV_KEY='CLAUDE_EFFORT'` 下拉选择，五档可选，默认 `medium`。
- 切换后立即写入会话级环境变量，对该会话后续 query 生效；不影响其他会话。
- Agent Runner 读取 `CLAUDE_EFFORT` 环境变量，传入 `query({ effort })`。
- 切换 effort 不会重置当前会话上下文。

### US-3: 执行过程 DAG 实时可视化
> 作为 DeepThink 用户，我希望看到 Agent 当前会话的执行节点树（工具调用、子 Agent、技能、回合），理解执行路径。

**验收**
- 右侧侧栏新增"DAG"Tab，点击后展示 reactflow 画布。
- 节点按 `traceNode.nodeType` 区分颜色：`turn`(蓝)、`tool`(绿)、`skill`(紫)、`subagent`(橙)、`review`(黄)、`goal_check`(红)。
- 节点显示 `title`（截断到 30 字符）和 `status` 图标（pending/running/done/failed）。
- 流式事件实时增量更新画布，无需手动刷新。
- 空会话状态显示 EmptyState："暂无执行节点"。

### US-4: 节点详情查看与编辑
> 作为 DeepThink 用户，我希望点击 DAG 节点查看完整上下文状态，并能编辑输入输出执行逻辑后保存。

**验收**
- 点击节点弹出右侧详情面板（或浮层），展示 `nodeId / nodeType / parentNodeId / title / status / tokens / inputSummary / outputSummary`。
- `inputSummary` 和 `outputSummary` 字段为可编辑 textarea。
- 点击"保存"按钮持久化到后端（节点注解表），下次会话恢复后仍可见。
- 保存成功后 toast 提示"已保存节点注解"。

### US-5: 单节点重跑与从此续跑
> 作为 DeepThink 用户，我希望对某个 DAG 节点发起"重跑"或"从此节点续跑"，用于调试和分支探索。

**验收**
- 节点详情面板有"重跑此节点"和"从此续跑"两个按钮。
- "重跑此节点"：以该节点的 `inputSummary` 作为新消息发送到当前会话，生成新的子分支。
- "从此续跑"：以该节点的 `inputSummary` 作为新消息发送，并标注 `continue_from_node_id`，Agent Runner 在该节点后续链路上重新执行。
- 两个动作都先弹确认框，避免误触。
- 发送后自动切换回"对话"Tab 并滚动到底部。

## 4. 功能拆解

| 模块 | 拆解点 | 优先级 |
|------|--------|--------|
| 斜杠命令 | 输入框 `/` 触发检测 + 面板组件 | P0 |
| 斜杠命令 | 命令列表数据源（SDK + Skills 合并） | P0 |
| 斜杠命令 | 键盘交互（↑↓ Tab Enter Esc） | P0 |
| effort | 环境变量面板下拉选择器 | P0 |
| effort | Agent Runner 读取 `CLAUDE_EFFORT` 并传入 query | P0 |
| DAG | reactflow 依赖引入与画布骨架 | P0 |
| DAG | traceNode 流式事件采集与持久化 | P0 |
| DAG | 节点详情面板 + 编辑保存 | P0 |
| DAG | 重跑/续跑动作 | P1 |
| DAG | 节点类型颜色与图标区分 | P1 |

## 5. 成功验证

- **V1**：在输入框打 `/`，面板出现；`↑↓` 选择后 `Tab` 补全，命令正确插入到输入框。
- **V2**：切换 `effort=low`，发送一条消息，docker 容器日志中 `query()` 调用可见 `effort: 'low'`；切回 `high` 后再次发送，日志可见 `effort: 'high'`。
- **V3**：发送触发工具调用的消息（例如"列出当前目录文件"），DAG 画布出现 `turn` 节点及其下的 `tool` 子节点，节点状态随流式事件从 `running` 变为 `done`。
- **V4**：点击 DAG 节点，详情面板展示完整 `inputSummary / outputSummary`；编辑两个字段并保存，刷新页面后注解仍存在。
- **V5**：在工具节点上点"重跑此节点"，弹出确认框，确认后该节点 input 作为新消息发送，对话页出现新回合。
- **V6**：`make typecheck` 三端通过；`make test` 全量通过；新增 DAG 相关单测通过。

## 6. 风险与对策

| 风险 | 对策 |
|------|------|
| SDK `supportedCommands()` 可能因 provider 不同返回不同命令集合 | 在 agent-runner 启动时调用一次并缓存，通过 init 事件下发到前端 |
| reactflow 体积较大（~200KB gzip） | 走动态 import，仅在打开 DAG Tab 时加载 |
| traceNode 持久化数据量增长 | 本期仅存内存 + 临时表，会话结束时清理；不做跨会话归档 |
| 编辑 input/output 保存与真实执行结果脱节 | 注解字段独立存储，不覆盖原始 `inputSummary`，UI 上区分"原始"与"注解" |
| "从此续跑"需要 Agent Runner 支持分支执行 | 本期实现为"以 input 重新发起 query"，标注 continue_from_node_id 但不实现真正的分支剪枝，UI 上提示用户 |

## 7. 里程碑

1. **M1 - 基础设施**：引入 reactflow 依赖；agent-runner 在 init 事件下发 supportedCommands；新增 traceNode 持久化表与 IPC 通道。
2. **M2 - 斜杠命令 + effort**：前端输入框面板、键盘交互；环境变量面板 effort 选择器；agent-runner 读取 `CLAUDE_EFFORT`。
3. **M3 - DAG 可视化**：右侧侧栏 DAG Tab；reactflow 画布渲染；流式事件实时更新。
4. **M4 - 节点交互**：详情面板；编辑保存；重跑/续跑动作。
5. **M5 - 测试与文档**：单测、E2E 验证、test_report 文档；合并 main 推送。
