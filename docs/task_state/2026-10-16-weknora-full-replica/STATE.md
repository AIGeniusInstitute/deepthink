# 执行状态 — WeKnora 知识库整体复刻（第二轮）

> PRD：`docs/prd/2026-10-16-weknora-full-replica/PRD.md`
> 技术方案：`docs/tech_solution/2026-10-16-weknora-full-replica/SOLUTION.md`
> 分支：`worktree-feat-kb-full-replica`（worktree：`~/deepthink/.claude/worktrees/feat-kb-full-replica`）

---

## 0. 总览

| 期 | 内容 | 状态 |
|---|---|---|
| **P1** | 知识库内核补全：父子分块 / FAQ 索引 / 预生成问题 / 查询改写 / 意图识别 | **进行中（1/5 子项完成）** |
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
| FAQ 索引 | §2.2 | ⬜ 未实现 | — |
| 预生成问题（Doc2Query） | §2.3 | ⬜ 未实现 | — |
| 查询改写 / 扩展 | §2.4 | ⬜ 未实现 | — |
| 意图识别 | §2.5 | ⬜ 未实现 | — |

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

### 3.3 夹具问题（非代码缺陷）

初次 e2e 出现 0 个父行、14 个块。经排查是**夹具问题不是代码缺陷**：section 太小触发语义 2。已把 `bodyRepeat` 提到 150，并为「不建冗余父行」单独写了用例——把这个行为**升级为显式断言**，而不是靠调夹具绕过。

---

## 4. 验证证据

```
make typecheck          → 通过（exit 0）
npx vitest run          → Test Files  166 passed | 4 skipped (170)
                          Tests  2214 passed | 16 skipped (2230)
                          0 failed
npx vitest run tests/units/kb-*  → 全部通过（AC-8）
```

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

---

## 6. 下一步

1. P1 §2.4 查询改写 / 扩展（纯本地无 LLM，风险最低）→ §2.5 意图识别 → §2.2 FAQ 索引 → §2.3 预生成问题
   （顺序依据 SOLUTION.md §4 风险表：先做无外部依赖、不改数据模型的两项）
2. P1 全部子项完成后：Playwright UI 验收 → bugfix loop → test_report（含通过截图）→ 合并 main 并 push
