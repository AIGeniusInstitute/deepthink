# Disk 回收站清空接口 404 — Hono 路由优先级遮蔽

> 日期：2026-09-11 ｜ 修复分支：`fix/disk-trash-route` ｜ 严重度：P1（功能不可用）

## 1. 用户现象

在 AgentNet Disk 网盘页面点击「清空回收站」时，操作失败；回收站内容未被清空，前端提示失败。从用户视角看，回收站的「彻底删除单项」可以工作，但「清空全部」按钮始终无效。

## 2. 问题描述

后端 `DELETE /api/groups/:jid/files/trash`（清空回收站）接口始终返回 `404 File or directory not found`，而非执行清空逻辑。该字面路由被更早注册的参数路由 `DELETE /api/groups/:jid/files/:path` 遮蔽——Hono 按注册顺序匹配，将路径段 `trash` 当作 `:path` 参数捕获，进入「删除文件」处理器，因 base64 解码 `trash` 后找不到对应文件而返回 404。

## 3. 根因

**框架路由匹配顺序缺陷**。Hono 的路由匹配按注册顺序进行，字面段与参数段冲突时，先注册的胜出。

代码位置：`src/routes/files.ts`

```text
line 1369  fileRoutes.delete('/:jid/files/:path', ...)      // 参数路由，先注册 ← 遮蔽源
...
line 1630  fileRoutes.delete('/:jid/files/trash/:id', ...) // 彻底删除单项（两段，不受影响）
line 1655  fileRoutes.delete('/:jid/files/trash', ...)     // 清空回收站，后注册 ← 被遮蔽
```

`DELETE /:jid/files/trash`（单段字面 `trash`）被 `DELETE /:jid/files/:path`（单段参数 `:path`）匹配走，"trash" 成为 path 参数值。`GET /:jid/files/trash`（回收站列表）不受影响，因为 GET 方法下没有同模式的参数路由遮蔽。

> 外部依据：Hono 路由匹配按注册顺序，字面路由需在参数路由之前注册——这是路由器设计的通用约束，非 bug，但本实现未遵守。

## 4. 复现路径

```bash
# 1. 登录拿 cookie
curl -s -X POST http://127.0.0.1:9999/api/auth/login \
  -H 'Content-Type: application/json' \
  -d '{"username":"admin","password":"88888888"}' -c /tmp/c.txt

# 2. 获取工作区 jid（如 web:main）
JID=$(curl -s http://127.0.0.1:9999/api/groups -b /tmp/c.txt \
  | python3 -c "import sys,json;d=json.load(sys.stdin);g=d['groups'];print(list(g.keys())[0])")

# 3. 清空回收站 —— 修复前返回 404
curl -s -X DELETE "http://127.0.0.1:9999/api/groups/$JID/files/trash" -b /tmp/c.txt
# 修复前: {"error":"File or directory not found"}
# 修复后: {"success":true}
```

## 5. 诊断方法

```bash
# 确认路由注册顺序——字面 trash 路由是否在参数 :path 路由之前
grep -n "fileRoutes.delete" src/routes/files.ts

# 预期（修复后）顺序：
#   fileRoutes.delete('/:jid/files/trash/:id', ...)   ← 字面在前
#   fileRoutes.delete('/:jid/files/trash', ...)       ← 字面在前
#   fileRoutes.delete('/:jid/files/:path', ...)      ← 参数在后
```

## 6. 修复方案

**外科手术式：仅调整路由注册顺序，零逻辑改动**。将 `DELETE /:jid/files/trash/:id`（彻底删除单项）与 `DELETE /:jid/files/trash`（清空回收站）两个字面路由的注册，移到 `DELETE /:jid/files/:path` 参数路由之前。

```diff
+ // DELETE /api/groups/:jid/files/trash/:id — 彻底删除单项
+ // 注意：字面路由 trash 必须注册在参数路由 :path 之前，否则 Hono 会将 "trash" 当作 :path 捕获
+ fileRoutes.delete('/:jid/files/trash/:id', authMiddleware, (c) => { ... });
+
+ // DELETE /api/groups/:jid/files/trash — 清空回收站
+ // 注意：字面路由 trash 必须注册在参数路由 :path 之前，否则 Hono 会将 "trash" 当作 :path 捕获
+ fileRoutes.delete('/:jid/files/trash', authMiddleware, (c) => { ... });
+
  // DELETE /api/groups/:jid/files/:path - 删除文件
  fileRoutes.delete('/:jid/files/:path', authMiddleware, (c) => { ... });
```

**选型理由**：
1. 仅移动注册位置，不改动任何处理器逻辑（Surgical Changes 原则）。
2. 加注释说明「字面路由须在参数路由前」的约束，防止后续维护者再次踩坑。
3. 不引入「路由分组/子应用」等更大重构（Simplicity First）。

## 7. 处理卡住的状态

无卡住的运行态。本 bug 为代码层路由匹配缺陷，重启服务加载新 `dist/routes/files.js` 即生效，无遗留脏数据（回收站表 `file_trash` 在 bug 期间数据正常，只是清空接口不通）。

## 8. 经验沉淀 / 预防

**教训**：Hono（及大多数路径参数路由器）按注册顺序匹配，字面路径段必须注册在同模式的参数路径段之前。本例 `trash`（字面）与 `:path`（参数）同处 `/:jid/files/{seg}` 单段位置，先注册的 `:path` 把 `trash` 吃掉。

**预防**：
1. **路由注册约定**：同一 HTTP 方法下，字面路由一律写在参数路由之前，并加注释标注遮蔽关系。
2. **巡检脚本**：新增 lint 检查——对 `fileRoutes.{method}('/:.../:<param>', ...)` 模式，扫描是否存在同前缀、同段数的字面路由注册在其之后，有则告警。可接入 CI。
3. **测试覆盖**：回收站相关 3 个 DELETE 接口（purge/empty/soft-delete）必须有 e2e 断言，本次 `disk-api-verify.sh` 已覆盖 16 用例，后续回归直接跑该脚本。
4. **全局排查**：应排查 `src/routes/*.ts` 是否存在同类「字面路由晚于参数路由」的遮蔽隐患（如 `search`/`rename`/`move` 等字面段是否被 `:path` 遮蔽）——经核查，这些字面路由均为多段（`/:jid/files/search` 是 GET 且 `:path` 的 GET 版本也是 `:path`，但 search 路径不同段数不冲突），当前仅 trash 单段 DELETE 受影响。
