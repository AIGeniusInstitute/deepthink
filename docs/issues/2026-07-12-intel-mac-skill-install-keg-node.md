# 修复：Intel x64 Mac 上桌面版 Skill 安装报错（homebrew keg-only node@20 PATH 缺失）

> 关联前序修复：`docs/tech_solution/desktop-skill-install-npx-path/TECH-SOLUTION.md`（Apple Silicon 上的 npx PATH 修复）。本次为其 Intel x64 机器上的遗漏场景补丁。

## 1. 用户现象

在 Intel x64 Mac 上打包 DeepThink 桌面版（`make desktop-pack-mac-x64`）后启动应用，进入 Skill 模块，搜索 `kill`，点击「安装 skill」，前端弹出错误：

```
Failed to install skill
```

同一套源码在 Apple Silicon Mac Pro 上打包运行，安装 skill 正常。

## 2. 问题描述

桌面版 backend 进程在执行 `installSkillForUser()` → `execFile('npx', [...])` 时，`npx` 不在 backend 进程的 `PATH` 中，spawn 报 `ENOENT`，前端凭 HTTP 500 渲染「Failed to install skill」。

前序修复（`desktop/src/backend-supervisor.ts:resolveBackendPath()`）已经做了「登录 shell PATH + 继承 PATH + 兜底路径」合并，兜底清单含 `/opt/homebrew/bin` 与 `/usr/local/bin`。但**本机 npx 既不在 `/usr/local/bin`，也不被 zsh 登录 shell 解析捕获**，所以兜底未命中。

## 3. 根因

实测本机（Intel x64, macOS）：

```
$ uname -m
x86_64
$ which npx node npm
/usr/local/opt/node@20/bin//npx
/usr/local/opt/node@20/bin//node
/usr/local/opt/node@20/bin//npm
$ ls -la /usr/local/bin/npx /opt/homebrew/bin/npx
ls: /usr/local/bin/npx: No such file or directory
ls: /opt/homebrew/bin/npx: No such file or directory
```

关键事实链：

1. **npx 只存在于 homebrew keg-only 路径** `/usr/local/opt/node@20/bin/npx`（homebrew 把 `node@20` 装成 keg-only，**不在 `/usr/local/bin` 建符号链接**）。
2. **这条 PATH 仅在 `~/.bash_profile` 里设置**：
   ```
   $ grep -n node@20 ~/.bash_profile
   1:export PATH="/usr/local/opt/node@20/bin:$PATH"
   ```
3. **用户的登录 shell 是 zsh**（`$SHELL=/bin/zsh`），zsh 永远不会 source `.bash_profile`；macOS GUI 应用更不会。
4. 现有 `resolveBackendPath()` 用 `zsh -l -i -c 'printf %s "$PATH"'` 解析，在 GUI 应用最小 env 下复现，**输出里没有 `/usr/local/opt/node@20/bin`**（验证命令见 §5）：
   ```
   $ env -i HOME=$HOME SHELL=/bin/zsh PATH=/usr/bin:/bin:/usr/sbin:/sbin zsh -l -i -c 'printf %s "$PATH"' | tr ':' '\n' | grep node
   (空)
   ```
5. 兜底清单 `FALLBACK_PATH_ENTRIES` 只有 `/usr/local/bin`（里面没有 npx）和 `/opt/homebrew/bin`（Intel 机不存在）。

→ backend 进程 PATH 不含 node@20 bin → `spawn npx ENOENT` → skill 安装失败。

**为什么 Apple Silicon 上能用**：那台机器的 npx 在 `/opt/homebrew/bin/npx`（homebrew 标准符号链接，已在兜底清单里），与登录 shell 解析无关，所以前序修复在 Apple Silicon 上看起来生效，但并没有真正覆盖「keg-only node@XX」这一类场景。本机恰好是 keg-only + bash_profile 的组合，暴露了这个缺口。

## 4. 复现路径

1. 在 Intel x64 Mac 上，homebrew 安装 keg-only 的 node@XX（`brew install node@20`），且**没有**把 `/usr/local/opt/node@20/bin` 加进 zsh 的 `.zshrc`/`.zprofile`，只在 `.bash_profile` 里 export。
2. `make desktop-pack-mac-x64` 打包，启动 DeepThink.app。
3. 登录 → Skill 模块 → 搜索 `kill`（或任意 skill）→ 点击「安装」。
4. 前端弹「Failed to install skill」。

不熟悉代码的人也可用一行命令复现 backend 进程视角下的「找不到 npx」：

```bash
env -i HOME="$HOME" SHELL=/bin/zsh PATH=/usr/bin:/bin:/usr/sbin:/sbin \
  zsh -l -i -c 'command -v npx || echo "npx NOT FOUND"'
# 输出: npx NOT FOUND
```

## 5. 诊断方法

```bash
# 1) 确认 npx 真实位置（是否 keg-only / 有无标准 bin 符号链接）
which npx
ls -la /usr/local/bin/npx /opt/homebrew/bin/npx 2>&1

# 2) 确认 npx 的 PATH 来自哪里（应只命中 .bash_profile）
grep -rn "node@" ~/.bash_profile ~/.zshrc ~/.zprofile ~/.zshenv 2>/dev/null

# 3) 复现 GUI env 下 zsh 登录 shell 解析拿不到 node@20
env -i HOME="$HOME" SHELL=/bin/zsh PATH=/usr/bin:/bin:/usr/sbin:/sbin \
  zsh -l -i -c 'printf %s "$PATH"' | tr ':' '\n' | grep -i node || echo "node keg path MISSING"

# 4) 看打包后 backend 日志确认 ENOENT
tail -50 ~/Library/Application\ Support/DeepThink/logs/backend.log 2>/dev/null | grep -i npx
```

