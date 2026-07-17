# 沙箱模块全面审查与 docker-env 缓存中毒加固

承接 [`2026-07-18-sandbox-create-400-docker-api-version.md`](./2026-07-18-sandbox-create-400-docker-api-version.md)：上一轮已定位 `POST /api/sandbox/sessions` 400 的根因（docker CLI 1.42 < 守护进程最低 1.44）并落地 `docker-env.ts` 自动协商 + 注入所有 spawn 点，合并入 main（`3c651dc`）。本轮做**全量沙箱能力审查**，并在审查中复现出 `docker-env.ts` 的一类缓存中毒缺陷，补齐加固。

## 1. 用户现象

用户在 `http://127.0.0.1:5173/sandbox` 点「新建沙箱」无反应，浏览器控制台报：

```
POST http://127.0.0.1:5173/api/sandbox/sessions 400 (Bad Request)
```

## 2. 问题描述

`5173` 是 vite dev 前端，`/api` 代理到 `9898` 后端。400 由 `src/routes/sandbox.ts:21` 的 `POST /sessions` 抛错产生 —— `SandboxManager.create()` 内 `spawnDocker('run')` 返回 `ok=false`，路由捕获后回 400。

## 3. 根因

### 3.1 已修复根因（上一轮）
docker CLI（1.42）低于 Docker Desktop 守护进程最低支持版本（1.44），未带 `DOCKER_API_VERSION` 覆盖时，所有 `docker` 调用 stderr 返回 `client version 1.42 is too old. Minimum supported API version is 1.44`，沙箱容器无法启动 → 400。

证据（本机当前）：
```
$ docker ps
Error response from daemon: client version 1.42 is too old.
Minimum supported API version is 1.44, please upgrade your client to a newer version
$ DOCKER_API_VERSION=1.44 docker ps          # 正常
$ DOCKER_API_VERSION=1.44 docker images | grep sandbox
deepthink-sandbox   latest   a0a189a30561   1.67GB
```

### 3.2 本轮新发现：`docker-env.ts` 缓存中毒

`resolveDockerEnv()` 用 `docker ps` 探测一次：返回 `ok=true`（exit 0）就把缓存置为 `process.env`（不 pin 版本）；返回失败才解析版本号并 pin。缓存是进程级单例，命中后不再探测。

在 Docker Desktop 冷启动场景下，`docker ps` 偶发返回 `exit 0`（守护进程尚未完成版本协商就放行了 `ps` 这条），于是缓存被污染为「不 pin」状态 —— 之后所有 `docker run` 都失败，且**整个进程生命周期内**后续每次沙箱创建都 400，因为缓存已固定为错误值。

本轮审查首次跑 `scripts/integration-probe.ts` 即复现到这一失败：
```
PROBE FAILED: Error: 沙箱启动失败: docker: Error response from daemon:
client version 1.42 is too old. Minimum supported API version is 1.44 ...
（无 "pinning DOCKER_API_VERSION" WARN，说明走了 ok=true 分支）
```
紧接着的 3 次连跑全部 PASS，佐证这是冷启动偶发，而非稳定复现 —— 正因偶发，上一轮未捕获到。

## 4. 复现路径

```bash
cd ~/deepthink
DEEPTHINK_DATA_DIR=/home/me/.config/DeepThink/data npx tsx scripts/integration-probe.ts
# Docker Desktop 刚启动后首次跑有概率复现 "client version 1.42 is too old"；
# 再次跑即 PASS（说明 probe 在第二次正常命中失败分支并 pin）。
```

## 5. 诊断方法

```bash
# 1) 确认 docker CLI/守护进程版本差
docker ps 2>&1 | grep -E "too old|Minimum supported"
# 应输出 client version 1.42 is too old. Minimum supported API version is 1.44

# 2) 确认手动 pin 可解
DOCKER_API_VERSION=1.44 docker ps && echo OK

# 3) 确认沙箱镜像在
DOCKER_API_VERSION=1.44 docker images | grep deepthink-sandbox

# 4) 跑端到端探针（不经过 HTTP/鉴权，直测 SandboxManager）
cd ~/deepthink
DEEPTHINK_DATA_DIR=/home/me/.config/DeepThink/data npx tsx scripts/integration-probe.ts

# 5) HTTP 层验证（鉴权 cookie 用 mint 脚本生成，见本轮审查记录）
#    POST /api/sandbox/sessions 应返回 200 + status:running + cdpPort
```

## 6. 修复方案

核心思想：失败比探测更可信 —— 若某次 `docker` spawn 的 stderr 命中版本不匹配，直接从该 stderr 解析最低版本号并 pin，重试一次。这样即使 `docker ps` 探测被冷启动欺骗污染了缓存，第一次 `docker run` 的失败也能自愈。

`src/sandbox/docker-env.ts` 新增两个导出：
```ts
export function extractRequiredApiVersion(stderr: string): string | null {
  const m = stderr.match(/Minimum supported API version is (\d+\.\d+)/);
  return m ? m[1] : null;
}
export function pinDockerApiVersion(version: string): void {
  cache = { ...process.env, DOCKER_API_VERSION: version };
}
```

`src/sandbox/manager.ts` `spawnDocker` 改为：spawn → 若 `!ok` 且 `extractRequiredApiVersion(stderr)` 命中且当前 env 未 pin → `pinDockerApiVersion(required)` 后重试一次。实际 spawn 抽成 `_runDocker(args, env)` 避免重复。

选型理由：
- 不改探测策略（`docker ps` 仍是首次协商业主），只在失败路径补救，零额外开销。
- 只对版本不匹配这一确定性信号重试，不会对其它错误（网络/镜像缺失）盲目重试。
- 重试只一次，避免无限循环。

## 7. 处理卡住的状态

如果线上后端进程已经因为缓存中毒处于「所有沙箱创建都 400」的状态：
- 临时：重启后端进程（清掉进程内缓存，重启后 `docker ps` 探测大概率走失败分支正确 pin）。
- 根治：部署本加固后，无需重启即可在首次失败后自愈。

## 8. 经验沉淀 / 预防

- 「探测一次 + 永久缓存」对冷启动偶发错误极度脆弱。凡是「探测结果决定后续所有调用」的单例缓存，都应在失败路径上提供「用真实失败信号覆盖缓存」的自愈入口，而不是只信探测。
- `docker version` 在版本不匹配时返回空 body 不可解析；`docker ps` 会带完整消息 —— 用作探测命令的选择是对的，但探测的 `ok=true` 不能等同于「版本匹配」，因为冷启动会假阳性。
- 端到端探针（`scripts/integration-probe.ts`）应作为沙箱改动 CI 门禁，覆盖 create / exec / listFiles / readFile / browser(start+navigate+screenshot) / destroy 全链路。
- 部署对齐：源码 fix 入 main 后，必须确认**运行中的后端进程**加载的是新产物（本机 `~/deepthink/dist/index.js`，进程 cwd=`~/deepthink` argv=`node dist/index.js`）。`make dev` / `_build-backend-if-stale` 会在源码变更后重编译，但若后端进程是桌面应用拉起且未重启，仍是旧码 —— 改动后务必重启后端。
