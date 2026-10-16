# 知识库重建索引后列表仍显示「已向量化 0」：冗余计数列没人刷新

- 日期：2026-10-16
- 分支：`worktree-fix-embedded-count`
- 影响范围：`src/routes/paas-knowledge-bases.ts` 的 `POST /:id/rebuild-index`（`:1003`）
- 状态：已修复
- 引入提交：`dd8dc01`（知识库子系统首次落地，**非本轮 P1 引入**）
- 发现方式：9999 实例落地向量模型后的**人工复核**，不是自动化用例发现的（原因见 §8.1）

## 1. 用户现象

在 9999 实例上配好向量模型、对知识库点了「重建索引」，文档列表里那一行仍然是：

```
eCRF填写指南-…-CIBI3026A101_CCI_V1.0_20260106.pdf
就绪  pdf  201.1 KB · 分块 266 · 已向量化 0 · 2026-10-16T10:02:29.258Z
```

**「分块 266」是对的，「已向量化 0」是错的。**

这个数字直接决定用户下一步做什么：看到 0，正常反应是「重建索引没生效，得再点一次 / 换个姿势」。
而实际上索引早就建好了 —— 用同一个库检索是能命中的（§5 有实测），也就是说**用户在为一个
并不存在的问题反复折腾**。更糟的是没有第二个信号能纠正他：状态是「就绪」、没有报错、没有红点。

## 2. 问题描述

界面上那个数字来自 `kb_documents.embedded_chunk_count` —— 一个**冗余计数列**，
而它与真值（`kb_chunks` 里 `embedding IS NOT NULL` 的行数）脱节了：

```
=== kb_documents 里的计数列 ===
id|chunk_count|embedded_chunk_count
1c3258b6|1|0
4fa8dae4|266|0

=== kb_chunks 实际 ===
267|267          -- 总行数 | 有向量的行数
```

同一个库、同一时刻：分块层 267/267 全有向量，文档层说自己 0 个向量化。

检索侧不受影响，因为检索读的是 `kb_chunks`/`kb_chunks_vec`，不读这个计数列。
所以这是一次**纯展示层的数据不一致** —— 数据是对的，界面在撒谎。

## 3. 根因

`embedded_chunk_count` 不是实时统计出来的，是**存下来的冗余值**，靠"谁写向量谁顺手更新"来维护。
全仓库只有两处写它、一处读它：

| # | 位置 | 行为 | 对错 |
|---|---|---|---|
| 1 | `src/kb/pipeline.ts:262` | ingest 管线入库末尾按本轮实际嵌入数写入 | ✅ |
| 2 | `src/routes/paas-knowledge-bases.ts:985`（单文档 embed 端点） | `updateDocumentParseState(docId, { embedded_chunk_count: countEmbeddedChunksForDocument(docId) })` | ✅ 实时重算 |
| 3 | `src/routes/paas-knowledge-bases.ts:172`（文档列表序列化） | `embedded_chunk_count: row.embedded_chunk_count ?? 0` | 读的是存值，**不重算** |
| 4 | `src/routes/paas-knowledge-bases.ts:1003`（`rebuild-index`） | 调 `embedAllChunksInKb(id, 200)` 写向量，**不更新计数列** | ❌ **缺陷点** |

也就是说：**只有 ingest 管线经过的路，计数列才会被维护。**
`rebuild-index` 是一条绕开管线的旁路 —— 它直接调底层 `embedAllChunksInKb()` 批量补向量，
从没碰过计数列。而 `rebuild-index` 恰恰是**用户为了"把向量补上"才会去点的那个按钮**，
于是这条路径上的用户 100% 会看到那个错误的 0。

注意第 2 行（单文档 embed 端点）当时已经用"实时重算"的方式补过一次同样的坑 ——
说明这个模式在仓库里是已知的，只是 `rebuild-index` 这条路径漏了。

**为什么它是"静默"的**：接口返回的 `attempted/success/failed` 全部正确
（9999 上返回的就是真实的 `{"attempted":267,"success":267,"failed":0}`），
只有读列表接口那一列才会看到不一致。**接口层面所有断言都会通过。**

