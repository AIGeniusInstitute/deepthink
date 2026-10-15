# macOS 桌面版「打包成功却打不开」排查：单实例静默退出 + 残留 DMG 挂载

- 日期：2026-10-15
- 触发命令：`make desktop-pack-mac`
- 平台：macOS 15.7.9（Darwin 24.6.0，arm64，BuildVersion 24G830）
- 工具版本：electron-builder 25.1.8 / electron 32.3.3
- 结论：**构建链路本身无缺陷**（两次打包均 exit 0、dmg 校验通过、应用端到端可用）；用户观感上的「错误」来自两个**运行时环境态**陷阱，本文记录成因与正确操作姿势

## 1. 用户现象

反馈执行 `make desktop-pack-mac` 遇到错误，且打包出的 Mac 桌面版应用打不开、不可用。

本次实测的客观结果与之不符——打包一次成功，未复现任何构建错误：

| 检查项 | 实测结果 |
|---|---|
| `make desktop-pack-mac` 第 1 次 | exit 0 |
| `make desktop-pack-mac` 第 2 次（可重复性） | exit 0 |
| `hdiutil verify desktop/release/DeepThink-1.0.0-arm64.dmg` | checksum VALID（574 MB） |
| `better-sqlite3` native binding | 存在，且通过内置 node v22.11.0 ABI 加载校验 |
| 从挂载卷启动应用 | 后端 49282 healthy，UI 渲染正常，建管理员端到端通过 |
| 装入 /Applications 后启动 | 后端 49281 healthy，GUI 窗口正常渲染真实数据 |

但排查过程中**确实复现到两个会让「打包成功却用不了」的真实陷阱**，且第一个陷阱极容易被误判成「构建坏了」。两者都值得沉淀。

## 2. 问题描述

两类现象都不在构建产物里，而在「单实例锁 + 挂载卷」这类环境态上：

- **现象 A（主因）**：启动新构建时进程**静默退出**——没有新窗口、没有报错弹窗、没有 crash 日志，只有一行 supervisor 日志。用户看到的就是「双击了，没反应」。
- **现象 B**：从挂载的 DMG 卷里直接运行 `.app` 后，卷被进程占用，导致**下一次**打包在 DMG 阶段 `hdiutil detach` 失败（exit 16）。

## 3. 根因

### 3.1 现象 A：单实例锁 + macOS userData 不认 `$HOME`

`desktop/src/main.ts` 顶部就申请单实例锁，拿不到就静默退出：

```js
if (!app.requestSingleInstanceLock()) {
  debug('single-instance lock failed, quitting');
  app.quit();
}
```

锁的位置是 Electron 的 userData 目录 `~/Library/Application Support/deepthink-desktop`（取自 `package.json` 的 `name`）。当 `/Applications/DeepThink.app` 的**任一实例正在运行**（桌面版会把窗口关成托盘常驻，`window-all-closed` 不退出，所以「没有窗口 ≠ 没在跑」）时，新实例拿不到锁 → `app.quit()` → 用户什么都看不到。

证据（`~/Library/Application Support/DeepThink/logs/main.log`）：

```
2026-10-15T03:36:28.897Z main module loaded
2026-10-15T03:36:28.910Z second-instance event
2026-10-15T03:36:28.922Z single-instance lock failed, quitting
```

**排查中踩到的次生坑**：macOS 下 Chromium/Electron 解析 userData **不走 `$HOME`**（走 `NSSearchPathForDirectoriesInDomains`），所以想用 `HOME=/tmp/xxx` 隔离一个实例出来验证是**无效的**——实测新实例仍撞上现有实例的锁并静默退出，一度让人误以为「新构建启动就崩」。补上 `--user-data-dir=/tmp/xxx` 后才真正隔离成功。

### 3.2 现象 B：残留挂载（与 2026-07-12 同源）

与 `docs/issues/2026-07-12-macos-dmg-stale-mount.md` 同一根因：从 DMG 卷直接双击运行 `.app`（而不是拷到 `/Applications`），进程持有 `/Volumes/DeepThink 1.0.0` 内的二进制文件描述符，卷卸不掉，下次打包 attach 同名卷冲突。

本次实测复现到了前置态（6 个进程占住卷）：

```bash
$ lsof -t "/Volumes/DeepThink 1.0.0"
11922 12074 12075 12076 12080 12101
```

**但该路径已闭环**：`make desktop-clean-stale-mount`（`desktop-pack-mac` 的前置依赖）实测一步恢复——占用进程全部退出、卷正常 ejected。故这一次它不是故障点。

### 3.3 附带发现：主进程无 SIGTERM 处理器

对 `desktop/src/` 全目录检索，只有一处信号相关代码，且是**发给后端子进程**的：

```
desktop/src/backend-supervisor.ts:299:    this.log('[supervisor] sending SIGTERM');
desktop/src/backend-supervisor.ts:300:    proc.kill('SIGTERM');
```

**Electron 主进程自身没有 SIGTERM/SIGINT handler**，实测 `kill <主进程 pid>` 后 6 秒进程仍在（`pkill DeepThink` 同理杀不掉）。`desktop-clean-stale-mount` 之所以仍然有效，是靠「把卷上**所有**持有者一起 kill」（含后端子进程）间接达成，而不是主进程响应了信号——这条隐式依赖比较脆，见 §6 建议。

## 4. 复现路径

**现象 A**：

