# 执行状态：android-single-apk（单 APK 开箱即用）

- 需求 PRD：`docs/prd/android-single-apk/PRD.md`
- 技术方案：`docs/tech_solution/android-single-apk/TECH_SOLUTION.md`
- 开发分支：`worktree-android-single-apk`（worktree: `.claude/worktrees/android-single-apk`）
- 真机：小米 25042PN24C（Android 16，arm64）

## 进度总览

| 阶段 | 内容 | 状态 | 备注 |
|---|---|---|---|
| 步骤 1 | PRD + 验收标准 + 测试用例 | ✅ 完成 | 2026-11-06 |
| 步骤 2 | 技术方案 | ✅ 完成 | 2026-11-06，含 spike 计划与方案对比 |
| M0 Spike | S1 spawn 链 / S2 claude glibc / S3 保活 / S4 better-sqlite3 | 🔨 进行中 | 供应链与集成路径已验证（见下），S1 真机实验待做 |
| M1 运行时 | F1 RuntimeHost + F2 前台服务 + F7 端口生命周期 | ⏳ 未开始 | 依赖 M0 |
| M2 执行链 | F3 spawn 链 + F4 claude 打包 + F5 原生模块 | ⏳ 未开始 | 依赖 M0 定型 |
| M3 产品化 | F6 UI 集成 + F8 数据目录 + F9 构建管线 + F10 E2E | ⏳ 未开始 | |
| 步骤 5 | 测试报告 | ⏳ 未开始 | `docs/test_report/android-single-apk/` |

## 关键决策记录

- 2026-11-06 立项决策：推进方式 = 立项 + 内嵌 spike；壳策略 = **保留 Kotlin 壳 + JNI 嵌入运行时**。
- 2026-11-06 可行性核验：flun fork `@flun/nodejs-mobile-react-native` v2.1.4 内嵌 Node v22.23.2，
  原 Phase 2 的 Node 18 阻塞解除；`capacitor-nodejs`（停更）与 `aosp-node-bridge`（不存在）出局。
- versionCode 规则改为语义映射（tech_solution §8），禁止时间戳 versionCode
  （2026-11-06 真机 INSTALL_FAILED_VERSION_DOWNGRADE 事故教训）。

## M0 Spike 发现（2026-11-06）

- ✅ **运行时供应链验证通过**：`android-libnode.zip`（83MB，含三 ABI `libnode.so` + Node headers）
  发布于 OpenFlun/nodejs-mobile release v22.23.2，gitee（主）/ github（备）双源 200 可达；
  `@flun/nodejs-mobile-react-native` 的 postinstall 即从此下载（`prebuiltAssets` 配置）。
- ✅ **集成路径定型（tech_solution 路径 i）**：npm 包内 `android/src/main/cpp/native-lib.cpp` 的
  JNI 胶水核心仅 `node::Start(argc, argv)`（+ stdout/stderr→logcat 重定向），可改造为我们的
  `RuntimeHost` JNI 模块，无需 RN 壳。`node.h` 头文件随 `android-libnode.zip` 提供。
- ✅ **原生模块交叉编译机制可直接复用**：flun build.gradle 的 node-gyp 管线
  （`@flun/nodejs-mobile-gyp`，NDK toolchain，**含 Windows 宿主支持**）正是 better-sqlite3（S4）所需。
- ⏳ S1 spawn 链真机实验未做（libnode 无 `node` 可执行文件，`child_process.spawn('node')` 行为待验，
  方案 A 启动器 ELF = `dlopen(libnode)→node::Start` 的 20 行 C，与 RuntimeHost 胶水同构）。

## 风险台账

| 风险 | 等级 | 状态 |
|---|---|---|
| R1 spawn 链（libnode 无 node 可执行文件） | 高 | 未验证（S1） |
| R2 claude CLI glibc ELF | 高 | 未验证（S2） |
| R3 MIUI/HyperOS 保活 | 中 | 未验证（S3） |
| R4 better-sqlite3 交叉编译 ABI | 中 | 未验证（S4） |
| R5 APK 体积 | 低 | 未开始度量 |
| R6 flun fork 可持续性 | 中 | 已对策（隔离层 + 版本锁定） |
