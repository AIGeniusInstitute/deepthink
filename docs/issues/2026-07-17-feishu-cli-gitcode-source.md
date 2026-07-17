# 容器构建下载 feishu-cli 失败（gh-proxy 镜像整体不可用）

- 日期：2026-07-17
- 触发命令：`make start PORT=9898`（内部调用 `./container/build.sh`）
- 平台：Linux 5.15.0-48-generic（amd64）+ Docker Desktop（buildx `desktop-linux` builder）
- 用户网络：中国大陆（`github.com` TCP 不通，docker hub 直连不通）
- 修复：feishu-cli 依赖源由 GitHub release 二进制切换为 `gitcode.com/AIGeniusInstitute/feishu-cli` 源码自编译

## 1. 用户现象

执行 `make start PORT=9898` 时，Makefile 检测到本地无 `deepthink-agent:latest` 镜像，触发 `./container/build.sh` 构建。构建在 `[stage-0 11/19]` 的 feishu-cli 下载步骤连续两次失败：

```
🐳 Docker 镜像不存在，正在构建...

=== 第一次（host 网络 + gh-proxy.com）===
=> ERROR [stage-0 11/19] RUN ... feishu-cli ...  318.2s
17.99 Installing feishu-cli v1.35.0 for amd64 (mirror: https://gh-proxy.com/)
318.1 curl: (28) Operation timed out after 300001 milliseconds with 2046091 out of 13745770 bytes received
318.1 gzip: stdin: unexpected end of file
318.1 tar: Unexpected EOF in archive

=== 第二次（回退 default bridge 网络 + gh-proxy.com）===
=> ERROR [stage-0 11/19] RUN ... feishu-cli ...  1.2s
1.113 curl: (22) The requested URL returned error: 403
1.124 ERROR: 无法解析 feishu-cli 最新版本 (GITHUB_MIRROR=https://gh-proxy.com/)
```

第一次超时（13.7MB 二进制只下到 2MB），第二次直接 403。镜像无法构建，`make start` 无法启动服务。

## 2. 问题描述

`container/build.sh` 默认 `GITHUB_MIRROR=https://gh-proxy.com/`，`container/Dockerfile` 的 feishu-cli 安装段把该前缀拼到所有下载 URL 前：

- 版本探测：`https://gh-proxy.com/https://api.github.com/.../releases/latest`
- 二进制：`https://gh-proxy.com/https://github.com/.../releases/download/v1.35.0/feishu-cli_v1.35.0_linux-amd64.tar.gz`
- 源码 archive：`https://gh-proxy.com/https://github.com/.../archive/refs/tags/v1.35.0.tar.gz`

`gh-proxy.com` 当前对该仓库的下载整体不可用（超时 + 403）。即使设 `GITHUB_MIRROR=`（空，直连），下载 URL 变回 `https://github.com/...`，而 `github.com` 本身在国内裸网络下 TCP 不通（见根因），依旧无法下载。

## 3. 根因

**`github.com` 域名 TCP 不通 + 公共 ghproxy 镜像整体失效**，二者叠加使原 gh-proxy 拼接方案彻底不可用。

证据链（均来自构建期同网络的实测）：

```bash
# 1. github.com 本身 TCP 不通 —— release 下载第一步就要连 github.com 拿 302 跳转，
#    连不上即整步超时 (这就是 "Operation timed out" 的源头)
$ for H in github.com api.github.com codeload.github.com objects.githubusercontent.com; do
    printf "%-32s " "$H"
    timeout 6 bash -c "exec 3<>/dev/tcp/$H/443 && echo TCP-OK" 2>/dev/null || echo TCP-FAIL
  done
github.com                       TCP-FAIL     ← 不通
api.github.com                   TCP-OK       ← 通
codeload.github.com              TCP-OK       ← 通
objects.githubusercontent.com    TCP-OK       ← release 二进制实际 CDN，通

# 2. 9 个公共 ghproxy 镜像实测下载 13.7MB 二进制，全部失败
$ for M in gh-proxy.com ghfast.top ghproxy.cc ghproxy.net gh.api.99988866.xyz \
           gh.llkk.cc github.moeyy.xyz gh.h233.eu.org ghps.cc mirror.ghproxy.com; do
    curl -fsSL --max-time 25 -o /dev/null -w "$M: HTTP %{http_code}\n" \
      "https://$M/https://github.com/riba2534/feishu-cli/releases/download/v1.35.0/feishu-cli_v1.35.0_linux-amd64.tar.gz"
  done
# 结果: 9 个全部 HTTP 000 / 403 / 404 (SSL 超时 / 限流 / 路径失效)

# 3. 默认 GITHUB_MIRROR= (直连) 也不行 —— 因 RUN 里下载 URL 仍走 github.com (TCP-FAIL)
$ curl -fSL --max-time 200 https://github.com/riba2534/feishu-cli/releases/download/v1.35.0/feishu-cli_v1.35.0_linux-amd64.tar.gz
curl: (28) Connection timeout after 15001 ms   # 连 github.com 都连不上
```

