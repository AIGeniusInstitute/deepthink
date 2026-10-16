# make stop-prod 报「已停止」，几秒后旧看门狗又把实例拉起来

- 日期：2026-10-16
- 分支：`worktree-feat-kb-full-replica`
- 影响范围：`Makefile` `stop-prod` / `_start-direct`（守护启动路径），`scripts/deepthink-watchdog.sh`（未改）
- 状态：已修复

## 1. 用户现象

两件事一起出现：

1. `make stop-prod PORT=9911` 打印「✅ 已停止 DeepThink (端口 9911)」，但 **6 秒后端口又被占用**：

   ```
   $ make stop-prod PORT=9911 && sleep 8 && lsof -ti tcp:9911 -sTCP:LISTEN
   🛑 停止看门狗 (pid 17224)          # ← 修复后才有的行
   ⏳ 端口 9911 被 pid 23228 占用，发送 SIGTERM…
   ✅ 已停止 DeepThink (端口 9911)
   23228                              # ← 修复前：停止后仍然有人在听
   ```

2. `make start-prod PORT=9911` 打印「✅ 已后台启动 (watchdog pid …, node pid …)」，
   但这个新 node **根本没抢到端口**，看门狗在日志里疯狂崩溃重启：

   ```
   [watchdog] 15:04:08 启动 node (pid=22565, port=9911)
   [watchdog] 15:04:10 node 意外退出，3s 后自动重启
   [watchdog] 15:04:13 启动 node (pid=22633, port=9911)
   [watchdog] 15:04:15 node 意外退出，3s 后自动重启
   …（每 5 秒一轮，无限循环）
   ```

   结果是：命令说启动成功，实际服务的是**上一轮**的进程。

## 2. 问题描述

同一端口上同时存在两个看门狗，`stop-prod` 一个都没能停掉。

`stop-prod` 的停止手段只有两条：

```make
@touch "$(CURDIR)/logs/deepthink-$(PORT).stop"      # ① 写共享停止标记
@$(MAKE) --no-print-directory _stop-port PORT=$(PORT)  # ② 杀端口监听进程
```

看门狗靠轮询那个标记文件决定要不要退出（`scripts/deepthink-watchdog.sh:47,56,67`），
而**标记是一个共享文件、谁看到谁删**（`rm -f "$STOP_FLAG"`）。同时，`_start-direct`
在拉起新看门狗之前还会 `rm -f "$PROD_STOP_FLAG"` 主动清一次标记。

于是只要同端口上存在两个看门狗（旧的在标记轮询窗口内没退干净，`start-prod` 又拉起了一个），
两个就可能互相截胡：

- 旧看门狗的 node 被杀 → 它在下一次轮询时发现标记"不见了"（被新看门狗或 `_start-direct`
  删掉了）→ 判定为「node 意外退出」→ 按设计自动重启 → **重新占住端口**；
- 新看门狗拉起的新 node 因为端口被占，起来就 `EADDRINUSE` 退出 → 也是「意外退出」→ 重启 → 死循环。

`start-prod` 的判据放大了后果：它只检查"**端口上有人监听**"（`lsof -ti:$(PORT) -sTCP:LISTEN`），
不检查监听者是不是自己刚起的那个 node —— 旧进程占着端口反而让这个判据成立，于是报出
一声响亮的「✅ 已后台启动」。

## 3. 根因

**停止逻辑用"共享文件"做进程定向，而共享文件无法定向投递；启动成功判据又不校验进程身份。**

实测证据（同一时刻存在两个看门狗，旧的才是端口持有者）：

```
$ ps -eo pid,ppid,lstart,command | grep -E "deepthink-watchdog|node dist/index.js"
17224     1  Fri Oct 16 14:56:11 2026  bash scripts/deepthink-watchdog.sh 9911 …
22353 17224  Fri Oct 16 15:03:47 2026  node dist/index.js          # ← 旧看门狗在 15:03 重启的 node，占着端口
22563     1  Fri Oct 16 15:04:08 2026  bash scripts/deepthink-watchdog.sh 9911 …   # ← 本次 start-prod 拉起的
22757 22563  Fri Oct 16 15:04:23 2026  node dist/index.js          # ← 抢不到端口，反复退出重启
```

