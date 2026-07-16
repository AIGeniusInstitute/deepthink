# 沙箱面板嵌入 Chat 对话框右侧 + 实时联动 + 中文字体修复

## 1. 背景

DeepThink 已有完整沙箱能力（`/sandbox` 独立页面、7 个 `sandbox_*` MCP 工具、Docker 镜像 `deepthink-sandbox:latest`、BrowserController 帧推送链路），但当前存在三个用户痛点：

1. **沙箱与对话割裂**：agent 在对话框里调用 `sandbox_browser_navigate` 等工具时，用户必须切换到独立 `/sandbox` 页面才能看到浏览器状态，对话和执行视图分离，体验中断。
2. **执行过程不直观**：agent 在沙箱里写文件、执行脚本时，用户看不到终端实时输出和文件目录树变化，难以感知 agent 实际在做什么。
3. **中文方框 bug**：沙箱 Chromium 截图里，所有中文字符显示为 `.notdef` 方框（□），原因是 `container/sandbox/Dockerfile` 只装了 `fonts-liberation` 和 `fonts-noto-color-emoji`，缺少任何中文字体包。

## 2. 目标

| # | 目标 | 验收标准 |
|---|------|---------|
| G1 | 沙箱面板嵌入 Chat 右侧 | ChatView 侧边栏新增「沙箱」tab，点开即看到浏览器/终端/文件树三视图 |
| G2 | agent 工具调用实时联动 | agent 调 `sandbox_browser_*` 时右侧 BrowserView 自动订阅帧流并刷新；调 `sandbox_run_code` 时 Terminal 显示输出；文件树自动刷新 |
| G3 | 中文字体正常渲染 | 沙箱浏览器截图里中文字符正常展示，无方框 |
| G4 | 不破坏现有 `/sandbox` 独立页 | 独立页功能保持，chat 嵌入是新增能力 |
| G5 | 不引入新的 StreamEventType | 复用 `tool_progress` + `toolInput` 承载 sandbox 元数据，保持 `shared/stream-event.ts` 单一真相源 |

## 3. 用户故事

### 故事 1：浏览器操作实时可见
用户在 `/chat/main` 与 agent 对话："帮我打开百度地图搜索杭州璞睿生命科技"。
- agent 调 `sandbox_browser_navigate('https://map.baidu.com/search?query=...')`
- Chat 右侧沙箱面板自动展开 BrowserView，实时显示浏览器帧流（250ms/帧 JPEG）
- 截图里中文字符正常显示「百度地图」「杭州璞睿生命科技」
- agent 调 `sandbox_browser_screenshot` 后，最终截图也写入 `downloads/sandbox/` 可在文件面板预览

### 故事 2：代码执行 + 终端输出
用户："在沙箱里跑一段 Python 打印 1 到 10"。
- agent 调 `sandbox_run_code(language='python', code='...')`
- 右侧沙箱面板自动切换到 Terminal tab，显示执行过程（stdout/stderr 实时流式）
- 执行完成后 Terminal 保留输出，可滚动查看

### 故事 3：文件目录树可视化
用户："在沙箱 /workspace 下创建 hello.py 并写入代码"。
- agent 通过 `sandbox_run_code` 或 `sandbox_browser_evaluate` 写入文件
- 右侧沙箱面板文件树 tab 每 5s 自动刷新，显示 `/workspace` 下的文件结构
- 点击文件可在右侧预览内容

### 故事 4：独立页保持可用
运维用户直接访问 `/sandbox`，仍可手动创建沙箱、执行代码、启动浏览器，行为不变。

## 4. 非目标 (Out of Scope)

- 不新增 StreamEventType（如 `sandbox_browser_frame`）到 `shared/stream-event.ts`，避免破坏类型同步机制
- 不改造 `BrowserController` 帧推送链路（仍走 WS `sandbox_browser_frame` 消息）
- 不改造 `SandboxManager` / `security.ts` / Docker 安全参数
- 不支持多 agent 同时操作同一沙箱（保持 P0: single subscriber per session 限制）
- 不在沙箱镜像里安装完整 `fonts-noto-cjk`（370MB 太大，选 `fonts-wqy-zenhei` 16MB 足够覆盖常用 CJK）

## 5. 功能需求

### F1. ChatView 侧边栏新增 sandbox tab

- `web/src/components/chat/ChatView.tsx` 的 `SIDEBAR_TABS` 数组（line 36-43）新增 `{id:'sandbox', icon: Globe, label:'沙箱'}`。
- 侧边栏 tab content 分支新增 `sidebarTab === 'sandbox' ? <SandboxPanel groupJid={groupJid} /> : null`。
- 新建 `web/src/components/sandbox/SandboxPanel.tsx` 组件，作为 chat 右侧的沙箱面板容器。

### F2. SandboxPanel 组件结构

```
SandboxPanel
├── SandboxPanelHeader  (显示当前 sessionId、agent 状态、刷新按钮)
├── 视图切换 tabs: [浏览器 | 终端 | 文件树]
├── BrowserView  (复用现有组件，传 sessionId)
├── SandboxTerminal  (复用现有组件，传 sessionId)
└── SandboxFileTree  (新组件，REST 拉取 /workspace 目录树)
```

- 当 agent 调用 `sandbox_browser_*` 工具时，自动切到「浏览器」tab。
- 当 agent 调用 `sandbox_run_code` 时，自动切到「终端」tab。
- 文件树 tab 不自动切换，用户主动点击。

### F3. per-agent sessionId 关联

