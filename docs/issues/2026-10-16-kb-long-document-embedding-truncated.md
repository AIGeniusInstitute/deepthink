# 长文档尾部内容永远检索不到（嵌入截断）

- 日期：2026-10-16
- 分支：`worktree-feat-knowledge-base`
- 影响版本：知识库子系统开发前的 `src/embedding.ts`
- 状态：已修复，并在 UI 验收中回归通过

## 1. 用户现象

把一份一万多字的中文运维文档上传到知识库，问文档最后一节里写的内容，知识库答"没有找到相关内容"；把同样的问题改成问文档开头的内容，就能答上来。用户的感觉是"文档后半截像是没被导入"。

换一个更直观的验证方式：在文档最末尾写一句唯一标记（本仓库用 `ZEBRAFISH_SENTINEL_9X`），然后用这个标记去搜——搜不到，而开头任意一句话都搜得到。

## 2. 问题描述

知识库在"入库"阶段会把整篇文档文本送去做向量化，再把向量存进 `kb_documents` 的向量列。这一步对送入的文本长度做了静默截断，超出部分既不报错也不记录，只是**根本没有被向量化**。于是任何只出现在截断点之后的内容，在语义检索里等于不存在。

关键词检索那条路仍然是全文的，所以表现会变成：同一个词，用关键词搜能得到结果，用向量搜得不到。混合检索因为融合了关键词臂，有时又能搜到——这让问题更难被当成 bug 报出来。

## 3. 根因

代码层面，`src/embedding.ts`：

```ts
// 修复前
const MAX_EMBED_TEXT_CHARS = 8000;

export async function embedText(text: string): Promise<number[]> {
  const truncated = text.slice(0, MAX_EMBED_TEXT_CHARS);
  ...
}
```

`text.slice(0, 8000)` 按 **UTF-16 code unit** 截断，中文一个字算 1，一篇一万三千字的文档会有约 4800 字从未进入任何向量。

设计层面，这里混了两个不同的东西：**"一次嵌入调用能送多少 token"** 是模型/接口的限制，**"一篇文档有多长"** 是内容的事实。前者应该用"切分 + 多次调用 + 多向量存储"来解决，而不是用一次 `slice` 把后者悄悄丢掉。截断是唯一没有把信息保留下来的处理方式：落盘的向量与原文之间不再有可验证的对应关系。

外部依据：OpenAI 的 embeddings 接口对单次 `input` 有 8192 token 上限，官方做法是把长文本切成语义块分别嵌入（[OpenAI Embeddings guide](https://platform.openai.com/docs/guides/embeddings/limitations)）。WeKnora 的实现同样是先切分再嵌入。

## 4. 复现路径

1. 建一个知识库；
2. 上传一份长度 > 8000 字符的文本（本仓库测试夹具：`docs/test_report/2026-10-16-weknora-knowledge-base/fixtures/deepthink-ops.md`，12825 字符，末尾一节含 `ZEBRAFISH_SENTINEL_9X`，该标记位于偏移 12769）；
3. 在检索测试台里选「向量」模式，查询 `ZEBRAFISH_SENTINEL_9X`；
4. 修复前：0 命中；修复后：该标记所在分块以 `[12759, 12825)` 排在第一位。

用命令行复现（需先登录拿 cookie）：

```bash
curl -s -b cookies.txt -X POST http://127.0.0.1:9899/api/paas/knowledge-bases/$KB/search \
  -H 'Content-Type: application/json' \
  -d '{"query":"ZEBRAFISH_SENTINEL_9X","mode":"vector","limit":3,"debug":true}'
```

## 5. 诊断方法

判断一个"答不上来"是检索问题还是生成问题，先看检索这一层：

```bash
# 分块切到哪了、每块在原文中的字符区间是什么
curl -s -b cookies.txt "http://127.0.0.1:9899/api/paas/knowledge-bases/documents/$DOC/chunks?full=1"

# 打开 debug，看向量臂和关键词臂各自召回了几条
curl -s -b cookies.txt -X POST http://127.0.0.1:9899/api/paas/knowledge-bases/$KB/search \
  -H 'Content-Type: application/json' \
  -d '{"query":"...","mode":"vector","debug":true}' | jq .debug
```

`debug.effective_mode` 与 `debug.vector_candidates` / `debug.keyword_candidates` 能直接区分"这条内容没进索引"和"进了索引但没排上来"。

## 6. 修复方案

不再对整篇文档做一次截断式嵌入，而是引入分块层：文档先按策略切成带偏移量的分块，**每个分块单独嵌入并单独存储向量**，检索在分块粒度上做。这样单次嵌入调用的输入天然被 `chunkSize`（默认 512）限住，既符合接口限制，又不存在"哪一段被丢掉"的问题。

关键改动：

```diff
- const MAX_EMBED_TEXT_CHARS = 8000;
- const truncated = text.slice(0, MAX_EMBED_TEXT_CHARS);
+ // 每块单独嵌入；块大小由 chunkConfig.chunkSize 决定（默认 512，远低于接口上限）
+ for (const chunk of chunks) {
+   const vector = await embedText(chunk.content);
+   saveKbChunkEmbedding(chunk.id, vector, dim);
+ }
```

选型理由：分块是唯一能同时满足三件事的做法——(1) 单次嵌入输入不超限；(2) 原文的每一段都有向量；(3) 检索命中的是**可回源核验的字符区间**，而不是"某个大概的位置"。这也是 WeKnora 与本仓库 `src/kb/chunker.ts` 保持一致的地方。

回归测试：`tests/units/kb-ingest-search.test.ts` 用 `TAIL_MARKER` 断言 `text.indexOf(TAIL_MARKER) > 8000` 且该标记仍可被检索；UI 验收另用 12825 字符的夹具复现同一场景。

## 7. 处理卡住的状态

不适用。截断是静态行为，不存在"卡住"的运行态；受影响的历史文档在修复后需要通过「重建索引」重新分块与嵌入：

```
POST /api/paas/knowledge-bases/:id/rebuild-index
```

该接口会重新分块所有文档并补齐缺失的向量，`dimension_changed` 为真时说明向量维度变了，所有文档都要重新嵌入。

## 8. 经验沉淀 / 预防

- **静默截断是最难发现的一类数据丢失**：不报错、不留痕、不改变接口契约。凡是"把用户输入裁掉一部分再处理"的地方，都应该要么记录被裁掉多少，要么换成能完整保留的处理方式。项目里其余 `slice(0, N)` 建议做一次巡检。
- **用哨兵文本做端到端回归**：在测试夹具的**最尾部**放一个唯一标记，断言它能被检索到。这比断言"检索返回了 N 条结果"强得多——后者在内容被截断时照样能通过（开头的内容还在，照样能返回 N 条）。
- **单测全绿不等于链路正确**：分块、融合、流水线各自的单测当时都是绿的，但"上传一份长文档后尾部能被检索到"这个用户可见的行为是错的。跨层的验收必须有一条端到端用例兜住。
- **巡检建议**：对 `MAX_*_CHARS`、`slice(0,`、`substring(0,` 这类常量做一次全仓扫描，逐个确认是"接口硬限制"还是"顺手截断"。
