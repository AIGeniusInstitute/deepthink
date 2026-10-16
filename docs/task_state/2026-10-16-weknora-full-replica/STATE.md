# 执行状态 — WeKnora 知识库整体复刻（第二轮）

> PRD：`docs/prd/2026-10-16-weknora-full-replica/PRD.md`
> 技术方案：`docs/tech_solution/2026-10-16-weknora-full-replica/SOLUTION.md`
> 分支：`worktree-feat-kb-full-replica`（worktree：`~/deepthink/.claude/worktrees/feat-kb-full-replica`）

---

## 0. 总览

| 期 | 内容 | 状态 |
|---|---|---|
| **P1** | 知识库内核补全：父子分块 / FAQ 索引 / 预生成问题 / 查询改写 / 意图识别 | ✅ **已完成**：5/5 子项 + UI 验收 18/18 + test_report + 合并（含上线实例上报的 1 个修复） |
| P2 | 文档接入扩展（xlsx/pptx、图片、整目录上传） | 未启动 |
| P3 | 检索增强（rerank 深化、Wiki、GraphRAG） | 未启动 |
| P4 | Agent 协作（fork/rewind、artifacts、steering） | 未启动 |
| P5 | 平台化（SSO、多租户、Langfuse、小程序、扩展） | 未启动 |

**P1 已完成**：UI 验收 18/18 通过（截图见 `docs/test_report/2026-10-16-weknora-full-replica/screenshots/`），
全量回归 174 文件 / 2386 条通过，5 个缺陷已按 issue 工作流修复并沉淀，
报告见 `docs/test_report/2026-10-16-weknora-full-replica/TEST_REPORT.md`。P2–P5 未启动。

---

## 1. P1 子项进度

| 子项 | 方案章节 | 状态 | 提交 |
|---|---|---|---|
| 父子分块（parent-child） | §2.1 | ✅ 已实现并验证 | `87038ee`（分块器层）+ `4911658`（落库层） |
| 查询改写 / 扩展 | §2.4 | ✅ 已实现并验证 | `bcc904d` |
| 查询理解（改写 + 意图） | §2.5 | ✅ 已实现并验证 | 见 §2.6 |
| FAQ 索引 | §2.2 | ✅ 已实现并验证 | 见 §2.7 |
| 预生成问题（Doc2Query） | §2.3 | ✅ 已实现并验证 | 见 §2.8 |

前置已完成：`21d3880` 知识库 URL 入库 SSRF 修复（PRD §2.9，属 issue 线，非本需求）。

---

## 2. 已完成：父子分块 §2.1

### 2.1 交付内容

**分块器层（`87038ee`）**
- `src/kb/chunker.ts`：新增 `ChunkType`、`chunkParentChild()`、`mergeBreadcrumbs()`、`DEFAULT_PARENT_CONFIG` / `DEFAULT_CHILD_CONFIG`
- `Chunk` 新增 `chunkType` / `parentIndex`，默认值使既有 2 个消费者行为不变
- overlap 上限对齐 WeKnora `ensureDefaults`：`> chunkSize/2` → 截到 `chunkSize/2`（原为 `>= chunkSize` → `chunkSize/4`）
- `tests/units/kb-parent-child.test.ts` 13 条

**落库层（`4911658`）**
- `src/db.ts`：`kb_chunks.parent_chunk_id` 列（`ensureColumn` 迁移）；`replaceChunksForDocument` 支持 `chunkType`/`parentIndex`；兄弟链只在普通块之间建立；`listUnembeddedChunks(ForDocument)` 过滤掉 `parent_text`
- `src/kb/pipeline.ts`：`IngestOptions.parentChild`，开启后走 `chunkParentChild`
- `src/routes/paas-knowledge-bases.ts`：上传与 reparse 接受 `parent_child` 表单标记
- `tests/units/kb-parent-child-e2e.test.ts` 7 条
- `tests/units/kb-parent-chunk-id-migration.test.ts` 2 条

### 2.2 实测数据（非推断）

对 e2e 夹具 `longDoc(14, bodyRepeat)` 直接调分块器实测（`recommendStrategy` 判定为 `heading`）：

| 夹具 | 源文本长度 | 总块数 | 父块 | 子块 | 扁平分块数 | 不变式 |
|---|---|---|---|---|---|---|
| `bodyRepeat=150` | 6693 | **42** | **14** | **28** | 14 | ✅ 全块成立 |
| `bodyRepeat=40` | 2073 | 14 | **0** | 14 | 14 | ✅ 全块成立 |

