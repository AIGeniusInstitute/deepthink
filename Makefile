.PHONY: dev dev-backend dev-web build build-backend build-web start \
       typecheck typecheck-backend typecheck-web typecheck-agent-runner \
       format format-check install install-host-tools clean reset-init update-sdk ensure-latest-sdk sync-types \
       backup restore help _ensure-docker-image _ensure-sandbox-image \
       sandbox-build logs status stop \
       _check-sync _build-web-if-stale _build-ar-if-stale _build-backend-if-stale \
       _start-pm2 _start-direct \
       admin-create admin-passwd \
       desktop-install desktop-build-deps desktop-build desktop-fetch-node \
       desktop-rebuild-natives desktop-dev desktop-pack-mac desktop-pack-mac-x64 \
       desktop-pack-mac-all desktop-pack-win desktop-pack-linux

# ─── Runtime ────────────────────────────────────────────────
# 本项目只用原生 Node 工具链运行（npm / npx / tsx / node），不使用 bun。
# 原因：主服务的 WebSocket 走 `ws` 包 + @hono/node-server 的 `server.on('upgrade')`
# 握手，该模式在 bun 的 HTTP server 下不触发，会导致 WS 全部握手失败（HTTP/接口正常，
# 但前端实时流式卡片/通知全失效，飞书等 stdout 通道不受影响）。
PORT    ?= $(or $(WEB_PORT),9898)
PKG     := npm
RUN     := npx
RUNNER  := npx tsx src/index.ts

# ─── Development ─────────────────────────────────────────────

# 单行 shell 片段：运行 dev 命令前暂停 pm2 中的 deepthink，退出（正常/中断/终止）时恢复。
# 用法示例：@$(PM2_GUARD); <command>
PM2_GUARD = PM2_WAS_RUNNING=0; \
	if command -v pm2 >/dev/null 2>&1 && pm2 show deepthink 2>/dev/null | grep -q 'online'; then \
	  PM2_WAS_RUNNING=1; \
	  echo "⏸  暂停 pm2 deepthink..."; \
	  pm2 stop deepthink; \
	fi; \
	trap "if [ \"$$PM2_WAS_RUNNING\" = '1' ]; then echo '▶  恢复 pm2 deepthink...'; pm2 start deepthink; fi" EXIT INT TERM

dev: ## 启动前后端（首次自动安装依赖和构建容器镜像）；自动暂停 pm2，退出后恢复
	@if [ ! -d node_modules ] || [ package.json -nt node_modules ] || [ web/package.json -nt web/node_modules ] || [ container/agent-runner/package.json -nt container/agent-runner/node_modules ]; then echo "📦 依赖有更新，安装依赖..."; $(MAKE) install; fi
	@$(MAKE) _ensure-docker-image
	@$(MAKE) _ensure-sandbox-image
	@$(PKG) --prefix container/agent-runner run build --silent 2>/dev/null || $(PKG) --prefix container/agent-runner run build
	@$(PM2_GUARD); \
	echo "🚀 使用 $(PKG) 启动..."; \
	$(PKG) run dev:all

dev-backend: ## 仅启动后端（tsx 直跑 TS）；自动暂停 pm2，退出后恢复
	@$(PM2_GUARD); $(RUNNER)

dev-web: ## 仅启动前端
	cd web && $(PKG) run dev

# ─── Build ───────────────────────────────────────────────────

build: sync-types ## 编译前后端及 agent-runner
	$(PKG) run build:all
	@touch .build-sentinel

build-backend: ## 仅编译后端
	$(PKG) run build

build-web: ## 仅编译前端
	cd web && $(PKG) run build

# ─── Production ──────────────────────────────────────────────

start: ensure-latest-sdk ## 一键启动生产环境（pm2 托管时自动走 pm2 restart；否则前台阻塞）。可用 PORT=xxxx 指定端口
	@# pm2 注册过 deepthink 就路由到 pm2，避免裸跑和 pm2 抢端口
	@if command -v pm2 >/dev/null 2>&1 && pm2 describe deepthink >/dev/null 2>&1; then \
	  $(MAKE) --no-print-directory _start-pm2; \
	else \
	  $(MAKE) --no-print-directory _start-direct; \
	fi

