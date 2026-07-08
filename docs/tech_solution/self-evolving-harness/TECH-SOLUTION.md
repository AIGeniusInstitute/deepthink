# 技术方案 — Self-Evolving Harness Loop

> 分支：`feat/self-evolving-harness`，基线 `main` @ `c7c985a`
> PRD：`docs/prd/self-evolving-harness/PRD.md`

---

## 1. 架构总览

```
┌─────────────────────────────────────────────────────────────────────┐
│                          Web UI / API                               │
│  HarnessPage.tsx ←→ routes/harness.ts (6 endpoints, admin-only)    │
└──────────────────────────────┬──────────────────────────────────────┘
                               │
┌──────────────────────────────▼──────────────────────────────────────┐
│                     harness-meta-loop.ts                            │
│  propose → register → eval → judge → promote|rollback              │
│  verdict rules: behavior-evidence-only                             │
└────┬──────────────────────┬─────────────────────────┬──────────────┘
     │                      │                         │
     ▼                      ▼                         ▼
┌──────────┐         ┌─────────────┐          ┌──────────────┐
│ registry │         │   eval      │          │  proposals   │
│  .ts     │         │   .ts       │          │  (db)        │
│ snapshot │         │ runEval()   │          │              │
│ list/diff│         │ score       │          │              │
│ rollback │         │             │          │              │
└────┬─────┘         └──────┬──────┘          └──────────────┘
     │                      │
     ▼                      ▼
┌────────────────────────────────────────────────────────┐
│  data/harness/versions/{id}/manifest.json (文本快照)   │
│  data/harness/eval-cases/*.yaml (基准)                 │
│  DB: harness_versions / _proposals / _eval_runs /      │
│      _eval_cases                                        │
│  trace 证据: chat_trace_nodes + loop_trace_nodes        │
└────────────────────────────────────────────────────────┘
```

**核心设计原则**：
1. **版本快照是文本**（manifest.json），不是可执行代码——变异单位是 prompt/skill 内容，符合 ACE "文本层演化"；
2. **评估器不纳入版本**——`harness-eval.ts` 固定在代码库，作为外部裁判（SEAGym 做法），避免自举悖论；
3. **行为证据 = trace DAG ref**——eval run 只存 `trace_node_root` 指针，不复制 trace 内容；
4. **版本切换是数据库标记**——promote/rollback 仅改 `status` 字段，原子操作，符合 Continual Harness "reset-free"。

## 2. 数据模型

### 2.1 新增 4 张表（`src/db.ts` migration v42 → v43）

```sql
CREATE TABLE IF NOT EXISTS harness_versions (
  id TEXT PRIMARY KEY,
  parent_id TEXT,
  hash TEXT NOT NULL,
  manifest_json TEXT NOT NULL,
  status TEXT NOT NULL DEFAULT 'experimental'
    CHECK(status IN ('experimental','promoted','archived','rolled_back')),
  source TEXT NOT NULL DEFAULT 'manual',
  created_at TEXT NOT NULL,
  promoted_at TEXT,
  notes TEXT
);
CREATE INDEX IF NOT EXISTS idx_harness_versions_status ON harness_versions(status);
CREATE INDEX IF NOT EXISTS idx_harness_versions_parent ON harness_versions(parent_id);

CREATE TABLE IF NOT EXISTS harness_proposals (
  id TEXT PRIMARY KEY,
  proposed_version_id TEXT NOT NULL,
  baseline_version_id TEXT NOT NULL,
  hypothesis TEXT NOT NULL,
  expected_behavior TEXT NOT NULL,
  mutation_patch TEXT NOT NULL,
  verdict TEXT,
  evidence_run_ids_json TEXT,
  trace_summary TEXT,
  created_at TEXT NOT NULL,
  judged_at TEXT,
  FOREIGN KEY (proposed_version_id) REFERENCES harness_versions(id),
  FOREIGN KEY (baseline_version_id) REFERENCES harness_versions(id)
);
CREATE INDEX IF NOT EXISTS idx_harness_proposals_baseline ON harness_proposals(baseline_version_id);

CREATE TABLE IF NOT EXISTS harness_eval_runs (
  id TEXT PRIMARY KEY,
  version_id TEXT NOT NULL,
  proposal_id TEXT,
  case_id TEXT NOT NULL,
  status TEXT NOT NULL DEFAULT 'pending'
    CHECK(status IN ('pending','running','completed','failed')),
  pass INTEGER,
  score REAL,
  trace_node_root_id INTEGER,
  started_at TEXT NOT NULL,
  finished_at TEXT,
  error TEXT,
  FOREIGN KEY (version_id) REFERENCES harness_versions(id),
  FOREIGN KEY (proposal_id) REFERENCES harness_proposals(id)
);
CREATE INDEX IF NOT EXISTS idx_harness_eval_runs_version ON harness_eval_runs(version_id);
CREATE INDEX IF NOT EXISTS idx_harness_eval_runs_proposal ON harness_eval_runs(proposal_id);

CREATE TABLE IF NOT EXISTS harness_eval_cases (
  case_id TEXT PRIMARY KEY,
  name TEXT NOT NULL,
  prompt TEXT NOT NULL,
  assertions_json TEXT NOT NULL,
  rubric_json TEXT NOT NULL,
  enabled INTEGER NOT NULL DEFAULT 1,
  created_at TEXT NOT NULL
);
```

