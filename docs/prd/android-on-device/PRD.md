# PRD：DeepThink 端上自治运行（Android 本地部署，Phase 0+1）

- 需求代号：`android-on-device`
- 版本：v1.0（2026-11-04）
- 状态：已评审立项（落地范围：Phase 0+1 全量，含 Kotlin 壳 app 源码入库；Phase 2 嵌入式路线不在本期）
- 前置研究：《Android APK 端上自治运行可行性研究》（2026-11-04，本会话产出，结论：可行；Termux 路线起步，nodejs-mobile 嵌入式因 Node 18 卡点列为后续）

---

## 1. 背景与问题

当前 Android 应用（`android/build/outputs/DeepThink-1.0.0-release.apk`）是一个纯 WebView 壳：
用户必须先部署一个远程 DeepThink server，在 app 里手动填 server URL 才能使用。
这带来三个问题：

1. **部署门槛高**：非技术用户无法拥有"自己的 DeepThink"，必须依赖企业/他人部署的 server。
2. **强依赖网络与 server 存活**：server 不可达即完全不可用。
3. **数据不在端上**：对话、记忆、文件都留在 server 侧。

研究结论（已验证）：
- DeepThink 后端是**单进程 Node 服务**，自己 serve 前端 + API + WebSocket，4 个 `DEEPTHINK_*`
  环境变量可覆盖全部关键路径——整体搬到端上**不需要改业务代码**（桌面版 Electron 已验证同一模式）。
- **无 Docker 是一级路径**：host 执行模式自动降级，对话 / 文件 / 定时任务 / 记忆 / IM 全功能保留；
  仅沙箱代码执行、浏览器自动化、Web 终端三项降级，且失败被隔离、不崩进程。
- Claude Code（agent 运行时内核）已被社区在真机原生跑通（claude-code-android，Pixel 10 Pro /
  Galaxy S26 Ultra 等实测，含多 Agent 工作流）；glibc 兼容机制（`glibc-repo` + `patchelf-glibc`
  重写 ELF interpreter）有成熟方案可复用。

**注意**："不连 server URL" ≠ 离线。Agent 推理仍走云端 LLM API。本需求实现的是
**DeepThink 平台后端跑在手机里**（数据端上自治、无自建 server 依赖）。

## 2. 目标与非目标

### 2.1 目标

用户在一部 arm64 Android 手机上：
1. 安装 Termux + 一键安装脚本，把 DeepThink 运行时完整装进手机；
2. 安装 DeepThink Android app（壳），app **自动发现并连接本机服务**，无需填任何 URL；
3. 离开局域网/互联网（LLM API 除外）后，平台功能照常：对话（含流式）、文件、记忆、
   定时任务、Skills、多 Agent 编排等全部跑在本机。

### 2.2 非目标（本期不做）

| 非目标 | 原因 |
|---|---|
| Phase 2 nodejs-mobile 嵌入式 APK（双击即用、上架分发） | nodejs-mobile release 停在 Node 18，跑不动 Node ≥22 的后端/CLI；需自维护 Node fork，单列后续需求 |
| Docker 沙箱（`sandbox_run_code` / `sandbox_browser_*`）在端上可用 | Android 无 Docker；本期以降级提示兜底 |
| Web 终端（绑定 `docker exec`） | 同上，降级提示兜底 |
| 端侧本地 LLM（真·离线） | 能力差距大，单列研究课题 |
| iOS | 另立需求 |
| Google Play 上架 | 打包执行代码违反 Play 政策；本期为企业侧载/自有渠道分发 |

## 3. 术语

| 术语 | 含义 |
|---|---|
| 五件套 | 后端 `dist/` + 前端 `web/dist/` + agent-runner（dist/prompts/package.json）+ 根生产依赖 + 配置模板，DeepThink 运行所需的最小资产集（与桌面版 extraResources 对齐） |
| payload | 由 `make android-payload` 打出的运行时压缩包，侧载到手机供安装脚本解包 |
| 本地模式 | app 连接 `127.0.0.1` 上的本机 DeepThink 服务（对比"远程模式"=手动填 server URL） |
| glibc 兼容 | Android bionic 无法直接执行 glibc ELF；通过 `patchelf` 重写 interpreter 到 Termux glibc 包提供的 `ld-linux-aarch64.so.1` 使其可运行 |

## 4. 功能需求

> 每个功能点含：需求描述 → 验收标准（AC）→ 测试用例（TC）。
> TC 标记 `[自动化]` 的纳入 CI/本地脚本可重复执行；`[真机]` 的需在 Android 设备人工验收
> （本迭代开发机为 Windows，无法执行真机项，测试报告中如实标注）。

---

### F1 一键安装脚本（Termux）