第二行是 WeKnora 语义 2 的直接体现：`heading` 策略按标题边界切分，section 小于子块尺寸 384 时父块 content 等于唯一子块 content，`真分裂` 不成立 → 不建父行。**这不是 bug，是照做的语义**，已由独立用例锁定。

### 2.3 验收标准对照（P1 中仅 §2.1 部分）

| # | 标准 | 结果 |
|---|---|---|
| AC-1 | 不变式 `text.slice(startAt,endAt) === content` | ✅ 单测 + e2e 逐块断言 |
| AC-2 | 父块 `chunk_type='parent_text'` 且不进向量索引 | ✅ e2e：不在 `listUnembeddedChunksForDocument` 候选集（且已断言候选集非空）+ 不在 `kb_chunks_vec` |
| AC-3 | 未真分裂时不产生父行 | ✅ e2e：短文档 / 小 section 两条用例 |
| AC-4 | 子块可经 `parent_chunk_id` 回溯父行 | ✅ e2e：回指存在、类型为 `parent_text`、同 doc、区间落在父块内 |
| AC-5 | 面包屑进 embedding 文本但不进 content | ✅ 单测 |
| AC-6 | FAQ 库不建关键词索引 | ⬜ 子项未实现 |
| AC-7 | 查询扩展最多 5 条、最短 3 字符 | ⬜ 子项未实现 |
| AC-8 | 既有 KB 测试不回归 | ✅ 全量回归通过 |

---

## 2.5 已完成：查询改写 / 扩展 §2.4

### 交付内容

- `src/kb/query-expansion.ts`（新增，纯函数：无 DB / 网络 / 配置读取）
  `expandQueries()` 四条规则，`extractKeywords` / `extractPhrases` / `splitByDelimiters` / `removeQuestionWords`
- `src/kb/search.ts` 触发块：召回不足（`hits.length < limit`）且非 vector 模式时，跑变体的**关键词臂**检索并去重追加，位置在 rerank **之前**
- `src/kb/rag.ts`：`RagRequest.enableQueryExpansion` + `resolveQueryExpansion()`（请求级覆盖 rag.json 默认，默认关）
- `src/routes/paas-knowledge-bases.ts`：`/search`、`/search/all`、`/chat` 三处接受 `enable_query_expansion`
- 测试：`tests/units/kb-query-expansion.test.ts`（17 条）+ `tests/units/kb-query-expansion-search.test.ts`（8 条）

### 源码核对（逐行读过上游，纠正了侦察摘要）

侦察摘要有几处不准，已按源码更正：触发条件是**首位结果计数**而非分数（`search.go:141`）；`DisableKeywordsMatch` 为真时**一条检索都不发**；变体来源是 `RewriteQuery` 且 `seen` 同时预置原查询；并发是 `min(16, jobs)`；开关默认**关**（Go bool 零值）。已写入 SOLUTION.md §2.4.1。

### 六条显式偏离（全部写进模块头注释 + 一条断言差异的测试）

最大的一条：**本模块不做 jieba 分词**。WeKnora 的中文关键词变体依赖 jieba 词切分；本仓库关键词臂是 FTS5 trigram（`db.ts` 的 `KB_CHUNK_FTS_TOKENIZER`），刻意没有分词器。故汉字按**字**切分，把 jieba+停用词表的效果改在字符级实现（成立原因：上游中文停用词全是单字）。可观测效果同类，但变体字符串不同。

由此引出的第 3 条偏离值得单独记：**若沿用上游的 `len(keywords) >= 2` 门槛，纯中文查询会一条变体都产不出**（无分词器时中文塌成单个 run）。这不是字符串差异而是能力丢失，故门槛放宽为「≥2 个关键词，或单个关键词且已与原查询不同」。

其余：长度门槛按 rune 而非 Go 的 byte（中文一字 3 字节，上游门槛对中文实际宽松约 3 倍）；引号字符类补上被上游弄丢的智能引号（hexdump 证 0x22/0x27 各出现两次）；同步而非并发（better-sqlite3 是同步的）；无关键词阈值可缩放。

### 验证

- 配对负向对照：同一查询开扩展 → 有命中且 `expansion_added > 0`；关扩展 → 恰好 0 命中。证明命中确实来自扩展。
- 前置条件用例先钉死「原始查询首轮召回为 0、变体是文档子串」，否则上面的用例会平凡通过。
- **负向验证**：把触发条件改成 `false &&` 后，恰好那 2 条断言"扩展真的发生了"的用例失败，其余 6 条照过 → 用例非平凡。改动已还原并 `diff` 确认字节一致。

