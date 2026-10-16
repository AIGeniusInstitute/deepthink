# PRD — WeKnora 知识库系统整体复刻（第二轮：补齐清单）

- **日期**：2026-10-16
- **对应意图**：`docs/intent/2026-10-16-weknora-full-replica/INTENT.md`
- **前置交付**：`docs/prd/2026-10-16-weknora-knowledge-base/`（v1 内核，main `4cf15ef`）
- **参考实现**：`~/WeKnora`（v0.8.3，283MB，Go + Vue3 + Python grpc）
- **分支**：`worktree-feat-kb-full-replica`

---

## 1. 背景

上一轮委托的表述是「把 WeKnora 知识库管理系统整体复刻到 DeepThink」，我方自行做了范围裁决，只交付**知识库内核**，并在 v1 PRD §2.2 写了一张「非目标」表排除若干能力。

本轮委托方给出了**「必须要复刻的功能清单」**，其中三项直接推翻 v1 的排除决定，另有多项 v1 完全未涉及。

### 1.1 v1 PRD §2.2「非目标」表的失效声明

| v1 排除项 | v1 理由 | 本轮委托 | 处置 |
|---|---|---|---|
| Wiki 模式 / 知识图谱 | 非内核，列 v2 | **明确要求** | ❌ 排除决定作废，纳入本期 |
| 数据源连接器（11 类） | 非内核，列 v3 | **明确要求**（9 类） | ❌ 排除决定作废，纳入本期 |
| 多模态 / 图片向量 | 依赖多模态模型，列 v2 | **明确要求**（VLM/ASR/OCR） | ❌ 排除决定作废，纳入本期 |
| Agent / 沙箱 / 技能 / MCP 发布 | DeepThink 已具备 | 清单仍列（E4–E6、I2） | ✅ 保留：已有者复用，不重建 |
| IM 频道集成 | DeepThink 已有 8 通道 | 清单未变 | ✅ 保留：复用 |
| 多租户 RBAC / 审计日志 | DeepThink 已有 | 清单仍列（G1/G2） | ✅ 保留：复用 + 核对缺口 |
| 多种向量库（Qdrant/Milvus/ES） | 已定调 sqlite-vec / pgvector | 清单未要求 | ✅ 保留：不引入 |

### 1.2 一条被误归类的缺口（v1 交付瑕疵，本轮归还）

v1 PRD `FR-1.6` 原文要求：

> 支持扩展格式：在既有 `.md/.txt/.pdf/.docx` 基础上增加 `.html/.htm/.csv/.json/.xlsx/.pptx`

实测（`src/document-parser.ts:21` 的 `SUPPORTED_PARSERS`）只落地了 `pdf / docx / html / csv / json / markdown / text` —— **`.xlsx` 与 `.pptx` 从未实现**。

v1 的 TEST_REPORT 把这两种格式写进了「§8 已知边界 / 不是缺陷」，这个归类是错的：它不是我方主动设计的边界，而是**未满足自己写下的验收条款**。本轮正式将 `A1-ppt/xlsx` 作为承接缺口纳入，并要求 v1 测试报告同步更正归类。

---

## 2. 能力盘点（实测，非推断）

对清单 40 项逐项对照现有代码实测。三档结论：`已存在` / `部分存在` / `缺失`。

### 2.1 A 文档接入

| # | 能力 | 结论 | 证据 | 差距 |
|---|---|---|---|---|
| A1 | 文件上传多格式 | 部分存在 | `src/document-parser.ts:21`、`src/routes/paas-knowledge-bases.ts:324` | 已有 pdf/docx/md/html/csv/tsv/json/txt；**缺 pptx / xlsx / epub / xmind / 图片 / 音频** |
| A2 | URL 抓取 | 已存在 | `src/routes/paas-knowledge-bases.ts:417`、`src/document-parser.ts:167` | 仅 `text/html`/`text/plain`/`xml`，cheerio 抽正文；无 JS 渲染、无多页爬取 |
| A3 | 手写 Markdown | 缺失 | 仅 `:id/documents`(multipart) 与 `:id/documents/url` | 无纯文本入库接口与 UI |
| A4 | 整目录上传 | 缺失 | `paas-knowledge-bases.ts:296` 每次只取单个 `formData.get('file')` | 无 multiple / webkitdirectory / zip 解包 |
| A5 | 外部数据源定时同步 | 缺失 | `src/` 下 `confluence\|notion\|yuque\|rss\|connector` 无命中 | 无 connector 抽象；通用调度器 `src/task-scheduler.ts` 存在但无知识库同步任务类型 |

