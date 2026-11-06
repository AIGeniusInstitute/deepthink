# PRD：DeepThink Android 单 APK 开箱即用（Phase 2 嵌入式运行时）

- 需求代号：`android-single-apk`
- 版本：v1.0（2026-11-06）
- 状态：已立项（立项决策见 §2.3；壳策略：**保留 Kotlin 壳 + JNI 嵌入 Node 运行时**，2026-11-06 拍板）
- 前置需求：`android-on-device`（Phase 0+1，Termux 路线，已交付 v1.9.0）
- 前置调研：本会话 2026-11-06 对嵌入式路线的可行性核验（结论见 §1.2），推翻了 2026-11-04 可行性研究中
  "nodejs-mobile 停在 Node 18"的阻塞判断

---

## 1. 背景与问题

### 1.1 为什么做

Phase 0+1（Termux 路线）交付后真机实测（2026-11-06，小米 25042PN24C / Android 16）证明：
**该形态对普通用户不可接受**。完成一次安装需要用户：装 Termux（第三方渠道）→ 传 payload →
在 Termux 里跑 5–15 分钟安装脚本 → 保持 Termux 前台 → 手动 start.sh。任何一环都会卡住非技术用户。

产品要求明确：**统一打包一个 APK，用户安装、打开，即可使用**——不需要 Termux、不需要任何
命令行、不需要外部 server。

### 1.2 可行性核验结论（2026-11-06，ground truth）

| 事实 | 依据 |
|---|---|
| nodejs-mobile 官方（JaneaSystems / nodejs-mobile org）**仍停在 Node 18**（v18.20.4） | GitHub releases |
| **flun 活跃 fork `@flun/nodejs-mobile-react-native` v2.1.4 内嵌 Node.js v22.23.2** | npm registry，2026-11-06 仍在发版 |
| `@flun/node-mobile-app` v4.1.1：零侵入 Node→APK 打包 CLI（RN 壳），Android 支持 Windows 构建 | npm registry |
| 该工具**自动交叉编译原生模块**（正中 better-sqlite3）、自动识别 `listen()` 端口、内置 WebView + 错误页 | README |
| `capacitor-nodejs` 停在 0.0.1（2022）已死；`aosp-node-bridge` 在 npm / Maven Central 均不存在 | npm / Maven 查询 |
| DeepThink 后端是**单进程 Node 服务**（自己 serve 前端 + API + WS），4 个 `DEEPTHINK_*` 环境变量可覆盖全部关键路径 | android-on-device 可行性研究（已验证） |
| 无 Docker 是一级路径：host 执行模式自动降级，仅沙箱/浏览器/终端三项降级 | 同上（已验证） |

**原 Phase 2 的唯一阻塞（Node 18）已解除**，本需求立项。

### 1.3 贴文参考材料的核验记录（存档）

外部参考文（"WebView + 进程内 Node.js HTTP Server"方案）给出三条路径，核验结果：
A（Capacitor + @capacitor-nodejs）生态已死；B（@flun/node-mobile-app）真实可用但默认 RN 壳；
C（aosp-node-bridge）为幻觉产物。参考文的核心论点（前台服务是前提、端口生命周期、
动态 require 打包陷阱、原生模块交叉编译、体积取舍）全部成立，已吸收进本 PRD 与技术方案。

## 2. 目标与非目标

### 2.1 目标（用户视角）

1. 用户从分发渠道拿到**单个** `DeepThink.apk`，安装后**打开即用**：
   无 Termux、无命令行、无 URL 配置、无外部 server；
2. 首次打开 → 自动启动内嵌 DeepThink 服务 → WebView 自动连接 → 直接进入对话界面；
3. 对话（含流式）、文件、记忆、定时任务、Skills、多 Agent 编排全部跑在本机；
   退后台/锁屏后**长任务与定时任务继续执行**（前台服务保活）；
4. 覆盖升级（同签名）**不丢数据**（对话/记忆/文件/配置）；
5. 构建可在 Windows 开发机一键完成（`make android-apk`），产出可安装的签名 APK。

### 2.2 非目标（本期不做）

| 非目标 | 原因 |
|---|---|
| iOS | 另立需求（flun 工具支持 iOS，但需 macOS 构建链） |
| Google Play 上架 | 打包执行代码违反 Play 政策；企业侧载/自有渠道分发 |
| 端侧本地 LLM（真·离线） | 能力差距大，单列研究课题 |
| Docker 沙箱 / 浏览器自动化 / Web 终端在端上可用 | Android 无 Docker；沿用降级提示兜底 |
| Termux 路线退役 | 保留为高级/开发模式，与本形态并存，不互相依赖 |

### 2.3 已拍板的架构决策

