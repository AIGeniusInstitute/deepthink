# 技术方案 — 反馈与学习自进化模块（FLM）

> 对应 PRD：[`docs/prd/feedback-learning-module/PRD.md`](../../prd/feedback-learning-module/PRD.md)
> 日期：2026-10-10　｜　分支：`feature/feedback-learning-module`

---

## 0. 前置结论（来自代码侦察，均已验证）

落地前先确认既有能力边界，避免重复实现。**证据见 PRD §1.2**。三条硬约束：

1. **不重写评分引擎** —— `src/eval-center/eval-scoring.ts` 已有「确定性断言 + LLM Judge + 置信度聚合」，但它评的是 golden test case。FLM 评的是线上真实任务，输入与结论语义不同，**新建**但聚焦「三档结论 + 归因到环节」。
2. **不重写策略版本** —— `src/harness-registry.ts` 版本化的是 harness manifest 且只有全量翻转。FLM 的策略单元是 prompt/routing/param/fewshot，**且灰度是必需的**（全仓库无此概念）。
3. **不新建轨迹表** —— 复用 `chat_trace_nodes` / `trace_steps` / `trace_tool_calls`。

## 1. 分层与文件清单

```
src/flm/                          ← 新建模块目录（对齐 src/eval-center/ 的组织方式）
  flm-types.ts                    类型定义（与 db.ts 的 Row 类型分离：对外 DTO）
  flm-config.ts                   模块配置读写（采样率/白名单/重试/脱敏/告警/降级开关）
  flm-normalize.ts                F2 归一化：实体对齐、时序对齐、冲突消解、去重、脱敏
  flm-evaluate.ts                 F3 三层评价 + 归因（纯函数为主，可单测）
  flm-learn.ts                    F4 学习层：短期纠偏、经验记忆、数据回流、知识条目
  flm-closedloop.ts               F5 闭环：门禁、灰度、回滚、审计
  flm-collect.ts                  F1 采集：用户反馈落库、系统日志订阅、环境快照
  flm-insights.ts                 F6 看板聚合查询

src/routes/flm.ts                 ← HTTP 路由，挂载 /api/flm
src/flm/flm-db.ts                 ← FLM 数据访问层（用 db.ts 导出的 getDb()）
src/db.ts                         ← 仅新增 CREATE TABLE + SCHEMA_VERSION 71
src/web.ts                        ← import + app.route 各一行

web/src/api/flm.ts                ← API 客户端
web/src/stores/flm.ts             ← zustand store
web/src/pages/FeedbackLearningPage.tsx   ← 控制台（7 Tab）
web/src/components/chat/MessageFeedback.tsx ← 消息级反馈组件（新文件）
web/src/components/chat/MessageBubble.tsx   ← 仅插入组件（2 处，各 1 行）
web/src/components/layout/nav-items.ts      ← 新增 1 个导航项
web/src/App.tsx                             ← 新增 1 条 lazy + 1 条 Route
```

**取舍说明（为什么 DDL 在 `db.ts`、CRUD 在 `src/flm/flm-db.ts`）**：
`src/eval-center/` 两者都在自己目录，是因为它的表在**独立 PG 库**、schema 也独立加载。
FLM 的表在**主库**，必须与 `SCHEMA_VERSION` 迁移机制同源 —— 按 `docs/howto/modify-db-schema.md`，
建表语句与版本号**只能**在 `db.ts` 一处，否则会分裂出第二条迁移路径。
而 CRUD 放模块内是 `src/autonomy/` 的既有范式（`autonomy-adapt.ts` 等用 `getDb()` 直接查询），
既避免给 13k 行的 `db.ts` 再加数百行，也让 FLM 的读写逻辑内聚在一处。

> ⚠️ **实施期修正**：本方案初稿写的是「CRUD 也放 `db.ts`」。落地时按 `src/autonomy/` 的既有范式
> 改为 `src/flm/flm-db.ts` + `getDb()` —— 侦察确认 `getDb()` 是已建立的跨模块查询入口
> （`src/routes/files.ts`、`src/routes/agent-groups.ts`、`src/autonomy/autonomy-adapt.ts` 均如此）。
> 此处保留修正痕迹，避免文档与实际实现不一致。

