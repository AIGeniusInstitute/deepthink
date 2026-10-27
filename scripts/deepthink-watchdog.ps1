# ──────────────────────────────────────────────────────────────
# DeepThink 单实例看门狗（Windows 版 deepthink-watchdog.sh）：
# node 意外退出时自动重启；检测到停止标记时正常退出不重启。
#
# 用法（由 scripts\rebuild-restart.ps1 调起，勿手动直跑）:
#   deepthink-watchdog.ps1 -Port <PORT> -DataDir <DATA_DIR> -LogFile <LOG_FILE> -StopFlag <STOP_FLAG> -PidFile <PIDFILE>
#
#   -Port      服务端口（node 的 WEB_PORT）
#   -DataDir   数据目录（node 的 DEEPTHINK_DATA_DIR）
#   -LogFile   node 的 stdout/stderr 与看门狗日志共用文件
#   -StopFlag  stop-prod.ps1 写下的停止标记文件；存在则退出不重启
#   -PidFile   记录当前 node 子进程 pid（供诊断 / 启动校验）
#
# 环境变量（可覆盖）:
#   RESTART_DELAY  意外退出后重启前的等待秒数，默认 3（避免崩溃循环刷屏）
#   FLAG_POLL      运行中轮询停止标记的间隔秒数，默认 2（决定"停止请求"的最大感知延迟）
#
# Windows 实现要点：
#   - node 经 cmd /c 包一层启动：`node dist/index.js >> 日志 2>&1`，让 stdout/stderr
#     合并追加到同一日志（Start-Process 不允许两个流重定向到同一文件）；cmd /c 同步
#     等待 node，wrapper 退出即 node 退出。pidfile 里记的是 node 子进程的 pid（通过
#     ParentProcessId 找到），不是 cmd 的。
#   - Windows 无 SIGTERM，停子进程用 Stop-Process（强杀，SQLite WAL 可安全恢复）。
#   - 看门狗被强杀时 node 可能变孤儿：stop-prod.ps1 会按端口补杀监听进程。
# ──────────────────────────────────────────────────────────────

[CmdletBinding()]
param(
  [Parameter(Position = 0)][int]$Port,
  [Parameter(Position = 1)][string]$DataDir,
  [Parameter(Position = 2)][string]$LogFile,
  [Parameter(Position = 3)][string]$StopFlag,
  [Parameter(Position = 4)][string]$PidFile
)

$ErrorActionPreference = 'Stop'

$Root         = Split-Path -Parent $PSScriptRoot
$RestartDelay = if ($env:RESTART_DELAY) { [int]$env:RESTART_DELAY } else { 3 }
$FlagPoll     = if ($env:FLAG_POLL) { [int]$env:FLAG_POLL } else { 2 }

function Log([string]$msg) {
  $line = '[watchdog] {0} {1}' -f (Get-Date -Format 'yyyy-MM-dd HH:mm:ss'), $msg
  [System.IO.File]::AppendAllText($LogFile, $line + [Environment]::NewLine, (New-Object System.Text.UTF8Encoding($false)))
}

function Remove-State {
  Remove-Item -LiteralPath $StopFlag, $PidFile -Force -ErrorAction SilentlyContinue
}

# node 的环境变量（等价 Makefile start-prod 的 export；DEEPTHINK_WEB_DIST_DIR 显式钉在
# 本仓库的 web/dist，防止继承桌面版内嵌终端的旧值导致页面停在旧前端）
$env:WEB_PORT = '{0}' -f $Port
$env:DEEPTHINK_DATA_DIR = $DataDir
$env:DEEPTHINK_WEB_DIST_DIR = Join-Path $Root 'web\dist'

function Start-NodeChild {
  $quotedLog = '"' + $LogFile + '"'
  $argLine = '/c node dist/index.js >> {0} 2>&1' -f $quotedLog
  $wrapper = Start-Process -FilePath 'cmd.exe' -ArgumentList $argLine -WorkingDirectory $Root -WindowStyle Hidden -PassThru
  # 找真正的 node 子进程 pid（pidfile / 端口校验要用 node 的 pid，不是 cmd 的）
  $nodePid = $null
  for ($i = 0; $i -lt 30 -and $null -eq $nodePid; $i++) {
    Start-Sleep -Milliseconds 100
    $child = Get-CimInstance Win32_Process -Filter ('ParentProcessId={0}' -f $wrapper.Id) -ErrorAction SilentlyContinue |
             Where-Object { $_.Name -eq 'node.exe' } | Select-Object -First 1
    if ($child) { $nodePid = [int]$child.ProcessId }
    if ($wrapper.HasExited) { break }
  }
  if ($null -eq $nodePid) { $nodePid = [int]$wrapper.Id }   # 兜底：找不到就记 wrapper pid
  return @($wrapper, $nodePid)
}

function Stop-NodeChild($wrapper, [int]$nodePid) {
  Stop-Process -Id $nodePid -Force -ErrorAction SilentlyContinue
  # cmd wrapper 等 node 退出后自行结束；最多等 5s 再强杀 wrapper
  for ($i = 0; $i -lt 5; $i++) {
    if ($wrapper.HasExited) { return }
    Start-Sleep -Seconds 1
  }
  Stop-Process -Id $wrapper.Id -Force -ErrorAction SilentlyContinue
}

while ($true) {
  # 循环顶部先查停止标记（覆盖"重启间隙收到停止请求"的场景）
  if (Test-Path -LiteralPath $StopFlag) {
    Log '检测到停止标记，退出不重启'
    Remove-State
    exit 0
  }

  $child   = Start-NodeChild
  $wrapper = $child[0]
  $nodePid = [int]$child[1]
  Set-Content -LiteralPath $PidFile -Value $nodePid -Encoding ASCII
  Log ('启动 node (pid={0}, port={1})' -f $nodePid, $Port)

  # 运行中轮询：node 存活就每 FLAG_POLL 秒查一次停止标记；node 退出则跳出
  while (-not $wrapper.HasExited) {
    if (Test-Path -LiteralPath $StopFlag) {
      Log ('检测到停止标记，停止 node (pid={0})' -f $nodePid)
      Stop-NodeChild $wrapper $nodePid
      Remove-State
      exit 0
    }
    Start-Sleep -Seconds $FlagPoll
  }

  # node 已退出：再次确认是否有停止标记（stop-prod 已杀 node 但标记稍后写入的兜底）
  if (Test-Path -LiteralPath $StopFlag) {
    Log 'node 已退出，检测到停止标记，正常退出不重启'
    Remove-State
    exit 0
  }

  Log ('node 意外退出，{0}s 后自动重启' -f $RestartDelay)
  Start-Sleep -Seconds $RestartDelay
}
