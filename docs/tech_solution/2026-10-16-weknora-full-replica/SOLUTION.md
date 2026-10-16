# 技术方案 — WeKnora 知识库系统整体复刻（第二轮）

> 配套 PRD：`docs/prd/2026-10-16-weknora-full-replica/PRD.md`
> 本文按分期推进，**只详述当前实施的 P1**；P2–P5 在各自启动时补入，不做预测性设计（Simplicity First）。

---

## 1. 分期与依赖

| 期 | 内容 | 依赖 | 状态 |
|---|---|---|---|
| P1 | 知识库内核补全：父子分块、FAQ 索引、预生成问题、查询改写、意图识别 | 无 | **本方案详述** |
| P2 | 文档接入扩展：xlsx/pptx、图片、整目录上传 | P1（分块器） | 待启动 |
| P3 | 检索增强：rerank 深化、Wiki、GraphRAG | P1 | 待启动 |
| P4 | Agent 协作：fork/rewind、artifacts、steering | 无 | 待启动 |
| P5 | 平台化：SSO、多租户、Langfuse、小程序、扩展 | P1–P4 | 待启动 |

**前置已交付**：`21d3880` 知识库 URL 入库 SSRF 修复（PRD §2.9）。

---

## 2. P1 设计

### 2.1 父子分块（parent-child）

#### 2.1.1 WeKnora 语义对照

复刻的是 `internal/infrastructure/chunker/strategy.go` 的 `SplitParentChild` / `splitParentChild`。**实测确认的三条语义，与直觉不同，必须照做**：

| # | WeKnora 语义 | 出处 | 若不照做的后果 |
|---|---|---|---|
| 1 | 父块 `ChunkType = "parent_text"`，**不参与 embedding** | `knowledge_process.go:549` | 父块进向量索引，召回质量被大块稀释 |
| 2 | 父行**仅在"真分裂"时创建**：`len(subs) > 1 \|\| subs[0].Content != parent.Content`；否则 `parentIndex = -1` | `strategy.go:splitParentChild` | 每个父块都建行 → 大量父子内容重复的冗余行 |
| 3 | 子块 embedding 文本 = `ContextHeader + "\n\n" + Content`（`EmbeddingContent()`），而 `Content` 本身**不含**面包屑 | `splitter.go` | 面包屑被写进 content，破坏 `slice(startAt,endAt)===content` 不变式 |

**最后一条是本方案的关键约束**：v1 已建立的核心不变式是 `text.slice(chunk.startAt, chunk.endAt) === chunk.content`。WeKnora 把面包屑并入 embedding 文本、但不并入 content——本方案沿用同一处理：**面包屑存在 `headingPath` 字段（即 WeKnora 的 `ContextHeader`），embedding 时拼接，content 保持是源文本的精确切片**。

#### 2.1.2 参数

| 参数 | 值 | 来源 |
|---|---|---|
| `ParentChunkSize` | 4096 | WeKnora `ChunkingConfig` |
| `ChildChunkSize` | 384 | WeKnora `ChunkingConfig` |
| 子块 overlap | `childSize / 5` = 76（取整） | `DeriveParentChildConfigs` |
| 父块 overlap | **0** | ⚠️ 见下 |
| overlap 上限 | `chunkSize / 2` | `ensureDefaults` |

> ⚠️ **父块 overlap 是一个未获实证的取值。** 侦察未在 WeKnora 中确认父块 overlap 的派生规则（只确认了子块为 `childSize/5`）。本方案取 **0**，理由是：父块之间的 overlap 会让同一段文本出现在两个父块中，进而各自派生出内容重叠的子块，产生**跨父块的重复子块**——这与语义 2「避免冗余行」的意图相悖。这是一个**设计判断而非复刻**，已在代码注释中显式标注。若后续实测 WeKnora 父块非 0，此处需回调。

#### 2.1.3 算法

```
chunkParentChild(text, { parentCfg, childCfg }) -> Chunk[]

1. parents = chunkText(text, parentCfg)          // 复用既有三种策略
2. for each parent p:
     subs = chunkText(p.content, childCfg)       // 在父块**区间内**再切
     子块偏移平移回全文坐标: sub.startAt += p.startAt
     真分裂 = subs.length > 1 || subs[0].content !== p.content
     if 真分裂:
        emit { chunkType: 'parent_text', content: p.content, startAt, endAt, parentIndex: -1 }
        parentIdx = <该父行的下标>
     else:
        parentIdx = -1
     for each sub:
        emit { chunkType: 'text', content: sub.content, parentIndex: parentIdx,
               headingPath: mergeBreadcrumbs(p.headingPath, sub.headingPath) }
3. 重排 index（0..n-1），并把 parentIndex 落到最终下标
```

