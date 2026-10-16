# 任务执行状态 — WeKnora 知识库内核复刻

**分支**：`worktree-feat-knowledge-base`
**工作树**：`~/deepthink/.claude/worktrees/feat-knowledge-base`
**开始**：2026-10-16
**完成**：2026-10-16

---

## 进度总览

| 里程碑 | 状态 | 备注 |
|---|---|---|
| M0 侦察 + 范围裁决 | ✅ 完成 | 见 `docs/intent` |
| M1 数据模型 + 分块引擎 | ✅ 完成 | `src/kb/chunker.ts` + `kb_chunks` 系列表 |
| M2 解析流水线 + chunk 级向量化 | ✅ 完成 | `src/kb/pipeline.ts` + 7 种解析器 |
| M3 混合检索 + 检索测试台 | ✅ 完成 | `src/kb/fusion.ts` / `search.ts` + RRF |
| M4 RAG 问答 + 引用溯源 | ✅ 完成 | `src/kb/rag.ts` |
| M5 Web UI | ✅ 完成 | 列表页 + 详情页 4 个 tab |
| M6 测试 + 报告 + 合并 | ✅ 完成 | 见 `docs/test_report` |

---

## 交付物

### 后端

| 文件 | 说明 |
|---|---|
| `src/kb/chunker.ts` | 三策略分块，全部携带原文绝对字符偏移 |
| `src/kb/fusion.ts` | RRF 融合（K=60，向量权重 0.7 / 关键词 0.3） |
| `src/kb/search.ts` | 三路检索（hybrid / keyword / vector）+ 引用构造 |
| `src/kb/pipeline.ts` | 解析→分块→向量化 流水线状态机 |
| `src/kb/rag.ts` | RAG 问答（流式 + 非流式）+ 引用编号 |
| `src/kb/rerank.ts` | 重排 |
| `src/document-parser.ts` | 扩展 html / csv / json，新增文本嗅探 |
| `src/db.ts` | `kb_chunks` / `kb_chunk_revisions` / `kb_chunks_fts` / `kb_chunks_vec` + chunk CRUD + FTS 查询构造 + 混合检索 |
| `src/routes/paas-knowledge-bases.ts` | 28 个 HTTP 接口（路由注册条数，`grep -c` 实测） |
| `src/index.ts` | MCP IPC：`kb_search` / `kb_read_document` / `kb_list_documents` |
| `container/agent-runner/src/mcp-tools.ts` | 对应 3 个 MCP 工具 |

### 前端

| 文件 | 说明 |
|---|---|
| `web/src/pages/KnowledgeBasesPage.tsx` | 知识库列表（增删 + 跳转） |
| `web/src/pages/KnowledgeBaseDetailPage.tsx` | 详情页，4 tab：文档 / 分块 / 检索测试台 / 问答 |
| `web/src/components/knowledge-base/KbChunkViewer.tsx` | 分块查看、回源核验、编辑、修订历史回滚 |
| `web/src/components/knowledge-base/KbSearchLab.tsx` | 检索测试台，三模式 + 调试诊断面板 |
| `web/src/components/knowledge-base/KbChatPanel.tsx` | 流式问答 + 引用展开 |
| `web/src/stores/knowledge-bases.ts` | 状态与 API，含手写 SSE 解析 |

---

## 关键决策记录

### 范围裁决（M0）

WeKnora 全量约 105 万行，覆盖 RAG / Agent / Wiki / 沙箱 / MCP / 11 个数据源 / 8 个 IM 渠道 / RBAC。DeepThink 已具备 Agent Studio、沙箱、skills、mcp-registry、8 个 IM 渠道、RBAC + 审计、计费。

因此"整体复刻"落在：**把 WeKnora 的知识库内核复刻到 DeepThink 原生的 TS/React 技术栈上**，外围能力复用 DeepThink 既有子系统。Wiki / 知识图谱、数据源连接器 defer 到 v2/v3。

