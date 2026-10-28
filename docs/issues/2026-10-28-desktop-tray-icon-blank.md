# 桌面端 Windows 托盘「显示隐藏的图标」面板里图标为空白

> 日期：2026-10-28
> 影响面：DeepThink 桌面版托盘图标（Windows 必现；macOS/Linux 同因同果）

## 1. 用户现象

Windows 任务栏「显示隐藏的图标」（溢出面板）里 DeepThink 一项**没有图标、是空白的**；
只能靠 tooltip / 右键菜单辨认。主窗口与功能不受影响。

## 2. 问题描述

`desktop/src/tray.ts` 创建托盘时加载 `resources/tray.ico`（Windows）：
`nativeImage.createFromPath(iconPath)` 在**文件不存在时不会抛异常，而是返回空图**，
代码随后 `new Tray(空图)`，托盘项就是一块空白。而 `tray.ico` 在任何构建产物里都不存在。

## 3. 根因

两层叠加：

1. **图标资产从未生成**。`scripts/generate-tray-icons.sh` 从 `desktop/resources/icon.png`
   派生 `trayTemplate.png`（mac）/ `tray.png`（linux）/ `tray.ico`（win），但脚本要求
   ImageMagick（`convert`），缺失时**静默 exit 0**（注释写着"fallback 到空图标，不影响运行"
   ——但空白图标本身就是缺陷）。更要命的是：**打包脚本与 CI 流程都不调用它**，
   `generate-tray-icons` 只是 Makefile 里的手动 target。
2. **运行时没有任何回退**。`createFromPath` 拿到空图后直接 `new Tray(空图)`，
   而随包必有的 `icon.ico` / `icon.png`（`win.json` 的 `files` 含 `resources/**/*`）
   从未被考虑。

## 4. 复现路径

1. 用 `scripts\pack-win.ps1` 打包并安装（构建机未装 ImageMagick）。
2. 启动 DeepThink，最小化到托盘。
3. 点任务栏「显示隐藏的图标」→ DeepThink 项图标为空白。

## 5. 诊断方法

```powershell
# 1) 仓库里有没有托盘图标资产？（预期：只有 icon.*，没有 tray.*）
ls desktop\resources

# 2) 生产包（app.asar）里有没有 tray.ico？（asar 头是 JSON，图标是嵌套 key）
grep -ao '"tray\.ico":\|"icon\.ico":\|"icon\.png":' "C:\Program Files\DeepThink\resources\app.asar"
# 实测输出：只有 "icon.ico": 与 "icon.png":，没有 "tray.ico": ← 即根因
```

## 6. 修复方案

运行时按「平台首选 → 应用图标 → 空图」回退，并把命中的来源写进日志：

```diff
// desktop/src/tray.ts
+function loadTrayImage(): { image: Electron.NativeImage; source: string } {
+  const resourcesDir = path.join(__dirname, '..', 'resources');
+  const preferred = path.join(resourcesDir, trayIconName());
+  const fallback = path.join(resourcesDir, process.platform === 'win32' ? 'icon.ico' : 'icon.png');
+  for (const candidate of [preferred, fallback]) {
+    if (!fs.existsSync(candidate)) continue;
+    const image = nativeImage.createFromPath(candidate);
+    if (image.isEmpty()) continue;
+    if (candidate === preferred && process.platform === 'darwin') image.setTemplateImage(true);
+    return { image, source: path.basename(candidate) };
+  }
+  return { image: nativeImage.createEmpty(), source: 'empty' };
+}

 export function createTray(handlers: TrayHandlers): Tray {
-  const iconPath = path.join(__dirname, '..', 'resources', trayIconName());
-  ...
-  tray = new Tray(image.isEmpty() ? nativeImage.createEmpty() : image);
+  const { image, source } = loadTrayImage();
+  debug(`tray: icon loaded from ${source}`);
+  tray = new Tray(image);
```

选型理由：

- **回退到 `icon.ico`/`icon.png` 而不是让打包流程生成 `tray.ico`**：`icon.*` 随包必有
  （`files: ["resources/**/*"]`），零构建依赖、三平台同一处修好；`generate-tray-icons.sh`
  仍保留给想定制托盘字形的场景（装 ImageMagick 后手动跑）。
- macOS 的 `setTemplateImage(true)` 只对平台首选生效——回退的彩色应用图标被设成模板图
  会变成黑剪影，反而更糟。
- 三候选全缺时仍用空图（保持原行为），但写日志，不再无声无息。

## 7. 处理卡住的状态

无运行态卡住。已安装的旧包在升级到含本修复的版本后自动恢复正常（图标资产随新包带上）。

## 8. 经验沉淀 / 预防

1. **`createFromPath` 这类"失败返回空值"的 API 必须显式判空**：空 NativeImage 是合法对象，
   不判 `isEmpty()` 就等于把"文件缺失"翻译成"空白 UI"。同类 API（`nativeImage`、
   `fs.readFileSync` 的空文件）都应显式校验。
2. **静默 fallback ≠ 无害 fallback**：`generate-tray-icons.sh` 的"缺 ImageMagick 就跳过"
   把构建期问题推迟成了线上 UI 缺陷，且注释宣称"不影响运行"。fallback 一定要落到
   **可用状态**（真图标）而不是**空状态**（空白）。
3. **构建产物缺失类问题的诊断手法**：`grep -ao '"file":' xxx.app.asar` 直接看 asar 头，
   比猜打包配置快得多；本 issue 的根因就是靠这一条命令坐实的。
