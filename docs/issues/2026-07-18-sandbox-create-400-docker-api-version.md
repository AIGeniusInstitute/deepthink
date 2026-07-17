# 沙箱新建 400 / 浏览器 CDP 超时 —— Docker client/daemon API 版本不匹配

- 日期：2026-07-18
- 影响模块：`src/sandbox/manager.ts`、`src/sandbox/browser.ts`
- 严重度：P0（沙箱能力完全不可用）

## 1. 用户现象

在 `http://127.0.0.1:5173/sandbox` 页面点击「新建沙箱」无反应。浏览器控制台报：

```
POST http://127.0.0.1:5173/api/sandbox/sessions 400 (Bad Request)
```

调用栈：`client.ts:28 apiFetch → sandbox.ts:45 createSession → SandboxToolbar.tsx:22 handleCreate`。

## 2. 问题描述

后端 `POST /api/sandbox/sessions` 路由把 `SandboxManager.create()` 抛出的所有异常都包成 `400`。`create()` 内部 `spawnDocker(['run', ...])` 返回 `ok=false`，于是抛 `沙箱启动失败: ...`，路由回 400。前端只看到 400，没有任何错误体展示，表现即「点了没反应」。

进一步发现：即便绕过创建链路，浏览器沙箱的 CDP 也启动超时（`Chromium CDP 启动超时`），`BrowserController.ensureProcessesRunning` 失败。

## 3. 根因

**Docker CLI 与 daemon 的 API 版本不匹配。** 本机 Docker Desktop 的 daemon 最低要求 API 1.44，而 `$PATH` 上的 `docker` 客户端是 1.42（Docker Engine 22.06.0-beta.0）。任何不带 `DOCKER_API_VERSION` 覆盖的 `docker` 调用都会被 daemon 拒绝：

```
Error response from daemon: client version 1.42 is too old.
Minimum supported API version is 1.44, please upgrade your client to a newer version
```

证据：

```bash
$ docker ps
Error response from daemon: client version 1.42 is too old. Minimum supported API version is 1.44 ...
$ DOCKER_API_VERSION=1.44 docker ps   # 正常
$ DOCKER_API_VERSION=1.44 docker images | grep sandbox
deepthink-sandbox   latest   a0a189a30561   9 hours ago   1.67GB
```

`SandboxManager` 与 `BrowserController` 中所有 `spawn('docker', ...)` 都直接继承服务进程环境，而服务进程（`node dist/index.js`）启动时未设置 `DOCKER_API_VERSION`，因此：

- `manager.ts` 的 `spawnDocker('run')` → 失败 → `create()` 抛错 → 400；
- `browser.ts` 的 `spawnInContainer` / `waitForTcpReady` / `killProcessesInContainer` 用 `stdio: 'ignore'` 且无论退出码都 resolve，**静默失败** → chromium / cdp-forwarder 根本没启动 → `pingCdp` 10s 内拿不到响应 → `Chromium CDP 启动超时`。

镜像本身正常（手动 `docker run` + `docker exec` 跑 python 输出 `hello from sandbox`、`(3, 11)`，exit 0）。

## 4. 复现路径

1. 确保本机 docker client 1.42 / daemon min 1.44（`docker version` 的 Server 段报空 "Error response from daemon:"）。
2. 不设 `DOCKER_API_VERSION`，启动后端：`WEB_PORT=9898 node dist/index.js`。
3. 浏览器打开 `http://127.0.0.1:5173/sandbox`，点「新建沙箱」。
4. 控制台报 `POST /api/sandbox/sessions 400`。

## 5. 诊断方法

```bash
# 5.1 确认版本不匹配（看是否出现 "Minimum supported API version is X"）
docker ps 2>&1 | grep -i "Minimum supported"

# 5.2 带 override 验证 daemon/镜像本身没问题
DOCKER_API_VERSION=1.44 docker ps
DOCKER_API_VERSION=1.44 docker images | grep deepthink-sandbox

# 5.3 端到端集成验证（worktree 根目录执行）
npx tsx scripts/integration-probe.ts
# 期望输出：[1] create ok / [2] exec completed / [3] listFiles / [4] readFile / [5] browser started / [6] destroy ok / ALL GOOD
```

## 6. 修复方案

新增 `src/sandbox/docker-env.ts`：进程级缓存地解析 `docker` 子进程所需环境。首次调用用 `docker ps`（**不是** `docker version`——后者在版本不匹配时只回空 "Error response from daemon:"，拿不到协商文本）探测；若失败，从 stderr 正则 `/Minimum supported API version is (\d+\.\d+)/` 解析 daemon 最低版本，pin 到 `DOCKER_API_VERSION`，后续所有 spawn 复用该缓存。

