# docker CLI 客户端过旧导致 make dev 死循环重建镜像 / 容器无法运行

> 处理日期：2026-07-18 · 涉及环境：Linux + Docker Desktop

## 1. 用户现象

- `make dev` 看似一直在「构建 Docker 镜像」，每次启动都重新构建（npm install → pip install → go build feishu-cli，约 10 分钟），构建中途或结束后进程异常退出，前端迟迟起不来。
- 即便镜像已构建完成，`docker images` / `docker run deepthink-agent:latest` 也不可用，后端 `_ensure-docker-image` 判定「镜像不存在」反复触发重建。

## 2. 问题描述

`make dev` 的 `_ensure-docker-image` target 用 `docker image inspect deepthink-agent:latest` 判断镜像是否就绪。该命令调用 docker daemon 的 REST API，被 daemon 以「客户端 API 版本过旧」拒绝：

```
Error response from daemon: client version 1.42 is too old.
Minimum supported API version is 1.44, please upgrade your client to a newer version
```

`docker image inspect` 失败 → Makefile 走进「镜像不存在 → 重建」分支 → 构建完成后 inspect 仍失败 → 下次启动再重建 → 死循环。运行时 `container-runner.ts` 通过 `docker run` 启动容器同样会因 CLI/daemon 版本不匹配而失败。

## 3. 根因

机器上存在两套 docker CLI 与两个 daemon：

| CLI | 路径 | 版本 | API | 说明 |
|-----|------|------|-----|------|
| 旧 | `/usr/local/bin/docker` → `/usr/bin/docker` | 22.06.0-beta.0（2022） | 1.42 | PATH 优先级高，被默认使用；active context = `desktop-linux` |
| 新 | `/snap/docker/3505/bin/docker`（snap） | 29.3.1 | 1.54 | 静态链接；snap 包装层有沙箱限制 |

| Daemon | socket | 版本 | min API |
|--------|--------|------|---------|
| Docker Desktop | `~/.docker/desktop/docker.sock`（owner `me:me`） | 29.3.1 | **1.44** |
| 系统 Docker Engine | `/var/run/docker.sock`（owner `root:docker`） | 29.3.1 | 1.40 |

- `docker build`（buildx）走 BuildKit gRPC 协议，**绕过** daemon REST API 的版本校验 → 即使旧 CLI 也能构建成功 → 镜像实际已 load 进 Docker Desktop daemon。
- `docker image inspect` / `docker run` 走 daemon REST API → 旧 CLI（1.42）对 Docker Desktop daemon（min 1.44）报 too old 被拒 → inspect 永远失败。
- 旧 CLI 的 active context 是 `desktop-linux`（Docker Desktop socket），所以它一直连的是 min 1.44 的 daemon，注定失败。

**本质**：apt 装的 `docker-ce-cli` 22.06-beta 是 2022 年的陈旧残留，与 Docker Desktop 29.x daemon 不匹配；PATH 把它排在最前，遮蔽了 snap 里的现代 CLI。

外部依据：Docker Engine API 版本协商——客户端版本低于 daemon 的 minimum supported API 时，daemon 直接拒绝。见 https://docs.docker.com/reference/api/engine/versioning/ 。

## 4. 复现路径

1. 确认当前 `docker` 解析到旧 CLI：`command -v docker` → `/usr/local/bin/docker`；`docker version | head -3` 显示 `Version: 22.06.0-beta.0`、`API version: 1.42`。
2. 删除 sentinel 触发重建判断：`rm -f .docker-build-sentinel`。
3. 运行 `make dev` → `_ensure-docker-image` 调 `docker image inspect deepthink-agent:latest` → daemon 返回 `client version 1.42 is too old` → inspect 退出码非 0 → Makefile 认为「镜像不存在」→ 调 `./container/build.sh` 开始漫长重建。
4. 重建完成后（即便成功），下次 `make dev` 第 3 步同样失败 → 永远重建。

## 5. 诊断方法

```bash
# (a) 当前 docker CLI 版本与 API
docker version | grep -iE 'version|API'
# 若 Client API < 1.44 且 Server min API > Client API，即命中本 issue

# (b) 直接看 daemon 拒绝信息
docker image inspect deepthink-agent:latest
# 期望：返回镜像 JSON；本 issue：Error response from daemon: client version X is too old.

# (c) 查所有 docker 二进制与版本
for p in /usr/local/bin/docker /usr/bin/docker /snap/bin/docker /snap/docker/*/bin/docker; do
  [ -x "$p" ] && echo "--- $p" && "$p" version 2>/dev/null | grep -E 'Version|API version' | head -2
done

# (d) 查 docker context（旧 CLI 的 active context 决定它连哪个 daemon）
docker context ls

# (e) 查两个 daemon 的 socket
ls -la /var/run/docker.sock ~/.docker/desktop/docker.sock
```

