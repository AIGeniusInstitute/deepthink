# PRD — DeepThink 企业级全自主 Coding Agent（Self-Evolving Harness Loop）

> 范式：人肉调壳 → Meta-Harness → Self-Harness
> 公理：自改进必须**可记录、可测试、可回滚**，以**行为证据**为准。
> 仓库：`~/deep-think`，分支 `feat/self-evolving-harness`，基线 `main` @ `c7c985a`。

---

## 1. 背景

DeepThink 当前 Harness（prompt + tools + memory + orchestration）是**静态拼装**的：
- System prompt 在 `container/agent-runner/src/index.ts:1473-1485` 现场字符串拼接，无版本；
- SubAgent 定义在 `agent-definitions.ts` 硬编码 `code-reviewer / web-researcher / supervisor`；
- 工具定义在 `mcp-tools.ts` 1764 行硬编码；
- 评估基准缺失，行为证据散落在 `chat_trace_nodes` + `conversations/`，未结构化复用。

模型每次升级，harness 就要重调——但人肉调壳永远追不上模型迭代。本项目把"壳"变成**可版本化、可评估、可回滚、可自改进**的工程对象。

## 2. 范式映射

| 研究范式 | 工程落地（本 PR） |
|---------|-----------------|
| DGM + SICA（源码级自改进 / 档案库 / 垫脚石） | `harness_versions` 版本档案库；保留所有变体（含失败），可被未来提案作为垫脚石引用 |
| Meta-Harness（harness 代码自动搜索） | `harness_proposals` 表：提案者给出 mutation patch + 假设；评估时**给提案者完整执行轨迹**而非仅分数 |
| Self-Harness（自己调自己 / 行为证据 > 提案论证） | Meta-Loop 由 Agent 自己运行；判定**只看 eval 行为证据**，不看提案者的论证文本 |
| AHE（瓶颈是可观测性 / 每次修改是可证伪契约） | 每个提案 = 一份可证伪契约（假设、预期、实际、裁决、证据 trace id） |
| ACE + MOSS + Continual Harness（文本层演化 / 生产合流 / reset-free 在线演化） | 版本以文本（prompt/skill 内容）为变异单位；eval 跑在生产 trace 抽样上；版本切换**原子且可回滚**，无需 reset 会话 |
| Harness Updating ≠ Benefit + Harness-Bench + SEAGym | 评估用**行为证据**（pass/fail + trace DAG）而非"改动量"；`harness_eval_cases` 为最小 Harness-Bench，promote 阈值 = 显著优于 baseline |

## 3. 目标

**核心目标**：让 DeepThink 的 harness 成为**可记录、可测试、可回滚**的版本化对象，并跑通一次端到端的"propose → eval → promote/rollback"闭环。

**非目标**（本 PR 不做）：
- 不追求让 Agent 真的自进化到超越人类水平；
- 不实现 MOSS 的生产合流（生产 trace 抽样仅留接口，不连真实流量）；
- 不实现 SEAGym 的沙箱训练环境（复用现有 container 即可）；
- 不重构 `mcp-tools.ts` 把所有工具 DB 化（仅做版本快照，不做动态加载）。

## 4. 功能需求

### F1 — Harness 版本档案库（DGM Archive）

- **F1.1** 任意时刻可对当前 harness 打快照：system prompt + subagent defs + 工具签名清单 + skill 选择 + CLAUDE.md 内容哈希。
- **F1.2** 快照写入 `data/harness/versions/{version_id}/` 目录 + `harness_versions` 表（id, parent_id, hash, manifest_json, created_at, source, status）。
- **F1.3** 版本有 `status`：`experimental` / `promoted` / `archived` / `rolled_back`。
- **F1.4** 所有版本永久保留（包括失败变体）——这是 DGM 的"垫脚石"原则。

### F2 — 行为证据评估器（Harness-Bench mini）

- **F2.1** `data/harness/eval-cases/` 存放最小基准：5 个代表性任务（代码生成、bug 修复、文件操作、记忆召回、工具调用）。
- **F2.2** 每个 case = 一份 `case.yaml`（prompt + 预期行为断言 + 评分 rubric）。
- **F2.3** 评估器对指定版本跑全部 case，每 case 产生一份 `EvalCaseResult`：pass/fail + 完整 trace DAG ref + 评分理由。
- **F2.4** 评分**只看行为证据**（执行轨迹 + 断言匹配），不看提案者论证。

### F3 — 可证伪契约（AHE）

- **F3.1** 每个提案 `harness_proposals` 行包含：
  - `hypothesis`：假设（"把 X 改成 Y，会让 case Z 通过"）
  - `expected_behavior`：预期行为
  - `mutation_patch`：变异 patch（文本 diff）
  - `proposed_version_id`：注册到的版本 id
  - `baseline_version_id`：对照版本
  - `verdict`：`improved` / `regressed` / `neutral` / `inconclusive`
  - `evidence_run_ids`：评估 run id 列表
  - `trace_summary`：行为证据摘要
- **F3.2** 提案者（Agent 自己）拿到的是**完整执行轨迹**（trace DAG ref），不是仅分数。

### F4 — Meta-Loop 编排器（Self-Harness）

- **F4.1** `harness-meta-loop.ts` 实现状态机：`proposing → registering → evaluating → judging → promoting|rolling_back`。
- **F4.2** 评判规则（行为证据为准）：
  - `improved`：新版本在 eval 上 pass 率 **严格高于** baseline，且无新增 fail；
  - `regressed`：新版本出现 baseline 未有的 fail；
  - `neutral`：pass 率持平但行为轨迹相似；
  - `inconclusive`：评估异常或证据不足。
