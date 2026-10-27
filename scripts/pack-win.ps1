# ──────────────────────────────────────────────────────────────
# DeepThink — Windows 桌面版一键打包（Windows 版 make desktop-pack-win）
#
# 在没有 make 的 Windows 机器上打出 NSIS 安装包（desktop\release\*.exe）。
#
# 流程（复刻 Makefile 的 desktop-pack-win 链路）：
#   依赖检查/安装（root / web / agent-runner / desktop）
#   → shared/ 单向真相源同步 → 编译后端 / 前端 / agent-runner / Electron 壳
#   → 拉取内置 Node 二进制（dev-resources\node\）
#   → 原生模块（better-sqlite3 等）按内置 Node ABI 重建并校验
#   → electron-builder 打包（build\win.json，--publish never）
#
# 用法：
#   powershell -NoProfile -ExecutionPolicy Bypass -File scripts\pack-win.ps1
#   powershell -NoProfile -ExecutionPolicy Bypass -File scripts\pack-win.ps1 -Help
#
# 环境变量：
#   DESKTOP_NODE_VERSION  内置 Node 版本（默认 v22.11.0，与 Makefile 一致）
#
# 与 bash 版的差异（Windows 无 make）：
#   - 不走 make：desktop-pack-win 的各步在本脚本内以 PowerShell 复刻
#     （对应 Makefile 的 root-install / web-install / agent-runner-install /
#      desktop-install / sync-types / build / desktop-rebuild-natives）
#   - shared/ 同步的文件清单必须与 scripts/sync-stream-event.sh 保持一致
#     （与 scripts\rebuild-restart.ps1 的 Sync-SharedTypes 同款清单）
# ──────────────────────────────────────────────────────────────

[CmdletBinding()]
param(
  [Alias('h')]
  [switch]$Help
)

$ErrorActionPreference = 'Stop'

$Root = Split-Path -Parent $PSScriptRoot

function Write-G([string]$m) { Write-Host $m -ForegroundColor Green }
function Write-B([string]$m) { Write-Host $m -ForegroundColor Cyan }
function Write-Y([string]$m) { Write-Host $m -ForegroundColor Yellow }
function Write-E([string]$m) { Write-Host $m -ForegroundColor Red }
function Die([string]$msg) { Write-E ('❌ ' + $msg); exit 1 }

function Show-Usage {
  Write-Host 'DeepThink Windows 桌面版一键打包（Windows 版 make desktop-pack-win）'
  Write-Host ''
  Write-Host '用法:'
  Write-Host '  powershell -NoProfile -ExecutionPolicy Bypass -File scripts\pack-win.ps1'
  Write-Host ''
  Write-Host '环境变量:'
  Write-Host '  DESKTOP_NODE_VERSION  内置 Node 版本（默认 v22.11.0）'
  Write-Host ''
  Write-Host '产物:'
  Write-Host '  desktop\release\DeepThink Setup <version>.exe（NSIS 安装包）'
  exit 0
}

if ($Help) { Show-Usage }

Set-Location $Root

# 国内 npm 镜像源（与 Makefile 的 NPM_FLAGS 一致）
$Reg = @('--registry=https://registry.npmmirror.com')
$NodeVer = if ($env:DESKTOP_NODE_VERSION) { $env:DESKTOP_NODE_VERSION } else { 'v22.11.0' }

# ── 基础工具 ─────────────────────────────────────────────────

function Invoke-Step([string]$file, [string[]]$stepArgs) {
  & $file @stepArgs
  if ($LASTEXITCODE -ne 0) { Die ('命令失败: {0} {1}' -f $file, ($stepArgs -join ' ')) }
}

