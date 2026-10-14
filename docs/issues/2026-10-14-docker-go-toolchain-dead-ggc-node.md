# 容器构建下载 Go 工具链超时：dl.google.com 被解析到不响应的 GGC 节点

- 日期：2026-10-14
- 触发命令：`./scripts/rebuild-restart.sh 9999`（内部 `make start-prod PORT=9999` → `_ensure-docker-image` → `./container/build.sh`）
- 平台：macOS (Darwin 24.6.0, arm64) + Docker Desktop（buildx `desktop-linux` builder, buildkit v0.32.2）
- 用户网络：中国大陆
- 修复：Go 工具链下载由「单押 `dl.google.com`」改为「多源按序回退」，默认 阿里云 → 南京大学 → `dl.google.com`

## 1. 用户现象

执行 `./scripts/rebuild-restart.sh 9999` 重新编译部署本机实例，构建 agent 镜像时在 `[stage-0 11/19]`（feishu-cli 源码自编译段）失败：

```
0.592 Downloading Go 1.21.13 (arm64) from dl.google.com
30.73 curl: (28) Failed to connect to dl.google.com port 443 after 30006 ms: Timeout was reached
65.74 curl: (28) Failed to connect to dl.google.com port 443 after 30002 ms: Timeout was reached
100.8 curl: (28) Failed to connect to dl.google.com port 443 after 30011 ms: Timeout was reached
135.8 curl: (28) Failed to connect to dl.google.com port 443 after 30005 ms: Timeout was reached
135.8 gzip: stdin: unexpected end of file
135.8 tar: Child returned status 1
135.8 tar: Error is not recoverable: exiting now
```

四次重试**全部**是 connect 阶段 30s 超时（不是慢、不是掉包率），耗时 135s 后整层失败，镜像构建不出来，实例起不来。

关键反差：**同一时刻在 macOS 宿主机上手敲 `curl` 下载同一个 URL 是 200 成功的**，所以在宿主机上排查会得出「网络没问题」的错误结论。

## 2. 问题描述

`container/Dockerfile` 第 11 步为了自编译 feishu-cli（见 [`2026-07-17-feishu-cli-gitcode-source.md`](2026-07-17-feishu-cli-gitcode-source.md)），需要先从 `dl.google.com` 拉 Go 1.21.13 官方二进制：

```dockerfile
curl -fsSL --connect-timeout 30 --max-time 180 --retry 3 --retry-delay 5 \
  "https://dl.google.com/go/${GO_TARBALL}"      # ← 单一硬编码源
  | tar -xz -C /usr/local
```

`dl.google.com` 在 `--network=host` 的 build 里被解析到一个 **TCP 443 完全不响应**的 IP，`--retry 3` 打的是同一个 URL、同一台主机，因此 4 次尝试全灭。宿主机成功只是**运气好**——落在轮询里的另一个（健康的）节点上。

## 3. 根因

**`dl.google.com` 在国内是被解析到一组 GGC（Google Global Cache）节点，其中一部分节点 443 端口不响应；构建环境恰好被解析到并"钉死"在坏节点上。**

证据链（全部为实测，非推断）：

```bash
# 1. 宿主机 dig 连续 6 次：轮询在 3 个 IP 之间跳（说明是一组节点，不是单点）
$ for i in 1 2 3 4 5 6; do dig +short dl.google.com | tr '\n' ' '; echo; done
180.163.150.33
202.101.48.97
202.101.48.97
202.101.48.65
180.163.150.33
202.101.48.97

# 2. 逐个 IP 直连（--resolve 绕过 DNS）：只有 180.163.150.33 是活的
$ for ip in 180.163.150.33 202.101.48.97 202.101.48.65; do
    printf '%-18s ' "$ip"
    curl -sSI --connect-timeout 8 --max-time 12 \
      --resolve dl.google.com:443:$ip https://dl.google.com/go/go1.21.13.linux-arm64.tar.gz | head -1
  done
180.163.150.33     HTTP/2 200        ← 活
202.101.48.97      curl: (28) ... Timeout was reached   ← 死
202.101.48.65      curl: (28) ... Timeout was reached   ← 死

# 3. 容器侧（--network host，与 docker build 同一网络路径）连续 8 次：
#    解析结果被钉死在坏节点上，8/8 失败 —— 这正是 --retry 救不回来的原因
$ docker run --rm --network host alpine:3.20 sh -c '
    for i in $(seq 1 8); do
      ip=$(nslookup dl.google.com | grep -m1 "^Address: " | awk "{print \$2}")
      wget -T 8 -q -O /dev/null https://dl.google.com/go/go1.21.13.linux-arm64.tar.gz \
        && echo "try $i: ip=$ip OK" || echo "try $i: ip=$ip FAIL"
    done'
  try 1: ip=202.101.48.65 FAIL
  try 2: ip=202.101.48.65 FAIL
  ...（连续 8 次全是同一个坏 IP）
  => OK=0 FAIL=8
```

