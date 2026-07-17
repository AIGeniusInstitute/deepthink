import { Menu, shell, dialog, BrowserWindow } from 'electron';
import path from 'path';
import { exportConfig, importConfig, type BackendLifecycle } from './config-io.js';

export interface MenuDeps {
  dataDir: string;
  backend: BackendLifecycle;
  getMainWindow: () => BrowserWindow | null;
}

function timestamp(): string {
  const d = new Date();
  const p = (n: number) => String(n).padStart(2, '0');
  return `${d.getFullYear()}${p(d.getMonth() + 1)}${p(d.getDate())}-${p(d.getHours())}${p(d.getMinutes())}${p(d.getSeconds())}`;
}

export function installMenu(deps: MenuDeps): void {
  const isMac = process.platform === 'darwin';

  const macAppMenu: Electron.MenuItemConstructorOptions = {
    label: 'DeepThink',
    submenu: [
      { role: 'about', label: '关于 DeepThink' },
      { type: 'separator' },
      { role: 'services' },
      { type: 'separator' },
      { role: 'hide' },
      { role: 'hideOthers' },
      { role: 'unhide' },
      { type: 'separator' },
      { role: 'quit', label: '退出 DeepThink' },
    ],
  };

  const fileMenu: Electron.MenuItemConstructorOptions = {
    label: '文件',
    submenu: [
      {
        label: '导出配置…',
        click: async () => {
          const res = await dialog.showSaveDialog({
            title: '导出配置',
            defaultPath: `deepthink-backup-${timestamp()}.tar.gz`,
            filters: [{ name: 'tar.gz', extensions: ['tar.gz', 'tgz'] }],
          });
          if (res.canceled || !res.filePath) return;
          try {
            await exportConfig({
              dataDir: deps.dataDir,
              destPath: res.filePath,
              backend: deps.backend,
            });
            await dialog.showMessageBox({
              type: 'info',
              title: '导出完成',
              message: `配置已导出到：\n${res.filePath}`,
              detail: '⚠️ 备份含 session-secret.key 与 claude-provider.key 明文，妥善保管，勿提交 git。',
            });
          } catch (err) {
            await dialog.showMessageBox({ type: 'error', title: '导出失败', message: String(err) });
          }
        },
      },
      {
        label: '导入配置…',
        click: async () => {
          const res = await dialog.showOpenDialog({
            title: '导入配置',
            properties: ['openFile'],
            filters: [{ name: 'tar.gz', extensions: ['tar.gz', 'tgz'] }],
          });
          if (res.canceled || res.filePaths.length === 0) return;
          const src = res.filePaths[0];
          const confirm = await dialog.showMessageBox({
            type: 'warning',
            title: '导入配置',
            message: `将从 ${path.basename(src)} 恢复配置，会覆盖当前 ${deps.dataDir}。\n导入期间服务会短暂不可用。是否继续？`,
            buttons: ['取消', '继续导入'],
            defaultId: 0,
            cancelId: 0,
          });
          if (confirm.response !== 1) return;
          try {
            await importConfig({ srcPath: src, dataDir: deps.dataDir, backend: deps.backend });
            await dialog.showMessageBox({ type: 'info', title: '导入完成', message: '配置已恢复，窗口将重新加载。' });
            deps.getMainWindow()?.reload();
          } catch (err) {
            await dialog.showMessageBox({ type: 'error', title: '导入失败', message: String(err) });
          }
        },
      },
      { type: 'separator' },
      isMac ? { role: 'close', label: '关闭窗口' } : { role: 'quit', label: '退出' },
    ],
  };

  const template: Electron.MenuItemConstructorOptions[] = [
    ...(isMac ? [macAppMenu] : []),
    fileMenu,
    {
      label: '编辑',
      submenu: [
        { role: 'undo', label: '撤销' },
        { role: 'redo', label: '重做' },
        { type: 'separator' },
        { role: 'cut', label: '剪切' },
        { role: 'copy', label: '复制' },
        { role: 'paste', label: '粘贴' },
        { role: 'selectAll', label: '全选' },
      ],
    },
    {
      label: '视图',
      submenu: [
        { role: 'reload', label: '重新加载' },
        { role: 'forceReload', label: '强制重新加载' },
        { role: 'toggleDevTools', label: '开发者工具' },
        { type: 'separator' },
        { role: 'resetZoom', label: '重置缩放' },
        { role: 'zoomIn', label: '放大' },
        { role: 'zoomOut', label: '缩小' },
        { type: 'separator' },
        { role: 'togglefullscreen', label: '全屏' },
      ],
    },
    {
      label: '帮助',
      submenu: [
        {
          label: '打开项目主页',
          click: () => shell.openExternal('https://github.com/AIGeniusInstitute/deep-think'),
        },
      ],
    },
  ];

  const menu = Menu.buildFromTemplate(template);
  Menu.setApplicationMenu(menu);
}