## 4. 复现路径

不需要真模型，不需要 9999：

1. 建一个知识库；
2. **先不配**向量模型，上传一份文档 → 等状态到「就绪」。此时分块已产生、计数列为 0；
3. 这时再去「设置 → 本机模型服务」把向量模型配上（真实用户在 9999 上就是这个顺序）；
4. 点「重建索引」；
5. 看文档列表 —— 分块有数、**已向量化仍是 0**；
6. 直接查库：`kb_chunks` 里的 `embedding` 已经全部写上了。

第 2 步的时序是刻意的：先传文档后配模型，才会走到 `rebuild-index` 这条旁路。
如果一开始就配好模型，走的是 ingest 管线，就复现不出来。

## 5. 诊断方法

**（a）直接比"计数列"和"真值"** —— 一条命令就能看出撒谎：

```bash
DB=~/.deepthink-9999/db/deepthink.db   # 9999 的数据目录以实际为准

sqlite3 "$DB" "SELECT id, chunk_count, embedded_chunk_count FROM kb_documents;"
# 1c3258b6|1|0
# 4fa8dae4|266|0        ← 计数列说没人有向量

sqlite3 "$DB" "SELECT COUNT(*), COUNT(embedding) FROM kb_chunks;"
# 267|267               ← 真值说全都有
```

**（b）证明"其实已经生效"** —— 别只看数字，直接问检索：

```bash
curl -s -X POST "http://127.0.0.1:9999/api/paas/knowledge-bases/<kbId>/search" \
  -H 'Content-Type: application/json' \
  -b cookies.txt -d '{"query":"录错了受试者的信息要怎么修正？","top_k":5,"mode":"vector"}'
```

9999 实测：`keyword` 模式 **0 条**、`vector` 模式 **3 条**（0.6753 / 0.6439 / 0.6257）、
`hybrid` 3 条。命中卡片上写着 `向量分: 0.6333  关键词分: 0.0000` —— 得分全部来自向量臂。
**向量索引工作正常，"已向量化 0"是纯粹的显示错误。**

**（c）定位代码** —— 搜这个列的读写点：

```bash
grep -n "embedded_chunk_count" src/routes/paas-knowledge-bases.ts src/kb/pipeline.ts
```

四个命中点，只有 `rebuild-index` 是"写向量但不管计数"的。

**（d）回归用例**（`tests/units/kb-rebuild-index-count.test.ts`，3 项）：

```bash
npx vitest run tests/units/kb-rebuild-index-count.test.ts
```

把修复回退后跑，第 2 项失败在**预期的那一行**上：

```
AssertionError: expected +0 to be 1 // Object.is equality
 ❯ tests/units/kb-rebuild-index-count.test.ts:162:38
     expect(doc.embedded_chunk_count).toBe(doc.chunk_count);
```

## 6. 修复方案

`rebuild-index` 在批量补完向量之后，按**已有的那个模式**（`:985` 的写法）把计数列重算一遍。

```diff
   const stats = await embedAllChunksInKb(id, 200);
+
+  // `kb_documents.embedded_chunk_count` 是冗余计数列，平时由 ingest 管线在
+  // pipeline.ts 里维护。重建索引走的**不是**那条管线，于是没人更新它 ——
+  // 结果是库里 267/267 个分块都拿到向量了、检索也确实命中，列表上却还是
+  // 「已向量化 0」。用户据此判断"重建索引没生效"，而实际是生效了。
+  // 单文档的 embed 端点（上面那个）已经用同一个办法补过，这里对齐它的写法。
+  for (const d of listKbDocuments(id, user.id)) {
+    updateDocumentParseState(d.id, {
+      embedded_chunk_count: countEmbeddedChunksForDocument(d.id),
+    });
+  }
+
   return c.json({
     dimension_changed: dimensionChanged,
     rechunked_documents: stale.length,
     ...stats,
   });
```

