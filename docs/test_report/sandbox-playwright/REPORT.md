# Sandbox Playwright 集成测试报告

## 概览

| 项目 | 结果 |
|------|------|
| 需求 | docs/prd/sandbox-playwright/PRD.md |
| 方案 | docs/tech_solution/sandbox-playwright/SOLUTION.md |
| 分支 | feat/sandbox-playwright |
| 执行日期 | 2026-07-16 |
| 最终结论 | **✅ 全部通过** |

## 验收目标

P1 三项全部完成:

1. **P1.a Makefile 集成**: `sandbox-build` + `_ensure-sandbox-image` target, `make dev`/`make start` 前自动检查镜像
2. **P1.b 浏览器网络模式**: `SANDBOX_BROWSER_NETWORK=bridge|none|restricted` (P2 restricted 自动降级 bridge)
3. **P1.c Playwright 替换手写 CDP**: BrowserController 使用 `playwright-core` 的 `chromium.connectOverCDP` + 标准 `page.click/fill/screenshot/evaluate` API
4. **附加**: 容器集成 smoke test 通过

## 验证证据

### 1. 单元测试 (vitest)

```
Test Files  91 passed (91)
     Tests  1187 passed (1187)
  Duration  3.54s
```

`sandbox-security.test.ts` 6 项断言全过:
- 非浏览器模式禁网 (--network=none)
- 浏览器模式 CDP forwarder 端口 127.0.0.1::9223
- 全量加固标志 (read-only / cap-drop ALL / no-new-privileges / memory+memory-swap / cpus / pids / nofile / tmpfs uid=1000 / user 1000:1000 / init)
- 浏览器模式跳过自定义 seccomp (使用 Docker 默认 profile,保留其他加固)
- memory-swap == memory (禁 swap)
- SANDBOX_BROWSER_NETWORK=none 时 --network=none + CDP 端口共存

### 2. TypeScript 类型检查

```
npx tsc --noEmit            # 后端 OK
cd web && npx tsc --noEmit    # 前端 OK
cd container/agent-runner && npx tsc --noEmit   # Agent Runner OK
shared type copies are in sync
```

### 3. 容器集成 smoke test

执行命令: `npx tsx scripts/sandbox-playwright-smoke.ts`

输出:
```
[smoke] docker run code: 0
[smoke] container ready: true
[smoke] CDP host port: 57769
[smoke] starting BrowserController (Playwright connectOverCDP)...
[smoke] navigated to data URL
[smoke] page title: Smoke Test url: data:text/html,...<title>Smoke Test</title>...
[smoke] evaluate(document.title): Smoke Test
[smoke] evaluate(h1): hello
[smoke] screenshot saved: .../smoke-screenshot.png bytes: 3184
[smoke] frames received during test: 2
[smoke] ✅ ALL CHECKS PASSED
```

验证矩阵:

| 检查项 | 通过 | 说明 |
|--------|------|------|
| Docker 容器启动 (browserEnabled=true) | ✅ | buildDockerRunArgs 全量加固参数 |
| Chromium 进程在容器内启动 | ✅ | `docker exec` 显示 PID + /proc/net/tcp 9222 LISTEN |
| CDP forwarder (cdp-forwarder.js) 启动 | ✅ | 监听 0.0.0.0:9223 → 127.0.0.1:9222 |
| Docker 端口映射 127.0.0.1::9223 | ✅ | curl /json/version 返回 Chrome/150.0.7871.114 |
| Playwright connectOverCDP | ✅ | endpoint=http://127.0.0.1:{host_port} |
| page.goto (data URL) | ✅ | title 正确,URL 一致 |
| page.evaluate | ✅ | document.title 和 #x.textContent 都返回正确 |
| page.screenshot (PNG) | ✅ | 3184 bytes,>1KB 阈值 |
| 帧回调 (JPEG q=60 500ms) | ✅ | 1.2s 内收到 2 帧 |
| 容器清理 (docker rm -f) | ✅ | stop() 杀 chromium + forwarder |

## 关键技术决策

### 1. CDP forwarder (cdp-forwarder.js)

**问题**: Chromium 150 (含 2024+ 安全补丁) 忽略 `--remote-debugging-address=0.0.0.0`,DevTools 端点强制绑定 127.0.0.1:9222。Docker 端口映射转发到容器 eth0 IP,无法到达容器 loopback,导致宿主机无法访问 CDP。

**方案**: 在镜像内 `/usr/local/lib/cdp-forwarder.js` 部署一个 30 行的 Node.js TCP 转发器,监听 0.0.0.0:9223 → 127.0.0.1:9222。Docker 端口映射改为 `-p 127.0.0.1::9223`,宿主机 Playwright 通过 forwarder 间接访问 chromium。

