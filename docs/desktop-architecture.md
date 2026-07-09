# DeepThink 桌面版 Electron 壳架构

> 本文档从 `CLAUDE.md` §2.6 拆分而来。修改 / 新增桌面版相关代码时请同步更新。
>
> 顶层 `CLAUDE.md` 只保留"桌面版是把后端 + 前端 + Agent Runner 打包成单机 .dmg/.exe/.AppImage 的 Electron 应用"这条心智模型锚点；详细架构按需 Read 本文档。

DeepThink 桌面端是一个 Electron 应用（`desktop/` 目录），把后端服务 + Web 前端 + Agent Runner 打包成单机可执行的 `.dmg` / `.exe` / `.AppImage`，让非开发者用户能"双击即用"。

## 模块结构（`desktop/src/`）

| 文件 | 职责 |
|------|------|
| `main.ts` | Electron 主进程入口：单实例锁、splash → 启动后端 → 创建主窗口、`before-quit` 优雅停机 |
| `backend-supervisor.ts` | 后端进程守护：`spawn(nodeBinary, [backendEntry])` 启动后端、stdout 监听 ready 信号、HTTP 探针 `/api/health` 兜底、崩溃后指数退避重启（最多 3 次）、停止时 `lsof -ti:PORT -sTCP:LISTEN` 清理残留监听者 |
| `paths.ts` | 路径解析：`appDataDir` / `dataDir` / `logDir`（per-platform 用户目录）、`backendEntry` / `webDistDir` / `agentRunnerDir` / `nodeBinary`（开发 vs 打包双路径，可通过环境变量覆盖） |
| `port-resolver.ts` | `findFreePort(49281, 49300)` 在保留区间内找空闲端口，避免与其他 DeepThink 实例冲突 |
| `splash.ts` | 启动闪屏：`data:` URL 内联 HTML，品牌色 `#E8EEF2` / `#1F2937`，"正在启动…"脉动动画 |
| `tray.ts` | 系统托盘：显示主窗口、打开数据/日志目录、重启服务、退出；macOS 下 `setTemplateImage(true)` 适配深色模式 |
| `menu.ts` | 应用菜单：文件 / 编辑 / 视图 / 帮助（中文 label），帮助菜单含项目主页外链 |
| `updater.ts` | `electron-updater` 自动更新：检测到新版本弹窗询问，下载完成后下次退出时安装 |
| `meta.ts` | ESM `__dirname` shim |

## 启动流程

```
app.whenReady()
  → ensureDirs()                          # 创建 appDataDir / dataDir / logDir
  → installMenu() + createTray()          # 应用菜单 + 系统托盘
  → createSplash()                        # 显示启动闪屏
  → backend.start()                       # spawn Node + 等待 /api/health 200
      ├─ 成功 → createMainWindow(port)    # BrowserWindow.loadURL(http://127.0.0.1:${port})
      │         → destroySplash() + initUpdater()
      └─ 失败 → 弹错误对话框 → app.quit()
```

## 资源路径策略（`paths.ts`）

| 资源 | 开发模式 | 打包模式（`app.isPackaged`） |
|------|---------|----------------------------|
| 后端入口 | `<repo>/dist/index.js` | `process.resourcesPath/backend/index.js` |
| Web 静态资源 | `<repo>/web/dist` | `process.resourcesPath/web-dist` |
| Agent Runner | `<repo>/container/agent-runner` | `process.resourcesPath/agent-runner` |
| Node 二进制 | 系统 PATH 上的 `node`（避免 Electron binary 跑 better-sqlite3 等 native 模块踩 ABI 不一致）| `process.resourcesPath/node/{node|node.exe}` |

环境变量覆盖：`DEEPTHIK_BACKEND_DIR` / `DEEPTHIK_WEB_DIST_DIR` / `DEEPTHIK_AGENT_RUNNER_DIR` / `DEEPTHIK_NODE_BINARY` 优先级最高，便于调试时指向自定义构建产物。

## 用户数据目录（per-platform）

| 平台 | 路径 |
|------|------|
| macOS | `~/Library/Application Support/DeepThink/` |
| Windows | `%APPDATA%/DeepThink/` |
| Linux | `$XDG_CONFIG_HOME/DeepThink/` 或 `~/.config/DeepThink/` |

下含 `data/`（后端 `data/` 目录，SQLite + 配置 + 工作区）和 `logs/`（`main.log` + `backend.log`）。

