// S1 spike：node 启动器（方案 A）。
// libnode.so 是共享库、没有 node 可执行文件，DeepThink 的 spawn('node', ...) 因此失败；
// 本启动器是一个微型 ELF，动态链接 libnode.so 并转调 node::Start，
// 以 "node" 为名放在 PATH 上即补齐整条执行链（实测 T3 证明普通 ELF spawn 可用）。
// 编译（NDK，两个 ABI）：
//   x86_64:  x86_64-linux-android26-clang++ launcher.cpp -o node \
//            -L<libnode-dir> -lnode -Wl,-rpath,'$ORIGIN'
//   arm64:   aarch64-linux-android26-clang++ 同上
// 运行时要求 libnode.so 与 libc++_shared.so 位于启动器同目录（$ORIGIN）。
#include <cstdio>

namespace node {
int Start(int argc, char **argv);
}

int main(int argc, char **argv) {
    return node::Start(argc, argv);
}