---

## 2. 数据模型

### 2.1 表清单（11 张，全部落主库）

| 表 | 用途 | 关键列 |
|---|---|---|
| `flm_feedback` | 用户反馈原始记录（消息级） | `id, message_id, chat_jid, user_id, session_id, turn_id, task_id, trace_id, step_id, type, rating, reason_tags, correction_text, payload, created_at, updated_at` |
| `flm_events` | **归一化后的统一反馈事件** | `event_id, source, type, task_id, trace_id, session_id, step_id, chat_jid, user_id, raw_payload, normalized_payload, confidence, weight, alignment, dedup_key, desensitized, tenant_id, occurred_at, created_at` |
| `flm_evaluations` | **三层评价结果 + 归因** | `eval_id, task_id, trace_id, session_id, chat_jid, outcome(achieved/partial/failed), outcome_reason, process_score, path_conformity, step_count, retry_count, first_anomaly_step, duration_ms, quality_scores, attribution_stage, evidence_json, evaluator(rule/llm/human), needs_review, review_status, eval_time` |
| `flm_cases` | **经验记忆案例** | `case_id, task_id, sample_type(positive/negative), goal, goal_embedding, summary, attribution_stage, reuse_count, verified, source_event_id, created_at` |
| `flm_strategies` | **策略版本** | `version_id, strategy_type(prompt/routing/param/fewshot), name, content, parent_version, trigger_source(auto/human), attribution_tag, eval_report, gate_status(passed/blocked/na), gray_ratio, status(draft/canary/released/rolled_back/archived), requires_human_review, publisher, publish_time, created_at` |
| `flm_actions` | **闭环动作记录** | `action_id, eval_id, action_type(retry/replan/strategy_update/rollback), before_version, after_version, executor, result, detail, exec_time` |
| `flm_observations` | 环境观测点注册 | `id, name, path, expected, enabled, created_by, created_at` |
| `flm_snapshots` | 环境快照与 diff | `id, task_id, phase(before/after), payload, ttl_seconds, expired, captured_at` |
| `flm_config` | 模块配置（KV） | `key PRIMARY KEY, value, updated_at` |
| `flm_alerts` | 告警记录 | `id, metric, threshold, actual, level, message, acked, created_at` |
| `flm_audit` | 策略全链路审计 | `id, version_id, action, detail, actor, created_at` |

### 2.2 迁移方式

按 `docs/howto/modify-db-schema.md`：
1. 在 `db.ts` 的 `initDatabase()` 内追加 `db.exec(\`CREATE TABLE IF NOT EXISTS ...\`)` 块（含索引）
2. `SCHEMA_VERSION` 由 `'70'` → `'71'`
3. **不使用** `ADD COLUMN IF NOT EXISTS`（PG 专有语法，会打断 SQLite 批处理）

**无运行时资产**：FLM 不引入 `.sql` 文件，因此**不涉及** `scripts/copy-runtime-assets.cjs` 的资产清单（这正是 2026-09-29 Eval Center 事故的成因，本方案从结构上规避）。

### 2.3 SQL 兼容性约束

所有 SQL 必须同时可在 SQLite 与 PostgreSQL 下执行：
- 用 `INSERT OR REPLACE` / `INSERT OR IGNORE`（由 `sql-translator.ts` 翻译）
- 不用 `ON CONFLICT ... DO UPDATE`（翻译器覆盖不全）
- 不用 `jsonb` 函数；JSON 以 TEXT 存储，读取侧 `JSON.parse`
- 时间统一 `Date.now()` 毫秒整数，**不用** PG 的 `now()`

---

## 3. 关键算法

### 3.1 F2 归一化（`flm-normalize.ts`）

