# Agent 群组发送消息报 500 —— PG 专有语法中断 SQLite 迁移批处理

## 1. 用户现象

进入任意 Agent 群组（Swarm）页面，输入消息并发送，直接报错，消息发不出去：

```
POST /api/agent-groups/web:swarm:546f318b-6458-4311-a27d-64b79f384ab1/messages
{"text":"世界的本质"}
→ HTTP 500 Internal Server Error
```

刷新页面同样如此 —— 群组的**席位（seats）管理是好的**，唯独**消息收发**功能整体不可用。

## 2. 问题描述

服务端抛 `SqliteError: no such table: group_messages`：

```
SqliteError: no such table: group_messages
    at Database.prepare (.../better-sqlite3/lib/methods/wrappers.js:5:21)
    at createGroupMessage (file:///Users/edy/deepthink/dist/db.js:8218:23)
    at file:///Users/edy/deepthink/dist/routes/agent-groups.js:367:17
```

Agent 群聊功能的两张核心表 —— `group_seats`（席位）与 `group_messages`（消息）—— 属于**同一个 v67 迁移块**。实际落地结果却是「第一张表建好了，第二张表根本不存在」，这是一个典型的**批量 DDL 语句被中途打断**的特征。

## 3. 根因

### 代码层面

`src/db.ts` 的 v67 迁移块把多条 DDL 语句塞进一次 `db.exec()`：

```js
db.exec(`
  CREATE TABLE IF NOT EXISTS group_seats ( ... );          -- ① 成功
  ALTER TABLE group_seats ADD COLUMN IF NOT EXISTS updated_at TEXT;  -- ② 语法错误
  CREATE INDEX IF NOT EXISTS idx_group_seats_gid ...;      -- ③ 未执行
  CREATE TABLE IF NOT EXISTS group_messages ( ... );       -- ④ 未执行 ← 祸根
  CREATE INDEX IF NOT EXISTS idx_group_msgs_gid ...;       -- ⑤ 未执行
`);
```

第 ② 句 `ALTER TABLE ... ADD COLUMN IF NOT EXISTS` 是 **PostgreSQL 专有语法**。SQLite 的 `ALTER TABLE ADD COLUMN` **不支持 `IF NOT EXISTS`**（截至 SQLite 3.5x 仍未支持，见文末依据）。

而 `db.exec()` 遇到第一条错误语句就会**立刻中止，不再执行后续语句**。于是：

- ① `group_seats` 建表成功 → 席位功能正常
- ② 抛 `near "EXISTS": syntax error` → 批处理中断
- ④ `CREATE TABLE group_messages` **被静默跳过** → 表从未创建

外层 `try/catch` 把错误降级成一条 WARN（`group_seats / group_messages migration v67 failed (non-blocking)`），启动流程照常继续，**故障被推迟到用户第一次发消息时才以 500 的形式暴露**。

### 三重放大因素

1. **错误被 catch 吞掉**：DDL 失败只留一行 WARN，服务「看起来启动成功」。
2. **schema_version 仍然推进**：版本号写入在第 2752 行、位于 `try` 块**之外**，失败照样写成 `70`，制造「迁移已完成」的假象。
3. **表结构不对称**：同批次的 `group_seats` 建好了、`group_messages` 没有，单看数据库很难意识到是「半截迁移」。

### 外部依据

- SQLite 官方语法图 `ALTER TABLE`：`ADD COLUMN` 无 `IF NOT EXISTS` 子句 — https://sqlite.org/lang_altertable.html
- SQLite 不支持 `ADD COLUMN IF NOT EXISTS` 的历史讨论 — https://sqlite.org/forum/forumpost/9e08baa1e6
- PostgreSQL `ALTER TABLE`：`ADD COLUMN [ IF NOT EXISTS ]` 为 PG 专有 — https://www.postgresql.org/docs/current/sql-altertable.html
- better-sqlite3 `Database#exec()`：遇到错误即中止 — https://github.com/WiseLibs/better-sqlite3/blob/master/docs/api.md#execstring---this

## 4. 复现路径

