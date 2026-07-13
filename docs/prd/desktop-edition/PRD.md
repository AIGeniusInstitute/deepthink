# PRD — DeepThink 桌面版（Desktop Edition）

> 文档版本：v1.0 · 编写日期：2026-07-06 · Owner：Code Agent
> 关联：`docs/tech_solution/desktop-edition/`

## 1. 背景与目标

### 1.1 现状
DeepThink 当前以"源码 + Make 命令"形式分发：
- 用户须自行安装 Node.js ≥ 20、Docker（容器模式必备）
- 通过 `git clone` + `make start` 启动，首次启动会自动 `npm install` 编译
- admin 主容器已支持宿主机模式（无需 Docker），但安装门槛仍高

### 1.2 问题
对非开发者用户：
- Node.js / Docker / git 三件套是门槛
- 首次 `npm install` 可能因网络/原生模块编译失败
- 命令行启动方式不友好
- 升级需要重新 `git pull` + 编译

### 1.3 目标
将 DeepThink 改造成**桌面版**，产品名定为 **DeepThink**。用户下载一个安装包，双击安装，启动应用即用，全程零命令行、零依赖外部工具。**仅启用宿主机模式**（不依赖 Docker）。首期支持 **macOS、Windows、Linux** 三大主流操作系统。

### 1.4 非目标
- 不做移动端原生 App（已有 PWA 覆盖移动端）
- 不替代容器模式的多用户隔离场景（桌面版定位为单用户本地工具）
- 不做云端托管版本

## 2. 用户画像与场景

| 用户类型 | 场景 |
|---------|------|
| 个人开发者 | 本机一键启动 AI Agent，与 Claude 对话、文件操作、终端任务 |
| 非技术用户 | 通过飞书/Telegram 等本地 IM Bot 接入 Claude，无需理解 Node/Docker |
| 团队成员 A | 想用 DeepThink 但公司不允许装 Docker，仅需宿主机模式 |

## 3. 关键假设（请审阅时确认或推翻）

> 用户在需求对齐阶段未回答，按推荐默认推进，以下假设可在评审时推翻。

| 编号 | 假设 | 推翻的影响 |
|------|------|------------|
| A1 | 打包技术选用 **Electron**，将现有 Node 后端作为 spawned child process，前端用 BrowserWindow 加载 `http://localhost:3000` | 若选 Tauri，需把 Node 后端打包为 SEA sidecar，原生模块处理复杂度 ↑ |
| A2 | 目标平台覆盖 **macOS（Apple Silicon + Intel）+ Windows x64 + Linux x64**，三平台首期同步发布 | — |
| A3 | 桌面版**不保留 Docker 容器模式**，仅宿主机模式；member 用户、容器隔离特性在桌面版中隐藏（不删除源码，便于服务端复用） | 若保留容器模式，需用户自行装 Docker，门槛未真正降低 |
| A4 | 用户数据目录改为**系统应用数据目录**（mac：`~/Library/Application Support/DeepThink/`；win：`%APPDATA%/DeepThink`；linux：`~/.config/DeepThink/`） | 若保留 `cwd/data`，App 升级会被覆盖，数据丢失 |
| A5 | 桌面版只支持**单用户单工作区**（即 admin 主容器 `folder=main`），多用户/邀请码/RBAC 在桌面版中默认隐藏 | 若保留多用户，UX 需要重新设计登录/切换 |
| A6 | 现有 IM 渠道（飞书/Telegram/QQ/钉钉/微信）**全部保留**，配置走 Web 设置页 | — |
| A7 | 安装包内置 **Claude Agent SDK + 完整 node_modules**，无需用户安装 | 体积 ~150MB |

## 4. 功能需求

### 4.1 核心功能（必做）

| ID | 功能 | 验收标准 |
|----|------|----------|
| F1 | 一键安装包 | macOS `.dmg`、Windows `.exe`（NSIS）、Linux `.AppImage`，双击安装无需任何外部依赖 |
| F2 | 应用启动 | 双击图标启动，2~5 秒内出现主窗口（聊天界面），后台 Node 服务自动拉起 |
| F3 | 首次设置向导 | 复用现有 `/setup` 流程：创建管理员 → 配置 Claude API → （可选）配置 IM |
| F4 | 数据持久化 | 数据落在系统应用数据目录，App 卸载/升级不丢数据；提供"在 Finder/资源管理器中打开"按钮 |
| F5 | 单实例运行 | 已有实例运行时，再次双击图标聚焦到现有窗口而非启动新进程 |
| F6 | 系统托盘 | 关闭窗口最小化到托盘，托盘菜单：显示主窗口 / 退出 / 重启服务 |
| F7 | 自动启动（可选） | 系统登录时自启动开关，默认关 |
| F8 | 内置 Claude Code 运行时 | 完整打包 `@anthropic-ai/claude-agent-sdk` 及其 CLI，无需 `npm install` |
| F9 | 原生模块跨平台预编译 | `better-sqlite3`、`node-pty` 必须按目标平台预编译并随包分发 |
| F10 | 应用自动更新 | 内置更新检查器，启动时检查 GitHub Release，提示用户下载新版本 |
| F11 | 日志查看 | 设置页内置"打开日志目录"按钮，方便排障 |

