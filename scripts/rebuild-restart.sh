#!/usr/bin/env bash
# ──────────────────────────────────────────────────────────────
# DeepThink — 一键重新编译 / 构建 / 打包 / 部署本机实例
#
# 本质是 `make start-prod PORT=<端口>` 的便捷入口 + 启动后健康校验。
# 该端口上的实例形态（与 make start-prod 完全一致）：
#   数据目录  ~/.deepthink-<PORT>          （独立 DB / 配置，与其它端口互不影响）
#   日志      logs/deepthink-<PORT>.log
#   托管      scripts/deepthink-watchdog.sh 后台守护，node 意外退出自动拉起
#   停止      make stop-prod PORT=<PORT>
#
# 流程：停旧实例 → 增量编译（后端/前端/agent-runner）→ 构建本机 Docker 镜像
#       （deepthink-agent / deepthink-sandbox，供 Agent 容器使用）→ 后台守护启动 → 健康校验
#
# 用法：
#   ./scripts/rebuild-restart.sh                 # 默认端口 9999
#   ./scripts/rebuild-restart.sh 8080            # 指定端口
#   ./scripts/rebuild-restart.sh 9999 --full     # 全量强制重建（跳过增量检测，含 Docker 镜像）
#   ./scripts/rebuild-restart.sh --help
# ──────────────────────────────────────────────────────────────
set -euo pipefail

ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
cd "$ROOT"

PORT=""
FULL=0

g() { printf '\033[32m%s\033[0m\n' "$*"; }
b() { printf '\033[36m%s\033[0m\n' "$*"; }
y() { printf '\033[33m%s\033[0m\n' "$*"; }
e() { printf '\033[31m%s\033[0m\n' "$*" >&2; }
die() { e "❌ $*"; exit 1; }

usage() {
  cat <<'EOF'
DeepThink 一键重新编译 / 构建 / 打包 / 部署本机实例

用法:
  ./scripts/rebuild-restart.sh [PORT] [--full]

参数:
  PORT       服务端口（默认 9999）；数据目录 = ~/.deepthink-<PORT>
  --full     全量强制重建：强制重编后端/前端/agent-runner + 强制重建
             deepthink-agent / deepthink-sandbox 镜像（耗时可达 10 分钟以上）。
             不加则走增量检测，只重编改动的部分。
  -h, --help 显示本帮助

流程:
  停旧实例 → 增量编译 → 构建本机 Docker 镜像 → 后台守护启动 → 健康校验

停止/查看:
  make stop-prod PORT=<PORT>      # 停止该端口实例
  tail -f logs/deepthink-<PORT>.log
EOF
  exit 0
}

while [ "$#" -gt 0 ]; do
  case "$1" in
    --full)     FULL=1; shift ;;
    -h|--help)  usage ;;
    -*)         die "未知参数: $1（可用: --full）" ;;
    *)
      case "$1" in
        ''|*[!0-9]*) die "端口必须是数字: $1" ;;
      esac
      PORT="$1"; shift
      ;;
  esac
done
PORT="${PORT:-9999}"

# ── 前置检查 ─────────────────────────────────────────────────
[ -f "$ROOT/Makefile" ] || die "找不到 Makefile，脚本必须位于项目仓库内"
command -v make >/dev/null 2>&1 || die "未安装 make"
g "✅ 项目根目录: $ROOT"

DATA_DIR="$HOME/.deepthink-$PORT"
LOG_FILE="$ROOT/logs/deepthink-$PORT.log"

# 失败时把实例日志尾部作为排查证据打出来（不主观猜原因）
fail_tail() {
  if [ -f "$LOG_FILE" ]; then
    e "──── $LOG_FILE (最后 30 行) ────"
    tail -30 "$LOG_FILE" >&2 || true
    e "────────────────────────────────"
  fi
  exit 1
}

# ── 端口占用预检（放在耗时构建之前，避免白跑十分钟才失败）────
# make start-prod 在端口被占用时会调 stop-prod，直接杀掉该端口的监听进程。
# 若占用者是无关程序（别的应用恰好用了同一端口），那会误杀。这里先拦下来：
# 只有当占用者是「本项目根目录下的 node dist/index.js」时才放行。
if lsof -ti:"$PORT" -sTCP:LISTEN >/dev/null 2>&1; then
  HOLDER_PID="$(lsof -ti:"$PORT" -sTCP:LISTEN 2>/dev/null | head -1)"
  HOLDER_CMD="$(ps -p "$HOLDER_PID" -o command= 2>/dev/null || true)"
  HOLDER_CWD="$(lsof -a -p "$HOLDER_PID" -d cwd -Fn 2>/dev/null | grep '^n' | cut -c2- || true)"
  if [ "$HOLDER_CWD" = "$ROOT" ] && [ "${HOLDER_CMD#*dist/index.js}" != "$HOLDER_CMD" ]; then
    y "   端口 ${PORT} 已被本项目的旧实例占用（pid ${HOLDER_PID}），将自动停掉后重启"
  else
    e "❌ 端口 ${PORT} 被无关程序占用，已中止（避免误杀）："
    e "   pid ${HOLDER_PID}: $(printf '%.120s' "$HOLDER_CMD")"
    e "   工作目录: ${HOLDER_CWD:-未知}"
    e "   make start-prod 会停掉占用该端口的监听进程，可能误杀无关程序。"
    e "   请改用其它端口，或先自行处理该进程后重试。"
    exit 1
  fi
