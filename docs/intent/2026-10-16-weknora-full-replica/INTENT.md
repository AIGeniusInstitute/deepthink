# Intent — WeKnora 知识库系统整体复刻

- **日期**：2026-10-16
- **委托人**：DeepThink 产品负责人
- **委托原文时间**：2026-10-16T05:37:44.803Z（飞书）
- **分支**：`worktree-feat-kb-full-replica`
- **状态**：意图已冻结，进入 PRD 阶段

---

## 1. 委托原文（逐字保留）

> ## 任务目标
>
> 知识库系统项目源代码：`~/WeKnora`
>
> 把 WeKnora 知识库管理系统整体复刻到 DeepThink。
>
> 为 DeepThink 系统开发一个完整的知识库子系统。
>
> **必须要复刻的功能清单**
>
> **功能清单**
>
> - **文档接入**：文件上传（PDF/Word/PPT/Excel/Markdown/HTML/EPUB/XMind/图片/音频等）、URL 抓取、手写 Markdown、整目录上传、飞书 / Lark / Notion / Confluence / 语雀 / 钉钉 / IMA / GitLab / RSS 定时同步。
> - **文档理解**：版式分析、扫描件 OCR、表格抽取、图片多模态描述（VLM）、音频转写（ASR）、按文件类型选择解析引擎（ParserEngineRules，可接 MinerU / OpenDataLoader）。
> - **索引管道**：可配置分块（含父子分块与自适应策略）、向量索引、关键词全文索引、FAQ 索引、Wiki 生成、知识图谱抽取、预生成问题（question generation）。
> - **检索**：向量 + BM25 混合检索、RRF 融合、Rerank 重排、查询改写与扩展、意图识别（greeting/chitchat/web_search 等，见 `config/prompt_templates/intent_prompts.yaml`）。
> - **问答与 Agent**：流式 SSE 问答、多轮上下文压缩、引用溯源；ReAct Agent（工具：`search_knowledge`、`read_document`、`list_documents`、`wiki_search`、`data_analysis` 等）、MCP 外部工具、Agent Skills（Docker、Cube 或 E2B 沙箱执行脚本）、Web 搜索。
> - **对话体验**：回答进行中追加要求、从任意历史提问分叉或原地回滚（带沙箱工作区检查点）、按会话调整思考强度，「产物」页跨会话汇总智能体生成的文件。
> - **多租户与安全**：RBAC 角色鉴权（默认开启，`WEKNORA_TENANT_ENABLE_RBAC`）、审计日志（默认保留 90 天）、三档注册模式（开放注册、`invite_register` 仅限邀请注册、`invite_only` 禁止注册；旧变量 `DISABLE_REGISTRATION=true` 对应禁止注册）、OIDC 单点登录、SSRF 防护（可选仅白名单出站 `SSRF_DNS_WHITELIST_ONLY`）、敏感字段 AES-256 加密。界面提供简体中文、繁体中文、英文、日文、韩文和俄文。
> - **可观测性**：Langfuse 全链路追踪（LLM/Embedding/Rerank/VLM/ASR 调用与 token 统计）、健康检查、Swagger API 文档（`GIN_MODE=debug` 时）。
> - **生态**：REST API（`/api/v1`）+ API Key、内置 MCP Server（按空间创建端点，把 WeKnora 作为工具暴露给其他 Agent）、CLI（`cli/`）、微信小程序（`miniprogram/`）、浏览器插件渠道、本机浏览器（智能体通过 Chrome/Edge 扩展操作用户浏览器）。Lite 桌面版（macOS）可在本机沙箱中执行智能体命令。

---

## 2. 这次委托与上一轮的关系：**范围升级**

上一轮委托（2026-10-16T03:34Z）的表述是「把 WeKnora 知识库管理系统整体复刻到 DeepThink」，交付方（我们）自行做了范围裁决：只复刻**知识库内核**，把 Wiki 生成、知识图谱、外部数据源连接器列为 v2/v3。该裁决已交付并合并（main `4cf15ef`）。

本轮委托新增了一份**「必须要复刻的功能清单」**，其中明确包含上一轮被 defer 的项（Wiki 生成、知识图谱抽取），以及上一轮完全未涉及的项（OCR、VLM、ASR、版式分析、FAQ 索引、预生成问题、意图识别、查询改写、Langfuse、小程序、浏览器插件、桌面版）。

**因此本轮不再做范围裁剪式裁决**——清单是委托方明示的「必须」。我们只做一件事：把清单每一项**落到具体实现路径上**，并对「DeepThink 已有」的项给出复用映射，而不是重新造。

> ⚠️ 这一点必须写清楚：清单里有相当比例的项，DeepThink 平台**已经具备**（RBAC、审计日志、注册模式、多 IM 渠道、沙箱、MCP、i18n 多语言…）。对这些项，「复刻」的正确动作是**核对 + 补齐缺口 + 接入知识库上下文**，而不是重建一套并行实现。重建会产生两套并行机制，属于 Simplicity First 明令禁止的投机性设计。

---

## 3. 功能清单结构化（编号供 PRD / 测试报告引用）

### A. 文档接入

