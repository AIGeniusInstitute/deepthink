# Intent — AgentNet Disk 企业级 Agent 平台文件网盘

## 用户原始意图

为 DeepThink 系统开发企业级文件网盘「AgentNet Disk」，使 Agent 能够像人类用户一样上传、下载、预览、编辑和保存文件，同时满足企业级安全、权限和审计要求。

用户附了一份完整的 PRD 设计文档与技术方案（约 5000 字），覆盖：
- 产品定位：企业级 Agent 平台文件存储与协作底座
- 功能模块：文件管理 / 文件预览 / 在线编辑 / 上传能力 / 下载能力 / 权限管理 / Agent 交互 / 协同办公 / 安全审计 / 版本管理
- 技术方案：MinIO 对象存储 + PostgreSQL 元数据 + Redis 缓存 + OnlyOffice 在线编辑 + 内容寻址分片 + 预签名 URL + RBAC+ABAC 混合权限
- Agent 工具：disk_upload / disk_download / disk_create_folder / disk_list / disk_search / disk_move / disk_delete / disk_share / disk_create_doc / disk_edit_doc

## 关键张力（需在 PRD 中裁定）

用户 PRD 描述的技术栈（MinIO + PostgreSQL + Redis + OnlyOffice + Go/Node 微服务）与 DeepThink 实际架构存在重大差异：
- DeepThink 实际是 TypeScript + SQLite(better-sqlite3) + Hono + 本地文件系统，**已有一套 group 作用域的完整文件管理**（routes/files.ts 1411 行：list/upload/download/preview/convert(LibreOffice)/content 读写/createDirectory/delete）
- DeepThink 已有 LibreOffice 转换、Monaco 编辑器、mammoth/xlsx Office 预览、object-store(fs/s3 双后端，目前仅 trace-io 用)
- Agent 工具机制是 MCP tools（container/agent-runner/src/mcp-tools.ts，Claude Agent SDK tool() helper），已有 send_file

**裁定方向**：在现有架构上演进（Surgical Changes + Simplicity First），补齐 PRD 中现有系统缺失的能力，而非另起一套 MinIO+PG+OnlyOffice 微服务栈。MinIO 内容寻址分片、OnlyOffice 在线 Office 编辑、RBAC+ABAC 文件级权限属 P1/P2（speculative / 需外部依赖），不进 MVP。
