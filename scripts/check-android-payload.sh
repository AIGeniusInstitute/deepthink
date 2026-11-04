#!/usr/bin/env bash
# 校验 android payload 压缩包内容（TC-F3-02）：
#   必含项全在（运行时五件套 + termux 脚本 + 清单），禁含项全无（node_modules / .git / data / *.ts）。
# 用法：bash scripts/check-android-payload.sh <payload.tar.gz>
set -euo pipefail

TARBALL="${1:?用法：check-android-payload.sh <payload.tar.gz>}"
[ -f "$TARBALL" ] || { echo "❌ 文件不存在：$TARBALL" >&2; exit 1; }

LIST="$(tar -tzf "$TARBALL")"
fail=0

REQUIRED_PATTERNS=(
  'deepthink/backend/index.js'
  'deepthink/backend/pty-worker.cjs'
  'deepthink/backend/eval-center/eval-schema.sql'
  'deepthink/web-dist/index.html'
  'deepthink/agent-runner/dist/index.js'
  'deepthink/agent-runner/package.json'
  'deepthink/agent-runner/prompts/'
  'deepthink/package.json'
  'deepthink/config/default-groups.json'
  'deepthink/config/mount-allowlist.json'
  'deepthink/termux/install.sh'
  'deepthink/termux/start.sh'
  'deepthink/termux/stop.sh'
  'deepthink/termux/status.sh'
  'deepthink/termux/lib.sh'
  'deepthink/PAYLOAD-MANIFEST.txt'
)
for pat in "${REQUIRED_PATTERNS[@]}"; do
  if ! grep -qF "$pat" <<<"$LIST"; then
    echo "❌ 缺少必含项：$pat" >&2
    fail=1
  fi
done

FORBIDDEN_PATTERNS=(
  'node_modules/'
  '/.git/'
  'deepthink/data/'
  '\.ts$'
  '\.map$'
)
for pat in "${FORBIDDEN_PATTERNS[@]}"; do
  if grep -qE "$pat" <<<"$LIST"; then
    echo "❌ 含禁入项（匹配 $pat）：" >&2
    grep -E "$pat" <<<"$LIST" | head -5 >&2
    fail=1
  fi
done

if [ "$fail" -ne 0 ]; then
  echo "❌ payload 校验未通过：$TARBALL" >&2
  exit 1
fi
echo "✅ payload 校验通过：$(basename "$TARBALL")（$(grep -c . <<<"$LIST") 个条目）"
