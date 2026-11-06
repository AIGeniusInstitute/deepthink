#!/usr/bin/env bash
# S1 spike 探索：判定 exec-from-data-dir 失败的根因（瞬态 ETXTBSY vs W^X 策略）。
# 用法：bash device-explore.sh <adb 路径> [serial]
set -euo pipefail

ADB="$1"
SERIAL="${2:-emulator-5554}"
PKG="com.aigeniusinstitute.deepthink.spike"
DEV="/data/data/$PKG/files/spike"

a() { MSYS_NO_PATHCONV=1 "$ADB" -s "$SERIAL" "$@"; }

# 1. 文件完整性（排除写入未完成；必须走 exec-in 通道，adb shell 会剥引号）
echo "=== md5 / size ==="
a exec-in "run-as $PKG sh -c 'md5sum $DEV/nodebin/node > $DEV/sum.log 2>&1; wc -c < $DEV/nodebin/node >> $DEV/sum.log 2>&1; ls -la $DEV/nodebin >> $DEV/sum.log 2>&1'"
a shell run-as $PKG cat files/spike/sum.log

# 2. 重试 exec（排除瞬态 ETXTBSY）
echo "=== retry exec ==="
a exec-in "run-as $PKG sh -c '$DEV/nodebin/node -e \"console.log(12345)\" > $DEV/retry.log 2>&1; echo EXIT=\$? >> $DEV/retry.log'"
a shell run-as $PKG cat files/spike/retry.log

# 3. W^X 验证：symlink 到 nativeLibraryDir 的可执行库（若存在 liblaunchernode.so）
echo "=== symlink-to-nativelibdir ==="
a exec-in "run-as $PKG sh -c 'd=\$(ls -d /data/app/*/*$PKG*/lib/x86_64 2>/dev/null | head -1); echo dir=\$d > $DEV/sym.log; if [ -n \"\$d\" ] && [ -f \"\$d/liblaunchernode.so\" ]; then mkdir -p $DEV/nodebin; ln -sf \"\$d/liblaunchernode.so\" $DEV/nodebin/node2; $DEV/nodebin/node2 -e \"console.log(54321)\" >> $DEV/sym.log 2>&1; echo EXIT=\$? >> $DEV/sym.log; else echo no-liblaunchernode >> $DEV/sym.log; fi'"
a shell run-as $PKG cat files/spike/sym.log

# 4. app 数据目录 lib 路径实况
echo "=== data/app layout ==="
a exec-in "run-as $PKG sh -c 'ls -d /data/app/*/*$PKG*/lib/* > $DEV/layout.log 2>&1; ls /data/app/ >> $DEV/layout.log 2>&1'"
a shell run-as $PKG cat files/spike/layout.log
