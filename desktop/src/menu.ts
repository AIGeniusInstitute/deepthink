import { Menu, shell } from 'electron';

export function installMenu(): void {
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