---

## 2.6 已完成：查询理解（改写 + 意图识别）§2.5

### 交付内容

- `src/kb/query-understand.ts`（新增）
  纯函数层：`normalizeQueryIntent` / `needsKbRetrieval` / `needsRetrieval` / `parseQueryUnderstanding` / `formatConversationHistory` / `intentSystemPrompt` / 提示词常量
  调用层：`understandQuery()` —— 一次 chat 调用同时产出改写与意图
- `src/kb/rag.ts`：`retrieveForQuestion` 先跑理解；意图不需要检索时**直接返回 `retrievalSkipped`，不发检索也不发作答**（这是本功能的全部意义）；`buildMessages` 接受意图专属 system 提示词；`answerQuestion` / `answerQuestionStream` 在"跳过检索"时不再回落到兜底文案
- `src/routes/paas-knowledge-bases.ts`：`/chat` 接受 `enable_query_understanding`、`language`
- 测试：`tests/units/kb-query-understand.test.ts`（26 条）+ `tests/units/kb-query-understand-rag.test.ts`（9 条）

### 方案更正（初稿写错了两处关键事实）

| 初稿 | 源码事实 |
|---|---|
| 7 类意图 | **9 类**——漏了 `kb_search` 与 `clarification`，而这两个正是唯二会触发检索的 |
| "意图识别"与"查询改写"是两件事 | 上游**同一次 LLM 调用**同时产出两者；改写的 `RewriteQuery` 正是 §2.4 扩展的输入 |
| "web_search 走 web 检索" | web 检索未开启时该意图**直接不检索**，改用"网络搜索不可用"提示词作答 |

已按源码更正 SOLUTION.md §2.5，并补上第 4 条要点：**未知标签归为空意图（= 要检索）**。上游注释点名了历史事故——把标签原样取用会让任何意外值变成"不检索"，于是答案在既没查库、也没报错的情况下生成出来。这条已单独写用例锁定。

### 四条显式偏离

1. **没有图片路径**（最大的一条）。上游跑三种输入组合，有图时切视觉模型、maxTokens 提到 2048 做 OCR，提示词里有一整个 Task 3。本仓库知识库问答链路不收附件，整条去掉。`image_only` / `doc_only` 仍留在意图表里（提示词禁止模型在无附件时选它们），但本仓库没有任何路径能产出这两个值。
2. **截断字段一律丢弃**。上游抢救 `image_description` 的半截文本；没有图片描述可救，半截的改写会把用户完整的问题换掉。
3. **独立超时 30s**（上游用模型服务默认值）。150 token 的调用挂住会把整个回合卡在检索开始之前。
4. **模型复用 RAG 对话模型**。上游有单独的 `rewriteModel`；为 150 token 的调用再引一套凭据存储不划算。

另有一处**品牌替换**（非行为偏离但需讲明）：上游提示词开头是 "You are WeKnora, ... developed by Tencent"，本实现写作 DeepThink。已写成断言（断言的是**差异**，不是相同）。

### 承重不变式

**查询理解任何一步失败都返回 null，调用方行为与没有这个模块时逐字节一致。** 未配置模型 / `disabled` / 空问题 / 非 200 / 超时 / 抛异常 / 输出无法解析——全部退回"用原问题、正常检索"。理解是优化，不是闸门。9 条集成用例里有 5 条专测这些失败路径。

### 验证

- 核心命题有断言守着：问候语**不得**被答以「知识库中没有找到与该问题相关的内容」。测试同时断言 `fallback === false`、答案正文、以及用的是问候语专属 system 提示词而非 RAG 提示词。
- 反面对照：`kb_search` 意图 + 无命中 → 仍是兜底文案，且**不再调用作答模型**（只发了理解那一次调用）。防止"跳过检索"被写成"什么都跳过"。
- **负向验证**：把跳过检索的分支改成 `false &&` 后，恰好那 3 条断言"跳过了检索"的用例失败，其余 6 条照过 → 用例非平凡。改动已还原（grep 注入的 `false &&` 返回 0 行）。
- 流式路径单独覆盖：SSE 链路的"跳过检索不回落到兜底"有独立用例。

## 2.7 已完成：FAQ 索引 §2.2

### 交付内容