### 2.2 B 文档理解

| # | 能力 | 结论 | 证据 | 差距 |
|---|---|---|---|---|
| B1 | 版式分析 | 缺失 | PDF 走 `pdf-parse` 纯文本（`document-parser.ts:81`）、DOCX 走 `mammoth.extractRawText`（`:90`） | 版面结构全丢 |
| B2 | 扫描件 OCR | 部分存在 | 内置 `image-ocr` Skill（`src/db.ts:10861`，tesseract） | 只作为 Agent 可调 Skill 存在，**未接入入库流水线**；`parsePdf` 遇扫描件直接抛错（`document-parser.ts:86`） |
| B3 | 表格抽取 | 缺失 | `document-parser.ts:110` `parseDelimited` | 仅 CSV/TSV 按分隔符 join 成 `a \| b \| c`，且注释自承不支持引号字段；PDF/DOCX/PPT 内表格无结构化抽取 |
| B4 | 图片多模态描述（VLM） | 缺失 | 知识库链路无图片处理 | 多模态只在对话侧（`agent-runner/src/index.ts:565`） |
| B5 | 音频转写（ASR） | 部分存在 | `src/wechat.ts:169`、`:183` | 仅微信通道收消息时被动使用，知识库不能上传音频 |
| B6 | ParserEngineRules | 缺失 | `document-parser.ts:34` `detectParser` 是硬编码 if 链 | 无可配置规则表，不支持外接引擎（MinerU / OpenDataLoader） |

### 2.3 C 索引管道

| # | 能力 | 结论 | 证据 | 差距 |
|---|---|---|---|---|
| C1 | 可配置分块（父子 / 自适应） | 部分存在 | `src/kb/chunker.ts:14`、`:295`、`:327` | 有 heading/heuristic/recursive + size/overlap；**缺父子分块**（`pre_chunk_id`/`next_chunk_id` 列存在但切分器不填）；`recommendStrategy` 只是按标题密度选策略，非真正自适应 |
| C2 | 向量索引 | 已存在 | `src/db.ts:11856`（sqlite-vec）、`:12621`（pgvector）、`src/embedding.ts:295` | 双后端 + 线性扫描降级 |
| C3 | 关键词全文索引 | 已存在 | `src/db.ts:11897`（trigram）、`:12557`（bm25 臂） | <3 字符回退 LIKE（`:12505`） |
| C4 | FAQ 索引 | 缺失 | `src/` 下 `faq` 无命中 | `kb_chunks.chunk_type` 字段存在但恒为 `'text'`（`db.ts:1237`，写入处 `:12259` 从不传值） |
| C5 | Wiki 生成 | 缺失 | — | v1 列为 v2，本期纳入 |
| C6 | 知识图谱抽取 | 缺失 | `src/graph-engineering/*` 是工作流 DAG，非知识图谱 | 无实体/关系抽取 |
| C7 | 预生成问题 | 缺失 | `suggestedQuestion\|question_gen` 无命中 | — |

### 2.4 D 检索

