# `make dev` 重建 Docker 镜像时 `npm install` / feishu-cli 下载卡死

- 日期：2026-07-15
- 触发命令：`make dev`（内部调用 `./container/build.sh`）
- 平台：macOS 25.2.0（arm64）+ Docker Desktop v5.0.2
- 用户网络：中国大陆（`~/.npmrc` 已设 `registry=https://registry.npmmirror.com`）
- 修复阶段：
  - 阶段一（npm/pip）：commit afbb972
  - 阶段二（github feishu-cli）：本日第二次提交

## 1. 用户现象

### 阶段一：npm install 卡死

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

---

## 阶段二：feishu-cli 从 github.com 下载 hang 死

### 2-1. 用户现象

阶段一修完 npm/pip 后，`make dev` 能走过 `npm install`（35s）和 `pip install`（85s），但卡在 step 11 `RUN ... feishu-cli ...`。日志只输出 `Installing feishu-cli v1.35.0 for arm64` 后 90s+ 无任何新输出，`curl -fsSL https://github.com/.../feishu-cli_*.tar.gz` hang 住不退出，整个构建进程组被信号挂起（T 状态），Ctrl+C 后才能退出。

后端 9898 端口始终未监听，`http://localhost:9898/` 报 `ERR_CONNECTION_REFUSED`。

### 2-2. 问题描述

feishu-cli 的安装步骤从 github.com 下载两类资源：

1. **版本号解析**：`curl -sI https://github.com/riba2534/feishu-cli/releases/latest` 走 302 redirect，从 Location header 提取 tag 名（`v1.35.0`）
2. **release tar.gz 下载**：`curl -fsSL https://github.com/riba2534/feishu-cli/releases/download/${VERSION}/...tar.gz`
3. **源码 tar.gz 下载**：`curl -fsSL https://github.com/riba2534/feishu-cli/archive/refs/tags/${VERSION}.tar.gz`

三个 curl 命令都**没有超时参数**（`--connect-timeout` / `--max-time`），在 github.com 连接被 GFW 阻断时不会失败退出，而是无限 hang。容器内 curl 也读不到宿主机任何代理配置。

### 2-3. 根因

**github.com release 下载在国内裸网络下 hang + curl 无超时**。

阶段一修了 npm/pip 的同类问题，但 github.com 是另一类源——没有官方国内镜像，只能走第三方加速代理。且第三方代理（gh-proxy.com 等）对 `releases/latest` 的 302 redirect 不透传（直接代理返回 200 HTML 或 403），原代码的 `curl -sI | grep location` 方式在 mirror 下无法解析版本号。

证据：

```bash
# 1. 直连 github releases/latest HEAD —— 10s 超时（hang）
$ time curl -sI --connect-timeout 10 --max-time 15 https://github.com/riba2534/feishu-cli/releases/latest
# (无输出, 10s 超时退出)

# 2. ghproxy.com / mirror.ghproxy.com —— 10s 超时（服务已停）
# 3. gh-proxy.com HEAD —— 2.2s 返回 200 HTML, 没有 Location header（不透传 302）

# 4. gh-proxy.com 能代理 api.github.com, 返回完整 JSON:
$ curl -sL https://gh-proxy.com/https://api.github.com/repos/riba2534/feishu-cli/releases/latest | jq -r .tag_name
v1.35.0

# 5. gh-proxy.com 下载 release tar.gz (12.67MB, 4.8s ≈ 2.6 MB/s):
$ curl -sL -o /tmp/feishu-cli-test.tar.gz https://gh-proxy.com/https://github.com/riba2534/feishu-cli/releases/download/v1.35.0/feishu-cli_v1.35.0_linux-arm64.tar.gz
$ ls -la /tmp/feishu-cli-test.tar.gz
-rw-r--r--  12673189  /tmp/feishu-cli-test.tar.gz
$ file /tmp/feishu-cli-test.tar.gz
gzip compressed data, from Unix
```

