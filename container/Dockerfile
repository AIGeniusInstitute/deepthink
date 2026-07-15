# DeepThink Agent Container
# Runs Claude Agent SDK in isolated Linux VM with full toolchain

FROM node:22-slim

# Install system packages (organized by category)
# NOTE: Keep this layer BEFORE `COPY --from=ghcr.io/astral-sh/uv:latest` so that
# uv:latest digest churn (frequent releases) does not invalidate this ~440MB layer.
# See issue #403.
RUN apt-get update && apt-get install -y --no-install-recommends \
    # --- Browser & fonts ---
    chromium \
    fonts-liberation \
    fonts-noto-color-emoji \
    # --- Chromium shared library deps ---
    libgbm1 \
    libnss3 \
    libatk-bridge2.0-0 \
    libgtk-3-0 \
    libx11-xcb1 \
    libxcomposite1 \
    libxdamage1 \
    libxrandr2 \
    libasound2 \
    libpangocairo-1.0-0 \
    libcups2 \
    libdrm2 \
    libxshmfence1 \
    # --- Build tools & compilers ---
    build-essential \
    cmake \
    pkg-config \
    # --- Python ecosystem ---
    python3 \
    python3-pip \
    python3-venv \
    python3-dev \
    # --- Core CLI tools ---
    curl \
    wget \
    git \
    zsh \
    jq \
    tree \
    file \
    less \
    bc \
    patch \
    rsync \
    # --- Compression ---
    zip \
    unzip \
    xz-utils \
    bzip2 \
    # --- Network ---
    openssh-client \
    dnsutils \
    iputils-ping \
    # --- Process & system ---
    procps \
    lsof \
    # --- Text search & dev ---
    ripgrep \
    fd-find \
    shellcheck \
    # --- Multimedia ---
    ffmpeg \
    imagemagick \
    ghostscript \
    graphviz \
    # --- Document & PDF ---
    poppler-utils \
    pandoc \
    # --- Database clients ---
    sqlite3 \
    default-mysql-client \
    postgresql-client \
    redis-tools \
    # --- Locale ---
    locales \
    && rm -rf /var/lib/apt/lists/* \
    # Set up UTF-8 locale
    && sed -i '/en_US.UTF-8/s/^# //' /etc/locale.gen && locale-gen \
    # Symlink fd-find → fd (Debian names it fdfind)
    && ln -sf /usr/bin/fdfind /usr/local/bin/fd

# Copy uv from official image (multi-arch, no extra download).
# Placed AFTER the apt-get layer: uv:latest releases frequently, so its digest
# changes invalidate this layer on most rebuilds. Keeping the heavy apt-get
# layer above ensures it stays cached across uv version bumps. See issue #403.
COPY --from=ghcr.io/astral-sh/uv:latest /uv /usr/local/bin/uv
COPY --from=ghcr.io/astral-sh/uv:latest /uvx /usr/local/bin/uvx

# Locale environment
ENV LANG=en_US.UTF-8
ENV LC_ALL=en_US.UTF-8

# Set Chromium path for agent-browser
ENV AGENT_BROWSER_EXECUTABLE_PATH=/usr/bin/chromium
ENV PLAYWRIGHT_CHROMIUM_EXECUTABLE_PATH=/usr/bin/chromium

# Allow pip install without venv (Debian 12+ PEP 668) and add user bin to PATH
ENV PIP_BREAK_SYSTEM_PACKAGES=1
ENV PATH="/home/node/.local/bin:${PATH}"

# Create app directory
WORKDIR /app

# Container build does NOT read host ~/.npmrc, so a host-side npm mirror config
# has no effect inside `docker build`. China networks default to npmjs.org and
# time out on `npm install`. Default to npmmirror; override with
# `--build-arg NPM_REGISTRY=https://registry.npmjs.org` for upstream/CI.
ARG NPM_REGISTRY=https://registry.npmmirror.com
RUN npm config set registry "${NPM_REGISTRY}"

# Copy package.json only — no lock file so "*" always resolves to latest SDK
COPY agent-runner/package.json ./

# CACHEBUST after COPY ensures both global and local npm install are cache-busted
# (COPY caches on file content hash, which blocks ARG invalidation propagation)
ARG CACHEBUST=1
RUN npm install -g agent-browser
RUN npm install

# Headroom (https://github.com/chopratejas/headroom) - 工具输出/RAG/日志压缩.
# 装上 binary 但默认不启用——用户在 /mcp-servers 自行添加才生效, 配置:
#   { "command": "headroom", "args": ["mcp", "serve"] }
# 只选 [code,mcp] 两个 extras: [memory] 通过 sentence-transformers 强依赖
# torch + CUDA (cudnn-cu12, cublas, cusparse, cusolver, nccl, triton...),
# 压缩包就 ~2.45GB, 解包 3-6GB 量级. DeepThink 容器无 GPU, 也不需要语义
# embedding 类 retrieve. 用户如真需要 headroom 的 memory 能力, 可在容器内
# 单独 `pip install --index-url https://download.pytorch.org/whl/cpu torch`
# 再 `pip install "headroom-ai[memory]"` 走 CPU 路径. PIP_BREAK_SYSTEM_PACKAGES
# 已在 line 103 设置, 这里无需再传 --break-system-packages.
# Pin 到 ~=0.27.0 (>=0.27.0,<0.28.0): headroom-ai 仍是 PyPI Beta, 且 extras 解析
# 曾因 [memory]→torch 把镜像撑爆; `headroom --version` 自检只挡『装不上』挡不住
# 体积/行为漂移, 故锁定已验证的 ~550MB footprint, 仅允许 0.27.x 补丁更新.
#
# PIP_INDEX_URL default to Tsinghua mirror: same root cause as NPM_REGISTRY —
# container build can't read host pip config, China networks time out on pypi.org.
# Override with `--build-arg PIP_INDEX_URL=https://pypi.org/simple`.
ARG PIP_INDEX_URL=https://pypi.tuna.tsinghua.edu.cn/simple
RUN pip install --index-url "${PIP_INDEX_URL}" "headroom-ai[code,mcp]~=0.27.0" \
    && headroom --version

# Install feishu-cli (binary + builtin skills), 始终跟踪 latest release。
#
# 网络兜底: github.com 直连在国内裸网络下常 hang (curl 默认无超时会无限等待),
# 且第三方 mirror (gh-proxy.com 等) 不透传 302 redirect (返回 200 HTML),
# 原来的 `curl -sI .../releases/latest | grep location` 方式在 mirror 下无法解析版本。
# 改为:
#   1. GITHUB_MIRROR ARG: 默认 https://gh-proxy.com/, 代理前缀拼到 URL 前;
#      海外/CI 直连设 `--build-arg GITHUB_MIRROR=` (空字符串)
#   2. 版本解析走 api.github.com (通过 mirror 代理, 规避 rate limit), jq 提取 tag_name
#   3. 所有 curl 加 --connect-timeout 30 --max-time 300, 避免无限 hang
# CACHEBUST 已在此前触发, 每次构建都会重新解析 latest。
ARG GITHUB_MIRROR=https://gh-proxy.com/
ARG TARGETARCH
RUN set -e && \
    ARCH="${TARGETARCH:-$(dpkg --print-architecture)}" && \
    MIRROR="${GITHUB_MIRROR}" && \
    gh_url() { echo "${MIRROR}${1}"; } && \
    VERSION=$(curl -fsSL --connect-timeout 30 --max-time 60 \
      "$(gh_url https://api.github.com/repos/riba2534/feishu-cli/releases/latest)" \
      | jq -r .tag_name) && \
    if [ -z "$VERSION" ] || [ "$VERSION" = "null" ]; then \
      echo "ERROR: 无法解析 feishu-cli 最新版本 (GITHUB_MIRROR=${MIRROR:-direct})"; exit 1; \
    fi && \
    echo "Installing feishu-cli $VERSION for $ARCH (mirror: ${MIRROR:-direct})" && \
    curl -fsSL --connect-timeout 30 --max-time 300 \
      "$(gh_url https://github.com/riba2534/feishu-cli/releases/download/${VERSION}/feishu-cli_${VERSION}_linux-${ARCH}.tar.gz)" \
      | tar -xz --strip-components=1 -C /usr/local/bin && \
    feishu-cli --version && \
    mkdir -p /opt/builtin-skills && \
    SKILLS_TMP=$(mktemp -d) && \
    curl -fsSL --connect-timeout 30 --max-time 300 \
      "$(gh_url https://github.com/riba2534/feishu-cli/archive/refs/tags/${VERSION}.tar.gz)" \
      | tar -xz -C "$SKILLS_TMP" && \
    cp -r "$SKILLS_TMP"/*/skills/. /opt/builtin-skills/ && \
    rm -rf "$SKILLS_TMP" && \
    ls /opt/builtin-skills/

