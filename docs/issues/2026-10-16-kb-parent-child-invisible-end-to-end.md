# 父子分块在界面上完全不可用：勾不上、看不到、接口还漏字段

- 日期：2026-10-16
- 分支：`worktree-feat-kb-full-replica`
- 影响范围：`web/src/pages/KnowledgeBaseDetailPage.tsx`（上传参数）、
  `web/src/components/knowledge-base/KbChunkViewer.tsx`（分块标记）、
  `web/src/stores/knowledge-bases.ts`（`KbChunk` 类型 + 表单标记）、
  `src/routes/paas-knowledge-bases.ts` `serializeChunk`（响应字段）
- 状态：已修复

## 1. 用户现象

P1 的验收项是「上传文档时勾选**父子分块** → 分块视图里能看到**父块 / 子块**标记」。
把这条路走一遍，三步全断：

1. **上传面板里没有「父子分块」这个选项** —— 只有切块策略、块大小、重叠字数。用户
   根本无从勾选，任何上传进去的文档都只能是普通分块。
2. 用接口硬塞 `parent_child=1` 上传（绕开界面），进「分块」页签：**所有块长得一模一样**，
   没有任何标记说明哪个是父块、哪个是子块、哪个是检索单元。
3. 把标记补上再看：**「父块」标记出现了，但「子块」一个都没有** —— 界面上父子关系
   只剩下半截，看起来像"切分只切出了父块"。

UI 验收脚本的读数把第 3 步钉死了：

```
❌ 分块视图区分父块与子块 — 共 19 块 · 父块 6 · 子块 0
```

## 2. 问题描述

同一条用户路径上有三个独立缺陷，一个挡住下一个：

**D1｜上传表单没接这个参数。** 页面 state 里没有 `parentChild`，`uploadDocument` 的
`ChunkConfigInput` 里也没传 `parent_child`。store 的 FormData 组装早写好了
（`web/src/stores/knowledge-bases.ts:348` `if (cfg?.parent_child) fd.append('parent_child','1')`），
后端 `paas-knowledge-bases.ts:606` `isTruthyFormFlag(formData.get('parent_child'))` 也读它 ——
**只是没有任何界面能把它置成 true**。这条链路是通的，缺的是起点。

**D2｜分块视图压根没有父子标记。** `KbChunkViewer` 渲染的角标只有 `#index`、字符区间、
`heading_path`、`已向量化/未向量化`，没有任何一处体现 `chunk_type` / `parent_chunk_id`。
数据在库里、也在接口里（见 D3），但界面不呈现。同时 `KbChunk` 这个 TS 类型里也**没有**
`chunk_type` / `parent_chunk_id` 两个字段，想渲染都拿不到类型。

**D3｜接口序列化白名单漏字段。** 补上 D2 的标记之后，「父块」能显示了（它的判据是
`chunk_type === 'parent_text'`，这个字段接口有吐），但「子块」仍然一个不出现 ——
因为子块的判据是 `parent_chunk_id` 非空，而 `serializeChunk` 从来没输出过这个字段：

```ts
function serializeChunk(row: KbChunkRow, withContent = true): Record<string, unknown> {
  return {
    id, kb_id, doc_id, chunk_index,
    content, preview, char_count, heading_path, start_at, end_at,
    pre_chunk_id, next_chunk_id,          // ← 前后邻居都给了
    is_enabled, chunk_type,               // ← 类型也给了
    embedded, embedding_model, created_at, updated_at, content_revision,
    generated_questions,
  };                                      // ← 唯独没有 parent_chunk_id
}
```

于是前端 `c.parent_chunk_id` 恒为 `undefined`，「子块」分支永远不进，全部落到普通分块样式；
父块走的是另一条分支，所以能正常显示 —— 现象正好是"只有父块、没有子块"。

## 3. 根因

**"后端能力已完成、前端入口从未接上"这一类缺口，三个层次各漏一处：上传参数（D1）、
呈现（D2）、接口契约（D3）。**

单测全绿也照样漏，因为两个测试文件走的都是接口层：

- `tests/units/kb-parent-child-e2e.test.ts:86` 直接 `fd.set('parent_child','true')` 打 HTTP，
  绕开了界面 —— D1 与它无关；
- 该测试断言的是**库里**的行（`parent_text` 存在、父块 `embedding IS NULL`），
  不经过 `serializeChunk` —— D3 与它无关。

证据（同一份文档，库里 vs 接口）：

