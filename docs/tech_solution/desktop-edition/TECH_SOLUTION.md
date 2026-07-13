# 技术方案 — DeepThink 桌面版（Desktop Edition）

> 文档版本：v1.0 · 编写日期：2026-07-06 · Owner：Code Agent
> 关联 PRD：`docs/prd/desktop-edition/PRD.md`

## 1. 总体架构

### 1.1 架构图

```
┌──────────────────────────────────────────────────────────────┐
│  DeepThink.app (Electron 壳)                                  │
│                                                                │
│  ┌─────────────────────────────────────────┐                  │
│  │ Electron Main Process                   │                  │
│  │ (main.js)                               │                  │
│  │                                          │                  │
│  │  ┌──────────────┐  ┌────────────────┐  │                  │
│  │  │ AppLifecycle │  │ Tray / Menu    │  │                  │
│  │  │ Single Inst  │  │ Splash Window  │  │                  │
│  │  └──────┬───────┘  └────────────────┘  │                  │
│  │         │                                │                  │
│  │         ▼                                │                  │
│  │  ┌──────────────────────────────┐       │                  │
│  │  │ BackendSupervisor            │       │                  │
│  │  │ - spawn node + dist/index.js │       │                  │
│  │  │ - port probe + auto-increment│       │                  │
│  │  │ - crash detection / restart  │       │                  │
│  │  │ - stdout/stderr → log file   │       │                  │
│  │  └──────────────────────────────┘       │                  │
│  │                                          │                  │
│  │  ┌──────────────────────────────┐       │                  │
│  │  │ BrowserWindow                │       │                  │
│  │  │ loadURL(http://127.0.0.1:PORT)│      │                  │
│  │  └──────────────────────────────┘       │                  │
│  └─────────────────────────────────────────┘                  │
│                                                                │
│  ┌─────────────────────────────────────────┐                  │
│  │ Resources/ (随包分发)                    │                  │
│  │  ├── node             (Node binary)     │                  │
│  │  ├── backend/         (dist/index.js)   │                  │
│  │  ├── web-dist/        (前端静态资源)     │                  │
│  │  ├── agent-runner/    (子项目 dist+nm)   │                  │
│  │  ├── node_modules/    (后端原生模块)     │                  │
│  │  └── package.json    (版本元数据)        │                  │
│  └─────────────────────────────────────────┘                  │
└──────────────────────────────────────────────────────────────┘
                                ▲
                                │ 读写
                                ▼
        ┌──────────────────────────────────────────┐
        │ 系统应用数据目录                           │
        │  ~/Library/Application Support/DeepThink/  │ (mac)
        │  %APPDATA%/DeepThink/                      │ (win)
        │  ~/.config/DeepThink/                      │ (linux)
        │  ├── data/  (运行时数据)                   │
        │  └── logs/  (应用层日志)                   │
        └──────────────────────────────────────────┘
```

### 1.2 关键设计决策

#### D1 — 后端不内嵌 Electron Main，而是 spawn 独立 Node 子进程

**选择**：Electron Main 进程 spawn 独立 Node 子进程跑 `dist/index.js`，**不**用 `require()` 直接内嵌。

**原因**：
1. **原生模块 ABI 隔离**：`better-sqlite3`、`node-pty` 必须按 Node ABI 编译。若内嵌进 Electron Main，需用 `electron-rebuild` 重新编译以匹配 Electron ABI，引入额外构建复杂度。用独立 Node binary（随包分发）跑后端，可直接复用 npm prebuild 二进制。
2. **崩溃隔离**：后端崩溃不会带走 UI；Main 进程可监测并重启后端。
3. **代码零改动**：后端代码完全不需要感知"自己在 Electron 里"，保持源码版部署兼容。
4. **Claude SDK 子进程友好**：SDK 内部会 spawn CLI 子进程（`process.execPath` 在子进程里是真正的 node，行为正常）。

**取舍**：内存占用略高（多一个 Node 进程 ~50MB），可接受。

#### D2 — 随包分发独立 Node binary，不依赖系统 Node

**选择**：安装包内带 `Resources/node`（macOS：`node-darwin-arm64`；Windows：`node-win-x64.exe`；Linux：`node-linux-x64`），spawn 时用绝对路径。