```
输入：FeedbackEvent 草稿（来自采集层三类来源）
  ↓ normalizeEvent(draft)
1. 实体对齐   alignEntity(draft)
     - 四级主键依次尝试：task_id → trace_id → session_id → (chat_jid + 时间窗)
     - 命中即记 alignment='direct'；仅时间窗命中记 'fallback'
     - 时间窗兜底：|occurred_at - message.timestamp| <= 120s 且同 chat_jid
2. 时序对齐   按 occurred_at 排序（乱序输入在此修正）
3. 脱敏       desensitize(payload)   ← 规则从 flm_config 读，热更新
4. 置信度     confidence = base(source) × decay(alignment)
     base: user 0.9 / system 1.0 / env 0.8
     decay: direct 1.0 / fallback 0.6
5. 去重       dedup_key = sha1(source|type|chat_jid|step_id|floor(occurred_at/60s))
     同 key 已存在 → 只更新 confidence 取 max，不新增
6. 冲突消解   resolveConflict(events) —— 同一 task 下 user 与 system 结论矛盾时
     取 weight × confidence 高者为主结论，另一条记入 evidence 并标 `conflict=true`
```

**脱敏规则**（`flm_config` 键 `desensitize_rules`，JSON 数组）：
默认五类 —— 手机号 / 身份证 / 银行卡 / 邮箱 / Token（`sk-`、`ghp_`、`Bearer` 形态）。
每条规则 `{ name, pattern, flags, mask }`，运行时 `new RegExp` 编译（**规则来自 admin 配置，非用户输入**；仍做 `try/catch` 防止非法正则拖垮归一化）。

### 3.2 F3 三层评价（`flm-evaluate.ts`）

纯函数，无 IO、无 LLM 依赖，因此**可单测且必然 ≤10s**。

```
evaluateTask(ctx) → EvalResult
  ctx = { taskId, traceId, sessionId, chatJid, events[], traceNodes[], traceSteps[], toolCalls[] }

【结果层】outcomeOf(ctx)
  信号：负向反馈（reject/低分/未完成标签）、正向反馈（like/高采纳）、
        工具失败率、trace 终态 status、环境 diff 是否达预期
  规则：
    存在 env 事件且 diff 判定"未达成"           → failed
    存在显式 reject 或 rating<=2                → failed
    无负向信号且（正向信号存在 或 全链路成功）   → achieved
    其余（有失败但无负向、或正负混杂）           → partial
  → 输出 outcome + outcome_reason（列出命中的判据，供可解释）

【过程层】processOf(ctx)
  path_conformity = 成功步骤数 / 总步骤数
  step_count / retry_count（从 trace 的重复节点名统计）
  duration_ms = sum(step.ended_at - step.started_at)
  first_anomaly_step = 首个 status != 'ok' 的步骤（按 started_at）

【质量层】qualityOf(ctx)  —— 六维，各 0..100
  factuality      : 无"事实错误"标签且无 tool error  → 100/60/30 分档
  format          : 无"格式不符"标签
  latency         : 由 duration_ms 相对阈值分档
  cost            : 由 token 消耗相对阈值分档
  safety          : 无安全合规标记
  preference      : 由正向反馈比例

【归因】attribute(ctx, outcome) —— 仅在 outcome != achieved 时执行
  按优先级逐条判定，命中即停（首个异常点优先）：
    intent          : 用户反馈含"答非所问" / 首步即失败
    planning        : 步骤数显著超预期且无工具失败
    tool_selection  : 工具调用报错且存在未使用的备选工具
    param_gen       : 工具调用报错且入参格式错误
    execution       : 工具超时/限流/环境类错误
    summary         : 全部工具成功但结果层仍 failed（输出环节）

【证据】evidence[] —— 每条 { kind, ref, excerpt }
  kind ∈ feedback | log | env | trace
  可解释率 100%：结论必带 ≥1 条证据（无证据时补一条 trace 终态引用）
```

**双轨（AC-F3.2）**：`evaluateTask` 加可选参数 `{ useLlm: boolean }`。
开启时调用既有 provider 做一次判定，与规则轨比对：一致 → `evaluator='rule'`；不一致 → `evaluator='both'` 且 `needs_review=1`。
**默认 `useLlm=false`**，保证验收路径不依赖外部模型网络。