外部依据：
- gh-proxy.com 是基于 Cloudflare Workers 的 github 加速代理，对 `github.com/<user>/<repo>/releases/download/...`、`api.github.com/...`、`raw.githubusercontent.com/...` 等均能代理。
- 原代码用 302 redirect 方式（CLAUDE.md 注释："和 install.sh 作者自己用的技巧一致，不经 api.github.com 规避 rate limit"），在直连 github 时有效；但 mirror 不透传 redirect，必须改用 api.github.com + jq。

### 2-4. 复现路径

```bash
# 清空构建缓存, 强制 feishu-cli 步骤重跑
docker builder prune -f

# 直连 github (默认 GITHUB_MIRROR 空) → hang
GITHUB_MIRROR= ./container/build.sh
# 日志卡在: Installing feishu-cli v1.35.0 for arm64  ← 无进展

# 修复后走 mirror → 16s 完成
./container/build.sh
# 或显式: GITHUB_MIRROR=https://gh-proxy.com/ ./container/build.sh
```

### 2-5. 诊断方法

```bash
# (1) 看构建日志里 feishu-cli 步骤的 MIRROR 值
docker history deepthink-agent:latest --format '{{.CreatedBy}}' | grep -oE "MIRROR=[^ ]+"

# (2) 验证 mirror 能否解析版本号 (应输出 v1.35.0)
curl -sL --max-time 15 https://gh-proxy.com/https://api.github.com/repos/riba2534/feishu-cli/releases/latest | jq -r .tag_name

# (3) 验证 mirror 能否下载 release tar.gz (应 200 + gzip 数据)
curl -sLI --max-time 15 https://gh-proxy.com/https://github.com/riba2534/feishu-cli/releases/download/v1.35.0/feishu-cli_v1.35.0_linux-arm64.tar.gz | head -1

# (4) 测当前网络到 github.com 的延迟 (判断是否需要 mirror)
time curl -sI --connect-timeout 10 https://github.com/riba2534/feishu-cli/releases/latest -o /dev/null
```

### 2-6. 修复方案

**container/Dockerfile**（关键 diff）：

```diff
 ARG TARGETARCH
+# GITHUB_MIRROR default to gh-proxy.com: github.com release 下载在国内裸网络下 hang,
+# 第三方 mirror 不透传 302 redirect (返回 200 HTML), 原来的 `curl -sI | grep location`
+# 在 mirror 下无法解析版本. 改走 api.github.com (通过 mirror 代理, 规避 rate limit) +
+# jq 解析 tag_name. 所有 curl 加超时, 避免无限 hang.
+# 海外/CI 直连: --build-arg GITHUB_MIRROR= (空字符串)
+ARG GITHUB_MIRROR=https://gh-proxy.com/
 RUN set -e && \
     ARCH="${TARGETARCH:-$(dpkg --print-architecture)}" && \
-    VERSION=$(curl -sI "https://github.com/riba2534/feishu-cli/releases/latest" \
-      | grep -i '^location:' | head -1 \
-      | sed 's|.*/tag/\([^[:space:]]*\).*|\1|' | tr -d '\r\n') && \
+    MIRROR="${GITHUB_MIRROR}" && \
+    gh_url() { echo "${MIRROR}${1}"; } && \
+    VERSION=$(curl -fsSL --connect-timeout 30 --max-time 60 \
+      "$(gh_url https://api.github.com/repos/riba2534/feishu-cli/releases/latest)" \
+      | jq -r .tag_name) && \
     ...
-    curl -fsSL "https://github.com/riba2534/feishu-cli/releases/download/${VERSION}/..." \
+    curl -fsSL --connect-timeout 30 --max-time 300 \
+      "$(gh_url https://github.com/riba2534/feishu-cli/releases/download/${VERSION}/...)" \
       | tar -xz --strip-components=1 -C /usr/local/bin && \
```

**container/build.sh**（关键 diff）：

```diff
-GITHUB_MIRROR="${GITHUB_MIRROR:-https://gh-proxy.com/}"
+# 用 ${var-default} (不带冒号), 允许 GITHUB_MIRROR= (空) 表示直连
+GITHUB_MIRROR="${GITHUB_MIRROR-https://gh-proxy.com/}"

 build_with_args() {
   docker build \
     ...
     --build-arg GITHUB_MIRROR="${GITHUB_MIRROR}" \
     -t "${IMAGE_NAME}:${TAG}" .
 }
```

