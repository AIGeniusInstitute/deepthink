import { BrowserWindow } from 'electron';

let splashWindow: BrowserWindow | null = null;

export function createSplash(): BrowserWindow {
  splashWindow = new BrowserWindow({
    width: 480,
    height: 320,
    frame: false,
    resizable: false,
    minimizable: false,
    maximizable: false,
    center: true,
    show: false,
    alwaysOnTop: true,
    backgroundColor: '#E8EEF2',
    webPreferences: {
      contextIsolation: true,
      nodeIntegration: false,
    },
  });

  const html = `<!doctype html>
<html lang="zh-CN">
<head>
<meta charset="utf-8" />
<style>
  html, body { margin: 0; padding: 0; height: 100%; background: #E8EEF2; color: #1F2937;
    font-family: -apple-system, BlinkMacSystemFont, 'Segoe UI', sans-serif; }
  .wrap { display: flex; flex-direction: column; align-items: center; justify-content: center; height: 100%; }
  .logo { font-size: 56px; font-weight: 700; color: #1F2937; letter-spacing: -1px; }
  .tag { font-size: 13px; color: #6B7785; margin-top: 4px; }
  .status { font-size: 13px; color: #4A5563; margin-top: 28px; }
  .dot { display: inline-block; width: 8px; height: 8px; border-radius: 50%; background: #1F2937;
    margin-right: 8px; animation: pulse 1.2s infinite; }
  @keyframes pulse { 0%, 100% { opacity: 1; } 50% { opacity: .3; } }
</style>
</head>
<body>
  <div class="wrap">
    <div class="logo">DeepThink</div>
    <div class="tag">本地 AI Agent · 思考的深度</div>
    <div class="status"><span class="dot"></span>正在启动…</div>
  </div>
</body>
</html>`;
  splashWindow.loadURL('data:text/html;charset=utf-8,' + encodeURIComponent(html));
  splashWindow.once('ready-to-show', () => splashWindow?.show());
  return splashWindow;
}

export function destroySplash(): void {
  if (splashWindow && !splashWindow.isDestroyed()) {
    splashWindow.close();
  }
  splashWindow = null;
}
