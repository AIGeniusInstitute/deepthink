# 删除含文档的知识库返回 500（DELETE 语句上误用 .all()）

- 日期：2026-10-16
- 分支：`worktree-feat-knowledge-base`
- 影响版本：`src/db.ts` `deleteKnowledgeBase`（先于本次知识库子系统开发即存在）
- 状态：已修复

## 1. 用户现象

在知识库列表页删除一个知识库，界面弹「删除失败」，浏览器 Network 面板里 `DELETE /api/paas/knowledge-bases/:id` 返回 **500**。刷新页面，知识库还在。

**只要走到删除接口就必然 500**——不管是空库还是传了文档的库，删不掉的东西一件也删不掉。

## 2. 问题描述

删除知识库的接口在做级联清理时，先删除该知识库下的文档、再删除知识库本身。第一步用的 SQL 是 `DELETE FROM kb_documents WHERE kb_id = ?`，但调用的是 better-sqlite3 的 `.all()` 而不是 `.run()`。

`.all()` 的语义是"执行并把结果行全部取回"，对一条不产生结果集的 `DELETE` 语句，better-sqlite3 会直接抛错。**抛错发生在语句执行时，与影响多少行无关**，实测（见 §5）：

```
有文档的库 -> 抛错: This statement does not return data. Use run() instead
空库       -> 抛错: This statement does not return data. Use run() instead
```

所以这不是"有文档才失败"，而是这条语句**从来没成功执行过**——删除知识库这个功能自实现起就是不可用的。

异常没有被单独捕获，冒泡到路由的错误处理器，统一返回 500，前端只能显示"删除失败"，看不到任何有用信息。

## 3. 根因

代码层面，`src/db.ts` 约 11447 行：

```ts
// 修复前
db.prepare('DELETE FROM kb_documents WHERE kb_id = ?').all(id);
```

better-sqlite3 对语句类型有严格区分，用错会抛：

```
TypeError: This statement does not return data. Use run() instead
    at src/db.ts:11447
```

这个错误信息本身就是根因的直接证据——它明确说了"这条语句不返回数据，应该用 `run()`"。

基础设施层面暴露的相关问题：删除文档时依赖外键 `ON DELETE CASCADE` 去清 `kb_documents` 是**不够的**。`kb_documents` 与 `kb_chunks` 上各挂了 FTS5 的 `AFTER DELETE` 触发器，而 SQLite 的 `recursive_triggers` 默认为 off，级联删除**不会**触发子表上的 delete 触发器。结果就是：即使删成功了，FTS 索引里也会残留已删除文档的影子行，后续关键词检索会召回已经不存在的分块。

## 4. 复现路径

```bash
# 1. 登录拿 cookie
curl -s -c cookies.txt -X POST http://127.0.0.1:9899/api/auth/login \
  -H 'Content-Type: application/json' \
  -d '{"username":"admin","password":"88888888"}'

# 2. 建库
KB=$(curl -s -b cookies.txt -X POST http://127.0.0.1:9899/api/paas/knowledge-bases \
  -H 'Content-Type: application/json' -d '{"name":"repro"}' | jq -r .id)

# 3. 传一份文档，等它 ready
curl -s -b cookies.txt -X POST "http://127.0.0.1:9899/api/paas/knowledge-bases/$KB/documents" \
  -F "file=@deepthink-ops.md"

# 4. 删除 —— 修复前 500，修复后 200
curl -s -b cookies.txt -o /dev/null -w "%{http_code}\n" \
  -X DELETE "http://127.0.0.1:9899/api/paas/knowledge-bases/$KB"
```

UI 复现：知识库列表 → 传一份文档 → 点垃圾桶 → 确认 → 提示「删除失败」。

## 5. 诊断方法

```bash
# 看后端日志里那条 TypeError（含准确行号）
grep -n "does not return data" ~/.deepthink*/logs/*.log | tail
```