### 3.3 F4 学习层（`flm-learn.ts`）

- **短期纠偏** `planCorrection(evalResult, cfg)`：按重试上限 / 退避序列 / 工具白名单产出一个纠偏计划。**耗时闸门**：`projectedMs > originalMs * 2` 则直接判「降级人工介入」而不重试（满足 AC-F4.1/4.2）。
- **经验记忆** `indexCase(ctx)`：调 `src/embedding.ts` 的 `embedText()`。**未配置 embedding 时降级**为关键词匹配（与 `src/embedding.ts` 既有降级策略一致），并在返回值标注 `indexMode='embedding'|'keyword'`，避免"检索悄悄失灵"。
- **数据回流** `buildPreferenceDataset()`：从 `flm_cases` 的正负样本配对产出 `{chosen, rejected, source_case_id, generated_at}`；SFT 语料取 positive 的 goal + summary。**每条必带来源与生成时间**（AC-F4.6）。
- **知识条目** `proposeKnowledgeEntry()`：纠错类反馈 → 候选（状态 `pending`）→ 审核通过才写入既有知识库表。

### 3.4 F5 闭环（`flm-closedloop.ts`）

```
gateCheck(version)   —— 回归门禁
  对比 parent_version 的 eval_report 基线：任一核心指标劣化 > 阈值 → gate_status='blocked'
  核心指标：成功率、满意度、纠偏率（阈值取自 flm_config，默认 5%）
  blocked 的版本 status 停留 'draft'，不可放量（AC-F5.2 / TC-FLM-21）

release(version, ratio, target)
  ratio >= 100 → status='released'
  1 <= ratio < 100 → status='canary'，记录 gray_ratio（最小 1%，AC-F5.3）
  requires_human_review=1 且未审核 → 拒绝放量（AC-F5.5）

rollback(version, reason)
  status='rolled_back'，parent_version 恢复为生效版本
  同步写 flm_actions(action_type='rollback') + flm_audit + flm_alerts
  从触发到状态落库是同一次同步写，远小于 60s（AC-F5.4）

every(version, action, detail)  → flm_audit  全链路留痕（AC-F5.6）
```

**灰度判定**：`isStrategyActive(version, sessionKey)` 用 `sha1(version_id + sessionKey) % 100 < gray_ratio` 做**确定性**分桶（同一会话结果稳定，避免同一用户反复横跳）；`sha1` 而非 `Math.random` 是为了可复现——同一输入必得同一结论，否则无法测试。

---

## 4. API 设计（`/api/flm`）

