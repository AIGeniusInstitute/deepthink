#!/data/data/com.termux/files/usr/bin/bash
# DeepThink Termux 脚本公共函数（被 install/start/stop/status.sh source）。
# 可被普通 bash source（开发机语法检查），Termux 专属能力一律 command -v 探测后降级。

# ── 基础路径与配置 ──────────────────────────────────────────
DT_HOME="${DEEPTHINK_HOME:-$HOME/deepthink}"          # 代码资产根（payload 解包位置）
DT_DATA="${DEEPTHINK_DATA_DIR:-$HOME/.deepthink/data}" # 运行时数据（DB/群组/IPC/密钥）
DT_LOG_DIR="$(dirname "$DT_DATA")/logs"
DT_LOG="$DT_LOG_DIR/backend.log"
DT_PIDFILE="$(dirname "$DT_DATA")/backend.pid"
DT_PORT="${DEEPTHINK_WEB_PORT:-${WEB_PORT:-9898}}"

# ── 输出 ────────────────────────────────────────────────────
info() { printf '▸ %s\n' "$*"; }
ok()   { printf '✅ %s\n' "$*"; }
warn() { printf '⚠️  %s\n' "$*" >&2; }
fail() { printf '❌ %s\n' "$*" >&2; exit 1; }

# ── 运行环境探测 ────────────────────────────────────────────
is_termux() { [ -n "${PREFIX:-}" ] && [ -d "/data/data/com.termux/files/usr" ]; }

require_node() {
  command -v node >/dev/null 2>&1 || fail "未找到 node。先执行：pkg install nodejs"
  local major
  major="$(node -v | sed 's/^v//' | cut -d. -f1)"
  [ "$major" -ge 22 ] 2>/dev/null || fail "Node 版本过低（$(node -v)），需要 ≥22：pkg install nodejs"
}

# ── 健康探测（与 Android 壳 app 的发现判定一致：200 + status healthy/ok）──
health_json() {
  curl -fsS --max-time 5 "http://127.0.0.1:${DT_PORT}/api/health" 2>/dev/null
}

health_ok() {
  local body
  body="$(health_json)" || return 1
  printf '%s' "$body" | grep -qE '"status"[[:space:]]*:[[:space:]]*"(healthy|ok)"'
}

# 轮询等待就绪：dt_await_health <timeout-seconds>
dt_await_health() {
  local timeout="${1:-60}" waited=0
  while [ "$waited" -lt "$timeout" ]; do
    if health_ok; then return 0; fi
    sleep 1
    waited=$((waited + 1))
  done
  return 1
}

# ── 进程 ────────────────────────────────────────────────────
dt_pid() { [ -f "$DT_PIDFILE" ] && cat "$DT_PIDFILE" 2>/dev/null; }

dt_pid_alive() {
  local pid
  pid="$(dt_pid)" || return 1
  [ -n "$pid" ] && kill -0 "$pid" 2>/dev/null
}

dt_running() { dt_pid_alive && health_ok; }