外部依据：`gh-proxy.com` 等第三方公共 GitHub 代理为免费服务，长期面临被滥用 / 限流 / 域名失效，无 SLA；项目 CLAUDE.md 原注释也提到“第三方 mirror (gh-proxy.com 等) 不透传 302 redirect (返回 200 HTML)”，本身就脆弱。

## 4. 复现路径

1. 在 `github.com` TCP 不通、docker hub 直连不通的中国大陆网络环境
2. `cd ~/deepthink && make start PORT=9898`（或 `make dev`，首次构建时）
3. 若本地无 `deepthink-agent:latest` 镜像 → 触发 `./container/build.sh`
4. 构建到 `[stage-0 11/19]` feishu-cli 段，`curl https://gh-proxy.com/https://github.com/...` 超时或 403
5. 镜像构建失败，`make start` 退出

## 5. 诊断方法

```bash
# (a) 确认 github.com / docker hub 是否直连通 (本机)
for H in github.com registry-1.docker.io; do
  printf "%-28s " "$H"
  timeout 6 bash -c "exec 3<>/dev/tcp/$H/443 && echo TCP-OK" 2>/dev/null || echo TCP-FAIL
done

# (b) 批量测公共 ghproxy 镜像对该二进制是否可用
URL="https://github.com/riba2534/feishu-cli/releases/download/v1.35.0/feishu-cli_v1.35.0_linux-amd64.tar.gz"
for M in gh-proxy.com ghfast.top ghproxy.cc ghproxy.net; do
  curl -fsSL --max-time 25 -o /dev/null -w "$M: %{http_code}\n" "https://$M/$URL"
done

# (c) 验证 gitcode 仓库可达性 + 是否有预编译二进制 / tag
timeout 6 bash -c "exec 3<>/dev/tcp/gitcode.com/443 && echo gitcode TCP-OK"
GIT_TERMINAL_PROMPT=0 git ls-remote https://gitcode.com/AIGeniusInstitute/feishu-cli.git
# → 只有 refs/heads/main, 无任何 tag —— 即 gitcode 无 release 二进制

# (d) 验证源码自编译链路 (Go 工具链 CDN + 模块代理)
curl -fsSI --max-time 20 https://dl.google.com/go/go1.21.13.linux-amd64.tar.gz | grep -iE "^(HTTP|content-length)"
curl -fsSL --max-time 15 -o /dev/null -w "goproxy.cn cobra: %{http_code}\n" "https://goproxy.cn/github.com/spf13/cobra/@latest"
```

## 6. 修复方案

**将 feishu-cli 依赖源从 GitHub release 预编译二进制切换为 `gitcode.com/AIGeniusInstitute/feishu-cli` 源码自编译**，全程不碰 `github.com` 与任何 ghproxy 镜像。

选型理由：

| 候选 | 评估 | 取舍 |
|------|------|------|
| 换一个还活着的 ghproxy 镜像 | 实测 9 个全挂，免费公共代理无 SLA，今天换明天又挂 | ❌ 治标不治本 |
| `GITHUB_MIRROR=` 直连 | `github.com` TCP-FAIL，连 302 都拿不到 | ❌ 网络层不通 |
| `api.github.com/assets/{id}` + `codeload` 端点绕过 github.com | 域名虽通，但下载 ~130KB/s 不稳，且仍依赖 GitHub 域名 | ⚠️ 备选，非用户要求 |
| **gitcode 源码自编译**（采纳） | gitcode TCP-OK 0.5s（DeepThink 组织镜像，可信）；Go CDN + goproxy.cn 均实测可达；二进制 + skills 同源 | ✅ |

