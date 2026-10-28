# 桌面版自动更新弹「发现新版本」对话框，期望改为后台静默更新

> 日期：2026-10-28
> 影响面：DeepThink 桌面版（Electron 壳）的自动更新流程
> 期望行为（用户原话）：「不要弹出来。如果有更新，直接后台静默更新即可。」

## 1. 用户现象

打开桌面程序后弹出系统对话框：

```
发现新版本
DeepThink 1.7.0 已发布，正在后台下载。
下载完成后，安装更新前会自动备份当前配置到
C:\Users\chenguangjian\AppData\Roaming\DeepThink\backups，随后重启安装。
```

用户点「好的」后对话框消失，但下载、备份、自动重启安装照常发生——弹窗只是告知，
用户不希望被任何提示打扰，期望全自动静默完成。

## 2. 问题描述

`desktop/src/updater.ts` 的更新流程是：`update-available` → **弹对话框** → 后台下载
（`autoDownload=true`）→ `update-downloaded` 备份 data/ → `quitAndInstall()` 自动重启安装。
弹窗与"静默更新"的产品期望不符；且备份失败时还有第二个弹窗（「是否仍要安装更新」），
同样打断用户。

## 3. 根因

`desktop/src/updater.ts`（改动前）在 `update-available` 回调里显式调用了
`dialog.showMessageBox`：

```ts
autoUpdater.on('update-available', (info) => {
  dialog.showMessageBox({
    type: 'info',
    title: '发现新版本',
    message: `DeepThink ${info.version} 已发布，正在后台下载。`,
    detail: '下载完成后，安装更新前会自动备份当前配置到 ' + backupsDir + '，随后重启安装。',
    buttons: ['好的'],
  })
});
```

备份失败分支同样调用 `dialog.showMessageBox` 询问「取消更新 / 仍要安装」。
两处都是唯一的通知出口——删掉它们更新链路本身不需要任何改动（下载/备份/重启安装
已由 `autoDownload`、`update-downloaded`、`quitAndInstall()` 串好）。

## 4. 复现路径

1. 安装任一低于更新源最新版本的桌面包（如本地包 `1.0.1`，更新源有 `1.7.0`）。
2. 联网启动桌面程序。
3. 启动后数秒内弹出「发现新版本」对话框（即本 issue 的现象）。
4. 点「好的」，程序后台下载，下载完成后自动备份配置并重启安装。

## 5. 诊断方法

```powershell
# 看更新器事件（本次修复后新增的日志；静默 ≠ 无痕）
Get-Content "$env:APPDATA\DeepThink\logs\main.log" -Tail 30 | Select-String updater

# 看当前安装版本与更新源指向
Get-ItemProperty 'HKCU:\Software\Microsoft\Windows\CurrentVersion\Uninstall\*' |
  Where-Object { $_.DisplayName -match 'DeepThink' } | Select-Object DisplayName,DisplayVersion
Get-Content "C:\Program Files\DeepThink\resources\app-update.yml"
```

日志会出现（修复后）：

```
updater: update-available 1.7.0, downloading in background
updater: update-downloaded 1.7.0, backing up then quit-and-install
updater: backup saved ...\backups\pre-update-20261028-143000.tar.gz
```

## 6. 修复方案

```diff
// desktop/src/updater.ts
-import { dialog } from 'electron';
+import { backupsDir, logDir } from './paths.js';

 autoUpdater.on('update-available', (info) => {
-  dialog.showMessageBox({ type: 'info', title: '发现新版本', ... buttons: ['好的'] })
+  debug(`updater: update-available ${info.version}, downloading in background`);
 });

 autoUpdater.on('update-downloaded', async (info) => {
+  debug(`updater: update-downloaded ${info.version}, backing up then quit-and-install`);
   try { /* 备份 data/ → backups/pre-update-*.tar.gz */ }
   catch (err) {
-    const choice = await dialog.showMessageBox({ ... buttons: ['取消更新', '仍要安装'] });
-    if (choice.response !== 1) return; // 不装了
+    debug(`updater: backup failed (${String(err)}), installing anyway`);
   }
   autoUpdater.quitAndInstall();
 });
```

行为决策（与用户确认过）：

1. **安装时机不变**：下载完成后立即备份并 `quitAndInstall()` 自动重启安装（用户在
   「退出时安装」与「下载完立即重启安装」中选择了后者）。
2. **备份失败不再弹窗**：照常安装并把失败写进日志。取舍：`userData` 在
   `%APPDATA%\DeepThink`、NSIS 安装不覆盖它，备份只是兜底；静默更新要求下由脚本
   做决定而不是把用户叫回来答题。原实现的意图注释本来就是 "don't block the update"。
3. **静默 ≠ 无痕**：`update-available` / `update-downloaded` / 备份成功或失败 /
   `error` 一律写 `logs/main.log`，否则"程序为什么自己重启了"无从排查。

## 7. 处理卡住的状态

无运行态需要救活。但注意**版本线陷阱**（本次排查的重要发现）：

- 更新源是 GitHub Releases（`desktop/build/win.json` 的 `publish: github`），
  发布线按 git tag（`v1.6.0`…`v1.8.0`）由 CI 出包；
- 仓库里 `desktop/package.json` 的版本号（`1.0.x`，本地打包自增）**永远低于发布线**；
- 于是本地包一装上就会"发现新版本"并被发布线覆盖——发布线是旧代码时，
  本修复（以及同日的 AI 生成修复）会被旧壳覆盖回去。

所以本修复要真正生效到用户机器上，需要从 main 打一个高于发布线的正式版本
（`git tag v1.8.1` → CI 构建发布），或者本地打包时用 `-Version` 压过发布线。

## 8. 经验沉淀 / 预防

1. **静默化改造要连日志一起补**：删弹窗容易，删完之后更新行为完全不可见，
   下一个排查的人只能靠猜。本次把更新器每个关键节点都落 `main.log`。
2. **桌面版版本号双轨**（本地 `desktop/package.json` 自增 vs CI 按 tag 回写）
   是本次"发现新版本 1.7.0"的结构性原因。建议：本地打包默认版本号从
   `max(git tag) + 1` 起跳，或在 README/发布流程里明确"本地包仅自测用、
   不要长期当正式版装"，否则本地包会被发布线自动"降级覆盖"。
3. 弹窗类交互（`dialog.showMessageBox`）在"自动/静默"类链路里只应该出现在
   **需要人类做决定**的分支；纯告知型弹窗一律改为日志/托盘通知。
