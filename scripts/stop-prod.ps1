# ──────────────────────────────────────────────────────────────
# DeepThink — 停止指定端口的隔离生产实例（Windows 版 `make stop-prod`）
#
# 流程与 Makefile 的 stop-prod 一致：
#   写停止标记 → 停掉 deepthink-watchdog.ps1 看门狗 → 杀该端口的 LISTEN 监听进程。
#   停止标记通知看门狗「这是主动停止」，使其不自动拉起
#   （下次启动前 rebuild-restart.ps1 会清掉该标记）。
#
# 用法：
#   powershell -NoProfile -ExecutionPolicy Bypass -File scripts\stop-prod.ps1 -Port 9999
#
# 与 Unix 版的差异：
#   - Windows 没有 SIGTERM，进程停止用 TerminateProcess（等价 SIGKILL）。主服务的
#     SQLite 是 WAL 模式，强杀可安全崩溃恢复；IM 长连接等优雅关闭逻辑不会执行。
#   - 只杀「该端口处于 LISTEN 状态」的进程，不碰其它连接（项目规约：禁止误杀
#     Docker 网络代理等无关进程，对应 Unix 版的 `lsof -ti:PORT -sTCP:LISTEN`）。
# ──────────────────────────────────────────────────────────────

[CmdletBinding()]
param(
  [Parameter(Position = 0)]
  [int]$Port = 0
)

$ErrorActionPreference = 'Stop'

if ($Port -le 0 -or $Port -gt 65535) {
  Write-Host '用法: powershell -NoProfile -ExecutionPolicy Bypass -File scripts\stop-prod.ps1 -Port 9999' -ForegroundColor Red
  exit 1
}

$Root     = Split-Path -Parent $PSScriptRoot
$LogsDir  = Join-Path $Root 'logs'
$StopFlag = Join-Path $LogsDir ('deepthink-{0}.stop' -f $Port)
$PidFile  = Join-Path $LogsDir ('deepthink-{0}.pid' -f $Port)

function Write-G([string]$m) { Write-Host $m -ForegroundColor Green }
function Write-Y([string]$m) { Write-Host $m -ForegroundColor Yellow }
function Write-E([string]$m) { Write-Host $m -ForegroundColor Red }

function Touch-File([string]$path) {
  if (Test-Path -LiteralPath $path) {
    (Get-Item -LiteralPath $path).LastWriteTime = Get-Date
  } else {
    New-Item -ItemType File -Path $path | Out-Null
  }
}

# 该端口处于 LISTEN 状态的进程 pid
function Get-PortListeners([int]$p) {
  @(Get-NetTCPConnection -LocalPort $p -State Listen -ErrorAction SilentlyContinue |
      Select-Object -ExpandProperty OwningProcess -Unique)
}

# 本项目的 Windows 看门狗进程（命令行含 deepthink-watchdog.ps1 且 -Port 参数一致）
function Get-WatchdogPids([int]$p) {
  $rxScript = 'deepthink-watchdog\.ps1'
  $rxPort   = '-Port\s+{0}\b' -f $p
  $pids = @()
  foreach ($proc in (Get-CimInstance Win32_Process -ErrorAction SilentlyContinue)) {
    if ($proc.CommandLine -and ($proc.CommandLine -match $rxScript) -and ($proc.CommandLine -match $rxPort)) {
      $pids += $proc.ProcessId
    }
  }
  return $pids
}

# ── 1. 写停止标记：通知看门狗「主动停止」，不要自动拉起 ──────────
New-Item -ItemType Directory -Force -Path $LogsDir | Out-Null
Touch-File $StopFlag

# ── 2. 停看门狗（要直接杀，不能只留标记：标记是共享文件，同一端口上若有两个
#    看门狗，先醒来的会删掉标记，另一个就把重启当「意外退出」拉起实例）──────
foreach ($wdPid in (Get-WatchdogPids $Port)) {
  Write-G ('   🛑 停止看门狗 (pid {0})' -f $wdPid)
  Stop-Process -Id $wdPid -Force -ErrorAction SilentlyContinue
}

# ── 3. 杀该端口的 LISTEN 监听进程（对应 Makefile _stop-port）────
$pids = Get-PortListeners $Port
if ($pids.Count -eq 0) {
  Write-Y ('⚠️  端口 {0} 未被占用，无需停止' -f $Port)
} else {
  Write-Y ('⏳ 端口 {0} 被 pid {1} 占用，正在停止...' -f $Port, ($pids -join ','))
  foreach ($procId in $pids) {
    Stop-Process -Id $procId -Force -ErrorAction SilentlyContinue
  }
  # 轮询验证是否真死，最多 5s
  $dead = $false
  for ($i = 0; $i -lt 5; $i++) {
    if ((Get-PortListeners $Port).Count -eq 0) { $dead = $true; break }
    Start-Sleep -Seconds 1
  }
  if (-not $dead) {
    Write-Y '⚠️  端口仍被占用，重试强制终止...'
    foreach ($procId in (Get-PortListeners $Port)) {
      Stop-Process -Id $procId -Force -ErrorAction SilentlyContinue
    }
    Start-Sleep -Seconds 1
    if ((Get-PortListeners $Port).Count -gt 0) {
      Write-E ('❌ 端口 {0} 仍被占用，请手动处理：Get-NetTCPConnection -LocalPort {0} -State Listen' -f $Port)
      exit 1
    }
  }
  Write-G ('✅ 已停止 DeepThink (端口 {0})' -f $Port)
}

# ── 4. 清 pidfile（停止标记保留：由看门狗消费，或下次启动前清理）──
Remove-Item -LiteralPath $PidFile -Force -ErrorAction SilentlyContinue

# 显式退出码：被 rebuild-restart.ps1 以 & 调用时，只有 exit 才会写 $LASTEXITCODE
exit 0
