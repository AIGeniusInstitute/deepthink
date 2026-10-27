# ──────────────────────────────────────────────────────────────
# DeepThink — 一键重新编译 / 构建 / 打包 / 部署本机实例（Windows 版 rebuild-restart.sh）
#
# 本质是 `make start-prod PORT=<端口>` 的 Windows 等价入口 + 启动后健康校验。
# 该端口上的实例形态（与 make start-prod 完全一致）：
#   数据目录  %USERPROFILE%\.deepthink-<PORT>  （独立 DB / 配置，与其它端口互不影响）
#   日志      logs\deepthink-<PORT>.log
#   托管      scripts\deepthink-watchdog.ps1 后台守护，node 意外退出自动拉起
#   停止      powershell -File scripts\stop-prod.ps1 -Port <PORT>
#
# 流程：停旧实例 → 增量编译（后端/前端/agent-runner）→ 构建本机 Docker 镜像
#       （deepthink-agent / deepthink-sandbox，需 Docker Desktop；无 Docker 时跳过并告警）
#       → 后台守护启动 → 健康校验
#
# 用法：
#   powershell -NoProfile -ExecutionPolicy Bypass -File scripts\rebuild-restart.ps1
#   powershell -NoProfile -ExecutionPolicy Bypass -File scripts\rebuild-restart.ps1 8080
#   powershell -NoProfile -ExecutionPolicy Bypass -File scripts\rebuild-restart.ps1 9999 -Full
#   powershell -NoProfile -ExecutionPolicy Bypass -File scripts\rebuild-restart.ps1 -Help
#
# 与 bash 版的差异（Windows 无 lsof / pgrep / nohup / make / SIGTERM）：
#   - 不走 make：增量检测、shared/ 类型同步、依赖检查均在本脚本内以 PowerShell 复刻
#     （对应 Makefile 的 _check-sync / _build-*-if-stale / _ensure-native-abi / install）
#   - 端口占用检测用 Get-NetTCPConnection；「占用者是本项目旧实例」用 pidfile 比对 +
#     祖先进程链含 deepthink-watchdog.ps1 判定（bash 版比对 cwd，Windows 拿不到 cwd）
#   - 进程停止为强杀（TerminateProcess），详见 scripts\stop-prod.ps1 头注释
#   - shared/ 同步的文件清单必须与 scripts/sync-stream-event.sh 保持一致
# ──────────────────────────────────────────────────────────────

[CmdletBinding()]
param(
  [Parameter(Position = 0)]
  [int]$Port = 9999,
  [switch]$Full,
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
  Write-Host 'DeepThink 一键重新编译 / 构建 / 部署本机实例（Windows）'
  Write-Host ''
  Write-Host '用法:'
  Write-Host '  powershell -NoProfile -ExecutionPolicy Bypass -File scripts\rebuild-restart.ps1 [PORT] [-Full]'
  Write-Host ''
  Write-Host '参数:'
  Write-Host '  PORT       服务端口（默认 9999）；数据目录 = %USERPROFILE%\.deepthink-<PORT>'
  Write-Host '  -Full      全量强制重建：强制重编后端/前端/agent-runner + 强制重建'
  Write-Host '             deepthink-agent / deepthink-sandbox 镜像（需 Docker，耗时较长）。'
  Write-Host '             不加则走增量检测，只重编改动的部分。'
  Write-Host '  -Help      显示本帮助'
  Write-Host ''
  Write-Host '流程:'
  Write-Host '  停旧实例 → 增量编译 → 构建本机 Docker 镜像 → 后台守护启动 → 健康校验'
  Write-Host ''
  Write-Host '停止/查看:'
  Write-Host '  powershell -NoProfile -ExecutionPolicy Bypass -File scripts\stop-prod.ps1 -Port <PORT>'
  Write-Host '  Get-Content -Wait logs\deepthink-<PORT>.log'
  exit 0
}