| # | 能力 | 结论 | 证据 | 差距 |
|---|---|---|---|---|
| D1 | 向量 + BM25 混合检索 | 已存在 | `src/kb/search.ts:93`、`:122` | 过召回 `clamp(limit*5,50,500)` |
| D2 | RRF 融合 | 已存在 | `src/kb/fusion.ts:49`、`:38` | `k=60`，权重 `0.7/0.3` |
| D3 | Rerank 重排 | 已存在 | `src/kb/rerank.ts:87`、`search.ts:182` | ⚠️ v1 Intent 把 rerank 列为 v2，代码已提前实现——文档与代码状态相反 |
| D4 | 查询改写与扩展 | 缺失 | `queryRewrite\|expandQuery\|hyde\|multiQuery` 无命中 | 用户问题原样送检索（`rag.ts:150`、`:178`） |
| D5 | 意图识别 | 缺失 | `greeting\|chitchat\|classifyIntent` 无命中 | RAG 只走单一路径 |

### 2.5 E 问答与 Agent

| # | 能力 | 结论 | 证据 | 差距 |
|---|---|---|---|---|
| E1 | 流式 SSE 问答 | 已存在 | `src/kb/rag.ts:245`、`paas-knowledge-bases.ts:836` | 先 `citations` 后 `delta`，末尾 `[DONE]` |
| E2 | 多轮上下文压缩 | 部分存在 | KB 侧 `paas-knowledge-bases.ts:794`（取最近 20 条原文） | KB 问答**无压缩只截断**；Agent 侧 `autoCompactWindow` 属另一条链路 |
| E3 | 引用溯源 | 已存在 | `search.ts:238`、`rag.ts:133`、`paas-knowledge-bases.ts:480` | 偏移精确到字符 |
| E4 | ReAct Agent 工具 | 部分存在 | `agent-runner/src/mcp-tools.ts:2149/2249/2318`、宿主 `src/index.ts:7434/7526/7596` | 有 `kb_search`/`kb_read_document`/`kb_list_documents`；**缺 `wiki_search`、`data_analysis`** |
| E5 | MCP 外部工具 | 已存在 | `src/routes/mcp-servers.ts`、`src/container-runner.ts:1335` | per-turn 挂载 |
| E6 | Agent Skills 沙箱执行 | 部分存在 | `src/sandbox/manager.ts`、`mcp-tools.ts:2387` | **仅 Docker 一种后端**；无 Cube / E2B（`e2b\|cube\|daytona` 无命中） |
| E7 | Web 搜索 | 已存在 | `src/web-search.ts:15/121`、`mcp-tools.ts:2670` | 5 后端可插拔 |

### 2.6 F 对话体验

| # | 能力 | 结论 | 证据 | 差距 |
|---|---|---|---|---|
| F1 | 回答中追加要求（steering） | 部分存在 | `agent-runner/src/index.ts:529`（`MessageStream`）、`:1607`、`src/web.ts:887` | **Agent 路径已实现**；KB 自建 SSE `/chat` 无中途注入入口 |
| F2 | 从任意历史提问分叉 | 缺失 | 无消息树 / `parentId` | 前端仅 `regenerate` |
| F3 | 原地回滚 + 工作区检查点 | 部分存在 | `src/file-manager.ts:618`、`src/routes/files.ts:1789/1839`、`db.ts:2741` | 有**文件级**版本快照；无「按对话 turn 的工作区检查点」 |
| F4 | 按会话调整思考强度 | 部分存在 | `src/runtime-config.ts:4829`（`thinkingLevel` 七档）、`container-runner.ts:999` | 是**引擎级全局配置**，非会话级；会话/消息表无该字段 |
| F5 | 「产物」页 | 部分存在 | `web/src/pages/DiskPage.tsx`、`CollaborationPage.tsx:216` | 有按工作区浏览/搜索/回收站；无跨会话汇总视图 |

### 2.7 G 多租户与安全

