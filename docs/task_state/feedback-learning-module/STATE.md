# FLM 反馈与学习自进化模块 — 执行状态

- 需求：`docs/prd/feedback-learning-module/PRD.md`
- 技术方案：`docs/tech_solution/feedback-learning-module/TECH-SOLUTION.md`
- 分支：`feature/feedback-learning-module`
- 更新日期：2026-10-10

## 一、实测约束（先测后写，决定了全部实现形态）

在动笔之前对本机实例（`$HOME/.deepthink-9999`）做了数据探查，以下四条直接改变了设计：

| 实测结论 | 影响 |
|---|---|
| `chat_trace_nodes.session_id` 9092 行**全为 NULL** | 节点无法按 session 对齐，只能 `chat_jid + 时间窗` |
| `messages.task_id` 330 行**全为空** | 任务单元不能依赖既有 task_id，须自建推导规则 |
| `trace_tool_calls.chat_jid` 全填充 | 工具调用可稳定按聊天 + 时间窗捞取 |
| 所有时间列统一 ISO-8601 UTC 文本 | 可直接字符串比较做范围查询，SQLite/PG 行为一致 |

数据探查命令见 `docs/issues/` 中相关记录；探查脚本为一次性 `sqlite3` 查询，未留在仓库。

## 二、任务单元定义

四级前缀，保证 `taskId` **永不为空**：

```
turn:{turn_id}   >  sess:{session_id}  >  msg:{message_id}  >  chat:{jid}:{hourBucket}
```

`turn:` 的窗口起点取本回合**最早**的消息（用户提问），不是助手回复 —— 轨迹节点发生在
「提问 → 回复」之间，用回复时间当起点会把整段轨迹排除在外。右边界取同聊天下一条消息
时间，上限 10 分钟兜底。

## 三、实施进度

### 后端（已完成）

| 文件 | 内容 | 状态 |
|---|---|---|
| `src/db.ts` | `SCHEMA_VERSION` 70→71；12 张 `flm_*` 表 DDL；`ensureColumn` 兼容 SQLite/PG | ✅ |
| `src/flm/flm-types.ts` | 枚举与领域类型 | ✅ |
| `src/flm/flm-config.ts` | 配置读写 + `isEnabled()` 降级判定 | ✅ |
| `src/flm/flm-db.ts` | 12 张表的 CRUD（`getDb()` 内联 SQL，与既有范式一致） | ✅ |
| `src/flm/flm-normalize.ts` | 归一化、脱敏、`taskId` 推导、冲突消解 | ✅ |
| `src/flm/flm-collect.ts` | F1 采集：范围解析 / 实体对齐 / 系统派生 / 快照 diff / 上下文装配 | ✅ |
| `src/flm/flm-evaluate.ts` | F3 三层评价引擎（纯函数、无 IO） | ✅ |
| `src/flm/flm-learn.ts` | F4 学习：纠偏、案例检索、策略建议、数据回流、知识候选 | ✅ |
| `src/flm/flm-closedloop.ts` | F5 闭环：门禁 / 灰度 / 回滚 / 审计 | ✅ |
| `src/flm/flm-insights.ts` | F6 看板聚合与告警 | ✅ |
| `src/routes/flm.ts` | API 路由（登录层 + admin 层） | ✅ |
| `src/web.ts` | 挂载 `/api/flm` | ✅ |

### SQL 双兼容约束（踩过的坑，写进约束避免回归）

- **不用** `ADD COLUMN IF NOT EXISTS` —— PG 专有语法，会打断 SQLite 批处理 → 改用 `ensureColumn()`（基于 `PRAGMA table_info`）
- **不用** `ON CONFLICT ... DO UPDATE` —— `sql-translator.ts` 覆盖不全 → 改用 `INSERT OR REPLACE`
- 不用 `jsonb` / `now()`；JSON 统一存 TEXT；时间统一 `Date.now()` 毫秒整数

### 前端（已完成）

| 文件 | 内容 | 状态 |
|---|---|---|
| `web/src/api/flm.ts` | API client，含 `isDegraded()` 类型守卫 | ✅ |
| `web/src/components/chat/MessageFeedback.tsx` | 消息级 👍/👎 + 原因枚举弹窗 + 状态回显 | ✅ |
| `web/src/components/chat/MessageBubble.tsx` | 全模式 / 紧凑模式两处插入（分享视图隐藏） | ✅ |
| `web/src/pages/FeedbackLearningPage.tsx` | 7 标签页控制台 | ✅ |
| `web/src/App.tsx` | `/feedback-learning` 懒加载路由 | ✅ |
| `web/src/components/layout/nav-items.ts` | 导航项「自进化」 | ✅ |

### 测试（已完成）