| 方法 | 路径 | 权限 | 用途 |
|---|---|---|---|
| POST | `/feedback` | 登录用户 | 提交/更新消息反馈（幂等，AC-F1.1.5） |
| GET | `/feedback/mine?messageId=` | 登录用户 | 回显当前用户对该消息的评价 |
| GET | `/events` | admin | 反馈事件流（F2 结果） |
| POST | `/events/normalize` | admin | 触发归一化（采集→归一化） |
| POST | `/collect/system` | admin | 订阅系统日志产出事件 |
| GET/POST | `/observations` | admin | 环境观测点 |
| POST | `/snapshots/diff` | admin | 提交前后快照并计算 diff |
| POST | `/evaluate` | admin | 触发三层评价（可带 `{useLlm}`） |
| GET | `/evaluations` | admin | 评价列表（支持 outcome/stage 过滤） |
| GET | `/evaluations/:id` | admin | 评价详情（含证据） |
| GET | `/reviews` | admin | 人工复核队列 |
| POST | `/reviews/:id` | admin | 提交复核结论 |
| GET | `/cases` | admin | 案例库列表 |
| POST | `/cases/search` | admin | 向量/关键词检索 Top-K |
| PATCH | `/cases/:id` | admin | 人工修正归因标签 |
| POST | `/cases/index` | admin | 从评价沉淀案例 |
| POST | `/corrections/plan` | admin | 短期纠偏计划 |
| GET | `/strategies` | admin | 策略版本列表 |
| POST | `/strategies` | admin | 新建策略版本（含从归因生成建议） |
| POST | `/strategies/:id/gate` | admin | 跑回归门禁 |
| POST | `/strategies/:id/release` | admin | 灰度/放量 |
| POST | `/strategies/:id/rollback` | admin | 回滚 |
| GET | `/strategies/compare?a=&b=` | admin | A/B 对比 + 放量建议 |
| GET | `/actions` | admin | 闭环动作记录 |
| GET | `/audit` | admin | 审计时间线 |
| GET | `/overview` | admin | 总览指标 |
| GET | `/attribution` | admin | 归因多维下钻 |
| POST | `/datasets/preference` | admin | 生成偏好数据集 |
| GET | `/datasets/preference/export` | admin | 导出 |
| POST | `/knowledge/propose` | admin | 生成知识条目候选 |
| GET/POST | `/knowledge/candidates` | admin | 候选列表 / 审核 |
| GET/PUT | `/config` | admin | 模块配置（含降级开关） |
| GET | `/alerts` | admin | 告警列表 |
| PATCH | `/alerts/:id` | admin | 确认告警 |
| GET | `/health` | 登录用户 | 模块健康与降级状态（**供前端展示，不需 admin**） |

**鉴权分层**：
- `/feedback`、`/feedback/mine`、`/health` → `authMiddleware`（普通用户可用，这是消息反馈的入口）
- 其余 → `adminRoleMiddleware`（与 `/api/autonomy`、`/api/harness` 一致，FLM 控制台是运营面）

**降级开关（AC-F0.1）**：`flm_config.enabled`。所有写路径入口先查 `isEnabled()`；关闭时：
- `POST /feedback` 仍返回 200 但写 `skipped` 标记（**不阻断用户操作**）
- 采集/评价定时逻辑直接 return
- `GET /health` 返回 `{ enabled: false }`，前端横幅提示「已降级」

---

## 5. 前端设计

### 5.1 消息反馈组件（`MessageFeedback.tsx`）

- 位置：`MessageBubble` 的 AI 消息动作栏（紧凑模式 L506-532 区、气泡模式 L882-915 区），各插一行。
- 交互：👍 / 👎 两按钮 → 点踩弹出原因标签（六选一/多选）+ 纠错文本框 → 提交 → toast。
- 状态：本地 `useState` 保存当前评价；挂载时 `GET /feedback/mine?messageId=` 回显。
- **memo 安全性**：组件内部自持状态，不新增 props，`MessageBubble` 的 `memo` 比较器无需改动。
- **不阻断主链路**：提交失败仅 toast，`cancelable`，不影响消息。

### 5.2 控制台（`FeedbackLearningPage.tsx`）

路由 `/feedback`，7 个 Tab：

| Tab | 内容 | 覆盖 |
|---|---|---|
| 总览 | 五指标卡片 + 趋势 + 降级横幅 | AC-F6.1 |
| 反馈流 | 事件表（来源/类型/置信度/绑定），可筛 | AC-F1.1.3, F2.1 |
| 评价与归因 | 评价列表 + 详情抽屉（三层分 + 证据） + 复核队列 | AC-F3.x |
| 案例库 | 检索框 + 结果列表 + 归因标签编辑 | AC-F4.3/4.4/6.3 |
| 策略版本 | 版本表 + 门禁/灰度/回滚按钮 + A/B 对比 | AC-F5.x, F6.4 |
| 动作与审计 | 动作时间线 + 审计日志 | AC-F5.6 |
| 设置 | 采样率/白名单/重试/脱敏规则/观测点/告警阈值/降级开关 | AC-F1.2.2, F1.3.1, F2.6, F4.1, F6.5 |

### 5.3 导航

`nav-items.ts` 的 `baseNavItems` 增 `{ path: '/feedback', icon: MessageSquareHeart, label: '反馈学习' }`。
> 图标 `MessageSquareHeart` 需确认存在于所用 `lucide-react` 版本；不存在则退用已有的 `MessageCircle` 同族图标（构建期即可发现）。

