# 技术方案 — AgentNet Disk 文件网盘 MVP

> 对应 PRD `docs/prd/disk/PRD.md`。在 DeepThink 现有架构（Hono + SQLite + 本地 fs + 现有 group 作用域文件路由）上增量实现。

## 1. 架构决策

### 1.1 不另起微服务栈（关键决策）
PRD 描述的 MinIO+PG+Redis+OnlyOffice 微服务栈与现有架构冲突，且 Docker/MinIO/OnlyOffice 需额外环境。现有 DeepThink 已有 group 作用域文件管理底座（routes/files.ts 1411 行 + FilePanel.tsx 1357 行），**MVP 在其上增量补齐 6 个能力**：独立网盘页 / 搜索 / 移动重命名 / 回收站 / 版本历史 / Agent disk_* 工具。

### 1.2 文件存储保持本地 fs（不引入内容寻址分片）
- 现有 `data/groups/{folder}/` 本地 fs 存储，配额校验已就绪
- 回收站用 `data/groups/{folder}/.trash/{trashId}/` 子目录
- 版本快照用 `data/groups/{folder}/.versions/{base64path}/{versionNum}.bin` + DB 元数据
- 内容寻址分片去重（P2，speculative，不进 MVP）

### 1.3 复用现有权限模型（不引入文件级 RBAC）
- `authMiddleware` + `canAccessGroup` + `group_members` 提供工作区级隔离
- 文件级 RBAC+ABAC（P1，需真实多租户场景驱动，不 speculative 实现）

## 2. 数据库变更（schema_version 63 → 64）

新增 2 表，迁移幂等（`CREATE TABLE IF NOT EXISTS`）。文件路径用 group 内相对路径（与现有 file-manager 一致）。

```sql
-- 回收站
CREATE TABLE IF NOT EXISTS file_trash (
  id            TEXT PRIMARY KEY,           -- uuid
  group_folder  TEXT NOT NULL,             -- 作用域
  trash_id      TEXT NOT NULL,             -- .trash/{trashId} 子目录
  original_path TEXT NOT NULL,             -- 原相对路径
  name          TEXT NOT NULL,
  is_folder     INTEGER DEFAULT 0,         -- bool
  size_bytes    INTEGER DEFAULT 0,
  deleted_by    TEXT NOT NULL,             -- user.id
  deleted_at    TEXT NOT NULL DEFAULT (datetime('now')),
  entry_json    TEXT                       -- 原始 FileEntry 快照 JSON
);
CREATE INDEX IF NOT EXISTS idx_file_trash_group ON file_trash(group_folder, deleted_at);

-- 版本历史
CREATE TABLE IF NOT EXISTS file_versions (
  id            TEXT PRIMARY KEY,           -- uuid
  group_folder  TEXT NOT NULL,
  file_path     TEXT NOT NULL,             -- 相对路径
  version_num   INTEGER NOT NULL,          -- 递增
  content_ref   TEXT,                      -- .versions/{path}/{n}.bin 相对 ref
  size_bytes    INTEGER NOT NULL DEFAULT 0,
  mime_type     TEXT,
  created_by    TEXT NOT NULL,
  created_at    TEXT NOT NULL DEFAULT (datetime('now')),
  comment       TEXT,
  UNIQUE (group_folder, file_path, version_num)
);
CREATE INDEX IF NOT EXISTS idx_file_versions_path ON file_versions(group_folder, file_path, version_num);
```

## 3. 后端实现

### 3.1 新路由 `routes/disk.ts`（挂载 `/api/groups/:jid`）
复用 `file-manager.ts` 的 `validateAndResolvePath` / `getFileRoot` / `listFiles`，新增 handler：

| 方法 | 路径 | 功能 |
|---|---|---|
| GET | `/:jid/files/search?q=` | 递归文件名搜索（fs.walk + minimatch/glob，或简单 includes） |
| POST | `/:jid/files/move` | body `{source, targetDir}`；校验 targetDir 非 source 子目录；fs.rename 跨目录 |
| POST | `/:jid/files/rename` | body `{path, newName}`；校验同目录无重名 |
| GET | `/:jid/files/trash` | 列 file_trash by group_folder |
| POST | `/:jid/files/trash/:id/restore` | 恢复（move 回原路径，冲突加后缀，删表） |
| DELETE | `/:jid/files/trash/:id` | 彻底删（物理 rm + 删表） |
| DELETE | `/:jid/files/trash` | 清空 |
| GET | `/:jid/files/versions/:path` | 版本列表 |
| GET | `/:jid/files/versions/:path/:version` | 版本内容 |
| POST | `/:jid/files/versions/:path/:version/restore` | 回滚（当前存为新版本） |

**软删除改造**：修改现有 `DELETE /:jid/files/:path`，由直接 `deleteFile` 改为：生成 trashId → `fs.rename` 到 `.trash/{trashId}/` → INSERT file_trash。回收站彻底删才走原 `deleteFile` 物理 rm。