```sql
sqlite> select chunk_index, chunk_type, ifnull(parent_chunk_id,'NULL') as parent
        from kb_chunks where doc_id = (select id from kb_documents where filename like 'kb-p1-e2e-%')
        order by chunk_index limit 6;
chunk_index  chunk_type   parent
0            text         NULL
1            parent_text  NULL
2            text         6459f69e-0888-41a8-b971-bd9b41a498b1     ← 子块，parent 非空
3            text         6459f69e-0888-41a8-b971-bd9b41a498b1
4            parent_text  NULL
5            text         8b6dcc11-2b91-404f-a254-7a102b255ef5
```

```bash
# 接口同一份数据里就是没有这个键
curl -s -b <cookie> '.../documents/<docId>/chunks?full=1' \
  | python3 -c "import sys,json;print(sorted(json.load(sys.stdin)['chunks'][0].keys()))"
# 修复前：… 'next_chunk_id', 'pre_chunk_id', 'preview', 'start_at' …   ← 无 parent_chunk_id
```

依据：`src/routes/paas-knowledge-bases.ts` `serializeChunk`、`src/kb/chunker.ts`
（`chunkParentChild` 产出 `parentIndex`，落库时写成 `parent_chunk_id`）、
`web/src/pages/KnowledgeBaseDetailPage.tsx`（上传参数组装）。

## 4. 复现路径

**D1：**

1. 建一个文档型知识库，进「文档」页签。
2. 看上传工具条的选项：`切块策略 / 块大小 / 重叠字数` —— **没有父子分块**。
   （源码层面等价于：`grep -n parent_child web/src/pages/KnowledgeBaseDetailPage.tsx` 无结果。）

**D2 / D3：**

3. 用接口上传一份**足够长**的 markdown 并带 `parent_child=1`
   （父块 4096 字 / 子块 384 字，文档太短的话上游语义压根不建父块行，见下）：

   ```bash
   curl -s -b <cookie> -F 'file=@long.md' -F 'parent_child=1' \
     http://localhost:9911/api/paas/knowledge-bases/<kbId>/documents
   ```

4. 等文档状态变「就绪」，切到「分块」页签。
5. 观察：**没有任何父块/子块标记**（D2）；补上标记后变成**只有父块、没有子块**（D3）。

## 5. 诊断方法

```bash
# ① 库里有没有父子两层（有 → 问题在展示链路，不在切分）
sqlite3 ~/.deepthink-9911/db/messages.db \
  "select chunk_index, chunk_type, ifnull(parent_chunk_id,'NULL') from kb_chunks
   where doc_id=(select id from kb_documents where filename like 'kb-p1-e2e-%') order by chunk_index;"

# ② 接口有没有吐这个字段（最快定性 D3）
curl -s -b <cookie> 'http://localhost:9911/api/paas/knowledge-bases/documents/<docId>/chunks?full=1' \
  | python3 -c "import sys,json;print(sorted(json.load(sys.stdin)['chunks'][0].keys()))"

# ③ 界面上到底渲染了什么标记（D2）
grep -n "chunk_type\|parent_chunk_id\|父块\|子块" web/src/components/knowledge-base/KbChunkViewer.tsx

# ④ 上传表单有没有这个开关（D1）
grep -rn "parent_child" web/src/pages/ web/src/stores/

# ⑤ 上游对"短文不建父块"的定义（避免把设计当缺陷）
grep -n "len(subs) > 1\|subs\[0\]" src/kb/chunker.ts
```

排查顺序：①→②→③→④，每一步都能把范围砍掉一半。本次按这个顺序走，
三个缺陷是一次串行暴露出来的（修完前一个才看得见后一个）。

## 6. 修复方案

### D1：上传面板补上开关

```diff
--- a/web/src/pages/KnowledgeBaseDetailPage.tsx
+++ b/web/src/pages/KnowledgeBaseDetailPage.tsx
   const [chunkOverlap, setChunkOverlap] = useState(80);
+  const [parentChild, setParentChild] = useState(false);
   …
     strategy,
     chunk_size: chunkSize,
     chunk_overlap: chunkOverlap,
+    parent_child: parentChild,
   });
```

```diff
@@ 上传工具条
+                <label className="flex items-center gap-1.5 text-xs select-none cursor-pointer pb-1.5">
+                  <input type="checkbox" data-testid="kb-parent-child" className="size-4 accent-teal-600"
+                    checked={parentChild} onChange={(e) => setParentChild(e.target.checked)} />
+                  父子分块
+                </label>
```

```diff
@@ 上传提示文案
                 上传后先解析，再按上述配置切块并向量化，整个过程在后台进行。
+                勾选「父子分块」会先按小节切出父块、再在父块内切子块，检索单元是子块、
+                命中后可用父块补足上下文（父块本身不参与向量化）。
```

### D2：分块视图加父子标记，类型补字段

```diff
--- a/web/src/stores/knowledge-bases.ts
+++ b/web/src/stores/knowledge-bases.ts
 export interface KbChunk {
   generated_questions?: string[];
+  /** `text`（检索单元）| `parent_text`（回溯容器，不参与向量化）| `faq`。 */
+  chunk_type?: string | null;
+  parent_chunk_id?: string | null;
 }
```

