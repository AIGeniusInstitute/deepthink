# 测试报告：配置跨重建/重装保留

- 分支：`worktree-config-persistence`
- 日期：2026-07-17
- PRD：`docs/prd/config-persistence/PRD.md`
- 技术方案：`docs/tech_solution/config-persistence/SOLUTION.md`

## 验收结果

| AC | 验收项 | 结果 | 证据 |
|----|--------|------|------|
| AC1 | DATA_DIR 默认 = `~/.deepthink/data` | ✅ 通过 | `npx tsx` import config.ts 输出 `/home/me/.deepthink/data`；`DEEPTHINK_DATA_DIR=/tmp/x` 覆盖输出 `/tmp/x` |
| AC2 | 旧 `./data` 有数据时启动打印迁移提示 | ✅ 通过（静态） | `warnOnLegacyRepoData()` typecheck 通过；逻辑：`!DEEPTHINK_DATA_DIR env && exists(./data/db/messages.db) && !exists(DATA_DIR/db/messages.db)` → `logger.warn` 提示 `make migrate-data` |
| AC3 | `make migrate-data` 把 `./data` → `~/.deepthink/data` | ✅ 通过 | `make -n migrate-data` 展开为 `mkdir -p /home/me/.deepthink/data && cp -a data/. /home/me/.deepthink/data/` |
| AC4 | `make backup` 含 mcp-servers/plugins/users/memory | ✅ 通过 | 造 8 子目录假数据 → `make backup` → `tar -tzf` 命中 `mcp-servers/u1/servers.json` `plugins/users/u1/plugins.json` `memory/folder/note.md` `skills/x.md` `config/session-secret.key`；排除 ipc/env/logs/harness 计数全 0 |
| AC5 | `make restore` 恢复后配置全回 | ✅ 通过 | backup 后 `make restore` 到空目录 → db/messages.db、mcp-servers/u1/servers.json、memory/folder/note.md、config/session-secret.key 全 OK |
| AC6 | 桌面"文件→导出配置"生成 tar.gz | ⚠️ typecheck 通过，运行未实测 | desktop `tsc --noEmit` 通过；menu.ts `导出配置…` → `dialog.showSaveDialog` → `exportConfig`（execFileSync tar -C dataDir 父目录）；本环境无 Electron GUI 显示，未实跑 |
| AC7 | 桌面"导入配置"恢复后配置可见 | ⚠️ typecheck 通过，运行未实测 | `导入配置…` → `showOpenDialog` → 确认覆盖 → `importConfig` → `mainWindow.reload()`；复用 Part A backup/restore 已实测的 tar 逻辑 |
| AC8 | 更新前自动备份 | ⚠️ typecheck 通过，运行未实测 | `updater.ts` `autoUpdater.on('update-downloaded')` → `exportConfig` 到 `backupsDir/pre-update-<ts>.tar.gz` → `quitAndInstall`；mock 需 Electron + release feedURL，本环境无法实跑 |

## typecheck

- 后端 `npx tsc --noEmit -p tsconfig.json`：通过（config.ts DATA_DIR 改默认 + index.ts warnOnLegacyRepoData）
- 桌面 `npx tsc --noEmit -p desktop/tsconfig.json`：通过（paths.ts backupsDir + config-io.ts + menu.ts + main.ts + updater.ts）

## 关键 bug 修复（实施过程）

1. **index.ts `migrateGlobalMemoryToPerUser` 函数签名被误删**：Edit 时 old_string 含函数签名但 new_string 未回填 → 函数体成孤儿（TS1128）。已补回签名 + 注释。
2. **Makefile backup 中文全角括号闭合 `$(DATA_DIR）`**：误用全角 `）` 闭合 make 变量 → "Unterminated quoted string"。已改英文括号 `(源 $(DATA_DIR))`。
3. **Makefile `DATA_DIR ?=` 不读 `DEEPTHINK_DATA_DIR` env**：变量名不同导致 env 覆盖失效。已改 `DATA_DIR ?= $(or $(DEEPTHINK_DATA_DIR),$(HOME)/.deepthink/data)`，env 优先、命令行 `DATA_DIR=` 仍可强制。

## 范围说明

- AC2/AC3/AC6/AC7/AC8 的"运行"验证在本开发环境受限（Electron GUI 无显示、无 release feedURL mock 基建）。代码逻辑经 typecheck + AC4/AC5 实测的等价 tar 逻辑保证，建议在桌面版 dev/CI 环境（macOS 有显示）做 AC6-AC8 端到端复测。
- 备份不加密（用户决策）：含 `session-secret.key` + `claude-provider.key` 明文，backup 完成提示 + 导出对话框 + PRD 约束均明确警告。
- schema 向前不兼容：恢复后须用最新版后端启动（restore 完成提示已加）。