| # | 能力 |
|---|---|
| A1 | 文件上传：PDF / Word / PPT / Excel / Markdown / HTML / EPUB / XMind / 图片 / 音频 |
| A2 | URL 抓取 |
| A3 | 手写 Markdown |
| A4 | 整目录上传 |
| A5 | 外部数据源定时同步：飞书 / Lark / Notion / Confluence / 语雀 / 钉钉 / IMA / GitLab / RSS |

### B. 文档理解

| # | 能力 |
|---|---|
| B1 | 版式分析（layout analysis） |
| B2 | 扫描件 OCR |
| B3 | 表格抽取 |
| B4 | 图片多模态描述（VLM） |
| B5 | 音频转写（ASR） |
| B6 | 按文件类型选择解析引擎（`ParserEngineRules`，可接 MinerU / OpenDataLoader） |

### C. 索引管道

| # | 能力 |
|---|---|
| C1 | 可配置分块（含**父子分块**与**自适应策略**） |
| C2 | 向量索引 |
| C3 | 关键词全文索引 |
| C4 | FAQ 索引 |
| C5 | Wiki 生成 |
| C6 | 知识图谱抽取 |
| C7 | 预生成问题（question generation） |

### D. 检索

| # | 能力 |
|---|---|
| D1 | 向量 + BM25 混合检索 |
| D2 | RRF 融合 |
| D3 | Rerank 重排 |
| D4 | 查询改写与扩展 |
| D5 | 意图识别（greeting / chitchat / web_search 等） |

### E. 问答与 Agent

| # | 能力 |
|---|---|
| E1 | 流式 SSE 问答 |
| E2 | 多轮上下文压缩 |
| E3 | 引用溯源 |
| E4 | ReAct Agent（工具：`search_knowledge` / `read_document` / `list_documents` / `wiki_search` / `data_analysis` 等） |
| E5 | MCP 外部工具 |
| E6 | Agent Skills 沙箱执行脚本（Docker / Cube / E2B） |
| E7 | Web 搜索 |

### F. 对话体验

| # | 能力 |
|---|---|
| F1 | 回答进行中追加要求（steering） |
| F2 | 从任意历史提问分叉（fork） |
| F3 | 原地回滚（带沙箱工作区检查点） |
| F4 | 按会话调整思考强度 |
| F5 | 「产物」页：跨会话汇总智能体生成的文件 |

### G. 多租户与安全

| # | 能力 |
|---|---|
| G1 | RBAC 角色鉴权（WeKnora 默认开启 `WEKNORA_TENANT_ENABLE_RBAC`） |
| G2 | 审计日志（WeKnora 默认保留 90 天） |
| G3 | 三档注册模式：开放 / `invite_register`（仅限邀请）/ `invite_only`（禁止注册） |
| G4 | OIDC 单点登录 |
| G5 | SSRF 防护（可选仅白名单出站） |
| G6 | 敏感字段 AES-256 加密 |
| G7 | 界面语言：简体中文 / 繁体中文 / 英文 / 日文 / 韩文 / 俄文 |

### H. 可观测性

| # | 能力 |
|---|---|
| H1 | Langfuse 全链路追踪（LLM / Embedding / Rerank / VLM / ASR 调用与 token 统计） |
| H2 | 健康检查 |
| H3 | Swagger API 文档 |

### I. 生态

| # | 能力 |
|---|---|
| I1 | REST API（`/api/v1`）+ API Key |
| I2 | 内置 MCP Server（按空间创建端点，把 DeepThink 作为工具暴露给其他 Agent） |
| I3 | CLI |
| I4 | 微信小程序 |
| I5 | 浏览器插件渠道 |
| I6 | 本机浏览器操作（智能体经 Chrome/Edge 扩展操作用户浏览器） |
| I7 | Lite 桌面版（macOS），可在本机沙箱执行智能体命令 |

---

## 4. 委托方未明说、但会决定成败的约束（我方判断，供 PRD 确认）

1. **不得破坏现有交付**：知识库内核（main `4cf15ef`）已上线，本轮所有改动必须与其兼容；既有 2171 项测试不得回归。
2. **`~/WeKnora` 是参考实现，不是依赖**：禁止把 Go 服务作为运行时依赖嵌入 DeepThink；复刻产出必须是 DeepThink 原生 TS/React 代码。
3. **零新增重依赖是上一轮的既有约束**，但 B 组（OCR / VLM / ASR）与 C6（图谱抽取）在原理上需要模型服务。这类能力的合理形态是**可插拔的 provider 接口 + 本地 stub 可用**，而不是硬绑某个云厂商。
4. **A5 与 I4/I5/I7 的体量远大于其余项**：外部数据源同步是 9 个独立 connector，小程序与浏览器插件是独立前端工程，桌面版是独立打包链。这三块是否单独立项，需要在 PRD 阶段与委托方对齐优先级与交付节奏。

---

## 5. 下一步

1. 完成两份能力盘点（知识库内核 / 平台级），产出「已存在 / 部分存在 / 缺失」逐项映射表。
2. 写入 `docs/prd/2026-10-16-weknora-full-replica/PRD.md`：每项功能的验收标准 + 测试用例。
3. 写入 `docs/tech_solution/2026-10-16-weknora-full-replica/`：技术方案与分期。
4. 编码 → 测试 → UI 验收 → 测试报告 → 合并 main。
