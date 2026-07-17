import { app, BrowserWindow, shell } from 'electron';
import fs from 'fs';
import { ensureDirs, logDir, dataDir } from './paths.js';
import { supervisorSingleton as backend } from './backend-supervisor.js';
import { createSplash, destroySplash } from './splash.js';
import { createTray } from './tray.js';
import { installMenu } from './menu.js';
import { initUpdater } from './updater.js';

const DEBUG_LOG = `${logDir}/main.log`;
function debug(line: string): void {
  try {
    fs.appendFileSync(DEBUG_LOG, `${new Date().toISOString()} ${line}\n`);
  } catch { /* best-effort */ }
}

debug('main module loaded');

let mainWindow: BrowserWindow | null = null;

// Single instance lock — must be requested as early as possible.
if (!app.requestSingleInstanceLock()) {
  debug('single-instance lock failed, quitting');
  app.quit();
} else {
  debug('single-instance lock acquired');
  app.on('second-instance', () => {
    debug('second-instance event');
    if (mainWindow) {
      if (mainWindow.isMinimized()) mainWindow.restore();
      if (!mainWindow.isVisible()) mainWindow.show();
      mainWindow.focus();
    }
  });
}

app.whenReady().then(async () => {
  debug('app ready');
  ensureDirs();
  installMenu({ dataDir, backend, getMainWindow: () => mainWindow });
  createTray({ onShow: showMainWindow, onQuit: () => app.quit(), onRestart: restartBackend, dataDir, logDir });

  const splash = createSplash();
  debug('splash created');

  try {
    debug('starting backend...');
    const { port } = await backend.start();
    debug(`backend started on port ${port}`);
    createMainWindow(port);
  } catch (err) {
    debug(`backend start failed: ${(err as Error).message}\n${(err as Error).stack}`);
    splash.close();
    const { dialog } = await import('electron');
    dialog.showErrorBox(
      'DeepThink 启动失败',
      `后端服务启动失败：\n${(err as Error).message}\n\n请查看日志：${logDir}`,
    );
    app.quit();
    return;
  }

  destroySplash();
  initUpdater({ dataDir, backend });
  debug('main window ready');
});

app.on('window-all-closed', () => {
  // macOS / Windows / Linux: minimize to tray instead of quitting
  // (no preventDefault needed since no window is left to close)
});

app.on('before-quit', async (event) => {
  event.preventDefault();
  (app as unknown as { _isQuitting?: boolean })._isQuitting = true;
  await backend.stop();
  app.exit(0);
});

function createMainWindow(port: number): void {
  mainWindow = new BrowserWindow({
    width: 1280,
    height: 800,
    minWidth: 800,
    minHeight: 600,
    title: 'DeepThink',
    backgroundColor: '#E8EEF2',
    show: false,
    webPreferences: {
      contextIsolation: true,
      nodeIntegration: false,
    },
  });

  mainWindow.loadURL(`http://127.0.0.1:${port}`);

  mainWindow.once('ready-to-show', () => {
    mainWindow?.show();
  });

  // Open external links in browser
  mainWindow.webContents.setWindowOpenHandler(({ url }) => {
    if (url.startsWith('http://127.0.0.1') || url.startsWith('http://localhost')) {
      return { action: 'allow' };
    }
    shell.openExternal(url);
    return { action: 'deny' };
  });

  mainWindow.on('close', (event) => {
    if ((app as unknown as { _isQuitting?: boolean })._isQuitting) return;
    event.preventDefault();
    mainWindow?.hide();
  });
}

function showMainWindow(): void {
  if (!mainWindow) return;
  if (mainWindow.isMinimized()) mainWindow.restore();
  if (!mainWindow.isVisible()) mainWindow.show();
  mainWindow.focus();
}

async function restartBackend(): Promise<void> {
  await backend.stop();
  try {
    const { port } = await backend.start();
    if (mainWindow) {
      mainWindow.loadURL(`http://127.0.0.1:${port}`);
    }
  } catch (err) {
    const { dialog } = await import('electron');
    dialog.showErrorBox('DeepThink', `重启失败：${(err as Error).message}`);
  }
}
