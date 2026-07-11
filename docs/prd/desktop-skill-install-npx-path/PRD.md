# PRD — DeepThink 桌面版 Skill 安装失败修复（npx PATH 缺失）

## 背景

上一次修复（`fix/skill-install-failure`）针对 happyclaw 主项目的 `installSkillForUser()` 中 `CLAUDE_CONFIG_DIR` 未覆盖的问题，已合并 main。

但用户在飞书反馈：重新打包 DeepThink DMG 后，在本机打开应用、搜索 `pptx`、点击「安装」按钮，依然报错：

> 安装失败 / Failed to install skill

并附上截图。说明 happyclaw 主项目的修复不覆盖 DeepThink 桌面应用场景。

## 用户现象

1. 用户在 macOS 上启动 DeepThink DMG 桌面应用。
2. 进 Web 界面 Skills 页面，搜索 `pptx`，搜索结果列表正常显示。
3. 点击某条结果的「安装」按钮。
4. 弹红色错误：`Failed to install skill`。
5. 用户级 skill 目录（`data/skills/{userId}/`）没有任何新增内容。

## 问题描述

通过本机 DeepThink 应用日志定位：

```
$ ls "/Users/xingzhi/Library/Application Support/DeepThink/logs/"
backend.log  main.log
```

backend.log 在用户操作时间段（2026-07-12 03:30 附近）没有任何 skill install 相关记录，说明请求要么没到后端、要么后端 logger 没记录到这条路径的错误。

通过 lldb 直读 DeepThink backend 进程 (pid 11395) 的环境变量，确认：

```
PATH = /usr/bin:/bin:/usr/sbin:/sbin
```

而 `npx` 位于 `/opt/homebrew/bin/npx`（不在 PATH 中）。

调用 `installSkillForUser()` 直接复现：

```
$ node -e "...process.env.PATH = '/usr/bin:/bin:/usr/sbin:/sbin'; installSkillForUser(userId, 'anthropics/skills@pptx')"
[result] { "success": false, "error": "spawn npx ENOENT" }
```

`installSkillForUser()` 通过 `execFile('npx', ...)` 调用 npx，PATH 不含 npx 所在目录 → spawn ENOENT → catch 块返回 `{ success: false, error: "spawn npx ENOENT" }` → HTTP 路由 `/api/skills/install` 返回 500 + `{ error: "Failed to install skill", details: "spawn npx ENOENT" }` → 前端弹 "Failed to install skill"。

## 根因

macOS Electron GUI 应用启动时不加载用户 shell profile（`.zshrc`/`.zprofile`），父进程 PATH 为系统默认的 `/usr/bin:/bin:/usr/sbin:/sbin`，**不包含** `/opt/homebrew/bin`、`~/.nvm/versions/node/vX/bin`、`~/.local/bin` 等用户级工具路径。

`desktop/src/backend-supervisor.ts:50-64` 的 `buildEnv()` 返回 env 时只补充了 DeepThink 自有变量，没有扩展 PATH。`spawn(nodeBinary, [backendEntry], { env: { ...process.env, ...env } })` 继承的父 PATH 仍是缺工具的版本，导致 backend 进程内所有 `npx` / `node` / `npm` 等子进程调用都受影响。

实际触发场景：
- `src/routes/skills.ts:installSkillForUser()` 调 `npx -y skills add ...` → spawn ENOENT
- 不影响其他不需要外部命令的功能（容器内已有内置 `claude-code` CLI，不依赖外部 PATH）

## 影响

- **功能**：DeepThink 桌面版 Skills 模块安装流程完全不可用。
- **范围**：所有 macOS 用户（homebrew 安装 node/npx 的用户占多数）。
- **可用性**：搜索功能不受影响（只调外部 HTTP API），但所有「安装」按钮都报错。

## 修复范围

- `desktop/src/backend-supervisor.ts`：`buildEnv()` 扩展 PATH，合并常见 macOS/Linux 工具路径 + 用户登录 shell PATH（一次性解析，启动时只跑一次）。
- 不改 `src/routes/skills.ts`（happyclaw 主项目从终端启动时 PATH 已完整，不受此 bug 影响）。
- 不改前端、不改 IPC 处理器、不改 MCP 工具。

## 验收标准

1. 用修复后的代码重新打包 DMG，启动应用。
2. 在 Skills 页面搜索 `pptx`，点击任一结果的「安装」按钮。
3. 期望：
   - 弹绿色「安装成功」提示。
   - `~/Library/Application Support/DeepThink/data/skills/{userId}/` 出现对应 skill 子目录。
4. 后端 backend.log 不再出现 `spawn npx ENOENT`。
5. 后端进程的 `PATH` 环境变量包含 `/opt/homebrew/bin`（或用户登录 shell 的 PATH）。

## 非目标

- 不改 happyclaw 主项目（终端启动模式 PATH 已对）。
- 不修复 host preflight 中 `claude-code not found` / `feishu-cli not found` 等其他告警（不影响 skill 安装）。
- 不重构 `installSkillForUser()` 的 npx 调用方式（继续用 `npx -y` 拉取 skills CLI）。