| # | 能力 | 结论 | 证据 | 差距 |
|---|---|---|---|---|
| G1 | RBAC 角色鉴权 | 部分存在 | `src/types.ts:288`（`UserRole = admin \| member` 仅 2 角色）、`src/permissions.ts:3-10`（6 权限点）、`:12-45`（4 模板）、`src/middleware/auth.ts:139-175` | 无角色层级、无资源级鉴权；权限点仅全局 6 个 |
| G2 | 审计日志（90 天保留） | 部分存在 | 三表：`auth_audit_log`(`db.ts:884`) / `billing_audit_log`(`:1063`) / `tool_call_audit_log`(`:1433`) | **只有 billing 有保留期**（365d，`db.ts:4198` + `index.ts:12164`）；`auth_audit_log` 与 `tool_call_audit_log` **无任何 TTL**，无限增长。另 `cleanupOldSupervisorSessions`(`db.ts:4698`)、`cleanupOldLoopRuns`(`:4909`) 是**死代码**（零调用点） |
| G3 | 三档注册模式 | 部分存在 | `src/runtime-config.ts:2915-2925`（两个布尔：`allowRegistration` / `requireInviteCode`，默认 `true`+`true`）、`src/routes/auth.ts:353-378`、邀请码 `db.ts:860-871` | 无单一 `registrationMode` 枚举，三态靠布尔组合推导；**默认是「仅邀请注册」**（与 WeKnora 默认开放相反，易误判为 bug） |
| G4 | OIDC 单点登录 | 缺失 | `oidc\|saml\|passport\|openid-client\|keycloak\|casdoor` 仅命中 QQ/飞书的 `openid` 业务字段 | 仅本地用户名密码（bcryptjs）+ HMAC 会话 Cookie |
| G5 | SSRF 防护 | 部分存在 | 模块：`src/url-safety.ts:50/118/177`；接入点仅 4 处：`routes/groups.ts:535`、`routes/workspace-config.ts:267`、`routes/skills.ts:866`、`open-platform/result-hooks.ts:78` | ⚠️ **见 §2.9 安全缺口**：三条流量最大的出站路径完全未接入 |
| G6 | 敏感字段 AES-256 加密 | 部分存在 | `src/runtime-config.ts:698`（32B 主密钥，`data/config/claude-provider.key`，0600）、`:716-783`、`:785-811`、`src/mcp-registry/crypto.ts:24-45` | 无 KMS / 无密钥轮换（仅 `enc:v1`）；**`web_search` 的 API Key 明文落盘**（`src/web-search-config.ts:100`） |
| G7 | 界面多语言 | 已存在 | `src/i18n-languages.ts:22-53`（30 语言）、`web/src/i18n/locales/`（30 目录实测存在，译文真实） | 每 locale 仅 1 个 `common.json` / 114 key，无命名空间拆分——**广度 30 语言、深度仅一个命名空间**（清单要求 6 语言，已超额） |

### 2.8 H 可观测性 / I 生态

