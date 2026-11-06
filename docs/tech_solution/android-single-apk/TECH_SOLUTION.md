# 技术方案：DeepThink Android 单 APK 开箱即用（`android-single-apk`）

- 版本：v1.0（2026-11-06）
- 对应 PRD：`docs/prd/android-single-apk/PRD.md`
- 架构决策（已拍板）：**保留 Kotlin WebView 壳 + JNI 嵌入 Node 运行时（flun fork，Node v22.23.2）**，
  生命周期与前台服务由 Kotlin 层自管

---

## 1. 总体架构

```
┌────────────────────────── DeepThink.apk ──────────────────────────┐
│  Kotlin 壳（现有，复用）                                            │
│  ├─ MainActivity / WebView（连 http://127.0.0.1:9898）              │
│  ├─ ServerDiscovery（发现状态机，复用）                              │
│  ├─ RuntimeHost（新增）── JNI ──► libnode.so（Node v22.23.2）       │
│  │     生命周期 Idle→Starting→Running→Exited/Failed                 │
│  ├─ DeepThinkService（新增）Foreground Service + 常驻通知            │
│  └─ PortManager（新增）端口检测 / 残留实例清理                       │
│                                                                     │
│  assets/                                                            │
│  ├─ backend/ web-dist/ agent-runner/ config/  （五件套）             │
│  ├─ node_modules/（生产依赖，交叉编译 .node）                        │
│  ├─ claude-cli/（patchelf 后的 glibc ELF）                          │
│  └─ glibc/（ld-linux-aarch64.so.1 + libc 等 loader 所需库）          │
└─────────────────────────────────────────────────────────────────────┘
        │ spawn 链（F3，spike 定型）
        ▼
  agent-runner（node）──► @anthropic-ai/claude-agent-sdk ──► claude（glibc ELF，patchelf）
```

数据目录（App 私有存储，映射桌面版环境变量）：

| 环境变量 | App 内路径 |
|---|---|
| `DEEPTHINK_HOME` | `/data/data/<pkg>/files/deepthink`（代码资产，启动时从 assets 释放） |
| `DEEPTHINK_DATA_DIR` | `/data/data/<pkg>/files/.deepthink/data`（DB/群组/IPC/密钥） |
| `DEEPTHINK_WEB_DIST_DIR` | `$DEEPTHINK_HOME/web-dist` |
| `DEEPTHINK_AGENT_RUNNER_DIR` | `$DEEPTHINK_HOME/agent-runner` |

> 首启从 assets 释放五件套到 files/（压缩存储，释放耗时 <5s；后续版本如 assets 未变化跳过）。
> 备选：直接在 assets 上以只读 FD 方案运行——因 npm 需要 node_modules 可写目录，放弃，统一释放。

## 2. 运行时选型与来源

**选定**：flun fork 的 nodejs-mobile（`@flun/nodejs-mobile-react-native` v2.1.4，内嵌 **Node v22.23.2**）。

关键问题：该 npm 包是 React Native 插件，而我们用 Kotlin 壳。取用其底层运行时的两条途径
（M0 spike 确认走哪条）：

- **路径 i**：其 `android/` 产物里直接含 `libnode.so` + JNI 头（nodejs-mobile 原生层），剥离 RN
  壳后由我们的 JNI 封装（`RuntimeHost`）直接调用 `JNI_OnLoad` / `node::Start` 风格入口；
- **路径 ii**：flun 的 nodejs-mobile fork 仓库发布独立 android 预编译（AAR / binaries），
  直接依赖 AAR。

两者都要过 spike S1。**版本锁定**：构建期固定确切版本（不带 `^`），`.node` 交叉编译所用
Node headers 必须与运行时同源同版本（Node 22 ABI = 127），否则 better-sqlite3 加载段错误。

**为什么不用另外两条路**（核验记录）：
- `@flun/node-mobile-app`（RN 壳 CLI）：壳被替换，丢掉现有 Kotlin 发现状态机/设置页/远程模式，
  且前台服务仍需自己补；弃（壳策略已拍板保留 Kotlin）。
- Capacitor 路线：`capacitor-nodejs` 停更（2022，0.0.1），无维护；弃。

## 3. Kotlin 层新增模块

### 3.1 RuntimeHost（JNI 封装 + 状态机）

