# 技术方案：配置跨重建 / 重装保留

- **分支**：`worktree-config-persistence`
- **PRD**：`docs/prd/config-persistence/PRD.md`

## 1. 现状（调研事实）

| 项 | 现状 | 文件锚点 |
|---|------|---------|
| `DATA_DIR` 解析 | `process.env.DEEPTHINK_DATA_DIR \|\| $PROJECT_ROOT/data`，`PROJECT_ROOT=process.cwd()` | `src/config.ts:12,29-31` |
| 所有模块引用 | 均用 `DATA_DIR` 常量，不硬编码 | `src/db.ts` / `runtime-config.ts` / `container-runner.ts` 等 |
| 桌面版 data | 已传 `DEEPTHINK_DATA_DIR: dataDir`（用户目录） | `desktop/src/backend-supervisor.ts:56`、`paths.ts:25` |
| `make backup` 范围 | db/config/groups/sessions/skills；**漏** mcp-servers/plugins/users/memory | `Makefile:343-360` |
| 备份 Web API | 无 | `src/routes/` 无 |
| 桌面导出/导入 | 无菜单入口 | `desktop/src/menu.ts` |
| `updater.ts` | 纯外链跳转，未走 electron-updater 下载 | `desktop/src/updater.ts:13-33` |
| 加密 | data/config 配置 AES-256-GCM 加密；`session-secret.key` + `claude-provider.key` 明文 | `src/runtime-config.ts`、`src/config.ts:80-89` |
| schema 迁移 | SCHEMA_VERSION=51，单向向前，旧→新自动迁移 | `src/db.ts:1786` |

## 2. 方案分解

### Part A — data 目录迁到 `~/.deepthink/data`

**A.1 `src/config.ts`**：
```ts
import os from 'os';
// ...
export const DATA_DIR = process.env.DEEPTHINK_DATA_DIR
  ? path.resolve(process.env.DEEPTHINK_DATA_DIR)
  : path.resolve(os.homedir(), '.deepthink', 'data');
```
保留 env 覆盖优先（桌面版 / 自定义部署不受影响）。

**A.2 `src/index.ts` 启动早期迁移检测**（`loadState()` 之前）：
```ts
const OLD_DATA_DIR = path.resolve(process.cwd(), 'data');
if ((!fs.existsSync(DATA_DIR) || fs.readdirSync(DATA_DIR).length === 0)
    && fs.existsSync(path.join(OLD_DATA_DIR, 'db'))) {
  logger.warn(`检测到旧数据目录 ${OLD_DATA_DIR}，新数据目录已改为 ${DATA_DIR}。运行 \`make migrate-data\` 迁移旧数据。`);
}
```
仅检测+提示，不自动迁移（避免大文件 cp 中断 / 误覆盖）。

**A.3 `Makefile` 新增 `migrate-data`**：
```make
migrate-data: ## 迁移旧 ./data → ~/.deepthink/data
	@if [ -d data ] && [ "$$(ls -A data 2>/dev/null)" ]; then \
	  mkdir -p $(DATA_DIR); \
	  cp -a data/. $(DATA_DIR)/; \
	  echo "✅ 已迁移 ./data → $(DATA_DIR)"; \
	else echo "ℹ️  无旧数据，跳过"; fi