依据：`Makefile` `stop-prod`（只写标记 + 杀监听进程）、`scripts/deepthink-watchdog.sh:47/56/67`
（标记轮询与 `rm -f "$STOP_FLAG"`）、`Makefile` `_start-direct`（`rm -f "$PROD_STOP_FLAG"` 后 nohup 看门狗）。

触发时机：`start-prod` 会先 `stop-prod` 再重启，两次都走这套"标记 + 杀进程"，
只要有一轮没退干净，就会累积出第二个看门狗。

## 4. 复现路径

在同一个端口上连续做两次 `make start-prod`（第一次留下的看门狗若未及时退出即进入故障态）：

```bash
make start-prod PORT=9911
make start-prod PORT=9911          # 第二次：stop 的窗口里旧看门狗可能复活
sleep 5
pgrep -fl "deepthink-watchdog.sh 9911"   # 出现两条 = 复现
lsof -ti tcp:9911 -sTCP:LISTEN           # 监听者 ≠ logs/deepthink-9911.pid 里的 pid = 复现
```

## 5. 诊断方法

```bash
# 谁在监听、它的父进程是谁（父进程是看门狗，看 pid 就能分出新旧两代）
for p in $(lsof -ti tcp:9911 -sTCP:LISTEN); do ps -o pid=,ppid=,lstart=,command= -p $p; done

# 活着几个看门狗
pgrep -fl "deepthink-watchdog.sh 9911"

# 停止标记还在不在（被谁消费了看不出来，但"不在"说明已经被人删过）
ls -la logs/deepthink-9911.stop

# 启动是否真的成功：拿 pidfile 和监听 pid 对一下
echo "listen=$(lsof -ti tcp:9911 -sTCP:LISTEN | head -1) pidfile=$(cat logs/deepthink-9911.pid)"

# 崩溃循环的直接证据
grep -c "意外退出" logs/deepthink-9911.log
```

## 6. 修复方案

两处，都在 `Makefile`：

```diff
--- a/Makefile
+++ b/Makefile
@@ stop-prod: ## 停止指定端口的隔离实例（PORT 必填，写停止标记后杀端口监听进程，不自动重启）
 	@mkdir -p "$(CURDIR)/logs"
 	@touch "$(CURDIR)/logs/deepthink-$(PORT).stop"
+	@# 看门狗要直接发信号停掉，不能只留停止标记：标记是一个**共享文件**，同一端口上
+	@# 若有两个看门狗（旧的在标记轮询窗口内没退干净，start-prod 又拉起了一个），先醒
+	@# 来的那个会把标记删掉，另一个就当「node 意外退出」把实例重新拉起来 —— 现象是
+	@# make stop-prod 报成功、几秒后端口又被占，而 start-prod 只检查「端口有人在听」，
+	@# 于是新实例静默绑定失败却报启动成功。看门狗自己的 TERM trap 会杀掉子进程再退出。
+	@for wd in $$(pgrep -f "deepthink-watchdog\.sh $(PORT) " 2>/dev/null); do \
+	  echo "🛑 停止看门狗 (pid $$wd)"; kill -TERM $$wd 2>/dev/null || true; \
+	done
 	@$(MAKE) --no-print-directory _stop-port PORT=$(PORT)
```