1. **壳策略：保留现有 Kotlin WebView 壳**（含自动发现状态机、设置页），**不**换用
   `@flun/node-mobile-app` 的 React Native 壳；运行时取 flun fork 的 libnode（Node v22.23.2）
   以 JNI 嵌入，生命周期（Idle→Starting→Running→Exited/Failed）由 Kotlin 层自管；
2. 内嵌服务固定服务 `127.0.0.1`（默认 9898，可复用现有发现状态机与端口扫描）；
3. 数据目录使用 **App 私有存储**（`/data/data/com.aigeniusinstitute.deepthink/files/`），
   对应桌面版 `DEEPTHINK_*` 四环境变量约定，不写共享存储。

### 2.4 成功判据（需求级验收）

在小米真机（25042PN24C，Android 16，arm64）全新安装 release APK：
**安装 → 打开 → ≤30s 自动进入可用对话界面 → 完成一次含工具调用的 Agent 对话 → 杀后台重进数据仍在**。
全程零命令行、零手工配置。此判据以真机测试报告（docs/test_report/android-single-apk/）为准。

## 3. 术语

| 术语 | 定义 |
|---|---|
| 嵌入式运行时 | libnode.so（Node v22.23.2，flun fork 构建）经 JNI 加载，在 App 进程内（或独立进程）运行 DeepThink 后端 |
| 五件套 | 后端 `dist/` + 前端 `web/dist/` + agent-runner（dist/prompts/package.json）+ 根生产依赖 + 配置模板 |
| spawn 链 | 后端 → `node agent-runner` → SDK/claude CLI 的子进程执行链（本需求最大技术风险，见 F3） |
| glibc 兼容 | Android bionic 不能执行 glibc ELF；打包 patchelf 处理过的 claude CLI + glibc loader 进 APK |
| 前台服务 | Android Foreground Service + 常驻通知，防止 App 退后台后进程被回收 |

## 4. 功能需求

> 每个功能点：需求描述 → 验收标准（AC）→ 测试用例（TC）。
> TC `[自动化]` 纳入本地/CI 可重复执行；`[真机]` 需 Android 设备人工验收。

### F1 嵌入式 Node 运行时宿主

**描述**：Kotlin 层通过 JNI 加载 libnode（Node v22.23.2），启动 DeepThink 后端
（`backend/index.js`），实现生命周期状态机 `Idle → Starting → Running → Exited/Failed`，
状态变化驱动 UI（启动中/已连接/错误页 + 可展开日志）。

AC：
1. App 启动即触发运行时启动，无需用户操作；`Starting` 到 `Running`（健康检查
   `GET /api/health` 返回 200 + status healthy/ok）≤30s（冷启，中端机）；
2. 运行时崩溃/退出时状态机进入 `Failed`，UI 显示错误页与日志尾部，提供「重试」按钮；
3. 运行时可被显式停止（设置页开关），停止后端口释放、进程退出干净；
4. libnode 版本为 Node ≥22（与后端 `require_node` 约束一致），启动日志打印 `node -v`。

TC：
- TC-F1-01 `[真机]` 全新安装冷启动 ≤30s 进入对话界面，健康检查通过
- TC-F1-02 `[真机]` 注入崩溃（kill 运行时进程）→ 错误页出现 → 点重试 → 恢复 Running
- TC-F1-03 `[自动化]` 生命周期状态机单测（状态迁移、重复启动幂等、stop 释放端口）
- TC-F1-04 `[真机]` 设置页停止服务 → 本机 9898 拒绝连接；重启服务 → 恢复

### F2 前台服务保活

**描述**：Node 服务托管在 Android Foreground Service 中，持常驻通知；退后台/锁屏后
长任务与定时任务继续执行。

AC：
1. 服务运行期间存在常驻通知（可配置文案，含服务状态），通知点击返回 App；
2. 退后台 30 分钟 + 锁屏场景下，运行中的 Agent 长任务与 `schedule_task` 定时任务照常触发执行；
3. 系统省电策略（MIUI/HyperOS 深度休眠）下不被杀：进程存活率验收见 TC；
4. 用户从最近任务划掉 App：服务随 App 生命周期停止（不残留常驻通知），下次打开自动重启服务。

TC：
- TC-F2-01 `[真机]` 退后台 30min + 锁屏 → 定时任务按时执行（以 `schedule_task` 5min 后触发验证）
- TC-F2-02 `[真机]` MIUI 电池优化不设白名单，灭屏 1h → 服务仍存活（`/api/health` 可达）
- TC-F2-03 `[真机]` 划掉 App → 通知消失、进程退出；重开 → 服务自动回到 Running
- TC-F2-04 `[自动化]` Foreground Service 启停与通知状态的 Robolectric/单测（如引入成本过高可降级为真机脚本）

### F3 子进程执行链（最大技术风险，先 spike 后实现）