_start-pm2: ## (内部) pm2 托管模式：build 后 pm2 restart
	@echo "🔄 检测到 pm2 托管 deepthink，改走 pm2 restart（端口 $(PORT)）"
	@$(MAKE) _check-sync _build-web-if-stale _build-ar-if-stale _build-backend-if-stale
	@$(MAKE) _ensure-sandbox-image
	@WEB_PORT=$(PORT) pm2 restart deepthink --update-env
	@sleep 2
	@pm2 logs deepthink --lines 20 --nostream || true
	@echo "✅ 启动完成，查看实时日志：pm2 logs deepthink"

_start-direct: ## (内部) 裸跑模式（无 pm2 或未注册）
	@# 检查端口是否被占用
	@if lsof -ti:$(PORT) -sTCP:LISTEN >/dev/null 2>&1; then \
	  echo "❌ 端口 $(PORT) 已被占用，请先停掉旧进程：make stop"; \
	  lsof -ti:$(PORT) -sTCP:LISTEN | xargs ps -fp 2>/dev/null | tail -1; \
	  exit 1; \
	fi
	@if [ ! -d node_modules ] || [ package.json -nt node_modules ] || [ web/package.json -nt web/node_modules ] || [ container/agent-runner/package.json -nt container/agent-runner/node_modules ]; then echo "📦 依赖有更新，安装依赖..."; $(MAKE) install; fi
	@$(MAKE) _ensure-docker-image
	@$(MAKE) _ensure-sandbox-image
	@$(MAKE) _check-sync
	@$(MAKE) _build-backend-if-stale
	@$(MAKE) _build-web-if-stale
	@$(MAKE) _build-ar-if-stale
	@echo "🟢 Node 模式：运行编译后的 dist/index.js（端口 $(PORT)，本项目不使用 bun，WebSocket 需要 node）"
	WEB_PORT=$(PORT) node dist/index.js

# ─── Internal build checks ────────────────────────────────────

_check-sync: ## (内部) 检测 shared/ 类型变更并同步
	@NEED_SYNC=0; \
	for target in src/stream-event.types.ts web/src/stream-event.types.ts container/agent-runner/src/stream-event.types.ts src/image-detector.ts container/agent-runner/src/image-detector.ts src/channel-prefixes.ts container/agent-runner/src/channel-prefixes.ts; do \
	  if [ ! -f "$$target" ] || [ -n "$$(find shared/ -newer "$$target" -name '*.ts' 2>/dev/null | head -1)" ]; then NEED_SYNC=1; break; fi; \
	done; \
	if [ "$$NEED_SYNC" = "1" ]; then echo "🔄 检测到 shared/ 类型变更，同步类型..."; $(MAKE) sync-types; fi

_build-web-if-stale: ## (内部) 前端变更时重新编译
	@NEED_WEB=0; \
	if [ ! -f web/dist/index.html ]; then NEED_WEB=1; \
	else \
	  for f in web/package.json web/vite.config.ts web/index.html web/tsconfig.json; do \
	    if [ -f "$$f" ] && [ "$$f" -nt web/dist/index.html ]; then NEED_WEB=1; break; fi; \
	  done; \
	  if [ "$$NEED_WEB" = "0" ] && [ -n "$$(find web/src/ -newer web/dist/index.html \( -name '*.ts' -o -name '*.tsx' -o -name '*.css' \) 2>/dev/null | head -1)" ]; then NEED_WEB=1; fi; \
	fi; \
	if [ "$$NEED_WEB" = "1" ]; then echo "🔨 检测到前端变更，重新编译前端..."; cd web && $(PKG) run build; else echo "✅ 前端无变更，跳过编译"; fi

