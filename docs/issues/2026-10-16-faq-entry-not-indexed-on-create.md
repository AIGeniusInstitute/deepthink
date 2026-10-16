# FAQ 条目建完不被向量化，而 FAQ 库根本没有可用的向量化入口

- 日期：2026-10-16
- 分支：`worktree-feat-kb-full-replica`
- 影响范围：`src/routes/paas-knowledge-bases.ts` FAQ 条目 POST / PUT；`web/src/components/knowledge-base/KbFaqPanel.tsx`（文案）
- 状态：已修复

## 1. 用户现象

在 FAQ 型知识库里新建一条条目，条目卡片上写着「v1 · **待向量化**」；在同一个页面的
「试检索」里输入条目自己的标准问、甚至逐字复制相似问，**永远返回「没有命中」**。
刷新、重进页面、重新保存，都一样。

界面上反复出现的提示是「需重新向量化才能检索到新内容」，但这个 FAQ 页面上**没有任何按钮
能做这件事**。

## 2. 问题描述

FAQ 条目创建/更新只落库、不建索引：

```ts
paasKbRoute.post('/:id/faq/entries', async (c) => {
  …
  const row = createFaqEntry(container.id, kb.id, user.id, validation.data, indexMode);
  return c.json({ entry: serializeFaqEntry(row) }, 201);   // 到此为止，没有任何 embedding 调用
});
```

`createFaqEntry`（`src/db.ts`）的 INSERT 不写 `embedding` 列；`updateFaqEntry` 更是显式把
`embedding = NULL`（内容变了，旧向量作废）—— 但**没有任何调用方负责把它补回来**。

全仓库唯一的"批量向量化"入口是 `POST /:id/rebuild-index`，它绑定在「文档」页签的工具条按钮
「重建索引」上（`web/src/pages/KnowledgeBaseDetailPage.tsx:271`）。而 FAQ 库的页签被主动裁剪过：

```ts
const visibleTabs = TABS.filter((t) =>
  isFaq ? t.id !== 'documents' && t.id !== 'chunks' : t.id !== 'faq',
);
```

FAQ 库只留 `faq / search / chat` —— **「重建索引」按钮所在的页签恰好被藏掉了**。
于是 FAQ 库的条目从建出来那一刻起就不可能被检索到，且用户无路可走。

## 3. 根因

**实现偏离了上游语义**：上游 FAQ 条目的建索引是**在写接口里同步做的**，本仓库把它
退化成了"等后续批处理"，而那个批处理在 FAQ 场景下不可达。

上游依据（`~/WeKnora`，本仓库复刻的来源）：

- `internal/application/service/knowledge_faq.go:114`
  `// CreateFAQEntry creates a single FAQ entry synchronously.`
  函数内 `s.indexFAQChunks(indexCtx, kb, faqKnowledge, []*types.Chunk{chunk}, embeddingModel, true, false)`，
  且**索引失败会删掉刚建的 chunk 并返回错误**（rollback）。
- `internal/application/service/knowledge_faq.go:316` `UpdateFAQEntry` 同样在写完之后重新索引：
  `// indexFAQChunks will delete old vectors and re-insert with the latest chunk data`。

本仓库的运行证据：

```sql
sqlite> select kb_id, count(*) n, group_concat(distinct chunk_type) types,
                sum(embedding is not null) emb from kb_chunks group by kb_id;
kb_id                                 n  types  emb
9198c9cc-…（文档库）                   3  text   3
d3675e90-…（FAQ 库）                   1  faq    0     ← 有条目，一个向量都没有
```

## 4. 复现路径

1. 建一个 **FAQ 型**知识库（新建对话框里选 FAQ）。
2. 在「FAQ 条目」页签新建一条：标准问「校准周期是多久」，相似问「这台仪器多久要重新标定一次」，
   答案随便填一句。保存。
3. 观察条目卡片：显示「v1 · 待向量化」。
4. 在「试检索」输入框里填**标准问原文**，点「检索」→ 结果区显示「没有命中。」
5. 想找补救入口：FAQ 库只有 `FAQ 条目 / 检索测试台 / 问答` 三个页签，
   没有「文档」页签，也就没有「重建索引」。**到此为止，没有任何办法。**

## 5. 诊断方法

```bash
# ① 条目到底有没有向量
sqlite3 ~/.deepthink-9911/db/messages.db \
  "select chunk_type, (embedding is not null) as emb, substr(content,1,40)
   from kb_chunks where chunk_type='faq';"

# ② 唯一的向量化入口挂在哪个页签
grep -n "rebuild-index\|rebuildIndex" src/routes/paas-knowledge-bases.ts web/src/pages/KnowledgeBaseDetailPage.tsx
grep -n "visibleTabs" -A3 web/src/pages/KnowledgeBaseDetailPage.tsx

# ③ 直接用接口验一次（绕开界面，确认是后端没索引而不是前端没显示）
curl -s -b <cookie> -X POST http://localhost:9911/api/paas/knowledge-bases/<faqKbId>/rebuild-index -d '{}'
#   跑完之后再查 ①，emb 变 1 → 证明向量化链路本身是好的，只是没人调它

# ④ 上游怎么做的
sed -n '114,120p;190,215p' ~/WeKnora/internal/application/service/knowledge_faq.go
```

## 6. 修复方案

在 FAQ 路由里加一个内联索引步骤，POST 与 PUT 各调用一次：

