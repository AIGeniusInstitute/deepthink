import { BrowserWindow } from 'electron';

let splashWindow: BrowserWindow | null = null;

export function createSplash(): BrowserWindow {
  splashWindow = new BrowserWindow({
    width: 520,
    height: 360,
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
    font-family: -apple-system, BlinkMacSystemFont, 'Segoe UI', 'PingFang SC', sans-serif;
    overflow: hidden; }
  .wrap { display: flex; flex-direction: column; align-items: center; justify-content: center;
    height: 100%; position: relative; }
  .logo { font-size: 64px; font-weight: 700; color: #1F2937; letter-spacing: -1.5px;
    opacity: 0; transform: translateY(8px);
    text-shadow: 0 0 24px rgba(31, 41, 55, 0.10);
    animation: slideUp 0.6s cubic-bezier(0.22, 1, 0.36, 1) 0.1s forwards,
               breath 2.4s ease-in-out 0.8s infinite; }
  .tag { font-size: 12px; color: #6B7785; margin-top: 10px; letter-spacing: 0.5px;
    opacity: 0; animation: fadeIn 0.6s ease-out 0.5s forwards; }
  .tag .dot { color: #9CA3AF; margin: 0 6px; }
  .status { font-size: 12px; color: #4A5563; margin-top: 32px; letter-spacing: 0.3px;
    opacity: 0; animation: fadeIn 0.6s ease-out 0.9s forwards; }
  .status .sub { color: #9CA3AF; margin-left: 6px; font-size: 11px; }
  .progress { position: absolute; bottom: 0; left: 0; height: 1px; width: 0%;
    background: #1F2937; animation: progress 1.8s cubic-bezier(0.4, 0, 0.2, 1) 0.3s forwards; }
  @keyframes slideUp { to { opacity: 1; transform: translateY(0); } }
  @keyframes fadeIn { to { opacity: 1; } }
  @keyframes breath { 0%, 100% { text-shadow: 0 0 24px rgba(31, 41, 55, 0.10); }
                      50% { text-shadow: 0 0 36px rgba(31, 41, 55, 0.22); } }
  @keyframes progress { to { width: 100%; } }
</style>
</head>
<body>
  <div class="wrap">
    <div class="logo">DeepThink</div>
    <div class="tag">Loop Engineering<span class="dot">·</span>本地优先<span class="dot">·</span>思考的深度</div>
    <div class="status">正在唤醒思考<span class="sub">Initializing…</span></div>
    <div class="progress"></div>
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