容器内解析走的是 Docker Desktop 的 DNS 代理（`/etc/resolv.conf` → `nameserver 192.168.65.7`），它把 `dl.google.com` 的答案**长期固定在** `202.101.48.65`（坏节点）；而 macOS 宿主机自己的解析器在三个 IP 间轮询，抽到活节点就能成功。二者的差异解释了「宿主机 curl 200、docker build 全超时」这个反直觉现象。

**上一版修复的假设被证伪**：[`2026-07-17-feishu-cli-gitcode-source.md`](2026-07-17-feishu-cli-gitcode-source.md) 的设计要点里写着「`dl.google.com` 实测 TCP-OK 更稳」——那是在**宿主机 shell** 里测的，且只测了一次。同一域名在 build 容器里的可用性取决于解析到哪个节点，属于**概率性可用**，不适合做唯一硬依赖。

## 4. 复现路径

```bash
# 1. 在任意项目 checkout 里重建 agent 镜像
cd ~/deepthink
./container/build.sh

# 2. 构建到 [stage-0 11/19] 时观察：宿主机 curl 同一 URL 成功，但 build 内 4 次
#    connect 超时后整层报错：
#      curl: (28) Failed to connect to dl.google.com port 443 after 30006 ms
#      gzip: stdin: unexpected end of file

# 3. 判定当前是否命中坏节点（容器侧解析）
docker run --rm --network host alpine:3.20 sh -c \
  'nslookup dl.google.com | grep -A1 "^Name:" | tail -1'
# 输出 202.101.48.65 / 202.101.48.97 → 命中坏节点，构建必挂
# 输出 180.163.150.33        → 命中活节点，构建能过（但不可依赖）
```

## 5. 诊断方法

```bash
# ① 宿主机视角（经常是"好的"，有误导性）
curl -fsSI --max-time 20 https://dl.google.com/go/go1.21.13.linux-arm64.tar.gz | head -1

# ② 容器视角（与 docker build 同网络路径）—— 这才是构建实际看到的
docker run --rm --network host alpine:3.20 sh -c \
  'nslookup dl.google.com | grep -A1 "^Name:" | tail -1;
   wget -T 8 -q -O /dev/null https://dl.google.com/go/go1.21.13.linux-arm64.tar.gz \
     && echo "dl.google.com OK" || echo "dl.google.com FAIL"'

# ③ 逐个 IP 判断节点死活（坏的节点表现为 connect 超时，不是 5xx）
dig +short dl.google.com | while read ip; do
  printf '%-18s ' "$ip"
  curl -sSI --connect-timeout 8 --max-time 12 \
    --resolve dl.google.com:443:$ip https://dl.google.com/go/go1.21.13.linux-arm64.tar.gz 2>&1 | head -1
done

# ④ 候选镜像源连通性 + 完整性（63,753,135 bytes / gzip 校验通过 才算可用）
docker run --rm --network host alpine:3.20 sh -c '
  for base in https://mirrors.aliyun.com/golang https://mirror.nju.edu.cn/golang \
              https://mirrors.ustc.edu.cn/golang https://mirrors.tuna.tsinghua.edu.cn/golang \
              https://goproxy.cn/golang https://golang.google.cn/dl https://dl.google.com/go; do
    printf "%-52s " "$base"
    wget -T 25 -q -O /tmp/g.tgz "$base/go1.21.13.linux-arm64.tar.gz" 2>/dev/null && gzip -t /tmp/g.tgz 2>/dev/null \
      && echo "OK $(stat -c %s /tmp/g.tgz)" || echo "FAIL"; rm -f /tmp/g.tgz
  done'
```

本次实测结果（2026-10-14，容器内 `--network host`）：

| 源 | 结果 |
|---|---|
| `https://mirrors.aliyun.com/golang` | ✅ OK 63753135 bytes |
| `https://mirror.nju.edu.cn/golang` | ✅ OK 63753135 bytes |
| `https://dl.google.com/go` | ❌ 本轮解析到坏节点 |
| `https://mirrors.ustc.edu.cn/golang` | ❌ 302 跳回 `dl.google.com`（等于没有镜像，坏节点问题原样继承） |
| `https://mirrors.tuna.tsinghua.edu.cn/golang` | ❌ 404（该路径下无 `go1.21.13` 文件） |
| `https://goproxy.cn/golang` | ❌ 404（goproxy.cn 只作 Go module proxy，不镜像工具链 tarball） |
| `https://mirrors.cloud.tencent.com/golang`、`https://mirrors.bfsu.edu.cn/golang`、`https://golang.google.cn/dl` | ❌ FAIL |