**`mergeBreadcrumbs(parent, child)`**：照搬 `strategy.go:mergeBreadcrumbs` 语义——子块已有面包屑则与父块合并，并**丢掉子块首行与父块重复的那条**；子块无面包屑则直接继承父块。

#### 2.1.4 数据模型

**不需要建表**。`kb_chunks` 已具备所需列（v1 已建）：

| 列 | 用途 |
|---|---|
| `chunk_type` | 已存在但恒为 `'text'` → 本方案首次写入 `'parent_text'` |
| `parent_chunk_id` | 子块回指父行（WeKnora 同名字段） |
| `pre_chunk_id` / `next_chunk_id` | 兄弟链，已存在但 v1 从未填充 |

**改动**：`Chunk` 接口新增两个字段，`chunkText` 默认填 `chunkType: 'text'` / `parentIndex: -1`，既有两个消费者（`kb/pipeline.ts:177`、`routes/paas-knowledge-bases.ts:266`）行为不变。

**⚠️ 加列时的迁移顺序护栏（本轮实际踩到过）**

`kb_chunks` 没有 `parent_chunk_id` 列，需要新增。加列本身简单，但**索引语句的位置**会让既有库启动即崩：

- `CREATE TABLE IF NOT EXISTS kb_chunks (...)` 对既有库是**空操作**——它不会补列。
- 固定 schema 块在 `ensureColumn()` 迁移**之前**执行。
- 因此把 `CREATE INDEX ... ON kb_chunks(parent_chunk_id)` 写进建表块，既有库执行到这一句时列还不存在 → `SqliteError: no such column` → **initDatabase 崩溃，服务起不来**。

**规则**：新增列的索引一律建在对应的 `ensureColumn()` 之后，不要放在建表块里。建表块里只放那些**从建表第一天就存在**的列的索引。

这个 bug 只在用**持久化 DB 文件**的测试里暴露；全新临时库的测试全部通过（因为 CREATE TABLE 会带出新列）。回归测试 `tests/units/kb-parent-chunk-id-migration.test.ts` 手工造了一个缺列的旧库来锁住这条路径，并已验证：把索引挪回建表块后该测试确实失败。

#### 2.1.5 护栏（`protectedPatterns`）

WeKnora 保护 LaTeX `$...$`、markdown 链接/图片、表格块、围栏代码、行内代码不被切分。**P1 只实现围栏代码块与表格块**——这两者被切断会直接破坏可读性；LaTeX/链接的收益低而正则风险高，推迟到 P2 评估。

> 这是**对清单的主动裁剪**，不是遗漏。裁剪依据：Simplicity First——先解决"切断会导致内容损坏"的类别。

---

### 2.2 FAQ 索引

> 本节初稿是按印象写的，与源码有四处不符（字段名 `kb_type`→`type`、`answer`→`answers`、
> `revision`→`version`，以及负向过滤的位置）。以下为逐行核对后的版本，
> 更正过程记在 `docs/task_state/.../STATE.md` §2.7。

**复用 `kb_chunks`，不建新表**（WeKnora 同样如此）。KB 行新增 `type`（`document` | `faq` | `wiki`，
默认 `document`）与 `faq_config`（JSON）。

#### 2.2.1 源码事实

