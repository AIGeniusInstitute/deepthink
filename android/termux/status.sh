#!/data/data/com.termux/files/usr/bin/bash
# DeepThink Termux 状态（PRD F2）：进程 / 端口 / health / 日志尾部。
set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
# shellcheck source=lib.sh
. "$SCRIPT_DIR/lib.sh"
[ -f "$DT_HOME/.env.sh" ] && . "$DT_HOME/.env.sh"
DT_LOG="$DT_LOG_DIR/backend.log"
DT_PIDFILE="$(dirname "$DT_DATA")/backend.pid"
DT_PORT="${DEEPTHINK_WEB_PORT:-${WEB_PORT:-$DT_PORT}}"

echo "── DeepThink 状态 ──────────────────────────"
printf '  %-12s %s\n' "安装目录" "$DT_HOME"
printf '  %-12s %s\n' "数据目录" "$DT_DATA"
printf '  %-12s %s\n' "端口" "$DT_PORT"

if dt_pid_alive; then
  printf '  %-12s %s\n' "进程" "✅ 运行中（pid $(dt_pid)）"
else
  printf '  %-12s %s\n' "进程" "❌ 未运行"
fi

if HJSON="$(health_json)"; then
  printf '  %-12s %s\n' "健康检查" "✅ $HJSON"
else
  printf '  %-12s %s\n' "健康检查" "❌ 不可达（http://127.0.0.1:$DT_PORT/api/health）"
fi

echo "── 日志尾部（$DT_LOG） ──"
tail -n 20 "$DT_LOG" 2>/dev/null || echo "  （暂无日志）"
