# 2026-09-13 · K8s 部署 must_change_password 始终为 true (PG bigint 类型问题)

## 1. 用户现象
K8s 集群部署 DeepThink 后，通过 `/api/auth/setup` 创建管理员账号，但登录后调用任何 API 均返回 `{"error": "Password change required", "code": "PASSWORD_CHANGE_REQUIRED"}`。查看 user 对象，`must_change_password` 始终为 `true`，即使数据库中该列值为 `0`。

## 2. 问题描述
`users.must_change_password` 在 PostgreSQL 中的列类型为 `BIGINT`（int8）。node-postgres 驱动将 `BIGINT` 列值作为**字符串**返回（因为 JavaScript Number 无法安全存储 >2^53 的整数）。

代码 `src/db.ts` 中两处映射：
```typescript
must_change_password: !!row.must_change_password,  // line 7257, 7757
```
当 PG 驱动返回字符串 `"0"` 时，`!!"0"` 在 JavaScript 中求值为 `true`（非空字符串），导致误判。

## 3. 根因

**代码层面**: `db.ts:7257` 和 `db.ts:7757` 使用 `!!row.must_change_password` 双非运算符转换布尔值，但未考虑 PG 驱动对 `BIGINT` 类型的字符串序列化行为。`!!"0" === true`。

**基础设施层面**: PostgreSQL 中 `must_change_password` 列定义为 `BIGINT` 类型，应使用 `INTEGER` 类型（值域 0/1，完全在 INTEGER 范围内）。

**依据**: `src/pg-sync-driver.ts:84-85` 注释明确说明: "pg returns BIGINT columns as strings (JS Number can't hold >2^53)"

## 4. 复现路径
1. 部署 DeepThink 到 K8s 集群，使用 PostgreSQL 作为数据库
2. 调用 `POST /api/auth/setup` 创建管理员用户
3. `SELECT must_change_password FROM users WHERE username='admin'` — DB 中为 0
4. 登录后查看 user 对象 — `must_change_password: true`
5. 调用任何需要鉴权的 API — 返回 `PASSWORD_CHANGE_REQUIRED`

## 5. 诊断方法
```bash
# 1. 检查 PG 列类型
kubectl exec -n deepthink postgres-0 -- psql -U deepthink -d deepthink -c \
  "SELECT column_name, data_type FROM information_schema.columns 
   WHERE table_name='users' AND column_name='must_change_password';"

# 2. 如果 data_type = 'bigint'，则需要修复
# 3. 验证原始值
kubectl exec -n deepthink postgres-0 -- psql -U deepthink -d deepthink -c \
  "SELECT must_change_password, pg_typeof(must_change_password) FROM users WHERE username='admin';"

# 4. 验证 JS 行为
node -e "console.log(!!'0')"  # 输出 true（这就是 bug）
node -e "console.log(!!(Number('0')))"  # 输出 false（修复后）
```

## 6. 修复方案

**方案 A（代码修复 — 根本修复）**: 在 `src/db.ts` 两处映射点使用 `Number()` 转换:

```diff
- must_change_password: !!row.must_change_password,
+ must_change_password: !!(Number(row.must_change_password)),
```
文件位置: `src/db.ts:7257` 和 `src/db.ts:7757`

**方案 B（数据库修复 — 辅助）**: 将 PG 中列类型从 BIGINT 改为 INTEGER:

```sql
ALTER TABLE users ALTER COLUMN must_change_password TYPE integer USING must_change_password::integer;
```

**选型理由**: 方案 A 是防御性修复（即使未来某列用 BIGINT 也不会误判），方案 B 是治本（小整数值不需要 BIGINT）。两方案均应用以确保双重保险。

### K8s 部署中的临时修复
在等待镜像重建期间，使用 postStart 生命周期钩子:
```yaml
lifecycle:
  postStart:
    exec:
      command:
        - sh
        - -c
        - sed -i 's/must_change_password: !!row.must_change_password/must_change_password: !!(Number(row.must_change_password))/g' /app/dist/db.js
```

## 7. 处理卡住的状态
如果已部署集群中 admin 用户被 locked out:
```bash
# 方案1: 直接改 PG 列类型 + 重启 Pod
kubectl exec -n deepthink postgres-0 -- psql -U deepthink -d deepthink -c \
  "ALTER TABLE users ALTER COLUMN must_change_password TYPE integer USING must_change_password::integer;"
kubectl -n deepthink rollout restart deployment/deepthink

# 方案2: 手动修复 DB 值
kubectl exec -n deepthink postgres-0 -- psql -U deepthink -d deepthink -c \
  "UPDATE users SET must_change_password = 0 WHERE username = 'admin';"
# 注意：仅方案2不够，需要同时应用方案B
```

## 8. 经验沉淀 / 预防
1. **PG 类型规范**: `BOOLEAN` 类标志位用 `INTEGER` 而非 `BIGINT`；`BIGINT` 仅用于可能超 2^53 的 ID/计数器
2. **防御性转换**: 所有从 PG 读取的数值字段在映射前做 `Number()` 转换
3. **类型审计脚本**:
```sql
SELECT column_name, data_type 
FROM information_schema.columns 
WHERE table_schema='public' 
  AND data_type IN ('bigint') 
  AND column_name NOT LIKE '%id%'
  AND column_name NOT LIKE '%_at';
```
4. **测试覆盖**: PG 模式集成测试应覆盖 `!!0 === false` / `!!"0" === true` 差异