| # | 事实 | 出处 |
|---|---|---|
| 1 | KB 类型字段是 `type`，不是 `kb_type` | `internal/types/knowledgebase.go` |
| 2 | 配置是 `faq_config` JSON `{index_mode, question_index_mode}`；后端 `EnsureDefaults` 给 `question_answer` + `combined` | `knowledgebase.go:783-795` |
| 3 | ⚠️ Vue 编辑器给的是**另一套**默认：`question_only` + `separate` | `web/src/views/knowledge/...` |
| 4 | 条目 = `kb_chunks` 行，`chunk_type='faq'`；业务字段在 `metadata` | `knowledge_faq.go` |
| 5 | metadata 键名：`standard_question` / `similar_questions` / `negative_questions` / **`answers`（复数）** / `answer_strategy` / **`version`** / `source` | `internal/types/faq.go` |
| 6 | **两份不同的"内容"**：`buildFAQChunkContent`（给人看，带 `Q:` / `Similar Questions:` / `Answers:` 前缀）≠ `buildFAQIndexContent`（给向量看，裸 `\n` 连接） | `knowledge_faq.go:1618` / `:1875` |
| 7 | `combined` = 1 条向量；`separate` = 1 + N 条（标准问 + 每个相似问各一条，`SourceID` 加后缀） | `buildFAQIndexInfoList:1892` |
| 8 | **FAQ 库没有关键词索引**——上游不是靠"检索器里按类型过滤"，而是靠建参数时把 KB 分成 `faqVectorKBIDs` / `docKeywordKBIDs` 两个桶 | `knowledgebase_search.go:456-461` |
| 9 | 负向问题**不进索引、不进 content**；命中之后才按 `lower(trim(x)) == lower(trim(neg))` **精确相等**否决，且**刻意不调 `NormalizeQuestion`**（标点参与比较） | `knowledge_faq.go` |
| 10 | `answer_strategy: 'random'` 存得下，但上游**从不读取**它——永远返回全部答案 | 同上 |

#### 2.2.2 四条显式偏离

1. **不做繁转简。** 上游 `NormalizeQuestion` 内嵌 ~40KB OpenCC 词典做繁→简。不 vendor。
   后果有界：仅繁体输入的内容指纹与上游不同（一条繁体条目和它的简体孪生条目不会互相判重）；
   **简体输入逐字节一致**。
2. **首尾标点字符集照抄上游字节，不补弯引号。** 上游 `strings.Trim` 的集合里 ASCII `"` 出现三次、
   **没有**任何弯引号（`""''`）——与 §2.4 短语类里同一处作者意图丢失。这里刻意选**相反**的补救：
   字符类里缺字符是真丢召回，而 trim 集合里多留一个弯引号只是没被去掉；指纹函数应当匹配字节而非意图。
3. **`answer_strategy: 'random'` 原样携带但不生效**，与上游行为一致（见事实 10）。不"顺手修好"。
4. **`separate` 的变体向量另存一张表**（见 2.2.3），上游是同一索引里多条 `SourceID`。

#### 2.2.3 落点与承重不变式

- **`kb_chunk_variant_vectors(chunk_id, variant_index, embedding, ...)`**：下标 0（标准问）仍写
  `kb_chunks.embedding`，1..N 写变体表。这样 `embedding IS NULL` 继续表示"尚未嵌入"，
  向量索引与去重逻辑都不用改。
- **检索分桶是"FAQ 不进关键词臂"的唯一机制**：`partitionKbIdsByType` 把 kbIds 拆桶后，
  关键词臂只收 `buckets.doc`。检索器内部**没有**任何按类型过滤的代码——所以这条必须在集成测试里
  端到端证明，靠读代码分不出"实现了"与"看起来实现了"。
- **负向否决是事后过滤**，位置在 `slice(0,limit)` 之后、扩展/重排之前，计数进
  `SearchDebug.faq_negative_filtered`；metadata 解析失败**保留**命中（宁可多召回不可静默丢）。
- **⚠️ 偏移量不变式在 FAQ 上不成立**：`text.slice(startAt, endAt) === content` 只对
  `chunk_type ∈ {text, parent_text}` 成立。FAQ 的 content 是合成的（`Q: … / Answers: …`），
  不是任何文档的子串；故 FAQ 行写 `start_at=0`、`end_at=content.length`，读者必须直接用
  `chunk.content`，不能去切容器文档。已在 `src/db.ts` 的 FAQ 段头注明。
- **已知缺口**：变体向量走精确线性扫描而非 ANN（性能取舍，不是召回取舍）；
  `doc_count` 会把 FAQ 的容器文档算进去；上游 FAQ 专用入口那条 0.7 阈值未单独实现。

#### 2.2.4 验收证据

`tests/units/kb-faq.test.ts` 37 项（纯函数）+ `tests/units/kb-faq-search.test.ts` 21 项（接进检索链路）。
两条承重命题各做过一次**反向验证**：把关键词臂改成收 FAQ 桶 → 只有"FAQ 库关键词召回为 0"挂；
把负向过滤短路成 `if (true) return true` → 只有两条负向用例挂；两次改完都 `diff` 证明字节级还原。