关键事实：`gitcode.com/AIGeniusInstitute/feishu-cli` 是 DeepThink 组织维护的源码镜像，但**只镜像了 `main` 分支源码，无 release 预编译二进制、无版本 tag**（`git ls-remote` 仅返回 `refs/heads/main`）。因此只能从源码 `go build` 编译出二进制，skills/ 目录直接从同一次 clone 拿（省去原第二个 archive 下载，二进制与 skills 天然同源）。

`container/Dockerfile` feishu-cli 段重写（原 `ARG GITHUB_MIRROR ... RUN ... curl gh_url(...) tar` 整段替换）：

```diff
- # Install feishu-cli (binary + builtin skills), 始终跟踪 latest release。
- # ... 原注释: GITHUB_MIRROR ARG 默认 https://gh-proxy.com/ 拼 URL ...
- ARG GITHUB_MIRROR=https://gh-proxy.com/
- ARG TARGETARCH
- RUN set -e && \
-     ARCH="${TARGETARCH:-$(dpkg --print-architecture)}" && \
-     MIRROR="${GITHUB_MIRROR}" && \
-     gh_url() { echo "${MIRROR}${1}"; } && \
-     VERSION=$(curl -fsSL --connect-timeout 30 --max-time 60 \
-       "$(gh_url https://api.github.com/repos/riba2534/feishu-cli/releases/latest)" \
-       | jq -r .tag_name) && \
-     ... curl "$(gh_url https://github.com/.../releases/download/...tar.gz)" | tar -xz ... && \
-     ... curl "$(gh_url https://github.com/.../archive/...tar.gz)" | tar -xz ...
+ # Install feishu-cli (binary + builtin skills), 始终跟踪 gitcode main 最新源码。
+ # 背景: github.com 国内 TCP 不通; ghproxy 镜像整体不可用. gitcode 镜像只
+ # 有 main 源码无预编译二进制, 改为源码自编译 (Go 工具链 dl.google.com +
+ # 模块 goproxy.cn, 编译后清理不留主镜像), 全程不碰 github.com / ghproxy.
+ ARG GITHUB_MIRROR=https://gh-proxy.com/   # 保留声明兼容 build.sh, 本段不再使用
+ ARG TARGETARCH
+ ARG GO_VERSION=1.21.13
+ RUN set -e && \
+     ARCH="${TARGETARCH:-$(dpkg --print-architecture)}" && \
+     curl -fsSL --retry 3 --retry-delay 5 "https://dl.google.com/go/go${GO_VERSION}.linux-${ARCH}.tar.gz" \
+       | tar -xz -C /usr/local && \
+     export GOROOT=/usr/local/go GOPATH=/tmp/gopath PATH="/usr/local/go/bin:$PATH" && \
+     SRC_TMP=$(mktemp -d) && \
+     git clone --depth 1 https://gitcode.com/AIGeniusInstitute/feishu-cli.git "$SRC_TMP/feishu-cli" && \
+     cd "$SRC_TMP/feishu-cli" && \
+     GOPROXY=https://goproxy.cn,direct GOSUMDB=off GOFLAGS=-mod=mod \
+       CGO_ENABLED=0 GOOS=linux GOARCH=${ARCH} \
+       go build -trimpath -o /usr/local/bin/feishu-cli . && \
+     feishu-cli --version && \
+     mkdir -p /opt/builtin-skills && cp -r skills/. /opt/builtin-skills/ && \
+     rm -rf /usr/local/go "$GOPATH" "$SRC_TMP" && \
+     ls /opt/builtin-skills/
```

设计要点：