# Copy source code
COPY agent-runner/ ./

# Build TypeScript
RUN npm run build

# Create workspace directories
RUN mkdir -p /workspace/group /workspace/global /workspace/memory /workspace/extra /workspace/ipc/messages /workspace/ipc/tasks /workspace/ipc/input

# Copy entrypoint script (runs as root, drops to node user via runuser)
COPY entrypoint.sh /app/entrypoint.sh
RUN chmod +x /app/entrypoint.sh

# Set ownership to node user (non-root) for writable directories
RUN chown -R node:node /workspace

# Install oh-my-zsh for node user (ys theme).
# Best-effort: the installer pulls install.sh from raw.githubusercontent.com AND
# git-clones the ohmyzsh repo from github.com — both are flaky behind some
# networks (notably CN), where the clone doesn't fail fast but HANGS. A plain
# `|| echo` can't rescue a hang, so wrap in `timeout` to cap the attempt. It's a
# cosmetic shell theme, NOT required by the agent runtime, so timeout/failure
# must fall back to the default shell rather than abort the whole image build.
RUN timeout -k 5 90 su - node -c 'sh -c "$(curl -fsSL https://raw.githubusercontent.com/ohmyzsh/ohmyzsh/master/tools/install.sh)" "" --unattended' \
    && sed -i 's/ZSH_THEME="robbyrussell"/ZSH_THEME="ys"/' /home/node/.zshrc \
    && chsh -s /bin/zsh node \
    || echo "⚠️ oh-my-zsh setup skipped (network slow/unavailable); container keeps default shell"

# Entrypoint runs as root to fix volume permissions, then drops to node user.
# Do NOT add USER node here — entrypoint handles the privilege drop.
WORKDIR /workspace/group

# Entry point reads JSON from stdin, outputs JSON to stdout
ENTRYPOINT ["/app/entrypoint.sh"]