| 文件 | 变更 |
|---|---|
| `src/kb/faq.ts` | **新增**。纯函数，零依赖（只 import `node:crypto`），故可被 `db.ts` 反向引用而不成环 |
| `src/db.ts` | KB 行加 `type` / `faq_config`；chunk 行加 `metadata`；新增 FAQ 段（建/改/查/删/变体向量/分桶） |
| `src/kb/search.ts` | KB 分桶；关键词臂只收文档桶；负向问题事后否决；变体向量并入向量臂后按 chunk 归并 |
| `src/embedding.ts` | 抽 `chunkIndexTexts` / `embedChunkRows`，FAQ 走 `buildFaqIndexTexts`，变体落新表 |
| `src/routes/paas-knowledge-bases.ts` | KB 建/改支持 `type` + `faq_config`；5 个 FAQ 条目路由；文件上传对 FAQ 库返回 422 |
| `src/schemas.ts` / `src/types.ts` | zod schema 与类型对齐（snake_case 一路到底，路由边界不做字段翻译） |

### 方案更正（初稿与源码不符 4 处）

| 初稿 | 源码 | 影响 |
|---|---|---|
| 字段 `kb_type` | `type` | 命名 |
| metadata `answer` | `answers`（复数） | 命名 |
| metadata `revision` | `version` | 命名 |
| "负向问题过滤"位置含糊，读起来像是在索引期 | **检索后**过滤，且刻意不调 `NormalizeQuestion` | 语义：带标点的提问不会被误杀 |

另外补上一条初稿没写的关键事实：**FAQ 库无关键词索引这件事，上游不是靠"检索器里按类型过滤"，而是靠建参数时把 KB 分桶**（`knowledgebase_search.go:456-461`）。这决定了落点——如果照初稿理解去写一个"按类型过滤"的分支，行为看着一样，但检索器内部多了一条上游没有的分支。

### 承重不变式（用测试锁死，不靠读代码）

1. **FAQ 库不进关键词臂**。集成测试用同一份文本两头对照：FAQ 库 `mode:'keyword'` 召回 0，文档库同样的词召得回——单看结果 0 分不清"正确排除"和"召回坏了"，加对照组才分得清。
2. **负向问题是事后精确否决**。A/B 两组用**同一个必然命中的查询向量**，唯一差异是查询文本：不等于负例 → 保留；等于 → 丢掉且 `faq_negative_filtered` 计数 +1。

### 三条显式偏离（写进 `src/kb/faq.ts` 头注释）

1. 不做繁转简（上游内嵌 ~40KB OpenCC 词典）。后果有界：仅繁体输入的指纹不同；简体输入逐字节一致。
2. 首尾标点字符集照抄上游字节、**不补弯引号**——与 §2.4 短语类的补救方向相反，理由写在注释里（匹配字符类缺字符丢召回；trim 集合多留一个字符无害；指纹函数该匹配字节而非意图）。
3. `answer_strategy:'random'` 携带但不生效，与上游一致（上游存了这个字段却从不读）。

### 验证

- `npx tsc --noEmit -p tsconfig.json` → 干净。
- `npx vitest run tests/units/kb-faq.test.ts tests/units/kb-faq-search.test.ts` → **58 passed**（37 纯函数 + 21 集成）。
- 全部 KB 单测 → **191 passed**（回归证明 §2.2 对 search/embedding 的改动没伤到既有行为）。
- **负向验证 ×2**：① 把关键词臂改成收 FAQ 桶 → 恰好只有"FAQ 库关键词召回为 0"1 条失败；② 把负向过滤短路成 `if (true) return true` → 恰好 2 条负向用例失败。两次改完 `diff` 证明**字节级还原**。

### 过程中被测试抓到的问题（我的，不是代码的）

写集成测试时先写完断言再跑：4 条向量检索用例失败，根因是**测试自己**的顺序——前面那条"更新会去重"的用例调了 `PUT`，而 `PUT` 会清掉条目的旧向量（旧向量对应旧文本，留着就是错的召回），后续用例却直接拿它当已嵌入的夹具。修法是补一条用例显式锁定"更新即失效、重新嵌入后才可检索"，顺带把这条语义变成了断言。

---

## 2.8 已完成：预生成问题 Doc2Query §2.3

### 交付内容

**纯逻辑 `src/kb/doc2query.ts`**（无 DB、无网络）
配置夹取/序列化、输出解析、`SourceID` 规则、提示词渲染、合格性判定、时效判定。

**编排 `src/kb/question-gen.ts`**
`generateQuestionsForKb(kbId, model)`：读 KB 配置 → 按 20 分批 → 逐块调 LLM → 失败只跳过该块 →
生成前后比对 `content_revision` → 写 metadata → 批量嵌入 → 写 `generated_question` 向量。
另导出 `dropGeneratedQuestionVectors`。