### 2.2 行类型（`src/db.ts` 导出）

```ts
export interface HarnessVersionRow { id, parent_id, hash, manifest_json, status, source, created_at, promoted_at, notes }
export interface HarnessProposalRow { id, proposed_version_id, baseline_version_id, hypothesis, expected_behavior, mutation_patch, verdict, evidence_run_ids_json, trace_summary, created_at, judged_at }
export interface HarnessEvalRunRow { id, version_id, proposal_id, case_id, status, pass, score, trace_node_root_id, started_at, finished_at, error }
export interface HarnessEvalCaseRow { case_id, name, prompt, assertions_json, rubric_json, enabled, created_at }
```

### 2.3 文件布局

```
data/harness/
  versions/{version_id}/
    manifest.json     # 完整快照（system prompt + subagents + tool signatures + skill ids + CLAUDE.md hash）
    mutation.patch    # 提案 patch（仅 proposal 创建时写入）
  eval-cases/
    code-generation.yaml
    bug-fix.yaml
    file-operation.yaml
    memory-recall.yaml
    tool-invocation.yaml
```

## 3. 模块设计

### 3.1 `src/harness-registry.ts`

**职责**：版本快照、列表、diff、rollback。**不**依赖 Claude SDK，纯 DB + fs 操作。

```ts
export interface HarnessManifest {
  schema_version: 1;
  captured_at: string;
  system_prompt: string;            // 完整 system prompt 文本
  subagents: Record<string, { description, prompt, tools: string[], model, maxTurns }>;
  tool_signatures: { name: string; description: string }[];  // 仅签名，不含实现
  skill_ids: string[];              // 启用的 skill 名
  claude_md_hash: string;           // CLAUDE.md 内容 sha256
  source_files: { path: string; hash: string }[];
}

export function snapshotCurrentHarness(opts: { source?: string; parentId?: string; notes?: string }): HarnessVersionRow;
export function listVersions(opts?: { status?: string; limit?: number }): HarnessVersionRow[];
export function getVersion(id: string): HarnessVersionRow | undefined;
export function getVersionManifest(id: string): HarnessManifest;
export function diffVersions(aId: string, bId: string): { added, removed, changed };
export function rollbackTo(versionId: string): void;  // 把当前 promoted 标 archived，目标标 promoted
export function promoteVersion(versionId: string): void;
```

**快照来源**：
- `system_prompt`：从 `container/agent-runner/src/agent-definitions.ts` + `CLAUDE.md` 读取（host 进程可直接读仓库文件）；
- `subagents`：直接 `import { PREDEFINED_AGENTS }` — 但 `src/` 不能 import `container/agent-runner/src/`（不同 ts 项目）。**取舍**：用 `fs.readFileSync` 读 `container/agent-runner/src/agent-definitions.ts` 源文件 + 简易正则提取 subagent 块；或在 `agent-definitions.ts` 旁放一份 JSON 镜像。**选 fs read**——保持单一真相源，避免镜像漂移。
- `tool_signatures`：从 `mcp-tools.ts` 静态提取工具名清单（正则扫 `tool({...name: 'xxx'})` 模式）；
- `claude_md_hash`：`crypto.createHash('sha256').update(fs.readFileSync('CLAUDE.md'))`。

### 3.2 `src/harness-eval.ts`

**职责**：对指定版本跑 eval case，产出行为证据。**评估器不纳入版本**。