| # | 能力 | 结论 | 证据 | 差距 |
|---|---|---|---|---|
| H1 | Langfuse 全链路追踪 | 缺失 | 全仓（排除 node_modules）仅 Intent 文档出现 "langfuse"；无 OTLP/OTel exporter | 追踪全在本地 SQLite，无外部后端对接 |
| H2 | 健康检查 | 已存在 | `src/web.ts:299` `/health`（存活）、`:304` `/ready`（就绪，含 `isShuttingDown` + `checkDbReady()`），均免鉴权 | 无 `/metrics`（Prometheus） |
| H3 | Swagger / OpenAPI | 缺失 | 无生成器/UI；`src/mcp-registry/openapi-parser.ts` 是**反向用途**（解析外部 spec 以导入） | 文档靠手写 `docs/API.md`，易漂移 |
| I1 | 开放平台 REST API + API Key | 已存在 | `src/web.ts:358` 挂载 `/v1`；`/v1/models`(`routes/open-platform.ts:129`)、`/v1/chat/completions`(`:152`，OpenAI 风格 + SSE)、`/v1/agents/:id/chat/completions`(`:227`)；`Bearer sk-…` 鉴权 `src/open-platform/api-keys.ts:38-71`，scope 校验 `:50` | 无版本演进/弃用策略、无 per-key IP 白名单、无 OAuth client credentials |
| I2 | 内置 MCP Server | 部分存在 | `src/routes/mcp-registry.ts:496`（`/api/mcp-registry/mcp`，协议 `2025-06-18`，`tools/list` `:408`、`tools/call` `:434`，含限流/幂等/审计）；自家 36 工具走 `createSdkMcpServer()` 同进程 | ⚠️ **对外端点暴露的是「用户自注册外部 HTTP 工具的代理」，DeepThink 自家 36 个工具（含 `kb_search`）外部 Agent 拿不到**。真正的「把自身暴露为 MCP 工具」未实现。且 `GET /mcp` 不实现 SSE（405） |
| I3 | CLI | 部分存在 | `src/admin-account-cli.ts`（`npm run admin:cli`）、`src/reset-admin.ts` | 是服务端运维脚本，非面向用户的分发式 CLI；无 `bin` 字段、无打包发布 |
| I4 | 微信小程序 | 缺失 | 无 `miniprogram`/`app.json`；`src/wechat.ts` 是 **iLink Bot 个人微信机器人**，与小程序无关 | 完全缺失 |
| I5 | 浏览器插件 | 缺失 | 无 `manifest.json`、无 `chrome.runtime` 引用 | 完全缺失 |
| I6 | 本机浏览器操作 | 缺失 | 同上；无 Chrome/Edge 扩展通道 | 完全缺失 |
| I7 | Lite 桌面版（macOS） | 部分存在 | `desktop/`（Electron 32 + electron-builder）：`desktop/package.json`（`pack:mac/win/linux`）、`src/main.ts`、`tray.ts`、`updater.ts`、`backend-supervisor.ts`；`docs/desktop-architecture.md` | 是「后端进程的外壳」（supervisor 拉起 Node 服务），非独立前端；清单要求「本机沙箱执行智能体命令」，能力待核 |
| — | IM 渠道（清单外补充） | 已存在 | `src/channel-prefixes.ts:2-10`：feishu / telegram / qq / wechat / dingtalk / discord / whatsapp（7 个） | 无 Slack |

### 2.9 ⚠️ 安全缺口：SSRF 防护「模块强、平台弱」

**这是本轮盘点发现的最高优先级问题，且其中一条落在知识库 URL 入库链路上。**

> **归属更正**：`fetchUrlContent` 与 `POST /:id/documents/url` 均由 `17d6bd1`（**Agent PaaS Phase 2**）引入，`git log -S` 实测二者在 v1 知识库工作之前即存在，v1 未修改该函数。此缺口是**既有缺陷**，非 v1 引入——但它落在清单 `G5` 射程内，本轮修复。

`src/url-safety.ts` 的实现质量高于一般水准——`isPrivateHostname` 覆盖 CGNAT `100.64/10`（含阿里云 metadata `100.100.100.200`）、`198.18/15`、6to4、`::ffff:` 十六进制形态，并提供了 DNS-rebinding TOCTOU 收口原语 `resolvePublicAddresses`。

但它**只在 4 处被显式调用**（git URL 拉取、skill/包安装、workspace-config、result-hook）。三条流量最大的出站路径只判 `^https?://`：

| 路径 | 位置 | 风险 |
|---|---|---|
| Agent `web_fetch` 工具 | `container/agent-runner/src/mcp-tools.ts:2809-2813`（`redirect: 'follow'`） | 直连任意 URL，跟随重定向可绕过首跳校验 |
| `web_search` 自定义 baseUrl | `container/agent-runner/src/web-search.ts:355` | 用户可控 baseUrl 直连 |
| **知识库 URL 入库** | `src/document-parser.ts:167-196` | **上一轮交付的 `POST /:id/documents/url` 走的正是这条路径** |

任何把内网地址（`169.254.169.254`、`100.100.100.200`）塞进用户消息或文档内容的提示注入即可触发。清单 `G5` 明确要求 SSRF 防护，本轮必须收口——修复方式是把既有 `url-safety.ts` 接入这三处，**不是重写防护模块**。

---

## 3. 范围裁决

**本轮不做范围裁剪。** 清单是委托方明示的「必须」，40 项全部纳入。

但不同项的**交付性质**不同，分三类：