1. **Go 工具链不留在主镜像**：从 `dl.google.com` 下载官方二进制到 `/usr/local/go`，编译完 `rm -rf /usr/local/go`，主镜像只多 `feishu-cli` 二进制（~29MB）+ skills。
2. **不引入新 docker 基础镜像**：未用 `FROM golang:1.21 AS builder` 多 stage，因为 `registry-1.docker.io` 直连不通，拉 `golang:1.21` 新镜像层有风险；`dl.google.com` 实测 TCP-OK 更稳。
3. **模块依赖走 goproxy.cn**：`GOPROXY=https://goproxy.cn,direct`，实测可拉 feishu-cli 全部 22 个依赖（含 `github.com/larksuite/oapi-sdk-go/v3` 飞书 SDK、cobra 等）。`GOSUMDB=off` 避免 sum.golang.org 国内不通。
4. **`CGO_ENABLED=0` 纯静态**：与 feishu-cli 官方 Makefile 一致，跨架构交叉编译，无 C 工具链依赖。
5. **始终跟踪 latest**：`git clone --depth 1` 总是拉 gitcode main 最新，语义等价于原“跟踪 latest release”。
6. **`GITHUB_MIRROR` ARG 保留声明**：`build.sh` 仍传 `--build-arg GITHUB_MIRROR=...`，删了会产生 unknown-arg warning；保留声明无害，注释标注已废弃。
7. **`feishu-cli --version` 输出 `dev (built unknown)`**：源码编译无 ldflags 注入版本号，仅自检能跑即可；二进制与 skills 同源，原“binary 与 skills 共享 $VERSION 一致”的语义由“同一次 clone”自然满足。

全链路实测（构建前在宿主机用 gitcode clone 的源码验证）：

```bash
$ cd /tmp/gc-feishu   # git clone --depth 1 https://gitcode.com/AIGeniusInstitute/feishu-cli.git
$ GOPROXY=https://goproxy.cn,direct GOSUMDB=off \
    CGO_ENABLED=0 GOOS=linux GOARCH=amd64 go build -trimpath -o /tmp/feishu-cli .
go: downloading github.com/spf13/cobra v1.8.0
go: downloading github.com/larksuite/oapi-sdk-go/v3 v3.5.3
... (22 个模块全部从 goproxy.cn 拉到)
$ /tmp/feishu-cli --version
feishu-cli version dev (built unknown)   # 产物 29MB, 自检通过
```

## 7. 处理卡住的状态

本次构建失败未产生 stuck 运行态（镜像没构建出来，`make start` 直接退出）。若此前有半成品镜像层残留，无需特殊清理——`docker build` 会复用 stage-0 1~10 步缓存，仅 11 步起重新执行。

## 8. 经验沉淀 / 预防

1. **不要把构建链路绑定到无 SLA 的免费公共代理**。`gh-proxy.com` 等 ghproxy 镜像是社区免费服务，被滥用 / 限流 / 域名失效是常态。构建应优先选择 DeepThink 组织可控源（gitcode 镜像）或官方稳定 CDN（`dl.google.com`、`goproxy.cn`）。
2. **国内网络下，构建依赖应分别验证每个域名的 TCP 可达性**，而非假设“有镜像就行”。本次根因就是 `github.com` 本身不通 + 镜像同时挂掉的双重失败。诊断脚本（见 §5）可纳入构建故障排查 SOP。
3. **`docker build` 上下文与宿主机配置隔离**：宿主机 `~/.npmrc` / `~/.gitconfig` / proxy 环境变量都不进 buildkit RUN，镜像内必须显式配置（本项目对 npm/pip 已做，本次补齐 Go 工具链与模块代理）。
4. **预编译二进制不可得时，源码自编译是可靠 fallback**：Go 项目的 `CGO_ENABLED=0` 静态编译 + 官方 CDN 工具链 + goproxy 模块代理，构成一条国内全程可达的编译链路，可复用于其他“GitHub release 二进制下载难”的依赖。
5. **巡检建议**：CI 可加一个轻量 job，定期 `curl -fsSI https://dl.google.com/go/go1.21.13.linux-amd64.tar.gz` 与 `git ls-remote https://gitcode.com/AIGeniusInstitute/feishu-cli.git`，任一不通则告警，避免某天 gitcode 镜像停止同步时构建静默失败。
