# 技术方案：DeepThink 端上自治运行（android-on-device，Phase 0+1）

- 需求 PRD：[`docs/prd/android-on-device/PRD.md`](../../prd/android-on-device/PRD.md)
- 版本：v1.0（2026-11-04）
- 技术路线：**Termux 宿主运行后端 + Kotlin WebView 壳 app 自动发现本地服务**
  （nodejs-mobile 嵌入式 = Phase 2，不在本方案）

---

## 1. 总体架构

```
┌─────────────────────────── Android 手机 ───────────────────────────┐
│                                                                    │
│  DeepThink App（Kotlin WebView 壳）                                 │
│    ├─ ServerDiscovery：探测 127.0.0.1:{9898 + 9890-9900}/api/health │
│    ├─ 命中 → WebView loadUrl(http://127.0.0.1:<port>)  ← 零配置     │
│    ├─ 未命中 → 引导页（Termux 启动指引 + 重试 + 手动远程 URL 入口）  │
│    └─ 本地模式降级提示条（沙箱/浏览器/终端不可用，可关闭）           │
│              │ loopback HTTP + WebSocket                            │
│              ▼                                                     │
│  Termux (~)                                                        │
│    ~/deepthink/            ← payload 解包目录（代码资产）           │
│      backend/              ← dist/（含 pty-worker.cjs）             │
│      web-dist/             ← web/dist/                              │
│      agent-runner/         ← dist + prompts + package.json          │
│      node_modules/         ← 设备端 npm install --omit=dev          │
│      config/               ← default-groups 等模板                  │
│      termux/               ← install/start/stop/status.sh           │
│    ~/.deepthink/data/      ← DEEPTHINK_DATA_DIR（DB/群组/IPC/密钥）  │
│    ~/.deepthink/logs/backend.log                                   │
│              │ spawn(node, backend/index.js)（host 执行模式）        │
│              ▼                                                     │
│    agent-runner → claude CLI（patchelf 后的 glibc binary）→ LLM API │
└────────────────────────────────────────────────────────────────────┘
```

核心论据（均已在可行性研究中以代码证据确认）：
- 后端单进程 serve API + 前端 + WS（`src/web.ts`），前端无需独立部署；
- 路径全部 `DEEPTHINK_*` env 可覆盖（与桌面版 `BackendSupervisor` 同一模式）；
- 无 Docker 时 host 执行模式是一级路径（`src/index.ts:2110` 自动降级），
  仅 sandbox_* / Web 终端 / container 模式降级，失败被隔离。

## 2. 设备端目录与环境变量

`start.sh` 注入（对齐 `desktop/src/backend-supervisor.ts` 的 buildEnv）：

```bash
export DEEPTHINK_DATA_DIR="$HOME/.deepthink/data"
export DEEPTHINK_WEB_DIST_DIR="$HOME/deepthink/web-dist"
export DEEPTHINK_AGENT_RUNNER_DIR="$HOME/deepthink/agent-runner"
export NODE_ENV=production
export WEB_PORT="${WEB_PORT:-9898}"
export HOME="$HOME"   # Termux 私有目录；~/.claude、~/.claude.json 依赖它可写
cd "$HOME/deepthink"  # PROJECT_ROOT=process.cwd() → config/ 模板在 ./config/
```

**为什么 payload 不带 node_modules**：五件套里 node_modules 占 ~1.5GB，设备端
`npm install`（约 10 分钟）远优于分发 1.5GB 压缩包（payload 目标 < 60MB）。
根目录**无 package-lock.json**（与 agent-runner 无 lock 的既定策略一致），
安装用 `npm install --omit=dev`；agent-runner 用 `npm install`（保持 "*" 拉最新 SDK）。

## 3. 后端改动（F5，唯一的代码修改）

**问题**：`src/terminal-manager.ts:16` `PTY_WORKER_PATH = __dirname/../src/pty-worker.cjs`
——打包部署（desktop extraResources / android payload）只含 `dist/`，`src/` 不存在，
PTY 静默降级 pipe 模式。与 `eval-schema.sql` 同类（`copy-runtime-assets.cjs` 的存在意义）。

