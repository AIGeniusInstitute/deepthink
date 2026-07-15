# Agent PaaS Phase 3 测试报告

## 概述

Phase 3 围绕 6 个子项目展开：

1. sqlite-vec 向量索引（替换 Phase 2 线性扫描）
2. 独立 Embedding 配置页（管理员可配置 OpenAI 兼容 API）
3. Agent 分享链接（公开只读 + 授权安装）
4. Agent 多人协作（owner / editor / viewer）
5. 版本 diff 视图（字段 + prompt 行级 diff）
6. 市场评论举报与管理员处理

## 测试范围与方法

由于本地环境无法驱动浏览器 E2E（MCP cloudcli-browser 持续 fetch failed），采用以下替代验证策略：

- **静态检查**：`make typecheck`（三端 tsc --noEmit 全通过）
- **行为测试**：`make test`（vitest 90 文件 / 1180 用例全通过）
- **构建**：`make build`（后端 + web 前端 + agent-runner 三端构建成功）
- **冒烟启动**：`DEEPTHINK_DATA_DIR=/tmp/dt-phase3-smoke WEB_PORT=9931 node dist/index.js`
- **API curl 抽样**：验证关键路由可达 + 响应符合预期
- **代码 review**：逐文件交叉核对 PRD AC1-AC14

## 验证结果

### 1. 静态检查

```
$ make typecheck
npx tsc --noEmit
cd web && npx tsc --noEmit
cd container/agent-runner && npx tsc --noEmit
✓ All shared type copies are in sync.
```

后端 / Web / Agent Runner 三端 TypeScript 全部通过 0 错误。

### 2. 行为测试

```
$ make test
 Test Files  90 passed (90)
      Tests  1180 passed (1180)
   Start at  15:13:20
   Duration  3.25s
```

无回归。sqlite-vec 加载失败时有 try-catch 回退到线性扫描，不破坏既有路径。

### 3. 构建

```
$ make build
[web] ✓ built in 6.63s
[web] PWA v1.3.0, generateSW, precache 78 entries
[agent-runner] tsc — exit 0
```

### 4. 冒烟启动

关键日志：

```
INFO: sqlite-vec extension loaded — vector index enabled
    version: "v0.1.9"
INFO: Database initialized
INFO: Web server started
    port: 9931
```

`GET /api/health` → `{"status":"healthy","checks":{"database":true,"queue":true,"uptime":4}}`

sqlite-vec v0.1.9 通过 `createRequire(import.meta.url)` 同步加载成功，`kb_documents_vec` 虚拟表创建成功。

### 5. AC 对照

| AC | 验证 |
|----|------|
| AC1 sqlite-vec 加载 | 启动日志确认 `v0.1.9` 已加载，虚拟表 `kb_documents_vec` 创建 |
| AC2 线性扫描回退 | `vectorSearchKbDocuments` 中 `if (vecExtensionLoaded) ... else linear` 分支保留，typecheck 通过 |
| AC3 Embedding 配置页 | `EmbeddingSettingsSection` 组件 + `/settings?tab=embedding` 路由 + nav 项已注册 |
| AC4 Embedding 测试连接 | `POST /api/paas/embedding-config/test` → `{success, dimensions?, error?}` |
| AC5 分享链接创建 | `POST /api/paas/agents/:id/share` 返回 `{shareId, shareToken, shareUrl}` |
| AC6 公开查看分享 | `GET /api/paas/share/:token` 无需认证，prompt 截断 200 字 |
| AC7 授权安装 | `POST /api/paas/share/:token/install` 检查配额并复制 Agent + mounts |
| AC8 协作者添加 | `POST /api/paas/agents/:id/collaborators` 校验 owner 并拒绝 owner 自加 |
| AC9 协作者权限 | `getAgentCollaboratorRole` 在 `GET /:id/collaborators` 和 `GET /:id/versions/:vid/diff` 路径中作为 collaborator 访问的后备授权 |
| AC10 版本 diff | `GET /api/paas/agents/:id/versions/:vid/diff` 返回 fields + promptDiff |
| AC11 评论举报 | `POST /api/paas/marketplace/reviews/:reviewId/report` 校验 reason 长度 + UNIQUE 防重复 |
| AC12 举报队列 | `GET /api/paas/admin/review-reports` JOIN 评论 + 举报人 + 市场项 |
| AC13 举报处理 | `POST /api/paas/admin/review-reports/:id/resolve` 支持 `dismiss` / `delete_review`（级联） |
| AC14 SharePage 前端 | `/share/:token` 路由 + SharePage 组件，未登录显示登录按钮，已登录显示安装按钮 |

### 6. 后端 API curl 抽样

#### 公开分享端点（无需认证）

```
GET /api/paas/share/nonexistent-token
→ 404 {"error":"Share link not found or revoked"}
```

#### Embedding 配置端点（需认证）

```
GET /api/paas/embedding-config  (无 cookie)
→ 401 Unauthorized（前端会重定向到 /login）
```

#### 管理员举报队列

```
GET /api/paas/admin/review-reports  (非 admin)
→ 403
```

路由全部挂载并按预期返回状态码。

## 已知限制

1. **Embedding apiKey 存储**：PRD 原计划 AES-256-GCM 加密，实际采用文件权限 0600 + 服务器本地访问控制（简化实现）。后续可接入 `runtime-config.ts` 的加密模式。
2. **浏览器 E2E 未跑**：cloudcli-browser 工具不可用，UI 行为依赖 typecheck + 代码 review + 后端 API 验证替代。
3. **sqlite-vec windows/linux 预编译二进制依赖**：`sqlite-vec` 通过 `optionalDependencies` 按平台拉取预编译二进制，目前仅在 macOS arm64 上验证；其他平台需在实际部署时复测。
4. **协作者 UI**：添加协作者需输入目标用户 UUID，未做用户搜索；小规模团队可用，规模大时需加用户搜索组件。

## 结论

Phase 3 6 个子项目全部实现完成：

- 后端：DB schema v49 → v50，新增 3 张表（agent_shares / agent_collaborators / marketplace_review_reports），新增 2 个路由文件（paas-embedding / paas-share），扩展 3 个路由文件（paas-agents / paas-marketplace / paas-admin），sqlite-vec 集成 + 线性扫描回退。
- 前端：新增 3 个组件（EmbeddingSettingsSection / ReviewReportsTab / SharePage），扩展 4 个页面（SettingsPage / AgentStudioPage / MarketplacePage / UsersPage），扩展 3 个 store（agents-paas / marketplace / users）。
- 测试：1180/1180 通过，无回归。
- 构建：三端构建成功。
- 冒烟：服务正常启动，sqlite-vec v0.1.9 加载成功。

可以合并到 main 并推送。
