#!/data/data/com.termux/files/usr/bin/bash
# DeepThink Termux 启动（PRD F2）：后台启动后端 + wake-lock + 健康检查。
# 用法：bash start.sh        （端口默认 9898，可用 WEB_PORT=9900 覆盖）
set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
# shellcheck source=lib.sh
. "$SCRIPT_DIR/lib.sh"
[ -f "$DT_HOME/.env.sh" ] && . "$DT_HOME/.env.sh"
# .env.sh 可能覆盖 DT_* / WEB_PORT，重新对齐 lib 的派生路径
DT_LOG="$DT_LOG_DIR/backend.log"
DT_PIDFILE="$(dirname "$DT_DATA")/backend.pid"
DT_PORT="${DEEPTHINK_WEB_PORT:-${WEB_PORT:-$DT_PORT}}"

require_node
[ -f "$DT_HOME/backend/index.js" ] || fail "未找到 $DT_HOME/backend/index.js。先运行 termux/install.sh。"

if dt_running; then
  ok "DeepThink 已在运行：http://127.0.0.1:$DT_PORT（pid $(dt_pid)）"
  exit 0
fi

# 清理陈旧 pidfile
dt_pid_alive || rm -f "$DT_PIDFILE"

# wake-lock 防休眠（termux-tools 提供；缺失告警不失败）
if command -v termux-wake-lock >/dev/null 2>&1; then
  termux-wake-lock && ok "已持有 wake-lock"
else
  warn "termux-wake-lock 不可用（pkg install termux-api），长任务可能被休眠中断"
fi

mkdir -p "$DT_LOG_DIR" "$DT_DATA"
info "启动后端（端口 $DT_PORT，日志 $DT_LOG）"
cd "$DT_HOME"
# 环境注入与 desktop/src/backend-supervisor.ts 的 buildEnv 对齐（tech_solution §2）
export DEEPTHINK_HOME="${DEEPTHINK_HOME:-$DT_HOME}"
export DEEPTHINK_DATA_DIR="${DEEPTHINK_DATA_DIR:-$DT_DATA}"
export DEEPTHINK_WEB_DIST_DIR="${DEEPTHINK_WEB_DIST_DIR:-$DT_HOME/web-dist}"
export DEEPTHINK_AGENT_RUNNER_DIR="${DEEPTHINK_AGENT_RUNNER_DIR:-$DT_HOME/agent-runner}"
export NODE_ENV=production
export WEB_PORT="$DT_PORT"

nohup node "$DT_HOME/backend/index.js" >> "$DT_LOG" 2>&1 &
echo $! > "$DT_PIDFILE"
info "pid $(dt_pid)"

if dt_await_health 60; then
  ok "DeepThink 就绪 → http://127.0.0.1:$DT_PORT"
  info "Android 壳 app 会自动发现本机服务；浏览器亦可直接访问。"
else
  warn "60s 内健康检查未通过。日志尾部："
  tail -n 20 "$DT_LOG" >&2 || true
  fail "启动失败。常见原因见 android/README.md 故障排查（端口占用 / 首次迁移 / 原生模块）。"
fi