**选型理由**：

- `GITHUB_MIRROR` 默认指向 `gh-proxy.com`：国内用户开箱即用。gh-proxy 基于 Cloudflare Workers，全球节点，海外用户走它也不会显著变慢。
- `${var-default}` 不带冒号：让 `GITHUB_MIRROR=` (空字符串) 表示"直连"，而不是"用默认值"。区分"用户未设"和"用户明确要直连"。
- 版本解析从 302 redirect 改成 api.github.com + jq：mirror 不透传 302，但能代理 api.github.com 返回 JSON。通过 mirror 代理 api 调用，rate limit 走 mirror IP，规避了 CLAUDE.md 说的"不经 api.github.com 规避 rate limit"顾虑。
- 所有 curl 加 `--connect-timeout 30 --max-time 300`：即使 mirror 也挂了，5 分钟内必然失败退出，不会无限 hang 卡死整个 `make dev`。
- 不动 oh-my-zsh 下载（line 180）：已有 `timeout -k 5 90` + `|| echo` 兜底，best-effort 失败不影响构建。

### 2-7. 处理卡住的状态

如果 `make dev` 当前卡在 feishu-cli 下载：

```bash
# 1. Ctrl+C 中断 build.sh
# 2. 清掉所有挂起的 build 进程 (T 状态的僵尸)
pkill -9 -f "buildx build" ; pkill -9 -f "docker build" ; pkill -9 -f "container/build.sh"

# 3. 确认端口空闲 (旧 make dev 的孤儿前端可能占 5173)
lsof -ti:5173 -sTCP:LISTEN | xargs -r kill -9
lsof -ti:9898 -sTCP:LISTEN | xargs -r kill -9

# 4. 重新构建 (修复后会走 gh-proxy, 16s 完成该步骤)
./container/build.sh

# 5. 再 make dev
make dev
```

如果手头急需用后端而构建卡着，可临时绕过 Docker 重建，直接用 tsx 跑后端（不依赖容器）：

```bash
make dev-backend   # 后端 9898
make dev-web       # 前端 5173 (另开终端)
```

### 2-8. 经验沉淀 / 预防

**核心经验**：Docker 构建里凡是 `RUN curl` 下载外部资源，**必须带 `--connect-timeout` + `--max-time`**，否则一次网络抖动就会让整个构建无限 hang。这是比"镜像源配置"更底层的兜底——镜像源解决"慢"，超时解决"卡死"。

**github 加速的几种方式对比**：

| 方式 | 版本解析 | release 下载 | 可用性 |
|------|---------|-------------|--------|
| 直连 github | 302 redirect 可解析 | 可下载(慢) | 国内 hang |
| gh-proxy.com | ❌ 不透传 302 (返回 200 HTML) | ✓ 2.6 MB/s | Cloudflare, 稳定 |
| gh-proxy + api.github.com | ✓ JSON + jq | ✓ | 推荐 |
| ghproxy.com / mirror.ghproxy.com | - | - | 服务已停 |

**通用模式**：

```dockerfile
ARG GITHUB_MIRROR=https://gh-proxy.com/
RUN MIRROR="${GITHUB_MIRROR}" && \
    gh_url() { echo "${MIRROR}${1}"; } && \
    curl -fsSL --connect-timeout 30 --max-time 300 "$(gh_url https://github.com/...)" ...
```

**预防清单**：

- 新增 `RUN curl` 下载 github.com / raw.githubusercontent.com / api.github.com 资源时：
  1. 用 `$(gh_url ...)` 走 mirror
  2. 加 `--connect-timeout 30 --max-time 300`
  3. 版本号用 `api.github.com + jq` 而非 302 redirect
- `docker build --check` 校验 Dockerfile 语法
- `docker history <image>` 验证 ARG 生效 + 每步耗时

**巡检命令**：

```bash
# 检查所有 RUN curl 是否带了 --max-time (防止再出现无超时的 hang)
grep -nE "RUN.*curl" container/Dockerfile | grep -vE "max-time|connect-timeout"
# 期望无输出; 有输出说明该 curl 缺超时, 需补上
```

