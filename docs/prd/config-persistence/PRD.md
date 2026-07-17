# PRD：配置跨重建 / 重装保留

- **版本**：v1.0
- **创建日期**：2026-07-17
- **负责人**：DeepThink 团队
- **分支**：`worktree-config-persistence`（基于 `main`）

## 1. 背景与目标

### 1.1 背景

DeepThink 的全部运行时配置（Claude API key、飞书/IM 通道凭据、用户账号、群组、容器环境变量、Skills、MCP servers、Plugins、系统设置、会话密钥）都落在 `data/` 目录，与代码产物物理分离。当前 `make build` / `make clean` / `make start` / 桌面打包本身都不碰 `data/`，理论上重建 web server 与重装桌面包都不丢配置。

但用户实际遇到的三个丢配置场景：

1. **开发环境重拉代码**：`data/` 在仓库根 `~/deepthink/data/`，**不纳入 git**，重新 clone / 切分支 / `git clean -fdx` 即丢全部配置。
2. **桌面版卸载重装**：桌面版 `data/` 虽已在用户目录（`~/Library/Application Support/DeepThink/data/`），但无导出入口，卸载清理或换机无保险。
3. **桌面版自动更新**：`updater.ts` 当前是纯外链跳转，未走 `electron-updater` 下载通道，更新失败/中途中断无回滚备份。

### 1.2 目标

让全部 `data/` 配置在上述三个场景下都可保留/恢复：

1. **data 目录脱离仓库**：开发环境/服务器部署默认把 `data/` 放到用户目录 `~/.deepthink/data`，仓库目录被删/重拉不影响配置。
2. **手动备份/恢复完整**：`make backup` / `make restore` 覆盖全部配置类子目录（补齐 `mcp-servers` / `plugins/users` / `memory`）。
3. **桌面版导出/导入入口**：桌面"文件"菜单提供"导出配置…"/"导入配置…"，一键打包/恢复 `data/`。
4. **更新前自动备份**：桌面版自动更新升级为真正 `electron-updater` 流程，安装更新前自动备份 `data/` 到 `appDataDir/backups/`。

### 1.3 非目标（明确排除）

- 不做备份包加密（用户已选"不加密 + 警告"，接受 `session-secret.key` / `claude-provider.key` 明文风险；文档约束妥善保管）。
- 不新增后端 Web API（桌面直接 tar，开发环境用 make 命令，避免 stop backend 后无法调 API 的死锁）。
- 不改桌面版 `data/` 路径（已用 `~/Library/Application Support/DeepThink/data/`，本方案不动）。
- 不做 Web UI 的"导出配置"按钮（后端无 API，桌面 + CLI 已覆盖三个场景）。

## 2. 用户故事

- **作为开发者**：我 `git clean -fdx` 或重新 clone 仓库后，`make start` 启动的 DeepThink 仍是之前配置好的账号 / 凭据 / 群组，无需重新设置向导。
- **作为桌面用户**：我卸载旧版 DeepThink 装新版前，能从"文件→导出配置"存一份备份；装好后"导入配置"恢复。
- **作为桌面用户**：DeepThink 自动更新到新版本前，系统自动备份了一份 `data/`，更新出问题我能从 `appDataDir/backups/` 找回。

## 3. 验收标准

| # | 验收项 | 验证方式 |
|---|--------|---------|
| AC1 | 开发环境 `DATA_DIR` 默认 = `~/.deepthink/data` | `node -e "console.log(require('./dist/config').DATA_DIR)"` 输出含 `.deepthink/data` |
| AC2 | 旧 `./data` 有数据时启动打印迁移提示 | `make start` 日志含"检测到旧数据目录 ... 运行 make migrate-data" |
| AC3 | `make migrate-data` 把 `./data` → `~/.deepthink/data` | 迁移后 `ls ~/.deepthink/data` 见子目录 |
| AC4 | `make backup` 含 mcp-servers/plugins/users/memory | `tar -tzf` 命中三者 |
| AC5 | `make restore` 恢复后配置全回 | reset-init → restore → start，`/api/auth/me` 返回原 admin |
| AC6 | 桌面"文件→导出配置"生成 tar.gz | `make desktop-dev`，菜单触发，文件含 db/config/... |
| AC7 | 桌面"导入配置"恢复后配置可见 | 导入后窗口 reload，配置在场 |
| AC8 | 更新前自动备份 | mock `update-downloaded`，`appDataDir/backups/pre-update-*.tar.gz` 生成 |

## 4. 约束与风险

- **备份包含明文敏感数据**：`data/config/session-secret.key`（cookie 签名密钥）与 `claude-provider.key`（AES 加密 key 本身）明文落盘，与 IM/Claude 凭据密文同包 → 备份包等价明文。文档与 backup 完成提示明确警告"妥善保管，勿提交 git"。
- **schema 向前不兼容**：`db.ts` SCHEMA 迁移单向向前，旧备份→新代码自动迁移成立；新备份→旧代码无保护。恢复后须用最新版后端启动。
- **桌面导出/导入需停后端**：tar `data/db` 前须 `backend.stop()` 保证 SQLite WAL 一致，期间服务不可用（手动操作可接受）。