**`src/db.ts`**
`kb_chunk_variant_vectors` 加 `source` 列进主键（含未发布表形态的 drop/recreate 迁移）；
`kb_chunks.content_revision`、`knowledge_bases.question_generation_config` 两个 `ensureColumn`；
`updateKbChunkContent` 自增 revision 并清该块的预生成问题向量；`deleteKbChunk` 与
`replaceChunksForDocument` 清对应变体行；`vectorSearchFaqVariants` → `vectorSearchChunkVariants(..., source)`；
新增 `patchChunkMetadata` / `setChunkGeneratedQuestions` / `getChunkGeneratedQuestions` /
`listChunksNeedingQuestions` / `getSiblingChunkContents` / `updateKnowledgeBaseQuestionGenerationConfig`。

**`src/kb/search.ts`**：向量臂在去重前并入 `faq_variant` 与 `generated_question` 两类额外条目。

**`src/embedding.ts`**：`clearChunkVariantVectors(chunk.id)` → `clearChunkVectorsBySource(chunk.id, 'faq_variant')`
（见下"回归点"）。

**`src/routes/paas-knowledge-bases.ts`**：`questionGenerationConfig` 回显；创建/更新接受该配置
（PATCH 是部分更新）；`POST /:id/generate-questions`；分块序列化带 `generated_questions` 与
`content_revision`（直接读行上的 metadata，避免每个分块回查一次库）。

**前端**：`web/src/stores/knowledge-bases.ts`（类型 + `updateQuestionGenConfig` + `generateQuestions`）、
`web/src/components/knowledge-base/KbDoc2QueryPanel.tsx`（开关 / 每块问题数 / 业务指令 / 生成按钮）、
`KbChunkViewer` 每个分块列出已生成的问题、`KnowledgeBaseDetailPage` 文档页签挂载面板。

### 自查中发现并修掉的两个真 bug（都是我引入的）

| # | 问题 | 后果 | 修法 |
|---|---|---|---|
| 1 | `clearChunkVariantVectors` 清**全部来源**，而 `embedding.ts` 在 FAQ 索引模式翻回 combined 时调它 | **重新嵌入一次文档库就会把预生成问题向量全抹掉** —— 功能静默失效，不报错 | 改成 `clearChunkVectorsBySource(..., 'faq_variant')` |
| 2 | `makeQuestionId` 用 `Date.now() * 1e6` 做 double 加法 | 纳秒时间戳 1.7e18 超出 `Number.MAX_SAFE_INTEGER`，`+1` 被吞，同批前 256 条问题 id 完全相同 | 改用 `BigInt`；`buildGeneratedQuestionsMetadata` 默认值同步改 |

另有两处文档与代码不符，按"改字面不改行为"处理（`listChunksNeedingQuestions` 的注释声称会筛
未嵌入分块，SQL 并没有——上游也不看单块嵌入状态，改注释）。

### 验证证据

- `npx vitest run tests/units/kb-doc2query.test.ts tests/units/kb-doc2query-flow.test.ts` → **53 passed**（36 + 17）。
- 全部 KB 单测 → **244 passed**（14 文件）。
- 全量回归见 §4。
- **负向验证 ×3**（每次 `diff` 证明字节级还原）：

| 被破坏的分支 | 挂掉的用例数 |
|---|---|
| 去掉检索里的 `generated_question` 合并 | 2 |
| 单块失败 `continue` → `return` | 1 |
| 去掉 `content_revision` 过期判定 | 1 |

### ⚠️ 召回测试第一版是**平凡成立**的（已重写）

第一版写成"单个分块的 KB，搜到了就算问题进了索引"。做负向验证时发现：**把检索里的
`generated_question` 合并整行删掉，用例照样全绿**——因为那个 KB 里只有这一个分块，普通向量臂
必然返回它，命中和问题索引没有任何关系。

重写为：用一个**自身没有向量**的分块（入库时嵌入服务返回 503，分块落库但 `embedding` 为空——
这是上游允许的真实状态，生成问题的合格判定只看 KB 有没有配嵌入模型），此时可检索路径**只剩
问题索引一条**；再加一条"命中得分是问题向量相似度 ≈ 1"的直接证据。重写后同样的破坏会让 2 条
用例挂掉。

**教训**：单元素语料上的"检索到了"不构成证据。凡是"命中即证明"的用例，先做一次负向验证确认
它**真的会挂**，否则等于没测。

---

## 3. 过程中的缺陷与修复

### 3.1 迁移顺序 bug（我引入，已修复）