**描述**：`android/termux/install.sh`，在 Termux 内一键完成 DeepThink 运行时安装：
检测环境 → 安装系统依赖 → 解包 payload → 安装 npm 依赖（含 better-sqlite3 设备端编译）→
glibc 兼容处理（patchelf claude CLI）→ 生成启动脚本与数据目录 → 自检。

AC：
1. 在 Termux（arm64，Android 8+）中执行 `bash install.sh` 可无人值守完成安装；
2. 依赖安装包含：`nodejs`（≥22）、`clang`、`make`、`python`、`glibc-repo`、`glibc-runner`、
   `patchelf-glibc`（后三者用于 claude CLI glibc 兼容），缺失自动 `pkg install`；
3. `npm` 安装后 `better_sqlite3.node` 为设备端编译产物且可被 Node 加载（脚本内置加载自检）；
4. 所有落盘的 `claude` CLI 二进制（`@anthropic-ai/claude-code` bin 与
   `@anthropic-ai/claude-agent-sdk-{platform}` 平台包）经 patchelf 处理，`--version` 可执行；
5. 安装目录、数据目录均为 Termux 私有目录（`~/deepthink`、`~/.deepthink/data`），
   不写共享存储；安装脚本本身幂等（重复执行=升级/修复，不破坏数据）；
6. 任一步失败即中止并输出可定位的错误信息（步骤名 + 原因 + 建议命令），不留半成品状态。

TC：
| 编号 | 用例 | 类型 |
|---|---|---|
| TC-F1-01 | `bash -n install.sh`（及全部脚本）语法检查通过 | [自动化] |
| TC-F1-02 | shellcheck 全脚本 0 error（warning 可容忍） | [自动化]（无 shellcheck 环境则跳过并记录） |
| TC-F1-03 | 纯函数单测：URL/路径/版本比较等辅助函数（如抽出为 `lib.sh`）vitest/bash 断言 | [自动化] |
| TC-F1-04 | Termux 全新设备：install.sh 一次跑通，自检步骤全绿 | [真机] |
| TC-F1-05 | install.sh 重复执行（幂等）：第二次运行不报错、数据不丢 | [真机] |
| TC-F1-06 | better-sqlite3 加载自检通过（脚本内 `node -e "require('better-sqlite3')"`） | [真机]（自动化部分：脚本含该自检逻辑） |
| TC-F1-07 | patchelf 后 `claude --version` 正常输出版本号 | [真机]（自动化部分：脚本含该自检逻辑） |

---

### F2 运行时启停与守护（Termux）

**描述**：`android/termux/` 下 `start.sh` / `stop.sh` / `status.sh`：
启动后端（`node dist/index.js`，`DEEPTHINK_DATA_DIR=~/.deepthink/data`，端口默认 9898）、
wake-lock 防休眠、健康检查等待就绪、日志落盘、优雅停止。

AC：
1. `start.sh`：后台启动后端，`/api/health` 返回 200 后打印访问地址（`http://127.0.0.1:9898`）；
2. 启动即持有 `termux-wake-lock`（无 termux-api 时告警但不失败）；
3. `status.sh` 输出：进程存活、端口监听、health JSON、日志尾部；
4. `stop.sh` 优雅停止（SIGTERM→超时 SIGKILL），释放 wake-lock，可再次 start；
5. 端口可通过 `DEEPTHINK_WEB_PORT` / `WEB_PORT` 覆盖；
6. 后端进程崩溃退出时日志留存可诊断（`~/.deepthink/logs/backend.log`）。

TC：
| 编号 | 用例 | 类型 |
|---|---|---|
| TC-F2-01 | 脚本语法检查（`bash -n`）通过 | [自动化] |
| TC-F2-02 | 启动/停止/状态三脚本在 Linux bash（Git Bash / CI 容器）下以 mock node 可跑通主流程（若实现可注入 `DEEPTHINK_NODE_BIN`） | [自动化]（尽力，不可行则并入真机项） |
| TC-F2-03 | start 后 health 200；stop 后端口释放；再 start 成功 | [真机] |
| TC-F2-04 | `WEB_PORT=9900 start.sh` 后 9900 可访问 | [真机] |

---

### F3 运行时打包管线（`make android-payload`）

**描述**：新增 `scripts/build-android-payload.sh` 与 Makefile 目标 `android-payload`：
把五件套（不含 node_modules——由设备端 npm 安装，减小分发体积）打成
`dist-android/deepthink-android-payload-<version>.tar.gz` + SHA256 校验文件。

AC：
1. 产物包含：`backend/`（dist/ + copy-runtime-assets 产物）、`web-dist/`、`agent-runner/`
   （dist + prompts + package.json）、根 `package.json` + `package-lock.json`、
   `config/` 模板（default-groups / mount-allowlist / global-claude-md.template.md）、
   `container/skills/`、`android/termux/` 安装脚本、`PAYLOAD-MANIFEST.txt`（文件清单+版本）；
