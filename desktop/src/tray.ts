import { Tray, Menu, nativeImage, shell } from 'electron';
import path from 'path';
import { __dirname } from './meta.js';

export interface TrayHandlers {
  onShow: () => void;
  onQuit: () => void;
  onRestart: () => void;
  dataDir: string;
  logDir: string;
}

let tray: Tray | null = null;

export function createTray(handlers: TrayHandlers): Tray {
  // 1x1 transparent placeholder; replaced with real icon once assets ready
  const iconPath = path.join(__dirname, '..', 'resources', trayIconName());
  let image: Electron.NativeImage;
  try {
    image = nativeImage.createFromPath(iconPath);
    if (process.platform === 'darwin') {
      image.setTemplateImage(true);
    }
  } catch {
    image = nativeImage.createEmpty();
  }

  tray = new Tray(image.isEmpty() ? nativeImage.createEmpty() : image);
  tray.setToolTip('DeepThink');

  const menu = Menu.buildFromTemplate([
    { label: '显示主窗口', click: () => handlers.onShow() },
    { type: 'separator' },
    { label: '打开数据目录', click: () => shell.openPath(handlers.dataDir) },
    { label: '打开日志目录', click: () => shell.openPath(handlers.logDir) },
    { type: 'separator' },
    { label: '重启服务', click: () => handlers.onRestart() },
    { type: 'separator' },
    { label: '退出 DeepThink', click: () => handlers.onQuit() },
  ]);

  tray.setContextMenu(menu);
  tray.on('click', () => handlers.onShow());
  return tray;
}

function trayIconName(): string {
  switch (process.platform) {
    case 'darwin':
      return 'trayTemplate.png';
    case 'win32':
      return 'tray.ico';
    default:
      return 'tray.png';
  }
}