三个函数（`listKbDocuments` / `updateDocumentParseState` / `countEmbeddedChunksForDocument`）
在文件顶部**原本就已导入**，改动不动 import、不动接口契约、不动前端。

**选型理由**：

- **不去掉冗余列、改实时统计** —— 列表接口要一次列出几十个文档，实时统计就是每个文档一次
  `COUNT(*)`，N+1 查询。这个冗余列是有意为之的，缺陷在"漏更新"，不在"用冗余列"。
- **不改成只在返回体里算一次** —— 内存里算出来的数字只对这一次响应有效，前端一刷新又变回 0，
  等于没修。
- **沿用 `:985` 的现成写法** —— 同一类问题在同一个文件里已经有正确答案，保持一致比自创写法更重要。

## 7. 处理卡住的状态

存量库不需要任何迁移脚本：**修复上线后点一次「重建索引」就会自愈**
（`embedAllChunksInKb` 发现没有待嵌入的分块会直接返回 `attempted: 0`，随后计数列被重算）。

9999 实测量级：267 个分块、无需重新嵌入、一次请求内完成。

如果用户的数据已经被这个错误的 0 误导过，用 §5(a) 的两条 SQL 当作交付时的对账口径即可。

## 8. 经验沉淀 / 预防

### 8.1 为什么 2420 个单测全绿，也没挡住它

因为这个缺陷**不在任何一条被断言过的链路上**：

- 接口层的断言（`attempted` / `success` / `failed`）**全部正确**；
- 检索层的断言（能不能命中）**全部正确**；
- 出问题的只有"列表接口从哪一列读数字"，而此前没有任何用例读过 `embedded_chunk_count`。

一条通用教训：**冗余列（denormalized counter）的写入点必须成套地测**。
只要存在"绕过管线的旁路"，就要有一条用例专门断言"走旁路之后冗余列仍然等于真值"。
新用例 `tests/units/kb-rebuild-index-count.test.ts` 的断言点**刻意选在列表接口**而不是 stats，
就是为了让后来者不能再靠"接口返回对"来蒙混过去。

### 8.2 这是一类缺陷，不是一次意外

同一天在知识库子系统里，`embedded_chunk_count` 是第 3 个"数据对、界面错"的缺陷
（前两个：`kb-chunk-content-not-equal-to-source-slice`、`kb-parent-child-invisible-end-to-end`）。
它们的共同形态都是：**底层数据是对的，某一层派生视图没有跟着更新**。

建议的巡检（可挂进现有的巡检脚本）：

```sql
-- 计数列与真值不一致的文档。正常情况应返回 0 行。
SELECT d.id, d.filename, d.embedded_chunk_count AS listed,
       (SELECT COUNT(*) FROM kb_chunks c
         WHERE c.doc_id = d.id AND c.embedding IS NOT NULL) AS actual
  FROM kb_documents d
 WHERE d.parse_status = 'ready'
   AND d.embedded_chunk_count <> (SELECT COUNT(*) FROM kb_chunks c
                                   WHERE c.doc_id = d.id AND c.embedding IS NOT NULL);
```

### 8.3 已知边界（本次不修，如实记录）

`rebuild-index` 内部是 `embedAllChunksInKb(id, 200)` —— **单次最多嵌入 200 个分块**，
且前端只调一次、不循环。所以 267 个分块的库点一次只补 200 个，提示语里的
「向量化 200/200」也只反映这一批。修复后**列表上的数字是诚实的**（会显示 200，不是 266），
用户再点一次就会补齐，但**"重建索引"这个按钮名与"可能要按好几次"之间仍有落差**。

本轮不改的原因：改成分批循环会让这个同步请求的耗时随分块数线性增长，
而前端超时是 300 秒（`web/src/stores/knowledge-bases.ts:471`）——
几千个分块的库会直接超时。要正确做需要改成后台任务 + 进度轮询，
那是另一个需求（与扫描件 OCR 的后台化同构），不在本次 bugfix 范围内。
**这里如实记下，不假装它不存在。**