1. 保持 `/Applications/DeepThink.app` 任一实例处于运行态（可以最小化到托盘，进程仍在）
2. 挂载新 dmg，双击 `/Volumes/DeepThink 1.0.0/DeepThink.app`
3. 观察：**无新窗口、无弹窗**；旧实例 `main.log` 追加 `second-instance event`，新进程日志追加 `single-instance lock failed, quitting`

**现象 B**：见 `docs/issues/2026-07-12-macos-dmg-stale-mount.md` §4。

## 5. 诊断方法

```bash
# 1) 产物完整性——完全不依赖任何运行态，先排除「构建坏了」的可能
hdiutil verify desktop/release/DeepThink-1.0.0-arm64.dmg
ls -la desktop/release/mac-arm64/DeepThink.app/Contents/Resources/node_modules/better-sqlite3/build/Release/better_sqlite3.node

# 2) 是不是被单实例锁挡住了（"打不开"第一现场）
tail -5 "$HOME/Library/Application Support/DeepThink/logs/main.log"
ps aux | grep "DeepThink.app/Contents/MacOS/DeepThink" | grep -v grep

# 3) 有没有残留挂载 + 谁在占用
ls -d /Volumes/DeepThink* 2>/dev/null
for v in /Volumes/DeepThink*; do echo "== $v =="; lsof "$v"; done

# 4) 隔离验证新构建（不碰现有实例、不碰真实数据目录）
HOME=/tmp/dt-verify-home "/Volumes/DeepThink 1.0.0/DeepThink.app/Contents/MacOS/DeepThink" \
  --user-data-dir=/tmp/dt-verify-profile
# ⚠️ 只设 HOME 不管用！macOS 下 userData 不走 $HOME，
#    必须同时给 --user-data-dir，否则单实例锁仍与现有实例冲突而静默退出

# 5) 端到端确认后端真的可用
#    端口不固定：后端在 49281-49300 里挑第一个空闲端口，实际值见 main.log 的
#    "backend started on port <N>"
curl -s http://127.0.0.1:49282/api/health
```

## 6. 修复方案

**本次未改动任何源码**——构建链路无缺陷，没有可修的 diff，故没有伴随的代码提交。已完成的处置是把「操作姿势」纠正到位：

1. 结束旧实例（先 `kill -9` 主进程避免 supervisor 拉起后端，再对后端子进程发 SIGTERM 让它优雅退出）
2. 备份旧包与数据库
3. 用新构建替换 `/Applications/DeepThink.app`，以 LaunchServices（`open -a`）正常启动并验证通过

对两个环境态陷阱，建议后续加固（**未实施**，超出本次范围）：

- **主进程补 SIGTERM/SIGINT handler**，复用 `BackendSupervisor.stop()` 的优雅退出路径。收益：`kill`/`pkill` 行为与运维直觉一致，也让 `desktop-clean-stale-mount` 的 `kill` 不再依赖「杀后端间接带走主进程」。
- **`desktop-clean-stale-mount` 加兜底**：`kill`（SIGTERM）后 sleep 复查，仍有持有者则 `kill -9`。当前实现只发一次 SIGTERM 就 `sleep 2` 再 detach，遇到不响应信号的持有者会走 `detach -force || true` 静默失败，随后 electron-builder 才报 exit 16，错误现场被推迟且更难定位。

## 7. 处理卡住的状态

从 dmg 卷跑起的实例杀不干净 / 卷卸不掉时：

```bash
# 首选：直接跑 Makefile 目标（实测一步恢复）
make desktop-clean-stale-mount

# 手工等价操作，温和 → 兜底
kill $(lsof -t "/Volumes/DeepThink 1.0.0")
hdiutil detach "/Volumes/DeepThink 1.0.0" || hdiutil detach -force "/Volumes/DeepThink 1.0.0"
```

若仍卸不掉（`resource busy`）：`sudo umount -f "/Volumes/DeepThink 1.0.0"`，再 `hdiutil detach`（详见 2026-07-12 文档 §7）。

## 8. 经验沉淀 / 预防

1. **「打包成功但打不开」先查单实例锁，不要先怀疑构建**：看 `main.log` 有没有 `single-instance lock failed, quitting`。桌面版窗口关掉只是最小化到托盘，**「没有窗口 ≠ 没有进程」**——这是本次最容易被误判成构建故障的地方。
2. **不要从挂载卷直接运行 `.app`**：拷到 `/Applications` 再运行，否则孤儿进程占卷会让下一次打包的 DMG 阶段失败。
3. **`$HOME` 隔离不了 Electron 单实例锁**：macOS 下 Chromium userData 走系统 API，验收脚本必须用 `--user-data-dir` 才能隔离。任何"起第二个实例来对比验证"的脚本都会踩这条。
4. **升级会迁移数据库**：新构建首次启动会把 `~/Library/Application Support/DeepThink/data/db/messages.db` 迁移到最新 schema，**回退旧包时要连 DB 备份一起回退**，否则旧包可能读不了新库。
5. **打包前后一行巡检**：

```bash
tail -3 "$HOME/Library/Application Support/DeepThink/logs/main.log"; \
ls -d /Volumes/DeepThink* 2>/dev/null && echo "⚠️ 有残留挂载，打包前先 make desktop-clean-stale-mount"
```

6. **本次的完整验收结论**（供后续回归比对）：两次 `make desktop-pack-mac` 均 exit 0；dmg `hdiutil verify` VALID；应用从挂载卷与从 `/Applications` 两条路径均可启动，后端 `/api/health` 返回 `{"status":"healthy","database":true}`，UI 无 page error、无 5xx；全新数据目录下建管理员端到端流程通过。
