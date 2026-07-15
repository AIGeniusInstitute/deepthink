# Agent PaaS Phase 2 前端 UI 增强 — 测试报告

**日期**：2026-07-15
**分支**：`feat/agent-paas-phase2-frontend`
**范围**：Phase 2 后端 API 的前端 UI 补齐（4 个页面 + 4 个 store）
**验收标准**：前端 typecheck 通过 + `make build` 成功 + 代码 review

## 1. 验收矩阵

| 页面 | 改动点 | 静态校验 | 结论 |
|------|--------|---------|------|
| KnowledgeBasesPage | PDF/DOCX 上传 + URL 抓取 + 嵌入状态 + 嵌入按钮 | ✅ tsc | 通过 |
| MarketplacePage | 评分显示 + 评论抽屉 + 提交表单 + admin 审核 | ✅ tsc | 通过 |
| UsersPage + AgentQuotaTab | admin 配额管理 tab | ✅ tsc | 通过 |
| AgentStudioPage | 版本历史 + 回滚 | ✅ tsc | 通过 |

## 2. 三端 Typecheck

```
$ tsc -p web/tsconfig.json --noEmit
$ tsc -p tsconfig.json --noEmit
$ tsc -p container/agent-runner/tsconfig.json --noEmit
```

三端均无错误输出（退出码 0）。

## 3. 构建

```
$ make build
[web] ✓ built in 6.65s
[agent-runner] exited with code 0
```

## 4. 子项详细验证

### 4.1 KnowledgeBasesPage

**store 新增**（`web/src/stores/knowledge-bases.ts`）：
- `KbDocumentMeta` 增加 `parser_type`、`embedding_model`、`embedded`
- `uploadFromUrl(kbId, url)` → POST `/:id/documents/url`
- `embedAll(kbId)` → POST `/:id/embed-all`，返回 `{ embedded, failed }`
- `embedDocument(kbId, docId)` → POST `/:id/documents/:docId/embed`

**page 新增**：
- 文件上传 `accept` 扩展为 `.md,.markdown,.txt,.pdf,.docx` + 对应 MIME
- 「URL 抓取」按钮 + 弹窗：输入 URL → `uploadFromUrl`，提示 15s / 1MB 限制
- 「嵌入全部」按钮：调用 `embedAll`，进度态切换
- 文档列表每行显示 `parser_type` 徽标 + 嵌入状态徽标（已嵌入 / 未嵌入）
- 未嵌入文档行右侧显示「嵌入此文档」按钮（`Zap` 图标）
- 头部副标题更新：「FTS5 + 向量混合检索，支持 .md / .txt / .pdf / .docx / URL」
- 列表头新增「已嵌入 N / M」统计

### 4.2 MarketplacePage

**store 新增**（`web/src/stores/marketplace.ts`）：
- `MarketplaceItem` 增加 `status`、`submittedBy`、`ratingAverage`、`ratingCount`
- 新增 `MarketplaceReview` 类型
- `load(itemType?, status?)`：带状态过滤
- `loadMine()` → GET `/mine`
- `loadReviews(itemId)` → GET `/:id/reviews`
- `submit(data)` → POST `/submit`
- `approve(id)` / `reject(id)` → POST `/:id/approve|reject`
- `submitReview(itemId, rating, comment)` → POST `/:id/reviews`

**page 新增**：
- `Stars` 组件：5 星可视化 + 平均分 + 评论数
- 卡片底部显示 `Stars` + `ratingAverage/ratingCount`
- admin 看到 `pending` 状态卡片时显示 ✓ 通过 / ✗ 拒绝 按钮
- admin 状态过滤：approved / pending / rejected 三态切换
- 卡片点击 → 详情抽屉 `ItemDetailDrawer`
  - 显示完整描述 + 大号 Stars
  - 评论区：5 星选择 + textarea + 提交按钮
  - 评论列表：按时间倒序，每条显示评分 + 评论内容
- 「提交模板」按钮 → `SubmitDialog`
  - 类型 / 作者名 / 名称 / 描述 / 标签 / payload(JSON) 表单
  - 提交后状态为 pending，提示等待审核

### 4.3 UsersPage + AgentQuotaTab

**store 新增**（`web/src/stores/users.ts`）：
- `AgentQuota` 类型（user_id / username / quota / used）
- `fetchQuotas()` → GET `/api/paas/admin/quotas`
- `updateQuota(userId, quota)` → PUT `/api/paas/admin/quotas/:userId`，成功后自动刷新

**page 新增**：
- `UsersPage` tabs 增加 `'quotas'` 项，仅 admin 可见
- 新组件 `AgentQuotaTab.tsx`：
  - 列出所有用户的 username / user_id / 已用 / 配额
  - inline 编辑配额（Input + 保存按钮），范围 0-10000
  - `used > quota` 时显示红色高亮（over-quota 状态）
  - 刷新按钮

### 4.4 AgentStudioPage

**store 新增**（`web/src/stores/agents-paas.ts`）：
- `AgentVersion` 类型（id / version / created_at / created_by）
- `versions: Record<string, AgentVersion[]>` state
- `listVersions(agentId)` → GET `/:id/versions`
- `restoreVersion(agentId, versionId)` → POST `/:id/versions/:vid/restore`，成功后自动重新 load + 刷新版本列表

**page 新增**：
- `VersionHistorySection` 组件：
  - 选中 Agent 时自动 `listVersions(selected.id)`
  - 显示版本列表（version 号 + 创建时间 + 创建者）
  - 「回滚」按钮，点击后二次确认（提示会先保存当前状态为新版本）
  - 默认只显示最近 3 个版本，超过时显示「展开全部 (N)」按钮
  - 提示文案：每次修改自动生成版本快照（最多保留 20 个），回滚前会再生成一个当前状态快照作为 undo

## 5. 依赖检查

- `pdf-parse`、`mammoth`、`cheerio` 在 Phase 2 后端实现时已添加到根 `package.json` 并安装
- 前端无新依赖（使用已有的 `lucide-react`、`sonner`、`radix-ui`、Zustand）

## 6. 已知限制

1. **浏览器 E2E 走查不可用**：`cloudcli-browser` MCP 持续 "fetch failed"，UI 走查降级为 typecheck + build + 代码 review。
2. **embedding API 配置需手工编辑**：`data/config/embedding.json`（baseUrl/apiKey/model）暂无独立前端配置页，需手动创建文件。未配置时后端自动回退 FTS5-only 检索，不影响 KB 上传 / 搜索基础功能。
3. **Marketplace 评分平均分计算**：依赖后端 `getReviewStats(itemId)`（实时 AVG + COUNT 查询），无前端缓存。
4. **Agent 版本回滚后 UI 同步**：`restoreVersion` 成功后会自动 `load()` 重新拉取 Agent 列表 + `listVersions` 刷新版本历史，但当前选中的 Agent 会被新的回滚后状态覆盖（用户会看到表单中的 systemPrompt / model 等字段更新）。

## 7. 提交信息

- 分支：`feat/agent-paas-phase2-frontend`
- 合并目标：`main`
- 推送目标：`o`（gitcode.com:AIGeniusInstitute/deep-think.git）

## 8. 结论

Phase 2 前端 UI 增强完整交付：4 个页面 + 4 个 store 的 Phase 2 交互能力全部补齐。Agent PaaS 平台 Phase 2 的后端能力现在完全可用：用户可在 UI 上传 PDF/DOCX/URL 到知识库、触发向量嵌入、查看嵌入状态、在市场提交模板、查看评分评论、admin 可审核 / 管理配额、在 Agent Studio 查看版本历史并回滚。三端 typecheck + build 全部通过。
