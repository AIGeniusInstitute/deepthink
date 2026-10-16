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

#### 2.1.5 护栏（`protectedPatterns`）

WeKnora 保护 LaTeX `$...$`、markdown 链接/图片、表格块、围栏代码、行内代码不被切分。**P1 只实现围栏代码块与表格块**——这两者被切断会直接破坏可读性；LaTeX/链接的收益低而正则风险高，推迟到 P2 评估。

> 这是**对清单的主动裁剪**，不是遗漏。裁剪依据：Simplicity First——先解决"切断会导致内容损坏"的类别。

---

### 2.2 FAQ 索引

**复用 `kb_chunks`，不建新表**（WeKnora 同样如此）。KB 行新增 `kb_type: 'document' | 'faq'`（默认 `document`）。

- FAQ 条目以 chunk 形式存储，元数据进 `kb_chunks.metadata` JSON：`{ standard_question, similar_questions[], negative_questions[], answer, answer_strategy, revision }`。
- `index_mode`：`question_answer`（默认）| `question_only`。
- `question_index_mode`：`combined`（默认，多问题合并成一条向量）| `separate`。
- 负向问题过滤为**小写精确相等**（WeKnora 语义，非子串匹配）。
- **FAQ 库只走向量索引，不建关键词索引**（`buildRetrievalParams` 把 KB 拆成 `faqVectorKBIDs` / `docKeywordKBIDs`）。

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

### 2.5 意图识别

- 7 类：`greeting` / `chitchat` / `follow_up` / `image_only` / `summarize` / `web_search` / `doc_only`。
- LLM 参数：maxTokens 150（有图 2048）、temperature 0.3、Thinking false。
- 结构化输出兜底正则：`"([a-z_]+)"\s*:\s*"((?:[^"\\]|\\.)*)("?)`。
- 下游影响：`greeting` / `chitchat` **不走检索**；`web_search` 走 web 检索；`doc_only` 强制只做文档检索。

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
| AC-8 | 既有 51 条 KB 测试全部不回归 | `npx vitest run tests/units/kb-*` |

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
