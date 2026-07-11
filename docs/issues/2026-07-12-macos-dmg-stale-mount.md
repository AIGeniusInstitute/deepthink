# macOS 打包 DMG 失败：hdiutil detach exit code 16

- 日期：2026-07-12
- 触发命令：`make desktop-pack-mac`
- 平台：macOS 25.2.0（arm64）
- 工具版本：electron-builder 25.1.8

## 1. 用户现象

执行 `make desktop-pack-mac` 时，electron-builder 在最后一步 `building target=DMG` 反复失败，输出：

```
⨯ unable to execute hdiutil  args=["detach","-quiet","/Volumes/DeepThink 1.0.0"] code=undefined error=Exit code: 16.
Command failed: hdiutil detach -quiet /Volumes/DeepThink 1.0.0
```

electron-builder 内部重试 5 次均失败，最终 `make: *** [desktop-pack-mac] Error 1` 退出。打包生成的 `.dmg` 文件不完整或被回滚。

## 2. 问题描述

electron-builder 构建 DMG 时会通过 `hdiutil` attach 一个临时 DMG 镜像，写入应用数据后再 detach。detach 阶段失败，错误码 16 = `resource busy` —— 表示该挂载点 `/Volumes/DeepThink 1.0.0` 仍有进程在占用文件描述符，内核拒绝卸载。

## 3. 根因

**残留的 stale DMG 挂载点 + 孤儿后端进程**。

时间线：
1. 上一次本地从 DMG 直接双击运行 `DeepThink.app`（未拷贝到 `/Applications`），Electron 主进程启动了后端 `agent-runner`（执行 `node /Volumes/DeepThink 1.0.0/DeepThink.app/Contents/Resources/agent-runner/dist/index.js`）。
2. 用户关闭 GUI 后，Electron 主进程退出，但 agent-runner 是 `child_process.spawn` 拉起的 detached 进程，PPID 被重新指派给 launchd（PPID=1），成为孤儿进程，持续占用 DMG 内的 `node` 二进制文件描述符。
3. DMG 因此无法被卸载，挂载点 `/dev/disk*s1` 长期保留在 `/Volumes/DeepThink 1.0.0`。
4. 下一次 `make desktop-pack-mac` 时，electron-builder 尝试 attach 同名 DMG，与已存在的挂载点冲突；其内部 detach 重试逻辑无法清掉非自己 attach 的卷，最终失败。

证据：

```bash
$ ls /Volumes/
DeepThink 1.0.0   ← 残留挂载
Macintosh HD
WorkBuddy 5.1.7-arm64

$ mount | grep -i deepthink
/dev/disk7s1 on /Volumes/DeepThink 1.0.0 (apfs, local, nodev, nosuid, read-only, journaled, noowners, mounted by xingzhi)

$ lsof "/Volumes/DeepThink 1.0.0"
COMMAND   PID    USER   FD  TYPE  SIZE/OFF  NODE NAME
node    67528 xingzhi  txt  REG   119121584  /Volumes/DeepThink 1.0.0/DeepThink.app/Contents/Resources/node/node

$ ps -p 67528 -o pid,ppid,command
  PID  PPID COMMAND
67528     1 /Volumes/DeepThink 1.0.0/DeepThink.app/Contents/Resources/node/node /Volumes/DeepThink 1.0.0/DeepThink.app/Contents/Resources/agent-runner/dist/index.js
```

PPID=1 表明进程已被 launchd 接管（孤儿化）。

## 4. 复现路径

前置条件：macOS 上已构建过一次 `make desktop-pack-mac`，生成 `desktop/release/DeepThink-1.0.0-arm64.dmg`。

1. 双击 `desktop/release/DeepThink-1.0.0-arm64.dmg`，挂载镜像。
2. 进入 `/Volumes/DeepThink 1.0.0/`，**直接双击 `DeepThink.app`**（不要拷贝到 `/Applications`）。
3. 等待应用启动并初始化完成后端（agent-runner 开始运行）。
4. 关闭应用窗口（Cmd+Q 也可能不杀 agent-runner，因为它是 detached）。
5. 再次执行 `make desktop-pack-mac` → 复现 detach 失败。

## 5. 诊断方法

```bash
# 一行命令查看是否有残留挂载 + 占用进程
ls /Volumes/ | grep -i deepthink && \
  mount | grep -i deepthink && \
  for v in /Volumes/DeepThink*; do \
    echo "== $v =="; lsof "$v" 2>/dev/null | head; \
  done

# 查看 hdiutil attach 记录
hdiutil info | grep -A 2 -i deepthink
```

如果输出包含 `node` 进程从 `/Volumes/DeepThink*/DeepThink.app/...` 路径运行，即为根因。

## 6. 修复方案

### 即时修复（让打包立即恢复）