- **F4.3** 仅 `improved` 触发 promote（标 `promoted`，baseline 标 `archived`）；其余触发 rollback（新版本标 `rolled_back`，保留为垫脚石）。
- **F4.4** Meta-Loop 可由 Web UI 手动触发，也可由定时任务调度（复用 `task-scheduler.ts`）。

### F5 — Web API + UI

- **F5.1** `GET /api/harness/versions` — 版本列表（含 parent、status、verdict 摘要）。
- **F5.2** `POST /api/harness/snapshot` — 对当前 harness 打快照。
- **F5.3** `POST /api/harness/proposals` — 提交提案（含 mutation patch + hypothesis），触发 Meta-Loop。
- **F5.4** `GET /api/harness/proposals/:id` — 查看提案 + 完整证据 trace。
- **F5.5** `POST /api/harness/versions/:id/rollback` — 回滚到指定版本（把该版本重新标 `promoted`，当前 promoted 标 `archived`）。
- **F5.6** `GET /api/harness/eval-runs` — 评估历史。
- **F5.7** `HarnessPage.tsx`：版本树（左侧）+ 选中版本的 manifest + diff + eval 历史 + 提案列表 + rollback 按钮。复用 `LoopsPage` 样式。

## 5. 数据模型

新增 4 张表（`src/db.ts` migration，SCHEMA_VERSION +1）：

| 表 | 主键 | 关键字段 |
|----|------|---------|
| `harness_versions` | `id` | `parent_id`, `hash`, `manifest_json`, `status`, `source`, `created_at`, `promoted_at` |
| `harness_proposals` | `id` | `proposed_version_id`, `baseline_version_id`, `hypothesis`, `expected_behavior`, `mutation_patch`, `verdict`, `evidence_run_ids` (JSON), `trace_summary`, `created_at`, `judged_at` |
| `harness_eval_runs` | `id` | `version_id`, `proposal_id` (nullable), `case_id`, `status`, `pass`, `score`, `trace_node_root` (ref `chat_trace_nodes`), `started_at`, `finished_at`, `error` |
| `harness_eval_cases` | `case_id` | `name`, `prompt`, `assertions_json`, `rubric_json`, `enabled` |

## 6. 成功标准（Goal-Driven）

本 PR 视为完成，当且仅当：

1. ✅ `make typecheck` 三端全绿；
2. ✅ `make test` 全绿（含新增 harness 单测）；
3. ✅ 手动跑通一次端到端 Meta-Loop：
   - 对当前 harness 打快照（v1 baseline）；
   - 提交一个 mutation 提案（例如"在 system prompt 末尾加一句'先思考再编码'"）；
   - 系统自动注册 v2、跑 eval、产出 verdict；
   - 在 UI 看到版本树 + 提案 + 证据 trace + rollback 按钮可用；
4. ✅ Eval 跑在 5 个 case 上，每个 case 产出 `pass: bool` + trace ref；
5. ✅ Rollback 路径验证：把 v2 rollback 后，v1 重新 `promoted`，v2 `rolled_back`；
6. ✅ 失败变体保留在档案库（可被未来提案引用 `parent_id`）。

## 7. 风险与取舍

- **风险 R1：eval 评估器本身是 harness 的一部分**（自举悖论）。取舍：评估器代码**不纳入版本快照**，作为外部裁判固定在代码库里。这是 SEAGym 的做法。
- **风险 R2：mutation patch 可能破坏 harness 加载**。取舍：版本注册时做 JSON schema 校验 + dry-run 加载，加载失败直接标 `rolled_back`。
- **风险 R3：行为证据评分依赖 trace DAG 完整性**。取舍：trace 缺失时 verdict = `inconclusive`，宁可不下结论也不误判。
- **风险 R4：Meta-Loop 无限循环**。取舍：单次提案只跑一轮 eval，不自动链式提案；连续提案由外部调度限频。

## 8. 里程碑

| 阶段 | 交付物 | 验证 |
|------|--------|------|
| M1 DB + Registry | 4 张表 + `harness-registry.ts` | 单测：snapshot/list/diff/rollback |
| M2 Eval + Cases | `harness-eval.ts` + 5 个 case | 单测：scorer pass/fail 判定 |
| M3 Meta-Loop | `harness-meta-loop.ts` | 集成测：一次 propose→verdict 流程 |
| M4 API + UI | `routes/harness.ts` + `HarnessPage.tsx` | 手测：UI 走查 |
| M5 端到端 | PRD/SOLUTION/TEST-REPORT 齐全 | §6 全绿 |

## 9. 验收清单

- [ ] 4 张表迁移 + Schema 版本升级
- [ ] `harness-registry.ts` 导出 `snapshotCurrentHarness()` / `listVersions()` / `getVersion()` / `diffVersions()` / `rollbackTo()`
- [ ] `harness-eval.ts` 导出 `runEval(versionId, caseIds)` 返回 `EvalCaseResult[]`
- [ ] `harness-meta-loop.ts` 导出 `runMetaLoop(proposalId)` 返回 `Verdict`
- [ ] `routes/harness.ts` 6 个端点全部 RBAC（admin only）
- [ ] `HarnessPage.tsx` 可视化版本树 + 提案 + 证据
- [ ] 5 个 eval case 文件
- [ ] 单测覆盖：registry / scorer / meta-loop verdict 规则
- [ ] `make typecheck` + `make test` 全绿
- [ ] 端到端手测一次

## 10. 后续（非本 PR）

- MOSS 生产 trace 抽样接入；
- 工具定义 DB 化（动态加载工具）；
- SEAGym 沙箱训练环境；
- 多提案并行评估 + 帕累托前沿选择；
- 持续在线演化（reset-free）。