if ($Help) { Show-Usage }
if ($Port -le 0 -or $Port -gt 65535) { Die ('端口必须是 1-65535 的数字: {0}' -f $Port) }

Set-Location $Root

$DataDir  = Join-Path $HOME ('.deepthink-{0}' -f $Port)
$LogsDir  = Join-Path $Root 'logs'
$LogFile  = Join-Path $LogsDir ('deepthink-{0}.log' -f $Port)
$PidFile  = Join-Path $LogsDir ('deepthink-{0}.pid' -f $Port)
$StopFlag = Join-Path $LogsDir ('deepthink-{0}.stop' -f $Port)

# ── 基础工具 ─────────────────────────────────────────────────

function Touch-File([string]$path) {
  if (Test-Path -LiteralPath $path) {
    (Get-Item -LiteralPath $path).LastWriteTime = Get-Date
  } else {
    New-Item -ItemType File -Path $path | Out-Null
  }
}

function Show-LogTail {
  if (Test-Path -LiteralPath $LogFile) {
    Write-E ('──── {0} (最后 30 行) ────' -f $LogFile)
    Get-Content -LiteralPath $LogFile -Tail 30 -ErrorAction SilentlyContinue | ForEach-Object { Write-E $_ }
    Write-E '────────────────────────────────'
  }
}

function Invoke-Step([string]$file, [string[]]$stepArgs) {
  & $file @stepArgs
  if ($LASTEXITCODE -ne 0) { Die ('命令失败: {0} {1}' -f $file, ($stepArgs -join ' ')) }
}

function Get-PortListeners([int]$p) {
  @(Get-NetTCPConnection -LocalPort $p -State Listen -ErrorAction SilentlyContinue |
      Select-Object -ExpandProperty OwningProcess -Unique)
}

function Get-ProcessCommandLine([int]$procId) {
  $proc = Get-CimInstance Win32_Process -Filter ('ProcessId={0}' -f $procId) -ErrorAction SilentlyContinue
  if ($proc) { return [string]$proc.CommandLine }
  return ''
}

# 沿 ParentProcessId 向上找 deepthink-watchdog.ps1。Windows 拿不到进程 cwd，
# 用「由本项目看门狗拉起」证明占用者是本项目旧实例（等价 bash 版的 cwd == ROOT 判定）
function Test-WatchdogAncestor([int]$procId) {
  $cur = $procId
  for ($i = 0; $i -lt 10 -and $cur -gt 0; $i++) {
    $proc = Get-CimInstance Win32_Process -Filter ('ProcessId={0}' -f $cur) -ErrorAction SilentlyContinue
    if (-not $proc) { break }
    if ($proc.CommandLine -and $proc.CommandLine -match 'deepthink-watchdog\.ps1') { return $true }
    $cur = [int]$proc.ParentProcessId
  }
  return $false
}

function Test-AnyFileNewer([string[]]$refFiles, [datetime]$refTime) {
  foreach ($f in $refFiles) {
    if ((Test-Path -LiteralPath $f) -and ((Get-Item -LiteralPath $f).LastWriteTime -gt $refTime)) { return $true }
  }
  return $false
}

function Test-TreeNewer([string]$dir, [string[]]$patterns, [datetime]$refTime) {
  if (-not (Test-Path -LiteralPath $dir)) { return $false }
  foreach ($pat in $patterns) {
    $hit = Get-ChildItem -LiteralPath $dir -Recurse -File -Filter $pat -ErrorAction SilentlyContinue |
           Where-Object { $_.LastWriteTime -gt $refTime } | Select-Object -First 1
    if ($hit) { return $true }
  }
  return $false
}

function Get-UrlBody([string]$url) {
  try {
    $resp = Invoke-WebRequest -Uri $url -UseBasicParsing -TimeoutSec 3
    return [string]$resp.Content
  } catch {
    return ''
  }
}

