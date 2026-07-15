# `make dev` 重建 Docker 镜像时 `npm install` 卡死

- 日期：2026-07-15
- 触发命令：`make dev`（内部调用 `./container/build.sh`）
- 平台：macOS 25.2.0（arm64）+ Docker Desktop v5.0.2
- 用户网络：中国大陆（`~/.npmrc` 已设 `registry=https://registry.npmmirror.com`）

## 1. 用户现象

执行 `make dev` 时，Makefile 检测到容器源码变更，触发 `./container/build.sh` 重建镜像。构建日志卡在 `[stage-0 8/18] RUN npm install` 长达 96.5s 仍未完成：

```
🐳 检测到容器源码变更，正在重建 Docker 镜像...
Building DeepThink agent container image...
[+] Building 111.9s (13/24)      docker:desktop-linux
 => [stage-0  7/18] RUN npm install -g agent-b  11.4s
 => [stage-0  8/18] RUN npm install             96.5s   ← 卡死
```

用户已在本机 `~/.npmrc` 配置了 `registry=https://registry.npmmirror.com`，宿主机 `npm install` 秒下；但 Docker 构建照旧走 `registry.npmjs.org`，国内裸网络下丢包/超时，构建无法推进。

## 2. 问题描述

`docker build` 上下文是隔离的——BuildKit 在容器里跑 RUN 命令，**不会挂载宿主机的 `~/.npmrc`**，也不会继承宿主机的 `npm config`。容器内 `npm` 默认 registry 是 `https://registry.npmjs.org`，与宿主机配置无关。同理，`pip` 默认走 `https://pypi.org/simple`，也不读宿主机 `~/.pip/pip.conf`。

结果：宿主机配的国内镜像源在 `docker build` 里全部失效，每个 `RUN npm install` / `RUN pip install` 都直连海外源，国内网络下慢死。

## 3. 根因

**Docker 构建上下文与宿主机 npm/pip 配置隔离**。

证据链：

```bash
# 1. 宿主机 ~/.npmrc 已配国内镜像
$ cat ~/.npmrc
registry=https://registry.npmmirror.com

# 2. 宿主机 npm 走镜像
$ npm config get registry
https://registry.npmmirror.com

# 3. 但 Dockerfile 里没有任何 npm registry 设置，容器内 npm 回退到默认值
$ grep -n "npm config\|NPM_REGISTRY\|registry" container/Dockerfile
# (空)

# 4. 两个源的延迟差异（10 倍量级）
$ time curl -sI -o /dev/null https://registry.npmjs.org/
curl -sI -o /dev/null https://registry.npmjs.org/  0.01s user 0.01s system 1% cpu 1.043 total
$ time curl -sI -o /dev/null https://registry.npmmirror.com/
curl -sI -o /dev/null https://registry.npmmirror.com/  0.00s user 0.00s system 10% cpu 0.091 total
```

