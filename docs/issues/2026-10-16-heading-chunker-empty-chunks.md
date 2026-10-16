# 纯标题文档入库失败：heading 分块把整篇切成 0 块

- 日期：2026-10-16
- 影响范围：知识库所有文档入库路径；只要正文「只有标题、没有正文段落」就必现
- 严重级别：中高（文档 100% 入库失败，且失败原因指向"文档有问题"而不是"分块器有问题"）
- 引入时间：早于本次 P2 改动（main 上同样复现），属既有缺陷
- 触发面扩大：P2 新增的 xmind 解析器输出**天然就是这个形状**，于是从"边缘情况"变成"必然命中"

---

## 1. 用户现象

上传一份 `.xmind` 思维导图，列表里的文档状态直接变成 **失败**，没有分块、没有向量。
服务端日志只有一句：

```
KB ingestion failed
    stage: "chunk"
    message: "Chunking produced no chunks"
```

用户视角：文件本身能正常打开、内容也不空，上传却被告知"切不出分块" —— 既不知道
该改什么，也没有任何可操作的补救手段。

同一现象对**纯目录型 Markdown**（整篇由 `#`/`##` 标题组成、没有正文段落）同样成立，
只是那条路径不那么常见，所以一直没被撞上。

## 2. 问题描述

入库流水线的 chunk 阶段对解析出来的正文调用 `chunkText()`。当
`recommendStrategy()` 判定正文"标题密集"（前 20% 或前 2000 字符里出现 ≥3 个标题行）
时会选 `heading` 策略。

`chunkByHeading()` 把文本切成若干 section：**每个 section 是「一个标题行结束」到
「下一个标题行开始」之间的那段正文**（`src/kb/chunker.ts:218-231`）。随后
`src/kb/chunker.ts:238` 把正文为空白白的 section 整段跳过：

```ts
const seg: Seg = { text: text.slice(sec.start, sec.end), start: sec.start, end: sec.end };
if (seg.text.trim().length === 0) continue;   // ← 整篇只有标题时，每一段都被这里吃掉
```

一份"只有标题、没有正文"的文档，每个 section 的 body 都是换行符，于是全部被跳过，
`out` 为空数组。流水线在 `src/kb/pipeline.ts:195` 判定 `chunks.length === 0` 后
把文档标记为 failed。

## 3. 根因

**代码层面**：`chunkByHeading()` 的 section 定义把"标题行"排除在内容之外 ——
它假定标题只是**容器**，正文才是内容。这个假定对普通文档成立，对**大纲型文档**不成立：
在大纲/思维导图里，标题行本身就是全部信息（`### 年龄 18-75 岁` 就是那条知识）。

于是出现一个反直觉的结果：**文档里标题越多，越可能一个块都切不出来**。

`recommendStrategy()` 只是把这个必然性提前了 —— 它看到 ≥3 个标题就选 `heading`，
而那恰恰是唯一会丢光内容的策略（`heuristic` / `recursive` 对同一份文本都能正常产出）。

**为什么测试没拦住**：既有 chunker 用例（`tests/units/kb-chunker.test.ts`）里的
"heading 策略"样本都带正文段落，没有任何一条覆盖"标题行没有 body"的形状。

**外部依据**：
- 本仓库 `src/kb/chunker.ts:189-247`（section 构造与空白过滤）
- WeKnora 的 heading 分块同样以正文为切分单位，但它的解析器不产出纯标题文本，
  所以那边不会走到这条路径 —— 这是复刻时把解析面扩宽之后才暴露的差异

## 4. 复现路径

最快的一条（不需要 UI）：

```bash
cd ~/deepthink
cat > _probe.mts <<'TS'
import { chunkText, recommendStrategy } from './src/kb/chunker.js';
const outline = '# 项目设计\n\n# 研究设计\n## 入组标准\n### 年龄 18-75 岁\n';
console.log('策略 =', recommendStrategy(outline));
console.log('分块 =', chunkText(outline, { strategy: 'heading' } as never).length);
TS
npx tsx ./_probe.mts; rm -f ./_probe.mts
# 输出：策略 = heading / 分块 = 0     ← 缺陷
```

UI 路径：

1. 打开 `http://127.0.0.1:9922/login`（隔离实例），用 `admin / 88888888` 登录
2. 进入任意**文档库** → 「文档」页签 → 「上传文档」
3. 选 `tests/fixtures/office/design.xmind`（或任意纯目录型 `.md`）
4. 列表里该文档状态变为「失败」，服务端日志出现 `Chunking produced no chunks`

## 5. 诊断方法