**描述**：DeepThink 后端需 `spawn('node', agent-runner)`、PTY worker、`execFile('claude')`。
嵌入式运行时是 libnode（**无 `node` 可执行文件**），必须打通整条 spawn 链，
否则壳可开但 Agent 全废。候选方案（spike 定型，见技术方案 §5）：
A) 打包 `node` 启动器可执行文件；B) agent-runner 改 in-process（模块加载）；
C) flun 运行时自带的子进程桥。

AC：
1. 对话含工具调用的完整 Agent 会话可跑通（agent-runner 成功启动并回流 StreamEvent）；
2. `/recall` 斜杠命令（`execFile('claude', ['--print'])`）可用，或有明确降级行为（返回原始消息列表）；
3. spawn 失败时不崩主进程，错误进入会话错误流（复用 `agent_error` 机制）；
4. 会话循环（IPC 注入后续消息）功能完整：多轮对话、并发会话互不串扰。

TC：
- TC-F3-01 `[真机]` 发起含工具调用的对话 → Agent 完整应答（StreamEvent 流式可见）
- TC-F3-02 `[真机]` 连续多轮对话（≥5 轮）+ 两个并行会话 → 不串扰不丢消息
- TC-F3-03 `[真机]` `/recall` 可用或按 AC3 降级
- TC-F3-04 `[自动化]` spawn 链失败注入（错误 node 路径）→ 错误流可见、主进程存活

### F4 claude CLI glibc 兼容打包

**描述**：claude CLI 是 glibc ELF。构建期用 patchelf 重写 interpreter 指向打包进 APK 的
glibc loader（复用 android-on-device 的 `glibc-repo + patchelf-glibc` 配方，构建期在开发机执行），
运行期以 `LD_PRELOAD=''` + 指定 loader 启动。

AC：
1. APK 内含 patchelf 处理后的 claude CLI（arm64）与 glibc loader/libs；
2. 真机上 `claude --version` 可执行输出正常（沙箱外经由运行时调用）；
3. 已知机型不兼容（`Bad system call`）时降级清晰：错误信息指向 README 故障排查。

TC：
- TC-F4-01 `[自动化]` 构建管线产出含 claude CLI + loader 的 APK（脚本校验 assets 清单）
- TC-F4-02 `[真机]` claude CLI 在设备上 `--version` 可执行
- TC-F4-03 `[真机]` SDK 调用路径（非显式 CLI）跑通一次 Agent 会话

### F5 原生模块交叉编译（better-sqlite3）

**描述**：better-sqlite3 等 `.node` 原生模块按 android-arm64 交叉编译（NDK + Node 22 headers），
随 APK 分发；运行期 `require` 加载自检。

AC：
1. 构建产物中 `better_sqlite3.node` 为 android-arm64 编译产物；
2. 真机加载自检通过（`:memory:` 建表/写读）；
3. 其余原生模块（如有）同样纳入交叉编译清单；纯 JS 依赖不受影响。

TC：
- TC-F5-01 `[自动化]` 构建后校验 `.node` 文件 ABI/架构（`file` 或 readelf 检查 aarch64）
- TC-F5-02 `[真机]` 启动自检 better-sqlite3 可加载；对话写库读库正常

### F6 自动发现与 UI 集成

**描述**：复用现有 Kotlin 发现状态机：服务 Running 后 WebView 自动连接
`http://127.0.0.1:9898`；沿用设置页（远程模式切换）与一次性降级提示条。

AC：
1. 打开 App 无需填任何 URL 即进入界面；
2. 服务启动中显示启动进度/日志尾部（而非空白）；
3. 远程模式（填 server URL）继续可用，与本地模式互斥切换即时生效（沿用 v1.9.0 修复）；
4. 本地模式降级提示条（沙箱/浏览器/终端不可用）沿用，可关闭。

TC：
- TC-F6-01 `[真机]` 全新安装首启零配置进入对话界面
- TC-F6-02 `[真机]` 启动 30s 内可见进度/日志（非空白页）
- TC-F6-03 `[真机]` 切远程模式填 URL → 连接远程；切回本地 → 自动重连本机

### F7 端口与进程生命周期

**描述**：启动前检测端口占用（被上一次残留实例占用时先清理）；启动失败可见；
支持设置页修改端口（复用现有发现区间逻辑）。

AC：
1. 冷启动 / 被划掉后重启 / 崩溃重启三种场景均不出现"端口占用导致静默启动失败"；
2. 端口被其他应用占用时错误页明确提示并给出改端口入口；
3. 运行时重启（设置页/错误页重试）不产生僵尸进程与端口泄漏。

TC：
- TC-F7-01 `[真机]` 划掉 App 重开 ×5 → 5 次全部正常进入界面
- TC-F7-02 `[真机]` 人为占用 9898 → 错误页提示 + 改端口后可用