### 2.3 预生成问题（Doc2Query）

- **在文档处理阶段**生成，不是检索期。
- 参数：`questionCount` 默认 3、**上限 10**；temperature 0.7；maxTokens 512。
- 生成结果写入 chunk 元数据 `generated_questions`，并**以合成 source_id（截断 64 字符，超长取 hash）作为独立检索条目入索引**。
- 解析：按行、trim 前导 `0-9.-*) `、丢弃长度 < 5 的行。

### 2.4 查询改写 / 扩展

**纯本地，无 LLM**（WeKnora `query_expansion.go` 如此）。四类扩展：

1. 去停用词后的关键词变体
2. 引号短语
3. 按分隔符切分取最长段（> 5 字符）
4. 去疑问词

参数：触发条件 `命中数 < max(1, EmbeddingTopK)`；最多 5 条；最短 3 字符；并发上限 16；扩展查询**只搜关键词**（`DisableVectorMatch: true`）。

#### 2.4.1 源码核对结果（本轮逐行读过 `query_expansion.go` + `search.go:141` + 其自测）

侦察阶段给的摘要有几处不准，以源码为准：

| # | 事实 | 出处 |
|---|---|---|
| 1 | 触发条件是 `EnableQueryExpansion && len(SearchResult) < max(1, EmbeddingTopK)`，是**首位结果计数**不是分数 | `search.go:141` |
| 2 | `DisableKeywordsMatch` 为真时**直接返回 nil**，一条检索都不发 | `query_expansion.go:27-32` |
| 3 | 变体来源是 `RewriteQuery`（无改写时 = 用户原查询），且 `seen` 同时预置 `RewriteQuery` 和 `Query` 的小写 | `query_expansion.go:126,133-136` |
| 4 | 并发是 `capSem = min(16, jobs)`，job 数 = 变体数 × 检索目标数 | `query_expansion.go:48-56` |
| 5 | 非 0 但有界的默认值：`expTopK = max(EmbeddingTopK*2, RerankTopK*2)`、`expKwTh = KeywordThreshold*0.8` | `query_expansion.go:41-42` |
| 6 | 开关来自 `conversation.enable_query_expansion`，Go bool 零值 → **默认关** | `config.go:147` |

#### 2.4.2 六条显式偏离（不是疏漏，全部写进模块头注释）

本模块**不做 jieba 分词**——这是最大的一条，单独说明，其余五条列在后面。

**偏离 1：无分词器。** WeKnora 的 `tokenize()` 把汉字串交给 `types.Jieba.CutForSearch`，`extractKeywords` 返回的是 jieba **词**（"如何配置向量数据库" → 配置/向量/数据库）。本仓库没有分词器、也不打算引入：关键词臂用的是 FTS5 **trigram** 分词器（`db.ts` 的 `KB_CHUNK_FTS_TOKENIZER`），本就不需要词边界；`chunker.ts:11` 也已写明"中文一字约等于一 token"的既有立场。

所以汉字串按索引分词的方式切——按字——并把 jieba+停用词表做到的事改在**字符级**做。这成立的原因是：WeKnora 停用词表里的中文项**全是单字**（的/是/在/了/和/与/或）。可观测效果同类——变体 = 查询减去虚词——但变体**字符串**与 WeKnora 不同，因此照搬 `query_expansion_test.go` 里断言 jieba 词的用例（如 网易/大厦）在本实现下不成立。这条已写成一条**断言差异**的测试，避免偏离随时间腐烂。

**偏离 3（规则 1 的门槛）**：上游用 `len(keywords) >= 2` 把关键词变体卡住，jieba 很容易满足。无分词器时一条中文查询会塌成**单个** run，该门槛会让整个规则对中文失效——"向量数据库的索引参数配置"会一条变体都产不出。这不是字符串差异而是**能力丢失**。故门槛放宽为：≥2 个关键词，**或**单个关键词且已与原查询不同（虚词确实被去掉了；等于原查询的单关键词不算改写）。

**偏离 2（长度门槛按 rune 而非 byte）**：上游写 `len(s) < 3` / `len(m[1]) > 2` / `len(seg) > 5`，Go 的 `len()` 对 string 是**字节**。中文一字 3 字节，所以这些门槛对中文实际比数字看起来宽松约 3 倍（单个汉字就能过"3"这道闸）。字节长度是 Go 字符串下标的副产物而非设计取值，故按 rune 计——即显然的意图。副作用：对中文输入比 WeKnora **更严**。