---

## 6. 测试策略

| 层 | 方式 | 覆盖 |
|---|---|---|
| 单元 | `tests/units/flm-*.test.ts`（vitest） | 归一化（对齐/去重/脱敏/冲突）、三层评价、归因、门禁、灰度分桶、纠偏闸门 |
| 集成 | `tests/flm-module.test.ts` | 建表可用 + CRUD 往返 + API 契约 |
| 冒烟门禁 | `make test-smoke` 清单增补 FLM 用例 | CI PR 门禁 |
| **UI 验收** | Playwright 脚本 `scripts/e2e/flm-acceptance.cjs` | **32 条 TC 逐条截图** |

**CI 门禁约束（CLAUDE.md 明确）**：新增核心能力（trace / validation / eval 等）须同步加进 `make test-smoke` 的固定清单。FLM 属此类，**必须**加。

### 6.1 UI 验收脚本设计

- 复用 `scripts/e2e/agent-group-chat-acceptance.cjs` 的既有范式（`playwright-core` + API 登录拿 cookie + `addInitScript` 注入 + 截图 + 结果 JSON）。
- **有界视口截图**：按页面真实内容高度自适应并设上限（吸取上一轮「全页截图撑到 25094px」的教训）。
- 用例执行前**清理自己造的数据**（前缀 `zz-flm-`），避免污染共享 dev。
- 截图输出到 `output/flm-acceptance/`，报告生成器读取结果 JSON + 截图内嵌成单文件 HTML。

---

## 7. 风险与对策

| 风险 | 对策 |
|---|---|
| 改动 `MessageBubble`（955 行、被所有会话复用）引入回归 | 只在动作栏插一行；组件自持状态不改 props；跑 `make test` + 聊天页人工回归 |
| 新增 11 张表影响 `SCHEMA_VERSION` 迁移 | 全部 `CREATE TABLE IF NOT EXISTS`（幂等）；跑 `make test`（含 db 相关用例）验证 |
| PG 模式下 SQL 不兼容 | 严格按 §2.3 约束；本地以 SQLite 验收 + 静态审查 SQL 方言 |
| 灰度分桶用随机数导致测试不稳定 | 用 `sha1` 确定性分桶（§3.4） |
| 检索依赖 embedding，未配置时静默失灵 | 降级关键词匹配 + 返回值显式标注 `indexMode` |
| 验收数据污染共享 dev | 测试数据统一 `zz-flm-` 前缀 + 用例前置清理 + 用例后置清理 |

---

## 8. 实施顺序

1. **数据层**：`db.ts` 建表 + Row 类型 + CRUD（SCHEMA_VERSION 71）
2. **纯函数层**：`flm-normalize.ts` / `flm-evaluate.ts`（先写单测，可离线验证）
3. **业务层**：`flm-collect.ts` / `flm-learn.ts` / `flm-closedloop.ts` / `flm-insights.ts`
4. **路由层**：`src/routes/flm.ts` + `web.ts` 挂载
5. **前端**：api → store → 控制台页面 → 消息反馈组件 → 路由与导航
6. **测试**：单测 → `make test` → `make typecheck` → 构建部署 → Playwright 验收
7. **报告**：`docs/test_report/feedback-learning-module/` + HTML 产物

---

## 9. 验证口径（Goal-Driven）

本方案的成功标准 = PRD §6 的退出条件，逐条可验证：

| 退出项 | 验证命令/动作 |
|---|---|
| 32 条 TC 全通过 | `node scripts/e2e/flm-acceptance.cjs`，结果 JSON `passed === total` |
| 单测全绿 | `make test` |
| 类型通过 | `make typecheck` |
| 报告产出 | `output/flm-acceptance/FLM-测试报告.html` 存在且内嵌截图 |
| 合并推送 | `git log main --oneline` 含本次提交；两远端 `git ls-remote` 一致 |