```kotlin
sealed class RuntimeState { object Idle; object Starting; data class Running(val port: Int); data class Failed(val reason: String, val logTail: String) }
```

- `start()`：释放 assets（如需）→ 设置 `DEEPTHINK_*` 环境 → JNI 启动 libnode 执行
  `backend/index.js`（工作目录 `$DEEPTHINK_HOME`）→ 轮询健康检查直至 `Running`；
- `stop()`：先发优雅退出（复用后端 shutdown 钩子）→ 5s 后强制结束；
- 健康判定与 shell 端一致：`GET /api/health` 200 + `"status":"healthy|ok"`（`lib.sh` 同款判定）；
- 启动日志环形缓冲（≤256KB），`Failed` 时展示尾部；
- 幂等：重复 `start()` 且已 `Running` 直接返回。

### 3.2 DeepThinkService（Foreground Service）

- `startForeground()` + 常驻通知（文案含状态：运行中/启动中/异常）；
- Service 与 RuntimeHost 同生命周期；App 划掉（onTaskRemoved）→ stopSelf + RuntimeHost.stop()；
- 退后台/锁屏服务存活是 F2 验收硬指标；MIUI/HyperOS 需配合「自启动」引导提示（一次性提示条）。

### 3.3 PortManager

- 启动前探测目标端口：若被**本应用残留实例**占用 → 清理后复用；被其他应用占用 →
  `Failed` + 错误页给出改端口入口（设置页已有端口/区间配置，复用）；
- 端口范围沿用壳的发现区间（9898，9890–9900）。

## 4. 资产布局与释放

`assets/runtime/` 下打包 `runtime.tar.zst`（五件套 + node_modules 瘦身版），首启释放到
`files/deepthink/`。释放策略：指纹文件（构建期写入 assets 版本 hash）比对，一致则跳过——
覆盖升级后资产更新会重放释放，但**绝不触碰 `files/.deepthink/data`**（与 install.sh 的
"代码覆盖、数据不动"同语义）。

## 5. spawn 链方案（F3，最大风险，S1 定型）

后端需要：`spawn('node', [agent-runner])`、PTY worker（`node dist/pty-worker.cjs`）、
`execFile('claude', ['--print'])`。libnode 是 **.so**，PATH 里没有 `node` 二进制。候选：

| 方案 | 做法 | 优点 | 缺点 |
|---|---|---|---|
| A. node 启动器 ELF | 打包一个 `node` 可执行文件（nodejs-mobile 构建树里的 `node_main` 独立可执行体，或自编 20 行 C `dlopen(libnode)→node::Start`），放入 `files/` 并加入 PATH | **零业务代码改动**，桌面/手机同一条执行链 | 需验证 libnode 能否以 executable 模式二次初始化；进程数多 |
| B. in-process agent-runner | agent-runner 改为模块导出，后端 `require()` 在线程/worker_threads 里跑 | 无 spawn，最省资源 | **侵入业务代码**（违背"不需要改业务代码"结论）；SDK 的子进程假设要重验 |
| C. flun 运行时自带桥 | 用 flun RN 插件的 spawn 能力（其 nodejs-mobile 对 fork/spawn 有支持） | 现成 | 依赖 RN 壳，与壳决策冲突 |

**决策倾向：A**（零侵入，与桌面版行为一致），S1 验证不过再退 B。
`execFile('claude')` 不受影响：那是 glibc ELF 启动问题（§6），与 node 启动器无关。

## 6. claude CLI glibc 兼容（F4）

构建期（开发机）执行，复用 android-on-device 配方：

1. 从 `@anthropic-ai/claude-code` linux-arm64 平台包取 `claude` ELF；
2. `patchelf --set-interpreter <assets/glibc/ld-linux-aarch64.so.1>`；
3. APK 内打包 glibc loader + 依赖库（`libc.so`/`libm.so`/`libdl.so`/`libpthread` 等，
   取自 Termux `glibc-repo` 同源包或 manylinux aarch64 sysroot）；
4. 运行期以 `LD_PRELOAD=''` 启动（防 libtermux-exec 类预载干扰，同 install.sh 注释）。

已知风险（R2）：个别机型 seccomp 拒绝（`Bad system call`）——降级为清晰错误 + 文档指引，
不阻塞其余功能。