2. 不含：`node_modules/`、`data/`、`.git`、源码 TS、测试；
3. 构建产物缺失（未 `make build`）时报错并指明修复命令，不产出残包；
4. 产出 `.tar.gz` + `.sha256`；重复执行可覆盖旧版本；
5. 体积目标 < 60MB（web/dist 27MB 为主要构成；不含 node_modules）。

TC：
| 编号 | 用例 | 类型 |
|---|---|---|
| TC-F3-01 | `make android-payload` 在本机执行成功，产出 tar.gz + sha256 | [自动化] |
| TC-F3-02 | 解包清单断言：必含项全在、禁止项（node_modules/data/.git）全无（脚本校验或 vitest 驱动） | [自动化] |
| TC-F3-03 | 故意缺 `web/dist` 时脚本报错退出非 0 | [自动化] |
| TC-F3-04 | sha256 校验一致 | [自动化] |

---

### F4 Android 壳 app（Kotlin 源码入库）

**描述**：在 `android/app/` 新建完整 Android 工程（Kotlin，minSdk 26，targetSdk 35），
替代无源码旧壳。核心能力：

**F4a 本地服务自动发现**：app 启动（及"重试"）时探测本地服务，命中即免配置进入：
- 探测序列：`http://127.0.0.1:<port>/api/health`，端口候选 = 用户配置端口（默认 9898）
  + 顺序探测区间（默认 9890–9900，可配置关闭）；
- 命中判定：HTTP 200 且 JSON `status == "healthy"`（容忍 `healthy`/`ok`）；
- 发现阶段 UI 显示进度；全部未命中进入 F4b 引导页。

**F4b 连接引导页**：未发现服务时展示：Termux 安装/启动步骤摘要、"重新探测"按钮、
"手动配置服务器"入口（F4c）。**不出现任何要求用户填写 URL 的强制步骤**。

**F4c 服务器设置（兼容远程）**：保留旧壳能力——手动输入 server URL（http/https）、
本地/远程模式切换、连接测试按钮、配置持久化（SharedPreferences）。远程 URL 输入仍为
可选路径，用于连企业部署的 server。

**F4d 本地模式降级提示**：本地模式连接成功后，在导航/菜单内展示一次性提示条：
"本地模式：沙箱代码执行、浏览器自动化、Web 终端暂不可用（依赖 Docker），其余功能完整"，
可关闭并记住。

**F4e WebView 运行时**：JS/DOM/LocalStorage/IndexedDB 启用；`http://127.0.0.1` 明文放行
（`usesCleartextTraffic` 仅限 loopback 用途说明）；后退键=页面历史后退；下拉刷新；
加载失败（服务中途挂掉）显示错误页 + 重试。

AC：
1. `./gradlew assembleRelease` 产出可安装 APK；`./gradlew test` JVM 单测全绿；
2. 冷启动 →（本机服务运行中）≤ 3s 进入 DeepThink 界面，全程零输入；
3. 服务未运行时进入引导页，不闪退、不白屏、不强制填 URL；
4. 端口非默认（如 9900）且在探测区间内时可自动发现；
5. 手动远程 URL 模式可连接远程 server（回归旧壳能力）；
6. 降级提示在本地模式下出现一次且可关闭。

TC：
| 编号 | 用例 | 类型 |
|---|---|---|
| TC-F4-01 | `./gradlew assembleRelease` 构建成功产出 APK | [自动化] |
| TC-F4-02 | JVM 单测：健康探测判定函数（200+healthy / 200+bad / 非 200 / 超时 / 非 JSON） | [自动化] |
| TC-F4-03 | JVM 单测：端口候选序列生成（默认、自定义、区间关闭） | [自动化] |
| TC-F4-04 | JVM 单测：server URL 规范化（补协议、去尾斜杠、非法输入拒绝）——与旧壳 `normalizeServerUrl` 行为对齐 | [自动化] |
| TC-F4-05 | 真机/模拟器：服务运行中冷启动自动进入界面（零输入） | [真机] |
| TC-F4-06 | 真机：服务未运行 → 引导页 → Termux 启动服务 → 点"重新探测" → 进入界面 | [真机] |
| TC-F4-07 | 真机：本地模式降级提示出现、关闭后不再出现 | [真机] |
| TC-F4-08 | 真机：手动填远程 URL 连接远程 server 成功 | [真机] |

---

### F5 打包修正：pty-worker 运行时资产

**描述**：修复 `src/pty-worker.cjs` 在打包部署（desktop extraResources / Android payload）中
丢失的问题：`terminal-manager.ts` 的 `PTY_WORKER_PATH` 当前解析 `dist/../src/pty-worker.cjs`，
打包后 `src/` 不存在 → PTY 静默降级 pipe 模式。改为 `__dirname` 同级解析并把
`pty-worker.cjs` 登记进 `scripts/copy-runtime-assets.cjs`（同类事故见
`docs/issues/2026-09-29-eval-center-schema-asset-missing.md`）。