**改法**（两处，共 ~5 行）：

```diff
# scripts/copy-runtime-assets.cjs
-const ASSETS = ['eval-center/eval-schema.sql'];
+const ASSETS = ['eval-center/eval-schema.sql', 'pty-worker.cjs'];
+# ROOT 可被 RUNTIME_ASSETS_ROOT 覆盖（测试用），默认行为不变
```

```diff
# src/terminal-manager.ts
-const PTY_WORKER_PATH = path.resolve(__dirname, '..', 'src', 'pty-worker.cjs');
+# dev（tsx 直跑 src/）与 prod（node dist/）同构：worker 与入口同级
+const PTY_WORKER_PATH = path.resolve(__dirname, 'pty-worker.cjs');
```

dev 形态 `__dirname=src/` → `src/pty-worker.cjs`（原位置）；prod 形态 `__dirname=dist/`
→ `dist/pty-worker.cjs`（copy 脚本产出）；desktop 打包 `resources/backend/` 同理成立。
desktop 对 `src/` 的依赖彻底移除，与 Android payload 复用同一产物。

## 4. payload 管线（F3）

`scripts/build-android-payload.sh`（bash，Git Bash/WSL/Linux/macOS 可跑）+
Makefile 目标 `android-payload`：

1. **预检**：`dist/index.js`、`dist/pty-worker.cjs`、`web/dist/index.html`、
   `container/agent-runner/dist/index.js`、`container/agent-runner/package.json`、
   `container/agent-runner/prompts/`、`config/`、`container/skills/`、`android/termux/`
   ——缺一即报错退出（提示 `make build` / `make sync-types`），不产残包；
2. **staging** 布局（解包后即设备端 `~/deepthink/` 终态布局）：

```
deepthink/
  backend/          ← dist/*（js + pty-worker.cjs + eval-schema.sql）
  web-dist/         ← web/dist/*
  agent-runner/     ← dist/ prompts/ package.json
  package.json      ← 根 package.json（设备端 npm install --omit=dev 用）
  config/           ← default-groups.json mount-allowlist.json
                      global-claude-md.template.md plugin-deps-override.json harness/
  container/skills/ ← 项目级 Skills
  termux/           ← install.sh start.sh stop.sh status.sh lib.sh
  PAYLOAD-MANIFEST.txt   ← 文件清单 + 版本 + 构建时间
```

3. `tar -czf dist-android/deepthink-android-payload-<version>.tar.gz` + `.sha256`；
4. `scripts/check-android-payload.sh <tar.gz>`：断言必含项全在、禁含项
   （`node_modules/`、`data/`、`.git/`、`*.ts`）全无 —— 供 TC-F3-02 自动化。

## 5. Termux 脚本（F1/F2）

### 5.1 install.sh 流程

```
preflight（Termux/ aarch64 / 磁盘 ≥3GB / node 版本）
 → pkg install nodejs clang make python git glibc-repo
 → apt update && pkg install glibc-runner patchelf-glibc
 → 解包 payload → ~/deepthink（幂等：data/ 不动，代码覆盖）
 → npm install --omit=dev（根）＋ npm install（agent-runner）
 → native 自检：node -e "require('better-sqlite3')"，失败 → npm rebuild better-sqlite3 再检
   （整装失败兜底：npm install --ignore-scripts + 定向 rebuild better-sqlite3，
    接受 node-pty 缺失——终端在 Android 本就不可用）
 → claude CLI glibc 兼容（见 5.2）
 → 写 ~/.claude/settings.json（autoUpdates:false，清 LD_PRELOAD 残留）
 → 生成 ~/deepthink/.env.sh 与 bin/ 脚本 → 自检汇总（逐项 ✅/❌ + 修复建议）
```

幂等语义：重复执行 = 升级/修复；`~/.deepthink/data` 永不触碰。