## 后端进程守护要点

- **进程隔离**：后端是独立的 Node 子进程，不是 Electron main 进程的内嵌模块。这样后端崩溃不会拖垮 UI，UI 也能在 `before-quit` 里优雅 SIGTERM → 5s 超时 → SIGKILL。
- **端口探测**：`waitForReady()` 双保险 —— stdout 监听 `listening|Server listening|started on` 关键词 + 200ms 间隔 HTTP 探针 `/api/health`，任一命中即视为就绪。60s 超时。
- **崩溃重启**：非主动停止的退出触发指数退避重启（1s → 2s → 4s），最多 3 次，超过后放弃，避免死亡循环。
- **停止清理**：`stop()` 走 SIGTERM → 5s → SIGKILL，再用 `lsof -ti:PORT -sTCP:LISTEN` 兜底杀掉逃逸出进程组的残留监听者（如子进程 spawn 的 Docker）。**严禁**用裸 `lsof -ti:PORT | xargs kill`，会误杀 OrbStack/Docker 代理导致 Docker daemon 崩溃（与 CLAUDE.md §10 的"关闭服务"约定一致）。
- **Electron binary 兜底**：开发模式下若 `node` 不在 PATH，回退到 `process.execPath`（Electron binary），此时 `ELECTRON_RUN_AS_NODE=1` 强制 Node-only 行为；但 native 模块可能踩 ABI 不一致，仅作兜底。

## 平台构建（`desktop/build/`）

| 配置 | 目标产物 | 关键差异 |
|------|---------|---------|
| `mac-arm64.json` / `mac-x64.json` | `DeepThink-1.0.0-{arm64}.dmg` / `DeepThink-1.0.0.dmg` | `icon.icns`、`hardenedRuntime: true`、`dmg.contents` 双图标布局 |
| `win.json` | `DeepThink-Setup-1.0.0.exe` | `icon.ico` |
| `linux.json` | `DeepThink-1.0.0.AppImage` / `.deb` | `icon.png` |

`extraResources` 把后端 `dist/`、Web `web/dist`、Agent Runner、Node 二进制、`node_modules/` 一起打进 `.app/Contents/Resources/`（mac）或对应目录。

## 图标资产（`desktop/resources/`）

| 文件 | 用途 |
|------|------|
| `icon.iconset/` | macOS 源素材（10 个 PNG：16/32/128/256/512 + @2x 高清版） |
| `icon.icns` | macOS 应用图标，由 `iconutil -c icns icon.iconset` 生成 |
| `icon.ico` | Windows 应用图标，由 `magick icon.iconset/*.png icon.ico` 合成多尺寸 |
| `icon.png` | Linux 应用图标，512×512 PNG |

更新流程：替换 `icon.iconset/deep-think.png` 源图 → 跑 `sips` 重新生成各尺寸 → `iconutil` 打包 `.icns` → `magick` 合成 `.ico` → `cp icon_512x512.png icon.png`。

## Makefile 目标

| 目标 | 说明 |
|------|------|
| `make desktop-build-deps` | 等价于 `make build sync-types`，编译后端 + 前端 + agent-runner |
| `make desktop-install` | `cd desktop && npm install` |
| `make desktop-build` | `desktop-build-deps` + `desktop-install` + 编译 Electron TypeScript |
| `make desktop-fetch-node` | 拉取当前平台的 Node.js 二进制到 `desktop/dev-resources/node` |
| `make desktop-dev` | 桌面版开发模式：启动 Electron 壳加载本机后端 |
| `make desktop-pack-mac` | 打包 macOS `.dmg`（仅 arm64，日常本地用） |
| `make desktop-pack-mac-x64` | 打包 macOS `.dmg`（仅 x64，需在 x64/intel Mac 上执行） |
| `make desktop-pack-mac-all` | 打包 macOS `.dmg`（arm64 + x64 双架构，发布用） |
| `make desktop-pack-win` | 打包 Windows `.exe`（需在 Windows runner 执行） |
| `make desktop-pack-linux` | 打包 Linux AppImage / `.deb`（需在 Linux runner 执行） |

## CI 构建注意

GitHub Actions 上构建 macOS x64 dmg 必须用 Intel runner。`macos-13`（Ventura, Intel）已于 2026 年被 GitHub 完全下线，必须改用 `macos-15-intel`。详见 `docs/issues/2026-07-10-macos-13-runner-retired.md`。
