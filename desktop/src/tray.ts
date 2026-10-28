import { Tray, Menu, nativeImage, shell } from 'electron';
import path from 'path';
import fs from 'fs';
import { __dirname } from './meta.js';
import { logDir } from './paths.js';

export interface TrayHandlers {
  onShow: () => void;
  onQuit: () => void;
  onRestart: () => void;
  dataDir: string;
  logDir: string;
}

let tray: Tray | null = null;

const DEBUG_LOG = `${logDir}/main.log`;
function debug(line: string): void {
  try {
    fs.appendFileSync(DEBUG_LOG, `${new Date().toISOString()} ${line}\n`);
  } catch { /* best-effort */ }
}

export function createTray(handlers: TrayHandlers): Tray {
  const { image, source } = loadTrayImage();
  debug(`tray: icon loaded from ${source}`);

  tray = new Tray(image);
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

/**
 * 托盘图标按「平台首选 → 应用图标 → 空图」回退。
 *
 * 平台首选的 tray.ico / tray.png / trayTemplate.png 由 scripts/generate-tray-icons.sh
 * 生成，但那需要 ImageMagick、缺失时静默跳过，且打包/CI 流程从不调它——结果是生产包里
 * 根本没有这几个文件，createFromPath 拿到空图，托盘与"显示隐藏的图标"面板里就是一个
 * 空白项。回退到随包必有的 icon.ico / icon.png（win.json 的 files 含 resources/**）。
 */
function loadTrayImage(): { image: Electron.NativeImage; source: string } {
  const resourcesDir = path.join(__dirname, '..', 'resources');
  const preferred = path.join(resourcesDir, trayIconName());
  const fallback = path.join(resourcesDir, process.platform === 'win32' ? 'icon.ico' : 'icon.png');

  for (const candidate of [preferred, fallback]) {
    if (!fs.existsSync(candidate)) continue;
    const image = nativeImage.createFromPath(candidate);
    if (image.isEmpty()) continue;
    // 只有平台首选（macOS template）才设模板图；回退到彩色应用图标时设模板会变成黑剪影
    if (candidate === preferred && process.platform === 'darwin') {
      image.setTemplateImage(true);
    }
    return { image, source: path.basename(candidate) };
  }

  debug('tray: no icon asset found (tray.* and icon.* all missing), using empty image');
  return { image: nativeImage.createEmpty(), source: 'empty' };
}
