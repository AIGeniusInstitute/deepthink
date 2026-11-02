# 2026-11-02 Windows 桌面打包失败：npm rebuild 被运行中的实例锁死 better_sqlite3.node

## 1. 用户现象

执行 `scripts\pack-win.ps1` 打 Windows 桌面安装包，前 5 步（版本号 / 依赖 / 同步 / 编译）全部正常，
走到 **[6/7] 拉取内置 Node 二进制 + 原生模块 ABI 重建** 时红字终止：

```
[原生模块] 按内置 Node v22.11.0 重建 ...
npm error prebuild-install warn install EBUSY: resource busy or locked,
  open 'C:\Users\chenguangjian\deepthink\node_modules\better-sqlite3\build\Release\better_sqlite3.node'
npm error gyp ERR! clean error
npm error gyp ERR! stack Error: EPERM: operation not permitted,
  unlink '...\node_modules\better-sqlite3\build\Release\better_sqlite3.node'
❌ 命令失败: npm rebuild --no-audit --no-fund --registry=https://registry.npmmirror.com
```

`desktop\release\` 下没有产出 `DeepThink Setup *.exe`（上一次成功产物停留在 1.8.4）。

## 2. 问题描述

`pack-win.ps1` 的第 6 步会执行 `npm rebuild`，把 `better-sqlite3` 按内置 Node（v22.11.0）的 ABI
重建出 `build\Release\better_sqlite3.node`。该文件此刻被本机**正在运行的 DeepThink 后端进程**
加载着——Windows 对已 `LoadLibrary` 的 `.node` 文件持独占句柄——于是：

1. `prebuild-install`（先尝试）下载/解包成功后**覆盖写入**目标文件 → `EBUSY`；
2. 回退 `node-gyp rebuild`（后尝试）先做 `clean` 要 `unlink` 同一文件 → `EPERM`；
3. 两者都失败 → `npm error code 1` → 整个打包中断。

而本机实例有 `deepthink-watchdog.ps1` 看门狗守护（node 意外退出 3s 后自动拉起），
即使手动杀掉后端也会被重新拉起、重新加锁——这是"停了也没用"的隐藏坑。

## 3. 根因

**代码/平台层面**：Windows 文件锁语义——进程加载的原生模块（`.node` = DLL）在进程存活期间
不可被删除、重命名或覆盖写。`npm rebuild` 必须原地覆盖
`node_modules\better-sqlite3\build\Release\better_sqlite3.node`，与任何已加载该模块的
node 进程互斥。macOS/Linux 无此限制（unlink 不受运行中进程影响），所以 bash 版
`make desktop-pack-win` 从没暴露过这个问题，是 Windows-only 的打包阻塞。

**触发时刻的证据**（本次事故现场）：

| 进程 | PID | 说明 | 创建时间 |
|---|---|---|---|
| `node dist/index.js` | 79840 | 本仓库后端实例（监听 :9898，`cmd /c node dist/index.js >> logs\deepthink-9898.log`） | 17:57:43 |
| `powershell … scripts\deepthink-watchdog.ps1 -Port 9898` | 63216 | 该实例的看门狗，node 被杀会自动拉起 | — |

`pack-win.ps1` 在 **17:57:56**（pid 79840 启动后 13 秒）执行 `npm rebuild` 失败——
时间戳与 npm 日志 `2026-11-02T09_57_56_657Z`（UTC，= 本地 17:57:56）完全吻合。

**脚本层面**：`pack-win.ps1` 在 `Rebuild-Natives` 前没有任何"解除文件占用"逻辑，
也没有提前预检，白跑完前 5 步编译才在第 6 步撞锁失败。

## 4. 复现路径

1. 启动本机实例：`powershell -NoProfile -ExecutionPolicy Bypass -File scripts\rebuild-restart.ps1 9898`
   （或任意方式跑起 `node dist/index.js`，只要它加载了根 `node_modules` 的 better-sqlite3）；
2. 确认服务在监听：`Get-NetTCPConnection -LocalPort 9898 -State Listen`；
3. 执行打包：`powershell -NoProfile -ExecutionPolicy Bypass -File scripts\pack-win.ps1 -NoBump`；
4. 前 5 步通过，第 6 步 `npm rebuild` 必然 `EBUSY` / `EPERM` 失败。

## 5. 诊断方法

```powershell
# 1) binding 是否被独占（LOCKED 即有问题）
$f = 'C:\Users\chenguangjian\deepthink\node_modules\better-sqlite3\build\Release\better_sqlite3.node'
try { $s = [System.IO.File]::Open($f,'Open','ReadWrite','None'); $s.Close(); 'UNLOCKED' } catch { 'LOCKED' }

# 2) 谁加载了它（.node 走 LoadLibrary，会出现在进程模块列表里；精确路径比对不误伤）
foreach ($p in Get-Process -Name node, electron, DeepThink -ErrorAction SilentlyContinue) {
  try { if ($p.Modules | Where-Object { $_.FileName -eq (Resolve-Path $f).Path }) { "pid $($p.Id): $($p.Name)" } } catch {}
}

