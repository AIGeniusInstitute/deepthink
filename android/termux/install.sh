#!/data/data/com.termux/files/usr/bin/bash
# DeepThink Termux 一键安装（PRD F1）。
#
# 用法（在 Termux 中）：
#   bash install.sh                     # 从已解包的 payload 内运行（termux/ 目录位于 payload 根下）
#   bash install.sh payload.tar.gz      # 从压缩包安装
#
# 安装位置：~/deepthink（代码） + ~/.deepthink/data（数据，幂等升级永不触碰）
# 磁盘需求：≥ 3GB（npm 依赖 + claude CLI 二进制）
set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
# shellcheck source=lib.sh
. "$SCRIPT_DIR/lib.sh"

PAYLOAD_ARG="${1:-}"

# ─────────────────────────────────────────────────────────────
# 0. 环境预检
# ─────────────────────────────────────────────────────────────
info "预检：Termux / 架构 / 磁盘"

is_termux || fail "未检测到 Termux 环境（\$PREFIX 未指向 Termux）。本脚本仅支持在 Termux 内运行。"

ARCH="$(uname -m)"
[ "$ARCH" = "aarch64" ] || warn "当前架构 $ARCH，仅 aarch64（arm64）为受支持目标，其他架构不承诺可用。"

AVAIL_KB="$(df -Pk "$HOME" | awk 'NR==2 {print $4}')"
if [ -n "${AVAIL_KB:-}" ] && [ "$AVAIL_KB" -lt 3145728 ]; then
  fail "磁盘剩余空间不足 3GB（当前 $((AVAIL_KB / 1024))MB）。DeepThink 运行时约需 2GB。"
fi
ok "预检通过（$ARCH，可用空间 $((AVAIL_KB / 1024))MB）"

# ─────────────────────────────────────────────────────────────
# 1. 系统依赖
# ─────────────────────────────────────────────────────────────
info "安装系统依赖（nodejs clang make python git）"
pkg install -y nodejs clang make python git >/dev/null \
  || fail "pkg install 失败。检查网络后重试（国内可先 pkg install termux-tools && termux-change-repo 选镜像）。"

require_node
ok "Node $(node -v)"

info "安装 glibc 兼容层（glibc-repo → glibc-runner + patchelf-glibc，~50MB）"
pkg install -y glibc-repo >/dev/null || fail "glibc-repo 安装失败"
apt-get update -o Dpkg::Options::="--force-confnew" -y >/dev/null 2>&1 || true
pkg install -y glibc-runner patchelf-glibc >/dev/null || fail "glibc-runner/patchelf-glibc 安装失败"

PATCHELF="$PREFIX/glibc/bin/patchelf"
GLIBC_LD="$PREFIX/glibc/lib/ld-linux-aarch64.so.1"
[ -x "$PATCHELF" ] || fail "patchelf 未就位：$PATCHELF"
[ -f "$GLIBC_LD" ] || fail "glibc ld.so 未就位：$GLIBC_LD"
ok "glibc 兼容层就绪"

# ─────────────────────────────────────────────────────────────
# 2. 部署 payload → ~/deepthink（幂等：代码覆盖，数据不动）
# ─────────────────────────────────────────────────────────────
info "部署运行时资产 → $DT_HOME"

if [ -n "$PAYLOAD_ARG" ]; then
  [ -f "$PAYLOAD_ARG" ] || fail "payload 文件不存在：$PAYLOAD_ARG"
  mkdir -p "$DT_HOME"
  tar -xzf "$PAYLOAD_ARG" -C "$DT_HOME" --strip-components=1
  ok "payload 已解包"
elif [ -d "$SCRIPT_DIR/../backend" ]; then
  PAYLOAD_ROOT="$(cd "$SCRIPT_DIR/.." && pwd)"
  if [ "$PAYLOAD_ROOT" = "$DT_HOME" ]; then
    ok "已在目标位置，跳过复制"
  else
    mkdir -p "$DT_HOME"
    cp -R "$PAYLOAD_ROOT/." "$DT_HOME/"
    ok "payload 已复制（$PAYLOAD_ROOT → $DT_HOME）"
  fi
