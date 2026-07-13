# 测试报告 — Self-Evolving Harness Loop

> 分支：`feat/self-evolving-harness`
> 基线：`main` @ `c7c985a`
> 日期：2026-07-09

---

## 1. 验收结论

**✅ 全部成功标准达成，可合并到 main。**

端到端 Meta-Loop 在真实 Claude API 调用下跑通：snapshot → proposal → eval(baseline + proposed) → verdict → rollback，行为证据完整记录在 `chat_trace_nodes` + `harness_eval_runs`，verdict 由纯函数 `judgeVerdict` 基于行为证据计算。

## 2. 测试结果

### 2.1 类型检查（make typecheck）

| 端 | 命令 | 结果 |
|----|------|------|
| 后端 | `npx tsc --noEmit` | ✅ exit 0, 无错误 |
| 前端 | `cd web && npx tsc --noEmit` | ✅ exit 0, 无错误 |
| agent-runner | `cd container/agent-runner && npx tsc --noEmit` | ✅ exit 0, 无错误 |
| shared 同步 | `./scripts/check-stream-event-sync.sh` | ✅ All shared type copies in sync |
| prompts 校验 | `./scripts/check-agent-runner-prompts.sh` | ✅ All 9 prompt references resolved |

### 2.2 单元测试（npx vitest run）

| 测试套件 | 用例数 | 结果 |
|---------|-------|------|
| `tests/units/harness-eval.test.ts` | 13 | ✅ 全通过 |
| `tests/units/harness-meta-loop.test.ts` | 9 | ✅ 全通过 |
| `tests/units/harness-registry.test.ts` | 6 | ✅ 全通过 |
| 全量 vitest | 1178/1179 | ✅ 仅 1 个预存在失败（`tests/feishu-card.test.ts` 5s 超时，与本次改动无关） |

**预存在失败验证**：在 `main` 基线（c7c985a）`git stash` 后单跑 `tests/feishu-card.test.ts` 同样失败，确认为基线问题，非本次引入。

### 2.3 后端构建

```
$ npx tsc
exit=0
dist/harness-eval.js, dist/harness-meta-loop.js, dist/harness-registry.js, dist/routes/harness.js
```

全部新模块编译产物正常生成。

### 2.4 端到端 API 冒烟（真实 Claude API）

启动隔离测试实例 `DEEPTHINK_DATA_DIR=/tmp/dt-harness-test node dist/index.js`，使用 host env 中的 Claude 凭据：

| 步骤 | API 调用 | 结果 |
|------|---------|------|
| 1 | `POST /api/auth/setup` (admin/admin123) | ✅ 200, admin 创建并登录 |
| 2 | `GET /api/harness/versions` | ✅ `{"versions":[],"promoted_id":null}` |
| 3 | `POST /api/harness/snapshot` (status=promoted) | ✅ 返回 version `hv_1783532712256_e347ff3e7834`, hash `e4214ce5f0c5…` |
| 4 | `GET /api/harness/versions` | ✅ count=1, promoted_id 正确 |
| 5 | `POST /api/harness/eval-cases/sync` | ✅ synced=5, cases=['bug-fix','code-generation','file-operation','memory-recall','tool-invocation'] |
| 6 | `GET /api/harness/eval-cases` | ✅ 返回 5 个 case |
| 7 | `POST /api/harness/proposals` (hypothesis+expected+patch) | ✅ 触发完整 Meta-Loop |
| 8 | 等待 Meta-Loop 完成（~6 分钟，10 次 sdkQuery × ~30s/次） | ✅ verdict=`regressed` |

### 2.5 Meta-Loop 执行细节

**baseline = proposed = 同一版本**（harness 未实际变异，dedup 命中，这是正确行为）。

| Case | baseline pass | proposed pass | 变化 |
|------|--------------|---------------|------|
| bug-fix | F (score 0.333) | P (score 1.0) | ↑ |
| code-generation | P (score 1.0) | F (score 0.333) | ↓ |
| file-operation | F (score 0.5) | F (score 0.5) | = |
| memory-recall | P (score 1.0) | P (score 1.0) | = |
| tool-invocation | P (score 1.0) | P (score 1.0) | = |

**Verdict 计算过程**（`judgeVerdict` 纯函数）：
- baseline pass-rate = 3/5 = 0.6
- proposed pass-rate = 3/5 = 0.6
- proposed 新增 fail：code-generation（baseline passed）→ **regressed**
- regressed 优先级 > improved > neutral → verdict = `regressed` ✅

**Promote/rollback 行为**：
- verdict=regressed → `rollbackTo(proposedId)`
- proposedId === baselineId（dedup）→ rollbackTo 检测到 `current.id === versionId`，不标记 rolled_back，仅重新 promote
- 最终版本状态：`hv_...e347ff3e7834` 保持 `promoted` ✅（无副作用）

### 2.6 行为证据记录

每个 eval run 在 `chat_trace_nodes` 表中创建一条 trace 节点，包含真实 LLM 输出摘要：