# ── shared/ 单向真相源同步（复刻 scripts/sync-stream-event.sh）──
# 文件清单必须与该脚本保持一致；改 shared/ 后本函数按内容差异复制，不动无变化副本的时间戳
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

# ── 编译（对应 Makefile 的 build / _build-*-if-stale）──────────

function Build-Backend {
  Write-B '   [后端] npm run build ...'
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

function Build-CodeAll {
  Build-Backend
  Build-Web
  Build-AgentRunner
}

function Build-CodeStale {
  # 后端
  $target = Join-Path $Root 'dist\index.js'
  if (-not (Test-Path -LiteralPath $target)) {
    Build-Backend
  } else {
    $t = (Get-Item -LiteralPath $target).LastWriteTime
    $refs = @((Join-Path $Root 'package.json'), (Join-Path $Root 'tsconfig.json'))
    if ((Test-AnyFileNewer $refs $t) -or (Test-TreeNewer (Join-Path $Root 'src') @('*.ts') $t)) {
      Build-Backend
    } else {
      Write-G '   ✅ 后端无变更，跳过编译'
    }
  }
  # 前端
  $target = Join-Path $Root 'web\dist\index.html'
  if (-not (Test-Path -LiteralPath $target)) {
    Build-Web
  } else {
    $t = (Get-Item -LiteralPath $target).LastWriteTime
    $refs = @(
      (Join-Path $Root 'web\package.json'),
      (Join-Path $Root 'web\vite.config.ts'),
      (Join-Path $Root 'web\index.html'),
      (Join-Path $Root 'web\tsconfig.json')
    )
    if ((Test-AnyFileNewer $refs $t) -or (Test-TreeNewer (Join-Path $Root 'web\src') @('*.ts', '*.tsx', '*.css') $t)) {
      Build-Web
    } else {
      Write-G '   ✅ 前端无变更，跳过编译'
    }
  }
  # agent-runner
  $target = Join-Path $Root 'container\agent-runner\dist\.tsbuildinfo'
  if (-not (Test-Path -LiteralPath $target)) {
    Build-AgentRunner
  } else {
    $t = (Get-Item -LiteralPath $target).LastWriteTime
    $refs = @(
      (Join-Path $Root 'container\agent-runner\package.json'),
      (Join-Path $Root 'container\agent-runner\tsconfig.json')
    )
    if ((Test-AnyFileNewer $refs $t) -or (Test-TreeNewer (Join-Path $Root 'container\agent-runner\src') @('*.ts') $t)) {
      Build-AgentRunner
    } else {
      Write-G '   ✅ agent-runner 无变更，跳过编译'
    }
  }
}

# ── 依赖检查 / 安装（对应 Makefile 的 install）────────────────

function Test-DepsStale {
  foreach ($p in @('.', 'web', 'container\agent-runner')) {
    $base = if ($p -eq '.') { $Root } else { Join-Path $Root $p }
    $nm  = Join-Path $base 'node_modules'
    $pkg = Join-Path $base 'package.json'
    if (-not (Test-Path -LiteralPath $nm)) { return $true }
    if ((Get-Item -LiteralPath $pkg).LastWriteTime -gt (Get-Item -LiteralPath $nm).LastWriteTime) { return $true }
  }
  return $false
}

function Install-Dependencies {
  Write-B '📦 依赖有更新，安装依赖...'
  $reg = @('--registry=https://registry.npmmirror.com')
  # --allow-git=all：npm 12 起默认禁用 git 依赖（EALLOWGIT），baileys 有两个 github: 依赖
  Invoke-Step 'npm' (@('install', '--allow-git=all') + $reg)
  Invoke-Step 'npm' (@('--prefix', 'container\agent-runner', 'install') + $reg)
  Invoke-Step 'npm' (@('--prefix', 'container\agent-runner', 'run', 'build') + $reg)
  Invoke-Step 'npm' (@('--prefix', 'web', 'install') + $reg)
}

# ── 原生模块 ABI（对应 Makefile 的 _ensure-native-abi）────────

function Ensure-NativeAbi {
  if (-not (Test-Path -LiteralPath (Join-Path $Root 'node_modules\better-sqlite3'))) { return }
  & node -e "require('better-sqlite3')(':memory:').exec('select 1')"
  if ($LASTEXITCODE -ne 0) {
    $nodeVer = & node --version
    Write-Y ('🔄 检测到原生模块（better-sqlite3）ABI 与当前 Node {0} 不匹配，正在重新编译...' -f $nodeVer)
    Invoke-Step 'npm' @('rebuild', 'better-sqlite3', '--no-progress')
    & node -e "require('better-sqlite3')(':memory:').exec('select 1')"
    if ($LASTEXITCODE -ne 0) { Die 'better-sqlite3 重新编译后仍无法加载，请手动执行: npm rebuild better-sqlite3' }
    Write-G '   ✅ 原生模块已重新编译'
  }
}

# ── Docker 镜像（对应 Makefile 的 _ensure-docker-image / _ensure-sandbox-image）──

function Test-DockerReady {
  if (-not (Get-Command docker -ErrorAction SilentlyContinue)) { return $false }
  & cmd /c 'docker info >NUL 2>&1'
  return ($LASTEXITCODE -eq 0)
}

function Build-AgentImage {
  # 参数与默认值复刻 container/build.sh（国内镜像源默认值一致，环境变量可覆盖）
  $buildNetwork = if ($env:BUILD_NETWORK) { $env:BUILD_NETWORK } else { 'host' }
  $npmRegistry  = if ($env:NPM_REGISTRY) { $env:NPM_REGISTRY } else { 'https://registry.npmmirror.com' }
  $pipIndex     = if ($env:PIP_INDEX_URL) { $env:PIP_INDEX_URL } else { 'https://mirrors.aliyun.com/pypi/simple/' }
  $aptMirror    = if ($null -ne [Environment]::GetEnvironmentVariable('APT_MIRROR')) { $env:APT_MIRROR } else { 'mirrors.ustc.edu.cn' }
  $ghMirror     = if ($null -ne [Environment]::GetEnvironmentVariable('GITHUB_MIRROR')) { $env:GITHUB_MIRROR } else { 'https://gh-proxy.com/' }
  if (-not $env:DOCKER_BUILDKIT) { $env:DOCKER_BUILDKIT = '1' }
  $cachebust = [DateTimeOffset]::Now.ToUnixTimeSeconds()
  Push-Location (Join-Path $Root 'container')
  try {
    Write-B ('   🐳 构建 deepthink-agent:latest（network={0}）...' -f $buildNetwork)
    & docker build --network=$buildNetwork "--build-arg=CACHEBUST=$cachebust" "--build-arg=NPM_REGISTRY=$npmRegistry" "--build-arg=PIP_INDEX_URL=$pipIndex" "--build-arg=APT_MIRROR=$aptMirror" "--build-arg=GITHUB_MIRROR=$ghMirror" -t deepthink-agent:latest .
    if ($LASTEXITCODE -ne 0 -and $buildNetwork -eq 'host') {
      Write-Y '   host 网络构建失败（受限 builder？），改用默认 bridge 重试...'
      & docker build --network=default "--build-arg=CACHEBUST=$cachebust" "--build-arg=NPM_REGISTRY=$npmRegistry" "--build-arg=PIP_INDEX_URL=$pipIndex" "--build-arg=APT_MIRROR=$aptMirror" "--build-arg=GITHUB_MIRROR=$ghMirror" -t deepthink-agent:latest .
    }
    if ($LASTEXITCODE -ne 0) { Die 'agent 镜像构建失败' }
  } finally {
    Pop-Location
  }
  Touch-File (Join-Path $Root '.docker-build-sentinel')
}

function Build-SandboxImage {
  Write-B '   🐳 构建 deepthink-sandbox:latest ...'
  Push-Location (Join-Path $Root 'container\sandbox')
  try {
    & docker build -t deepthink-sandbox:latest .
    if ($LASTEXITCODE -ne 0) { Die '沙箱镜像构建失败' }
  } finally {
    Pop-Location
  }
  Touch-File (Join-Path $Root '.sandbox-docker-build-sentinel')
}

function Ensure-AgentImage([bool]$force) {
  $sentinel = Join-Path $Root '.docker-build-sentinel'
  $doBuild = $force
  if (-not $doBuild) {
    & cmd /c 'docker image inspect deepthink-agent:latest >NUL 2>&1'
    if ($LASTEXITCODE -ne 0) { $doBuild = $true }
    elseif (-not (Test-Path -LiteralPath $sentinel)) { $doBuild = $true }
    else {
      $t = (Get-Item -LiteralPath $sentinel).LastWriteTime
      $refs = @((Join-Path $Root 'container\Dockerfile'), (Join-Path $Root 'container\entrypoint.sh'))
      if ((Test-AnyFileNewer $refs $t) -or
          (Test-TreeNewer (Join-Path $Root 'container\agent-runner\src') @('*.ts') $t) -or
          (Test-TreeNewer (Join-Path $Root 'container\agent-runner\prompts') @('*') $t)) {
        $doBuild = $true
      }
    }
  }
  if (-not $doBuild) { Write-G '   ✅ Docker 镜像无需重建'; return }
  Build-AgentImage
}

function Ensure-SandboxImage([bool]$force) {
  $sentinel = Join-Path $Root '.sandbox-docker-build-sentinel'
  $doBuild = $force
  if (-not $doBuild) {
    & cmd /c 'docker image inspect deepthink-sandbox:latest >NUL 2>&1'
    if ($LASTEXITCODE -ne 0) { $doBuild = $true }
    elseif (-not (Test-Path -LiteralPath $sentinel)) { $doBuild = $true }
    else {
      $t = (Get-Item -LiteralPath $sentinel).LastWriteTime
      $refs = @(
        (Join-Path $Root 'container\sandbox\Dockerfile'),
        (Join-Path $Root 'container\sandbox\entry.sh'),
        (Join-Path $Root 'container\sandbox\seccomp-profile.json')
      )
      if (Test-AnyFileNewer $refs $t) { $doBuild = $true }
    }
  }
  if (-not $doBuild) { Write-G '   ✅ 沙箱镜像无需重建'; return }
  Build-SandboxImage
}

# ── 启动看门狗 ───────────────────────────────────────────────

function Start-Watchdog {
  $psExe = if ($PSVersionTable.PSEdition -eq 'Core') { 'pwsh' } else { 'powershell' }
  $wdScript = Join-Path $Root 'scripts\deepthink-watchdog.ps1'
  $argList = @(
    '-NoProfile', '-ExecutionPolicy', 'Bypass', '-File', ('"{0}"' -f $wdScript),
    '-Port', ('{0}' -f $Port),
    '-DataDir', ('"{0}"' -f $DataDir),
    '-LogFile', ('"{0}"' -f $LogFile),
    '-StopFlag', ('"{0}"' -f $StopFlag),
    '-PidFile', ('"{0}"' -f $PidFile)
  )
  Start-Process -FilePath $psExe -ArgumentList $argList -WindowStyle Hidden | Out-Null
}

# ── 前置检查 ─────────────────────────────────────────────────
if (-not (Test-Path -LiteralPath (Join-Path $Root 'package.json'))) { Die '找不到 package.json，脚本必须位于项目仓库内' }
if (-not (Get-Command node -ErrorAction SilentlyContinue)) { Die '未安装 Node.js' }
if (-not (Get-Command npm -ErrorAction SilentlyContinue)) { Die '未安装 npm' }
Write-G ('✅ 项目根目录: {0}' -f $Root)

# ── 端口占用预检（放在耗时构建之前，避免白跑几分钟才失败）────
# 只有当占用者是「本项目的旧实例」（pidfile 匹配，或由 deepthink-watchdog.ps1 拉起）时才放行，
# 否则中止避免误杀无关程序
$listenerPids = Get-PortListeners $Port
if ($listenerPids.Count -gt 0) {
  $holderPid = $listenerPids[0]
  $holderCmd = Get-ProcessCommandLine $holderPid
  $isOurs = $false
  if (Test-Path -LiteralPath $PidFile) {
    $wantPid = 0
    try { $wantPid = [int]((Get-Content -LiteralPath $PidFile -TotalCount 1 -ErrorAction Stop).Trim()) } catch { }
    if ($wantPid -eq $holderPid) { $isOurs = $true }
  }
  if (-not $isOurs -and (Test-WatchdogAncestor $holderPid)) { $isOurs = $true }
  if ($isOurs) {
    Write-Y ('   端口 {0} 已被本项目的旧实例占用（pid {1}），将自动停掉后重启' -f $Port, $holderPid)
  } else {
    Write-E ('❌ 端口 {0} 被无关程序占用，已中止（避免误杀）：' -f $Port)
    $shortCmd = if ($holderCmd.Length -gt 120) { $holderCmd.Substring(0, 120) } else { $holderCmd }
    Write-E ('   pid {0}: {1}' -f $holderPid, $shortCmd)
    Write-E '   本脚本只会停掉由 scripts\deepthink-watchdog.ps1 拉起、且 pidfile 匹配的旧实例。'
    Write-E '   请改用其它端口，或先自行处理该进程后重试。'
    exit 1
  }
}

# ── 可选：全量强制重建 ───────────────────────────────────────
if ($Full) {
  Write-Y '▶ 全量强制重建已启用（跳过增量检测，耗时较长）'
  Write-B '   [1/3] 编译后端 / 前端 / agent-runner ...'
  Sync-SharedTypes
  Build-CodeAll
  if (Test-DockerReady) {
    Write-B '   [2/3] 重建 agent 镜像 deepthink-agent:latest ...'
    Build-AgentImage
    Write-B '   [3/3] 重建沙箱镜像 deepthink-sandbox:latest ...'
    Build-SandboxImage
  } else {
    Write-Y '   ⚠️ 未检测到可用的 Docker，跳过镜像重建（宿主机模式不受影响；容器模式群组需先安装/启动 Docker Desktop）'
  }
  Write-G '   全量重建完成'
}

# ── 停旧实例 → 编译 → 构建镜像 → 启动 ───────────────────────
Write-B ('▶ 停止旧实例 → 编译 → 构建镜像 → 后台守护启动（端口 {0}）...' -f $Port)
& (Join-Path $PSScriptRoot 'stop-prod.ps1') -Port $Port
if ($LASTEXITCODE -ne 0) {
  Write-E '❌ 停止旧实例失败'
  Show-LogTail
  exit 1
}

if (Test-DepsStale) {
  Install-Dependencies
} else {
  Write-G '✅ 依赖无更新，跳过安装'
}
Sync-SharedTypes
Build-CodeStale
Ensure-NativeAbi

if (Test-DockerReady) {
  Ensure-AgentImage $false
  Ensure-SandboxImage $false
} else {
  Write-Y '⚠️ 未检测到可用的 Docker，跳过镜像检查（宿主机模式不受影响；容器模式群组需先安装/启动 Docker Desktop）'
}

# ── 后台守护启动 ─────────────────────────────────────────────
New-Item -ItemType Directory -Force -Path $LogsDir | Out-Null
Remove-Item -LiteralPath $StopFlag -Force -ErrorAction SilentlyContinue
[System.IO.File]::WriteAllText($LogFile, '')
Write-B ('🚀 后台守护启动（端口 {0}，watchdog 自动重启）...' -f $Port)
Start-Watchdog

# ── 健康校验 ─────────────────────────────────────────────────
# 注意：不能只看 HTTP 状态码。端口上若跑着别的程序，/health 可能被对方的 SPA
# 兜底路由以 200 + HTML 返回。因此先确认监听该端口的确实是本次启动的 node
# （比对 pidfile），再校验响应体是 DeepThink 的 JSON。
$healthUrl = 'http://127.0.0.1:{0}/health' -f $Port
$readyUrl  = 'http://127.0.0.1:{0}/ready' -f $Port

Write-B ('▶ 等待端口 {0} 由本次启动的实例监听...' -f $Port)
$listening = $false
for ($i = 1; $i -le 15; $i++) {
  if ((Get-PortListeners $Port).Count -gt 0) { $listening = $true; break }
  Start-Sleep -Seconds 1
}
if (-not $listening) {
  Write-E ('❌ 端口 {0} 无监听进程，实例未起来' -f $Port)
  Show-LogTail
  exit 1
}
$listenPid = (Get-PortListeners $Port)[0]
$wantPid = 0
if (Test-Path -LiteralPath $PidFile) {
  try { $wantPid = [int]((Get-Content -LiteralPath $PidFile -TotalCount 1 -ErrorAction Stop).Trim()) } catch { }
}
if ($wantPid -eq 0 -or $listenPid -ne $wantPid) {
  Write-E ('❌ 端口 {0} 被其它进程占用（监听 pid {1}），本次启动的实例是 pid {2}' -f $Port, $listenPid, $wantPid)
  Write-E ('   该端口的实例日志：{0}' -f $LogFile)
  exit 1
}
Write-G ('   端口由本次实例监听（node pid {0}）' -f $wantPid)

Write-B '▶ 等待进程存活 /health（最长 30s）...'
$healthOk = $false
for ($i = 1; $i -le 15; $i++) {
  if ((Get-UrlBody $healthUrl) -like '*"status":"ok"*') {
    Write-G ('   /health OK（{0}*2s）' -f $i)
    $healthOk = $true
    break
  }
  Start-Sleep -Seconds 2
}
if (-not $healthOk) {
  Write-E '/health 未返回预期的 {"status":"ok"}'
  $last = Get-UrlBody $healthUrl
  if ($last.Length -gt 200) { $last = $last.Substring(0, 200) }
  if (-not $last) { $last = '(无响应)' }
  Write-E ('   最后响应: {0}' -f $last)
  Show-LogTail
  exit 1
}

Write-B '▶ 等待依赖就绪 /ready（最长 60s）...'
$readyOk = $false
for ($i = 1; $i -le 30; $i++) {
  if ((Get-UrlBody $readyUrl) -like '*"status":"ready"*') {
    Write-G ('   /ready OK（{0}*2s）' -f $i)
    $readyOk = $true
    break
  }
  Start-Sleep -Seconds 2
}
if (-not $readyOk) {
  Write-E '/ready 未返回预期的 {"status":"ready"}（依赖未就绪）'
  $last = Get-UrlBody $readyUrl
  if ($last.Length -gt 200) { $last = $last.Substring(0, 200) }
  if (-not $last) { $last = '(无响应)' }
  Write-E ('   最后响应: {0}' -f $last)
  Show-LogTail
  exit 1
}

# ── 输出 ─────────────────────────────────────────────────────
Write-Host ''
Write-G '═══════════════════════════════════════════════'
Write-G ' ✅ DeepThink 已重新编译、构建并部署'
Write-B ('   Web UI  ：http://localhost:{0}' -f $Port)
Write-B ('   数据目录：{0}' -f $DataDir)
Write-B ('   日志    ：Get-Content -Wait {0}' -f $LogFile)
Write-B ('   停止    ：powershell -NoProfile -ExecutionPolicy Bypass -File scripts\stop-prod.ps1 -Port {0}' -f $Port)
Write-G '═══════════════════════════════════════════════'
