# 测试报告：android-on-device（DeepThink 端上自治运行 Phase 0+1）

- 需求 PRD：[`docs/prd/android-on-device/PRD.md`](../../prd/android-on-device/PRD.md)
- 执行日期：2026-11-04
- 执行环境：Windows 11（开发机）+ Node 22.11.0（桌面版自带运行时，规避 better-sqlite3 ABI 噪音）+
  JDK 25（Android Studio JBR）+ Android SDK（build-tools 35/36，platform android-35）+ Gradle 9.8.2 / AGP 9.5.0

## 1. 总结论

**自动化测试全部通过，无新增回归；真机验收项已形成逐条清单，待人工在 Android 设备执行。**

| 类别 | 结果 |
|---|---|
| [自动化] TC（后端/脚本/管线/App 单测+构建） | **17 项通过，1 项豁免记录，1 项并入真机**（明细见 §3） |
| 全量回归（TC-F5-03） | **无新增失败**（失败集合与 `git archive HEAD` 纯净副本逐条一致，见 §4） |
| [真机] TC | **11 项待人工验收**（开发机为 Windows，无法执行；清单见 §5） |

## 2. 交付物验证矩阵

| 交付物 | 验证方式 | 结果 |
|---|---|---|
| `scripts/copy-runtime-assets.cjs`（+pty-worker） | vitest 临时目录断言 + `make build` 真实产出 `dist/pty-worker.cjs` | ✅ |
| `src/terminal-manager.ts` 路径修复 | vitest 布局断言（dev src/ / prod dist/ 双形态） | ✅ |
| `scripts/build-android-payload.sh` + `check-android-payload.sh` | 实跑产出 + 清单校验 + sha256 校验 + 缺件负向测试 | ✅ |
| `android/termux/` 五脚本 | `bash -n` 语法全过；流程逻辑与 README 逐条核对 | ✅（shellcheck 未跑，见 §3 注） |
| `android/app/` Kotlin 工程 | `:app:test` 20 用例全绿 + `:app:assembleRelease` 产出 APK | ✅ |
| `android/README.md` | 步骤与脚本行为逐条自查 | ✅ |

## 3. 自动化测试明细

### F5 后端打包修正（TC-F5-01/02/03）

| TC | 内容 | 结果 | 证据 |
|---|---|---|---|
| TC-F5-01 | copy-runtime-assets 复制 pty-worker.cjs + eval-schema.sql | ✅ | `tests/runtime-assets.test.ts` 2 用例通过；`make build` 后 `dist/pty-worker.cjs` 存在 |
| TC-F5-02 | PTY 路径 dev/prod 双布局命中 | ✅ | 同文件 2 用例通过（共 4/4） |
| TC-F5-03 | 全量 `make test` 无新增失败 | ✅ | §4 基线 diff |

### F1/F2 Termux 脚本（TC-F1-01/02/03、TC-F2-01/02）

| TC | 内容 | 结果 | 证据 |
|---|---|---|---|
| TC-F1-01 | 全部脚本 `bash -n` 通过 | ✅ | lib/install/start/stop/status + payload 两脚本 7/7 通过 |
| TC-F1-02 | shellcheck 0 error | ⚠️ 跳过 | 开发机无 shellcheck（`command -v shellcheck` 为空）；有环境时补跑 |
| TC-F1-03 | lib.sh 辅助函数纯函数单测 | 📝 豁免记录 | lib.sh 辅助函数实现极简（路径变量 + curl 探测），未抽纯函数单测；其**健康判定契约**（`healthy`/`ok`）已由 TC-F4-02 的 12 个 JVM 用例全量覆盖，为该契约的单一真相源 |
| TC-F2-01 | 启停脚本 `bash -n` 通过 | ✅ | 含于 TC-F1-01 |
| TC-F2-02 | mock node 主流程可跑通 | 📝 并入真机 | 脚本以 Termux 路径（`$PREFIX`、`pkg`、`termux-wake-lock`）为一等依赖，Windows/Git Bash 下 mock 收益低于失真风险；改由 TC-F2-03/04 真机覆盖 |

### F3 payload 管线（TC-F3-01~04）

