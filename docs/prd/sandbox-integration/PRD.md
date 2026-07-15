# DeepThink Sandbox 集成 PRD

> 版本：v1.0 · 日期：2026-07-16
> 关联文档：
> - 调研选型：`docs/prd/sandbox/sandbox-research-and-selection.md`
> - 技术方案：`docs/tech_solution/sandbox-integration/SOLUTION.md`
> - 隔离对比：`docs/prd/sandbox/sandbox-isolation-comparison.md`

## 1. 背景

DeepThink 是企业级 Agent SaaS 平台，Agent 在执行任务时经常需要：
1. 运行 LLM 生成或用户提交的代码（Python / Node / Shell）
2. 通过浏览器 UI 自动化验证产物（点击、填表、截图对比）
3. 对执行结果做断言校验

当前 agent-runner 容器虽然自带 Python / Node / Chromium，但**直接在 agent 容器内执行不可信代码**有如下问题：
- 无资源限制：fork bomb / OOM 会拖垮宿主
- 无网络隔离：恶意代码可外泄数据
- 无独立可观测界面：用户看不到 Agent 执行代码/浏览器的实时过程
- 无审计：缺乏 execution_id / 资源用量 / 失败原因归档

调研文档（`docs/prd/sandbox/`）已选定 **Docker + seccomp + cgroups + warm pool** 作为 P0 方案，本 PRD 在此基础上补齐"集成进 DeepThink"与"实时 UI"两条主线。

## 2. 目标

### 2.1 业务目标
- Agent 能通过 MCP 工具调用沙箱执行代码、操作浏览器、获取结果
- 用户能在 `/sandbox` 页面实时看到：沙箱内终端 I/O（xterm.js 渲染）、沙箱内浏览器画面（CDP 截图流）
- 沙箱执行完即销毁，资源用量与审计日志持久化

### 2.2 非目标（P0 不做）
- 不做 Firecracker microVM（留 P2）
- 不做 Playwright + noVNC 完整远程桌面（P0 用 CDP 截图流）
- 不做 per-tenant 配额计费（留 P1）
- 不做多语言扩展（P0 支持 Python / Node / Shell）

## 3. 用户故事

### Story 1：Agent 在沙箱内验证生成的代码
> 作为 DeepThink 用户，我在和 Agent 对话时让它写一段 Python 数据处理脚本，Agent 写完后**自动在沙箱内执行**，我可以在 `/sandbox` 页面看到执行过程、stdout、最终结果。Agent 拿到结果后判断是否符合预期，不符合则继续修改。

**验收**：
- Agent 调用 `sandbox_run_code(language="python", code="...")` MCP 工具
- 前端 `/sandbox` 页面看到终端实时打印 stdout/stderr
- 工具返回 `{ status, exit_code, stdout, stderr, duration_ms }`
- 沙箱实例执行完销毁，无残留容器

### Story 2：Agent 在沙箱内做浏览器 UI 自动化
> 作为 DeepThink 用户，我让 Agent 验证某个网页的登录流程是否正常，Agent 在沙箱内启动 headless Chromium，导航到 URL，填用户名密码，点击登录，截图回传，对照预期。

**验收**：
- Agent 调用 `sandbox_browser_navigate(url)` → `sandbox_browser_click(selector)` → `sandbox_browser_screenshot()`
- 前端 `/sandbox` 页面右侧实时看到沙箱内 Chromium 的画面（≥2 fps）
- 工具返回 `{ status, screenshot_url, url, title }`

### Story 3：用户手动在沙箱里跑命令调试
> 作为开发者，我想直接在 `/sandbox` 页面打开一个交互式终端，输入 `python3 -c "print(1)"`，看到输出。无需走 Agent。

**验收**：
- 进入 `/sandbox` 页面，点击"新建沙箱"
- 左侧 xterm.js 终端启动，可输入 shell 命令实时交互
- 右侧浏览器面板可选择"无浏览器"或"启动 Chromium"
- 会话保持直到用户关闭或 10 分钟空闲超时

## 4. 功能需求

### FR-1：沙箱生命周期管理
- **创建沙箱**：POST `/api/sandbox/sessions`，可选参数 `{ language, browser_enabled, ttl_minutes }`
- **列出沙箱**：GET `/api/sandbox/sessions`，返回当前用户的活跃沙箱
- **销毁沙箱**：DELETE `/api/sandbox/sessions/:id`，立即 `docker rm -f`
- **空闲超时**：默认 10 分钟无 I/O 自动销毁
- **硬超时**：默认 30 分钟强制销毁（防常驻）