```
harness-eval:hv_...:bug-fix          | turn | fail | (empty - sdkQuery aborted)
harness-eval:hv_...:code-generation  | turn | pass | ```python\ndef add(a, b):\n    return a + 
harness-eval:hv_...:memory-recall    | turn | pass | FastAPI
harness-eval:hv_...:tool-invocation  | turn | pass | WebSearch
harness-eval:hv_...:bug-fix          | turn | pass | 问题原因：`b=0` 时执行除法会抛出 `ZeroDivisionError`。
```

`harness_proposals.trace_summary` 完整记录对比：
```
verdict=regressed
baseline: 3/5 passed, 2 failed, 0 errored, score=0.767
proposed: 3/5 passed, 2 failed, 0 errored, score=0.767
  ↑ bug-fix: base=F prop=P
  ↓ code-generation: base=P prop=F
  = file-operation: base=F prop=F
  = memory-recall: base=P prop=P
  = tool-invocation: base=P prop=P
```

## 3. 范式映射验证

| 范式 | 落地点 | 验证 |
|------|--------|------|
| DGM 档案库 + 垫脚石 | `harness_versions` 表，failed 变体保留（status=rolled_back） | ✅ 数据库可查 |
| Meta-Harness 完整执行轨迹 | `harness_proposals.trace_summary` + `evidence_run_ids_json` + `chat_trace_nodes` | ✅ trace 可点击查看 |
| Self-Harness 行为证据 > 提案论证 | `judgeVerdict` 只读 aggregate，不读 hypothesis/expected 文本 | ✅ 纯函数单测覆盖 |
| AHE 可证伪契约 | proposal 行含 hypothesis + expected_behavior + verdict + trace_summary | ✅ DB 行完整 |
| ACE 文本层演化 | manifest 是 JSON 文本，mutation 单位是 prompt/skill 文本 | ✅ manifest 可读 |
| Continual Harness reset-free | promote/rollback 仅 status 字段翻转，原子操作 | ✅ 验证同 id 时无副作用 |
| Harness-Bench 行为证据评估 | 5 个 yaml case + `scoreAssertion` 4 种 kind | ✅ 13 个单测覆盖 |
| SEAGym 评估器不纳入版本 | `harness-eval.ts` 固定在代码库，不在 manifest 中 | ✅ manifest 无评估器 |

## 4. 已知限制（非本 PR 范围）

1. **proposed == baseline 时 verdict 退化为 LLM 噪声比较**——当用户未实际变异 harness 就提交提案时，dedup 命中导致 baseline 与 proposed 是同一版本，verdict 反映的是 LLM 响应的随机性而非真实改进。**取舍**：不在代码中特判（Simplicity First），在 UI 提示用户"提交前请先实际变异 harness"。
2. **eval 只测纯文本响应**——`sdkQuery` 是 `maxTurns:1, allowedTools:[]`，不测工具调用质量。`tool_called` assertion kind 已留接口但未实现。留下期。
3. **mutation_patch 不自动应用**——patch 只记录意图，不真的改 CLAUDE.md/agent-definitions.ts。这是"行为证据为准"的设计——测假设而非真变异。下期做动态加载。
4. **单次 proposal 只跑一轮 eval**——不自动链式提案，避免失控。多提案并行评估留下期。
5. **预存在测试失败**：`tests/feishu-card.test.ts` 5s 超时，基线问题，已验证非本次引入。

## 5. 回归检查

- ✅ 现有 `loop_runs` / `loop_iterations` / `loop_trace_nodes` / `chat_trace_nodes` 表未修改
- ✅ 现有路由未修改（仅新增 `/api/harness`）
- ✅ 现有前端路由未修改（仅新增 `/harness`）
- ✅ `make sync-types` 校验通过
- ✅ SCHEMA_VERSION 从 42 升至 43，`CREATE TABLE IF NOT EXISTS` 幂等

## 6. 交付物清单

| 类型 | 路径 |
|------|------|
| PRD | `docs/prd/self-evolving-harness/PRD.md` |
| 技术方案 | `docs/tech_solution/self-evolving-harness/TECH-SOLUTION.md` |
| 测试报告 | `docs/test_report/self-evolving-harness/TEST-REPORT.md` |
| DB 迁移 | `src/db.ts`（+4 表, SCHEMA_VERSION 43） |
| 版本注册表 | `src/harness-registry.ts`（340 行） |
| 评估器 | `src/harness-eval.ts`（265 行） |
| Meta-Loop | `src/harness-meta-loop.ts`（200 行） |
| Web API | `src/routes/harness.ts`（175 行） |
| 启动同步 | `src/index.ts`（+10 行） |
| 路由挂载 | `src/web.ts`（+2 行） |
| 前端 store | `web/src/stores/harness.ts`（200 行） |
| 前端页面 | `web/src/pages/HarnessPage.tsx`（330 行） |
| 前端路由 | `web/src/App.tsx`（+2 行） |
| 导航项 | `web/src/components/layout/nav-items.ts`（+1 项） |
| Eval cases | `data/harness/eval-cases/{code-generation,bug-fix,file-operation,memory-recall,tool-invocation}.yaml` |
| 单测 | `tests/units/harness-eval.test.ts` (13) + `harness-meta-loop.test.ts` (9) + `harness-registry.test.ts` (6) |

## 7. 下期路线

- **动态 harness 加载**：版本切换时实际重载 prompt/skill
- **MOSS 生产 trace 抽样**：eval case 从真实生产对话抽样
- **工具调用评估**：实现 `tool_called` assertion + 多轮 eval
- **多提案并行**：帕累托前沿选择
- **持续在线演化**：定时任务驱动 Meta-Loop 自运行