# 3) 是否有看门狗在守护（有则杀占用者也会被拉起）
Get-CimInstance Win32_Process |
  Where-Object { $_.CommandLine -match 'deepthink-watchdog' } |
  Select-Object ProcessId, CommandLine
```

## 6. 修复方案

`scripts\pack-win.ps1`：在 `Rebuild-Natives` 开头调用新增的 `Free-NativeBinding`，
在覆盖重建前解除占用。核心 diff：

```diff
 function Rebuild-Natives {
   Write-B ('   [原生模块] 按内置 Node {0} 重建 ...' -f $NodeVer)
+  Free-NativeBinding
   $oldTarget  = $env:npm_config_target
   ...
 }
+
+# 解除 better_sqlite3.node 的进程占用：停看门狗（防自动拉起）→ 停占用者 → 轮询确认解锁
+function Free-NativeBinding {
+  ... Test-FileLocked 判锁 ...
+  ... Get-BindingHolders 找占用者（模块列表精确匹配 binding 路径，不猜不误杀）...
+  ... Get-AutoRestartWatchdogs 找看门狗（命令行含本仓库路径，或占用者祖先链归因）...
+  # 先停看门狗再停占用者：只杀占用者的话 3s 后会被看门狗自动拉起重新加锁
+  ... Stop-Process 占用者与看门狗 → 轮询 10s 确认解锁 → 3 轮兜底（应对拉起竞态）...
+  ... 仍锁死则 Die 并给出资源监视器 / stop-prod.ps1 的处置指引 ...
+}
```

选型理由：

- **精确识别，不误杀**：占用者只认「进程模块列表里精确出现本仓库 binding 路径」的进程
  （`.node` 经 `LoadLibrary` 加载，必然在模块表里），照搬 `rebuild-restart.ps1` 的
  「只停本项目实例」纪律；枚举模块失败（权限）即跳过，宁可漏报不误杀。
- **看门狗双通道归因**：① 命令行含 `deepthink-watchdog` 且含本仓库路径；
  ② 占用者祖先链上的 `deepthink-watchdog`（`.sh` 版命令行可能是相对路径，靠血缘归因）。
  先杀看门狗再杀占用者，杜绝 3s 自动拉起竞态；外层再套 3 轮"重扫-重杀"兜底。
- **不改为临时目录重建**：换目录重建要动 electron-builder 的 files 约定与 Makefile 链路，
  改动面大且会让 macOS/Linux 行为出现分叉；解锁后原地重建是与 bash 版一致的最小改动。
- **失败可诊断**：解锁失败时输出资源监视器（CPU → 关联的句柄）定位法和
  `scripts\stop-prod.ps1 -Port <端口>` 兜底命令，不再是一句裸的 EBUSY。

## 7. 处理卡住的状态

事故发生时实例还在跑、打包已中断，无需救活运行态——**服务本身是健康的**，
只是与打包互斥。处置顺序（已验证）：

```powershell
# 停掉占用 binding 的实例（写停止标记 → 杀看门狗 → 杀端口监听，看门狗不会拉起）
powershell -NoProfile -ExecutionPolicy Bypass -File scripts\stop-prod.ps1 -Port 9898

# 打包（修复后脚本会自己做上面这一步，手动停只是等价兜底）
powershell -NoProfile -ExecutionPolicy Bypass -File scripts\pack-win.ps1 -NoBump

# 打包完成重新拉起服务（增量编译 + ABI 自检 + /health /ready 健康校验）
powershell -NoProfile -ExecutionPolicy Bypass -File scripts\rebuild-restart.ps1 9898
```

注意：`rebuild-restart.ps1` 的 `Ensure-NativeAbi` 会把 better-sqlite3 按**当前** Node
（PATH 里的 node）再重建一次——打包产物打进安装包的那份已经定型，不受影响。

## 8. 经验沉淀 / 预防

1. **Windows 上"改 .node 文件"与"加载该 .node 的进程"天然互斥**。任何要覆盖
   `node_modules\**\build\Release\*.node` 的脚本（`npm rebuild` / `npm install` 触发
   原生模块 install 脚本）都要先解除占用。本修复的 `Free-NativeBinding` 是通用模式：
   Test-FileLocked 判锁 → 模块表精确找持有者 → 先停自动拉起的守护再停持有者。
2. **守护进程会放大锁问题**：只杀持有者不杀看门狗 = 3s 后问题原样复现。停"被守护的进程"
   必须先停守护（`stop-prod.ps1` 的写停止标记 + 杀看门狗顺序就是为此设计的）。
3. **打包类脚本应预检互斥资源**：本修复把解锁放在 `Rebuild-Natives` 入口（覆盖前一刻执行，
   停机窗口最小）。若日后第 7 步 electron-builder 也撞锁（如 `desktop\release\*.exe`
   被安装器/杀软占用），同款诊断思路：先判锁、再找持有者、给出处置指引。
4. **排查进程占用优先用"模块表精确比对"而不是杀端口/杀名字**：`Get-Process … .Modules`
   能唯一定位"谁加载了这个 .node"，配合祖先链归因看门狗，全程不碰无关进程
   （对应项目规约：禁止 `lsof -ti:PORT | xargs kill` 式误杀）。