```diff
--- a/web/src/components/knowledge-base/KbChunkViewer.tsx
+++ b/web/src/components/knowledge-base/KbChunkViewer.tsx
                 {c.heading_path && ( … )}
+                {c.chunk_type === 'parent_text' && (
+                  <span data-testid="kb-chunk-type"
+                    className="px-1.5 py-0.5 rounded bg-violet-100 text-violet-700"
+                    title="父块是回溯用的容器，不参与向量化、不出现在检索结果里">父块</span>
+                )}
+                {c.chunk_type === 'text' && c.parent_chunk_id && (
+                  <span data-testid="kb-chunk-type"
+                    className="px-1.5 py-0.5 rounded bg-sky-100 text-sky-700"
+                    title="子块：检索单元，命中可用父块补足上下文">子块</span>
+                )}
                 {c.embedded ? ( …已向量化… ) : ( …未向量化… )}
```

### D3：接口补上 `parent_chunk_id`

```diff
--- a/src/routes/paas-knowledge-bases.ts
+++ b/src/routes/paas-knowledge-bases.ts
@@ serializeChunk
     is_enabled: !!row.is_enabled,
     chunk_type: row.chunk_type,
+    // 子块靠这个字段回指父块；前端据此区分「父块 / 子块」。漏了它，库里明明有父子
+    // 两层，界面上一律显示成普通分块。
+    parent_chunk_id: row.parent_chunk_id ?? null,
     embedded: !!row.embedding,
```

选型理由：

- **D1 加复选框而不是加到「新建知识库」对话框**：`parent_child` 是**上传时**的参数
  （`reparseDocument` 也按文档级读它），不是库级配置，放上传工具条才和它的作用域一致。
- **D2 用 `chunk_type` + `parent_chunk_id` 双判据，不在前端靠 `heading_path` 猜**：
  `chunk_type === 'parent_text'` 是显式类型位，比任何推断都稳。
- **D3 改序列化而不是改前端判定**：`parent_chunk_id` 是分块的真实结构信息，接口本来就该吐；
  前端绕过它去猜（比如用 `chunk_index` 相邻性推断）只会更脆。`?? null` 而不是 `undefined`：
  JSON 里 `undefined` 键会被丢掉，显式 `null` 让"没有父块"和"字段不存在"能区分开。

验证：

- UI 验收脚本 `tests/e2e/kb-p1-ui.mjs` 的「分块视图区分父块与子块」由 ❌ 转 ✅：
  `共 19 块 · 父块 6 · 子块 12`（12 = 13 个子块里去掉 1 个不属于任何父块的首块），
  与库里 `parent_chunk_id` 非空行数一致。
  截图 `docs/test_report/2026-10-16-weknora-full-replica/screenshots/03-kb-chunks-parent-child.png`。
- 既有单测 `tests/units/kb-parent-child-e2e.test.ts` 保持通过（它测的是库层语义，未改动）。

## 7. 处理卡住的状态

不适用。

## 8. 经验沉淀 / 预防

- **"后端做完了" ≠ "用户用得到"。** 本次三个缺陷里有两个（D1、D2）纯粹是界面没接上，
  代码可运行、单测全绿、接口能跑通，但整条用户路径是断的。复刻类需求尤其容易这样：
  后端按上游一比一实现了，前端只做了"能看见数据"的部分。
  验收用例必须**从界面出发写**（"我要在界面上勾选并看到结果"），不能从接口出发写。
- **单测走接口 = 天然绕开前两个缺陷。** `kb-parent-child-e2e.test.ts` 直接
  `fd.set('parent_child','true')`，等于替用户把界面缺失的那一步手工补齐了。
  写接口测试时值得问一句：**这个参数在真实界面上能不能被设成这个值？**
- **本次三个缺陷是串行暴露的** —— 修好前一个，才看得见后一个。所以"跑一次 UI 验收、
  失败一项、修一项、再跑"这个循环不能省，一次性看完所有缺陷是不现实的。
  每轮都留了截图与读数（`父块 6 · 子块 0` → `父块 6 · 子块 12`），这也是缺陷确实被消掉的证据。
- **顺手纠正一个容易误判的点**：短文档看不到「父块」不是缺陷。`src/kb/chunker.ts` 的上游语义是
  「父块只在**真的分裂**时才建行」（子块数 > 1，或首个子块内容 ≠ 父块内容）。拿一份几百字的
  短文测父子分块，测的是空气。验收脚本因此改成**生成一份足够长的文档**
  （每节十余条 filler，确保父块 4096 字能被切出多个 384 字子块）。
