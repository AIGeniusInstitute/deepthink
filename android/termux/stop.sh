#!/data/data/com.termux/files/usr/bin/bash
# DeepThink Termux 停止（PRD F2）：SIGTERM → 10s → SIGKILL，释放 wake-lock。
set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
# shellcheck source=lib.sh
. "$SCRIPT_DIR/lib.sh"
[ -f "$DT_HOME/.env.sh" ] && . "$DT_HOME/.env.sh"
DT_PIDFILE="$(dirname "$DT_DATA")/backend.pid"

if ! dt_pid_alive; then
  info "DeepThink 未在运行"
  rm -f "$DT_PIDFILE"
else
  PID="$(dt_pid)"
  info "停止 DeepThink（pid $PID）：SIGTERM"
  kill "$PID" 2>/dev/null || true
  for _ in 1 2 3 4 5 6 7 8 9 10; do
    kill -0 "$PID" 2>/dev/null || break
    sleep 1
  done
  if kill -0 "$PID" 2>/dev/null; then
    warn "10s 内未退出，SIGKILL"
    kill -9 "$PID" 2>/dev/null || true
  fi
  rm -f "$DT_PIDFILE"
  ok "已停止"
fi

if command -v termux-wake-unlock >/dev/null 2>&1; then
  termux-wake-unlock && ok "wake-lock 已释放"
fi
