# 技术方案 — DeepThink 桌面版 Skill 安装失败修复（npx PATH 缺失）

## 问题定位

### 现场

DeepThink backend 进程 (pid 11395) 实测环境变量（lldb 读取）：

```
PATH = /usr/bin:/bin:/usr/sbin:/sbin
HOME = /Users/xingzhi
DEEPTHINK_DATA_DIR = /Users/xingzhi/Library/Application Support/DeepThink/data  (完整未截断)
```

`npx` 实际位置：`/opt/homebrew/bin/npx`（Apple Silicon homebrew 默认安装路径），不在 PATH 中。

### 隔离复现

用相同 PATH 调用 `installSkillForUser()`（来自 DeepThink bundle）：

```
$ node /tmp/dt-real-repro.mjs
[setup] userDir= /Users/xingzhi/Library/Application Support/DeepThink/data/skills/921b4c78-00cc-4bf7-9c3a-1aed54c612cc
[setup] npx= NOT FOUND
[result] { "success": false, "error": "spawn npx ENOENT" }
```

→ 复现用户看到的 `Failed to install skill`。后端日志没记到，是因为 `installSkillForUser()` 的 catch 块返回错误对象但没主动 `logger.error`，前端凭 HTTP 500 渲染错误。

### 根因

macOS Electron GUI 应用启动时不加载 shell profile（`.zshrc` / `.zprofile` / `.bashrc`），父进程 PATH 为系统默认的 4 路径，不包含 homebrew、nvm、asdf、volta 等用户级工具路径。

`desktop/src/backend-supervisor.ts` 的 `buildEnv()` 只补充了 DeepThink 自有变量，没扩展 PATH，spawn backend 进程时 `{ ...process.env, ...env }` 继承的 PATH 仍是缺工具的版本。

### 调用链

```
macOS GUI 启动 electron (PATH=/usr/bin:/bin:/usr/sbin:/sbin)
  → desktop/src/backend-supervisor.ts: spawn(nodeBinary, [backendEntry], env={...process.env, ...env})
    → backend process (PATH 仍为 /usr/bin:/bin:/usr/sbin:/sbin)
      → src/routes/skills.ts:installSkillForUser() → execFile('npx', [...])
        → spawn npx ENOENT (npx 不在 PATH)
          → catch 块返回 { success: false, error: "spawn npx ENOENT" }
            → HTTP 500 + { error: "Failed to install skill", details: "spawn npx ENOENT" }
              → 前端弹 "Failed to install skill"
```

## 修复方案

### 主修改：扩展 backend 进程 PATH

`desktop/src/backend-supervisor.ts` 的 `buildEnv()` 中扩展 PATH：

1. **优先**用登录 shell 解析用户真实 PATH（`$SHELL -l -c 'printf "%s" "$PATH"'`）。
2. **合并**用户登录 shell PATH + 当前 `process.env.PATH` + 常见 macOS/Linux 工具路径作为兜底。
3. 登录 shell 解析失败时，仅用兜底路径合并当前 PATH（保证不破坏原有路径）。

### 兜底路径清单

- `/opt/homebrew/bin` — Apple Silicon homebrew
- `/usr/local/bin` — Intel homebrew 或手动安装的 node
- `${HOME}/.local/bin` — pip --user、cargo install 等通用用户级 bin

不预设 nvm/asdf 路径（位置依赖版本号，不稳定）；登录 shell 解析能覆盖这些场景。

### 实现要点

- 在 buildEnv 内合并 PATH，**不在 installSkillForUser 内做**：根因在桌面应用 backend 进程的 PATH 缺失，治本应在 PATH 来源处修复；同时让未来其他需要外部命令的 spawn 调用也受益。
- 解析登录 shell PATH 只在 backend 启动时跑一次（`buildEnv()` 在 `start()` 中调用一次），开销可接受（< 1s）。
- 用 `execFileSync` 同步调用 shell 解析 PATH，避免 startup race。
- 失败时静默 fallback 到兜底路径，不抛错。

### 不改的部分

1. **`src/routes/skills.ts`**：happyclaw 主项目从终端启动时 PATH 已完整，不受影响；DeepThink bundle 也走同文件编译产物，但 backend 进程 PATH 修好后就能正常 spawn npx。
2. **`installSkillForUser` 内部**：不增加 PATH 处理逻辑，避免双重修复。
3. **前端 SkillsPage**：错误展示逻辑不变。
4. **backend-supervisor 的其他 env 字段**：不动。

### 副作用分析

- backend 进程的 PATH 变长 → 子进程可见更多命令 → 正向修复（不影响已有行为）。
- 登录 shell 解析会加载 `.zshrc`，理论上可能引入 PATH 之外的 env 变量泄漏？不会 — `execFileSync(shell, ['-l', '-c', 'printf "%s" "$PATH"'])` 只输出 PATH，子进程不继承解析过程的 env。
- 启动慢一点（< 1s 解析 shell），用户感知不到。

## 验证策略

### 1. 单元层（buildEnv 输出 PATH）

- 写隔离脚本 import `desktop/dist/backend-supervisor.js`，调用 `buildEnv()`，断言返回的 `PATH` 包含 `/opt/homebrew/bin` 且非空。

### 2. 集成层（真实 installSkillForUser）

- 用修复后的 backend env 启动 DeepThink backend 进程，curl `POST /api/skills/install` 真实调用（package=`anthropics/skills@pptx`），断言返回 200 + success。
- 断言 `data/skills/{userId}/pptx/SKILL.md` 存在。

### 3. 桌面端到端（用户视角）

- 重新打包 DMG，启动应用，搜索 `pptx`，点击「安装」按钮，断言弹绿色成功提示。
- 受限于本会话无 GUI 自动化能力，由用户在新打包后实测确认。

### 4. 类型检查 + 构建

- `make typecheck`、`make desktop-build` 通过。

## 退出条件

1. `make typecheck` 通过。
2. `make desktop-build` 通过。
3. 隔离脚本断言 `buildEnv()` 返回的 PATH 包含 `/opt/homebrew/bin`。
4. 用修复后 env 跑 `installSkillForUser('anthropics/skills@pptx')` 返回 `{ success: true, installed: ['pptx'] }`。
5. skill 实际落到用户级目录 `data/skills/{userId}/pptx/SKILL.md`。
6. 测试报告写入 `docs/test_report/desktop-skill-install-npx-path/TEST-REPORT.md`。

桌面 DMG 端到端 UI 验证由用户在新打包后实测，作为最终验收。