### 4.2 隐藏/禁用功能

桌面版中以下功能**默认隐藏但不删除**（保留源码以复用于服务端部署）：

- 多用户管理（用户列表/邀请码/RBAC）
- Docker 容器模式、镜像构建 UI
- member 主容器相关逻辑
- 审计日志（单用户场景下意义不大）
- 终端（宿主机模式不支持，已有逻辑）

### 4.3 体验细节

- 启动时窗口显示 loading splash（"正在启动 DeepThink…"），后端 ready 后加载聊天页
- 端口冲突自动避让（3000 被占 → 3001 → 3002…），窗口标题栏显示实际端口
- 后端进程崩溃时弹窗提示并提供"重启应用"按钮
- 菜单栏：DeepThink / 文件 / 视图 / 帮助；快捷键 Cmd/Ctrl+, 打开设置

## 5. 用户流程

### 5.1 首次安装
```
下载 .dmg/.exe → 双击安装 → 拖入 Applications → 启动 App
→ splash 2s → 设置向导（管理员账号 + Claude API）→ 进入聊天主界面
```

### 5.2 日常使用
```
启动 App → 自动拉起后端 → 主窗口显示聊天界面
→ 与 Claude 对话 / 配置 IM 通道 / 文件管理 / 查看任务
→ 关闭窗口 → 最小化到托盘 → 后台保持运行
→ 托盘"退出" → 后端优雅关闭
```

### 5.3 升级
```
App 启动时检查更新 → 有新版本 → 提示下载 → 跳转 Release 页
→ 用户下载新安装包 → 覆盖安装（数据保留）→ 启动新版
```

## 6. 非功能需求

| 维度 | 要求 |
|------|------|
| 安装包体积 | ≤ 200MB（含 node_modules + Claude SDK） |
| 启动时间 | 冷启动 ≤ 5s（从双击到主窗口可交互） |
| 内存占用 | 空载 ≤ 400MB（Electron 基础 + Node 后端 + SQLite） |
| 平台支持 | macOS 12+（Intel + ARM64）、Windows 10+ x64、Ubuntu 20.04+ x64 |
| 代码签名 | macOS Developer ID Application（后续）；Windows EV Code Certificate（后续） |
| 离线可用 | 安装后无需联网即可启动（首次配置 Claude API 需联网验证） |
| 数据迁移 | 提供从源码版（`cwd/data`）导入数据的入口 |

## 7. 度量指标

| 指标 | 目标 |
|------|------|
| 首次启动成功率 | ≥ 95% |
| 安装到首次对话完成时间 | ≤ 10 分钟 |
| 启动崩溃率 | ≤ 1% |
| 用户报告"依赖问题"工单 | 较源码版下降 ≥ 80% |

## 8. 风险与对策

| 风险 | 等级 | 对策 |
|------|------|------|
| 原生模块（better-sqlite3/node-pty）在 Electron 下需 rebuild | 高 | 用 `electron-rebuild` 在打包前预编译；备选 `@electron/rebuild` |
| Claude Agent SDK 内部依赖动态加载（child_process spawn CLI） | 高 | 验证 SDK 在 SEA/Electron packaged 环境下能正常 spawn CLI；保留 `node_modules` 完整结构而非打包成单文件 |
| 安装包体积过大 | 中 | 用 `electron-builder` 的 `files` 字段剔除无关资源（tests/、docs/、screenshots/） |
| macOS 公证（notarization）失败 | 中 | CI 集成 `notarytool`，签名后自动公证 |
| 后端端口冲突 | 中 | 启动时探测端口，自动 +1 重试，BrowserWindow 加载实际端口 |
| 数据目录迁移破坏现有源码版用户 | 中 | 通过环境变量 `DEEPTHINK_DATA_DIR` 覆盖；源码版仍用 `cwd/data`，桌面版注入系统目录 |

## 9. 里程碑

| 阶段 | 交付物 | 工期估计 |
|------|--------|---------|
| M1 PRD & 技术方案评审 | 本文档 + 技术方案 | D1 |
| M2 桌面壳骨架（Electron + 自动拉起后端 + BrowserWindow） | 可启动的 mac .app | D2-D3 |
| M3 数据目录迁移 + 单实例 + 托盘 + splash | 完整桌面体验 | D4 |
| M4 打包链路（electron-builder + CI） | 可分发 .dmg | D5 |
| M5 自动更新 + 数据迁移工具 | 完整可发布 | D6 |
| M6 Windows / Linux 平台验证 | 全平台安装包 | D7-D8 |

## 10. 开放问题

1. ❓ 是否需要"代码签名 / 公证"在 MVP 阶段就做？（影响用户首次安装是否被 Gatekeeper / SmartScreen 拦截）
2. ❓ 自动更新走 GitHub Release 还是自建更新服务？
3. ❓ 是否提供"便携版"（Win 免安装 `.exe`、Linux AppImage）？