### 5.2 claude CLI glibc 兼容（关键技术，配方来自 claude-code-android）

npm 装出的 `claude` 是 **glibc linux-arm64 ELF**，bionic 不能直接 exec。处理：

```bash
PATCHELF="$PREFIX/glibc/bin/patchelf"
GLIBC_LD="$PREFIX/glibc/lib/ld-linux-aarch64.so.1"
# 对每个落盘的 claude ELF（@anthropic-ai/claude-code/bin/claude、
# @anthropic-ai/claude-agent-sdk-*/claude，根与 agent-runner 两处 node_modules）：
LD_PRELOAD='' "$PATCHELF" --set-interpreter "$GLIBC_LD" "$BIN"
# 冒烟（--init-only 引导完整运行时后退出）：
HOME="$TMP_HOME" LD_PRELOAD='' timeout 45 "$BIN" --init-only
```

- `LD_PRELOAD=''` 必须清空：Termux 的 libtermux-exec 预载会让 glibc 二进制误解析 libc
  （claude-code-android 实测结论）；同理 `~/.claude/settings.json` 不留 `env.LD_PRELOAD`。
- agent-runner 的 CLI 解析链（`container/agent-runner/src/index.ts:1734-1786`）：
  Linux 走 `which claude` → 常见路径 → 兜底 `resolveBundledClaudeCli()`（解析
  `@anthropic-ai/claude-code` 的 bin，`isRealExecutable` 认 ELF 魔数）→ SDK 平台包。
  **patchelf 不破坏 ELF 魔数**，既有解析链零改动全部生效。
- 冒烟失败分流（对齐 claude-code-android 的已知问题）：
  - `Bad system call` / Bun crash / SIGSYS → 机型不兼容（Android 8/10 seccomp 前科），
    报告用户并指向 README 故障表（pinned 旧版 CLI 为 Phase 0.5 备选，本期不实现）；
  - 超时 → 告警不阻断（慢设备），首次真实运行再验。

### 5.3 start/stop/status

- `start.sh`：`termux-wake-lock` → `nohup node backend/index.js > ~/.deepthink/logs/backend.log &`
  （pidfile）→ 轮询 `/api/health` ≤ 60s → 打印 `http://127.0.0.1:$WEB_PORT`；
  已在跑（pidfile + health 200）则幂等提示。
- `stop.sh`：SIGTERM → 10s → SIGKILL，`termux-wake-unlock`，清 pidfile。
- `status.sh`：pid / 端口 / health JSON / 日志尾 20 行。

## 6. Android 壳 app（F4）

### 6.1 工程与工具链

```
android/
  app/                          ← Kotlin 工程（替代无源码旧壳）
    src/main/AndroidManifest.xml
    src/main/java/com/aigeniusinstitute/deepthink/
      MainActivity.kt           ← WebView + 状态机 + 降级提示条
      ServerDiscovery.kt        ← 探测逻辑（纯逻辑 + 可注入 Probe 接口）
      ServerUrl.kt              ← URL 规范化（对齐旧壳 normalizeServerUrl 行为）
      SettingsActivity.kt       ← 服务器设置（本地/远程、连接测试）
      Prefs.kt                  ← SharedPreferences 封装
    src/test/java/...           ← JVM 单测（TC-F4-02/03/04）
  termux/                       ← F1/F2 脚本
  build/outputs/                ← 构建产物（旧 APK 归档为 legacy）
```

- minSdk 26 / target+compileSdk 35，`usesCleartextTraffic=true`（loopback http），
  唯一权限 `INTERNET`。
- 依赖最小化：**纯 Android framework UI（无 androidx）** + Kotlin stdlib（AGP 9 内置 Kotlin
  支持）；网络探测用 `HttpURLConnection`（与旧壳同款，无 OkHttp）；JSON 解析用
  `org.json`（Android 内置）。
