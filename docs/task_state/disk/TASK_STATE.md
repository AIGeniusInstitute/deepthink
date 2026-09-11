# AgentNet Disk — 任务状态

## 需求
企业级 Agent 平台文件网盘：文件管理 / 预览 / 在线编辑 / 上传下载 / 权限 / Agent 交互工具 / 回收站 / 版本管理。

## 里程碑进度

| 阶段 | 状态 | 说明 |
|------|------|------|
| intent | ✅ 完成 | `docs/intent/disk/INTENT.md` |
| prd | ✅ 完成 | `docs/prd/disk/PRD.md`（MVP 6 功能点 F1-F6 + AC + 8 用例）|
| tech_solution | ✅ 完成 | `docs/tech_solution/disk/TECH_SOLUTION.md` |
| coding | ✅ 完成 | 后端+前端+Agent 工具全部编码 |
| test | ✅ 完成 | tsc 0 error + smoke 122/122 零回归 |
| deploy | ✅ 完成 | 9999 服务部署 health=ok |
| ui_test | ✅ 完成 | playwright 8/9 PASS（1 项选择器误报非缺陷）|
| test_report | ✅ 完成 | `docs/test_report/disk/` |
| merge | ⏳ 待执行 | 合并 worktree → main |

## 编码产物清单

### 后端
| 文件 | 改动 |
|------|------|
| `src/db.ts` | +file_trash / file_versions 两表（schema_version 63→64）|
| `src/file-manager.ts` | +moveFile/renameFile/searchFiles/moveToTrash/restoreFromTrash/purgeTrash/saveVersionSnapshot/readVersionContent/pruneVersionSnapshots/emptyTrash |
| `src/routes/files.ts` | +9 路由（search/move/rename/trash CRUD/versions list+restore）+ DELETE 改软删 + PUT 自动版本快照 |
| `container/agent-runner/src/mcp-tools.ts` | +7 disk_* 工具（list/upload/download/create_folder/search/move/delete）|

### 前端
| 文件 | 改动 |
|------|------|
| `web/src/stores/files.ts` | +9 store 方法（search/move/rename/trash/version）|
| `web/src/components/layout/nav-items.ts` | +网盘 nav 项 |
| `web/src/App.tsx` | +/disk 路由 lazy |
| `web/src/pages/DiskPage.tsx` | 新增独立全页（工作区切换器+FilePanel 复用+搜索弹窗+回收站抽屉）|

## 关键决策
1. **演进而非重写**：PRD 指定 MinIO+PG+OnlyOffice，实际栈 TS+SQLite+本地 fs。按 Surgical Changes 在现有架构上扩展，重基建留 P1/P2。
2. **复用 FilePanel**：1357 行既有文件管理组件直接复用，DiskPage 仅加外层壳（工作区切换+搜索+回收站）。
3. **软删除+版本快照 best-effort**：DELETE→.trash+DB 元数据（失败回滚恢复）；PUT→.versions 快照（失败仅 warn 不阻塞写）。
4. **Agent 工具零侵入**：disk_* 工具走既有 MCP tool() helper，不重构 IPC 层。

## 验证结果
- 后端 `npx tsc --noEmit` exit 0
- 前端 `npx tsc --noEmit` exit 0 + `npm run build` 10.34s 成功
- `make test-smoke` 10 文件 122 测试全 PASS 零回归
- 9999 部署 health=ok
- playwright UI 8/9 PASS（登录/网盘页/工作区切换/文件列表/搜索176结果/回收站/新建文件夹）