# ── shared/ 单向真相源同步（复刻 scripts/sync-stream-event.sh）──
# 文件清单必须与该脚本保持一致；按内容差异复制，不动无变化副本的时间戳
function Sync-SharedTypes {
  $pairs = @(
    @('shared\stream-event.ts', 'container\agent-runner\src\stream-event.types.ts'),
    @('shared\stream-event.ts', 'src\stream-event.types.ts'),
    @('shared\stream-event.ts', 'web\src\stream-event.types.ts'),
    @('shared\image-detector.ts', 'src\image-detector.ts'),
    @('shared\image-detector.ts', 'container\agent-runner\src\image-detector.ts'),
    @('shared\channel-prefixes.ts', 'src\channel-prefixes.ts'),
    @('shared\channel-prefixes.ts', 'container\agent-runner\src\channel-prefixes.ts'),
    @('shared\web-search.ts', 'src\web-search.ts'),
    @('shared\web-search.ts', 'container\agent-runner\src\web-search.ts')
  )
  foreach ($pair in $pairs) {
    $src = Join-Path $Root $pair[0]
    $dst = Join-Path $Root $pair[1]
    $need = $true
    if (Test-Path -LiteralPath $dst) {
      if ((Get-FileHash -LiteralPath $src -Algorithm SHA256).Hash -eq (Get-FileHash -LiteralPath $dst -Algorithm SHA256).Hash) {
        $need = $false
      }
    }
    if ($need) {
      Copy-Item -LiteralPath $src -Destination $dst -Force
      Write-Y ('   🔄 同步 {0} → {1}' -f $pair[0], $pair[1])
    }
  }
}

# ── 依赖安装（对应 Makefile 的 root-install / web-install / agent-runner-install / desktop-install）──

function Install-IfStale([string]$dir, [bool]$allowGit) {
  $base = if ($dir -eq '.') { $Root } else { Join-Path $Root $dir }
  $nm  = Join-Path $base 'node_modules'
  $pkg = Join-Path $base 'package.json'
  if ((Test-Path -LiteralPath $nm) -and ((Get-Item -LiteralPath $pkg).LastWriteTime -le (Get-Item -LiteralPath $nm).LastWriteTime)) {
    Write-G ('   ✅ {0} 依赖无更新，跳过安装' -f $dir)
    return
  }
  Write-B ('   📦 安装 {0} 依赖 ...' -f $dir)
  $cmdArgs = @('install', '--no-audit', '--no-fund')
  # --allow-git=all：npm 12 起默认禁用 git 依赖（EALLOWGIT），baileys 有两个 github: 依赖
  if ($allowGit) { $cmdArgs += '--allow-git=all' }
  $prefix = if ($dir -eq '.') { @() } else { @('--prefix', $dir) }
  Invoke-Step 'npm' ($prefix + $cmdArgs + $Reg)
}

# ── 编译（对应 Makefile 的 build / desktop-build）────────────

function Build-Backend {
  Write-B '   [后端] npm run build ...'
  # npm run build = tsc && node scripts/copy-runtime-assets.cjs（非 .js 运行时资产进 dist/）
  Invoke-Step 'npm' @('run', 'build')
}

function Build-Web {
  Write-B '   [前端] npm --prefix web run build ...'
  Invoke-Step 'npm' @('--prefix', 'web', 'run', 'build')
}

function Build-AgentRunner {
  Write-B '   [agent-runner] npm --prefix container/agent-runner run build ...'
  Invoke-Step 'npm' @('--prefix', 'container/agent-runner', 'run', 'build')
}

function Build-DesktopShell {
  Write-B '   [Electron 壳] npm --prefix desktop run build ...'
  Invoke-Step 'npm' @('--prefix', 'desktop', 'run', 'build')
}

# ── 原生模块 ABI（对应 Makefile 的 desktop-rebuild-natives）──