`SandboxManager` 与 `BrowserController` 所有 `spawn('docker', ...)` 站点统一注入该 env：

- `manager.ts`：`spawnDocker`、`_doExecute`（exec 代码）、`destroy`（`docker rm -f`）、`startTerminal`（`docker exec -i sh`）。
- `browser.ts`：`spawnInContainer`（启动 chromium / cdp-forwarder）、`waitForTcpReady`（`curl` 探活）、`killProcessesInContainer`。

关键 diff（共享 env 解析）：

```ts
// src/sandbox/docker-env.ts
export async function resolveDockerEnv(): Promise<NodeJS.ProcessEnv> {
  if (cache !== undefined) return cache;
  const probe = await rawSpawn(['ps', '--format', '{{.Names}}']);
  if (probe.ok) { cache = process.env; return cache; }
  const m = `${probe.stderr}\n${probe.stdout}`.match(/Minimum supported API version is (\d+\.\d+)/);
  if (m) {
    logger.warn({ pinned: m[1] }, 'Docker client API version too old for daemon; pinning DOCKER_API_VERSION');
    cache = { ...process.env, DOCKER_API_VERSION: m[1] };
  } else {
    cache = process.env; // 未知失败，不覆盖，让真实错误上浮
  }
  return cache;
}
export function dockerEnvSync(): NodeJS.ProcessEnv { return cache ?? process.env; }
```

```diff
// src/sandbox/manager.ts
- const proc = spawn('docker', args, { stdio: ['pipe', 'pipe', 'pipe'] });
+ const dockerEnv = await this.resolveDockerEnv();
+ const proc = spawn('docker', args, { stdio: ['pipe', 'pipe', 'pipe'], env: dockerEnv });
```

```diff
// src/sandbox/browser.ts  spawnInContainer / waitForTcpReady / killProcessesInContainer
- const p = spawn('docker', args, { stdio: 'ignore' });
+ const p = spawn('docker', args, { stdio: 'ignore', env: dockerEnvSync() });
```

**选型理由**：
- 自动协商优于「在启动脚本里写死 `DOCKER_API_VERSION=1.44`」——后者会随 daemon 再次升级而再次失效，且要求用户改环境。自动解析 daemon 实际要求的最低版本，自愈、零配置。
- 共享模块而非各自缓存：一次 probe 服务于 manager + browser，避免重复探测与版本不一致。
- `docker ps` 而非 `docker version` 作探测：实测 `docker version` 在此故障下只回空错误体，无法解析；`docker ps` 才回完整协商文本。
- 不把 spawn 签名改成必填 env（侵入式）；只在内部统一注入，对外行为不变。

## 7. 处理卡住的状态

- 残留沙箱容器（探测失败可能留下 `deepthink-sandbox-sb-*`）：
  ```bash
  DOCKER_API_VERSION=1.44 docker ps -a --format '{{.Names}}' | grep deepthink-sandbox | xargs -r docker rm -f
  ```
- DB 里残留 `status='running'` 但容器已不存在的会话：`get()` 已有 `container_lost` 兜底，会自动改写为 `stopped`；无需人工清理。

## 8. 经验沉淀 / 预防

- **根因教训**：所有 `spawn('docker', { stdio: 'ignore' })` 且不检查退出码的调用都是「静默失败陷阱」。本次浏览器 CDP 超时的表象离根因（docker 根本没执行成功）很远。今后对 docker 子进程：要么检查 `code === 0`，要么至少把 stderr 落日志，便于排障。
- **版本协商**：Docker Desktop on Linux 经常出现 $PATH 上的系统 docker CLI 落后于 Desktop daemon 的情况。自动 `DOCKER_API_VERSION` 协商应作为沙箱模块的标配，而不是依赖部署环境。
- **巡检脚本**（可加进 CI / `make check`）：
  ```bash
  docker ps >/dev/null 2>&1 || echo "WARN: docker CLI 无法连通 daemon，沙箱将不可用"
  ```
- **前端可观测**：`POST /api/sandbox/sessions` 返回 400 时前端应展示 error body（当前只吞掉），否则用户只看到「点了没反应」。建议后续在 `client.ts` 的 `apiFetch` 里对非 2xx 抛出含 error body 的错误，并在 `SandboxToolbar` toast 出来。（本 issue 仅做后端修复，前端展示改进另开。）
```
