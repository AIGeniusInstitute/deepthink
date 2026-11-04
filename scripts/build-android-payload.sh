#!/usr/bin/env bash
# 打包 Android/Termux 运行时 payload（docs/tech_solution/android-on-device/TECH_SOLUTION.md §4）。
#
# 产物：dist-android/deepthink-android-payload-<version>.tar.gz + .sha256
# 布局：解包后即设备端 ~/deepthink/ 终态（backend/ web-dist/ agent-runner/ config/ termux/ ...）。
# 刻意不含 node_modules（~1.5GB）——设备端由 install.sh 执行 npm install，减小分发体积。
#
# 用法：make android-payload   （或 bash scripts/build-android-payload.sh）
set -euo pipefail

ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
# 用 sed 解析版本（Git Bash 的 pwd 是 /c/... POSIX 路径，node require 不认）
VERSION="$(sed -n 's/^[[:space:]]*"version": *"\([^"]*\)".*/\1/p' "$ROOT/package.json" | head -1)"
if [ -z "$VERSION" ]; then echo "❌ 无法解析 package.json 的 version 字段" >&2; exit 1; fi
BUILD_TIME="$(date -u +%Y-%m-%dT%H:%M:%SZ)"
OUT_DIR="$ROOT/dist-android"
STAGE="$OUT_DIR/staging"
TOP="$STAGE/deepthink"
TARBALL="$OUT_DIR/deepthink-android-payload-$VERSION.tar.gz"

info() { printf '▸ %s\n' "$*"; }
fail() { printf '❌ %s\n' "$*" >&2; exit 1; }

# ── 1. 预检：构建产物齐全才打包，缺一即止（不产残包，TC-F3-03） ──
REQUIRED=(
  "dist/index.js"
  "dist/pty-worker.cjs"
  "dist/eval-center/eval-schema.sql"
  "web/dist/index.html"
  "container/agent-runner/dist/index.js"
  "container/agent-runner/package.json"
  "container/agent-runner/prompts"
  "config/default-groups.json"
  "config/mount-allowlist.json"
  "config/global-claude-md.template.md"
  "container/skills"
  "android/termux/install.sh"
  "android/termux/start.sh"
  "android/termux/stop.sh"
  "android/termux/status.sh"
  "android/termux/lib.sh"
)
MISSING=0
for rel in "${REQUIRED[@]}"; do
  [ -e "$ROOT/$rel" ] || { printf '❌ 缺失：%s\n' "$rel" >&2; MISSING=1; }
done
[ "$MISSING" -eq 0 ] || fail "构建产物不完整。先执行：make build（后端/前端/agent-runner）；pty-worker.cjs 由 npm run build 的 copy-runtime-assets 步骤产出。"

info "预检通过（${#REQUIRED[@]} 项）"

# ── 2. staging：复制为设备端终态布局 ──
rm -rf "$STAGE"
mkdir -p "$TOP"/{backend,web-dist,agent-runner,config,container,termux}

cp -R "$ROOT/dist/." "$TOP/backend/"
cp -R "$ROOT/web/dist/." "$TOP/web-dist/"
cp -R "$ROOT/container/agent-runner/dist" "$TOP/agent-runner/dist"
cp -R "$ROOT/container/agent-runner/prompts" "$TOP/agent-runner/prompts"
cp "$ROOT/container/agent-runner/package.json" "$TOP/agent-runner/package.json"
cp "$ROOT/package.json" "$TOP/package.json"
cp -R "$ROOT/config/." "$TOP/config/"
cp -R "$ROOT/container/skills" "$TOP/container/skills"
cp "$ROOT"/android/termux/*.sh "$TOP/termux/"
chmod +x "$TOP"/termux/*.sh

# ── 3. 清理禁入物（防呆：staging 里绝不留 node_modules / 源码 TS / 测试）──
find "$TOP" \( -name node_modules -o -name .git -o -name '*.ts' -o -name '*.map' \) -prune -exec rm -rf {} + 2>/dev/null || true

# ── 4. 清单 ──
{
  echo "# DeepThink Android payload manifest"
  echo "# version: $VERSION"
  echo "# built:   $BUILD_TIME"
  echo "# note:    node_modules 不随包分发，由设备端 install.sh 执行 npm install"
  (cd "$TOP" && find . -type f | sed 's|^\./||' | sort)
} > "$TOP/PAYLOAD-MANIFEST.txt"

# ── 5. 打包 + 校验和（TC-F3-04） ──
mkdir -p "$OUT_DIR"
tar -czf "$TARBALL" -C "$STAGE" deepthink
if command -v sha256sum >/dev/null 2>&1; then
  (cd "$OUT_DIR" && sha256sum "$(basename "$TARBALL")" > "$(basename "$TARBALL").sha256")
else
  (cd "$OUT_DIR" && shasum -a 256 "$(basename "$TARBALL")" > "$(basename "$TARBALL").sha256")
fi

SIZE="$(du -h "$TARBALL" | cut -f1)"
info "产出 $TARBALL（$SIZE）"

# ── 6. 自校验（TC-F3-02） ──
bash "$ROOT/scripts/check-android-payload.sh" "$TARBALL"

# 清理 staging（保留 tarball）
rm -rf "$STAGE"
info "完成 ✅  校验和：$TARBALL.sha256"
