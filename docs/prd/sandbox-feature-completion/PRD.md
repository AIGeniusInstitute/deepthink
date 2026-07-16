# 沙箱功能需求补齐 PRD

> 版本：v1.0 · 日期：2026-07-16
> 关联：sandbox-integration / sandbox-playwright / sandbox-chat-inline

## 1. 背景

DeepThink 沙箱功能经过三期迭代（sandbox-integration → sandbox-playwright → sandbox-chat-inline），核心代码执行 + 浏览器自动化 + 实时 UI 已可用。但通过代码审查发现 **16 项功能缺口**，其中多项直接影响用户体验和 PRD 验收标准。本需求补齐这些缺口。

## 2. 目标

将沙箱功能从"基本可用"提升到"完整交付"，覆盖原 PRD 中未完成的验收项和用户可感知的缺陷。

## 3. 缺口清单与优先级

### P0（用户可感知，必须修复）

| # | 缺口 | 影响 | 原 PRD 追溯 |
|---|------|------|------------|
| G1 | 文件内容预览缺失 | 用户可列出文件但无法读取内容，SandboxFileTree 点击文件无反应 | chat-inline Story 3 "点击文件可在右侧预览内容" |
| G2 | 终端 resize 不工作 | 拖动面板大小时终端行列不更新，导致换行错位 | sandbox-integration FR-4 |
| G3 | 执行历史 UI 缺失 | REST 端点存在但前端无消费，用户看不到过去的执行记录 | sandbox-integration NFR-3 |
| G4 | idle 状态从不设置 | 沙箱状态永远是 running，直到销毁，前端黄点从未出现 | sandbox-integration FR-4 状态变更 |
| G5 | 状态变更不推送 | onStatusChange 回调已定义但从未注册，UI 状态仅在 30s 轮询时更新 | sandbox-integration FR-4 |
| G6 | peak_memory_mb 未采集 | DB 列存在但 INSERT 不写，审计日志缺失内存用量 | sandbox-integration NFR-3 |

### P1（功能完整，应当修复）

| # | 缺口 | 影响 | 原 PRD 追溯 |
|---|------|------|------------|
| G7 | ttlMinutes 参数被忽略 | 创建 API 接受参数但不生效，用户无法自定义超时 | sandbox-integration FR-1 |
| G8 | cdpPort 重启丢失 | 服务重启后已运行沙箱的浏览器功能全部失效 | 无 |
| G9 | getByGroup 轮询延迟 | Chat 面板 5s 轮询，Agent 首次创建沙箱后最多等 5s | 无 |

### P2（已知限制，文档记录即可）

| # | 缺口 | 说明 |
|---|------|------|
| G10 | restricted 网络模式 | 需要 iptables + 自定义 Docker 网络，暂不实现 |
| G11 | 浏览器单订阅限制 | 已知限制，已在 chat-inline 测试报告中记录 |
| G12 | Prometheus 指标 | 暂不实现，留后续 |
| G13 | SettingsPage 配额调整 | 暂用环境变量 |
| G14 | Warm pool 预热 | 暂不实现 |

## 4. 用户故事

### Story 1：在沙箱文件树中预览文件内容
> 用户在 Chat 右侧沙箱面板的文件树 tab 中看到 `/workspace/hello.py`，点击文件后在右侧预览区域看到代码内容。

**验收**：
- 点击文件节点弹出预览面板或内联展开，显示文件内容（前 100KB）
- 支持常见文本文件（.py/.js/.ts/.json/.txt/.md/.html/.css/.sh/.yaml/.yml/.env/.cfg/.ini）

### Story 2：调整终端面板大小不乱码
> 用户在 `/sandbox` 页面拖动终端和浏览器之间的分隔条，终端自动适配新尺寸，不再出现换行错位。

**验收**：
- 拖动面板大小时，终端 pty 同步更新 cols/rows
- 长命令输出不再出现"折行重叠"现象

### Story 3：查看沙箱执行历史
> 用户在沙箱页面点击"执行历史"按钮，看到按时间倒序排列的执行记录列表（状态、耗时、退出码、输出摘要）。

