# 原始意图记录 — WeKnora 知识库管理系统复刻

- **日期**：2026-10-16
- **提出人**：产品负责人（飞书）
- **状态**：已归档（意图原文，不做加工）

---

## 1. 用户原始表述

> 知识库系统项目源代码：`~/WeKnora`
>
> 把 WeKnora 知识库管理系统整体复刻到 DeepThink。
> 为 DeepThink 系统开发一个完整的知识库子系统。

## 2. 意图解读

用户要求为 DeepThink 开发一个**完整的知识库子系统**，参考实现是腾讯开源的 WeKnora。

关键词是"**整体复刻**"。在动手之前，必须先把"整体"这个词的边界摸清楚——因为 WeKnora 的真实体量与 DeepThink 的技术栈之间，存在一个必须显式裁决的落差。§3 是这份落差的实测数据，§4 是据此提出的范围建议。

## 3. 体量实测（2026-10-16 实测，非估算）

| 系统 | 技术栈 | 文件数 | 代码行数 |
|---|---|---|---|
| **WeKnora** | Go 1.26 | 2,987 | 762,480 |
| | Vue 3 + TS（`frontend/src`） | 701 | 275,391 |
| | Python（`docreader`） | 76 | — |
| | **小计** | **~3,764** | **≈ 105 万行** |
| **DeepThink** | TypeScript / Hono（`src`） | 241 | 128,720 |
| | React 19 / Vite（`web/src`） | — | — |

WeKnora 的能力面（据其 README v0.8.3）横跨：

RAG 检索问答 · Agent 多步推理 · Wiki 知识图谱 · 技能沙箱（Docker/E2B/Cube）· 本地浏览器
（BrowserSkill）· MCP Server 发布 · 11 类数据源连接器 · 8 种 IM 频道 · 多模态 Embedding ·
29 家模型厂商目录 · 多种向量库（pgvector/OpenSearch/腾讯云 VectorDB…）· 四级 RBAC 多空间 ·
审计日志 · 任务队列与 Worker 池 · Langfuse 追踪 · CLI · 桌面端 · 小程序 · Chrome 插件

## 4. 关键落差与范围裁决（待确认）

### 4.1 落差

- **量级**：105 万行 vs 12.9 万行。逐行移植在单次交付内不可能，强行推进会产出一个"形似而神不似"的空壳。
- **技术栈**：WeKnora 是 Go + Vue；DeepThink 是 TypeScript/Hono + React。移植 = 重写，不是搬运。
- **能力重叠**：WeKnora 的 **Agent / 沙箱 / 技能 / MCP 发布 / IM 频道 / RBAC / 审计 / 计费**，DeepThink **已全部具备**（Agent Studio、5 个引擎、sandbox、skills、mcp-registry、8 个 IM 通道、RBAC + 审计、billing）。

### 4.2 结论

WeKnora 中**只有"RAG 知识库内核"这一块是 DeepThink 真正的空缺**。其余部分要么已有更强实现，要么不属于知识库范畴。

因此"整体复刻"应裁决为：**复刻 WeKnora 的知识库内核能力，落在 DeepThink 原生技术栈上**，其余能力面复用 DeepThink 既有子系统。

### 4.3 DeepThink 现状（复刻起点，实测）

现有知识库是一个 **~1,000 行的最小实现**：

| 文件 | 行数 | 职责 |
|---|---|---|
| `src/routes/paas-knowledge-bases.ts` | 362 | KB CRUD + 上传 + 检索 |
| `src/paas-knowledge-bases.ts` | — | 类型与桥接 |
| `src/embedding.ts` | 225 | OpenAI 兼容 embedding，sqlite-vec / pgvector |
| `web/src/pages/KnowledgeBasesPage.tsx` | 326 | 前端页面 |
| `web/src/stores/knowledge-bases.ts` | 132 | Zustand store |

**已具备**：KB 增删改查、`.md/.txt/.pdf/.docx` 上传（≤10MB）、URL 导入、FTS5 全文检索、异步 embedding、`kb_search` MCP 工具。

**关键缺陷**（决定了复刻的重点）：

1. **无分块** — `src/embedding.ts:23` 的 `MAX_EMBED_TEXT_CHARS = 8000` 会把文档**截断**后整篇向量化。超过 8000 字符的文档，后半部分**从未进入索引**，检索永远召回不到。这是与 WeKnora 最本质的差距。
2. **无引用溯源** — 无法从答案定位回原文片段。
3. **无问答会话** — 只有检索接口，没有 RAG 对话。
4. **无解析流水线** — 没有文档状态机、进度、失败原因、重新解析。
5. **检索为单路** — 向量与关键词是回落关系，不是融合。
6. **格式窄** — 不支持 Excel / PPT / HTML / CSV / 图片。

## 5. 交付范围建议

### v1（本期）

复刻 WeKnora 知识库内核，端到端打通：

1. 知识库管理（配置：分块策略 / 向量模型 / 检索参数）
2. 文档接入（扩展格式 + 文件夹批量上传 + URL + 纯文本）
3. 解析流水线（状态机 / 进度 / 失败原因 / 重新解析）
4. 分块（多策略 + 可视化预览 / 编辑）
5. 向量化（**chunk 级** + 真批量 + 重嵌入）
6. 混合检索（向量 + 关键词，RRF 融合 + 可选重排）
7. 检索测试台（召回调试面板）
8. RAG 问答（会话 + 流式 + **引用溯源**）
9. Web UI（列表 / 详情 / 问答）
10. Agent 集成（MCP 工具对齐 WeKnora：`kb_search` / `read_document` / `list_documents`）

### 后续分期（不在 v1）

- **v2**：Wiki 模式 + 知识图谱、多模态 embedding（图片向量）、rerank 模型接入
- **v3**：数据源连接器（飞书云盘 / Confluence / Notion / GitLab 等）
- **按需**：跨用户知识库共享与空间隔离（DeepThink 已有 RBAC 基础）

## 6. 验收标准（v1 退出条件）

1. 上传一份 > 8000 字符的 PDF，**全文可被检索到**（当前实现此处必然失败）
2. 检索结果可定位回原文 chunk，问答答案带可点击引用
3. 混合检索在中文语料上的召回优于纯 FTS5 基线
4. 全部测试用例通过，附 UI 截图证据
5. Agent 可通过 MCP 工具使用知识库

---

**下一步**：待范围裁决确认后，进入 PRD 阶段。
