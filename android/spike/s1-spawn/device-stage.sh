#!/usr/bin/env bash
# S1 spike：向模拟器/设备暂存 node 启动器运行环境并执行 T-A~T-C 闭环实验。
# 用法：bash device-stage.sh <adb 路径> <launcher-node 路径> <libnode.so 路径> <libc++_shared.so 路径> [serial]
set -euo pipefail

ADB="$1"
LAUNCHER="$2"
LIBNODE="$3"
LIBCXX="$4"
SERIAL="${5:-emulator-5554}"
PKG="com.aigeniusinstitute.deepthink.spike"
DEV="/data/data/$PKG/files/spike"
HERE="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"

a() { MSYS_NO_PATHCONV=1 "$ADB" -s "$SERIAL" "$@"; }

# 1. 从宿主推送 libnode.so + libc++_shared.so（与启动器同目录，rpath $ORIGIN 解析）
a exec-in "run-as $PKG sh -c 'mkdir -p $DEV/nodebin'"
cat "$LIBNODE" | a exec-in "run-as $PKG sh -c 'cat > $DEV/nodebin/libnode.so'"
cat "$LIBCXX" | a exec-in "run-as $PKG sh -c 'cat > $DEV/nodebin/libc++_shared.so'"
echo "--- nodebin libs staged ---"
a shell run-as $PKG ls -la files/spike/nodebin

# 2. 推送 node 启动器（ELF）：写 .new 再 mv 原子替换，规避 exec-in 写句柄滞留的 ETXTBSY 竞态
cat "$LAUNCHER" | a exec-in "run-as $PKG sh -c 'cat > $DEV/nodebin/node.new && chmod 755 $DEV/nodebin/node.new && mv $DEV/nodebin/node.new $DEV/nodebin/node'"
echo "--- nodebin ---"
a shell run-as $PKG ls -la files/spike/nodebin

# 3. 推送测试脚本
cat "$HERE/launcher/test2.js" | a exec-in "run-as $PKG sh -c 'cat > $DEV/test2.js'"

# 4. 推送设备侧驱动脚本并执行（exec-in 会提前返回，设备侧自等待、宿主侧轮询）
DRIVER="#!/system/bin/sh
cd $DEV
prev=0
while true; do
  sz=\$(wc -c < nodebin/node.new 2>/dev/null || echo 0)
  if [ \"\$sz\" = \"5536\" ]; then break; fi
  if [ \"\$sz\" = \"\$prev\" ] && [ \"\$sz\" != \"0\" ]; then break; fi
  prev=\$sz
  sleep 1
done
chmod 755 nodebin/node.new && mv nodebin/node.new nodebin/node
ok=0
for i in 1 2 3 4 5 6 7 8; do
  if ./nodebin/node test2.js > t2.log 2>&1; then ok=1; break; fi
  echo RETRY-\$i >> t2.log
  sleep 2
done
echo EXIT-OK=\$ok >> t2.log"
printf '%s' "$DRIVER" | a exec-in "run-as $PKG sh -c 'cat > $DEV/driver.sh'"
a exec-in "run-as $PKG sh $DEV/driver.sh"

# 5. 轮询读回结果（最多 120s）
for i in $(seq 1 60); do
  if a shell run-as $PKG cat files/spike/t2.log 2>/dev/null | grep -q "EXIT-OK"; then break; fi
  sleep 2
done
echo "--- t2.log ---"
a shell run-as $PKG cat files/spike/t2.log
echo "--- launcher-test-result.txt ---"
a shell run-as $PKG cat files/spike/launcher-test-result.txt