### F8 数据目录与升级保数据

**描述**：运行时数据存 App 私有存储（`files/.deepthink/data` 一类布局，映射
`DEEPTHINK_DATA_DIR`）；同签名覆盖升级保留全部数据；卸载即清空（Android 标准语义）。

AC：
1. 对话/记忆/文件/配置全部落在 App 私有目录，不写共享存储；
2. v1（本需求首版）→ v1.x 同签名覆盖升级后，历史对话/记忆/文件完好；
3. 与桌面版数据格式兼容（同一 db schema 版本线）。

TC：
- TC-F8-01 `[真机]` 产生对话/文件 → 覆盖安装新版本 → 数据完好
- TC-F8-02 `[自动化]` 数据目录布局与 `DEEPTHINK_*` 映射单测

### F9 构建管线（Windows 可一键产出）

**描述**：`make android-apk` 一键产出安装 APK：后端五件套打包进 assets + libnode ABI
拆分 + better-sqlite3 交叉编译 + claude CLI patchelf 处理 + Gradle 签名构建。
产出 `android/app/build/outputs/apk/release/app-release.apk`。

AC：
1. Windows 开发机一条命令产出可安装 APK（允许首次运行下载 NDK/依赖）；
2. 构建自校验：assets 清单完整（五件套 + libnode + loader + claude + .node）缺一即失败；
3. 版本号语义：`versionName` 跟随 `package.json` version，`versionCode` 单调递增且不回退
   （吸取 2026-11-06 真机 INSTALL_FAILED_VERSION_DOWNGRADE 教训：禁止时间戳 versionCode）。

TC：
- TC-F9-01 `[自动化]` `make android-apk` 成功产出 APK + 校验脚本通过
- TC-F9-02 `[自动化]` 版本号单调性检查（对比上一 release 的 versionCode）
- TC-F9-03 `[真机]` 产出 APK 在小米真机全新安装成功

### F10 开箱体验（需求级 E2E）

**描述**：合并 F1–F9 的端到端验收，以 §2.4 成功判据为准。

TC：
- TC-F10-01 `[真机]` §2.4 成功判据全流程一次通过
- TC-F10-02 `[真机]` 全程无命令行/无 Termux/无手工配置（操作计数：安装 + 打开 + 登录/初始化 ≤3 步）

## 5. 风险与前置 Spike

| # | 风险 | 等级 | 对策（spike 项，先行验证） |
|---|---|---|---|
| R1 | spawn 链不通（libnode 无 node 可执行文件）→ Agent 全废 | **高** | S1：真机验证三种 spawn 方案至少一种通（F3 候选 A/B/C） |
| R2 | claude CLI glibc ELF 在 App 进程模型下不可执行（seccomp/机型差异） | **高** | S2：patchelf + loader 打包后真机执行 `--version` |
| R3 | 前台服务在 MIUI/HyperOS 深度休眠下仍被杀 | 中 | S3：真机 1h 灭屏保活实测（配合自启动引导提示） |
| R4 | better-sqlite3 交叉编译 ABI 不匹配（Node 22 headers 对齐） | 中 | S4：NDK 编译 + 真机加载自检 |
| R5 | APK 体积膨胀（libnode ~30–50MB + glibc + claude） | 低 | 构建期 node_modules 六阶段瘦身（flun 配方可借鉴），目标 <150MB |
| R6 | flun fork 为个人维护，上游可持续性 | 中 | 隔离层封装（RuntimeHost 接口），锁定版本构建；必要时自建 fork |

**Spike 门禁**：S1–S2 任一失败则本 PRD 回炉（候选：回退方案 C 全量采用 flun RN 壳、
或调整 F3 为 in-process 重构），不带病进入 F3 实现。

## 6. 里程碑

| 阶段 | 内容 | 出口 |
|---|---|---|
| M0 Spike | S1–S4 真机验证，定型 F3 方案 | spike 报告（写入 tech_solution 附录） |
| M1 运行时 | F1/F2/F7：运行时宿主 + 前台服务 + 生命周期 | 真机起服务、健康检查、保活实测 |
| M2 执行链 | F3/F4/F5：spawn 链 + claude 兼容 + 原生模块 | 完整 Agent 对话真机跑通 |
| M3 产品化 | F6/F8/F9/F10：UI 集成 + 升级保数据 + 构建管线 | §2.4 成功判据 + 测试报告 |

## 7. 文档产出约定

- 技术方案：`docs/tech_solution/android-single-apk/TECH_SOLUTION.md`
- 执行状态：`docs/task_state/android-single-apk/TASK_STATE.md`
- 测试报告：`docs/test_report/android-single-apk/TEST_REPORT.md`
- Spike 结论附录于技术方案；真机测试均在小米 25042PN24C（Android 16）执行并留档
