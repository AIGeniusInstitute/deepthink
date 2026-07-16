# PRD: Sandbox 浏览器操作迁移到 Playwright + P1 待办收尾

## 背景

P0 沙箱集成（commit `b703970`）已上线，浏览器操作用手写 CDP（WebSocket + Runtime.evaluate）。手写 CDP 存在以下问题：
- 缺少自动等待元素可见/可点击，需要 Agent 手写 sleep
- 选择器策略单一（仅 CSS），失败诊断不友好
- 截图、evaluate、frame 流异常处理粗糙
- 维护成本高（约 250 行手写 CDP 协议代码）

同时 P0 标记了 3 项 P1 待办：
- a. 沙箱镜像构建未集成到 `make` 流程
- b. 浏览器沙箱网络 egress 白名单
- c. cloudcli-browser MCP UI E2E 走查

本需求完成上述全部工作。

## 目标

1. **核心**：将 `src/sandbox/browser.ts` 的手写 CDP 替换为 Playwright API（`chromium.connectOverCDP`），对外接口不变（manager.ts / src/index.ts IPC handler / 7 个 MCP 工具签名零改动）。
2. **P1.a**：沙箱镜像构建集成到 `make` 流程，`make dev` / `make start` 自动检测并构建 `deepthink-sandbox:latest`。
3. **P1.b**：浏览器沙箱网络模式可选（`bridge` / `none`），覆盖"完全禁网但仍可被 Playwright 操控"场景。`restricted` 模式跨平台复杂度过高，推迟 P2。
4. **P1.c**：cloudcli-browser MCP 不可用，UI E2E 走查跳过，记录为已知限制。

## 用户故事

### 故事 1：Agent 用 Playwright 操控沙箱浏览器
Agent 调用 `sandbox_browser_navigate` → `sandbox_browser_click` → `sandbox_browser_screenshot` 时，主进程通过 Playwright `chromium.connectOverCDP` 操控沙箱内 Chromium，元素自动等待可见后点击，截图分辨率/质量稳定。

### 故事 2：开发者用 make 一键构建沙箱镜像
开发者克隆仓库后，`make dev` 自动检测 `deepthink-sandbox:latest` 是否存在或源码（Dockerfile/entry.sh/seccomp-profile.json）是否变更，自动调用 `./container/sandbox/build.sh`。

### 故事 3：Agent 在禁网沙箱内做浏览器自动化
Agent 创建 `browserEnabled=true` 沙箱，配置 `SANDBOX_BROWSER_NETWORK=none`，沙箱完全禁网，但 Playwright 仍可通过 CDP 操控页面，用于 `about:blank` + `page.setContent()` 场景（本地 HTML 测试）。

## 功能需求

### FR-1 Playwright 替换 BrowserController
- 安装 `playwright-core`（不下载浏览器二进制）
- 重写 `src/sandbox/browser.ts`：
  - `start(onFrame, intervalMs, initialUrl?)`：`ensureChromiumRunning` → `chromium.connectOverCDP(wsEndpoint)` → 默认 BrowserContext → 第一个 Page → 若 `initialUrl` 则 navigate
  - `navigate(url)`：`page.goto(url, { waitUntil: 'load', timeout: 30_000 })`
  - `click(selector)`：`page.click(selector, { timeout: 10_000 })`
  - `type(selector, text)`：`page.fill(selector, text)`
  - `screenshot()`：`page.screenshot({ type: 'png' })` → 返回 data URL
  - `evaluate(expression)`：`page.evaluate(expression)`
  - `getTitle()` / `getCurrentUrl()`
  - `stop()`：`browser.close()` + `docker exec pkill chromium`
  - 帧流：`setInterval(() => page.screenshot({ type: 'jpeg', quality: 60 }), intervalMs)`
- 选择器透传给 Playwright（支持 `css=` / `text=` / `xpath=` 前缀，CSS 默认）