```bash
# 1. 确认库中「半截迁移」状态：group_seats 在、group_messages 不在
DB=~/.deepthink-9999/db/messages.db
sqlite3 "$DB" "SELECT name FROM sqlite_master WHERE type='table' AND name LIKE 'group%';"
# 实际输出：
#   group_members
#   group_seats        ← ① 建成功了
#   （没有 group_messages）

# 2. 版本号却已推进到 70，看起来「迁移完成」
sqlite3 "$DB" "SELECT value FROM router_state WHERE key='schema_version';"
#   70

# 3. 启动日志里其实早有 WARN
grep -n "migration v67 failed" logs/deepthink-9999.log

# 4. 发消息即 500
curl -i -X POST 'http://127.0.0.1:9999/api/agent-groups/web:swarm:<uuid>/messages' \
  -H 'Content-Type: application/json' \
  -b 'deepthink_session=<token>' \
  --data-raw '{"text":"世界的本质"}'
# → HTTP/1.1 500 Internal Server Error
```

## 5. 诊断方法

```bash
# ① 定位 500 的真实异常（不要只看 HTTP 码）
tail -50 logs/deepthink-9999.log | grep -A2 "SqliteError"

# ② 确认表缺失而非数据问题
DB=~/.deepthink-9999/db/messages.db
sqlite3 "$DB" "SELECT name FROM sqlite_master WHERE type='table' AND name LIKE 'group%';"

# ③ 回看启动期是否已有 DDL 失败告警（本例的关键线索）
grep -n "migration v67 failed" logs/deepthink-9999.log

# ④ 确认是语法错误而非权限/锁问题
sqlite3 :memory: "CREATE TABLE t(a TEXT); ALTER TABLE t ADD COLUMN IF NOT EXISTS b TEXT;"
# Error: near "EXISTS": syntax error     ← 一句话定性

# ⑤ 确认同批次的表只建了一半
sqlite3 "$DB" "PRAGMA table_info(group_seats);"
```

## 6. 修复方案

去掉 PG 专有语法，改用**本仓库既有的、方言可移植的 `ensureColumn()`**（内部走 `PRAGMA table_info` 探测，已在本文件被调用 30+ 次；`sql-translator.ts` 会把 `PRAGMA table_info` 翻译成 PG 的 `information_schema` 查询，因此 SQLite / PG 双后端通吃）。

```diff
--- a/src/db.ts
+++ b/src/db.ts
@@ -2716,7 +2716,6 @@
         updated_at TEXT,
         UNIQUE(group_id, agent_definition_id)
       );
-      ALTER TABLE group_seats ADD COLUMN IF NOT EXISTS updated_at TEXT;
       CREATE INDEX IF NOT EXISTS idx_group_seats_gid ON group_seats(group_id);
       CREATE INDEX IF NOT EXISTS idx_group_seats_agent ON group_seats(agent_definition_id);

@@ -2740,6 +2739,13 @@
       CREATE INDEX IF NOT EXISTS idx_group_msgs_time ON group_messages(group_id, created_at);
     `);
+    // 老库补齐 updated_at（group_seats 首建于本迁移块，正常库已含该列）。
+    // 注意：必须用 ensureColumn（PRAGMA table_info 探测），不能写成
+    // `ALTER TABLE ... ADD COLUMN IF NOT EXISTS` —— 后者是 PG 专有语法，
+    // SQLite 会报 `near "EXISTS": syntax error` 并中断整个 db.exec() 批处理，
+    // 导致同批次靠后的 CREATE TABLE group_messages 被静默跳过。
+    ensureColumn('group_seats', 'updated_at', 'TEXT');
   } catch (err) {
     logger.warn({ err }, 'group_seats / group_messages migration v67 failed (non-blocking)');
   }