**偏离 4（引号字符类）**：上游字符类是 `["'"'「」『』]`；hexdump 后 0x22/0x27 各出现**两次**，即作者显然想写的智能引号 U+201C/U+201D/U+2018/U+2019 被 ASCII 引号吃掉了。本实现保留 ASCII 那一对**并补上**智能引号，两种引法都取得到。

**偏离 5（顺序而非并发）**：上游把「变体 × 检索目标」扇出到 goroutine、上限 `min(16, jobs)`。本仓库的 `keywordSearchChunks` 是同步的（better-sqlite3），且一次收全部 kbId，所以每个变体只有一个 job、无可重叠。上限值仍写进 debug 载荷以对齐观测，但不做任何调度。

**偏离 6（无关键词阈值）**：上游为扩展命中考量 `expKwTh = KeywordThreshold * 0.8`。本仓库关键词臂不做任何阈值过滤（bm25 没有绝对尺度），没有可缩放的阈值；扩展命中也同样豁免 `minScore`，理由与此前关键词臂的注释一致。

#### 2.4.3 落点

`src/kb/query-expansion.ts`（纯函数，无 DB/网络/配置读取）+ `searchChunks` 内的触发块（在 rerank **之前**，让扩宽后的候选集能被重排）。开关：请求级 `enable_query_expansion` 覆盖 `rag.json` 的 `enableQueryExpansion`，两者都缺省为关。

### 2.5 查询理解（改写 + 意图识别）

> ⚠️ **本节的初稿有错，已按源码更正。** 初稿写"7 类意图"，实际是 **9 类**（漏了 `kb_search` 与 `clarification`，而这两个恰恰是**唯二**会触发检索的）。初稿还把"意图识别"与"查询改写"当成两件事——上游是**同一次 LLM 调用**同时产出两者，且改写的产物 `RewriteQuery` 正是 §2.4 扩展的输入。下游影响也写错了：不是"web_search 走 web 检索"，而是 web 检索未开启时该意图**直接不检索**。

#### 2.5.1 源码事实

| # | 事实 | 出处 |
|---|---|---|
| 1 | 9 类：`kb_search` `web_search` `greeting` `chitchat` `follow_up` `image_only` `doc_only` `summarize` `clarification` | `chat_manage.go:94-104` |
| 2 | **只有 `kb_search`、`clarification` 和空意图需要查库**；空意图按"要检索"处理（安全侧） | `NeedsKBRetrieval()` `chat_manage.go:110-116` |
| 3 | `web_search` 是否检索取决于 `WebSearchEnabled` 开关；关时改用"网络搜索不可用"提示词回答 | `NeedsRetrieval()` `:230-235` |
| 4 | 未知标签 → **空意图**（= 要检索）。注释点名了历史事故：原样取用标签会让任何意外值变成"不检索"，答案在既没查库也没报错的情况下生成 | `NormalizeQueryIntent` `:238-252` |
| 5 | 一次调用同时产出改写与意图；maxTokens 150（有图 2048）、temperature 0.3、Thinking false | `query_understand.go:110-136` |
| 6 | 解析三层：严格 JSON → 取首个 `{` 到末个 `}` → 截断抢救正则 `"([a-z_]+)"\s*:\s*"((?:[^"\\]|\\.)*)("?)` | `:380-470` |
| 7 | 字段别名：`rewrite_query`/`rewritten_query`/`query`/`question` | `parseStructuredQueryOutputJSON` |
| 8 | **不检索时换 system 提示词**（`intent_prompts.yaml`），否则问候语会被 RAG 提示词要求答"资料中没有相关信息" | `applyIntentPromptOverride` `:531` |
| 9 | 空改写回落到原查询（`RewriteQuery = Query`） | `:64` |

#### 2.5.2 四条显式偏离

**偏离 1（最大）：没有图片路径。** 上游跑三种输入组合（纯文本 / 文本+图 / 纯图），有图时切视觉模型、maxTokens 提到 2048 做 OCR 转写，提示词里有整个 Task 3。本仓库的知识库问答链路**不收附件**，所以整条图片路径去掉：Task 3 与 `image_description` 不请求也不解析。`<no_image_attached />` / `<no_document_attached />` 两个标记**保留**——它们正是上游"无附件"分支，也就是我们唯一会渲染的分支。