### 不引入新依赖

解析器只加 `html` / `csv` / `json` 三种**零依赖**格式，明确**不做** xlsx / pptx —— 那需要引入解析库，而本次没有任何一种格式是验收标准要求的（Simplicity First）。

### 分词器选型

`kb_chunks_fts` 用 `tokenize='trigram'`，而非 SQLite 默认的 `unicode61`。原因见 `docs/issues/2026-10-16-kb-chinese-keyword-search-dead.md`。代价是索引体积变大、MATCH 词项必须 ≥3 字符；后者用 `instr()` LIKE 降级补上。

### 隔离部署

UI 验收跑在 `make dev-isolated ISOLATED_PORT=9899 ISOLATED_DATA_DIR=/tmp/dt-kb-ui`，独立端口 + 独立数据目录，**不碰用户的实时数据库**（生产实例在 9999）。

---

## 过程中发现并修复的缺陷

| # | 缺陷 | Issue 文档 |
|---|---|---|
| 1 | 长文档尾部内容永远检索不到（`MAX_EMBED_TEXT_CHARS = 8000` 静默截断） | `docs/issues/2026-10-16-kb-long-document-embedding-truncated.md` |
| 2 | 删除知识库必然 500（`DELETE` 语句上误用 `.all()`） | `docs/issues/2026-10-16-kb-delete-returns-500.md` |
| 3 | 分块偏移量与内容对不上，引用无法回源核验 | `docs/issues/2026-10-16-kb-chunk-content-not-equal-to-source-slice.md` |
| 4 | 中文关键词检索恒为 0 命中（`unicode61` + 整句短语匹配） | `docs/issues/2026-10-16-kb-chinese-keyword-search-dead.md` |

缺陷 1 是本次开发的**动机**；缺陷 2 是**先于本次开发就存在**的（删除知识库功能从实现起就不可用）；缺陷 3、4 由本次新增的集成测试与 UI 验收发现。

### 发现过程

- 缺陷 3 被**端到端路由测试**发现，而分块器的单元测试是绿的——因为夹具里一个分块内部恰好没有段落分隔符，`join('')` 与 `slice()` 结果相同。
- 缺陷 4 被**中文语料的检索用例**发现。此前所有检索测试用的都是英文标记串，中文全链路从未真正跑过。
- 缺陷 2 被 UI 验收脚本的清理步骤发现（脚本每次运行前删掉上一轮遗留的知识库，断言 HTTP 200）。

---

## 环境问题（非产品缺陷）

| 现象 | 原因 | 处理 |
|---|---|---|
| 40 个测试文件报 `NODE_MODULE_VERSION 127 vs 147` | `better-sqlite3` 原生模块为 Node 22 编译，本机是 Node v26.7.0 | `npm rebuild better-sqlite3 sqlite-vec` |
| 3 个测试文件报 `Cannot find package 'zustand'` | worktree 下缺 `web/node_modules` | 软链到主仓库的 `web/node_modules` |
| Playwright 报浏览器版本不匹配（期望 r1234，缓存里是 r1243） | `playwright-core` 版本与缓存浏览器不一致 | `launch({ executablePath })` 指向已装好的「Google Chrome for Testing」，不额外下载 |

---

## 验证结果

| 项目 | 命令 | 结果 |
|---|---|---|
| 类型检查 | `make typecheck` | 通过（backend + web + agent-runner + shared types 同步 + 9 个 prompt 引用） |
| 构建 | `make build` | 通过 |
| 全量单测 | `npx vitest run` | 162 文件通过 / 4 跳过；**2171 通过 / 0 失败 / 16 跳过** |
| 知识库单测 | `npx vitest run tests/units/kb-*.test.ts` | **51 / 51 通过** |
| UI 验收 | `docs/test_report/.../ui-test.mjs` | **12 / 12 通过** |

详见 `docs/test_report/2026-10-16-weknora-knowledge-base/TEST_REPORT.md`。
