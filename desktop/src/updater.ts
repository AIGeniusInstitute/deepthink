import pkg from 'electron-updater';
import path from 'path';
import fs from 'fs';
import { exportConfig, type BackendLifecycle } from './config-io.js';
import { backupsDir, logDir } from './paths.js';

const { autoUpdater } = pkg;

let initialized = false;

export interface UpdaterDeps {
  dataDir: string;
  backend: BackendLifecycle;
}

const DEBUG_LOG = `${logDir}/main.log`;
function debug(line: string): void {
  try {
    fs.appendFileSync(DEBUG_LOG, `${new Date().toISOString()} ${line}\n`);
  } catch { /* best-effort */ }
}

function backupStamp(): string {
  const d = new Date();
  const p = (n: number) => String(n).padStart(2, '0');
  return `${d.getFullYear()}${p(d.getMonth() + 1)}${p(d.getDate())}-${p(d.getHours())}${p(d.getMinutes())}${p(d.getSeconds())}`;
}

export function initUpdater(deps: UpdaterDeps): void {
  if (initialized) return;
  initialized = true;

  try {
    // 全静默自动更新（产品要求：有更新直接后台静默更新，不弹任何对话框）：
    // check → 后台下载 → 备份 data/ → quitAndInstall 自动重启安装。
    // 静默不等于无痕：各关键节点写 main.log，便于排查"程序为何自己重启了"。
    autoUpdater.autoDownload = true;
    autoUpdater.autoInstallOnAppQuit = true;

    autoUpdater.on('update-available', (info) => {
      // 之前这里弹「发现新版本」对话框；按要求改为静默下载，只留日志。
      debug(`updater: update-available ${info.version}, downloading in background`);
    });

    autoUpdater.on('update-downloaded', async (info) => {
      // Backup data/ before installing (the precise "about to install" moment).
      debug(`updater: update-downloaded ${info.version}, backing up then quit-and-install`);
      try {
        fs.mkdirSync(backupsDir, { recursive: true });
        const backupPath = path.join(backupsDir, `pre-update-${backupStamp()}.tar.gz`);
        await exportConfig({
          dataDir: deps.dataDir,
          destPath: backupPath,
          backend: deps.backend,
        });
        debug(`updater: backup saved ${backupPath}`);
      } catch (err) {
        // 备份失败也不弹窗、不阻塞更新（原实现在这里弹「是否仍要安装」）。
        // 取舍：userData 在 %APPDATA%\DeepThink、NSIS 安装不覆盖它，备份只是兜底；
        // 静默更新要求下由脚本做决定——照常安装，但把失败记进日志便于排查。
        debug(`updater: backup failed (${String(err)}), installing anyway`);
      }
      // Quit-and-install; before-quit handler in main.ts will stop the backend.
      autoUpdater.quitAndInstall();
    });

    autoUpdater.on('error', (err) => {
      // Updater errors are non-fatal (no feed configured in dev, etc.)
      debug(`updater: error ${String(err)}`);
    });
    autoUpdater.checkForUpdates().catch(() => {
      // Network may be unavailable; ignore
    });
  } catch {
    // Updater not configured in dev; ignore
  }
}