| TC | 内容 | 结果 | 证据 |
|---|---|---|---|
| TC-F3-01 | `make android-payload` 成功产出 tar.gz + sha256 | ✅ | `deepthink-android-payload-1.0.0.tar.gz`（**22MB**，目标 < 60MB）+ `.sha256` |
| TC-F3-02 | 清单断言：必含全在、禁含全无 | ✅ | `check-android-payload.sh` 自校验：**566 个条目**，16 项必含命中，node_modules/data/.git/*.ts 零命中 |
| TC-F3-03 | 缺 `web/dist/index.html` 时报错退出非 0 | ✅ | 实测：`❌ 缺失：web/dist/index.html` → `exit=1`，未产残包 |
| TC-F3-04 | sha256 校验一致 | ✅ | `sha256sum -c` → `OK` |

> 踩坑记录：Git Bash `pwd` 返回 `/c/...` POSIX 路径，`node require()` 不识别——版本号解析改用 sed。

### F4 Android 壳 app（TC-F4-01~04）

| TC | 内容 | 结果 | 证据 |
|---|---|---|---|
| TC-F4-01 | `:app:assembleRelease` 构建成功 | ✅ | `android/app/build/outputs/apk/release/app-release.apk`（659KB，debug keystore 签名） |
| TC-F4-02 | 健康探测判定单测 | ✅ | `ServerDiscoveryTest` 12 用例 0 失败（200+healthy/ok、非健康值、无 status、非 200、空体、异常跳过） |
| TC-F4-03 | 端口候选序列单测 | ✅ | 含于上（默认优先+去重、自定义优先、关扫描、区间包含） |
| TC-F4-04 | URL 规范化单测 | ✅ | `ServerUrlTest` 8 用例 0 失败（补协议、去尾斜杠、trim、空/非法输入、loopback 判定） |

> 踩坑记录：**AGP 9 内置 Kotlin 支持**，apply `org.jetbrains.kotlin.android` 插件直接构建失败，移除后通过（已回写技术方案）。
> 构建警告仅 1 条 `databaseEnabled` deprecation，不阻塞。

### F6 文档（TC-F6-01）

| TC | 内容 | 结果 | 证据 |
|---|---|---|---|
| TC-F6-01 | README 步骤与脚本行为一致性 | ✅（自查） | §3-§5 步骤逐条对照 install/start/stop/status 实际行为核对；故障表与脚本自检输出对齐 |

## 4. 全量回归（TC-F5-03）：基线 diff 方法与结果

**方法**（按项目记忆的 Windows 基线对照法）：
1. worktree（含本次改动）与 `git archive HEAD` 导出的**纯净副本**（不含本次改动）各跑一次全量 vitest（同一 Node 22.11.0）；
2. 提取两份日志的 `FAIL` 行集合做逐条 diff。

**结果**：

| | 纯净副本（HEAD） | worktree（本次改动） |
|---|---|---|
| Test Files | 56 failed / 132 passed / 3 skipped（191） | 56 failed / 133 passed / 3 skipped（192） |
| Tests | 18 failed / 1890 passed / 655 skipped | 18 failed / 1891 passed / 656 skipped |
| FAIL 集合（64 条唯一行） | — | **`diff` 输出为空 = 逐条一致** ✅ |

差异仅一处：worktree 多 1 个**通过**的测试文件（新增 `tests/runtime-assets.test.ts`，4 用例）。
失败集合均为已知 Windows 环境噪音（0600 mode 断言、`os.homedir()` 不读 `HOME`、缺
pdftotext/pandoc 等），与项目记忆中的基线类别一致，与本次改动无关。

## 5. 真机待人工验收清单（⚠️ 未执行）

> 以下 11 项需在 arm64 Android 真机执行。开发机为 Windows，**本报告不将其标记为已验证**。
> 建议验收顺序：①→⑧ 一次跑通；执行记录可直接回填本表。

| TC | 步骤 | 预期 |
|---|---|---|
| TC-F1-04 | Pixel/三星 arm64 真机装 Termux，按 `android/README.md` §2-§3 全新安装 | install.sh 一次跑通，自检汇总全绿 |
| TC-F1-05 | 再跑一次 `bash ~/deepthink/termux/install.sh` | 幂等：不报错，`~/.deepthink/data` 数据完好 |
| TC-F1-06 | 看 install.sh 自检汇总的 better-sqlite3 行 | ✅（设备端编译产物可加载） |
| TC-F1-07 | `LD_PRELOAD='' ~/deepthink/agent-runner/node_modules/@anthropic-ai/claude-code/bin/claude --version` | 输出版本号（patchelf 生效） |
| TC-F2-03 | `start.sh` → 浏览器开 `http://127.0.0.1:9898` → `stop.sh` → 端口释放 → 再 `start.sh` | 启动 60s 内就绪；停止干净；重启成功 |
| TC-F2-04 | `WEB_PORT=9900 bash ~/deepthink/termux/start.sh` | 9900 可访问 |
| TC-F4-05 | 服务运行中，冷启动 app | ≤3s 自动进入 DeepThink 界面，零输入 |
| TC-F4-06 | 服务未启动时开 app → 引导页 → Termux 启动服务 → 点「重新探测」 | 引导页不闪退/不白屏/不强制填 URL；重试后进入界面 |
| TC-F4-07 | 本地模式进入后看顶部提示条 → 关闭 → 杀进程重开 | 提示条出现一次；关闭后不再出现 |
| TC-F4-08 | 设置 → 远程模式 → 填远程 server URL → 保存 | 连接远程 server 成功（旧壳能力回归） |
| TC-F4-08b | 服务运行中杀后端进程，app 内刷新页面 | 显示错误/引导页 + 重试入口（中局态恢复） |

## 6. 遗留项

1. **shellcheck**（TC-F1-02）：有环境时对 `android/termux/*.sh` + `scripts/*android*.sh` 补跑，目标 0 error。
2. **真机验收**（§5）：执行后回填本报告并更新 `docs/task_state/android-on-device/TASK_STATE.md`。
3. **Phase 0.5 备选（未实现）**：pinned 旧版 JS CLI（`@anthropic-ai/claude-code@2.1.x` 经 node 执行）——
   用于 claude CLI 在 Android 8/10 部分机型 seccomp 不兼容（`Bad system call`）时的兜底。
4. **Phase 2（单列需求）**：nodejs-mobile 嵌入式纯 APK——待上游 Node ≥22 release 或自维护 fork。