```bash
# 1. 终止占用 DMG 的孤儿 agent-runner 进程
kill $(lsof -t "/Volumes/DeepThink 1.0.0")

# 2. 卸载 stale 挂载点
hdiutil detach "/Volumes/DeepThink 1.0.0"

# 3. 重新打包
make desktop-pack-mac
```

### 预防措施（已沉淀到 Makefile）

在 `Makefile` 新增 `desktop-clean-stale-mount` target，作为 `desktop-pack-mac` / `desktop-pack-mac-x64` 的前置依赖：

```diff
+desktop-clean-stale-mount: ## 打包前清理 macOS 上残留的 DeepThink DMG 挂载点（避免 hdiutil detach 失败，exit code 16）
+	@for v in "/Volumes/DeepThink 1.0.0" "/Volumes/DeepThink 1.0.0-x64" "/Volumes/DeepThink"*; do \
+		[ -e "$$v" ] || continue; \
+		echo "[desktop] 发现残留挂载点: $$v"; \
+		holders=$$(lsof -t "$$v" 2>/dev/null); \
+		if [ -n "$$holders" ]; then \
+			echo "[desktop] 以下进程占用该卷，需先终止:"; \
+			ps -p $$holders -o pid,ppid,command 2>/dev/null; \
+			echo $$holders | xargs kill 2>/dev/null || true; \
+			sleep 2; \
+		fi; \
+		hdiutil detach "$$v" 2>/dev/null || hdiutil detach -force "$$v" 2>/dev/null || true; \
+	done
+
-desktop-pack-mac: desktop-build desktop-rebuild-natives ## 打包 macOS .dmg（仅 arm64，日常本地用）
+desktop-pack-mac: desktop-build desktop-rebuild-natives desktop-clean-stale-mount ## 打包 macOS .dmg（仅 arm64，日常本地用）
 	cd $(DESKTOP_DIR) && npx electron-builder --config build/mac-arm64.json
```

**选型理由**：

- **最小侵入**：只在打包前加一个清理 hook，不修改 electron-builder 流程、不修改 .app 启动逻辑（Surgical Changes 原则）。
- **幂等**：无残留挂载时静默跳过，不影响 CI 干净环境。
- **可见性**：发现残留挂载时打印占用进程的 `pid/ppid/command`，便于用户事后追查根因（比如是否有多个 .app 实例在跑）。
- **强制 fallback**：先温和 `detach`，失败再 `detach -force`，再失败才放弃（避免阻塞打包流程）。
- **不杀陌生进程**：只 kill `lsof -t` 返回的占用进程，这些进程必然是从 `/Volumes/DeepThink*` 路径加载文件的，确实是上次打包残留的实例。

### 替代方案（未采纳）

- 修改 `BackendSupervisor` 在 .app 退出时强制 `SIGTERM` 子进程：可行但超范围，且无法处理已经被 launchd 接管的孤儿。
- 在 .app 启动时检测自身是否从 `/Volumes/*.dmg` 路径运行，弹窗提示用户拷贝到 `/Applications`：体验好但工作量大，留作后续优化。

## 7. 处理卡住的状态

如果 `kill` + `hdiutil detach` 后挂载点仍存在：

```bash
# 强制 detach
hdiutil detach -force "/Volumes/DeepThink 1.0.0"

# 极端情况：先 umount 再 detach
sudo umount -f "/Volumes/DeepThink 1.0.0"
hdiutil detach $(mount | grep -i deepthink | awk '{print $1}' | sed 's/s[0-9]*$//')

# 检查 launchd 残留
launchctl list | grep -i deepthink
launchctl remove <label>  # 如有
```

## 8. 经验沉淀 / 预防

1. **不要从 DMG 直接运行 .app**：macOS DMG 是只读挂载，从其内启动的应用会产生孤儿进程占用卷。正确做法是把 `.app` 拖到 `/Applications` 后再运行。
2. **CI 环境天然干净**：GitHub Actions runner 每次都是新 VM，不会有 stale 挂载。本问题只影响本地打包。
3. **打包失败后必须清理**：如果 electron-builder 在 DMG 阶段失败，**一定**会留下 `/Volumes/DeepThink*` 挂载点，下次打包前必须清理。本次 Makefile 改动已自动处理。
4. **agent-runner 进程模型**：`BackendSupervisor` spawn 子进程时若使用 `detached: true` 且 unref，子进程就会在主进程退出后孤儿化。这是有意的（保证后端不被 Electron 主进程崩溃拖累），但需要配合"退出时优雅 shutdown"信号通道（已在桌面版实现 SIGTERM handler）。后续可考虑在 `BackendSupervisor` 增加 `process.on('exit')` 强制 kill 子进程。
5. **巡检脚本**：把 `make desktop-clean-stale-mount` 加入本地开发日常流程，或在 `make desktop-dev` 启动前也跑一次，避免开发模式下从 DMG 启动遗留的孤儿进程干扰下一次打包。
