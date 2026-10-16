# 分块的偏移量与内容对不上，引用无法回源核验

- 日期：2026-10-16
- 分支：`worktree-feat-knowledge-base`
- 影响版本：`src/kb/chunker.ts` `packSegments`（本次知识库子系统开发中引入，在同一轮开发内发现并修复）
- 状态：已修复

## 1. 用户现象

分块页每个分块都标着它在原文中的字符区间，例如 `#1 [58, 208)`。点「回源核验」，把这段区间从原文里取出来和分块内容比对——**两段文字看起来一样，但长度对不上**：分块内容 512 字，按区间取回来是 546 字。

更具体的表现：区间取回来的文本里段落之间有空行、有换行，分块内容里这些换行**全都没有**，整段挤成一片。引用标注的 `[58, 208)` 指向的原文，和用户点开看到的、以及模型据此作答的，不是同一段字符。

## 2. 问题描述

分块器先按分隔符把正文切成若干"片段"，再把片段攒够 `chunkSize` 就吐一个块。吐块的时候，块内容是把攒下来的片段**用空字符串拼起来**的；而块的 `startAt` / `endAt` 记的是第一个片段的起点和最后一个片段的终点。

片段不包含它们之间的分隔符（空行、换行），拼接时这些字符就消失了。于是：

```
原文区间 [startAt, endAt) 长度 546
分块 content 长度          512   ← 差的 34 个字符正是被丢掉的分隔符
```

差量不固定，取决于这一块跨了几个段落。

## 3. 根因

代码层面，`src/kb/chunker.ts` 的 `flush()`（修复前）：

```ts
chunks.push({
  index: chunks.length,
  content: pieces.map((p) => p.text).join(''), // ← 丢掉片段之间的分隔符
  headingPath: headingOf(startAt),
  startAt,
  endAt,
});
```

设计层面，这里把"分块内容"当成了**片段的拼接结果**，而把偏移量当成了**在原文中的位置**。这两者在片段不覆盖全文时会分叉。而知识库这个功能的整个价值主张就建立在"引用可核验"上：用户能拿 `[startAt, endAt)` 回到原文，验证这句话确实出自那里。一旦 `text.slice(startAt, endAt) !== content`，引用就只是两个看起来精确、实际无意义的数字——比"不标偏移量"更糟，因为它提供了虚假的确定性。

正确的不变式只有一条：

```
text.slice(chunk.startAt, chunk.endAt) === chunk.content
```

## 4. 复现路径

1. 建知识库，上传一份**段落之间有明确空行**的 Markdown（夹具 `deepthink-ops.md`）；
2. 进「分块」页，任选一个跨了多个段落的分块（例如 `#1 [58, 208)`）；
3. 点「回源核验」；
4. 修复前：回源文本与分块内容长度不一致，末尾经常少一个换行、中间少若干空行；
5. 修复后：显示「与原文一致 ✓」。

命令行版本（一次核对全部 82 块）：

```bash
CH=$(curl -s -b cookies.txt "http://127.0.0.1:9899/api/paas/knowledge-bases/documents/$DOC/chunks?full=1")
echo "$CH" | jq -r '.chunks[] | "\(.start_at) \(.end_at)"' | while read s e; do
  SRC=$(curl -s -b cookies.txt "http://127.0.0.1:9899/api/paas/knowledge-bases/documents/$DOC/content?start=$s&end=$e" | jq -r .content)
  echo "$SRC" | wc -c
done
```

## 5. 诊断方法

最短的诊断：拿一个分块，把 `content` 长度和 `end_at - start_at` 并排打出来。

```bash
curl -s -b cookies.txt "http://127.0.0.1:9899/api/paas/knowledge-bases/documents/$DOC/chunks?full=1" \
  | jq -r '.chunks[] | "\(.chunk_index) contentLen=\(.content|length) spanLen=\(.end_at - .start_at)"'
```

任何一行两个数不相等，就说明偏移量和内容已经分叉了。修复前的输出：

```
0 contentLen=22  spanLen=22
1 contentLen=512 spanLen=546   ← 分叉
2 contentLen=512 spanLen=559   ← 分叉
```

再看一眼长度差在哪：

```bash
curl -s -b cookies.txt "http://127.0.0.1:9899/api/paas/knowledge-bases/documents/$DOC/content?start=58&end=208" \
  | jq -r .content | cat -A | head -20   # cat -A 把换行显示成 $
```

回源文本里有 `$`（换行），分块内容里没有——差异就在这。

## 6. 修复方案

不改偏移量的计算方式（它本来就是对的），改内容的取法：**内容就是从原文里按偏移量切出来的那一刀**，而不是拼出来的。

```diff
- function packSegments(pieces, config, headingOf) {
+ function packSegments(pieces, config, headingOf, source) {
   ...
   const flush = () => {
     chunks.push({
       index: chunks.length,
-      content: pieces.map((p) => p.text).join(''),
+      // content 取 source.slice(startAt, endAt) 而不是拼接 pieces：
+      // pieces 不含片段之间的分隔符，拼接会静默丢掉这些字符，让分块的文本
+      // 与它自己的偏移量对不上——而这正是让引用无法核验的原因。
+      content: source.slice(startAt, endAt),
       headingPath: headingOf(startAt),
       startAt,
       endAt,
     });
   };
 }
```

三处调用点同步传入原文：`chunkByHeading` → `packSegments(pieces, config, () => sec.trail, text)`、`chunkByHeuristic` / `chunkByRecursive` → `packSegments(pieces, config, () => null, text)`。

选型理由：另一种修法是"让 pieces 保留分隔符"，但那要求每个分块策略在切分时就精确记账哪个分隔符归属于哪一段，任何一处遗漏都会重新引入同一个 bug。直接从原文切一刀则**在构造上就不可能违反不变式**——不管上游怎么切分，内容永远等于它自己的偏移量所指的字符串。用约束代替约定。

回归测试：`tests/units/kb-ingest-search.test.ts`

```ts
for (const ch of chunks) {
  expect(text.slice(ch.start_at, ch.end_at)).toBe(ch.content);
}
```

## 7. 处理卡住的状态

不适用。这是入库时的一次性计算，没有运行态需要救活。**已入库的旧数据需要重建索引**才会带上修正后的内容：

```
POST /api/paas/knowledge-bases/:id/rebuild-index
```

## 8. 经验沉淀 / 预防

- **找到这个 bug 的是集成测试，不是单元测试**。当时分块器的单测全绿——因为它的测试夹具里，一个分块内部恰好没有段落分隔符，`join('')` 和 `slice()` 结果相同。夹具"太干净"会让一个有缺陷的不变式看起来成立。**测试夹具必须包含会让被测不变式失败的那种输入**（这里是段落间的空行）。
- **不变式要写成断言，而不是写成注释**。`content === text.slice(startAt, endAt)` 是一句可以一行代码验证的话，就应该有一行代码在验证它。
- **用约束代替约定**：当"内容"和"位置"是两个可以各自演化的值时，优先让其中一个由另一个推导出来，而不是维护两者的一致性。
- **同类风险点**：任何"把切碎的东西重新拼起来，同时记录它在原文中的位置"的地方，都有同一个坑（高亮、diff、摘要、编辑器）。巡检建议：grep `\.join('')`，看它附近是否有 `startAt` / `offset` / `index` 之类的定位字段。