| 文件 | 用例数 | 覆盖 |
|---|---|---|
| `tests/units/flm-normalize.test.ts` | 31 | F2 归一化与冲突消解 |
| `tests/units/flm-evaluate.test.ts` | 43 | F3 三层评价引擎（含千节点性能结构保证） |
| `tests/units/flm-learn.test.ts` | 50 | F4 学习（含 AC-F4.4 Top-5 命中率 ≥80% 实测断言、记忆化逐位一致回归） |
| `tests/units/flm-closedloop.test.ts` | 40 | F5 门禁 / 灰度 / 回滚 / 审计 |
| `tests/units/flm-collect.test.ts` | 55 | F0 降级 + F1 采集 + F2/F3 端到端 + F6 聚合 |
| `tests/units/flm-console-routes.test.ts` | 14 | 控制台聚合接口 |
| `tests/units/flm-routes.test.ts` | 13 | 登录层路由 |
| `tests/units/flm-strategy-routes.test.ts` | 7 | 策略路由 |
| **合计** | **253** | 8 个文件，全绿 |

已加入 `Makefile` 的 `test-smoke` CI 门禁清单（Makefile 明确要求「新增核心能力（trace /
validation / eval）须补进此集」）。

## 四、开发过程中发现并修复的实现缺陷

| # | 缺陷 | 根因 | 修复 |
|---|---|---|---|
| 1 | `turn:` 任务永远取不到轨迹节点 | 窗口起点用了助手回复时间，而轨迹发生在提问与回复之间 | 改为取本回合最早消息时间作起点，最后一条消息作右边界锚点 |
| 2 | `searchCases('')` 返回全部案例 | `embed('')` 得零向量，所有案例相似度均为 0 但仍被返回 | 空查询直接返回空集 |
| 3 | `isInCanary` 对 `released` 版本返回 `false` | 只接受 `canary` 状态，与实际路由行为相反 | `released` 视为比例 100，返回体新增 `status` 字段 |
| 4 | 单次纠偏成本估算使闸门恒关 | 按整任务耗时估，任何 ratio=2 的任务立刻超限 | 改用 `durationMs / stepCount` 估单步成本 |
| 5 | 自动化测试中 SHA 采样不可复现 | 曾用 `Math.random()` | 改 `sha1(taskId) % 100`，同 key 结果稳定 |

## 四之二、验收阶段发现并修复的产品缺陷（8 起，7 份 issue 文档）

这 8 起**全部在单测全绿、接口全部 200 的情况下存在**：单测覆盖后端纯函数产出，缺陷长在前端消费、上下游契约、事件循环、操作可重复性这四处。

| # | 缺陷 | 根因类别 | Issue 文档 |
|---|---|---|---|
| 1 | 反馈去重把不同消息并成一条 | 去重键选错 | `docs/issues/2026-10-10-flm-feedback-dedup-collapses-distinct-messages.md` |
| 2 | 评价从不落库 | `insertEvaluation` 零调用点 | `docs/issues/2026-10-10-flm-evaluations-never-persisted.md` |
| 3 | 工具调用失败信号全链路无人识别 | 生产者/消费者状态取值集合交集为空 | `docs/issues/2026-10-10-flm-toolcall-failure-signal-never-detected.md` |
| 4 | 「学习沉淀」页签 `undefined.toFixed()` 打白整个控制台 | 前端 interface 声明了后端不存在的字段 | `docs/issues/2026-10-10-flm-learning-tab-crash-blanks-console.md` |
| 5 | 案例检索渲染三个不存在的字段（相似度 NaN%） | 同上（检索接口与列表接口形状混用） | 同上 §2.1 |
| 6 | 案例库随每次沉淀膨胀，Top-K 返回重复候选 | 派生数据缺幂等键 + 检索未去重 | `docs/issues/2026-10-10-flm-case-library-duplicates-and-topk.md` |
| 7 | `/admin/data-feedback` 同步计算 ~3.8s **冻结事件循环**，拖垮同进程其它接口 | 请求路径上的同步 CPU 密集计算 | `docs/issues/2026-10-10-flm-data-feedback-blocks-event-loop.md` |
| 8 | 加载失败被渲染成「暂无数据」 | catch 只发 toast 不落 state + 空态文案是一次事实断言 | `docs/issues/2026-10-10-flm-load-failure-rendered-as-empty-state.md` |

缺陷 7 的修复（目标文本级记忆化）实测：data-feedback 3.83s → 0.041s，并发健康探测 3.46s → 0.16s，输出逐位不变。

**同时修复了验收脚本自身的 10 处判据失效**（"测试永远绿但什么都没验"），清单见测试报告 §4.2。

## 五、待办

- [x] 单元测试全量回归 —— **253 / 253 通过**（8 个文件）
- [x] 后端 / 前端类型检查 —— 均 `exit 0`
- [x] `make start-prod PORT=9999` 部署（构建 + 后台守护 + watchdog）
- [x] Playwright 验收脚本 `scripts/e2e/flm-acceptance.cjs`（TC-02 ~ TC-33，共 32 条）
- [x] UI 验收执行 —— **32 / 32 通过**，脚本 MD5 `92fc3a0942319db191b7ee16a06094f9` 跑前跑后一致
- [x] 带截图测试报告 `docs/test_report/feedback-learning-module/`（32 张截图）
- [x] 合并 `feature/feedback-learning-module` → `main` 并 push（`fedd342`，fast-forward，atomgit / github 均已更新）