fi

# ── 可选：全量强制重建 ───────────────────────────────────────
if [ "$FULL" = "1" ]; then
  y "▶ 全量强制重建已启用（跳过增量检测，耗时较长）"
  b "   [1/3] 编译后端 / 前端 / agent-runner ..."
  make --no-print-directory build || die "全量编译失败"
  b "   [2/3] 重建 agent 镜像 deepthink-agent:latest ..."
  ./container/build.sh || die "agent 镜像构建失败"
  b "   [3/3] 重建沙箱镜像 deepthink-sandbox:latest ..."
  make --no-print-directory sandbox-build || die "沙箱镜像构建失败"
  g "   全量重建完成"
fi

# ── 停旧实例 → 编译 → 构建镜像 → 启动 ───────────────────────
b "▶ 停止旧实例 → 编译 → 构建镜像 → 后台守护启动（make start-prod PORT=${PORT}）..."
make --no-print-directory start-prod PORT="$PORT" || {
  e "❌ make start-prod 执行失败"
  fail_tail
}

# ── 健康校验 ─────────────────────────────────────────────────
# 注意：不能只看 HTTP 状态码。端口上若跑着别的程序，/health 可能被对方的 SPA
# 兜底路由以 200 + HTML 返回，curl -sf 会误判成功。因此先确认监听该端口的确实
# 是本次启动的 node（比对 pidfile），再校验响应体是 DeepThink 的 JSON。
HEALTH_URL="http://127.0.0.1:${PORT}/health"
READY_URL="http://127.0.0.1:${PORT}/ready"
PIDFILE="$ROOT/logs/deepthink-${PORT}.pid"

b "▶ 校验端口 ${PORT} 由本次启动的实例监听..."
LISTEN_PID="$(lsof -ti:"$PORT" -sTCP:LISTEN 2>/dev/null | head -1 || true)"
NODE_PID="$(cat "$PIDFILE" 2>/dev/null || true)"
[ -n "$LISTEN_PID" ] || { e "❌ 端口 ${PORT} 无监听进程，实例未起来"; fail_tail; }
if [ -z "$NODE_PID" ] || [ "$LISTEN_PID" != "$NODE_PID" ]; then
  e "❌ 端口 ${PORT} 被其它进程占用（pid ${LISTEN_PID}），本次启动的实例并未接管该端口"
  ps -p "$LISTEN_PID" -o pid,command 2>/dev/null | tail -1 >&2 || true
  e "   该端口的实例日志：$LOG_FILE"
  exit 1
fi
g "   端口由本次实例监听（node pid ${NODE_PID}）"

b "▶ 等待进程存活 /health（最长 30s）..."
UP=0
for i in $(seq 1 15); do
  case "$(curl -s --max-time 3 "$HEALTH_URL" 2>/dev/null || true)" in
    *'"status":"ok"'*) g "   /health OK（${i}*2s）"; UP=1; break ;;
  esac
  sleep 2
done
if [ "$UP" = "0" ]; then
  e "❌ /health 未返回预期的 {\"status\":\"ok\"}"
  e "   最后响应: $(curl -s --max-time 3 "$HEALTH_URL" 2>/dev/null | head -c 200 || echo '(无响应)')"
  fail_tail
fi

b "▶ 等待依赖就绪 /ready（最长 60s）..."
READY=0
for i in $(seq 1 30); do
  case "$(curl -s --max-time 3 "$READY_URL" 2>/dev/null || true)" in
    *'"status":"ready"'*) g "   /ready OK（${i}*2s）"; READY=1; break ;;
  esac
  sleep 2
done
if [ "$READY" = "0" ]; then
  e "❌ /ready 未返回预期的 {\"status\":\"ready\"}（依赖未就绪）"
  e "   最后响应: $(curl -s --max-time 3 "$READY_URL" 2>/dev/null | head -c 200 || echo '(无响应)')"
  fail_tail
fi

# ── 输出 ─────────────────────────────────────────────────────
echo ""
g "═══════════════════════════════════════════════"
g " ✅ DeepThink 已重新编译、构建并部署"
b "   Web UI  ：http://localhost:${PORT}"
b "   数据目录：${DATA_DIR}"
b "   日志    ：tail -f ${LOG_FILE}"
b "   停止    ：make stop-prod PORT=${PORT}"
g "═══════════════════════════════════════════════"