_build-ar-if-stale: ## (内部) agent-runner 变更时重新编译
	@NEED_AR=0; \
	if [ ! -f container/agent-runner/dist/.tsbuildinfo ]; then NEED_AR=1; \
	else \
	  for f in container/agent-runner/package.json container/agent-runner/tsconfig.json; do \
	    if [ -f "$$f" ] && [ "$$f" -nt container/agent-runner/dist/.tsbuildinfo ]; then NEED_AR=1; break; fi; \
	  done; \
	  if [ "$$NEED_AR" = "0" ] && [ -n "$$(find container/agent-runner/src/ -newer container/agent-runner/dist/.tsbuildinfo -name '*.ts' 2>/dev/null | head -1)" ]; then NEED_AR=1; fi; \
	fi; \
	if [ "$$NEED_AR" = "1" ]; then echo "🔨 检测到 agent-runner 变更，重新编译..."; cd container/agent-runner && $(PKG) run build; else echo "✅ agent-runner 无变更，跳过编译"; fi

_build-backend-if-stale: ## (内部) 后端变更时重新编译（Node 模式）
	@NEED_BACKEND=0; \
	if [ ! -f dist/index.js ]; then NEED_BACKEND=1; \
	else \
	  for f in package.json tsconfig.json; do \
	    if [ "$$f" -nt dist/index.js ]; then NEED_BACKEND=1; break; fi; \
	  done; \
	  if [ "$$NEED_BACKEND" = "0" ] && [ -n "$$(find src/ -newer dist/index.js -name '*.ts' 2>/dev/null | head -1)" ]; then NEED_BACKEND=1; fi; \
	fi; \
	if [ "$$NEED_BACKEND" = "1" ]; then echo "🔨 检测到后端源码变更，重新编译后端..."; $(PKG) run build; else echo "✅ 后端无变更，跳过编译"; fi

logs: ## 实时查看日志（需配合手动后台运行：make start > /tmp/deepthink.log 2>&1 &）
	@tail -f /tmp/deepthink.log

stop: ## 停止服务（pm2 托管时走 pm2 stop，否则杀端口监听进程）
	@if command -v pm2 >/dev/null 2>&1 && pm2 describe deepthink >/dev/null 2>&1; then \
	  pm2 stop deepthink >/dev/null && echo "✅ 已 pm2 stop deepthink（需再起用 pm2 start deepthink）"; \
	else \
	  lsof -ti:$(PORT) -sTCP:LISTEN 2>/dev/null | xargs kill 2>/dev/null && echo "✅ 已停止 DeepThink (端口 $(PORT))" || echo "⚠️  端口 $(PORT) 未被占用，无需停止"; \
	fi

status: ## 查看服务运行状态
	@echo "=== DeepThink 服务状态 ==="
	@if command -v pm2 >/dev/null 2>&1 && pm2 describe deepthink >/dev/null 2>&1; then \
	  echo "🔧 pm2 托管模式（重启请用 pm2 restart deepthink，勿混用 make start/stop）"; \
	  pm2 describe deepthink 2>/dev/null | grep -E "status|pid|uptime|restarts" | head -4 | sed 's/^/   /'; \
	fi
	@if lsof -ti:$(PORT) -sTCP:LISTEN >/dev/null 2>&1; then \
	  echo "✅ 后端进程: 运行中 (端口 $(PORT))"; \
	  curl -s http://localhost:$(PORT)/api/health 2>/dev/null | python3 -c "import sys,json; d=json.load(sys.stdin); print(f\"   健康状态: {d.get('status','unknown')}\")" 2>/dev/null || echo "   健康状态: 无法获取"; \
	else \
	  echo "❌ 后端进程: 未运行 (端口 $(PORT) 未占用)"; \
	fi
	@echo ""
	@echo "=== 日志文件 ==="
	@if [ -f /tmp/deepthink.log ]; then \
	  echo "✅ /tmp/deepthink.log 存在 ($(wc -l < /tmp/deepthink.log) 行)"; \
	  echo "   最近 3 行:"; \
	  tail -3 /tmp/deepthink.log | sed 's/^/   /'; \
	else \
	  echo "⚠️  /tmp/deepthink.log 不存在（未用后台模式启动）"; \
	fi
	@echo ""
	@echo "=== Docker 容器 ==="
	@docker ps --filter "name=deepthink" --format "table {{.Names}}\t{{.Status}}\t{{.Ports}}" 2>/dev/null || echo "   Docker 未运行或无 DeepThink 容器"

# ─── Quality ─────────────────────────────────────────────────