**现象**：`super-agent-team-trace.test.ts` 抛 `SqliteError: no such column: parent_chunk_id` at `initDatabase`。

**根因**：把 `CREATE INDEX ... ON kb_chunks(parent_chunk_id)` 写进了固定 schema 的 `db.exec` 块，而该块在 `ensureColumn()` 迁移**之前**执行。`CREATE TABLE IF NOT EXISTS` 对既有表是空操作、不会补列 → 既有库启动即崩。

**为什么差点漏掉**：全新临时库的测试全绿（`CREATE TABLE` 会带出新列）。**只有用持久化 DB 文件的测试才暴露**。已排除"与本次改动无关的抖动"这一可能——隔离复现确认是本改动引入。

**修复**：索引移到 `ensureColumn('kb_chunks','parent_chunk_id','TEXT')` 之后。

**负向验证**：把索引挪回建表块，`kb-parent-chunk-id-migration.test.ts` 确实失败（`expected [Function] to not throw ... SqliteError: no such column: parent_c…`）。证明该用例不是摆设。

**沉淀**：已写入 SOLUTION.md §2.1.4「加列时的迁移顺序护栏」，对以后每次加列都成立。

### 3.2 我自己的断言写弱了（已加固）

e2e 中「父块不在向量表」最初是**平凡成立**的——测试环境没配 embedding provider，向量表本来就是空的，子块也不在里面。已补：
1. `expect(candidates.length).toBeGreaterThan(0)` 作为非平凡前提；
2. 改为断言父块不在 `listUnembeddedChunksForDocument` 候选集（这才是"父块不参与 embedding"的实际机制，不依赖是否配了 provider）；
3. 保留对 `kb_chunks_vec` 的直查，防绕过候选集的其它写入路径。

### 3.3 `{{conversation}}` 占位符未替换（我引入，严重，已被测试抓到）

**现象**：断言 `body.messages[0].content` 含会话历史的用例失败，实际拿到的是**未替换的模板原文** `... {{conversation}} ...`。

**根因**：改写提示词里有**两个**占位符——`{{language}}` 和 `{{conversation}}`。我只替换了前者，把历史当成 user 消息附加。结果是**会话历史根本没有到达模型**。

**为什么严重**：这个功能的全部价值就是让改写能解析指代。"它和传统搜索有什么区别"这种问题，没有历史就无从改写——不是降级，是这个功能等于不存在。而且它**不会报错**：模型收到一个带字面量 `{{conversation}}` 的提示词，照样会吐出一段看起来合理的 JSON，意图与改写都"正常"返回，只是改写质量退化成单轮。属于静默失效。

**修复**：改为 `.replace('{{conversation}}', formatConversationHistory(history))`；顺带删掉我自己加的、算了却没用上的死代码 `const conversation = ...`，并简化了 `buildRewriteUserPrompt` 的签名（去掉它不再需要的 history 参数）。

**为什么差点漏掉**：我最初的断言只检查了 `system` 里是否替换了 `{{language}}`，没检查另一个占位符。**抓到这个 bug 的不是代码审查，是一条写具体了的断言**——它断言了内容里应当出现的具体会话原文。

### 3.4 我的测试期望写错了 2 处（代码是对的）

| 用例 | 我的期望 | 实际 | 判定 |
|---|---|---|---|
| `extractKeywords('他和我在北京')` | `['北京']` | `['他我北京']` | **期望错**。上游停用词表里没有代词；我按"常识"以为会有 |
| `expandQueries('什么是向量数据库')` | `['向量数据库']` | `['什么向量数据库','向量数据库']` | **期望错**。什么不在停用词表里，是规则 4 单独处理的 |

两处都是**照着自己的直觉写期望、而不是照着源码写期望**，代码反而是忠实的。已按源码修正期望，并加注释说明为什么长这样。这类失败不能当"代码 bug"直接改代码——那会把忠实的复刻改歪。

### 3.5 夹具问题（非代码缺陷）

初次 e2e 出现 0 个父行、14 个块。经排查是**夹具问题不是代码缺陷**：section 太小触发语义 2。已把 `bodyRepeat` 提到 150，并为「不建冗余父行」单独写了用例——把这个行为**升级为显式断言**，而不是靠调夹具绕过。

---

## 4. 验证证据