**教训**：判断镜像可用性必须**在构建环境内**下载完整文件并校验，不能只看 `curl -I` 的 200/302 —— USTC 那个 302 看着像"有镜像"，实际是把你送回坏节点。

## 6. 修复方案

`container/Dockerfile` 第 11 步：单一硬编码 URL 改成**多源按序回退 + 下载后校验**。

```diff
 ARG GITHUB_MIRROR=https://gh-proxy.com/
 ARG TARGETARCH
 ARG GO_VERSION=1.21.13
+# 空格分隔的候选下载源, 按序尝试, 第一个成功即止 (均指向官方 go${VERSION}.linux-*.tar.gz).
+# 境外/CI 可只留官方源: --build-arg GO_DOWNLOAD_BASES=https://dl.google.com/go
+ARG GO_DOWNLOAD_BASES="https://mirrors.aliyun.com/golang https://mirror.nju.edu.cn/golang https://dl.google.com/go"
 RUN set -e && \
     ARCH="${TARGETARCH:-$(dpkg --print-architecture)}" && \
     GO_TARBALL="go${GO_VERSION}.linux-${ARCH}.tar.gz" && \
-    echo "Downloading Go ${GO_VERSION} (${ARCH}) from dl.google.com" && \
-    curl -fsSL --connect-timeout 30 --max-time 180 --retry 3 --retry-delay 5 \
-      "https://dl.google.com/go/${GO_TARBALL}" \
-      | tar -xz -C /usr/local && \
+    GO_TGZ="/tmp/${GO_TARBALL}" && \
+    FETCHED=0 && \
+    for BASE in ${GO_DOWNLOAD_BASES}; do \
+      echo "Downloading ${GO_TARBALL} from ${BASE}"; \
+      if curl -fsSL --connect-timeout 20 --max-time 300 --retry 2 --retry-delay 3 \
+           "${BASE}/${GO_TARBALL}" -o "${GO_TGZ}" && gzip -t "${GO_TGZ}"; then \
+        FETCHED=1; break; \
+      fi; \
+      echo "  -> ${BASE} failed, trying next source"; \
+    done && \
+    [ "${FETCHED}" = "1" ] || { echo "ERROR: all Go download sources failed: ${GO_DOWNLOAD_BASES}" >&2; exit 1; } && \
+    tar -xzf "${GO_TGZ}" -C /usr/local && \
+    rm -f "${GO_TGZ}" && \
     export GOROOT=/usr/local/go && \
```

选型理由：

1. **换源而不是加 `--retry` / 调大超时**。坏节点的特征是 TCP 连接不建立，重试同一个 URL 只会重复超时（实测 8/8 全灭）；只有**换一个域名**才能绕开。所以修复的核心是"多源"，不是"重试参数"。
2. **默认阿里云 → 南京大学 → 官方源**。前两个是国内 CDN，解析稳定、实测下载完整；把官方 `dl.google.com` 留在最后，保证境外 / CI 环境不依赖国内镜像也能构建。架构上三个源都提供**同一份官方 tarball**（同一 `go${GO_VERSION}.linux-${ARCH}.tar.gz`），不存在内容分叉。
3. **从 `curl | tar` 改为先落盘 + `gzip -t` 校验再解包**。多源回退必须能在"下到半截 / 拿到错误页"时判定失败并继续试下一个源；流式管道下 `curl` 的失败状态会被 `tar` 的失败掩盖（本次报错里 `gzip: stdin: unexpected end of file` 就是这么来的），落盘后 `gzip -t` 是一次明确、廉价的完整性判定（63MB 文件校验 < 1s）。
4. **`GO_DOWNLOAD_BASES` 用 ARG 暴露**。与既有 `APT_MIRROR` / `NPM_REGISTRY` / `PIP_INDEX_URL` 的镜像可覆盖约定一致，境外用户 `--build-arg GO_DOWNLOAD_BASES=https://dl.google.com/go` 即可回到纯官方源。
5. **不引入 `golang:1.21` 多阶段构建**。该方案要拉新基础镜像（`registry-1.docker.io` 直连不稳），把一个"换下载源"的问题升级成"换基础镜像"的问题，与 2026-07-17 的选型结论一致。

## 7. 处理卡住的状态

本次失败没有产生 stuck 运行态：镜像没构建出来，`make start-prod` 在构建阶段就退出，端口上没有半死不活的实例。BuildKit 缓存保留在 `[stage-0 1..10]`，修复后重跑直接从第 11 步继续，不会白跑前 10 层。

