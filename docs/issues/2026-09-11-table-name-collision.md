# 表名冲突：staff_teams/staff_team_members 与 main 分支已存在表同名

**日期**: 2026-09-11
**分支**: feat-staff-collab-workbench
**状态**: 已修复

## 1. 用户现象

在 DeepThink Web 控制台创建数字员工后，点击「协作团队」页面创建团队时，页面报错「Internal Server Error」。数字员工创建成功，但团队相关操作（创建团队、添加成员、创建任务、黑板）全部 500。

## 2. 问题描述

worktree 的 `db.ts` 中新增了 6 张 `staff_*` 表，其中 `staff_teams` 和 `staff_team_members` 与 main 分支已存在的同名表冲突。`CREATE TABLE IF NOT EXISTS` 是 no-op（表已存在），导致 worktree 的表结构（含 `status` 列）从未被应用。INSERT 时引用 `status` 列 → `SqliteError: table staff_teams has no column named status`。

## 3. 根因

main 分支 `src/db.ts:2572` 已有 `staff_teams` 表（有 `group_folder` 列，无 `status` 列）和 `staff_team_members` 表（有 `staff_id` 列，无 `employee_id` 列）。worktree 分支从更早的 commit 分叉，未包含这些表定义。但运行时共享同一个 SQLite 数据库文件（`/home/me/.deepthink-9999/db/messages.db`），该 DB 已被 main 分支服务器初始化过，表已存在且 schema 不同。

`CREATE TABLE IF NOT EXISTS` 对已存在的表是 no-op — 不会修改已有表结构也不会报错。因此 worktree 的 schema（含 `status`/`employee_id` 等新列）静默跳过。

## 4. 复现路径

1. main 分支服务器启动 → 创建 `staff_teams`（无 `status` 列）+ `staff_team_members`（无 `employee_id` 列）
2. worktree 分支服务器启动 → `CREATE TABLE IF NOT EXISTS staff_teams` → no-op（表已存在）
3. `POST /api/staff/teams` → `INSERT INTO staff_teams (..., status, ...)` → `SqliteError: no column named status`

## 5. 诊断方法

```bash
# 检查 DB 中表的实际列
node -e "const db=require('better-sqlite3')('/home/me/.deepthink-9999/db/messages.db',{readonly:true}); console.log(db.prepare('PRAGMA table_info(staff_teams)').all().map(c=>c.name))"
# 若输出不含 status 列 → 确认冲突

# 检查 main 分支是否已有同名表
grep 'CREATE TABLE IF NOT EXISTS staff_' ~/deepthink/src/db.ts
```

## 6. 修复方案

**重命名全部 6 张表为 `sw_` 前缀**，避免与 main 分支 `staff_*` 表冲突：

| 原表名 | 新表名 |
|--------|--------|
| `staff_employees` | `sw_employees` |
| `staff_teams` | `sw_teams` |
| `staff_team_members` | `sw_members` |
| `staff_team_tasks` | `sw_tasks` |
| `staff_team_blackboard` | `sw_blackboard` |
| `staff_team_events` | `sw_events` |

```diff
-    CREATE TABLE IF NOT EXISTS staff_employees (
+    CREATE TABLE IF NOT EXISTS sw_employees (
...
-    CREATE TABLE IF NOT EXISTS staff_teams (
+    CREATE TABLE IF NOT EXISTS sw_teams (
```

**选型理由**: 重命名而非 `ensureColumn` 补列 — main 的 `staff_teams` 有 `group_folder` 列（worktree 不需要），worktree 的 `sw_teams` 有 `status` 列（main 不需要），两者语义不同（main 的 staff_teams 绑定 group_folder 用于 IM 群组，worktree 的 sw_teams 是任务协作团队），合并列会污染 main 的表。Surgical Changes 原则：不触碰 main 已有表。

SCHEMA_VERSION 62→63。

同时发现第二个 bug：启动命令使用 `DATA_DIR=...` 环境变量，但 DeepThink 配置读取的是 `DEEPTHINK_DATA_DIR`。修复为 `DEEPTHINK_DATA_DIR=/home/me/.deepthink-9999`。

## 7. 处理卡住的状态

无卡住状态。修复后直接重启服务器，新表 `sw_*` 由 `CREATE TABLE IF NOT EXISTS` 首次创建。

## 8. 经验沉淀 / 预防

- **命名空间隔离**: 新增表时先 `grep 'CREATE TABLE IF NOT EXISTS <name>' ~/deepthink/src/db.ts` 检查 main 是否已有同名表。使用前缀（如 `sw_`）隔离命名空间。
- **CREATE TABLE IF NOT EXISTS 陷阱**: 对已存在表是 no-op，不会报错也不会修改结构。schema 不匹配时静默跳过，问题在 INSERT 时才暴露。
- **环境变量名**: DeepThink 使用 `DEEPTHINK_DATA_DIR`（非 `DATA_DIR`）指定数据目录。启动命令必须用正确名称。
- **看门狗干扰**: `scripts/deepthink-watchdog.sh` 会自动重启 prod 服务器抢占 9999 端口。测试前需 `touch logs/deepthink-9999.stop` + kill 看门狗进程。