```

### 选型理由

| 方案 | 取舍 |
|------|------|
| **删掉该 `ALTER` 语句**（最小） | `group_seats` 的 `CREATE TABLE` 里本就含 `updated_at TEXT`，且该表**只在此处创建**，故这条 `ALTER` 实际是冗余的。但删掉后会丢失原作者「为老库补列」的防御意图。 |
| **改写为 `ensureColumn()`**（采用） | 保留防御意图，与本文件 30+ 处同类调用风格一致；`PRAGMA table_info` 已被 `sql-translator.ts` 覆盖为 PG 版本，双后端安全；执行两次幂等。 |
| 把 `IF NOT EXISTS` 从字符串里删掉，直接写 `ALTER TABLE ... ADD COLUMN` | 在 SQLite 上首次执行可行，但**第二次启动会因「列已存在」报错**，重新踩进同一个「中断批处理」的坑。 |

同时，把该语句**移出多语句 `db.exec()` 之外**，使单条语句失败不再具备「连坐」后续建表语句的能力。

### 自愈性

v67 块**不受 `schema_version` 门控**（无条件执行 `CREATE TABLE IF NOT EXISTS`），因此**已损坏的库无需手工修**：重启服务即自动补建缺失的 `group_messages`。

## 7. 处理卡住的状态

本次故障**不需要手工改库**——重启即自愈。若确需手工应急（例如不方便立即重启），可执行：

```bash
DB=~/.deepthink-9999/db/messages.db
sqlite3 "$DB" <<'SQL'
CREATE TABLE IF NOT EXISTS group_messages (
  id INTEGER PRIMARY KEY AUTOINCREMENT, group_id TEXT NOT NULL, run_id TEXT,
  node_run_id TEXT, sender_type TEXT NOT NULL DEFAULT 'user', sender_seat_id INTEGER,
  msg_type TEXT NOT NULL DEFAULT 'text', content_ref TEXT, mentions TEXT NOT NULL DEFAULT '[]',
  parent_msg_id INTEGER, status TEXT NOT NULL DEFAULT 'completed',
  token_in INTEGER NOT NULL DEFAULT 0, token_out INTEGER NOT NULL DEFAULT 0,
  duration_ms INTEGER NOT NULL DEFAULT 0, created_at TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_group_msgs_gid ON group_messages(group_id);
CREATE INDEX IF NOT EXISTS idx_group_msgs_time ON group_messages(group_id, created_at);
SQL
```

> 注意：直接改库前先停服务或确认 WAL 已 checkpoint，避免与运行中的进程竞争。

## 8. 经验沉淀 / 预防

### 本次真正的教训：迁移块「部分成功」比「完全失败」更危险

`group_seats` 建成功掩盖了 `group_messages` 的缺失，加上版本号照常推进，故障被伪装成「功能性问题」而不是「迁移问题」。三条可操作的预防：

1. **DDL 批处理禁止混入方言专有语法。**
   `IF NOT EXISTS` 在 `CREATE TABLE` / `CREATE INDEX` 上 SQLite 支持，但在 `ALTER TABLE ADD COLUMN` 上**只有 PG 支持**——同一个关键词的可用性随语句类型而变，极易误判。补列一律走 `ensureColumn()`。

2. **迁移块的异常不应被静默降级。**
   当前 `try/catch` + `logger.warn('non-blocking')` 让 DDL 失败悄无声息。建议对**建表**类迁移失败在启动后做一次表存在性自检并告警，而不是等用户请求时 500。

3. **`schema_version` 应在迁移块全部成功后写入。**
   本例中版本号写在 `try` 之外（`db.ts:2752`），迁移失败仍标记为已迁移，排查时产生误导。**本次为保持改动最小未调整该顺序**，留作后续独立改进项。

### 巡检建议

```bash
# 迁移健康巡检：版本号声称 70，但核心表缺失 → 立刻告警
DB=~/.deepthink-9999/db/messages.db
V=$(sqlite3 "$DB" "SELECT value FROM router_state WHERE key='schema_version';")
for t in group_seats group_messages; do
  sqlite3 "$DB" "SELECT name FROM sqlite_master WHERE type='table' AND name='$t';" | grep -q "$t" \
    || echo "❌ schema_version=$V 但缺表 $t —— 迁移块被中途打断"
done
```

### 回归验证（本次已执行）

新增临时脚本 `verify-v67-fix.mjs`（验证后删除，未入库）从 `src/db.ts` 直接抽取真实 SQL 做四组断言，**14/14 通过**：

| 组 | 断言 |
|----|------|
| [1] 复现 | 旧 SQL 抛 `near "EXISTS": syntax error`；`group_seats` 已建、`group_messages` 缺失 |
| [2] 修复 | 新 SQL 无错误；两张表均创建成功 |
| [3] 恢复 | 对「半截库」重跑迁移无错误，`group_messages` 补建，写入/读回内容正确 |
| [4] 幂等 | 新 SQL 连续执行两次无错误，表不重复 |

### 既有测试基线说明

`npx vitest run` 全量结果 **1695 通过 / 2 失败**。2 个失败为**改动前即存在**的过期断言（`tests/units/workflows.test.ts`、`tests/units/super-agent-team-trace.test.ts` 断言 `schema_version === '61'`，实际已是 `70`），与本 issue 无关，已通过 `git stash` 对照基线确认。