```ts
export interface EvalCase {
  case_id: string;
  name: string;
  prompt: string;
  assertions: { kind: 'contains' | 'not_contains' | 'regex' | 'tool_called' | 'no_error'; value: string }[];
  rubric: { weights: Record<string, number>; pass_threshold: number };
}

export interface EvalCaseResult {
  case_id: string;
  pass: boolean;
  score: number;
  trace_root_node_id?: number;   // 指向 chat_trace_nodes 或 loop_trace_nodes
  evidence_summary: string;
  error?: string;
}

export async function runEvalForVersion(versionId: string, caseIds?: string[]): Promise<{
  results: EvalCaseResult[];
  aggregate: { total: number; passed: number; failed: number; score: number };
  trace_run_id: string;          // 关联到一个临时 loop_run 用作 trace 容器
}>;

export function loadEvalCases(): EvalCase[];   // 从 data/harness/eval-cases/*.yaml
export function scoreAssertion(...): boolean;  // 单测可覆盖
```

**评估流程**：
1. 创建一个 `loop_runs` 记录（kind=`proactive`, goal_text=`[harness-eval] case xxx`, max_turns=1）作为 trace 容器；
2. 对每个 case：调用 `sdkQuery(prompt, { maxTurns: 1 })`，捕获结果文本；
3. 创建 `chat_trace_nodes` 顶级 turn 节点（node_type='turn', input_summary=prompt, output_summary=result）；
4. 跑 assertion 匹配，产出 `EvalCaseResult`；
5. 写 `harness_eval_runs` 行，`trace_node_root_id` 指向 trace 节点。

**关键点**：
- `sdkQuery` 已是 `maxTurns:1, allowedTools:[]` 的纯文本查询——这正好让 eval 测的是 **prompt 的纯文本响应质量**，不被工具调用污染（AHE 的"可证伪契约"原则）。
- 但 `tool_called` assertion 需要工具调用——**取舍**：本期 eval 只测纯文本响应（assertion kinds: `contains/not_contains/regex/no_error`），`tool_called` 留接口但暂不实现（标注 TODO）。
- `no_error` = sdkQuery 返回 null 或 trace 中有 error 节点即判 fail。

### 3.3 `src/harness-meta-loop.ts`

**职责**：编排 propose→register→eval→judge→promote/rollback。**只看行为证据**。

```ts
export type Verdict = 'improved' | 'regressed' | 'neutral' | 'inconclusive';

export async function runMetaLoopForProposal(proposalId: string): Promise<{
  verdict: Verdict;
  baseline_pass_rate: number;
  proposed_pass_rate: number;
  evidence_run_ids: string[];
  trace_summary: string;
}>;

export function judgeVerdict(baseline: EvalAggregate, proposed: EvalAggregate, baselineResults, proposedResults): Verdict;
```

**Verdict 规则**（纯函数，单测覆盖）：
- `regressed`：proposed 出现 baseline 没有的 fail case；
- `improved`：proposed pass 率 **严格高于** baseline，且无 regressed；
- `neutral`：pass 率持平且 fail case 集合相同；
- `inconclusive`：任一 aggregate 出错（total=0 或有 error）。

**Promote 决策**：
- `improved` → promote proposed, archive baseline；
- 其他 → rollback proposed（标 `rolled_back`），baseline 保持 `promoted`；
- 失败变体**保留在档案库**（不删，可作为未来提案的 `parent_id` 引用）。

### 3.4 `src/routes/harness.ts`

6 个端点，全部 `adminRoleMiddleware`：

| Method | Path | 功能 |
|--------|------|------|
| GET | `/api/harness/versions` | 列版本（可选 `?status=`） |
| POST | `/api/harness/snapshot` | 打当前快照 |
| GET | `/api/harness/versions/:id` | 版本详情 + manifest |
| GET | `/api/harness/versions/:id/diff/:otherId` | 两版 diff |
| POST | `/api/harness/versions/:id/rollback` | 回滚到该版本 |
| POST | `/api/harness/proposals` | 提案 → 自动触发 Meta-Loop |
| GET | `/api/harness/proposals/:id` | 提案详情 + 证据 trace |
| GET | `/api/harness/eval-runs` | 评估历史（可选 `?version_id=`） |
| GET | `/api/harness/eval-cases` | 基准用例列表 |

注册到 `web.ts`：`app.route('/api/harness', harnessRoutes);`