```diff
--- a/src/routes/paas-knowledge-bases.ts
+++ b/src/routes/paas-knowledge-bases.ts
+/**
+ * FAQ 条目落库后**立刻**建索引。
+ *
+ * 上游 `CreateFAQEntry` 就是同步索引（`knowledge_faq.go`：`indexFAQChunks` 成功
+ * 才返回条目，失败则删掉刚建的 chunk），不是留给后续批处理 —— FAQ 库的条目本来
+ * 也没有别的向量化入口。这里沿用这个语义，唯一区别是索引失败**不回滚**：条目已经
+ * 落库，删掉用户刚填的内容比留一条列表里可见的「待向量化」（重存一次即重试）更糟。
+ */
+async function indexFaqEntry(docId: string, kbId: string, entryId: string) {
+  const stats = await embedChunksForDocument(docId).catch((err) => {
+    logger.warn({ err, kbId }, 'FAQ 条目向量化请求失败，条目保持「待向量化」');
+    return { attempted: 0, success: 0, failed: 0 };
+  });
+  if (stats.failed > 0) {
+    logger.warn({ kbId, failed: stats.failed }, 'FAQ 条目向量化失败，条目保持「待向量化」');
+  }
+  return getKbChunk(entryId);
+}
+
 paasKbRoute.post('/:id/faq/entries', async (c) => {
   …
   const row = createFaqEntry(container.id, kb.id, user.id, validation.data, indexMode);
-  return c.json({ entry: serializeFaqEntry(row) }, 201);
+  const indexed = await indexFaqEntry(container.id, kb.id, row.id);
+  return c.json({ entry: serializeFaqEntry(indexed ?? row) }, 201);
```

```diff
@@ PUT /:id/faq/entries/:entryId
   const row = updateFaqEntry(existing.id, validation.data, indexMode);
   if (!row) return c.json({ error: 'FAQ entry not found' }, 404);
-  return c.json({ entry: serializeFaqEntry(row) });
+  // 编辑会把 embedding 置空（内容变了，旧向量失效），所以这里必须重新索引，
+  // 否则改过的条目就再也搜不到了。
+  const indexed = await indexFaqEntry(row.doc_id, kb.id, row.id);
+  return c.json({ entry: serializeFaqEntry(indexed ?? row) });
```

UI 文案同步（改完后"需重新向量化"已经不成立）：

```diff
-    toast.success(draft.id ? '已保存，需重新向量化才能检索到新内容' : '条目已创建');
+    toast.success(draft.id ? '已保存并重新向量化' : '条目已创建并向量化');
```

选型理由：

- **复用 `embedChunksForDocument(docId)` 而不是新写单条嵌入**：它只挑 `embedding IS NULL`
  的行（`listUnembeddedChunksForDocument`），重复调用幂等；而且对 `chunk_type='faq'` 的行
  会自动走 `chunkIndexTexts` → `buildFaqIndexTexts`，`separate` 模式下相似问题各占一条向量。
  换成单条嵌入反而要重新实现这套变体逻辑。
- **失败不回滚（与上游的唯一偏离）**：上游删掉刚建的 chunk 并返回错误。本仓库不回滚，
  理由是条目已经落库、界面明确显示「待向量化」、重存一次即可重试；删掉用户刚填的内容
  是更糟的失败模式。**这是一处显式登记的偏离。**

验证：

- 单元测试 `tests/units/kb-faq-search.test.ts` 的语义随之对齐上游：
  「更新即重建向量，PUT 返回时条目已是新内容的向量」+「db 层：改内容会把 embedding 置空」
  （后者保证"改了内容却留旧向量"这条静默错误召回路径仍被锁住）。
- UI 验收：新建条目后「试检索」用**只在相似问里出现过**的问法命中该条目，得分 1.000。
  截图 `docs/test_report/2026-10-16-weknora-full-replica/screenshots/09-kb-faq-probe-hit.png`。
- 全量回归 2386 项通过。

## 7. 处理卡住的状态

已经建出来、但处于「待向量化」的条目不需要特殊处置：调一次
`POST /api/paas/knowledge-bases/<kbId>/rebuild-index` 即可全量补上
（`embedAllChunksInKb` 会把该库所有 `embedding IS NULL` 的行补齐，含 FAQ 行）。

## 8. 经验沉淀 / 预防

- **"有功能"和"能到达"是两件事。** 向量化能力早就写好了、单测也过，但它挂在 FAQ 库
  看不见的页签上 —— 从 FAQ 用户的角度，这个能力等于不存在。
  凡是"裁剪 UI 入口"（如 FAQ 库隐藏 documents/chunks）时，必须回头核对：**被藏掉的那个页签
  上还挂着哪些别的功能**。本次就是这么漏的。
- **界面文案承诺了动作，就必须有对应的入口。** 「需重新向量化」这句话在页面上出现了 3 次，
  而页面没有任何地方能执行它 —— 文案其实是在描述一个不存在的按钮。
- 复刻类需求的验收标准应当是"**上游在写接口里做的事，我们是不是也在写接口里做了**"，
  而不是"这个能力我们有没有"。后者会掩盖掉把同步操作退化成不可达批处理这一类偏离。
- 遗留：切换「索引方式」（`question_answer` ↔ `question_only`、`combined` ↔ `separate`）
  会让全库向量一次性作废，这一条仍**没有**入口（toast 仍提示"需重新向量化"）。
  见 `docs/task_state/2026-10-16-weknora-full-replica/STATE.md` §5 缺口登记。