- 构建工具链（已定版并在本机验证）：Gradle 9.8.2（wrapper 已含）+ AGP 9.5.0 +
  JDK 17+（开发机用 Android Studio JBR 25）。注意 **AGP 9 起 Kotlin 支持内置**，
  不可再 apply `org.jetbrains.kotlin.android` 插件（apply 即报错）。
  构建命令：`JAVA_HOME=<Android Studio JBR> ./gradlew :app:assembleRelease`。

### 6.2 发现算法（F4a）

```
候选端口 = [配置端口(默认9898)] + (区间开关开启 ? 9890..9900 去重 : [])
for port in 候选:
    GET http://127.0.0.1:{port}/api/health   (超时 800ms)
    命中 = HTTP 200 && json.status ∈ {"healthy","ok"}
命中 → CONNECTED(loadUrl)   全部未命中 → GUIDE(引导页)
```

- 探测在后台线程池顺序执行（总预算 ≈ 9s 上限，实际服务在跑时 < 1s 命中）；
- `重试` = 重跑发现；连接后 WebView `onReceivedError` / `ERR_CONNECTION_REFUSED`
  → 自动回到 GUIDE（服务挂掉的中局态）；
- 降级提示（F4d）：本地模式 CONNECTED 后顶部横幅一次性提示，`不再显示` 持久化。

### 6.3 与后端契约

| 探测/连接 | 端点 | 判定 |
|---|---|---|
| 服务发现 | `GET /api/health`（无认证，`src/routes/monitor.ts:169`） | 200 + `status:"healthy"` |
| 界面加载 | `GET /`（SPA，`src/web.ts` 同源 serve） | WebView 正常渲染 |
| 流式/终端 | `ws://127.0.0.1:{port}/ws` | 同源自动升级，无需配置 |

## 7. 测试策略

| 层 | 手段 | 对应 TC |
|---|---|---|
| 后端 | vitest：copy-runtime-assets 临时目录断言；PTY 路径布局断言；全量 `make test` 基线 diff | TC-F5-01/02/03 |
| 脚本 | `bash -n` 全脚本；shellcheck（可用则跑）；`check-android-payload.sh` 清单断言；payload 构建冒烟 | TC-F1-01/02、TC-F2-01、TC-F3-01~04 |
| App | `./gradlew test` JVM 单测（发现判定/端口序列/URL 规范化）；`assembleRelease` 构建成功 | TC-F4-01~04 |
| 真机 | 壳 app 端到端 + Termux 全新安装（清单交付，开发机为 Windows 无法执行） | TC-F1-04~07、TC-F2-03/04、TC-F4-05~08 |

真机项在测试报告中逐条列为**待人工验收**，不冒充已验证（Supervisor 原则）。

## 8. 风险与备选

| 风险 | 备选 |
|---|---|
| Gradle/AGP 与 JDK25 兼容摩擦 | 便携 JDK21 + AGP 8.5.2/Gradle 8.7（旧 APK 先例） |
| claude CLI 在个别机型 seccomp 兼容失败 | README 故障表；Phase 0.5 pinned JS 版 CLI（`@anthropic-ai/claude-code@2.1.x` 经 node 执行） |
| node-pty 设备端编译失败 | `--ignore-scripts` + 定向 rebuild 兜底（终端本就依赖 Docker，降级无损） |
| npm install 设备端过慢/断网 | README 给出国内镜像建议（`npm config set registry`）；失败可重跑（幂等） |

## 9. 交付物清单

1. `scripts/copy-runtime-assets.cjs`（+pty-worker）+ `src/terminal-manager.ts` 路径修复
2. `scripts/build-android-payload.sh`、`scripts/check-android-payload.sh`、Makefile `android-payload`
3. `android/termux/{lib.sh,install.sh,start.sh,stop.sh,status.sh}`
4. `android/app/`（Kotlin 工程 + JVM 单测）
5. `android/README.md`（手机端安装手册）
6. 测试：`tests/runtime-assets.test.ts`（vitest）+ app JVM 单测 + 既有全量回归