### 3.5 前端

- `web/src/stores/harness.ts`：Zustand store，版本列表 + 选中版本 + 提案列表 + eval runs。
- `web/src/pages/HarnessPage.tsx`：左 2/3 版本列表（含 status 徽章 + verdict 徽章），右 1/3 详情面板（manifest + diff + 提案 + eval 历史 + rollback 按钮 + 提交提案表单）。
- 路由 `/harness`（`web/src/App.tsx` 加 lazy 路由）。
- 导航项 `{ path: '/harness', icon: GitBranch, label: 'Harness' }`（`nav-items.ts`）。

## 4. 5 个 Eval Case

`data/harness/eval-cases/*.yaml`，每个 case 测一种基础能力：

| Case | 测什么 | assertion 示例 |
|------|--------|---------------|
| `code-generation` | 给需求生成代码 | `contains:"function"`, `regex:/def\s+\w+|const\s+\w+/` |
| `bug-fix` | 给 buggy 代码指出问题 | `contains:"bug"`, `not_contains:"I cannot"` |
| `file-operation` | 描述文件操作步骤 | `contains:"read"`, `contains:"write"` |
| `memory-recall` | 给上下文问细节 | `contains:"<expected detail>"` |
| `tool-invocation` | 描述该用哪个工具 | `contains:"<tool name>"` |

YAML schema 简单：
```yaml
case_id: code-generation
name: 代码生成基础
prompt: |
  写一个 Python 函数 add(a, b) 返回两数之和。只输出代码，不要解释。
assertions:
  - { kind: contains, value: "def add" }
  - { kind: regex, value: "return\\s+a\\s*\\+\\s*b" }
rubric:
  weights: { default: 1.0 }
  pass_threshold: 1.0
```

## 5. 关键取舍

1. **不做动态 harness 加载**——版本快照只用于记录与 diff，不实际切换运行时 harness。本期只验证"可记录/可测试/可回滚"闭环。动态加载留待下期。
2. **eval 只测纯文本**——`sdkQuery` 是 `maxTurns:1, allowedTools:[]`，测的是 prompt 的纯响应质量，简单可重复。工具调用评估留下期。
3. **proposal 的 mutation_patch 不自动应用**——patch 只记录意图，不真的改 `agent-definitions.ts`。这是"行为证据为准"的体现：我们测的是假设，不是真的变异代码。
4. **trace 复用现有表**——不新建 trace 表，eval run 在 `loop_trace_nodes` + `chat_trace_nodes` 里建临时 trace，`harness_eval_runs.trace_node_root_id` 指过去。
5. **Meta-Loop 不自驱动**——单次 proposal 跑一轮，不自动链式提案。避免失控。

## 6. 测试策略

| 层 | 覆盖 | 工具 |
|----|------|------|
| 单测 | `scoreAssertion` 各 kind、`judgeVerdict` 4 种 verdict、`parseManifest`、`diffVersions` | vitest |
| 集成 | `runMetaLoopForProposal` 端到端（mock sdkQuery） | vitest + mock |
| 手测 | UI 走查一次完整流程 | browser |

新增测试文件：
- `tests/units/harness-registry.test.ts` — manifest 解析、diff
- `tests/units/harness-eval.test.ts` — assertion scorer
- `tests/units/harness-meta-loop.test.ts` — verdict 规则

## 7. 实施步骤

1. DB migration + 4 张表 + 行类型 + CRUD 函数（`db.ts`）
2. `harness-registry.ts` + 单测
3. 5 个 eval case yaml + `harness-eval.ts` + 单测
4. `harness-meta-loop.ts` + 单测
5. `routes/harness.ts` + 挂到 `web.ts`
6. `web/src/stores/harness.ts` + `HarnessPage.tsx` + 路由 + 导航
7. `make sync-types && make typecheck && make test`
8. 修失败 → 手测 → 测试报告 → commit + push + merge

## 8. 风险与回滚

- **风险**：migration 失败 → `SCHEMA_VERSION` 不变，`CREATE TABLE IF NOT EXISTS` 幂等；
- **风险**：sdkQuery 在测试环境无 Claude 凭据 → eval 单测 mock `sdkQuery`，集成测跳过（`it.skipIf(!process.env.ANTHROPIC_API_KEY)`）；
- **风险**：前端路由冲突 → `/harness` 未被占用，已确认。