外部依据：
- Docker docs — [Build context](https://docs.docker.com/build/building/context/)：BuildKit 不会自动挂载宿主机用户配置目录。
- npm docs — [npm config](https://docs.npmjs.com/cli/v10/commands/npm-config)：`npm config set` 写入 `$HOME/.npmrc`，在容器内 `$HOME=/root` 或 `/home/node`，与宿主机 `~/.npmrc` 是不同文件。

## 4. 复现路径

前提：处于中国大陆网络（无代理），本机 `~/.npmrc` 已配 npmmirror。

```bash
# 1. 清除 Docker 构建缓存，强制 RUN npm install 重新跑
docker builder prune -f

# 2. 触发重建
make dev
# 或直接：
./container/build.sh

# 3. 观察日志：step 8 RUN npm install 卡住 >90s 无进展
```

如宿主机没配 npmmirror，`make dev` 一样会卡——因为容器内 npm 始终走 npmjs.org，与宿主机配置无关。

## 5. 诊断方法

```bash
# (1) 看构建日志里有没有 ARG NPM_REGISTRY / npm config set 的痕迹
docker history deepthink-agent:latest --format '{{.CreatedBy}}' | grep -E "npm config|NPM_REGISTRY"
# 修复前为空，修复后应有 "npm config set registry ..." 行

# (2) 临时进容器验证 npm registry（build 后跑一次交互式容器）
docker run --rm deepthink-agent:latest sh -c 'npm config get registry'
# 修复前：https://registry.npmjs.org/
# 修复后：https://registry.npmmirror.com/

# (3) 量宿主机到两个源的延迟，判断是否网络问题
curl -sI -o /dev/null -w '%{time_total}\n' https://registry.npmjs.org/
curl -sI -o /dev/null -w '%{time_total}\n' https://registry.npmmirror.com/
```

## 6. 修复方案

在 Dockerfile 内通过 `ARG` 设置 npm/pip registry，默认值指向国内镜像，可通过 `--build-arg` 覆盖。在 `build.sh` 里透传同名环境变量，让海外用户/CI 用一行环境变量切回官方源。

**container/Dockerfile**（关键 diff）：

```diff
 WORKDIR /app

+# Container build does NOT read host ~/.npmrc, so a host-side npm mirror config
+# has no effect inside `docker build`. China networks default to npmjs.org and
+# time out on `npm install`. Default to npmmirror; override with
+# `--build-arg NPM_REGISTRY=https://registry.npmjs.org` for upstream/CI.
+ARG NPM_REGISTRY=https://registry.npmmirror.com
+RUN npm config set registry "${NPM_REGISTRY}"
+
 COPY agent-runner/package.json ./

 ARG CACHEBUST=1
 RUN npm install -g agent-browser
 RUN npm install
```

```diff
+# PIP_INDEX_URL default to Tsinghua mirror: same root cause as NPM_REGISTRY —
+# container build can't read host pip config, China networks time out on pypi.org.
+# Override with `--build-arg PIP_INDEX_URL=https://pypi.org/simple`.
+ARG PIP_INDEX_URL=https://pypi.tuna.tsinghua.edu.cn/simple
-RUN pip install "headroom-ai[code,mcp]~=0.27.0" \
+RUN pip install --index-url "${PIP_INDEX_URL}" "headroom-ai[code,mcp]~=0.27.0" \
     && headroom --version
```

**container/build.sh**（关键 diff）：

```diff
 BUILD_NETWORK="${BUILD_NETWORK:-host}"
+NPM_REGISTRY="${NPM_REGISTRY:-https://registry.npmmirror.com}"
+PIP_INDEX_URL="${PIP_INDEX_URL:-https://pypi.tuna.tsinghua.edu.cn/simple}"
+
+build_with_args() {
+  docker build \
+    --network="${BUILD_NETWORK}" \
+    --build-arg CACHEBUST="$(date +%s)" \
+    --build-arg NPM_REGISTRY="${NPM_REGISTRY}" \
+    --build-arg PIP_INDEX_URL="${PIP_INDEX_URL}" \
+    -t "${IMAGE_NAME}:${TAG}" .
+}

-if ! docker build --network="${BUILD_NETWORK}" --build-arg CACHEBUST="$(date +%s)" -t "${IMAGE_NAME}:${TAG}" .; then
+if ! build_with_args; then
   if [ "${BUILD_NETWORK}" = "host" ]; then
     echo "host-network build failed (restricted builder?); retrying with default bridge network..." >&2
-    docker build --build-arg CACHEBUST="$(date +%s)" -t "${IMAGE_NAME}:${TAG}" .
+    BUILD_NETWORK="default"
+    build_with_args
   else
     exit 1
   fi
 fi
```

**选型理由**：

- `ARG` 而非 `ENV`：只在构建期生效，不污染运行时容器（容器内 `npm install -g` 仍走用户挂载的 `~/.npmrc`，保留 Agent 运行时自由度）。
- 默认值指向国内镜像：用户群体主要在中国，默认值让"开箱即用"。海外用户/CI 通过 `NPM_REGISTRY=https://registry.npmjs.org ./container/build.sh` 一行覆盖。
- 同时修 pip：同一根因的下一个卡点，顺手解决，避免用户过了 npm 关又卡在 pip 关。
- 不动 feishu-cli / oh-my-zsh 的 github 下载：已有 `--network=host`（line 19）和 `timeout -k 5 90`（line 180）兜底，Surgical Changes 原则——只改卡住的部分。

## 7. 处理卡住的状态

如果当前 `make dev` 正卡在构建中：

```bash
# Ctrl+C 中断 build.sh
# 确认没有残留的 docker build 进程
docker ps -a --filter "status=created" --filter "ancestor=moby/buildkit:buildx-stable-1" -q | xargs -r docker rm -f

# 重新构建（修复后）
./container/build.sh
# 或
make dev
```

## 8. 经验沉淀 / 预防

**核心经验**：`docker build` 的隔离性会屏蔽宿主机所有用户级配置（`~/.npmrc`、`~/.pip/pip.conf`、`~/.cargo/config`、`~/.m2/settings.xml`、`~/.gradle/gradle.properties` 等）。凡是 `RUN <pkg-manager> install` 的步骤，镜像源配置必须在 Dockerfile 内显式声明，不能依赖宿主机。

**通用模式**：

```dockerfile
ARG ${PKG}_MIRROR=<default-mirror>
RUN <pkg-manager> config set registry "${${PKG}_MIRROR}"
```

**预防清单**：

- 新增任何 `RUN <pkg-manager> install` 步骤前，问一句：源在容器内能快速访问吗？如不能，加 `ARG` + `config set`。
- `docker build --check`（BuildKit 1.4+）可静态校验 Dockerfile 语法，改完跑一次。
- `docker history <image>` 可验证 ARG 是否生效、每层 Size 是否合理。
- 建议在 PR 模板里加一行自检："`RUN npm/pip install` 步骤是否设置了国内镜像 ARG（海外 CI 可覆盖）？"

**巡检命令**：

```bash
# 一键检查 Dockerfile 里所有 RUN <pkg> install 是否都配了镜像源
grep -nE "RUN (npm|pip|cargo|go) install" container/Dockerfile
# 对应每个步骤，确认前文有 ARG + config set 或 --index-url / -registry= 参数
```