function Rebuild-Natives {
  Write-B ('   [原生模块] 按内置 Node {0} 重建 ...' -f $NodeVer)
  $oldTarget  = $env:npm_config_target
  $oldRuntime = $env:npm_config_runtime
  $env:npm_config_target  = $NodeVer
  $env:npm_config_runtime = 'node'
  try {
    Invoke-Step 'npm' (@('rebuild', '--no-audit', '--no-fund') + $Reg)
  } finally {
    $env:npm_config_target  = $oldTarget
    $env:npm_config_runtime = $oldRuntime
  }
  # rebuild 后必须校验产物：npm 12 默认 allow-scripts 拦截 install 脚本时，npm rebuild
  # 会"成功"但 better-sqlite3 不产出 binding，打进包后后端启动即崩
  # （见 docs/issues/2026-08-21-desktop-dmg-better-sqlite3-missing.md）
  $binding = Join-Path $Root 'node_modules\better-sqlite3\build\Release\better_sqlite3.node'
  if (-not (Test-Path -LiteralPath $binding)) {
    Die 'better-sqlite3 rebuild 后仍无 build\Release\better_sqlite3.node（多半是 install 脚本被 npm 12 allow-scripts 拦截，检查根 package.json 的 allowScripts 白名单）'
  }
  $nodeExe = Join-Path $Root 'dev-resources\node\node.exe'
  if (-not (Test-Path -LiteralPath $nodeExe)) { $nodeExe = Join-Path $Root 'dev-resources\node\node' }
  & $nodeExe -e "require('better-sqlite3')(':memory:').exec('select 1')"
  if ($LASTEXITCODE -ne 0) { Die ('better-sqlite3 binding 无法在内置 Node {0} 下加载（ABI 不匹配）' -f $NodeVer) }
  Write-G ('   ✅ native binding 已通过内置 Node {0} 加载校验' -f $NodeVer)
}

# ── 前置检查 ─────────────────────────────────────────────────
if (-not (Test-Path -LiteralPath (Join-Path $Root 'package.json'))) { Die '找不到 package.json，脚本必须位于项目仓库内' }
if (-not (Get-Command node -ErrorAction SilentlyContinue)) { Die '未安装 Node.js' }
if (-not (Get-Command npm -ErrorAction SilentlyContinue)) { Die '未安装 npm' }
Write-G ('✅ 项目根目录: {0}' -f $Root)
Write-G ('✅ 内置 Node 版本: {0}' -f $NodeVer)

# ── 打包流程 ─────────────────────────────────────────────────
Write-B '▶ [1/6] 安装依赖 ...'
Install-IfStale '.' $true
Install-IfStale 'web' $false
# agent-runner 每次都装：claude-agent-sdk 用 "*" + 无 lock file，取最新
Write-B '   📦 安装 container/agent-runner 依赖 ...'
Invoke-Step 'npm' (@('--prefix', 'container/agent-runner', 'install', '--no-audit', '--no-fund') + $Reg)
Install-IfStale 'desktop' $false

Write-B '▶ [2/6] 同步 shared/ 类型真相源 ...'
Sync-SharedTypes

Write-B '▶ [3/6] 编译后端 / 前端 / agent-runner ...'
Build-Backend
Build-Web
Build-AgentRunner

Write-B '▶ [4/6] 编译 Electron 壳 ...'
Build-DesktopShell

Write-B '▶ [5/6] 拉取内置 Node 二进制 + 原生模块 ABI 重建 ...'
$env:NODE_VERSION = $NodeVer
Invoke-Step 'node' @('scripts\fetch-node-binary.js')
Rebuild-Natives

Write-B '▶ [6/6] electron-builder 打包（win / nsis）...'
# 重新按 TARGET_PLATFORM=win ARCH=x64 取内置 Node（打包进安装包的那份）
$env:TARGET_PLATFORM = 'win'
$env:ARCH = 'x64'
Invoke-Step 'node' @('scripts\fetch-node-binary.js')
# --publish never：build\win.json 里的 publish 配置只用于生成自动更新元数据，
# 否则 electron-builder 会构造 GitHub publisher 要求 GH_TOKEN 导致打包收尾失败
Push-Location (Join-Path $Root 'desktop')
try {
  Invoke-Step 'npx' @('electron-builder', '--config', 'build/win.json', '--publish', 'never')
} finally {
  Pop-Location
}

# ── 输出 ─────────────────────────────────────────────────────
$releaseDir = Join-Path $Root 'desktop\release'
Write-Host ''
Write-G '═══════════════════════════════════════════════'
Write-G ' ✅ Windows 打包完成'
if (Test-Path -LiteralPath $releaseDir) {
  Get-ChildItem -LiteralPath $releaseDir -File | Where-Object { $_.Extension -in @('.exe', '.blockmap', '.yml') } | ForEach-Object {
    Write-B ('   {0}  ({1:N1} MB)' -f $_.FullName, ($_.Length / 1MB))
  }
}
Write-B ('   产物目录：{0}' -f $releaseDir)
Write-G '═══════════════════════════════════════════════'