```diff
@@ _start-direct … 启动后的成功判据
-	  if lsof -ti:$(PORT) -sTCP:LISTEN >/dev/null 2>&1; then \
-	    echo "✅ 已后台启动 (watchdog pid $$wdpid, node pid $$(cat "$$PROD_PIDFILE" 2>/dev/null))"; \
+	  listen_pid=$$(lsof -ti:$(PORT) -sTCP:LISTEN 2>/dev/null | head -1); \
+	  want_pid=$$(cat "$$PROD_PIDFILE" 2>/dev/null); \
+	  if [ -n "$$listen_pid" ] && [ "$$listen_pid" = "$$want_pid" ]; then \
+	    echo "✅ 已后台启动 (watchdog pid $$wdpid, node pid $$want_pid)"; \
 	    …（成功分支不变）
 	  else \
-	    echo "❌ 启动失败，查看日志: $$PROD_LOG"; tail -20 "$$PROD_LOG"; rm -f "$$PROD_PIDFILE"; exit 1; \
+	    echo "❌ 启动失败：端口 $(PORT) 被 pid $$listen_pid 占着，本实例的 node 是 pid $$want_pid"; \
+	    echo "   多半是上一轮遗留的看门狗抢占了端口（先 make stop-prod PORT=$(PORT)，再确认 pgrep -fl deepthink-watchdog 已清空）"; \
+	    tail -20 "$$PROD_LOG"; rm -f "$$PROD_PIDFILE"; exit 1; \
 	  fi; \
```

选型理由：

- **给看门狗发 TERM，而不是继续加标记相关的补丁**：看门狗自带 trap
  `trap 'stop_child; rm -f "$STOP_FLAG" "$PIDFILE"; exit 0' TERM INT`，收到 TERM 会先杀子进程
  再退出。信号是**按进程投递**的，没有"谁抢到标记"的竞态；`pgrep -f "... $(PORT) "` 末尾的空格
  保证只匹配这个端口的看门狗（不会误伤 99110 之类的前缀）。
- **先发 TERM 再 `_stop-port`**：看门狗的 trap 会自己清理子进程，随后 `_stop-port` 兜底，
  顺序反了的话 `_stop-port` 杀完 node，看门狗可能已经又拉起来一个。
- **启动判据比对 pid 而不是"端口有人听"**：这是把"报成功"变成"真的成功"。本次故障里
  最危险的其实不是端口被占，而是**命令说成功、实际服务的是旧进程** —— 后续所有验证都会被它带偏。

验证：

```
$ make stop-prod PORT=9911 && sleep 8
🛑 停止看门狗 (pid 17224)
✅ 已停止 DeepThink (端口 9911)
$ pgrep -fl "deepthink-watchdog.sh 9911"          → 空
$ lsof -ti tcp:9911 -sTCP:LISTEN                  → 空（8 秒后仍为空）

$ make start-prod PORT=9911
✅ 已后台启动 (watchdog pid 24557, node pid 24559)
$ echo "listen=$(lsof -ti tcp:9911 -sTCP:LISTEN|head -1) pidfile=$(cat logs/deepthink-9911.pid)"
listen=24559 pidfile=24559                         # 一致
```

## 7. 处理卡住的状态

处置办法（已执行过一次，有效）：

```bash
# 1. 让所有看门狗先停（TERM 会触发各自的 cleanup trap）
for wd in $(pgrep -f "deepthink-watchdog\.sh 9911 "); do kill -TERM $wd; done
# 2. 兜底杀掉还占着端口的 node
lsof -ti tcp:9911 -sTCP:LISTEN | xargs -r kill -9
# 3. 确认两样都空了再重启，否则会再叠一层
pgrep -fl "deepthink-watchdog.sh 9911"; lsof -ti tcp:9911 -sTCP:LISTEN
```

## 8. 经验沉淀 / 预防

- **"停止"不要依赖共享文件做定向投递。** 标记文件适合"通知一类进程优雅收场"，不适合
  "精确停掉某一个"；多实例/多代进程并存时必然出现互相截胡。定向停止要用信号 + pid。
- **"启动成功"必须验证身份。** 只检查"端口有人听"会把别人的进程当成自己的成果 —— 这类
  假成功比直接失败更贵，因为它会让后续所有验证结论失效（本次就因此白跑了一轮验收）。
- 建议加一道巡检：`make status` 里校验 `lsof` 的监听 pid 与 `logs/deepthink-<PORT>.pid` 是否一致，
  并在 `pgrep -f deepthink-watchdog.sh <PORT>` 计数 > 1 时直接告警。**本次未改**（登记待办）。