**原因**：用户系统可能没装 Node，或装了不兼容版本。自带 Node 是"零依赖"承诺的基础。

**实现**：用 [`node-bin`](https://www.npmjs.com/package/node-bin) 或 [`@mapbox/node-pre-gyp`](https://github.com/mapbox/node-pre-gyp) 拉取对应平台二进制，构建时 copy 到 `Resources/node`。

#### D3 — 数据目录改用系统应用数据目录，通过环境变量注入

**选择**：Electron Main 启动时计算目标平台的数据目录路径，通过 `DEEPTHINK_DATA_DIR` 环境变量传给后端子进程；后端 `src/config.ts` 增加该环境变量优先级。

**改动点**（仅一处，surgical）：
```ts
// src/config.ts
const PROJECT_ROOT = process.cwd();
- export const DATA_DIR = path.resolve(PROJECT_ROOT, 'data');
+ export const DATA_DIR = process.env.DEEPTHINK_DATA_DIR
+   ? path.resolve(process.env.DEEPTHINK_DATA_DIR)
+   : path.resolve(PROJECT_ROOT, 'data');
```

源码版（未设环境变量）行为不变，桌面版通过环境变量注入新路径。**符合 Surgical Changes 原则**。

#### D4 — 前端构建产物复用，零改动

`web/dist/` 由后端 `serveStatic` 提供，Electron BrowserWindow 直接 `loadURL('http://127.0.0.1:PORT')`。前端代码零改动。

#### D5 — agent-runner 随包分发，路径解析改造

**选择**：打包时把 `container/agent-runner/dist/` + `container/agent-runner/node_modules/` 整体 copy 到 `Resources/agent-runner/`。

**问题**：`src/container-runner.ts:1688` 用 `path.join(process.cwd(), 'container', 'agent-runner')` 找 agent-runner。桌面版 cwd 不是项目根。

**改动**（surgical）：
```ts
// src/container-runner.ts
const projectRoot = process.cwd();
- const agentRunnerRoot = path.join(projectRoot, 'container', 'agent-runner');
+ const agentRunnerRoot = process.env.DEEPTHINK_AGENT_RUNNER_DIR
+   ? path.resolve(process.env.DEEPTHINK_AGENT_RUNNER_DIR)
+   : path.join(projectRoot, 'container', 'agent-runner');
```

桌面版 Electron Main 注入 `DEEPTHINK_AGENT_RUNNER_DIR=Resources/agent-runner`。

#### D6 — 静态资源路径（web/dist）改造

**选择**：`src/web.ts` 的 `serveStatic({ root: './web/dist' })` 改为可配置。

**改动**：
```ts
- serveStatic({ root: './web/dist' })
+ const WEB_DIST_ROOT = process.env.DEEPTHINK_WEB_DIST_DIR
+   ? path.resolve(process.env.DEEPTHINK_WEB_DIST_DIR)
+   : path.join(process.cwd(), 'web', 'dist');
+ serveStatic({ root: WEB_DIST_ROOT })
```

（具体修改点见 §3）

### 1.3 不做的事（避免过度设计）

- ❌ 不引入 Tauri（与 Electron 取舍已在 PRD 评估，Electron 更稳）
- ❌ 不做 Node SEA（Claude Agent SDK 内部动态 require/spawn，SEA 兼容性差）
- ❌ 不重写 Docker 容器模式相关代码（仅 UI 层隐藏，源码保留）
- ❌ 不做多用户/邀请码 UI 重设计（桌面版隐藏该 UI）
- ❌ 不自建更新服务（走 GitHub Release + electron-updater）

## 2. 依赖与工具链

### 2.1 新增依赖

| 包 | 用途 | 位置 |
|----|------|------|
| `electron` ^32 | 桌面壳 | devDependency (新增 `desktop/` 子项目) |
| `electron-builder` ^25 | 打包 | devDependency |
| `electron-updater` ^6 | 自动更新 | dependency（主进程用） |
| `node-bin` | 拉取跨平台 Node binary | devDependency（构建时） |
| `electron-rebuild` | 备用（D1 决策不依赖，但保留） | devDependency |

### 2.2 项目结构

新建 `desktop/` 子目录，与 `web/`、`container/agent-runner/` 平级：

```
loop-engineering/
├── desktop/                  ← 新增
│   ├── package.json
│   ├── tsconfig.json
│   ├── src/
│   │   ├── main.ts           # Electron main 入口
│   │   ├── backend-supervisor.ts
│   │   ├── port-resolver.ts
│   │   ├── paths.ts          # 平台路径解析
│   │   ├── tray.ts
│   │   ├── menu.ts
│   │   ├── splash.ts
│   │   ├── single-instance.ts
│   │   └── updater.ts
│   ├── resources/            # 构建时填充
│   │   └── icon.icns / icon.ico / icon.png
│   └── build/                # electron-builder 配置
│       ├── mac.json
│       ├── win.json
│       └── linux.json
├── src/                       # 后端（仅 3 处 surgical 改动）
├── web/                       # 前端（零改动）
├── container/agent-runner/    # agent-runner（零改动）
└── Makefile                   # 新增 desktop 相关 target
```

### 2.3 构建产物布局

`electron-builder` 打包后，安装包内 `Resources/` 结构：

```
DeepThink.app/Contents/Resources/
├── node                       # 平台对应 Node binary（可执行）
├── backend/
│   ├── index.js              # 后端 dist
│   └── *.js                  # 后端所有 dist 文件
├── web-dist/                 # 前端构建产物
│   ├── index.html
│   └── assets/
├── agent-runner/
│   ├── dist/index.js
│   └── node_modules/         # 含 @anthropic-ai/claude-agent-sdk + claude-code
├── node_modules/             # 后端原生模块 + 依赖
├── package.json              # 版本元数据
└── app-update.yml            # electron-updater 配置
```

## 3. 后端改动清单（Surgical Changes）

后端总改动量：**3 处环境变量读取**，零逻辑改动。

### 3.1 `src/config.ts` — DATA_DIR 可注入

```diff
- export const DATA_DIR = path.resolve(PROJECT_ROOT, 'data');
+ export const DATA_DIR = process.env.DEEPTHINK_DATA_DIR
+   ? path.resolve(process.env.DEEPTHINK_DATA_DIR)
+   : path.resolve(PROJECT_ROOT, 'data');
```

**影响分析**：`DATA_DIR` 派生出 `STORE_DIR`、`GROUPS_DIR`、`SESSION_SECRET_FILE` 等，全部自动跟随。源码版未注入环境变量，行为不变。

### 3.2 `src/container-runner.ts` — agentRunnerRoot 可注入

```diff
  const projectRoot = process.cwd();
- const agentRunnerRoot = path.join(projectRoot, 'container', 'agent-runner');
+ const agentRunnerRoot = process.env.DEEPTHINK_AGENT_RUNNER_DIR
+   ? path.resolve(process.env.DEEPTHINK_AGENT_RUNNER_DIR)
+   : path.join(projectRoot, 'container', 'agent-runner');
```

### 3.3 `src/web.ts` — 静态资源根可注入

```diff
- serveStatic({ root: './web/dist' }),
+ const WEB_DIST_ROOT = process.env.DEEPTHINK_WEB_DIST_DIR
+   ? path.resolve(process.env.DEEPTHINK_WEB_DIST_DIR)
+   : path.join(process.cwd(), 'web', 'dist');
+ serveStatic({ root: WEB_DIST_ROOT }),
```

（共 2 处 `serveStatic` 调用，全部替换为 `WEB_DIST_ROOT`）

### 3.4 端口冲突自动避让（可选改动）

当前 `WEB_PORT` 固定读环境变量。桌面版需在 Main 进程探测端口可用性，注入实际端口到 `WEB_PORT` 环境变量。后端零改动。

## 4. Electron 主进程设计

### 4.1 启动流程

```
App 启动
  ↓
single-instance lock 失败？→ 聚焦现有窗口 → quit
  ↓
计算 paths（dataDir / logDir / resourcesDir）
  ↓
显示 splash window
  ↓
BackendSupervisor.start()
  ├─ 探测可用端口（3000..3010）
  ├─ 构造 env（DEEPTHINK_DATA_DIR / AGENT_RUNNER_DIR / WEB_DIST_DIR / WEB_PORT / NO_PROXY...）
  ├─ spawn(Resources/node, [Resources/backend/index.js], { env, cwd: dataDir, stdio: pipe })
  └─ 监听 stdout 等待 "Server listening on http://127.0.0.1:PORT" 信号
  ↓
ready 信号到达 → BrowserWindow.loadURL
  ↓
主窗口显示，splash 关闭
  ↓
注册 tray + menu
  ↓
检查更新（异步，不阻塞）
```

### 4.2 BackendSupervisor 核心逻辑

```ts
class BackendSupervisor {
  private proc: ChildProcess | null = null;
  private port: number | null = null;
  private restartCount = 0;

  async start(): Promise<{ port: number }> {
    const port = await findFreePort(3000, 3010);
    this.port = port;
    const env = buildBackendEnv({ port, dataDir, agentRunnerDir, webDistDir });
    this.proc = spawn(nodePath, [backendEntryPath], {
      env: { ...process.env, ...env },
      cwd: dataDir,
      stdio: ['ignore', 'pipe', 'pipe'],
    });
    this.pipeLogs();
    await this.waitForReady(port); // 等 stdout 的 "listening" 信号或 HTTP probe
    return { port };
  }

  onCrash(): restart with exponential backoff (max 3 times, then show error dialog)

  stop(): graceful — send SIGTERM, wait 5s, SIGKILL
}
```

### 4.3 单实例

用 `app.requestSingleInstanceLock()`。第二次启动时 `second-instance` 事件触发，主窗口 `show()` + `focus()`。

### 4.4 托盘

```ts
Tray({
  icon: trayIconTemplate, // macOS 用 template image
  menu: [
    { label: '显示主窗口', click: () => showMainWindow() },
    { label: '打开数据目录', click: () => shell.openPath(dataDir) },
    { label: '打开日志目录', click: () => shell.openPath(logDir) },
    { type: 'separator' },
    { label: '重启服务', click: () => restartBackend() },
    { label: '退出', click: () => app.quit() },
  ],
});
```

关闭窗口 → `event.preventDefault()` + 隐藏窗口（最小化到托盘）。

### 4.5 端口探测

```ts
async function findFreePort(start: number, end: number): Promise<number> {
  for (let p = start; p <= end; p++) {
    try {
      const server = net.createServer();
      await new Promise((res, rej) => {
        server.once('error', rej);
        server.listen(p, '127.0.0.1', res);
      });
      server.close();
      return p;
    } catch { /* port in use, try next */ }
  }
  throw new Error('No free port in 3000-3010');
}
```

### 4.6 Splash Window

无 frame、alwaysOnTop、size 480×320，显示 logo + "正在启动 DeepThink…"。后端 ready 后销毁。

### 4.7 自动更新

用 `electron-updater`：
```ts
autoUpdater.setFeedURL({ provider: 'github', owner: 'aigeniusinstitute', repo: 'deepthink' });
autoUpdater.checkForUpdatesAndNotify();
```
有更新时弹 dialog "发现新版本 vX.Y.Z，是否前往下载？"，确定则 `shell.openExternal(releaseUrl)`。

> MVP 阶段先做"提示"，不自助下载安装；后续再开 `autoUpdater.quitAndInstall()`。

## 5. 打包配置

### 5.1 `desktop/build/mac.json`

```json
{
  "appId": "com.aigeniusinstitute.deepthink",
  "productName": "DeepThink",
  "directories": { "output": "release" },
  "files": [
    "dist/**/*"
  ],
  "extraResources": [
    { "from": "../../Resources/node", "to": "node" },
    { "from": "../../dist", "to": "backend" },
    { "from": "../../web/dist", "to": "web-dist" },
    { "from": "../../container/agent-runner/dist", "to": "agent-runner/dist" },
    { "from": "../../container/agent-runner/node_modules", "to": "agent-runner/node_modules" },
    { "from": "../../node_modules", "to": "node_modules", "filter": ["**/*", "!**/*.md"] },
    { "from": "./resources/icon.icns", "to": "icon.icns" }
  ],
  "mac": {
    "category": "public.app-category.developer-tools",
    "hardenedRuntime": true,
    "gatekeeperAssess": false,
    "entitlements": "build/entitlements.mac.plist",
    "entitlementsInherit": "build/entitlements.mac.plist",
    "target": [
      { "target": "dmg", "arch": ["arm64", "x64"] }
    ]
  }
}
```

### 5.2 Makefile 新增 target

```makefile
# ─── Desktop ────────────────────────────────────────────────
desktop-install:
	cd desktop && npm install

desktop-build-deps: build sync-types
	cd container/agent-runner && npm install && npm run build

desktop-fetch-node:
	node scripts/fetch-node-binary.js

desktop-pack-mac: desktop-build-deps desktop-fetch-node
	cd desktop && npx electron-builder --config build/mac.json

desktop-dev: desktop-build-deps
	cd desktop && npm run dev
```

### 5.3 `scripts/fetch-node-binary.js`

构建时拉取对应平台 Node binary，落到 `Resources/node`。用 `node-bin` 包或直接从 `https://nodejs.org/dist/vXX.X.X/` 下载。

## 6. CI / 发布

### 6.1 GitHub Actions 工作流

3 个矩阵任务（mac / win / linux），各平台在对应 runner 上：
1. checkout
2. setup-node 22
3. `make install` + `make build`
4. `cd container/agent-runner && npm install && npm run build`
5. `cd desktop && npm install`
6. `make desktop-fetch-node`
7. `npx electron-builder --config build/{platform}.json`
8. upload artifact

### 6.2 代码签名（后续）

- macOS：需 Apple Developer ID Application 证书 + notarytool 公证
- Windows：需 EV Code Certificate
- MVP 阶段先不签名，用户首次安装时手动允许（macOS 右键打开 / Windows SmartScreen 跳过）

## 7. 数据迁移工具

提供从源码版（`{repo}/data/`）导入到桌面版（系统数据目录）的入口：
- 设置页 → "高级" → "从源码版导入数据"
- 弹出文件夹选择器，让用户选 `loop-engineering/data/` 目录
- 校验 `data/db/messages.db` 存在
- 关闭后端 → rsync/cp 数据 → 重启后端
- 仅在桌面版可见，源码版隐藏

## 8. 实施步骤（按里程碑）

### M2 — 桌面壳骨架（D2-D3）
1. 创建 `desktop/` 子项目骨架（package.json / tsconfig / src/main.ts）
2. 实现 `paths.ts`（平台数据目录解析）
3. 实现 `port-resolver.ts`
4. 实现 `backend-supervisor.ts`（spawn + log pipe + ready 检测）
5. 实现 splash + main window + loadURL
6. 后端 3 处 surgical 改动（§3）
7. 验证：`make desktop-dev` 能拉起后端、主窗口显示聊天页

### M3 — 体验完善（D4）
8. 单实例锁
9. 托盘 + 菜单
10. 关闭最小化到托盘
11. 后端崩溃 dialog + 重启按钮
12. "打开数据目录 / 日志目录"按钮

### M4 — 打包链路（D5）
13. `scripts/fetch-node-binary.js`
14. electron-builder mac 配置 + 测试 `.dmg` 产物
15. 在干净 macOS 上验证：零 Node / 零 Docker 环境下能安装运行

### M5 — 自动更新 + 数据迁移（D6）
16. electron-updater 集成
17. 数据迁移工具
18. 应用图标设计

### M6 — Windows / Linux（D7-D8）
19. Windows 平台验证（原生模块 win32-x64 prebuild）
20. Linux AppImage 验证
21. CI 矩阵

## 9. 风险与回退方案

| 风险 | 触发条件 | 回退 |
|------|---------|------|
| `better-sqlite3` 在 Electron 子进程下 prebuild 不工作 | spawn 后端立即崩溃 with `Module did not self-unload` | 用 `electron-rebuild` 针对后端原生模块重新编译为 Node ABI（确认 ABI 版本匹配） |
| Claude Agent SDK 内部 spawn CLI 失败 | Agent 对话超时 / 不响应 | 验证 SDK spawn 用的是 `process.execPath`，注入正确的环境变量；必要时 patch SDK |
| 安装包体积 > 250MB | node_modules 太大 | 用 `electron-builder` 的 `files` filter 剔除 `*.md`、`*.ts`、test 文件、文档 |
| macOS 公证失败 | 用户无法启动 | MVP 阶段不签名，文档说明右键打开方式 |
| 端口 3000-3010 全被占 | 启动失败 | 提示用户关闭占用进程或扩展端口范围 |

## 10. 验收标准（Goal-Driven）

M2 完成时验证：
- [ ] `make desktop-dev` 在 macOS 上启动成功
- [ ] 主窗口能加载 `http://127.0.0.1:3000`，显示登录页
- [ ] 设置向导走完，能与 Claude 对话
- [ ] 数据落到 `~/Library/Application Support/DeepThink/data/`
- [ ] 后端日志落到 `~/Library/Application Support/DeepThink/logs/backend.log`
- [ ] 关闭 App 后所有子进程退出（`pgrep -f "dist/index.js"` 无残留）

M4 完成时验证：
- [ ] 在干净 macOS（无 Node / Docker / git）上双击 `.dmg` 安装并启动成功
- [ ] 安装包体积 ≤ 200MB
- [ ] 首次启动到主窗口可交互 ≤ 5s

## 11. 开放问题

1. ❓ 是否在 M4 就启用 macOS 签名 + 公证？（需要 Apple 开发者账号 $99/年）
2. ❓ Node binary 用哪个版本？建议 22 LTS（与 `engines.node` 对齐）→ **已选 v22.11.0**
3. ❓ 是否提供"便携版"（Win 免安装 `.exe`、Linux AppImage）？
4. ❓ DeepThink 应用图标设计（建议紫蓝渐变 + 大脑/思考气泡元素，与 DeepThink 现有 teal 风格区分）？

## 12. 实施记录（2026-07-06 完成 M2 + M4）

### 12.1 已落地

| 里程碑 | 状态 | 验证 |
|---|---|---|
| M2 桌面壳骨架 | ✅ | desktop/src 10 个 TS 文件已编译到 dist/；main.log 显示 "main window ready" |
| M3 体验完善 | ✅ 部分 | 单实例锁 / 托盘 / 菜单 / 崩溃重启（指数退避 3 次）已实现 |
| M4 打包链路 | ✅ | DeepThink-1.0.0-arm64.dmg 496MB，双击安装后后端 healthy |

### 12.2 实施过程中踩的坑（已修复）

| 坑 | 现象 | 修复 |
|---|---|---|
| `fetch-node-binary.js` 用了 TS 类型注解但保存为 `.js` | `SyntaxError: Missing initializer in const declaration` | 去掉 `: Record<string, string>` 等类型注解，改为纯 JS |
| electron 版本范围 `^32.2.0` | electron-builder 报 "is a range, not a fixed version" | 固定为 `32.3.3`（同时 `electron-builder` 固定 `25.1.8`） |
| 系统 Python 3.14 的 `pyexpat` 损坏 | dmg-builder 调 `python` 时 `ImportError: Symbol not found: _XML_SetAllocTrackerActivationThreshold` | 软链 `python` → `python3.11`（`~/.local/bin/python3.11` 或 `brew install python@3.11`） |
| GitHub CDN 下载 electron 二进制卡死 | `app-builder unpack-electron` 8 分钟无进展 | 注入 `ELECTRON_MIRROR=https://npmmirror.com/mirrors/electron/` |
| `better-sqlite3` ABI 不匹配 | backend 启动时 `NODE_MODULE_VERSION 141 vs 127` 报错 | 用打包的 Node 22 binary 跑 `npm rebuild better-sqlite3 node-pty --build-from-source`，确保原生模块按 Node 22 ABI 编译 |

### 12.3 待改进

| 项 | 现状 | 目标 |
|---|---|---|
| 安装包体积 | 496MB | ≤ 200MB（剥离 dev deps / docs / sourcemap / agent-runner 中 `claude-code` 非必要文件） |
| macOS 代码签名 | 未签名（用户首次需右键打开） | 需 Apple Developer ID |
| Windows / Linux | 配置就绪未验证 | 需对应平台 runner |
