import pkg from 'electron-updater';
import { dialog, shell } from 'electron';

const { autoUpdater } = pkg;

let initialized = false;

export function initUpdater(): void {
  if (initialized) return;
  initialized = true;

  try {
    autoUpdater.autoDownload = false;
    autoUpdater.autoInstallOnAppQuit = true;
    autoUpdater.on('update-available', (info) => {
      dialog
        .showMessageBox({
          type: 'info',
          title: '发现新版本',
          message: `DeepThink ${info.version} 已发布`,
          detail: '是否前往下载页？',
          buttons: ['前往下载', '稍后提醒'],
          defaultId: 0,
        })
        .then((res) => {
          if (res.response === 0) {
            shell.openExternal('https://github.com/AIGeniusInstitute/deep-think/releases/latest');
          }
        });
    });
    autoUpdater.on('error', () => {
      // Silent: updater errors are non-fatal in MVP
    });
    autoUpdater.checkForUpdates().catch(() => {
      // Network may be unavailable; ignore
    });
  } catch {
    // Updater not configured in dev; ignore
  }
}