**验收**：
- 执行历史面板显示最近 50 条记录
- 每条记录显示：状态图标、语言、耗时、退出码、stdout 前 200 字符
- 点击可展开查看完整 stdout/stderr

### Story 4：沙箱状态实时更新
> 用户看到沙箱状态 dot 从绿色（running）变为黄色（idle），再变为灰色（stopped），无需手动刷新。

**验收**：
- 沙箱 30s 无交互后状态变为 idle（黄色 dot）
- 沙箱销毁后状态变为 stopped（灰色 dot），从列表中移除（或标记已停止）
- 以上状态变更通过 WS 实时推送

## 5. 功能需求

### FR-1：文件内容读取 API
- `GET /api/sandbox/sessions/:id/files/read?path=/workspace/hello.py`
- 通过 `docker exec <container> cat <path>` 读取
- 路径安全校验：normalize + startsWith('/workspace') + 禁止 `..`
- 限制读取 100KB，超过截断并返回 `truncated: true`
- 仅支持文本文件（基于扩展名白名单），二进制文件返回 error

### FR-2：终端 resize WS 消息
- 新增 `sandbox_terminal_resize` WS 消息类型：`{ type, sessionId, cols, rows }`
- 后端 `SandboxManager.resizeTerminal()` 方法
- 前端 `SandboxTerminal` 组件 ResizeObserver 触发时发送 resize 消息

### FR-3：执行历史 UI 面板
- 新增 `SandboxExecutionList` 组件
- 调用 `GET /api/sandbox/sessions/:id/executions` 获取数据
- 列表项：状态图标、语言标签、耗时、退出码、stdout 摘要
- 点击展开：完整 stdout/stderr 显示
- 面板入口：SandboxToolbar 中新增"执行历史"按钮

### FR-4：idle 状态检测与推送
- `SandboxManager` 新增 `markIdle()` 方法，在 idle timer 触发时调用
- `markIdle()` 更新 DB status='idle'，调用 `onStatusChange` 回调
- `destroy()` 更新 status='stopped'，调用 `onStatusChange` 回调
- `create()` 后调用 `onStatusChange` 通知 'running'
- 后端 WS 层注册 `onStatusChange` 回调，广播 `sandbox_status` 消息

### FR-5：peak_memory_mb 采集
- `executeCode()` 执行时通过 `docker stats --no-stream` 采集容器内存
- 或者通过 `docker exec <container> cat /sys/fs/cgroup/memory.current` 获取
- 写入 `sandbox_executions.peak_memory_mb`

### FR-6：ttlMinutes 支持
- `SandboxManager.create()` 读取 `opts.ttlMinutes`
- 如果传入，覆盖默认的 `IDLE_TIMEOUT_MS` 和 `HARD_TIMEOUT_MS`
- 范围限制：1-60 分钟

### FR-7：cdpPort 重启恢复
- `SandboxManager.get()` 检测到 `cdpPort === null` 时，通过 `docker port` 命令重新获取
- 恢复后更新内存中的 `SessionState.cdpPort`

### FR-8：getByGroup 推送优化
- `resolveSandboxId()` 在首次创建沙箱后，通过 `broadcastStreamEvent` 推送 `tool_progress` 事件
- 前端 `SandboxPanel` 收到事件后立即更新，无需等待 5s 轮询

## 6. 非功能需求

- 所有改动通过 `make typecheck` 三端检查
- 所有改动通过 `make test` 不引入回归
- 不破坏现有 `/sandbox` 独立页和 Chat 沙箱面板行为
- 不新增 StreamEventType 到 shared/stream-event.ts

## 7. 验收清单

- [ ] `make typecheck` 三端通过
- [ ] `make test` 全量通过，无回归
- [ ] 文件内容读取 API 正常返回文本内容
- [ ] 终端 resize 后行列正确更新
- [ ] 执行历史面板正常展示
- [ ] 沙箱 idle 状态正常切换并推送
- [ ] peak_memory_mb 有实际值
- [ ] ttlMinutes 参数生效
- [ ] cdpPort 重启后可恢复
- [ ] getByGroup 推送延迟 < 1s