else
  fail "找不到 payload。用法：bash install.sh <payload.tar.gz>，或在已解包的 payload 内运行 termux/install.sh"
fi

[ -f "$DT_HOME/backend/index.js" ] || fail "部署不完整：$DT_HOME/backend/index.js 缺失"
[ -f "$DT_HOME/PAYLOAD-MANIFEST.txt" ] && ok "payload 清单：$(grep -m1 '# version:' "$DT_HOME/PAYLOAD-MANIFEST.txt" || true)"

# ─────────────────────────────────────────────────────────────
# 3. npm 依赖（含 better-sqlite3 设备端编译）
# ─────────────────────────────────────────────────────────────
info "安装后端 npm 依赖（首次约 5-15 分钟，视网络而定）"
cd "$DT_HOME"
if ! npm install --omit=dev --no-audit --no-fund; then
  warn "npm install 失败，尝试兜底：--ignore-scripts + 定向编译 better-sqlite3"
  npm install --omit=dev --ignore-scripts --no-audit --no-fund \
    || fail "npm install 兜底仍失败。检查网络/镜像（npm config set registry https://registry.npmmirror.com）后重试。"
fi

info "安装 agent-runner npm 依赖（无 lockfile，拉取最新 Claude Agent SDK）"
cd "$DT_HOME/agent-runner"
npm install --no-audit --no-fund \
  || { warn "agent-runner npm install 失败，尝试 --ignore-scripts 兜底"; \
       npm install --ignore-scripts --no-audit --no-fund \
       || fail "agent-runner 依赖安装失败。"; }

# ─────────────────────────────────────────────────────────────
# 4. 原生模块自检：better-sqlite3
# ─────────────────────────────────────────────────────────────
info "自检：better-sqlite3 原生模块"
cd "$DT_HOME"
if ! node -e "const D=require('better-sqlite3'); const d=new D(':memory:'); d.exec('create table t(x)'); d.close();" 2>/dev/null; then
  warn "better-sqlite3 加载失败，尝试设备端重编译"
  npm rebuild better-sqlite3 || fail "better-sqlite3 编译失败。确认 clang/make/python 已安装后重试：npm rebuild better-sqlite3"
  node -e "const D=require('better-sqlite3'); new D(':memory:').close();" \
    || fail "better-sqlite3 仍不可用。请附 ~/deepthink 下 npm rebuild better-sqlite3 的输出反馈。"
fi
ok "better-sqlite3 可用（设备端编译产物）"

# ─────────────────────────────────────────────────────────────
# 5. claude CLI glibc 兼容（配方来源：claude-code-android，patchelf 重写 interpreter）
# ─────────────────────────────────────────────────────────────
info "处理 claude CLI glibc 兼容（patchelf）"

CLAUDE_BINS="$(find "$DT_HOME/node_modules" "$DT_HOME/agent-runner/node_modules" \
  -path '*@anthropic-ai*' -type f \( -name claude -o -name 'claude.exe' \) 2>/dev/null || true)"

[ -n "$CLAUDE_BINS" ] || warn "未发现 claude CLI 二进制（@anthropic-ai/claude-code 平台包）。SDK 将在首次运行时自行解析，若报 executable not found，重跑本脚本或 npm rebuild @anthropic-ai/claude-code。"

