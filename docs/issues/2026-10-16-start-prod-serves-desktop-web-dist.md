# make start-prod 服务的是桌面版内置前端，不是仓库刚编译出来的 web/dist

- 日期：2026-10-16
- 分支：`worktree-feat-kb-full-replica`
- 影响范围：`Makefile` `_start-direct`（`make start` / `make start-prod` 共用的启动路径）
- 状态：已修复

## 1. 用户现象

在隔离实例上做 UI 验收，Playwright 脚本报 `locator.fill: Timeout 30000ms exceeded` ——
按 `data-testid="kb-create-name"` 找不到元素。但弹窗明明是开着的：探针读出对话框 HTML 里
有 `<div class="font-semibold">新建知识库</div>`，页面 `body` 里却是「暂无知识库，点击右上角
「新建」创建第一个。」—— 这跟仓库里的源码文案（「点右上角「新建知识库」」）对不上。

更直接的判据：

```
$ curl -s http://127.0.0.1:9911/ | grep -o 'assets/index-[A-Za-z0-9_-]*\.js'
assets/index-BXbNOyp-.js          # 页面加载的 bundle

$ grep -o 'assets/index-[A-Za-z0-9_-]*\.js' web/dist/index.html
assets/index-BpL56SlD.js          # 仓库刚编译出来的 bundle
```

`curl` 页面里一个 `data-testid` 都没有（`p.locator('[data-testid]').count()` → 0），
而 `grep kb-create-name web/dist/assets/index-BpL56SlD.js` 是命中的。**服务端在跑另一份前端。**

## 2. 问题描述

`src/web.ts` 解析静态资源根目录时，环境变量优先于工作目录：

```ts
// src/web.ts:21-23
const WEB_DIST_ROOT = process.env.DEEPTHINK_WEB_DIST_DIR
  ? path.resolve(process.env.DEEPTHINK_WEB_DIST_DIR)
  : path.join(process.cwd(), 'web', 'dist');
```

这个变量是 **DeepThink 桌面版**注入给其后端子进程的（值恒为
`/Applications/DeepThink.app/Contents/Resources/web-dist`），用途是让桌面版跑自己打包好的前端。

而本 Agent 的 shell 就是桌面版的内嵌终端，环境变量会被子进程继承。`start-prod` 只显式覆盖了
`DEEPTHINK_DATA_DIR`（做实例隔离），**没有覆盖 `DEEPTHINK_WEB_DIST_DIR`** —— 于是 `make` 花十几秒
编译出来的 `web/dist` 被静默忽略，实例对外服务的是桌面版内置的那份旧前端。编译日志一切正常，
`_build-web-if-stale` 也照常报「✅ 前端无变更/已重新编译」，没有任何一处会提示"你编译的东西没人用"。

## 3. 根因

**环境变量泄漏 + 启动目标未钉死静态资源根目录。**

进程环境实测：

```
$ ps eww -o command= -p <node pid> | tr ' ' '\n' | grep DEEPTHINK_WEB_DIST_DIR
DEEPTHINK_WEB_DIST_DIR=/Applications/DeepThink.app/Contents/Resources/web-dist

$ lsof -a -p <node pid> -d cwd | tail -1
node  <pid>  edy  cwd  DIR  ...  /Users/edy/deepthink/.claude/worktrees/feat-kb-full-replica
```

工作目录是对的（worktree 根），但环境变量把 `WEB_DIST_ROOT` 指到了 app bundle 里。
`start-prod` 的注释写着"编译+构建+部署"，实际部署的是别人家的产物。

依据：`src/web.ts:21-23`（优先级）、`Makefile` `_start-direct`（启动时只覆盖 DATA_DIR）。

## 4. 复现路径

1. 从 DeepThink 桌面版的内嵌终端（或任何继承了 `DEEPTHINK_*` 环境变量的 shell）里，在仓库根执行：
   `make start-prod PORT=9911`
2. `curl -s http://127.0.0.1:9911/ | grep -o 'assets/index-[A-Za-z0-9_-]*\.js'`
3. 与 `grep -o 'assets/index-[A-Za-z0-9_-]*\.js' web/dist/index.html` 对比 —— 两者不一致即复现。
4. 想立刻确认是"环境变量而非浏览器缓存"：`curl -s -o /dev/null -w '%{http_code}' http://127.0.0.1:9911/assets/<仓库那份 bundle>.js` → `404`。

