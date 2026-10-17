# 2026-10-18 桌面端 Makefile `desktop-build-deps` 依赖顺序 bug

## 1. 用户现象

在 fresh 机器（或刚 `git clean` 过的 worktree）上执行 `make desktop-pack-mac-x64` 打包桌面端 dmg，构建在「编译前端」阶段立即失败，报大量 `Cannot find module 'react'` / `Cannot find module 'react-router-dom'` / `Cannot find module 'lucide-react'` 以及连锁的 `JSX element implicitly has type 'any'`，最终 `make: *** [build] Error 1` 退出。同一台机器之前跑过 `make dev` / `make start` 的用户不会遇到，因为 `web/node_modules` 已经存在。

## 2. 问题描述

`Makefile` 的 `desktop-build-deps` 目标依赖顺序写反：

```makefile
desktop-build-deps: root-install build sync-types web-install
	cd container/agent-runner && npm install --no-audit --no-fund $(NPM_FLAGS)
	cd container/agent-runner && npm run build $(NPM_FLAGS)
```

`build` 目标执行 `npm run build:all`，由 `concurrently` 并发编译三个子项目：

```json
"build:all": "npx concurrently --group -n backend,web,agent-runner \"npm run build\" \"npm run build:web\" \"npm --prefix container/agent-runner run build\""
```

其中 `build:web` = `cd web && npm run build` = `tsc && vite build`，需要 `web/node_modules` 已存在；`agent-runner` 的 `tsc` 需要 `container/agent-runner/node_modules` 已存在。但 Make 把 `build` 排在 `web-install` 之前，agent-runner 的 `npm install` 更是写在 `desktop-build-deps` 的 recipe 行里（在所有 prerequisite 之后才执行）。结果：fresh 机器上 web/agent-runner 还没装依赖就跑 `tsc`，必然报 `Cannot find module 'react'` 等模块缺失错误，连锁触发 16000+ 个 TS 错误。

## 3. 根因

Make 依赖顺序与构建语义不匹配。`build:all` 隐式依赖三个子项目各自的 `node_modules`，但 `desktop-build-deps` 把 `web-install` 和 agent-runner install 排在 `build` 之后，违反了「先装依赖再编译」的不变量。

- 根因代码位置：`Makefile:718`（`desktop-build-deps` 的 prerequisite 列表）
- 外部依据：Make 的 prerequisite 在 recipe 执行前先全部建好，所以 `build` 在 `web-install` 之前 = `tsc` 在 `npm install` 之前
- 对照组：`root-install` 正确排在 `build` 之前（后端能编译通过），证明作者本意是「install 先于 build」，web/agent-runner 排后面是遗漏

历史上未暴露是因为开发者本地 `web/node_modules` / `container/agent-runner/node_modules` 长期存在，`web-install` 的幂等 guard 直接跳过，`build` 也能找到依赖；只有 fresh clone / CI / 新机器 / worktree 首次构建才触发。

## 4. 复现路径

1. 准备一个干净环境（新机器、新 worktree，或 `rm -rf web/node_modules container/agent-runner/node_modules`）
2. `make desktop-pack-mac-x64`（或任意依赖 `desktop-build-deps` 的目标，如 `make desktop-build`）
3. 观察到 `[web]` 阶段报 `Cannot find module 'react'`，`make: *** [build] Error 1`

预期（修复后）：web/agent-runner 先 install，再 `build:all`，全绿。

## 5. 诊断方法

```bash
# 1. dry-run 看依赖顺序（install 应排在 build:all 之前）
make -n desktop-build-deps 2>&1 | grep -iE "install|build:all"

# 2. 确认 fresh 状态会触发
rm -rf web/node_modules container/agent-runner/node_modules
make -n desktop-build-deps 2>&1 | grep -iE "install|build:all"
```

修复前输出顺序：`root-install → build:all → web-install → agent-runner install`（错）。
修复后输出顺序：`root-install → web-install → agent-runner-install → build:all`（对）。

## 6. 修复方案

抽出幂等的 `agent-runner-install` 目标（与 `web-install` / `root-install` 对称），并把三个 install 全部排到 `build` 之前。agent-runner install 保持无条件每次执行（原 inline 行为），因为 `container/agent-runner/package.json` 的 `@anthropic-ai/claude-agent-sdk` 用 `"*"` + 无 lock，本就该每次取最新；显式刷新走 `make update-sdk`。

```diff
+agent-runner-install: ## 安装 container/agent-runner 依赖（每次都装，因为 claude-agent-sdk 用 "*" + 无 lock，取最新）
+	cd container/agent-runner && npm install --no-audit --no-fund $(NPM_FLAGS)
+
-desktop-build-deps: root-install build sync-types web-install ## 编译桌面版所需的所有产物（后端 + 前端 + agent-runner）
-	cd container/agent-runner && npm install --no-audit --no-fund $(NPM_FLAGS)
-	cd container/agent-runner && npm run build $(NPM_FLAGS)
+desktop-build-deps: root-install web-install agent-runner-install sync-types build ## 编译桌面版所需的所有产物（后端 + 前端 + agent-runner）
+	@# build:all 会并发编译 backend+web+agent-runner，三者各自依赖的 node_modules 必须在 build 之前就位，
+	@# 否则 fresh 机器上 web/agent-runner 尚未 npm install 就跑 tsc，必因 "Cannot find module 'react'" 等失败。
+	cd container/agent-runner && npm run build $(NPM_FLAGS)
```

选型理由：
- 抽成独立 target 而非内联挪动，是因为 Make 的 prerequisite 顺序是排序的唯一真相源；内联 recipe 行永远在所有 prerequisite 之后执行，无法靠挪动 recipe 行实现「install 先于 build」。
- agent-runner install 不加幂等 guard（区别于 web/root），以保留原无条件刷新 SDK 的行为，零行为变更。
- 收尾的 `cd container/agent-runner && npm run build` 保留（`build:all` 已含 agent-runner build，这里冗余但无害，属既有代码，不在本次范围）。

## 7. 处理卡住的状态

不适用（本 bug 不产生 stuck 运行态，只导致构建退出）。若已在 fresh 机器上构建失败，直接 `git pull` 拿到修复后重跑 `make desktop-pack-mac-x64` 即可。

## 8. 经验沉淀 / 预防

- **Make 目标的 prerequisite 顺序必须匹配语义依赖**，尤其是「install → compile」这类硬依赖。CI 应在 fresh checkout 上跑一次 `make desktop-build`（或 `make build`）作为门禁，本地老 node_modules 会掩盖此类顺序 bug。
- 抽出独立 `*-install` target 时，与既有的 `web-install` / `root-install` 保持对称，便于阅读和维护。
- 本次还在 fresh Intel 机器上撞到 npm 10.5.2 的两个独立 bug（根 install 的 `edgesOut` 崩溃、`--legacy-peer-deps` 触发 npm/cli#4828 丢 `@rollup/rollup-darwin-x64`），与本 bug 无关，属环境问题，记录在 agent 记忆中。