若遇到"实例起来了但 watchdog 反复重启"（构建失败期间手改过服务），按 §11 的规范停实例：`make stop-prod PORT=9999`，**不要**用 `lsof -ti:PORT | xargs kill`（会连 Docker/OrbStack 网络代理一起杀掉）。

## 8. 经验沉淀 / 预防

1. **构建依赖不许"单点硬编码"**。这是本项目第二次栽在同一形态上：2026-07-17 是 `gh-proxy.com` 单点（整体挂掉），本次是 `dl.google.com` 单点（概率性可达）。凡是构建期要从外部域名拉东西的地方，都应具备**至少一个同类备源**。
2. **"实测可达"必须在构建环境内测，且要测多次**。本次根因能成立，全靠"宿主机 curl 成功、容器内 8/8 失败"这组对比；只在宿主机测一次就写进注释，正是上一版修复留下隐患的原因。
3. **`302` 不等于镜像可用**。USTC 的 `/golang/` 只是把请求 302 回 `dl.google.com`，坏节点问题原样继承；判定镜像源必须**下载完整文件 + 校验完整性**。
4. **容器解析走 Docker Desktop 的 DNS 代理（`192.168.65.7`），与宿主机解析器不是一回事**。二分"宿主机行、容器不行"这类问题时，先在容器里 `nslookup` 对比宿主机 `dig`，这是最省时间的一步。
5. **巡检建议**：CI 加一个轻量 job，在容器内验证**所有** `GO_DOWNLOAD_BASES` 候选源（`wget` 完整下载 + `gzip -t`），只要求"至少一个可用"告警，而不是逐个要求可用——国内镜像偶发 404、官方源偶发坏节点都属正常波动，多源策略下不应阻塞构建。

## 9. 验证记录（修复后实测）

### 9.1 镜像层（`./container/build.sh`，arm64）

```text
#15 [stage-0 11/19] RUN set -e && ...  GO_DOWNLOAD_BASES=aliyun nju dl.google.com ...
#15 0.896 Downloading go1.21.13.linux-arm64.tar.gz from https://mirrors.aliyun.com/golang
#15 18.76 Cloning feishu-cli source from gitcode.com
#15 51.60 feishu-cli version dev (built unknown)      ← 自检通过
#15 DONE 52.5s
...
#23 [stage-0 19/19] DONE 0.2s
#24 naming to docker.io/library/deepthink-agent:latest
Build complete!
```

第一个候选源（阿里云）即命中，未回退到后两个源；原来必挂的那一层现在 52.5s 通过。

### 9.2 产物落位（对镜像内的独立校验，不是只看构建日志）

```bash
$ docker run --rm --entrypoint feishu-cli deepthink-agent:latest --version
feishu-cli version dev (built unknown)

$ docker run --rm --entrypoint ls deepthink-agent:latest /opt/builtin-skills/
feishu-cli-data  feishu-cli-docs  feishu-cli-mail  feishu-cli-meetings  feishu-cli-messaging  feishu-cli-platform

$ docker run --rm --entrypoint sh deepthink-agent:latest -c 'ls -d /usr/local/go'
not present (cleaned)          ← Go 工具链按设计未留在主镜像
```

### 9.3 端到端：用户原始命令

```bash
$ ./scripts/rebuild-restart.sh 9999
🐳 检测到容器源码变更，正在重建 Docker 镜像...
Build complete!
✅ 沙箱镜像无需重建
🔨 检测到后端源码变更，重新编译后端... / 前端... / agent-runner...
🚀 后台守护启动（端口 9999，nohup 脱离终端 + watchdog 自动重启）
✅ 已后台启动 (watchdog pid 74372, node pid 74374)
   /health OK（1*2s）
   /ready OK（1*2s）
 ✅ DeepThink 已重新编译、构建并部署
   Web UI  ：http://localhost:9999
```

独立复核（不依赖脚本自身的 ✅ 输出）：

```bash
$ curl -s http://127.0.0.1:9999/health
{"status":"ok","timestamp":1791947428757}
$ curl -s http://127.0.0.1:9999/ready
{"status":"ready","timestamp":1791947428772}
$ lsof -ti:9999 -sTCP:LISTEN | head -1; cat logs/deepthink-9999.pid
74374
74374                      ← 监听进程 = 本次启动的 pidfile，确认不是残留实例
$ ps -p 74374 -o command=
node dist/index.js
```

结论：**真正修复**。构建层通过、产物落进镜像、端到端命令跑通、健康检查与实例身份均经独立复核。