```bash
# 1. 看文档失败在哪个阶段
grep -A 4 'KB ingestion failed' logs/deepthink-9922.log
#   stage: "chunk"  → 就是本 issue；stage: "parse" 则是解析器的问题，另一回事

# 2. 直接问分块器（§4 的探针）；想看内容长什么样就把它打出来
npx tsx ./_probe.mts

# 3. 确认策略是自动选出来的而不是显式配的
curl -s -b cookies.txt "http://127.0.0.1:9922/api/paas/knowledge-bases/<kbId>/documents" \
  | python3 -c "import json,sys;[print(d['filename'], d.get('parse_status'), d.get('error_message')) for d in json.load(sys.stdin)['documents']]"

# 4. 全仓扫「可能返回 0 块」的分支
grep -rn "produced no chunks" src/
```

## 6. 修复方案

在 `chunkByHeading()` 的返回处加一条**兜底**：正常路径一块都没产出、但确实存在标题行时，
退化成"以标题行为内容"来切。

```diff
   // Pack each section independently: a chunk must never straddle a heading
   // boundary, otherwise its headingPath would only describe part of it.
   const out: Chunk[] = [];
   for (const sec of sections) {
     ...
   }
+
+  // 兜底：整篇只有标题、没有正文时，上面的 body 全是空白，会被逐段跳过 ——
+  // 一个块都不剩。xmind 解析出来的就是这个形状（层级即内容），纯目录型
+  // Markdown 同理。丢掉标题等于把整篇文档丢空，所以这里退化成按标题行切。
+  if (out.length === 0 && marks.length > 0) {
+    const pieces: Seg[] = marks.map((mk) => ({
+      text: text.slice(mk.start, mk.end), start: mk.start, end: mk.end,
+    }));
+    return packSegments(pieces, config, trailAt, text);
+  }
   return out.map((c, i) => ({ ...c, index: i }));
```

**选型理由**：

- **为什么改分块器而不是改解析器**：让 xmind 解析器给每条标题补一个假段落
  （比如追加一行占位文字）能绕过这个现象，但那是把缺陷藏进解析结果里 ——
  用户看到的文档内容会被污染，而且纯目录型 Markdown 依旧会踩。问题在切分语义，就该在切分处修。
- **为什么不做成「按层级重组 section」**：那是更彻底的重写（把子标题的内容并入父标题），
  会改变**所有**标题型文档的切分结果，与 P2「未命中规则时行为与之前完全一致」的验收项冲突。
  兜底只在"原本产出 0 块"这一种输入上生效 —— 凡是以前能切出块的文档，
  切法**逐字节不变**，所以不存在回归面。
- **为什么用 `packSegments` 而不是直接 `text.split('\n')`**：`packSegments` 保留
  `startAt`/`endAt` 与源文的对应关系，引用回源（`getDocumentContent`）才不会指错位置；
  同时它按 `chunkSize` 打包，几千行的大纲不会变成一个超长块。

## 7. 处理卡住的状态

失败文档会停在 `parse_status = 'failed'`，**不会**卡在"解析中"。用户重新上传即可。

若列表里已经堆积了这类失败文档，不需要手工改库：修好后对每个文档点一次
「重新解析」（或对该库点「重建索引」）就会重新走一遍流水线。

## 8. 经验沉淀 / 预防

### 8.1 这类缺陷的通用特征

**把"常见形状"当成"唯一形状"**。`heading` 分块的 section 定义对"标题 + 正文"是完备的，
对"只有标题"是**空集** —— 而空集在调用方看来和"文档是空的"无法区分，于是错误信息
把责任推给了文档。判别式：**当某个纯函数的输出可以是空集时，要问"合法输入里有没有
天然映射到空集的形状"**，而不是只问"空输入会不会返回空"。

### 8.2 预防手段

1. **回归用例**：`tests/units/kb-chunker.test.ts` 增加"纯标题文档必须产出分块"，
   并断言不变量「非空文本 + 任何策略 → 至少 1 块」。这条不变量比具体样本更能挡住同类问题。
2. **把不变量提到调用方**：`src/kb/pipeline.ts` 在 `chunks.length === 0` 时已经会失败，
   但错误信息应当带上正文长度与命中的策略（`Chunking produced no chunks (len=110,
   strategy=heading)`），下次一眼就能看出是分块器还是解析器的问题。
3. **解析器新增格式时，用真实产物跑一遍完整入库**（不只是解析）：本次就是解析单测
   17 条全绿、入库却是失败的。P2 的 e2e（`tests/e2e/kb-p2-ingest.mjs`）已把
   "每种格式都要到 就绪" 作为断言，同类问题下次会在验收阶段而不是用户那里暴露。
