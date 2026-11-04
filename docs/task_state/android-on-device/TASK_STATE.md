# 执行状态：android-on-device（Phase 0+1）

> 需求：DeepThink 端上自治运行（Android 本地部署）
> 分支：`worktree-android-on-device`（worktree：`.claude/worktrees/android-on-device`）
> 更新：2026-11-04

## 进度总览

| 里程碑 | 内容 | 状态 |
|---|---|---|
| M1 | PRD + 技术方案 | ✅ 完成（`docs/prd/android-on-device/PRD.md`、`docs/tech_solution/android-on-device/TECH_SOLUTION.md`） |
| M2 | F5 后端打包修正（pty-worker） | ✅ 完成，TC-F5-01/02 通过 |
| M3 | F1/F2/F3 脚本与打包管线 | ✅ 完成，TC-F1-01、TC-F3-01~04 通过 |
| M4 | F4 Android 壳 app | ✅ 完成，TC-F4-01~04 通过（构建 + JVM 单测） |
| M5 | F6 文档 + 测试报告 | ✅ 完成（`android/README.md`、`docs/test_report/android-on-device/TEST_REPORT.md`） |
| 全量回归 | TC-F5-03 `make test` 无新增失败 | ✅ 通过（对照 Windows 基线） |

## 交付物清单（均已落库）

1. `scripts/copy-runtime-assets.cjs`：ASSETS 增加 `pty-worker.cjs`，ROOT 支持 `RUNTIME_ASSETS_ROOT`（测试用）
2. `src/terminal-manager.ts`：`PTY_WORKER_PATH` 改为 `__dirname/pty-worker.cjs`（dev/prod/打包同构）
3. `scripts/build-android-payload.sh` + `scripts/check-android-payload.sh` + Makefile `android-payload` / `android-payload-check`
4. `android/termux/{lib.sh,install.sh,start.sh,stop.sh,status.sh}`（一键安装/启停/状态）
5. `android/app/`（Kotlin 工程：MainActivity / ServerDiscovery / ServerUrl / SettingsActivity / Http / Prefs + 2 个 JVM 测试类）
6. `android/README.md`（手机端安装手册 + 故障排查 + 安全须知）
7. 测试：`tests/runtime-assets.test.ts`（vitest）+ `android/app/src/test/`（JUnit）

## 执行记录

- **2026-11-04 方案定稿**：范围=Phase 0+1 全量（用户确认）；app 源码新写入库（用户确认）。
  嵌入式 nodejs-mobile（Phase 2）不做——nodejs-mobile release 停在 Node 18，跑不动 Node ≥22。
- **F5**：copy-runtime-assets + terminal-manager 路径修复；`tests/runtime-assets.test.ts` 4 用例全过；
  `make build` 真实构建产出 `dist/pty-worker.cjs` 验证。
- **F1/F2**：termux 五脚本；`bash -n` 全过；shellcheck 本机不可用（TC-F1-02 记录跳过）。
  glibc 兼容配方取自 claude-code-android（patchelf 重写 interpreter + LD_PRELOAD 清理 + 冒烟检测）。
- **F3**：payload 管线跑通——产物 22MB / 566 条目（目标 < 60MB）；清单校验、sha256 校验、
  缺件负向测试（exit 1 不产残包）均过。踩坑记录：Git Bash `pwd` 为 `/c/...` POSIX 路径，
  `node require()` 不认，版本号解析改用 sed。
- **F4**：工具链定版 Gradle 9.8.2 + AGP 9.5.0 + JDK25（AS JBR）。踩坑记录：**AGP 9 内置
  Kotlin 支持，apply `org.jetbrains.kotlin.android` 直接报错**，移除后通过。
  `:app:test` 20 用例全绿（ServerDiscoveryTest 12 + ServerUrlTest 8）；`:app:assembleRelease`
  产出 `app-release.apk`（659KB，debug keystore 签名）。
- **回归**：Node22 全量 vitest 对照 Windows 基线（15 个环境失败），无新增失败——详见测试报告。

## 遗留 / 待人工验收

| 项 | 说明 |
|---|---|
| TC-F1-04~07、TC-F2-03/04、TC-F4-05~08 | **真机验收清单**（开发机为 Windows，无法执行）：Termux 全新安装、幂等重装、better-sqlite3/claude 自检、启停/换端口、app 自动发现/引导页/降级提示/远程模式。逐条步骤见 `android/README.md` §3-§5 与测试报告 |
| shellcheck | TC-F1-02：本机无 shellcheck，脚本以 `bash -n` 通过；有环境时补跑 |
| Phase 2 嵌入式（nodejs-mobile） | 单列后续需求；待 nodejs-mobile Node ≥22 release 或自维护 fork |
| pinned 旧版 JS CLI 备选 | claude CLI 在 Android 8/10 部分机型 seccomp 不兼容时的 Phase 0.5 方案，本期未实现（README 故障表已指向） |
