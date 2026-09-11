# PRD — AgentNet Disk 企业级 Agent 平台文件网盘（MVP）

> 范围裁定：在 DeepThink 现有架构（TS+SQLite+Hono+本地 fs+已有 group 作用域文件路由）上演进，不另起 MinIO+PG+OnlyOffice 微服务栈。理由见 `docs/intent/disk/INTENT.md`。

## 1. 背景与现状

DeepThink **已具备** group 作用域的完整文件管理底座：
- 后端 `routes/files.ts`（1411 行）：list/upload/download/preview/convert(LibreOffice)/content 读写/binary/html-docx/delete/createDirectory
- 前端 `FilePanel.tsx`（1357 行）：面包屑导航、11 种预览（image/text/markdown/pdf/html/video/audio/code/docx/xlsx/pptx）、拖拽上传、下载、删除、建目录
- 权限：Session-based + `canAccessGroup` + `group_members`（group 级隔离，admin/member 角色）

**现有系统缺失**（PRD 要求但未实现）：
| 能力 | 现状 | MVP 目标 |
|---|---|---|
| 独立网盘页面 | 仅 ChatPage 侧边 Tab | ✅ 独立 `/disk` 全页文件管理器 |
| 文件搜索 | 无 | ✅ 文件名递归搜索 |
| 移动/重命名 | 无 | ✅ move + rename 路由 |
| 回收站（软删除） | 硬删除 rm | ✅ 软删除 + 恢复 + 清空 |
| 版本历史 | 无 | ✅ 编辑自动快照 + 回滚 |
| Agent disk_* 工具 | 仅 send_file | ✅ 7 个 disk_* MCP 工具 |
| 分享链接 | 无 | ⏸ P1 |
| 文件级 RBAC+ABAC | group 级 | ⏸ P1 |
| 分片上传/秒传 | 直接上传 | ⏸ P1 |
| OnlyOffice 在线编辑 | LibreOffice 转换 + Monaco | ⏸ P2（现有已够用） |
| 审计日志 | 无 | ⏸ P1 |
| MinIO 内容寻址 | 本地 fs | ⏸ P2 |

## 2. MVP 功能点与验收标准

### F1. 独立网盘页面 `/disk`
**描述**：全页文件管理器，复用 FilePanel 逻辑，支持多工作区切换、文件夹树、面包屑、列表/网格视图。
**验收标准**：
- AC1.1 登录后侧边栏出现「网盘」导航项，点击进入 `/disk`
- AC1.2 页面左侧显示工作区切换器（用户有权限的所有 group），切换后右侧文件列表刷新
- AC1.3 文件夹树展示当前工作区目录结构，点击文件夹节点切换目录
- AC1.4 面包屑导航可逐级返回上层目录
- AC1.5 列表视图显示名称/大小/修改时间/类型图标；网格视图显示缩略图卡片
- AC1.6 上传（拖拽+点击）、下载、删除、新建文件夹、预览、编辑全部可用（复用现有路由）
- AC1.7 无 group 的用户显示空状态引导

### F2. 文件搜索
**描述**：在当前工作区内按文件名递归搜索。
**验收标准**：
- AC2.1 网盘页顶部有搜索框，输入关键词回车触发搜索
- AC2.2 后端 `GET /api/groups/:jid/files/search?q=keyword` 递归匹配文件名，返回路径/大小/修改时间
- AC2.3 搜索结果列表点击可定位到文件所在目录并高亮
- AC2.4 空关键词或 q 长度<1 返回空列表（不报错）

### F3. 移动 / 重命名
**描述**：文件/文件夹移动到另一目录、重命名。
**验收标准**：
- AC3.1 右键/操作菜单出现「移动」「重命名」选项
- AC3.2 `POST /api/groups/:jid/files/move` body `{source, targetDir}` 移动文件/文件夹，校验目标非源子目录（防循环）
- AC3.3 `POST /api/groups/:jid/files/rename` body `{path, newName}` 重命名，校验同目录无重名
- AC3.4 移动/重命名后文件列表刷新，路径正确更新