```bash
# 直接确认 FTS 索引有没有残留影子行
sqlite3 /tmp/dt-kb-ui/data.db \
  "SELECT count(*) FROM kb_chunks_fts WHERE kb_chunks_fts MATCH 'deep*';"
```

也可以在 Node 里最小化复现，不需要跑整个服务（把 `db.prepare(...).all(kb)` 分别对"命中的库"和"不存在的库"各执行一次，两次都会抛）：

```js
const Database = require('better-sqlite3');
const db = new Database(':memory:');
db.exec('CREATE TABLE kb_documents(id TEXT, kb_id TEXT)');
db.prepare('INSERT INTO kb_documents VALUES (?,?)').run('a', 'k1');
for (const [label, kb] of [['有文档的库', 'k1'], ['空库', 'k-empty']]) {
  try { db.prepare('DELETE FROM kb_documents WHERE kb_id = ?').all(kb); console.log(label, '-> 未抛错'); }
  catch (e) { console.log(label, '-> 抛错:', e.message); }
}
// 有文档的库 -> 抛错: This statement does not return data. Use run() instead
// 空库       -> 抛错: This statement does not return data. Use run() instead
```

## 6. 修复方案

```diff
- db.prepare('DELETE FROM kb_documents WHERE kb_id = ?').all(id);
+ // 显式删除文档（而不是依赖外键级联），才会触发出 kb_documents_fts 的 delete 触发器；
+ // kb_chunks 由 kb_documents 级联删除，进而触发分块 FTS 的 delete 触发器。
+ db.prepare('DELETE FROM kb_documents WHERE kb_id = ?').run(id);
```

选型理由：只把 `.all()` 换成 `.run()` 能修掉 500，但修不掉 FTS 影子行。显式删除文档行是**同时**解决两者的最小改动——它让 `kb_documents_fts` 的 `AFTER DELETE` 触发器真正跑到，而 `kb_chunks` 的级联删除是 SQLite 内部的、会触发 `kb_chunks_fts` 的触发器。比"打开 `PRAGMA recursive_triggers`"更保守：后者会改变全库所有触发器语义，影响面远大于本次问题。

回归验证：UI 验收脚本每次运行前会逐个删除上一轮遗留的知识库，并断言 `HTTP 200`。

## 7. 处理卡住的状态

不需要救活运行态——这是同步请求内的异常，没有留下中间状态。**但已经卡住的数据要清理**：修复前如果曾经出现过"删到一半"的知识库，其 `kb_chunks_fts` 里可能残留影子行，导致检索返回指向已删除分块的命中。清理方式：

```sql
-- 重建分块 FTS 索引，丢弃全部影子行
INSERT INTO kb_chunks_fts(kb_chunks_fts) VALUES('rebuild');
```

## 8. 经验沉淀 / 预防

- **`.all()` / `.get()` / `.run()` 不能混用**：`.all()` 和 `.get()` 只用于会返回结果集的语句（`SELECT`、带 `RETURNING` 的写语句），其余一律 `.run()`。better-sqlite3 会主动抛错而不是静默返回空数组——这是它的优点，前提是错误没有被上层吞掉。
- **这条 bug 一直存在，说明"删除"这条路径缺少测试**：新增/读取都有覆盖，删除没有。凡是带级联副作用的写操作（删父删子、删索引、删文件），都应有至少一条"删掉之后什么都不剩"的断言。
- **级联删除不会触发 SQLite 触发器**：只要表上挂了 FTS 触发器，就不能只依赖 `ON DELETE CASCADE`。约定：**任何挂 FTS 的表，父表删除时必须显式删除该表的行**。
- **巡检建议**：全仓 grep `\.all(` 并确认每处调用的语句类型；对挂了 FTS 触发器的表做一次触发路径梳理。
- **错误可见性**：删除接口把任何异常一律折叠成 500 + "删除失败"，让一个精确到行号的 TypeError 变成了一句无信息量的话。这类"兜底 catch 后返回通用错误"的地方，建议至少把原始错误写进服务端日志（本次日志里有，所以定位很快）并在响应里带上 error id 便于对账。