typecheck: sync-types typecheck-backend typecheck-web typecheck-agent-runner ## 全量类型检查
	@./scripts/check-stream-event-sync.sh
	@./scripts/check-agent-runner-prompts.sh

typecheck-backend:
	$(RUN) tsc --noEmit

typecheck-web:
	cd web && $(RUN) tsc --noEmit

typecheck-agent-runner:
	cd container/agent-runner && $(RUN) tsc --noEmit

test: ## 运行单元测试
	$(RUN) vitest run

format: ## 格式化代码
	$(PKG) run format

format-check: ## 检查代码格式
	$(PKG) run format:check

# ─── Docker Image ─────────────────────────────────────────────

# Docker 镜像源文件：Dockerfile、entrypoint.sh、agent-runner 源码和运行时 prompts
DOCKER_SRC := container/Dockerfile container/entrypoint.sh $(wildcard container/agent-runner/src/*.ts) $(shell find container/agent-runner/prompts -type f 2>/dev/null)

_ensure-docker-image: ## (内部) 检测 Docker 镜像是否需要构建/重建
	@if command -v docker >/dev/null 2>&1; then \
	  if ! docker image inspect deepthink-agent:latest >/dev/null 2>&1; then \
	    echo "🐳 Docker 镜像不存在，正在构建..."; \
	    ./container/build.sh; \
	  elif [ ! -f .docker-build-sentinel ]; then \
	    echo "🐳 Docker 镜像 sentinel 缺失，正在重建..."; \
	    ./container/build.sh; \
	  else \
	    STALE=0; \
	    for f in $(DOCKER_SRC); do \
	      if [ "$$f" -nt .docker-build-sentinel ]; then STALE=1; break; fi; \
	    done; \
	    if [ "$$STALE" = "1" ]; then \
	      echo "🐳 检测到容器源码变更，正在重建 Docker 镜像..."; \
	      ./container/build.sh; \
	    else \
	      echo "✅ Docker 镜像无需重建"; \
	    fi; \
	  fi; \
	fi

# ─── Sandbox Docker Image ────────────────────────────────────

# 沙箱镜像源文件：Dockerfile、entry.sh、seccomp-profile.json
SANDBOX_SRC := container/sandbox/Dockerfile container/sandbox/entry.sh container/sandbox/seccomp-profile.json

sandbox-build: ## 构建沙箱镜像 deepthink-sandbox:latest（用于代码执行 + 浏览器自动化）
	@./container/sandbox/build.sh
	@touch .sandbox-docker-build-sentinel

_ensure-sandbox-image: ## (内部) 检测沙箱镜像是否需要构建/重建
	@if command -v docker >/dev/null 2>&1; then \
	  if ! docker image inspect deepthink-sandbox:latest >/dev/null 2>&1; then \
	    echo "🐳 沙箱镜像不存在，正在构建..."; \
	    $(MAKE) sandbox-build; \
	  elif [ ! -f .sandbox-docker-build-sentinel ]; then \
	    echo "🐳 沙箱镜像 sentinel 缺失，正在重建..."; \
	    $(MAKE) sandbox-build; \
	  else \
	    STALE=0; \
	    for f in $(SANDBOX_SRC); do \
	      if [ "$$f" -nt .sandbox-docker-build-sentinel ]; then STALE=1; break; fi; \
	    done; \
	    if [ "$$STALE" = "1" ]; then \
	      echo "🐳 检测到沙箱源码变更，正在重建沙箱镜像..."; \
	      $(MAKE) sandbox-build; \
	    else \
	      echo "✅ 沙箱镜像无需重建"; \
	    fi; \
	  fi; \
	fi

# ─── Shared Types ────────────────────────────────────────────

sync-types: ## 同步 shared/ 下的类型定义到各子项目
	@./scripts/sync-stream-event.sh

# ─── SDK ─────────────────────────────────────────────────────

update-sdk: ## 更新 agent-runner + 主服务的 Claude Agent SDK 到最新版本
	cd container/agent-runner && $(PKG) update @anthropic-ai/claude-agent-sdk && $(PKG) run build
	$(PKG) update @anthropic-ai/claude-agent-sdk
	@# npm update 会将 "*" 回写为具体版本，还原它（agent-runner + 主服务）
	@# sed -i.bak ... && rm -f .bak：GNU sed 和 BSD sed 都支持，跨平台一致
	@sed -i.bak 's/"@anthropic-ai\/claude-agent-sdk": "[^"]*"/"@anthropic-ai\/claude-agent-sdk": "*"/' container/agent-runner/package.json && rm -f container/agent-runner/package.json.bak
	@sed -i.bak 's/"@anthropic-ai\/claude-agent-sdk": "[^"]*"/"@anthropic-ai\/claude-agent-sdk": "*"/' package.json && rm -f package.json.bak
	@echo "SDK updated. Run 'make typecheck' to verify."

ensure-latest-sdk: ## 启动前自动检测并更新 SDK（agent-runner + 主服务，有新版才更新）
	@LOCAL=$$(node -p "require('./container/agent-runner/node_modules/@anthropic-ai/claude-agent-sdk/package.json').version" 2>/dev/null || echo "0.0.0"); \
	ROOT_LOCAL=$$(node -p "require('./node_modules/@anthropic-ai/claude-agent-sdk/package.json').version" 2>/dev/null || echo "0.0.0"); \
	LATEST=$$(npm view @anthropic-ai/claude-agent-sdk version --fetch-timeout=5000 2>/dev/null || echo "$$LOCAL"); \
	if [ "$$LOCAL" != "$$LATEST" ]; then \
		echo "🔄 [agent-runner] Claude Agent SDK 有新版本: $$LOCAL → $$LATEST，正在更新..."; \
		(cd container/agent-runner && $(PKG) update @anthropic-ai/claude-agent-sdk && $(PKG) run build); \
		sed -i.bak 's/"@anthropic-ai\/claude-agent-sdk": "[^"]*"/"@anthropic-ai\/claude-agent-sdk": "*"/' container/agent-runner/package.json && rm -f container/agent-runner/package.json.bak; \
		echo "✅ [agent-runner] SDK 更新完成（内置 Claude Code 版本随之更新）"; \
	else \
		echo "✅ [agent-runner] Claude Agent SDK 已是最新 ($$LOCAL)"; \
	fi; \
	if [ "$$ROOT_LOCAL" != "$$LATEST" ]; then \
		echo "🔄 [主服务] Claude Agent SDK 有新版本: $$ROOT_LOCAL → $$LATEST，正在更新..."; \
		$(PKG) update @anthropic-ai/claude-agent-sdk; \
		sed -i.bak 's/"@anthropic-ai\/claude-agent-sdk": "[^"]*"/"@anthropic-ai\/claude-agent-sdk": "*"/' package.json && rm -f package.json.bak; \
		echo "✅ [主服务] SDK 更新完成"; \
	else \
		echo "✅ [主服务] Claude Agent SDK 已是最新 ($$ROOT_LOCAL)"; \
	fi

# ─── Setup ───────────────────────────────────────────────────

install-host-tools: ## 安装宿主机模式所需的外部工具（feishu-cli、agent-browser、uv）+ 刷新 builtin-skills 缓存
	@./scripts/install-host-tools.sh

install: ## 安装全部依赖并编译 agent-runner
	$(PKG) install
	@# node-pty 的 spawn-helper 预构建二进制可能缺少可执行权限，导致 PTY 模式失败
	@chmod +x node_modules/node-pty/prebuilds/darwin-arm64/spawn-helper 2>/dev/null || true
	cd container/agent-runner && $(PKG) install
	cd container/agent-runner && $(PKG) run build
	cd web && $(PKG) install
	@# 更新目录 mtime 以配合 start 中的依赖变更检测（[ package.json -nt node_modules ]）
	@touch node_modules web/node_modules container/agent-runner/node_modules

clean: ## 清理构建产物
	rm -rf dist
	rm -rf web/dist
	rm -rf container/agent-runner/dist
	rm -f .build-sentinel .docker-build-sentinel .sandbox-docker-build-sentinel

reset-init: ## 完全重置为首装状态（清空所有运行时数据）
	rm -rf data store groups
	@echo "✅ 已完全重置为首装状态（数据库、配置、工作区、记忆、会话全部清除）"

# ─── Admin Account Ops ───────────────────────────────────────
# 运维脚本：创建 / 修改 管理员账号。
# 用法：
#   make admin-create USERNAME=alice PASSWORD=YourStr0ngPass
#   make admin-passwd USERNAME=alice PASSWORD=NewStr0ngPass
# 省略 PASSWORD 时走交互式隐藏输入，避免密码落入 shell history：
#   make admin-create USERNAME=alice

admin-create: ## 创建管理员账号（USERNAME=xxx [PASSWORD=xxx]，省略 PASSWORD 则交互式输入）
	@if [ -z "$(USERNAME)" ]; then echo "❌ 用法: make admin-create USERNAME=alice [PASSWORD=xxx]"; exit 1; fi
	@ARGS="create $(USERNAME)"; \
	  [ -n "$(PASSWORD)" ] && ARGS="$$ARGS $(PASSWORD)"; \
	  npx tsx src/admin-account-cli.js $$ARGS

admin-passwd: ## 修改管理员密码（USERNAME=xxx [PASSWORD=xxx]，省略 PASSWORD 则交互式输入；清掉该账号所有旧登录会话）
	@if [ -z "$(USERNAME)" ]; then echo "❌ 用法: make admin-passwd USERNAME=alice [PASSWORD=xxx]"; exit 1; fi
	@ARGS="passwd $(USERNAME)"; \
	  [ -n "$(PASSWORD)" ] && ARGS="$$ARGS $(PASSWORD)"; \
	  npx tsx src/admin-account-cli.js $$ARGS

# ─── Backup / Restore ────────────────────────────────────────

backup: ## 备份运行时数据到 deepthink-backup-{date}.tar.gz
	@DATE=$$(date +%Y%m%d-%H%M%S); \
	FILE="deepthink-backup-$$DATE.tar.gz"; \
	echo "📦 正在打包备份到 $$FILE ..."; \
	tar -czf "$$FILE" \
	  --exclude='data/ipc' \
	  --exclude='data/env' \
	  --exclude='data/deepthink.log' \
	  --exclude='data/db/messages.db-shm' \
	  --exclude='data/db/messages.db-wal' \
	  --exclude='data/groups/*/logs' \
	  data/db \
	  data/config \
	  data/groups \
	  data/sessions \
	  $$([ -d data/skills ] && echo data/skills) \
	  2>/dev/null; \
	echo "✅ 备份完成：$$FILE ($$(du -sh $$FILE | cut -f1))"

restore: ## 从 deepthink-backup-*.tar.gz 恢复数据（用法：make restore 或 make restore FILE=xxx.tar.gz）
	@if [ -n "$(FILE)" ]; then \
	  BACKUP="$(FILE)"; \
	elif [ $$(ls deepthink-backup-*.tar.gz 2>/dev/null | wc -l) -eq 1 ]; then \
	  BACKUP=$$(ls deepthink-backup-*.tar.gz); \
	elif [ $$(ls deepthink-backup-*.tar.gz 2>/dev/null | wc -l) -gt 1 ]; then \
	  echo "❌ 发现多个备份文件，请用 make restore FILE=xxx.tar.gz 指定："; \
	  ls deepthink-backup-*.tar.gz; \
	  exit 1; \
	else \
	  echo "❌ 未找到备份文件，请将 deepthink-backup-*.tar.gz 放到当前目录"; \
	  exit 1; \
	fi; \
	echo "📂 正在从 $$BACKUP 恢复..."; \
	if [ -d data ] && [ "$$(ls -A data 2>/dev/null)" ]; then \
	  echo "⚠️  data/ 目录已存在数据，继续将覆盖。是否继续？[y/N] "; \
	  read CONFIRM; \
	  [ "$$CONFIRM" = "y" ] || [ "$$CONFIRM" = "Y" ] || { echo "已取消"; exit 1; }; \
	fi; \
	tar -xzf "$$BACKUP"; \
	if [ ! -f data/config/session-secret.key ]; then \
	  echo "⚠️  警告：备份中缺少 session-secret.key，用户登录 cookie 将失效，需重新登录"; \
	fi; \
	echo "✅ 数据恢复完成"; \
	echo ""; \
	echo "后续步骤："; \
	echo "  1. 如需 Docker 容器支持：./container/build.sh"; \
	echo "  2. 启动服务：make start"

# ─── Desktop (DeepThink) ────────────────────────────────────
# 桌面版：Electron 壳 + 后端 dist + 前端 dist + agent-runner + Node binary。
# 数据目录通过环境变量注入到后端，源码版行为零变化。

DESKTOP_DIR := desktop
DESKTOP_NODE_MODULES := $(DESKTOP_DIR)/node_modules
# 与 scripts/fetch-node-binary.js 默认保持一致；修改时同步更新一处即可。
DESKTOP_NODE_VERSION ?= v22.11.0

# Electron 二进制（electron 包 postinstall + electron-builder 打包）默认从 GitHub
# 下载，国内裸网络常 read ETIMEDOUT。这里默认走 npmmirror 镜像，已配置代理或自有
# 镜像的用户可在 shell 里 export 同名变量覆盖（?= 只在未设置时赋值）。
ELECTRON_MIRROR ?= https://npmmirror.com/mirrors/electron/
ELECTRON_BUILDER_BINARIES_MIRROR ?= https://npmmirror.com/mirrors/electron-builder-binaries/
export ELECTRON_MIRROR ELECTRON_BUILDER_BINARIES_MIRROR

desktop-install: ## 安装桌面版子项目依赖
	cd $(DESKTOP_DIR) && npm install --no-audit --no-fund

desktop-build-deps: build sync-types ## 编译桌面版所需的所有产物（后端 + 前端 + agent-runner）
	cd container/agent-runner && npm install --no-audit --no-fund
	cd container/agent-runner && npm run build

desktop-build: desktop-build-deps desktop-install ## 编译桌面版 Electron 壳 TypeScript
	cd $(DESKTOP_DIR) && npm run build

desktop-fetch-node: ## 拉取当前平台的 Node.js 二进制到 dev-resources/node
	NODE_VERSION=$(DESKTOP_NODE_VERSION) node scripts/fetch-node-binary.js

desktop-rebuild-natives: desktop-fetch-node ## 用内置 Node ABI 重新编译根 node_modules 的 native 模块（better-sqlite3 等），避免运行时 ABI 不匹配
	@echo "[desktop] rebuilding native modules against node $(DESKTOP_NODE_VERSION)..."
	npm rebuild --target=$(DESKTOP_NODE_VERSION) --runtime=node

desktop-dev: desktop-build ## 桌面版开发模式：启动 Electron 壳，加载本机后端
	cd $(DESKTOP_DIR) && npm run dev

desktop-clean-stale-mount: ## 打包前清理 macOS 上残留的 DeepThink DMG 挂载点（避免 hdiutil detach 失败，exit code 16）
	@for v in "/Volumes/DeepThink 1.0.0" "/Volumes/DeepThink 1.0.0-x64" "/Volumes/DeepThink"*; do \
		[ -e "$$v" ] || continue; \
		echo "[desktop] 发现残留挂载点: $$v"; \
		holders=$$(lsof -t "$$v" 2>/dev/null); \
		if [ -n "$$holders" ]; then \
			echo "[desktop] 以下进程占用该卷，需先终止:"; \
			ps -p $$holders -o pid,ppid,command 2>/dev/null; \
			echo "[desktop] 终止占用进程..."; \
			echo $$holders | xargs kill 2>/dev/null || true; \
			sleep 2; \
		fi; \
		echo "[desktop] detach $$v"; \
		hdiutil detach "$$v" 2>/dev/null || hdiutil detach -force "$$v" 2>/dev/null || true; \
	done

desktop-pack-mac: desktop-build desktop-rebuild-natives desktop-clean-stale-mount ## 打包 macOS .dmg（仅 arm64，日常本地用）
	cd $(DESKTOP_DIR) && npx electron-builder --config build/mac-arm64.json

desktop-pack-mac-x64: desktop-build desktop-rebuild-natives desktop-clean-stale-mount ## 打包 macOS .dmg（仅 x64，需在 x64/intel Mac 上执行）
	cd $(DESKTOP_DIR) && npx electron-builder --config build/mac-x64.json

desktop-pack-mac-all: desktop-pack-mac desktop-pack-mac-x64 ## 打包 macOS .dmg（arm64 + x64 双架构，发布用）

desktop-pack-win: desktop-build desktop-rebuild-natives ## 打包 Windows .exe（在 Windows runner 上执行）
	TARGET_PLATFORM=win ARCH=x64 NODE_VERSION=$(DESKTOP_NODE_VERSION) node scripts/fetch-node-binary.js
	cd $(DESKTOP_DIR) && npx electron-builder --config build/win.json

desktop-pack-linux: desktop-build desktop-rebuild-natives ## 打包 Linux AppImage/.deb（在 Linux runner 上执行）
	TARGET_PLATFORM=linux ARCH=x64 NODE_VERSION=$(DESKTOP_NODE_VERSION) node scripts/fetch-node-binary.js
	cd $(DESKTOP_DIR) && npx electron-builder --config build/linux.json

# ─── Release ───────────────────────────────────────────────

RELEASE_REPO ?= AIGeniusInstitute/deep-think
RELEASE_NOTES_DIR ?= docs/release-notes

release: ## 发布 release 到 GitHub（用法: make release VERSION=v1.0.0；需先 make desktop-pack-* 并打 tag）
	@if [ -z "$(VERSION)" ]; then echo "❌ 用法: make release VERSION=v1.0.0"; exit 1; fi
	@if ! command -v gh >/dev/null 2>&1; then echo "❌ 未安装 gh CLI"; echo "  安装: brew install gh"; echo "  登录: gh auth login"; exit 1; fi
	@if ! gh auth status >/dev/null 2>&1; then echo "❌ gh 未登录，请先 gh auth login"; exit 1; fi
	@if ! git rev-parse "$(VERSION)" >/dev/null 2>&1; then echo "❌ 本地无 tag $(VERSION)"; echo "  请先: git tag -a $(VERSION) -m 'Release $(VERSION)' && git push origin $(VERSION)"; exit 1; fi
	@if [ ! -d desktop/release ] || [ -z "$$(ls -A desktop/release 2>/dev/null)" ]; then echo "❌ desktop/release 为空"; echo "  请先在对应平台执行: make desktop-pack-mac / desktop-pack-win / desktop-pack-linux"; exit 1; fi
	@NOTES_FILE=$(RELEASE_NOTES_DIR)/$(VERSION).md; \
	  if [ -f "$$NOTES_FILE" ]; then NOTES_ARG="--notes-file $$NOTES_FILE"; else NOTES_ARG="--generate-notes"; fi; \
	  echo "🚀 发布 $(VERSION) 到 $(RELEASE_REPO)..."; \
	  echo "   资产:"; ls desktop/release/ | sed 's/^/   📦 /'; \
	  gh release create "$(VERSION)" \
	    --repo $(RELEASE_REPO) \
	    --title "DeepThink $(VERSION)" \
	    $$NOTES_ARG \
	    --latest \
	    desktop/release/

release-delete: ## 删除 release 及 tag（用法: make release-delete VERSION=v1.0.0）
	@if [ -z "$(VERSION)" ]; then echo "❌ 用法: make release-delete VERSION=v1.0.0"; exit 1; fi
	@echo "🗑  删除 $(VERSION)..."
	gh release delete "$(VERSION)" --repo $(RELEASE_REPO) --yes --cleanup-tag 2>/dev/null || true
	git tag -d "$(VERSION)" 2>/dev/null || true
	git push origin --delete "$(VERSION)" 2>/dev/null || true
	@echo "✅ 已删除 $(VERSION)"

# ─── Help ────────────────────────────────────────────────────

help: ## 显示帮助
	@echo "运行时: 🟢 Node.js（本项目不使用 bun）"
	@echo ""
	@grep -E '^[a-zA-Z0-9_-]+:.*?## .*$$' $(MAKEFILE_LIST) | \
		awk 'BEGIN {FS = ":.*?## "}; {printf "  \033[36m%-18s\033[0m %s\n", $$1, $$2}'