CLAUDE_OK=0
for bin in $CLAUDE_BINS; do
  # 占位 stub 判定（postinstall 被拦截残留的 ~500B 文本）：跳过并提示
  size="$(wc -c < "$bin" 2>/dev/null || echo 0)"
  if [ "$size" -lt 10240 ] && ! head -c4 "$bin" 2>/dev/null | grep -q $'\x7fELF'; then
    warn "跳过占位 stub（postinstall 未执行）：$bin"
    warn "  修复：cd $(dirname "$bin")/../.. && npm rebuild @anthropic-ai/claude-code"
    continue
  fi
  # 非 ELF（shebang 脚本等）无需 patchelf
  if ! head -c4 "$bin" 2>/dev/null | grep -q $'\x7fELF'; then
    info "跳过非 ELF：$bin"
    continue
  fi
  if LD_PRELOAD='' "$PATCHELF" --set-interpreter "$GLIBC_LD" "$bin" 2>/dev/null; then
    chmod +x "$bin"
    # LD_PRELOAD 必须清空：Termux 的 libtermux-exec 预载会让 glibc 二进制误解析 libc
    if ver="$(LD_PRELOAD='' timeout 30 "$bin" --version 2>/dev/null | head -1)"; then
      ok "claude CLI 可执行：$ver（$bin）"
      CLAUDE_OK=1
    else
      warn "patchelf 后仍无法执行：$bin（详见 README 故障排查：Bad system call / 机型不兼容）"
    fi
  else
    warn "patchelf 失败：$bin"
  fi
done

# ~/.claude/settings.json：关闭 claude 自动更新（由 npm update 走平台流程），清 LD_PRELOAD 残留
mkdir -p "$HOME/.claude"
node -e '
const fs = require("fs");
const p = process.env.HOME + "/.claude/settings.json";
let s = {};
try { s = JSON.parse(fs.readFileSync(p, "utf8")); } catch {}
s.autoUpdates = false;
if (s.env) { delete s.env.LD_PRELOAD; if (!Object.keys(s.env).length) delete s.env; }
fs.writeFileSync(p, JSON.stringify(s, null, 2));
' && ok "~/.claude/settings.json 已配置（autoUpdates:false）"

# ─────────────────────────────────────────────────────────────
# 6. 启动环境与脚本
# ─────────────────────────────────────────────────────────────
mkdir -p "$DT_LOG_DIR" "$DT_DATA"
cat > "$DT_HOME/.env.sh" <<EOF
# DeepThink Termux 运行环境（start.sh 自动加载）
export DEEPTHINK_HOME="$DT_HOME"
export DEEPTHINK_DATA_DIR="$DT_DATA"
export DEEPTHINK_WEB_DIST_DIR="$DT_HOME/web-dist"
export DEEPTHINK_AGENT_RUNNER_DIR="$DT_HOME/agent-runner"
export NODE_ENV=production
export WEB_PORT="$DT_PORT"
EOF
chmod +x "$DT_HOME"/termux/*.sh
ok "运行环境已写入 $DT_HOME/.env.sh（端口 $DT_PORT，可改 WEB_PORT 后重新生成或在 start 前覆盖）"

# ─────────────────────────────────────────────────────────────
# 7. 安装自检汇总
# ─────────────────────────────────────────────────────────────
echo
info "安装自检汇总"
printf '  %-28s %s\n' "Node $(node -v)" "✅"
node -e "require('better-sqlite3')" 2>/dev/null \
  && printf '  %-28s %s\n' "better-sqlite3" "✅" \
  || printf '  %-28s %s\n' "better-sqlite3" "❌（npm rebuild better-sqlite3）"
[ "$CLAUDE_OK" = "1" ] \
  && printf '  %-28s %s\n' "claude CLI (glibc)" "✅" \
  || printf '  %-28s %s\n' "claude CLI (glibc)" "⚠️ （见上方警告 / README 故障排查）"
[ -f "$DT_HOME/backend/index.js" ] \
  && printf '  %-28s %s\n' "backend 产物" "✅" \
  || printf '  %-28s %s\n' "backend 产物" "❌"
echo
ok "安装完成。启动：bash $DT_HOME/termux/start.sh"
info "首次使用请阅读 $DT_HOME/termux/README.md（如随包提供）或项目文档 android/README.md"