### FR-2：代码执行
- **运行代码**：POST `/api/sandbox/sessions/:id/execute`，body `{ language, code, stdin, timeout_ms }`
- **支持语言**：python / node / sh
- **返回**：`{ status, exit_code, stdout, stderr, duration_ms, truncated }`
- **输出限制**：stdout/stderr 各 1MB 截断，`truncated=true` 标识

### FR-3：浏览器自动化
- **启动浏览器**：POST `/api/sandbox/sessions/:id/browser/start`
- **导航**：POST `/api/sandbox/sessions/:id/browser/navigate` body `{ url }`
- **点击**：POST `/api/sandbox/sessions/:id/browser/click` body `{ selector }`
- **输入**：POST `/api/sandbox/sessions/:id/browser/type` body `{ selector, text }`
- **截图**：POST `/api/sandbox/sessions/:id/browser/screenshot` → 返回 PNG data URL
- **执行 JS**：POST `/api/sandbox/sessions/:id/browser/evaluate` body `{ script }`
- **关闭浏览器**：POST `/api/sandbox/sessions/:id/browser/stop`

### FR-4：实时 UI（WebSocket）
- **终端流**：WS 消息 `{ type: 'sandbox_terminal_start', sessionId }` → 服务端 spawn `docker exec -i sandbox-<id> sh` 通过 node-pty，输出通过 `{ type: 'sandbox_terminal_output', sessionId, data }` 回传
- **浏览器流**：当浏览器启动后，服务端每 500ms 通过 CDP `Page.captureScreenshot` 抓 PNG，通过 `{ type: 'sandbox_browser_frame', sessionId, dataUrl }` 推送（≥2 fps）
- **状态变更**：`{ type: 'sandbox_status', sessionId, status: 'created|running|idle|stopped|error' }`

### FR-5：Agent MCP 工具
- `sandbox_run_code(language, code, stdin?, timeout_ms?)` → 在新沙箱或当前沙箱执行代码
- `sandbox_browser_navigate(url)` → 启动浏览器并导航
- `sandbox_browser_click(selector)` / `sandbox_browser_type(selector, text)` / `sandbox_browser_screenshot()` / `sandbox_browser_evaluate(script)`
- `sandbox_close()` → 销毁当前 agent 关联的沙箱

### FR-6：安全约束（P0 核心，来自调研文档 §3.4）
- `--user 1000:1000` 非 root
- `--read-only` rootfs 只读
- `--tmpfs /workspace:rw,size=256m` + `--tmpfs /tmp:rw,size=64m`
- `--network=none` 默认禁网
- `--security-opt no-new-privileges`
- `--security-opt seccomp=<profile>` default deny
- `--cap-drop ALL`
- `--memory=512m --memory-swap=512m --cpus=1 --pids-limit=64`
- `--ulimit nofile=128:128 nproc=64:64 fsize=524288:524288`
- `--init` 回收僵尸
- `--stop-signal=TERM --stop-timeout=2`

## 5. 非功能需求

### NFR-1：性能
- 冷启动（创建容器 → 可接受首个 execute 请求）p95 < 3s
- 浏览器首帧截图延迟 < 5s
- 终端首字节延迟 < 200ms

### NFR-2：并发
- 单 DeepThink 实例最大并发沙箱 = 10（可通过 SettingsPage 调整）
- 每用户最大并发沙箱 = 3

### NFR-3：可观测
- 每个沙箱 execution 写入审计日志：`execution_id / user_id / session_id / language / status / exit_code / cpu_ms / peak_mem_mb / timestamp`
- Prometheus 指标：`sandbox_active_sessions`、`sandbox_executions_total{status}`、`sandbox_duration_seconds`

### NFR-4：兼容
- macOS 本地开发：Docker Desktop 可跑
- Linux 生产：docker-ce
- 沙箱镜像独立于 agent-runner 镜像，互不污染

## 6. 数据模型

新增 SQLite 表（Schema v51）：