## 6. 修复方案

### 6.1 环境（本机）侧：让 PATH 里的 docker 是现代 CLI

snap 里的现代 docker CLI 是静态链接二进制，拷出 `~/.local/bin/docker` 即可脱离 snap 沙箱独立运行，且 `~/.local/bin` 在 PATH 中排在 `/usr/local/bin` 之前，可顶掉旧 CLI；它复用已有的 `desktop-linux` context（指 Docker Desktop socket），无需额外配置：

```bash
mkdir -p ~/.local/bin
cp /snap/docker/3505/bin/docker ~/.local/bin/docker
chmod +x ~/.local/bin/docker
hash -r
docker version          # 应显示 29.3.1 / API 1.5x
docker image inspect deepthink-agent:latest --format '{{.Id}}'   # 应返回 sha256:...
```

无需 sudo、可逆（删除 `~/.local/bin/docker` 即恢复原状）。

> 备选（彻底根治）：`sudo apt install --only-upgrade docker-ce-cli` 把 apt 的 22.06-beta 升到 29.x，或直接卸载 apt 版改用 Docker Desktop 自带 CLI。但涉及系统包改动，优先用上面的非特权方案。

### 6.2 仓库侧：Makefile 检测 CLI/daemon 版本不匹配，拒绝盲目重建

旧逻辑在 `docker image inspect` 失败时无脑重建，遇到版本不匹配会死循环。新增预检：先判 CLI 能否与 daemon 通信，不能则直接报错并给出上面 6.1 的修复指引，不再触发重建。

```diff
--- a/Makefile
+++ b/Makefile
@@ _ensure-docker-image target
-    if ! docker image inspect deepthink-agent:latest >/dev/null 2>&1; then \
-      echo "🐳 Docker 镜像不存在，正在构建..."; \
+    if ! _docker_ver=$(docker version --format '{{.Client.APIVersion}}|{{.Server.APIVersion}}' 2>/dev/null) && \
+         printf '%s' "$$_docker_ver" | grep -q '|'; then :; \
+    else \
+      echo "❌ docker CLI 无法与 daemon 通信（可能客户端 API 版本过旧）。"; \
+      echo "   诊断：docker version  看是否报 'client version X is too old'"; \
+      echo "   修复：见 docs/issues/2026-07-18-docker-cli-too-old.md §6.1"; \
+      exit 1; \
+    fi; \
+    if ! docker image inspect deepthink-agent:latest >/dev/null 2>&1; then \
+      echo "🐳 Docker 镜像不存在，正在构建..."; \
```

选型理由：`docker version --format` 同时取 Client 与 Server API 版本，任一侧拿不到（grep 无 `|`）即说明 CLI/daemon 握手失败；此时重建无意义，必须先修 CLI。

## 7. 处理卡住的状态

- `make dev` 已陷入死循环且镜像其实已构建：先 `docker image inspect deepthink-agent:latest`（用新 CLI）确认镜像在，再 `touch .docker-build-sentinel` 标记已就绪，跳过重建。
- 后台 `make dev` 进程残留：`lsof -ti:9898 -sTCP:LISTEN | xargs -r kill`（仅杀监听进程，保护 Docker daemon，见 CLAUDE.md §10）。

## 8. 经验沉淀 / 预防

- **症状识别**：`make dev` 每次都重建镜像 + `docker run` 报 too old = CLI/daemon 版本不匹配，不要再等第 N 次重建，立即查 `docker version`。
- **根因层级**：`docker build`（BuildKit）能成而 `docker run`/`inspect` 失败，是 CLI 客户端过旧的**指纹特征**——BuildKit 走 gRPC 绕过 daemon REST API 的版本协商。
- **环境一致性**：多套 docker CLI（apt / snap / Docker Desktop）并存时，PATH 顺序决定用哪个；优先非特权的 `~/.local/bin` 注入现代 CLI，避免改系统包。
- **预防巡检**（加入 onboarding 自检脚本）：
  ```bash
  # docker CLI 与 daemon 握手是否正常
  docker version --format '{{.Client.APIVersion}} -> server {{.Server.APIVersion}}' >/dev/null 2>&1 \
    || echo "WARN: docker CLI/daemon 版本不匹配，参考 docs/issues/2026-07-18-docker-cli-too-old.md"
  ```
- **Makefile 防御**：§6.2 的预检让该问题从「静默死循环」变成「立即报错 + 给出修复指引」。