```

**A.4 `Makefile` backup/restore/reset-init 改绝对路径**：顶部加 `DATA_DIR ?= $(HOME)/.deepthink/data`。backup 用 `tar -czf "$$FILE" -C "$(DATA_DIR)" <子目录...>`；restore 用 `tar -xzf "$$BACKUP" -C "$(DATA_DIR)"`；reset-init 改 `rm -rf $(DATA_DIR)`（保留确认）。

### Part B — backup 范围补全

`Makefile:343` backup tar 列表追加（条件加入，不存在不报错）：
```
$$([ -d $(DATA_DIR)/mcp-servers ] && echo mcp-servers) \
$$([ -d $(DATA_DIR)/plugins/users ] && echo plugins/users) \
$$([ -d $(DATA_DIR)/memory ] && echo memory) \
```
完成提示追加：`⚠️ 备份含 session-secret.key 与 claude-provider.key 明文，妥善保管，勿提交 git`。

排除项保持：ipc / env / logs / harness / db WAL-shm/wal / plugins/catalog / plugins/runtime。

### Part C — 桌面版导出/导入配置

**C.1 `desktop/src/paths.ts`**：新增 `export const backupsDir = path.join(appDataDir, 'backups')`，`ensureDirs()` 一并 `mkdirSync(backupsDir)`。

**C.2 新建 `desktop/src/config-io.ts`**：
```ts
import { execFileSync } from 'child_process';
import path from 'path';
export async function exportConfig(opts: { dataDir: string; destPath: string; stop: () => Promise<void>; start: () => Promise<void> }): Promise<void> {
  await opts.stop();
  try {
    execFileSync('tar', ['-czf', opts.destPath,
      '-C', path.dirname(opts.dataDir), path.basename(opts.dataDir)]);
  } finally { await opts.start(); }
}
export async function importConfig(opts: { srcPath: string; dataDir: string; stop; start }): Promise<void> {
  await opts.stop();
  try {
    execFileSync('tar', ['-xzf', opts.srcPath,
      '-C', path.dirname(opts.dataDir)]);  // 覆盖解包到 dataDir 父目录
  } finally { await opts.start(); }
}
```
先 `stop()` 保证 SQLite WAL 一致，复用 `backend-supervisor` 的 stop/start。

**C.3 `desktop/src/menu.ts`**：`installMenu` 签名改 `installMenu(opts: { dataDir: string; backend: BackendSupervisor })`。文件菜单加：
```ts
{ label: '导出配置…', click: async () => { /* dialog.showSaveDialog → exportConfig */ } },
{ label: '导入配置…', click: async () => { /* dialog.showOpenDialog → 确认覆盖 → importConfig → mainWindow.reload() */ } },
{ type: 'separator' },
```
**C.4 `desktop/src/main.ts:40`**：`installMenu({ dataDir, backend })` 注入（backend 实例 + dataDir 已在 main 作用域）。

### Part D — 自动更新前备份

**`desktop/src/updater.ts`** 升级：
```ts
autoUpdater.autoDownload = true;
autoUpdater.on('update-downloaded', async () => {
  try {
    const dest = path.join(backupsDir, `pre-update-${Date.now()}.tar.gz`);
    await exportConfig({ dataDir, destPath: dest, stop: backend.stop, start: backend.start });
    logger.log(`pre-update backup → ${dest}`);
  } catch (e) {
    // 备份失败：弹框告知，询问是否仍继续（默认仍更新，不阻塞）
  }
  autoUpdater.quitAndInstall();
});
```
注：`Date.now()` 在 Electron 主进程可用（非 workflow 脚本环境）。`exportConfig` 复用 Part C。

## 3. 改动清单

| 文件 | 改动 | Part |
|------|------|------|
| `src/config.ts` | DATA_DIR 默认 → `~/.deepthink/data` | A |
| `src/index.ts` | 启动迁移检测 | A |
| `Makefile` | migrate-data + backup/restore/reset-init 绝对路径 + backup 补范围 | A+B |
| `desktop/src/paths.ts` | backupsDir | C |
| `desktop/src/config-io.ts` | 新建 exportConfig/importConfig | C |
| `desktop/src/menu.ts` | installMenu 签名 + 导出/导入菜单 | C |
| `desktop/src/main.ts` | 注入 installMenu | C |
| `desktop/src/updater.ts` | electron-updater 真流程 + 更新前备份 | D |

复用：`backend-supervisor.ts` stop()/start()/currentPort；`runtime-config.ts` writeSecretFile（备份包落盘 0o600）；`db.ts` SCHEMA 迁移。

## 4. 验证

见 PRD §3 验收标准 AC1-AC8。命令行验证 AC1-AC5 在开发环境直接跑；AC6-AC8 桌面版需 `make desktop-dev`。

## 5. 风险与回退

- **改 `DATA_DIR` 默认值导致现有开发环境数据"看不到"**：A.2 迁移检测 + `make migrate-data` 兜底；用户不迁移则新启动走首装向导（旧数据仍在 `./data` 未删，可随时 migrate）。
- **桌面 tar 跨平台**：Win10 1803+ 自带 bsdtar；macOS/Linux 原生 tar。若遇极端环境，fallback 用 Node `tar` npm 包（暂不引入，先靠系统 tar）。
- **updater 升级风险**：electron-updater 真下载流程改动较大，若 CI 无法 mock 测试，Part D 可后置独立验证，不阻塞 A/B/C。