```
npx tsc --noEmit -p tsconfig.json       → 通过（无 error 行）
npx tsc --noEmit -p web/tsconfig.json   → 通过（无 error 行）
cd web && npx vite build                → ✓ built in 11.55s
npx vitest run                          → Test Files  173 passed | 1 failed | 4 skipped (178)
                                          Tests  2384 passed | 1 failed | 16 skipped (2401)
                                          （唯一失败项是 §4 末尾那个既存偶发超时，见下）
```

历次基线：§2.1 交付 166 文件 / 2214 测试 → §2.4 交付 168 / 2239（+2 文件、+25 条）→ §2.5 交付 170 / 2274（+2 文件、+35 条）→ §2.2 交付 **172+4 / 2348**（+2 文件、+58 条）→ §2.3 交付 **173 / 2401**（+2 文件、+53 条）。每一步都是全量回归，不是只跑新用例。

**一个既存的偶发失败（不是本次引入，未修）**：`tests/feishu-card.test.ts` 的
`buildInteractiveCard delegates to buildAgentReplyCard without default header` 是动态 import，
默认 5s 超时，满负载并行跑时约 4 次里挂 1 次。**证据**：在 §2.2 之前那个 commit（`93df1ba`）上开
独立 worktree 连跑 4 次，第 4 次复现同一条、同样 5007ms；§2.2 分支上连跑 3 次，同样只挂 1 次。
两边同一速率 → 与 §2.2 无关。§2.3 交付时再次复现同一条，**单独跑该文件连跑 3 次全绿（94/94 ×3）**，
只在全量并行负载下偶发 → 确认是动态 import 争用，与本次改动无关。按"只清理自己弄脏的地方"不动它。

**UI 验收（已补，2026-10-16）**：

```
DT_BASE=http://localhost:9911 DT_USER=admin DT_PASS='******' DT_DATA_DIR=$HOME/.deepthink-9911 \
  node tests/e2e/kb-p1-ui.mjs
→ 合计 18 项，通过 18，失败 0
→ npx vitest run → Test Files 174 passed | 4 skipped (178)
                     Tests 2386 passed | 16 skipped (2402)
```

- ✅ Playwright UI 验收（父子分块 / FAQ 条目 / Doc2Query / 查询理解三处界面）
- ✅ test_report 及用例通过截图（9 张，`docs/test_report/2026-10-16-weknora-full-replica/screenshots/`）
- ✅ 合并 worktree → main 并 push

UI 验收过程中发现 5 个缺陷，全部走 issue 工作流修复（详见 §3.6）。

---

## 3.6 UI 验收发现的 5 个缺陷（2026-10-16）

**4 个单测全绿也照样漏** —— 都在"数据对、链路对"之后的那一公里。

| # | issue | 现象 | 根因层 | 修复 |
|---|---|---|---|---|
| D1 | `2026-10-16-start-prod-serves-desktop-web-dist.md` | 编译成功但页面不变 | 基础设施 | `_start-direct` 钉死 `DEEPTHINK_WEB_DIST_DIR` |
| D2 | `2026-10-16-stop-prod-watchdog-resurrects-instance.md` | 停止/启动都报成功但都不真 | 基础设施 | `stop-prod` 给看门狗发 TERM；启动判据比对 pid |
| D3 | `2026-10-16-kb-parent-child-invisible-end-to-end.md` | 父子分块勾不上、看不到、只有父块 | 前端入口 + 呈现 + 接口字段 | 三处各补一处 |
| D4 | `2026-10-16-faq-entry-not-indexed-on-create.md` | FAQ 条目永远"待向量化" | 后端漏调用索引 | POST/PUT 内联 `indexFaqEntry` |
| D5 | `2026-10-16-faq-index-mode-select-reverts.md` | 索引方式下拉弹回旧值 | 前端漏回写 store | `updateFaqConfig` 回写 `list` |

**D1/D2 是验证基础设施的缺陷**，最危险：D1 让"改的代码"根本没被服务，D2 让"启动成功"是假的
（服务的是上一轮进程）——两者都会让后续**所有**验证结论失效。D2 修复前正是"命令说成功、
实际服务旧进程"，比直接失败更贵。

**D3 是三个缺陷串行暴露的**：上传参数没接 → 补上开关仍看不到标记 → 补上标记后只有父块 →
才发现接口漏吐 `parent_chunk_id`。一次性看完所有缺陷不现实，每轮都留了读数
（`父块 6 · 子块 0` → `父块 6 · 子块 12`）。

**D4/D5 同界面、同现象、不同根因**（一个后端没存、一个前端没显示）。issue 文档末尾附了对照表：
先查服务端真值就能一步区分。