| 类别 | 项 | 交付动作 |
|---|---|---|
| **复用** | D1 D2 D3 E1 E3 E5 E7、G/H/I 组中已具备者 | 核对 + 补缺口 + 接入知识库上下文；**不重建** |
| **补强** | A1 A2 A3 A4 B2 C1 C3 E2 E4 E6 F1 F3 F4 F5 | 在既有实现上扩展，保持向后兼容 |
| **新建** | A5 B1 B3 B4 B5 B6 C4 C5 C6 C7 D4 D5 F2 | 从零实现 |

> 「复用」类的判定依据是实测代码，不是文档。凡实测发现「文档说没有、代码其实有」（如 D3 rerank）或「文档说有、代码没有」（如 A1 的 xlsx/pptx），一律以代码为准并在本文档更正。

---

## 4. 分期（详细 FR 与验收标准按分期逐批补入）

| 期 | 内容 | 可验证性 |
|---|---|---|
| **P1** | C1 父子分块 + 自适应策略、C4 FAQ 索引、C7 预生成问题、D4 查询改写、D5 意图识别 | 纯 TS 自包含；逐条单测 + UI 验收截图 |
| **P2** | A1 格式补齐（pptx/xlsx/epub/xmind）、A3 手写 Markdown、A4 整目录上传、B6 ParserEngineRules | 夹具驱动，可完整回归 |
| **P3** | B1 版式分析、B2 OCR 入库、B3 表格抽取、B4 VLM 图片描述、B5 ASR 音频转写 | 可插拔 provider + 本地 stub；验证链路而非模型质量 |
| **P4** | C5 Wiki 生成、C6 知识图谱抽取 | 夹具驱动 + 图谱可视化 |
| **P5** | A5 九个 connector、I4 小程序、I5 浏览器插件、I7 桌面版 | 接口契约级；深度低于 P1–P4（见 §6 风险） |

---

## 5. 非功能需求

1. **零回归**：v1 全部测试（2171 项）与 UI 验收（12 项）必须保持通过。
2. **向后兼容**：既有 `/api/paas/knowledge-bases` 端点路径与响应字段只增不改。
3. **双后端对等**：新增能力在 SQLite（sqlite-vec）与 PostgreSQL（pgvector）行为一致。
4. **优雅降级**：任何依赖模型服务的新能力，未配置时必须降级到「不启用该能力」而非报错。
5. **不新建并行机制**：清单中平台已具备的能力，必须复用既有实现。

---

## 6. 风险

| 风险 | 说明 | 应对 |
|---|---|---|
| P5 体量失衡 | A5（9 connector）+ I4/I5/I7 涉及 2 个独立前端工程与 1 条打包链，工作量超 P1–P4 总和 | 已向委托方明示；验证深度按接口契约级，不承诺端到端 UI 截图 |
| P3 依赖外部模型 | OCR/VLM/ASR 无模型服务则不可测 | 设计为可插拔 provider，配套本地 stub，确保「功能没实现」与「没配 Key」可区分 |
| 追问-确认循环 | v1 曾发生「PRD 写了、代码没做、报告里降级为边界」 | 本期每项 FR 必须绑定可执行测试用例；测试报告不得把未满足的 PRD 条款归类为「已知边界」 |
| 范围蔓延 | 40 项跨 9 大组 | 按 P1–P5 分期交付，每期独立测试报告 |

---

## 7. 里程碑

| 期 | 交付物 | 状态 |
|---|---|---|
| M0 | Intent 落盘 + worktree + 能力盘点 | ✅ 已完成（§2） |
| M1 | 本文档（PRD）完整化 + 技术方案 | 🚧 进行中 |
| M2 | P1 编码 + 测试 | ⏳ |
| M3 | P2 编码 + 测试 | ⏳ |
| M4 | P3 编码 + 测试 | ⏳ |
| M5 | P4 编码 + 测试 | ⏳ |
| M6 | P5 编码 + 测试 | ⏳ |
| M7 | 测试报告 + UI 验收截图 + 合并 main | ⏳ |
