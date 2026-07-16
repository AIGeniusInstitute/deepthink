# 沙箱功能需求补齐 — 测试报告

> 日期：2026-07-16 · 分支：`feat/sandbox-feature-completion`

## 验证结果

| 验证项 | 状态 | 说明 |
|--------|------|------|
| `make typecheck` | ✅ | 后端 + 前端 + agent-runner 三端通过 |
| `make test` | ✅ | 92 文件, 1199 用例, 零回归 |
| `make build` | ✅ | 后端 + 前端(vite + PWA) + agent-runner 全量构建成功 |

## 改动文件清单

| 文件 | 改动 |
|------|------|
| `src/sandbox/manager.ts` | G1(readFile) + G2(resizeTerminal) + G4(markIdle) + G5(statusListeners) + G6(peak_memory_mb) + G7(ttlMinutes) + G8(cdpPort recovery) |
| `src/routes/sandbox.ts` | G1: `GET /sessions/:id/files/read?path=` 路由 |
| `src/web.ts` | G2: `sandbox_terminal_resize` WS 处理 + G5: 注册 statusListener |
| `src/types.ts` | G2: `sandbox_terminal_resize` 加入 `WsMessageIn` 联合类型 |
| `web/src/api/sandbox.ts` | G1: `readFile()` API 方法 |
| `web/src/stores/sandbox.ts` | G2: `resizeTerminal` action |
| `web/src/components/sandbox/SandboxTerminal.tsx` | G2: ResizeObserver 触发 resize 消息 |
| `web/src/components/sandbox/SandboxFileTree.tsx` | G1: 文件点击 → 预览面板 |
| `web/src/components/sandbox/SandboxExecutionList.tsx` | G3: 新组件 — 执行历史列表 |
| `web/src/components/sandbox/SandboxToolbar.tsx` | G3: "执行历史"按钮 + 面板 |

## 功能验收

### G1: 文件内容预览
- [x] `GET /api/sandbox/sessions/:id/files/read?path=` 端点正常
- [x] 路径安全校验（normalize + startsWith + `..` 拒绝）
- [x] 文本扩展名白名单校验
- [x] 100KB 截断返回 `truncated: true`
- [x] 前端 SandboxFileTree 点击文件弹出预览面板
- [x] 预览面板可关闭

### G2: 终端 resize
- [x] `sandbox_terminal_resize` WS 消息类型定义
- [x] 后端 `SandboxManager.resizeTerminal()` 发送 ANSI escape
- [x] 前端 ResizeObserver 触发 resize 消息发送
- [x] `WsMessageIn` 类型包含 `sandbox_terminal_resize`

### G3: 执行历史 UI
- [x] `SandboxExecutionList` 组件渲染执行记录
- [x] 状态图标、语言、耗时、退出码
- [x] 点击展开详情
- [x] 工具栏"执行历史"按钮切换面板

### G4: idle 状态
- [x] `markIdle()` 方法更新 DB status='idle'
- [x] idle timer 触发后先标记 idle 再等 5 分钟后销毁
- [x] 有交互时 idle → running 恢复

### G5: 状态推送
- [x] `statusListeners: Set` 替代单回调
- [x] `addStatusListener()` / `removeStatusListener()` 方法
- [x] WS 层注册 statusListener，广播 `sandbox_status` 消息
- [x] 前端 store 处理 `sandbox_status` 更新 sessions 列表

### G6: peak_memory_mb
- [x] 执行代码后通过 cgroup v2 `memory.peak` 采集
- [x] Fallback 到 cgroup v1 `memory.usage_in_bytes`
- [x] INSERT 语句包含 `peak_memory_mb` 列

### G7: ttlMinutes
- [x] `create()` 读取 `opts.ttlMinutes`
- [x] 自定义 idle 超时（不超过默认 10 分钟）
- [x] 自定义 hard 超时

### G8: cdpPort 恢复
- [x] `get()` 检测 `cdpPort === null` 时尝试 `docker port` 恢复
- [x] 恢复后重建 InMemoryState
- [x] 容器不存在时更新 DB status='stopped'

## 已知限制（未改动）

- 浏览器单订阅限制（P1，已有文档记录）
- `restricted` 网络模式（P2，需 iptables）
- Prometheus 指标（P2）
- SettingsPage 配额调整（P2，当前用环境变量）
- Warm pool 预热（P2）