**D4 的修复改了一条既存断言的语义**（不是回归）：`PUT` 后立刻重建向量，于是"PUT 会把 embedding
置空"不再成立。已把该用例拆成两条——一条锁路由行为，一条锁 db 层机制
（"改了内容却留旧向量"这条静默错误召回路径仍然被断言锁住）。

---

## 5. 未决 / 已知缺口（显式登记，不声称已解决）

| # | 项 | 状态 |
|---|---|---|
| 1 | 父块 overlap 取 0 是**设计判断而非复刻**（WeKnora 未实证） | 已在方案 §2.1.2 标注，留回调点 |
| 2 | `protectedPatterns` 只做围栏代码块 + 表格块，LaTeX/链接推迟 P2 | 主动裁剪，已记录依据 |
| 3 | 同类 SSRF 路径仍有 2 处未修：`container/agent-runner/src/mcp-tools.ts:2809`（`redirect: 'follow'`）、`container/agent-runner/src/web-search.ts:355`（自定义 baseUrl） | 已登记 PRD §2.9，**未修** |
| 4 | `GET /api/paas/marketplace/:id` 不按 `status` 过滤，登录用户持 id 可读 `pending` 条目 | 已报告，**未改动**，等用户决策 |
| 5 | 查询理解的开关**默认关**（对齐上游 `conversation.enable_rewrite`）。即复刻完成 ≠ 默认生效，需在 rag.json 或请求里显式打开 | 设计对齐，已记录 |
| 6 | `image_only` / `doc_only` 两个意图**本仓库永远产不出**（不收附件），仅存在于意图表与提示词中 | 偏离 1 的直接后果，已在方案标注 |
| 7 | FAQ 的 `separate` 模式变体向量走**精确线性扫描**，没有 ANN 索引 | 性能取舍非召回取舍，量级上来要重建索引 |
| 8 | FAQ 库的 `doc_count` 会把内部那个 FAQ 容器文档算进去（对用户显示成"有 1 个文档"） | 未处理，等 UI 阶段一起看 |
| 9 | 上游 FAQ 专用入口那条 **0.7 相似度阈值**未单独实现（当前走通用检索链路） | 未实现，需确认是否影响 FAQ 召回质量 |
| 10 | `tests/feishu-card.test.ts` 有 1 条偶发超时（约 4 次挂 1 次），**已证明与本次改动无关**（父 commit 同样复现） | 既存问题，按"不动别人弄脏的地方"未修，见 §4 |
| 11 | Doc2Query 生成的问题**只进向量索引，不进关键词索引**（上游两边都进） | 有意取舍，召回只增不减，见方案 §2.3.2 偏离 4 |
| 12 | 问题的向量也走**精确线性扫描**（与 7 同因，共用一张表） | 同 7，量级上来要重建索引 |
| 13 | 生成是**同步接口**且**不记进度**：几百个分块时请求会一直挂着，中途刷新页面无法查询进度 | 单进程无任务队列的必然结果；分块数上来需要改异步 + 轮询 |
| 14 | KB 级 chat 模型取全局 `rag.json` 的 `model`（上游用 `kb.SummaryModelID` 按库指定） | 本仓库没有按库配模型的存储，未实现 |
| 15 | 切换「索引方式」（`question_answer`↔`question_only`、`combined`↔`separate`）会一次性作废全库向量，**没有重建入口**（toast 仍提示"需重新向量化"） | D4 只修了"新建/编辑即索引"，改配置这条路径仍无 UI 入口，同因同源，**未修** |
| 16 | `make status` 未校验监听 pid 与 pidfile 是否一致、未在看门狗计数 > 1 时告警 | D2 的建议项，超出本次修复范围，**未改** |
| 17 | `src/web.ts` 未在启动日志里打印实际的静态资源根目录 | D1 的建议项，下次同类问题可一眼看出，**未改** |
| 18 | 上传按钮的 `<Button>` 未带 `type="button"`（全仓库其余按钮同样如此）。当前无 `<form>` 包裹所以无害，被放进 `<form>` 会退化成提交按钮 | 既存写法，不在 D6 因果链上，**未顺手改** |

---

## 6. 下一步

1. ✅ P1 已完成：5 个子项实现（§2.1 / §2.2 / §2.3 / §2.4 / §2.5）+ Playwright UI 验收 18/18
   + 5 篇 issue + test_report（含 9 张通过截图）+ 合并 worktree → main。
2. P2–P5 未启动。启动 P2 前建议先处置 §5 里的 15（索引方式切换无重建入口）——
   它是目前唯一一个"UI 上明确提示了动作、但用户无路可走"的缺口。
