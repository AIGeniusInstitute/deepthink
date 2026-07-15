# Agent PaaS Phase 3 — PRD

**日期**：2026-07-15
**分支**：`feat/agent-paas-phase3`
**范围**：Phase 2 PRD §9 列出的 6 项 Phase 3 候选 + embedding 配置页

## 1. 背景

Phase 1（用户级 Agent + 知识库 + 市场）和 Phase 2（文档扩展 + 向量检索 + 审核 + 配额 + 评分 + 版本）已交付。Phase 2 的已知限制：

1. 向量检索使用线性扫描，单 KB 上限 1000 文档
2. embedding API 配置需手工编辑 `data/config/embedding.json`，无前端
3. Agent 不可分享，无协作
4. 版本历史仅可回滚，无 diff 视图
5. 评分不可举报

Phase 3 目标：规模化 + 协作化 + 易用性闭环。

## 2. 范围

### 2.1 sqlite-vec 向量索引（规模化）

**问题**：Phase 2 的 `vectorSearchKbDocuments` 线性扫描所有文档，O(N × dims)。1000 文档 × 1536 维 ≈ 6MB 内存，< 50ms。超过 1000 时性能退化明显。

**方案**：集成 [sqlite-vec](https://github.com/asg016/sqlite-vec) loadable extension，使用 `vec0` 虚拟表建索引。

- 启动时通过 `better-sqlite3.loadExtension()` 加载 `sqlite-vec0` 扩展
- DB schema v49 → v50，新增 `kb_documents_vec` 虚拟表（`vec_embedding FLOAT[1536]`）
- 文档嵌入时同步写入 vec 表
- `vectorSearchKbDocuments` 改为 `SELECT ... FROM kb_documents_vec WHERE vec_embedding MATCH ? ORDER BY distance LIMIT k`

**容错**：扩展加载失败时，自动回退到 Phase 2 的线性扫描实现（保留 `vectorSearchKbDocumentsLinear` 函数）。

### 2.2 独立 embedding 配置页（易用性）

**问题**：Phase 2 要求用户手工编辑 `data/config/embedding.json`，UX 差。

**方案**：在 `SettingsPage` 新增 `EmbeddingSettingsSection`：

- baseUrl（默认 `https://api.openai.com/v1`）
- apiKey（password 输入，提交后 AES-256-GCM 加密存储）
- model（默认 `text-embedding-3-small`）
- dimensions（默认 1536）
- 「测试连接」按钮：调用 `embedText("hello")` 验证可用性
- 仅 admin 可编辑，member 只读查看 model 名

**路由**：
- `GET /api/paas/embedding-config`（admin 完整字段，member 仅返回 `{ model, dimensions }`）
- `PUT /api/paas/embedding-config`（adminRoleMiddleware）

### 2.3 Agent 分享链接（协作化）

**问题**：Agent 不可分享，用户只能在自己账户内使用。

**方案**：Agent owner 可生成「只读分享链接」：

- `POST /api/paas/agents/:id/share` → 生成 `share_token`（UUID），写入 `agent_shares` 表
- `GET /api/paas/share/:token`（公开，无需认证）→ 返回 Agent 元信息（name / description / systemPrompt 脱敏后预览 / model / mounts 数量，不暴露完整 prompt）
- `POST /api/paas/share/:token/install`（需认证）→ 当前用户一键安装到自己的 Agent 定义，生成新 ID
- 前端 AgentStudioPage 每个 Agent 卡片新增「分享」按钮 + 弹窗显示 share URL
- 前端新增 `/share/:token` 公开页（`SharePage.tsx`）显示 Agent 信息 + 「安装到我的账户」按钮

**DB 新表**：`agent_shares(id, agent_def_id, share_token, created_by, created_at, expires_at, install_count)`

### 2.4 多人协作（协作化）

**问题**：Agent 只能 owner 编辑，团队成员无法共同维护。

**方案**：Agent owner 可邀请其他用户作为 collaborator：

- `agent_collaborators(agent_def_id, user_id, role, added_by, added_at)` 新表，role = `editor` / `viewer`
- `POST /api/paas/agents/:id/collaborators` → 添加 collaborator（owner only）
- `DELETE /api/paas/agents/:id/collaborators/:userId` → 移除
- `GET /api/paas/agents/:id/collaborators` → 列出
- `paasAgentsRoute.use('*', (c, next) => ...)` 加 collaborator 检查：editor 可 PATCH / mounts，viewer 只读
- 前端 AgentStudioPage 新增 `CollaboratorsSection`，显示 collaborator 列表 + 邀请输入框 + 移除按钮

### 2.5 版本 diff 视图（易用性）

**问题**：Phase 2 版本历史只能回滚，看不到「改了什么」。

**方案**：版本对比可视化：

- 后端：`GET /api/paas/agents/:id/versions/:vid/diff` → 返回 `{ current: {...}, target: {...}, fields: [{ name, before, after }] }`，仅对比 prompt / model / max_turns / temperature / enabled / mounts（JSON stringify）
- 前端 AgentStudioPage 版本历史行新增「对比」按钮 → `VersionDiffDialog`
  - 显示字段级 before / after 表格
  - systemPrompt 用 `<pre>` diff 显示（逐字符行对比，新增行绿色 / 删除行红色）
  - 顶部「回滚到该版本」按钮

### 2.6 评分举报（治理）

**问题**：marketplace 评论不可举报，恶意内容无法处理。

**方案**：

- `marketplace_review_reports(id, review_id, reporter_id, reason, status, created_at, handled_by, handled_at)` 新表
- `POST /api/paas/marketplace/reviews/:id/report` → 举报（reason 必填，最长 500）
- `GET /api/paas/admin/review-reports` → admin 查看待处理列表
- `POST /api/paas/admin/review-reports/:id/resolve` → admin 处理（action: `dismiss` / `delete_review`）
- 前端 MarketplacePage 详情抽屉每条评论增加「举报」按钮 + 弹窗（reason + submit）
- 前端 UsersPage 新增「评论举报」tab（admin 可见）显示待处理队列

## 3. 用户故事

### US1：知识库大规模检索
作为拥有 5000+ 文档的企业用户，我希望 KB 向量检索能在 100ms 内完成，避免线性扫描的延迟。

### US2：embedding 配置前端化
作为 admin，我希望在 Settings 页面配置 embedding API，而不是手工编辑 JSON 文件。

### US3：Agent 分享
作为 Agent creator，我希望生成只读分享链接，让团队成员快速安装复用。

### US4：Agent 协作
作为 Agent owner，我希望邀请同事共同编辑 Agent（prompt 迭代、mount 调整）。

### US5：版本对比
作为 Agent 维护者，我希望看到 v3 和当前版本的具体差异，再决定是否回滚。

### US6：评论治理
作为 admin，我希望处理用户举报的恶意评论，删除或驳回。

## 4. 假设（A1-A14）

- A1：sqlite-vec 通过 npm 安装 `sqlite-vec` 包，提供 `getLoadablePath()` 返回平台对应的 `.dylib/.so/.dll`。better-sqlite3 的 `db.loadExtension()` 加载。
- A2：扩展加载失败（平台不支持 / 缺二进制）时，启动日志 WARN，回退线性扫描，不阻断启动。
- A3：`kb_documents_vec` 虚拟表通过 `CREATE VIRTUAL TABLE USING vec0(embedding FLOAT[1536], doc_id TEXT)` 建立。
- A4：dimensions 由 embedding config 决定，默认 1536；config 变更时不自动 reindex，提供「重建索引」按钮。
- A5：Agent 分享链接永久有效（`expires_at` 可空），owner 可主动 revoke（DELETE）。
- A6：分享链接的 systemPrompt 预览只显示前 200 字符 + `...`，完整 prompt 仅在 install 后可见。
- A7：collaborator role 只有 `editor` / `viewer` 两档，不细分权限。
- A8：owner 不能把自己加为 collaborator（隐式拥有所有权限）。
- A9：collaborator 不能删除 Agent（仅 owner）。
- A10：版本 diff 仅对比 JSON-serializable 字段；mounts 数组按 `resourceType:resourceId` 排序后对比。
- A11：systemPrompt diff 按行对比（`diffLines` 简单实现，新增 + / 删除 -）。
- A12：评论举报 reason 必填，最长 500 字符；同一用户对同一 review 只能举报一次（UNIQUE(review_id, reporter_id)）。
- A13：admin 处理举报时 `delete_review` 会级联删除举报记录（CASCADE），`dismiss` 仅标记 `status='dismissed'`。
- A14：embedding config 的 apiKey AES-256-GCM 加密，复用 `runtime-config.ts` 的 `encryptValue` 机制。

## 5. 验收标准

- AC1：`make build` + 三端 `tsc --noEmit` 全部通过
- AC2：sqlite-vec 扩展加载成功时，10000 文档 KB 向量检索 < 100ms（无实测环境时降级为「代码 review + 扩展加载日志确认」）
- AC3：扩展加载失败时，系统正常启动，向量检索回退到线性扫描
- AC4：前端 Settings 页面有 EmbeddingSettingsSection，admin 可填写并保存配置
- AC5：admin 可点击「测试连接」按钮验证 embedding API 可用性
- AC6：Agent owner 可生成 share URL，公开页 `/share/:token` 显示 Agent 元信息
- AC7：登录用户在 share 页可点击「安装到我的账户」，生成新 Agent 定义
- AC8：Agent owner 可邀请 collaborator，editor 可修改 Agent，viewer 只读
- AC9：owner 不能删除自己创建的 Agent 中自己的 collaborator 记录之外的权限
- AC10：版本历史每行有「对比」按钮，diff 弹窗显示 before/after 字段
- AC11：systemPrompt diff 按行显示 + / - 标记
- AC12：marketplace 详情抽屉的每条评论有「举报」按钮，提交后进入 admin 待处理队列
- AC13：admin 可在 Users 页「评论举报」tab 看到 pending 举报，可 dismiss 或 delete_review
- AC14：DB schema v49 → v50（+ agent_shares / agent_collaborators / marketplace_review_reports 三张表 + kb_documents_vec 虚拟表）

## 6. 不做（Phase 4）

- Agent 分享的市场化（分享链接内的 install_count 排行）
- collaborator 的细粒度权限（只编辑 prompt 不能改 mount 等）
- 版本 diff 的三向对比（base / target / current）
- 评论举报的自动检测（关键词 / 语义）
- embedding 模型微调
- 向量索引的 HNSW 算法（sqlite-vec 默认用 KNN，已够用）

## 7. 工作量评估

| 子项目 | 后端 | 前端 | 复杂度 |
|--------|------|------|--------|
| sqlite-vec 集成 | 中 | - | 中（原生扩展加载有平台风险） |
| embedding 配置页 | 低 | 中 | 低 |
| Agent 分享 | 中 | 中 | 中 |
| 多人协作 | 中 | 中 | 中（权限矩阵） |
| 版本 diff | 低 | 中 | 低 |
| 评分举报 | 中 | 中 | 低 |

合计约 1.5 倍 Phase 2 工作量。