## 5. 诊断方法

```bash
# 1. 服务端到底在服务哪个 dist（curl 不经过任何前端缓存，最能定性）
curl -s http://127.0.0.1:9911/ | grep -o 'assets/index-[A-Za-z0-9_-]*\.js'
grep -o 'assets/index-[A-Za-z0-9_-]*\.js' web/dist/index.html

# 2. 看进程环境里有没有人把根目录指走了
ps eww -o command= -p "$(lsof -ti tcp:9911 -sTCP:LISTEN | head -1)" | tr ' ' '\n' | grep WEB_DIST

# 3. 看进程工作目录（cwd 正常 = 不是 cwd 推断的问题）
lsof -a -p "$(lsof -ti tcp:9911 -sTCP:LISTEN | head -1)" -d cwd | tail -1

# 4. 在浏览器里确认命中的是不是同一份（同一份 bundle 里才有新加的 testid）
curl -s http://127.0.0.1:9911/assets/<bundle>.js | grep -c 'kb-create-name'
```

## 6. 修复方案

```diff
--- a/Makefile
+++ b/Makefile
@@ _start-direct: ## (内部) 裸跑模式（无 pm2 或未注册）；START_DIRECT_DAEMON=1 时后台守护（start-prod 用）
+	@# 静态资源钉死在本仓库的 web/dist：DEEPTHINK_WEB_DIST_DIR 本是桌面版给后端指定
+	@# 「内嵌 web-dist」用的，从桌面版内嵌终端里跑 make 会继承它，于是上面刚编译出来的
+	@# web/dist 被静默忽略、页面一直停在桌面版内置的旧前端。必须显式覆盖。
+	@export DEEPTHINK_WEB_DIST_DIR="$(CURDIR)/web/dist"; \
 	if [ "$(START_DIRECT_DAEMON)" = "1" ]; then \
```

选型理由：

- **放在 `_start-direct` 而不是 `start-prod`**：`make start` 和 `make start-prod` 都经由这里启动后端，
  两条路径的病一样，修一处覆盖两处。
- **`export` 必须和 `if` 在同一个 shell 里**：make 每个 recipe 行起一个独立 shell，单独一行 `export`
  不会传给下一行。把 `export ...; \` 接在同一行、跨行续到 `if`，才是同一个 shell。
- **值取 `$(CURDIR)/web/dist`**：与 `src/web.ts` 的 cwd 推断同义，但不再依赖调用者环境。
- 没有采用"改 `src/web.ts` 忽略环境变量"：桌面版确实需要这个变量来指定它自己的 web-dist，
  这是它的合法用途；错的只是"从源码仓库启动"时不该继承它。

验证：

```
$ make start-prod PORT=9911 && curl -s http://127.0.0.1:9911/ | grep -o 'assets/index-[A-Za-z0-9_-]*\.js'
assets/index-CrVira6Z.js
$ grep -o 'assets/index-[A-Za-z0-9_-]*\.js' web/dist/index.html
assets/index-CrVira6Z.js          # 一致
```

## 7. 处理卡住的状态

不适用（无 stuck 实例，改完重启即生效）。

## 8. 经验沉淀 / 预防

- **桌面版注入的 `DEEPTHINK_*` 环境变量会污染 make 目标。** 凡是"以本仓库为根"的目标，都应把
  决定根目录的变量显式钉死，而不是指望环境干净。目前已知的两个：`DEEPTHINK_DATA_DIR`
  （`start-prod` 已覆盖）、`DEEPTHINK_WEB_DIST_DIR`（本次覆盖）。
- **"编译成功"和"用上了"是两件事。** 建议在启动日志里打一行实际的静态资源根目录
  （`src/web.ts` 里 `logger.info({ WEB_DIST_ROOT }, 'serving static assets')`），
  这样下次一眼就能看出来。**本次未改**（超出本次修复范围，登记待办）。
- 排查这类"改了代码但页面没变"的问题，先用 `curl` 拿页面引用的 bundle 名与本地构建产物比对，
  再谈浏览器缓存 / Service Worker —— 本次一开始怀疑是 `vite-plugin-pwa` 的 service worker
  在发旧包，方向错了，绕了一圈。