## 7. better-sqlite3 交叉编译（F5）

- 工具链：Android NDK（r26+）+ CMake/Makefile 走 node-gyp，`--arch=arm64 --target_arch=arm64`；
- Node headers：从 flun 运行时同版本源码树取 `include/node`（Node 22.23.2，ABI 127）；
- 产物 `better_sqlite3.node` 放入 `assets/runtime` 的 node_modules 对应目录；
- 构建自检：`llvm-readelf -h` 确认 AArch64 + ELF；真机 `require` 自检（PRD TC-F5-02）。

## 8. 构建管线（F9）

`make android-apk` 串联（Windows Git Bash 可跑）：

```
1. make build                        # 后端 + 前端 + agent-runner（现有）
2. scripts/build-android-apk-assets.sh
   ├─ 组装五件套 → staging（复用 build-android-payload.sh 布局）
   ├─ npm install --omit=dev（linux-arm64 target）+ 六阶段瘦身
   ├─ 交叉编译 better-sqlite3（NDK）
   ├─ patchelf claude CLI + 收集 glibc loader
   ├─ 下载/定位 libnode 运行时（版本锁定）
   └─ 打包 runtime.tar.zst → android/app/src/main/assets/runtime/
3. cd android && ./gradlew :app:assembleRelease   # JAVA_HOME=Android Studio JBR
4. scripts/check-android-apk.sh                   # assets 清单校验 + versionCode 单调性
```

**versionCode 规则**（吸取 2026-11-06 INSTALL_FAILED_VERSION_DOWNGRADE 教训）：
`versionCode = <major>*10000 + <minor>*100 + <patch>`（与 package.json 对齐），构建脚本比对
上一 release 记录（`android/version-history.json`）拒绝回退。禁止时间戳 versionCode。

## 9. Spike 计划（M0，先于一切实现）

| # | 目标 | 方法 | 通过判据 |
|---|---|---|---|
| S1 | spawn 链可行性 | 最小 demo：libnode 内跑 `child_process.spawn('node', ['-e','console.log(1)'])`，试方案 A 启动器 | 子进程启动成功、退出码回传 |
| S2 | claude CLI glibc 打包可执行 | patchelf 后放进测试 APK，真机跑 `--version` | 正常输出版本号 |
| S3 | MIUI 保活 | 前台服务 demo 灭屏 1h | 进程存活 + 端口可达 |
| S4 | better-sqlite3 交叉编译 | NDK 编译 + 真机 `require` 自检 | 建表写读通过 |

S1/S2 是**门禁**（PRD §5）：任一失败 → 回炉 PRD（退方案 B 或调整范围），不带病进实现。

## 10. 与现有代码的接口面

- **零改动承诺区**：`src/`（后端业务）、`container/agent-runner/`、`web/` —— 前提是 spawn 方案 A 成立；
  若 spike 强制走方案 B，改动收敛在 agent-runner 入口的模块化封装（`index.ts` 增加导出形态）；
- **复用**：Kotlin 壳全部现有页面/发现状态机/设置页；`lib.sh` 健康判定语义；
  android-on-device 的 patchelf 配方；
- **新增**：`android/app/src/main/java/.../runtime/`（RuntimeHost/State/Service/PortManager）、
  `scripts/build-android-apk-assets.sh`、`scripts/check-android-apk.sh`、`make android-apk`。

## 11. 替代方案对比（决策留档）

| 方案 | 结论 | 理由 |
|---|---|---|
| flun RN 壳全量（@flun/node-mobile-app） | 弃 | 换壳丢现有 Kotlin 能力；前台服务/spawn 仍需自补 |
| Capacitor + nodejs 插件 | 弃 | capacitor-nodejs 停更 4 年 |
| aosp-node-bridge | 不存在 | npm/Maven 均查无（参考文幻觉） |
| 继续 Termux 路线作主形态 | 弃 | 真机实测用户不可接受（本需求动因） |
| 维持远程 server 形态 | 保留为副形态 | 壳的远程模式继续可用，不是本需求范围 |

## 12. 风险对照

见 PRD §5（R1–R6）。本方案对每条风险给出对策与 spike 编号；R1/R2 门禁不过即回炉。