### F4. 回收站（软删除 + 恢复）
**描述**：删除文件/文件夹时移入回收站，可恢复或彻底清空。
**验收标准**：
- AC4.1 删除操作不直接 rm，而是记录到 `file_trash` 表 + 移动物理文件到 `{group}/.trash/{trashId}/`
- AC4.2 `GET /api/groups/:jid/files/trash` 返回回收站条目（原路径、名称、大小、删除时间、删除人）
- AC4.3 `POST /api/groups/:jid/files/trash/:id/restore` 将文件移回原路径（路径冲突则加 `_restored` 后缀）
- AC4.4 `DELETE /api/groups/:jid/files/trash/:id` 彻底删除（物理 rm + 删表）
- AC4.5 `DELETE /api/groups/:jid/files/trash` 清空整个回收站
- AC4.6 回收站页面（网盘页 Tab 或抽屉）展示条目 + 恢复/彻底删除按钮

### F5. 版本历史
**描述**：文本/二进制文件内容保存时自动留版本快照，可查看历史并回滚。
**验收标准**：
- AC5.1 新建 `file_versions` 表（file_path, version_num, content_ref 或 content blob, size, created_by, created_at, comment）
- AC5.2 `PUT /api/groups/:jid/files/content/:path` 和 `PUT .../binary/:path` 保存前自动写一条版本快照（保留前 N=20 个版本）
- AC5.3 `GET /api/groups/:jid/files/versions/:path` 返回版本列表
- AC5.4 `GET /api/groups/:jid/files/versions/:path/:version` 返回指定版本内容
- AC5.5 `POST /api/groups/:jid/files/versions/:path/:version/restore` 回滚到指定版本（当前内容也存为新版本）
- AC5.6 网盘预览/编辑面板有「版本历史」入口，展示列表 + 预览 + 回滚按钮

### F6. Agent disk_* MCP 工具
**描述**：Agent 经 MCP 工具操作网盘文件，覆盖 PRD 核心场景一（生成保存）+ 场景二（读取分析）。
**验收标准**：
- AC6.1 `container/agent-runner/src/mcp-tools.ts` 新增 7 个工具，zod schema 参数验证：
  - `disk_list`（folder_id?可选根，返回 FileEntry[]）
  - `disk_upload`（folder_id, file_name, content 文本或 base64）
  - `disk_download`（file_id/path，返回文本内容或 base64）
  - `disk_create_folder`（parent_id, name）
  - `disk_search`（keyword, file_type?）
  - `disk_move`（source, target_dir）
  - `disk_delete`（file_id/path，软删除）
- AC6.2 工具直接 fs 操作 workspace 路径（参照 memory 工具模式，走 IPC 不需要——agent-runner 本地 fs 可达）
- AC6.3 工具受 group 作用域约束（仅当前 workspace 目录内，路径遍历防护复用 validateAndResolvePath）
- AC6.4 在 Agent 对话中说「把这段内容保存成 report.md」→ Agent 调 disk_upload → 文件出现在网盘页
- AC6.5 说「读取 data.csv 并分析」→ Agent 调 disk_download → 返回内容 → 给出分析

## 3. 非功能要求
- **安全**：所有新路由复用 authMiddleware + canAccessGroup；路径遍历防护复用 validateAndResolvePath（O_NOFOLLOW 防 symlink TOCTOU）
- **多租户隔离**：复用 group_members，不引入文件级 RBAC（P1）
- **存储配额**：移动/恢复/版本回滚复用 checkStorageLimit
- **零回归**：现有 ChatPage 文件 Tab 功能不退化

## 4. 测试用例（映射 AC）
| 用例 | 覆盖 AC | 通过条件 |
|---|---|---|
| T1 访问 /disk 页面 | AC1.1-1.7 | 页面渲染、工作区切换、文件夹树、面包屑、列表/网格、上传下载删除建目录预览编辑 |
| T2 文件搜索 | AC2.1-2.4 | 搜索返回结果、定位、空输入不报错 |
| T3 移动/重命名 | AC3.1-3.4 | move + rename + 循环防护 + 重名校验 |
| T4 回收站 | AC4.1-4.6 | 软删除、列表、恢复、彻底删除、清空 |
| T5 版本历史 | AC5.1-5.6 | 自动快照、列表、回滚、版本数上限 |
| T6 Agent disk_* 工具 | AC6.1-6.5 | 7 工具注册、对话触发保存/读取 |
| T7 零回归 | — | ChatPage 文件 Tab + 现有 API 不退化 |
| T8 系统测试 | — | sys-test 现有用例全过 |
