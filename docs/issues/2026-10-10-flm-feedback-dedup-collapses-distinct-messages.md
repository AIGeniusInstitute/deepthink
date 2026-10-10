# FLM 事件去重把「不同消息的同类反馈」并成一条

- 日期：2026-10-10
- 模块：反馈与学习自进化（FLM）· F2 归一化
- 严重级别：高（静默丢数据，无任何报错）
- 发现方式：FLM UI 验收脚本数据准备阶段（`scripts/e2e/flm-acceptance.cjs`）

---

## 1. 用户现象

在飞书群里对 4 条**不同**的助手回答各点一次赞。

- 「反馈」列表里 4 条记录都在，看起来一切正常；
- FLM 控制台的「归一化事件流」里**只有 1 条**事件；
- 满意度、纠偏成功率、案例库、偏好对等所有下游指标全部按 1 条算。

换一句话说：**运营看到的满意度是「4 条反馈里 1 条算数」的结果，而不是 4 条反馈的结果**，而且界面上没有任何提示说「有 3 条被丢了」。

## 2. 问题描述

`flm_feedback` 表写入了 4 行，`flm_events` 只写入 1 行。`POST /api/flm/feedback` 对后 3 次请求返回 `ok: true` —— 只是 `eventInserted: false`。

前端把 `eventInserted` 当作内部字段，不展示；运营无从感知事件没进流水线。

## 3. 根因

`src/flm/flm-normalize.ts` 的 `computeDedupKey()` 参与哈希的字段是：

```
source | type | chatJid | sessionId | stepId | 时间桶
```

**没有「行为主体」**。而平台里的用户反馈，主体是"这条反馈针对哪条消息/哪个任务" —— 也就是 `task_id`。

本次复现的 4 条消息 `turn_id` 与 `session_id` 均为 NULL（飞书单聊消息没有回合绑定）：

```sql
-- ~/.deepthink-9999/db/messages.db
SELECT id, turn_id, session_id FROM messages WHERE id IN (...4 条...);
-- 全部为 || 即 NULL
```

于是 6 个字段里 5 个完全相同，只剩时间桶不同；4 次点赞都在同一分钟，时间桶也相同 → 4 次请求算出**同一个 dedup_key** → 后 3 条被 `INSERT OR IGNORE` 拦掉。

原实现的注释把这件事解释为"两次真实但雷同的行为在同一分钟内收敛为一条"，但**点赞两条不同回答不是雷同行为**。PRD AC-F2.5 的口径是：

> 去重：同来源同时刻重复事件按时间窗去重，**一次行为不重复计分**

「一次行为」的单位是**一个反馈主体**，不是"一个会话一分钟"。原实现把去重粒度放大到了会话级，属于对 AC-F2.5 的过度实现。

## 4. 复现路径

1. 登录 `http://127.0.0.1:9999`（admin / 88888888）。
2. 在任意群里对**两条不同**的助手回答各点一次赞（间隔小于 60 秒）。
3. 打开「反馈与学习」→「反馈流」标签页。

预期：事件流出现 2 条 `explicit_like`。
实际：只出现 1 条；`flm_feedback` 里是 2 行。

## 5. 诊断方法

```bash
# 取会话 cookie
C=$(curl -s -i -X POST http://127.0.0.1:9999/api/auth/login \
      -H 'Content-Type: application/json' \
      -d '{"username":"admin","password":"88888888"}' \
    | grep -i '^set-cookie' | sed 's/^[Ss]et-[Cc]ookie: //' | cut -d';' -f1 | tr -d '\r')

# 对两条不同消息提交同类反馈，观察 eventInserted
for M in om_x100b63ac3742aca0dda71627afdcb3b om_x100b64c97f7c9134c431d37f570c8d4; do
  curl -s -X POST http://127.0.0.1:9999/api/flm/feedback -H "Cookie: $C" \
    -H 'Content-Type: application/json' \
    -d "{\"messageId\":\"$M\",\"chatJid\":\"feishu:oc_d002a8c3c0bcf831e0af3a03928d5391\",\"type\":\"explicit_like\"}"
  echo
done

# 对照：反馈行数 vs 事件行数（前者大于后者即为本缺陷）
sqlite3 ~/.deepthink-9999/db/messages.db \
  "SELECT (SELECT count(*) FROM flm_feedback) AS feedback,
          (SELECT count(*) FROM flm_events)   AS events;"
```

实测输出：第一条 `"eventInserted":true`，第二条 `"eventInserted":false`。

## 6. 修复方案

把**行为主体**纳入去重键。

```diff
 export function computeDedupKey(
   draft: Pick<FeedbackDraft, 'source' | 'type' | 'stepId' | 'occurredAt'>,
-  ctx: { chatJid: string | null; sessionId: string | null; windowSec: number },
+  ctx: { chatJid: string | null; sessionId: string | null; taskId?: string | null; windowSec: number },
 ): string {
   const bucket = Math.floor(draft.occurredAt / (Math.max(1, ctx.windowSec) * 1000));
   const raw = [
     draft.source,
     draft.type,
+    // 行为主体：只有针对**同一个任务**的同类反馈才算「同一次行为」。少了这一段，
+    // 同一分钟里对不同消息的同类反馈会被并成一条 —— 点赞两条回答是两次行为。
+    ctx.taskId ?? '',
     ctx.chatJid ?? '',
     ctx.sessionId ?? '',
     draft.stepId ?? '',
     String(bucket),
   ].join('|');
```

调用点补传 `taskId`：

```diff
   dedupKey: computeDedupKey(draft, {
     chatJid: keys.chatJid,
     sessionId: keys.sessionId,
+    taskId: keys.taskId,
     windowSec: config.dedupWindowSec,
   }),
```

**选型理由**

- `taskId` 已经在 `ingest()` 里解析完成（`normalizeDraft(draft, keys, config)` 拿到 `keys.taskId`），修复是纯数据流补充，不引入新依赖、不改表结构。
- 幂等性没有被削弱：同一条消息重复提交 → `taskId` 相同 → 仍然同键、仍然被拦（原有单测 `同一条反馈重复提交被去重` 继续通过）。
- 系统侧事件（工具调用/错误/token）本来就带 `taskId`，同一任务同一分钟同类事件仍会收敛，行为不变。
- `ctx.taskId` 设为可选，是为了不破坏既有单测调用签名；生产路径 `normalizeDraft` 恒传，保证修复真正生效。

## 7. 处理卡住的状态（如适用）

不适用 —— 本缺陷不产生 stuck 运行态，只是静默少写数据。修复后**新提交**的反馈按新键入库；历史被吞掉的事件无法自动补回（原请求的 `dedup_key` 已落库且 `taskId` 未记录在该键里），需要重新提交反馈或按 `flm_feedback` 重放，本次不做数据回填。

## 8. 经验沉淀 / 预防

- **去重粒度必须落到"业务主体"上。** 判断口径：问一句"这两条记录合并成一条，业务上会不会少算一次行为？" —— 会，就不能合。
- **静默丢弃要有出口。** `eventInserted: false` 现在只存在于响应体里。控制台应在事件流上显示「本窗口去重 X 条」，否则丢数据永远靠人去对表才能发现。已记入测试报告遗留项。
- **验收脚本必须准备"多条不同主体"的数据。** 只准备一条数据的验收脚本永远发现不了这类缺陷 —— 本次正是因为要造 8 条反馈才暴露。
- 巡检建议（后续）：`flm_feedback` 行数与 `flm_events` 行数在同一窗口内长期大幅背离即告警。