## 6. 修复方案

在 `desktop/src/backend-supervisor.ts` 的 `resolveBackendPath()` 合并清单中，增加「homebrew keg-only node 的 bin 目录」探测。这是 homebrew 的稳定约定：node / node@18 / node@20 / node@22 等的 bin 都在 `<prefix>/opt/node*/bin`，两个前缀分别是：

- `/usr/local/opt`（Intel homebrew）
- `/opt/homebrew/opt`（Apple Silicon homebrew）

```diff
+// Homebrew installs node (and versioned node@18/node@20/...) as *keg-only*:
+// the `npx`/`node`/`npm` binaries live in `<prefix>/opt/node@XX/bin` and are
+// NOT symlinked into `<prefix>/bin`. Some users only expose this path via
+// `~/.bash_profile`, which a zsh login shell — and macOS GUI apps — never
+// source. Probe both Homebrew prefixes for node keg `bin` dirs so backend
+// subprocesses (e.g. `npx skills add`) can find npx.
+function homebrewNodeKegBins(): string[] {
+  const dirs: string[] = [];
+  for (const prefix of ['/usr/local/opt', '/opt/homebrew/opt']) {
+    let entries: fs.Dirent[];
+    try {
+      entries = fs.readdirSync(prefix, { withFileTypes: true });
+    } catch {
+      continue; // prefix not present (e.g. /opt/homebrew on Intel)
+    }
+    for (const ent of entries) {
+      if (!ent.name.startsWith('node')) continue;
+      const binDir = `${prefix}/${ent.name}/bin`;
+      try {
+        // statSync follows the opt symlink, so it works for keg symlinks too.
+        if (fs.statSync(binDir).isDirectory()) dirs.push(binDir);
+      } catch {
+        // bin doesn't exist — skip this keg
+      }
+    }
+  }
+  return dirs;
+}
```

合并顺序：

```diff
-  for (const p of [...shellPath, ...inherited, ...FALLBACK_PATH_ENTRIES]) {
+  for (const p of [...shellPath, ...inherited, ...homebrewNodeKegBins(), ...FALLBACK_PATH_ENTRIES]) {
```

**选型理由**：

- **治本在 PATH 来源处**：与前序修复一致，仍在 `resolveBackendPath()`（backend 启动时跑一次，结果缓存）统一扩展 PATH，而非在 `installSkillForUser` 内打补丁，让未来其他 spawn npx/node/npm 的调用都受益。
- **不 source `.bash_profile`**：bash_profile 可能有副作用、输出污染 PATH，且 zsh 用户不该依赖它。直接探测 homebrew keg 约定更确定、更通用。
- **glob 而非硬编码版本**：`node*` 覆盖 `node` / `node@18` / `node@20` / `node@22` 等任意版本，不耦合具体版本号。
- **statSync 跟随 symlink**：`/usr/local/opt/node@20` 本身是 symlink 指向 `../Cellar/node@20/...`，`statSync` 跟随符号链接，readdir 出来的 Dirent 类型不可靠，所以用 statSync 确认 `bin` 是真目录。
- **不预设 nvm/asdf 路径**：仍交给登录 shell 解析（它们的 PATH 写在 zsh rc 文件里，zsh 登录 shell 能拿到）。

## 7. 处理卡住的状态（如适用）

无需救活运行态。已打包的旧版 DMG 仍报错，重新 `make desktop-pack-mac-x64` 打包后即可生效。

## 8. 经验沉淀 / 预防

1. **「在某架构上修复成功」不等于「所有架构都覆盖」**：前序修复在 Apple Silicon 上验证通过，是因为那台机器 npx 恰好在标准 homebrew 符号链接路径（兜底命中），并未真正覆盖 keg-only node 场景。跨架构/跨机器的 PATH 修复，应至少在两种 homebrew 前缀（`/usr/local` Intel、`/opt/homebrew` Apple Silicon）各验一次。
2. **keg-only 工具不会进 `<prefix>/bin`**：homebrew 对 `node@XX`、`python@XX` 等版本化公式默认 keg-only，不建符号链接。兜底 PATH 不能只放 `<prefix>/bin`，还要探测 `<prefix>/opt/<name>*/bin`。
3. **zsh 用户可能在 `.bash_profile` 维护 PATH**：这是 macOS 上一个隐蔽的「终端能用、GUI 不能用」陷阱。登录 shell 解析（zsh）天然漏掉 bash_profile。后续若再出现「终端 OK / GUI 报 ENOENT」类问题，第一步先 `grep -rn PATH ~/.bash_profile ~/.zshrc ~/.zprofile`，第二步用 `env -i ... zsh -l -i -c` 复现 GUI 视角。
4. **巡检脚本**（可加入打包前自检）：
   ```bash
   # 模拟 GUI env，确认修复后 backend 视角能找到 npx
   env -i HOME="$HOME" SHELL=/bin/zsh PATH=/usr/bin:/bin:/usr/sbin:/sbin \
     node -e "import('./desktop/dist/backend-supervisor.js').then(m=>{const e=m.resolveBackendPath?.()||require('./desktop/dist/backend-supervisor.js');console.log(process.env.PATH)})" 2>/dev/null || true
   ```
   或直接跑本仓库 `make desktop-build` 后用 `/tmp/dt-verify-path.mjs`（见提交记录）断言 `homebrewNodeKegBins()` 返回的 PATH 里能 `command -v npx`。
