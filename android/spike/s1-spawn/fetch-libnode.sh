#!/usr/bin/env bash
# 把 android-libnode.zip（OpenFlun/nodejs-mobile release v22.23.2）暂存进 spike 工程。
# 用法：bash fetch-libnode.sh [zip 路径]
set -euo pipefail

DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
ZIP="${1:-}"
if [ -z "$ZIP" ]; then
  echo "用法：bash fetch-libnode.sh <android-libnode.zip 路径>" >&2
  echo "下载：https://gitee.com/OpenFlun/nodejs-mobile/releases/download/v22.23.2/android-libnode.zip" >&2
  exit 1
fi
[ -f "$ZIP" ] || { echo "zip 不存在：$ZIP" >&2; exit 1; }

rm -rf "$DIR/app/src/main/cpp/libnode"
unzip -q "$ZIP" -d "$DIR/app/src/main/cpp/"

mkdir -p "$DIR/app/src/main/jniLibs/x86_64" "$DIR/app/src/main/jniLibs/arm64-v8a"
cp "$DIR/app/src/main/cpp/libnode/bin/x86_64/libnode.so" "$DIR/app/src/main/jniLibs/x86_64/"
cp "$DIR/app/src/main/cpp/libnode/bin/arm64-v8a/libnode.so" "$DIR/app/src/main/jniLibs/arm64-v8a/"

echo "libnode staged："
ls -la "$DIR/app/src/main/jniLibs/x86_64/" "$DIR/app/src/main/cpp/libnode/bin/"
