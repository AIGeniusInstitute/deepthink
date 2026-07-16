# 沙箱功能需求补齐 — 技术方案

> 日期：2026-07-16 · 关联 PRD：`docs/prd/sandbox-feature-completion/PRD.md`

## 改动清单

共 8 项改动，涉及 6 个文件。所有改动通过 `make typecheck` + `make test` 验证。

---

### G1: 文件内容读取

**文件**：
- `src/sandbox/manager.ts` — 新增 `readFile()` 方法
- `src/routes/sandbox.ts` — 新增 `GET /sessions/:id/files/read?path=` 路由
- `web/src/components/sandbox/SandboxFileTree.tsx` — 文件点击 → 预览面板

**后端**：
- `readFile(sessionId, path)`：`docker exec -u 1000:1000 <container> cat <path>`，限制 100KB，文本扩展名白名单
- 路径安全：复用现有 `path.posix.normalize` + `startsWith('/workspace')` 校验

**前端**：
- `SandboxFileTree` 新增 `selectedFile` 状态 + `fileContent` 状态
- 点击文件节点 → 调用新 API → 右侧展开预览面板
- 预览面板可关闭

---

### G2: 终端 resize

**文件**：
- `src/sandbox/manager.ts` — 新增 `resizeTerminal()` 方法
- `src/web.ts` — 新增 `sandbox_terminal_resize` WS 消息处理
- `web/src/stores/sandbox.ts` — 新增 `resizeTerminal` action
- `web/src/components/sandbox/SandboxTerminal.tsx` — ResizeObserver 触发 resize

**后端**：
- `resizeTerminal(sessionId, cols, rows)`：向 `state.terminalProcess.stdin` 写入 ANSI escape `\x1b[8;${rows};${cols}t`

**前端**：
- `SandboxTerminal` 的 ResizeObserver 回调中，在 `fitAddon.fit()` 后发送 `sandbox_terminal_resize` WS 消息

---

### G3: 执行历史 UI

**文件**：
- `web/src/components/sandbox/SandboxExecutionList.tsx` — 新组件
- `web/src/components/sandbox/SandboxToolbar.tsx` — 新增"执行历史"按钮

**前端**：
- 调用 `GET /api/sandbox/sessions/:id/executions`（已有）
- 列表：状态图标、语言、耗时、退出码、stdout 摘要
- 点击展开：完整 stdout/stderr

---

### G4+G5: idle 状态 + 状态推送

**文件**：
- `src/sandbox/manager.ts` — 修改 `touch()` 和 `create()`，新增 `markIdle()`
- `src/web.ts` — 注册 `onStatusChange` 回调

**后端**：
- `touch()`：idle timer 触发时调用 `markIdle()` 而非直接 `destroy()`
- 新增 `markIdle(sessionId)`：更新 DB status='idle'，调用 `onStatusChange`，启动第二个 timer 在 5 分钟后真正销毁
- `create()` 后调用 `onStatusChange?.('running')`
- `destroy()` 保持调用 `onStatusChange?.('stopped')`
- WS 层：在 `sandbox_browser_subscribe` 和 `sandbox_terminal_start` 处理中注册 `onStatusChange` 回调，广播 `sandbox_status` 消息

**注意**：`onStatusChange` 是 per-session 单回调，需要改为支持多个 subscriber。方案：改为回调数组，或让 WS 层在 `sandbox_status` 广播时检查所有连接的 WS 客户端。

实际方案更简单：在 `sandbox_browser_subscribe` 和 `sandbox_terminal_start` 时注册回调，但使用 `broadcastToAll` 模式。由于 `onStatusChange` 是单回调，我们改为在 manager 层维护一个 `Set<callback>`，或在 WS 层用一个独立的 `Map<sessionId, Set<ws>>` 追踪。

最终方案：在 `web.ts` 的 WS 消息处理中，添加一个模块级 `Map<sessionId, Set<WebSocket>>` 追踪哪些 WS 客户端关心哪个沙箱的状态。在 `sandbox_browser_subscribe` 和 `sandbox_terminal_start` 时注册。`onStatusChange` 改为接受回调数组。

**简化方案**：在 `manager.ts` 中，将 `onStatusChange` 改为 `Set<callback>`，`onStatusChange()` 方法改为 `addStatusListener()`，`removeStatusListener()`。在 WS 处理中注册/注销。

---

### G6: peak_memory_mb 采集

**文件**：
- `src/sandbox/manager.ts` — 修改 `_doExecute()`

**方案**：
- 在代码执行完成后，通过 `docker exec <container> cat /sys/fs/cgroup/memory.peak` 获取峰值内存（cgroup v2）
- Fallback：`docker exec <container> cat /sys/fs/cgroup/memory/memory.usage_in_bytes`（cgroup v1）
- 如果都失败，`peak_memory_mb` 保持 NULL
- 写入 `sandbox_executions.peak_memory_mb`

---

### G7: ttlMinutes 支持

**文件**：
- `src/sandbox/manager.ts` — 修改 `create()`

**方案**：
- 在 `create()` 中读取 `opts.ttlMinutes`
- 如果传入且在 1-60 范围内，覆盖 `IDLE_TIMEOUT_MS` 和 `HARD_TIMEOUT_MS`
- 硬超时 = `ttlMinutes * 60 * 1000`，空闲超时 = `Math.min(ttlMinutes * 60 * 1000, 10 * 60 * 1000)`（不超过 10 分钟）

---

### G8: cdpPort 重启恢复

**文件**：
- `src/sandbox/manager.ts` — 修改 `get()` 方法

**方案**：
- `get()` 检测到内存中无状态 且 DB 行 `browserEnabled=1` 且 `status != 'stopped'` 时
- 尝试通过 `docker port <containerName> 9223/tcp` 恢复 cdpPort
- 恢复后重建 `InMemoryState`（仅 session 信息，不恢复 timer/browser，因为进程已丢失）
- 如果容器已不存在（docker port 失败），更新 DB status='stopped'

---

## 验证方案

```bash
make typecheck  # 三端类型检查
make test       # vitest 全量，不引入回归
make build      # 构建验证
```

手动验证：
- `curl -s localhost:9898/api/sandbox/sessions` 验证创建和列表
- 创建沙箱后执行代码，检查 `sandbox_executions.peak_memory_mb` 有值
- 创建沙箱时传 `ttlMinutes: 5`，验证 5 分钟后自动销毁
- 在前端 `/sandbox` 页面创建沙箱，点击文件验证预览
- 拖动终端面板验证 resize 生效
- 点击"执行历史"按钮验证列表