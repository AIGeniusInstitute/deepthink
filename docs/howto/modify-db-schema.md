# Howto: 修改数据库 Schema

> 从 CLAUDE.md §11 拆分而来。

## 步骤

1. 在 `src/db.ts` 中增加 migration 语句
2. 更新 `SCHEMA_VERSION` 常量
3. 同时更新 `CREATE TABLE` 语句和 migration ALTER/CREATE 语句
