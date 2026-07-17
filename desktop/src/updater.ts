import pkg from 'electron-updater';
import { dialog } from 'electron';
import path from 'path';
import fs from 'fs';
import { exportConfig, type BackendLifecycle } from './config-io.js';
import { backupsDir } from './paths.js';

const { autoUpdater } = pkg;

let initialized = false;

export interface UpdaterDeps {
  dataDir: string;
  backend: BackendLifecycle;
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
    // Download in the background; we back up data/ before installing on the
    // update-downloaded hook (the precise "about to install" moment).
    autoUpdater.autoDownload = true;
    autoUpdater.autoInstallOnAppQuit = true;

    autoUpdater.on('update-available', (info) => {
      dialog
        .showMessageBox({
          type: 'info',
          title: '发现新版本',
          message: `DeepThink ${info.version} 已发布，正在后台下载。`,
          detail: '下载完成后，安装更新前会自动备份当前配置到 ' + backupsDir + '，随后重启安装。',
          buttons: ['好的'],
        })
        .catch(() => { /* ignore */ });
    });

    autoUpdater.on('update-downloaded', async () => {
      // Backup data/ before installing. If backup fails, warn the user but
      // still let them choose to proceed (don't block the update).
      try {
        fs.mkdirSync(backupsDir, { recursive: true });
        const backupPath = path.join(backupsDir, `pre-update-${backupStamp()}.tar.gz`);
        await exportConfig({
          dataDir: deps.dataDir,
          destPath: backupPath,
          backend: deps.backend,
        });
      } catch (err) {
        const choice = await dialog.showMessageBox({
          type: 'warning',
          title: '更新前备份失败',
          message: '安装更新前自动备份配置失败。',
          detail: `错误：${String(err)}\n\n建议手动通过"文件→导出配置"备份后再更新。是否仍要安装更新？`,
          buttons: ['取消更新', '仍要安装'],
          defaultId: 0,
          cancelId: 0,
        });
        if (choice.response !== 1) return; // don't install
      }
      // Quit-and-install; before-quit handler in main.ts will stop the backend.
      autoUpdater.quitAndInstall();
    });

    autoUpdater.on('error', () => {
      // Silent: updater errors are non-fatal (no feed configured in dev, etc.)
    });
    autoUpdater.checkForUpdates().catch(() => {
      // Network may be unavailable; ignore
    });
  } catch {
    // Updater not configured in dev; ignore
  }
}
