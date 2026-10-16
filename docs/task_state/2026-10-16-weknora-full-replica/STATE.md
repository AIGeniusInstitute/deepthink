# 执行状态 — WeKnora 知识库整体复刻（第二轮）

> PRD：`docs/prd/2026-10-16-weknora-full-replica/PRD.md`
> 技术方案：`docs/tech_solution/2026-10-16-weknora-full-replica/SOLUTION.md`
> 分支：`worktree-feat-kb-full-replica`（worktree：`~/deepthink/.claude/worktrees/feat-kb-full-replica`）

---

## 0. 总览

| 期 | 内容 | 状态 |
|---|---|---|
| **P1** | 知识库内核补全：父子分块 / FAQ 索引 / 预生成问题 / 查询改写 / 意图识别 | **进行中（3/5 子项完成）** |
| P2 | 文档接入扩展（xlsx/pptx、图片、整目录上传） | 未启动 |
| P3 | 检索增强（rerank 深化、Wiki、GraphRAG） | 未启动 |
| P4 | Agent 协作（fork/rewind、artifacts、steering） | 未启动 |
| P5 | 平台化（SSO、多租户、Langfuse、小程序、扩展） | 未启动 |

**P1 尚未完成**，不能进入 test_report / 合并阶段。

---

## 1. P1 子项进度

| 子项 | 方案章节 | 状态 | 提交 |
|---|---|---|---|
| 父子分块（parent-child） | §2.1 | ✅ 已实现并验证 | `87038ee`（分块器层）+ `4911658`（落库层） |
| 查询改写 / 扩展 | §2.4 | ✅ 已实现并验证 | `bcc904d` |
| 查询理解（改写 + 意图） | §2.5 | ✅ 已实现并验证 | 见 §2.6 |
| FAQ 索引 | §2.2 | ⬜ 未实现 | — |
| 预生成问题（Doc2Query） | §2.3 | ⬜ 未实现 | — |

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
make typecheck          → 通过（无 error 行）
npx vitest run          → Test Files  170 passed | 4 skipped (174)
                          Tests  2274 passed | 16 skipped (2290)
                          0 failed
```

历次基线：§2.1 交付 166 文件 / 2214 测试 → §2.4 交付 168 / 2239（+2 文件、+25 条）→ §2.5 交付 **170 / 2274**（+2 文件、+35 条）。每一步都是全量回归，不是只跑新用例。

**尚未做的验证**（P1 完成前必须补）：
- ⬜ Playwright UI 验收（上传开启 `parent_child` 的文档，看检索/引用是否正常）
- ⬜ test_report 及用例通过截图
- ⬜ 合并 worktree → main 并 push

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

---

## 6. 下一步

1. P1 剩余 2 项：§2.2 FAQ 索引 → §2.3 预生成问题（Doc2Query）
   （顺序依据 SOLUTION.md §4 风险表：先做无外部依赖、不改数据模型的两项）
2. P1 全部子项完成后：Playwright UI 验收 → bugfix loop → test_report（含通过截图）→ 合并 main 并 push