```sql
CREATE TABLE sandbox_sessions (
  id TEXT PRIMARY KEY,                  -- usid
  user_id INTEGER NOT NULL,
  container_name TEXT NOT NULL,         -- sandbox-<usid>
  language TEXT DEFAULT 'python',
  browser_enabled INTEGER DEFAULT 0,
  status TEXT DEFAULT 'created',        -- created|running|idle|stopped|error
  created_at INTEGER NOT NULL,
  last_active_at INTEGER NOT NULL,
  stopped_at INTEGER,
  stopped_reason TEXT
);
CREATE INDEX idx_sandbox_sessions_user ON sandbox_sessions(user_id, status);

CREATE TABLE sandbox_executions (
  id TEXT PRIMARY KEY,                  -- exec_id
  session_id TEXT NOT NULL,
  user_id INTEGER NOT NULL,
  language TEXT NOT NULL,
  code_hash TEXT NOT NULL,              -- sha256，不存原文
  status TEXT NOT NULL,                -- completed|timeout|oom|killed|error
  exit_code INTEGER,
  stdout_bytes INTEGER,
  stderr_bytes INTEGER,
  truncated INTEGER DEFAULT 0,
  duration_ms INTEGER,
  peak_memory_mb INTEGER,
  FOREIGN KEY (session_id) REFERENCES sandbox_sessions(id)
);
CREATE INDEX idx_sandbox_executions_session ON sandbox_executions(session_id, created_at);
```

## 7. UI / 交互

### 7.1 路由
- `/sandbox` — 沙箱管理主页（左侧会话列表 + 右侧双面板）
- 已登录用户均可访问

### 7.2 页面布局
```
┌────────────────────────────────────────────────────────────┐
│ [新建沙箱] [刷新]  沙箱列表                                  │
├──────────┬─────────────────────────────────────────────────┤
│ 会话列表 │  ┌─终端─────────────────┐ ┌─浏览器─────────────┐│
│ #1 py   │  │ $ python3            │ │ [截图流]            ││
│ #2 node │  │ >>> print('hi')      │ │                     ││
│ #3 (none)│ │ hi                   │ │                     ││
│         │  │ _                    │ │                     ││
│         │  └──────────────────────┘ └─────────────────────┘│
└──────────┴─────────────────────────────────────────────────┘
```

### 7.3 组件
- `SandboxList`：左侧会话卡片列表，显示 ID、语言、状态、空闲倒计时
- `SandboxTerminal`：xterm.js + fit addon，WS 连接 `sandbox_terminal_*`
- `BrowserView`：图片轮播（last dataUrl），右下角显示 fps 与延迟
- `SandboxToolbar`：新建按钮、语言选择、浏览器开关、销毁按钮

## 8. 验收清单

P0 验收（必须全部通过）：
- [ ] `make typecheck` 三端通过
- [ ] `make test` 既有测试不回归
- [ ] 沙箱镜像构建成功：`docker build -t deepthink-sandbox:latest container/sandbox/`
- [ ] POST `/api/sandbox/sessions` 创建沙箱返回 200，container 出现在 `docker ps`
- [ ] POST `/api/sandbox/sessions/:id/execute` python `print('hi')` 返回 stdout="hi\n"
- [ ] fork bomb 测试（`while True: os.fork()`）被 pids-limit 杀掉，status=oom
- [ ] 死循环测试（`while True: pass`）被 wall timeout 终止，status=timeout
- [ ] 网络请求测试（`urllib.urlopen`）失败，status=error
- [ ] stdout 超过 1MB 截断，truncated=true
- [ ] 浏览器 navigate + screenshot 返回非空 PNG data URL
- [ ] 前端 `/sandbox` 页面打开后，xterm.js 终端可交互输入 `echo hi` 看到回显
- [ ] 浏览器启动后，右侧面板 ≥2 fps 显示画面
- [ ] DELETE `/api/sandbox/sessions/:id` 后容器从 `docker ps` 消失
- [ ] 空闲 10 分钟自动销毁
- [ ] 审计日志写入 `sandbox_executions` 表

## 9. 风险与缓解

| 风险 | 缓解 |
|------|------|
| Docker Desktop macOS 不可用 | 提供 fallback：开发模式跳过沙箱，返回 mock 结果（仅本地 dev） |
| CDP 截图流带宽大 | 默认 500ms / 帧，可降级到 2s；JPEG 质量 60；可手动暂停 |
| 沙箱镜像构建慢 | 镜像独立构建脚本 `container/sandbox/build.sh`，与主镜像解耦 |
| node-pty 在某些环境不可用 | 复用 `terminal-manager.ts` 已有的 pipe fallback 机制 |
| Agent 滥用沙箱 | 单 agent 会话最多 1 个并发沙箱，10 分钟空闲强制销毁 |

## 10. 落地路线

| 阶段 | 内容 | 时长 |
|------|------|------|
| **P0**（本次） | 代码执行 + 浏览器自动化 + 实时 UI + MCP 工具 + 安全约束 + 审计 | 当前 PR |
| **P1** | per-user 配额、Prometheus、warm pool 预热 | 后续 |
| **P2** | 切 gVisor (`--runtime=runsc`) 或 Firecracker | 威胁升级触发 |