**理由**:
- 不需要新增系统包(镜像已含 Node.js)
- 不需要 chromium 补丁(避免和上游版本脱钩)
- 代码量小、可维护、可被测试

### 2. 浏览器模式跳过自定义 seccomp

Chromium 需要 ~200+ syscalls,手维护白名单脆弱。Docker 默认 seccomp profile 仍阻断 namespace-creation / kernel-exploit 类系统调用 (ptrace/mount/unshare/keyctl/bpf/perf_event_open),配合 `--cap-drop ALL` + 非 root + 只读 + 内存/CPU/PID 限制,已覆盖真实逃逸向量。

### 3. fsize ulimit 移除

`--ulimit fsize=` 的单位是字节(不是 KB),原 `fsize=1048576:1048576` 实际只有 1MB,chromium 的 user-data-dir / shared memory 单文件即可超出,导致 "File size limit exceeded" 崩溃。tmpfs 已通过 `size=` 参数限制总磁盘占用,fsize 是冗余的,直接移除。

### 4. 资源限制提升

- `memory_mb`: 512 → 1024 (chromium + forwarder + renderer 总和)
- `cpus`: 1.0 → 2.0 (并发渲染需要)
- `pids_max`: 64 → 256 (chromium zygote + renderer + gpu + network + storage + crashpad 合计 ~80+ 进程)
- `nofile`: 128 → 1024 (chromium socket/fd 数高)
- 移除 `nproc` ulimit(pids-limit cgroup 已处理 fork bomb)

### 5. swiftshader 软件 GL

`--use-gl=angle --use-angle=swiftshader --disable-gpu` 强制使用软件 GL 后端。`--cap-drop ALL` 阻断 GPU 进程的内核访问,真 GPU 上下文创建失败 ("Failed to send GpuControl.CreateCommandBuffer"),导致 `Page.captureScreenshot` 报错。swiftshader 在用户态实现 GL,screenshots 正常工作。

## 改动文件清单

### 新增

| 文件 | 用途 |
|------|------|
| `container/sandbox/cdp-forwarder.js` | 0.0.0.0:9223 → 127.0.0.1:9222 TCP 转发器 |
| `docs/prd/sandbox-playwright/PRD.md` | 需求文档 |
| `docs/tech_solution/sandbox-playwright/SOLUTION.md` | 技术方案 |
| `docs/test_report/sandbox-playwright/REPORT.md` | 本测试报告 |
| `scripts/sandbox-playwright-smoke.ts` | 容器集成 smoke test |

### 修改

| 文件 | 改动 |
|------|------|
| `container/sandbox/Dockerfile` | COPY cdp-forwarder.js 到 /usr/local/lib/ |
| `src/sandbox/browser.ts` | 全量重写为 Playwright connectOverCDP;启动 chromium + forwarder;kill 清理 |
| `src/sandbox/security.ts` | 浏览器模式 9222→9223;移除 fsize ulimit;跳过自定义 seccomp;HOME=/tmp env |
| `src/sandbox/config.ts` | 新增 `BrowserNetworkMode` type + `getBrowserNetworkMode()`;`CDP_IN_CONTAINER_PORT` 9222→9223;新增 `CHROMIUM_DEVTOOLS_PORT` |
| `tests/units/sandbox-security.test.ts` | 更新端口断言;移除 fsize 检查;新增 3 个浏览器模式测试 |
| `package.json` | 新增 `playwright-core@^1.61.1` 依赖 |
| `Makefile` | 新增 `sandbox-build` + `_ensure-sandbox-image` target;`dev`/`_start-pm2`/`_start-direct` 调用 |

### 已知限制 (非 P1 范围)

- `SANDBOX_BROWSER_NETWORK=restricted` 暂未实现(P2,需要 Linux + iptables egress 白名单)
- `cloudcli-browser` UI E2E 仍不可用(MCP 工具 fetch failed);本次以 smoke test + vitest + typecheck 替代
- macOS Docker Desktop 下浏览器模式依赖端口映射转发(bridge 模式);Linux 上可考虑直连容器 IP

## 测试命令复现

```bash
cd ~/deep-think
./container/sandbox/build.sh                           # 构建镜像
make typecheck                                         # 类型检查
make test                                              # 单元测试
npx tsx scripts/sandbox-playwright-smoke.ts           # 容器集成 smoke
```

## 结论

P1 三项 (Makefile 集成 / 浏览器网络模式 / Playwright 替换) **全部完成**,1187 个单元测试零回归,typecheck 三端通过,容器集成 smoke test ✅ ALL CHECKS PASSED。可合并 main 并 push。