**版本快照注入**：修改 `PUT /:jid/files/content/:path` 和 `PUT /:jid/files/binary/:path`，保存前若文件已存在，读旧内容 → 写 `.versions/{base64path}/{n}.bin` → INSERT file_versions（保留最近 20 版，超限删最旧）。

### 3.2 file-manager.ts 新增导出
- `moveFile(folder, source, targetDir, rootOverride)` — 校验 + fs.rename
- `renameFile(folder, path, newName, rootOverride)` — 校验 + fs.rename
- `softDelete(folder, relativePath, rootOverride)` — 移到 .trash/{trashId}/，返回 trashId + entry 快照
- `restoreFromTrash(folder, trashId, rootOverride)` — 移回原路径（冲突加后缀）
- `searchFiles(folder, query, rootOverride)` — 递归 walk + 名字匹配，返回 FileEntry[]
- `listVersions(folder, filePath, rootOverride)` / `getVersionContent(folder, filePath, version, rootOverride)` / `saveVersionSnapshot(folder, filePath, content, rootOverride)` / `restoreVersion(folder, filePath, version, rootOverride)`
- `writeFileContent`（既有）/ `writeBinary`（既有）保存前 hook saveVersionSnapshot

### 3.3 Agent disk_* MCP 工具
文件：`container/agent-runner/src/mcp-tools.ts`，在 `createMcpTools(ctx)` 追加 7 个 `tool()`：

```ts
// disk_list —— 列目录
tool({ name: 'disk_list', description: '列出网盘指定目录文件', params: z.object({
  folder_id: z.string().optional().describe('目录相对路径，默认根') }),
  handler: async ({folder_id}) => { /* fs.readdirSync(workspacePath/folder_id) → FileEntry[] */ }
})
// disk_upload —— 保存文件
tool({ name: 'disk_upload', description: '上传内容到网盘', params: z.object({
  folder_id: z.string(), file_name: z.string(),
  content: z.string().describe('文本内容或 base64（带 data: 前缀判别）') }),
  handler: async (...) => { /* fs.writeFileSync */ }
})
// disk_download —— 读取
tool({ name: 'disk_download', description: '读取网盘文件内容', params: z.object({
  file_id: z.string().describe('相对路径') }),
  handler: async (...) => { /* fs.readFileSync，二进制转 base64 */ }
})
// disk_create_folder / disk_search / disk_move / disk_delete 同理
```

路径解析用 `path.join(ctx.workspaceGroup, relPath)` + 复用 file-manager 的 traversal 校验逻辑（agent-runner 内可引入 file-manager 或复制 validateAndResolvePath 精简版）。

## 4. 前端实现

### 4.1 新页面 `web/src/pages/DiskPage.tsx`
- 复用 `components/chat/FilePanel.tsx` 的预览/上传/编辑逻辑（提取公共子组件或直接复用 store）
- 左侧：工作区切换器（`useChatStore` 的 groups）+ 文件夹树（递归 listFiles）
- 主区：工具栏（搜索框、新建文件夹、上传、视图切换）+ 文件列表/网格
- 右侧抽屉/Tab：回收站
- 路由 `App.tsx` 加 `<Route path="/disk" element={<Suspense><DiskPage/></Suspense>} />`
- `UnifiedSidebar` nav-items 加「网盘」项

### 4.2 扩展 `stores/files.ts`
- 加 `searchFiles(q)`、`moveFile(source,targetDir)`、`renameFile(path,newName)`
- 加 `loadTrash()`、`restoreTrashItem(id)`、`purgeTrashItem(id)`、`emptyTrash()`
- 加 `loadVersions(path)`、`restoreVersion(path,version)`
- `deleteFile` 改为软删除（后端已改，前端无需感知，列表刷新即可）

### 4.3 api/client.ts
新增对应 fetch 调用，复用 `api.get/post/put/delete` + `toBase64Url` 路径编码。

## 5. 文件清单（改动）
| 文件 | 改动 |
|---|---|
| `src/db.ts` | +file_trash/file_versions 表，schema_version 63→64 |
| `src/file-manager.ts` | +move/rename/softDelete/restore/search/version 函数 |
| `src/routes/files.ts` | 改 DELETE 软删除；改 PUT content/binary 注入版本快照 |
| `src/routes/disk.ts` (新) | search/move/rename/trash/versions 路由，挂载 groups |
| `src/web.ts` | 注册 diskRoutes |
| `container/agent-runner/src/mcp-tools.ts` | +7 disk_* 工具 |
| `web/src/pages/DiskPage.tsx` (新) | 网盘全页 |
| `web/src/stores/files.ts` | +search/move/rename/trash/version 方法 |
| `web/src/api/client.ts` | +对应 API |
| `web/src/App.tsx` | +/disk 路由 |
| `web/src/components/layout/UnifiedSidebar.tsx` 或 nav-items | +网盘导航 |

## 6. 退出条件（Goal-Driven）
全部 AC1.1-6.5 + T7 零回归 + T8 系统测试通过，UI 截图存档，测试报告写入 `docs/test_report/disk/`，合并 main push。