后果要讲清楚：`image_only` / `doc_only` 仍留在意图表和 `normalizeQueryIntent` 里（模型被提示词明确禁止在无附件时选它们），但本仓库没有任何路径能产出这两个值。

**偏离 2：截断字段一律丢弃。** 上游的抢救只对 `image_description` 保留被截断的半截文本；没有图片描述可救，被截断的字段就一律丢掉。半截的改写会把用户完整的问题换掉。

**偏离 3：独立超时 30s**（上游用模型服务默认值）。这是个 150 token 的调用，挂住会把整个回合卡在检索开始之前。

**偏离 4：模型 = RAG 的对话模型。** 上游有单独的 `rewriteModel`；本仓库 rag.json 只有一个对话模型，为 150 token 的调用再引入一套凭据存储不划算。

**另有一处品牌替换**（不是行为偏离但需要讲明）：上游每个意图提示词开头是 "You are WeKnora, ... developed by Tencent"，本实现写作 DeepThink。照搬会在 DeepThink 里出现腾讯的产品名。已写成断言。

#### 2.5.3 承重不变式

**任何失败路径都返回 null，调用方行为与没有这个模块时逐字节一致。** 未配置模型、非 200、超时、抛异常、输出无法解析——全部退回"用原问题、正常检索"。查询理解是优化，不是闸门。这条有独立测试组守着。

#### 2.5.4 落点

`src/kb/query-understand.ts`（纯函数 + 一次 LLM 调用）+ `rag.ts` 的 `retrieveForQuestion`（意图为不检索时直接返回 `retrievalSkipped`，不发检索）+ `buildMessages`（换成意图专属 system 提示词，且不再注入"参考资料"）。开关：请求级 `enable_query_understanding` 覆盖 `rag.json` 的 `enableQueryUnderstanding`，默认关（对齐 `conversation.enable_rewrite`）。

---

## 3. 验收标准（P1）

| # | 标准 | 验证方式 |
|---|---|---|
| AC-1 | 父子分块满足不变式 `text.slice(startAt,endAt) === content` | 单测：全文逐块断言 |
| AC-2 | 父块 `chunk_type='parent_text'` 且**不进向量索引** | 单测 + DB 查询 |
| AC-3 | 未发生真分裂时不产生父行 | 单测：短文档 → 无 `parent_text` 行 |
| AC-4 | 子块可通过 `parent_chunk_id` 回溯到父行 | 单测 + 端到端检索 |
| AC-5 | 面包屑进入 embedding 文本但**不进入 content** | 单测 |
| AC-6 | FAQ 库不建关键词索引 | 单测：FTS 表中无该库 chunk |
| AC-7 | 查询扩展最多 5 条、最短 3 字符 | 单测 |
| AC-9 | 扩展仅在召回不足时触发；关闭时同一查询召回应为 0 | 集成测试：开/关同一查询配对断言 |
| AC-10 | 扩展只走关键词臂，不重复向量臂 | 集成测试：命中 `source` 全为 `keyword` |
| AC-11 | 中文查询在无分词器下仍能产出变体 | 单测：纯中文无疑问词用例 |
| AC-8 | 既有 KB 测试全部不回归 | `npx vitest run tests/units/kb-*` |

---

## 4. 风险

| 风险 | 缓解 |
|---|---|
| 改 `Chunk` 接口影响既有消费者 | 新增字段带默认值，既有 2 个消费者行为不变；跑全量回归 |
| 父块 overlap 取值无实证 | 已在 §2.1.2 标注为设计判断而非复刻，留回调点 |
| `protectedPatterns` 裁剪可能不足 | 明确记录裁剪范围与依据，P2 评估补充 |
| P1 五件事一次做完风险高 | 按 2.1 → 2.4 → 2.5 → 2.2 → 2.3 顺序，每件带单测独立提交 |

---

## 5. 未决

- 父块 overlap 的 WeKnora 真实取值（需再查 `DeriveParentChildConfigs` 的父块分支）。
- `kb_type` 变更对既有库的迁移路径（默认 `document`，应为无痛）。
- 意图识别的 LLM 调用是否复用既有 provider 抽象（倾向复用，待查 `src/kb/rag.ts` 的调用路径）。