AC：
1. `npm run build` 后 `dist/pty-worker.cjs` 存在；
2. dev（tsx 直跑 src/）与 prod（node dist/）两种形态 `PTY_WORKER_PATH` 均指向存在的文件；
3. `copy-runtime-assets.cjs` 缺源文件时仍保持"报错退出非 0"的既有防御行为。

TC：
| 编号 | 用例 | 类型 |
|---|---|---|
| TC-F5-01 | vitest：调用 copy-runtime-assets 脚本到临时目录，断言 `pty-worker.cjs` 与 `eval-schema.sql` 均被复制 | [自动化] |
| TC-F5-02 | vitest：PTY_WORKER_PATH 解析逻辑在 src/ 与 dist/ 两种布局下命中文件（抽出纯函数或路径断言） | [自动化] |
| TC-F5-03 | 全量 `make test` 无新增失败（对照 Windows 基线 15 个环境失败） | [自动化] |

---

### F6 文档：手机端安装手册

**描述**：`android/README.md`：从零到可用的完整手册——前置条件、payload 获取/自建、
Termux 安装步骤、app 安装、首次运行、常见故障（claude CLI 不可执行、better-sqlite3
编译失败、端口占用、后台被杀）、卸载、安全须知（API key 落端上）。

AC：
1. 手册步骤与 install.sh / start.sh 实际行为一致（逐条核对）；
2. 含故障排查表（症状 → 原因 → 命令）；
3. 明确安全边界与"不连 server ≠ 离线"的概念澄清。

TC：
| 编号 | 用例 | 类型 |
|---|---|---|
| TC-F6-01 | 文档评审：步骤与脚本行为逐条一致性检查 | [自动化]（评审记录于测试报告） |

---

## 5. 非功能需求

| 项 | 要求 |
|---|---|
| 兼容性 | arm64 Android 8+（与 claude-code-android 生态一致）；x86_64 模拟器尽力支持、不承诺 |
| 体积 | payload < 60MB；设备端安装后（含 npm 依赖与 claude CLI）约 1.5–2.5GB，README 中给出磁盘余量要求 |
| 性能 | 旗舰机（8GB RAM）可流畅跑单 Agent 会话；README 给出推荐配置，低端机不承诺 |
| 安全 | 数据全部落 Termux/app 私有目录；API key 仅存 `data/env`（只读挂载语义不变）；README 提示设置 Claude API 用量告警 |
| 可观测 | backend.log + status.sh；app 侧连接状态可视 |
| 兼容回归 | 现有桌面版/服务器版行为不变（pty-worker 修复对两种形态均为增强） |

## 6. 里程碑

| 里程碑 | 内容 | 验收 |
|---|---|---|
| M1 方案 | PRD + 技术方案评审通过 | 本文档 + tech_solution |
| M2 后端修正 | F5 + 自动化测试 | TC-F5-01/02/03 |
| M3 脚本与管线 | F1/F2/F3 + 自动化测试 | TC-F1-01/02、TC-F2-01、TC-F3-01~04 |
| M4 壳 app | F4 源码 + 构建 + JVM 单测 | TC-F4-01~04 |
| M5 文档与报告 | F6 + 测试报告（含真机待验清单） | TC-F6-01；真机项列为遗留验收项 |

## 7. 风险与依赖

| 风险 | 缓解 |
|---|---|
| claude CLI glibc 兼容在部分机型失败（claude-code-android 有 Android 8/10 `Bad system call` 前科） | install.sh 自检 + README 故障表；最低支持线 Android 8（arm64），失败机型指向 pinned 旧版 CLI 方案（Phase 0.5 备选，不在本期实现） |
| better-sqlite3 / node-pty 设备端编译失败 | 自检步骤前置；node-pty 失败允许降级（终端本就依赖 Docker 不可用），脚本以 `--ignore-scripts` + 定向 rebuild 兜底 |
| Termux 后台进程被系统杀 | wake-lock + README 引导关闭电池优化；数据不丢（SQLite WAL），重启即恢复 |
| 真机验收无法在开发机执行 | 测试报告中真机项逐条列"待人工验收"清单，不冒充已验证 |

## 8. 验收总则

1. 全部 [自动化] TC 通过，`make test` 无新增失败（对照 Windows 基线）；
2. 构建出的 APK 可安装（本机 build 验证 + 签名说明）；
3. [真机] TC 形成可逐条执行的验收清单，交付后在真实设备执行并回填测试报告；
4. 任何"已验证"结论必须附命令输出/构建日志；未验证的一律标注"待人工验收"。