### FR-2 Makefile 集成沙箱镜像构建
- 新增 target `sandbox-build`：调用 `./container/sandbox/build.sh`
- 新增内部 target `_ensure-sandbox-image`：检测 `deepthink-sandbox:latest` 是否存在或源码变更，自动重建
- `dev` / `start` 调用 `_ensure-sandbox-image`
- 新增 sentinel `.sandbox-docker-build-sentinel`
- `clean` target 增加清理 sentinel
- 源码列表：`container/sandbox/Dockerfile container/sandbox/entry.sh container/sandbox/seccomp-profile.json`

### FR-3 浏览器沙箱网络模式可选
- 新增 `src/sandbox/config.ts` 常量 `BROWSER_NETWORK_MODE`（默认 `bridge`，可选 `none`）
- 修改 `src/sandbox/security.ts` `buildDockerRunArgs`：
  - `bridge` 模式（默认）：保持当前 `-p 127.0.0.1::9222`（无 `--network=none`）
  - `none` 模式：`--network=none` + `-p 127.0.0.1::9222`（Docker 允许此组合）
- `validateSecurityArgs` 适配：browser 模式下 `--network=none` 或 `-p 127.0.0.1::9222` 任一存在即可通过

## 非功能需求

### NFR-1 接口零破坏
- `BrowserController` 对外方法签名（navigate/click/type/screenshot/evaluate/getTitle/getCurrentUrl/start/stop）保持不变
- `SandboxManager.startBrowser/stopBrowser/getBrowser` 不变
- 7 个 MCP 工具签名不变
- `src/index.ts` `handleSandboxIpc` 不变
- 前端 `web/src/stores/sandbox.ts` / `BrowserView.tsx` 不变（帧 data URL 协议不变）

### NFR-2 安全加固不退化
- 浏览器沙箱 `none` 模式：`--network=none` 真正禁网
- `--cap-drop ALL` / seccomp / `--read-only` / `--user 1000:1000` / 资源限制全保留
- Playwright 在主进程运行（不在容器内），通过 CDP 操控，不增加容器内攻击面

### NFR-3 跨平台
- macOS / Linux 均可运行（Playwright connectOverCDP 跨平台一致）
- 沙箱镜像构建无需修改（chromium 已装）

## 数据模型

无 DB schema 变更。

## 验收清单

- [ ] `playwright-core` 安装到 root package.json，`node_modules` 内存在
- [ ] `src/sandbox/browser.ts` 重写为 Playwright，无 `import { WebSocket } from 'ws'` 残留
- [ ] `make typecheck` 三端通过
- [ ] `make test` 全量通过，新增 `browser network=none` 测试用例通过
- [ ] `make sandbox-build` 命令可执行
- [ ] `make dev` / `make start` 自动检测并构建沙箱镜像
- [ ] 容器实测：构建镜像 → 启动浏览器沙箱 → Playwright navigate + screenshot 成功，截图非空 PNG
- [ ] 文档三段式（PRD + SOLUTION + REPORT）齐全

## 风险与权衡

| 风险 | 影响 | 缓解 |
|------|------|------|
| Playwright `connectOverCDP` 版本与沙箱 Chromium 不兼容 | 浏览器无法启动 | 锁定 `playwright-core@1.61.1`，沙箱镜像 chromium 由 Debian 12 bookworm 仓库提供（版本 119+，CDP 协议向后兼容） |
| Playwright 帧截图性能不如手写 CDP JPEG | CPU 占用上升 | 保留 JPEG quality=60 + 500ms 间隔；性能不达标可改用 `page.screenshot({ type: 'jpeg', quality: 40 })` |
| `--network=none` + `-p 127.0.0.1::9222` 组合 Docker 行为不一致 | 端口映射失效 | 已确认 Docker 允许此组合（`-p` 隐式创建 loopback 端口转发，不依赖容器网络栈） |
| Playwright 包体积 | 安装时间增加 | `playwright-core` 仅 ~10MB（无浏览器二进制） |

## Roadmap

- **P1（本需求）**：Playwright 替换 + make 集成 + network mode 可选
- **P2（后续）**：
  - `restricted` 网络模式（自定义 Docker network + iptables egress 白名单，需 Linux 宿主）
  - cloudcli-browser MCP 恢复后补 UI E2E
  - Playwright 录屏（video recording）支持，方便 Agent 调试回放