- 后端新增 `GET /api/sandbox/by-group/:groupFolder` REST 端点，返回当前 group 绑定的 sandbox sessionId（从 `sessions.sandbox_session_id` 列查）。
- 前端 SandboxPanel 挂载时调此端点，若无 sessionId 则显示「Agent 未使用沙箱」空状态。
- 当 agent 首次调 `sandbox_*` 工具时，host 通过 `resolveSandboxId` 创建沙箱并 `broadcastStreamEvent` 通知前端 sessionId 已就绪。

### F4. agent 工具调用联动

- host `src/index.ts` `handleSandboxIpc` 在完成 `sandbox_browser_navigate/click/type/screenshot/evaluate` 操作后，额外 `broadcastStreamEvent(chatJid, {eventType:'tool_progress', toolName, toolUseId, toolInput:{sandboxSessionId: sid, action, url?, screenshot?}})`。
- 前端 chat store `applyStreamEvent` 的 `tool_progress` 分支识别 `toolName.startsWith('sandbox_browser')` 或 `toolName === 'sandbox_run_code'`，从 `event.toolInput.sandboxSessionId` 取 sid，调 `useSandboxStore.getState().focusSession(sid)` 切换当前 sessionId 并触发 BrowserView 订阅帧流。
- chat 页面也需要 wire `useSandboxStore.wireWsHandlers()`（目前只在 SandboxPage 里 wire）。

### F5. 文件树 REST 端点

- 新增 `GET /api/sandbox/sessions/:id/files?path=/workspace` REST 端点。
- 后端通过 `docker exec <container> ls -la --time-style=long-iso <path>` 列目录，解析为 `{name, type:'file'|'dir', size, mtime}[]` 返回。
- 前端 `SandboxFileTree` 组件递归展开子目录（点击节点 lazy load）。
- 默认 5s 自动刷新根目录（仅展开的节点），非根目录不自动刷新。

### F6. 中文字体修复

- `container/sandbox/Dockerfile` apt install 列表新增 `fonts-wqy-zenhei`（文泉驿正黑，~16MB，覆盖常用简繁中日韩 CJK 字符）。
- 重建镜像 `make sandbox-build` 后，新创建的沙箱自动使用新镜像，Chromium 渲染 CJK 时回退到 wqy-zenhei 字体，不再显示方框。
- 现有运行中的沙箱需销毁重建才会生效（`manager.create` 每次重新 `docker run` 拉镜像层）。

## 6. 技术约束

- 不新增 StreamEventType 到 `shared/stream-event.ts`，复用 `tool_progress`。
- 不改动 `SandboxManager` / `BrowserController` / `security.ts` / `config.ts` 核心逻辑。
- 不改动 `/sandbox` 独立页的现有行为。
- `SandboxPanel` 必须复用 `BrowserView` / `SandboxTerminal` 组件，不重复实现。
- `useSandboxStore` 扩展为支持多 sessionId 帧索引（`browserFrames: Record<sessionId, string>`），避免 chat 多 group 切换时帧互相覆盖。
- 所有改动通过 `make typecheck` + `make test` + `make build`，不引入回归。

## 7. 验收测试

| 测试项 | 通过标准 |
|--------|---------|
| T1 typecheck | `make typecheck` 三端全绿 |
| T2 vitest | `make test` 1187+ 用例全过，无回归 |
| T3 镜像构建 | `make sandbox-build` 成功，镜像含 `fonts-wqy-zenhei` |
| T4 中文字体 | 启动新沙箱，浏览器导航到 `https://www.baidu.com`，截图里「百度」二字正常显示 |
| T5 chat 沙箱 tab | `/chat/main` 右侧侧边栏出现「沙箱」tab，点开显示空状态或当前 sessionId |
| T6 联动 | agent 调 `sandbox_browser_navigate` 后，右侧 BrowserView 自动展开并显示帧 |
| T7 终端联动 | agent 调 `sandbox_run_code` 后，右侧自动切到 Terminal tab 并显示输出 |
| T8 文件树 | 文件树 tab 能展示 `/workspace` 下文件结构，点击目录可展开 |
| T9 独立页回归 | `/sandbox` 独立页功能完全正常 |

## 8. 风险与对策

| 风险 | 对策 |
|------|------|
| wqy-zenhei 字体覆盖不全（生僻字仍方框） | 用户可后续追加 noto-cjk，本期不处理 |
| chat 多 group 切换时帧串台 | store 改 `browserFrames: Record<sessionId, string>` 按 sessionId 索引 |
| host 推 tool_progress 过频影响性能 | 仅在 sandbox 工具完成时推一次，不流式推 |
| 文件树轮询 docker exec 开销 | 5s 间隔 + 仅展开节点刷新，根目录默认展开 |
| 浏览器单订阅限制 | chat 右侧订阅时若已有 SandboxPage 订阅，host 端复用 onFrame 回调（`setOnFrame` 已支持） |

## 9. 里程碑

| 阶段 | 内容 | 预计 |
|------|------|------|
| M1 字体修复 | Dockerfile + 镜像重建 | 0.5h |
| M2 后端 | `GET /api/sandbox/by-group/:groupFolder` + `GET /api/sandbox/sessions/:id/files` + host `handleSandboxIpc` 推 tool_progress | 1.5h |
| M3 前端 | SandboxPanel + SandboxFileTree + useSandboxStore 多 sessionId 帧索引 + chat store 联动 | 3h |
| M4 测试 | typecheck + vitest + 镜像构建 + 手动 E2E | 1h |
| M5 文档 + 合并 | 测试报告 + commit + merge to main + push | 0.5h |

总计约 6.5h。
