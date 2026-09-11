# Issue: includeInactive 查询参数不兼容 `true` 值

## 1. 用户现象
前端调用 `GET /api/staff/employees?includeInactive=true` 时，返回的员工列表不包含已删除（inactive）的员工，仍只返回 active 员工。

## 2. 问题描述
`staff-employees.ts` 第 27 行 `includeInactive` 参数仅匹配 `'1'`，不兼容 `'true'`（REST API 惯例）。前端 / curl 使用 `includeInactive=true` 时，参数被解析为 `false`，导致 SQL 查询始终附加 `AND status = 'active'` 条件。

## 3. 根因
```typescript
// 修复前 — 只接受 '1'，不接受 'true'
const includeInactive = c.req.query('includeInactive') === '1';
```
- 代码层：硬编码字符串比较 `'1'`，未遵循 REST API `true/false` 布尔惯例
- 外部依据：Hono `c.req.query()` 返回 `string | undefined`，需手动解析多值布尔

## 4. 复现路径
1. `POST /api/staff/employees` 创建员工 → 获得 `EID`
2. `DELETE /api/staff/employees/{EID}` 软删除（status → inactive）
3. `GET /api/staff/employees?includeInactive=true` → 列表不含该员工 ❌
4. `GET /api/staff/employees?includeInactive=1` → 列表含该员工 ✅

## 5. 诊断方法
```bash
curl -b cookies.txt "http://127.0.0.1:9999/api/staff/employees?includeInactive=true" | python3 -c "import sys,json; print(len(json.load(sys.stdin)['employees']))"
# 修复前：返回 active 数量（不含 inactive）
# 修复后：返回 active + inactive 数量
```

## 6. 修复方案
```diff
- const includeInactive = c.req.query('includeInactive') === '1';
+ const q = c.req.query('includeInactive');
+ const includeInactive = q === '1' || q === 'true';
```
**选型理由**：同时兼容 `'1'`（数字布尔）和 `'true'`（REST 惯例），不引入第三方解析库（Simplicity First）。

## 7. 处理卡住的状态
不适用（无运行态卡死）。

## 8. 经验沉淀 / 预防
- 布尔查询参数应同时接受 `'1'`/`'true'`/`'yes'` 等常见值
- E2E 测试必须覆盖 `includeInactive=true`（非 `=1`）路径
- 巡检：`grep -rn "=== '1'" src/routes/` 检查其他路由是否有同类硬编码
