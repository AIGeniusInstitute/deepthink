# 测试报告 — DeepThink 桌面版 Skill 安装失败修复（npx PATH 缺失）

## 修复摘要

- **Bug**：DeepThink 桌面版（DMG）搜索到 skill 后点击「安装」依然报 `Failed to install skill`，上一次 `fix/skill-install-failure`（happyclaw 主项目的 `CLAUDE_CONFIG_DIR` 修复）不覆盖桌面应用场景。
- **根因**：macOS Electron GUI 启动时不加载 shell profile（`.zshrc`/`.zprofile`），父进程 PATH 仅为 `/usr/bin:/bin:/usr/sbin:/sbin`，**不含 `/opt/homebrew/bin`、nvm、asdf、volta 等用户工具路径**。`desktop/src/backend-supervisor.ts` 的 `buildEnv()` 没扩展 PATH，导致 backend 进程内 `installSkillForUser()` → `execFile('npx', ...)` 抛 `spawn npx ENOENT`，前端弹 `Failed to install skill`。
- **修复**：`desktop/src/backend-supervisor.ts` 的 `buildEnv()` 新增 `PATH: resolveBackendPath()`，启动时一次性合并登录 shell PATH + 当前 PATH + 兜底路径（`/opt/homebrew/bin` 等），让 backend 能找到 `npx`。

## 修改清单

| 文件 | 改动 |
|------|------|
| `desktop/src/backend-supervisor.ts` | `buildEnv()` 新增 `PATH: resolveBackendPath()`；class 后新增模块级 `resolveBackendPath()` 函数、`FALLBACK_PATH_ENTRIES` 常量、`cachedBackendPath` 缓存 |

无其他文件改动。

## 验证方法

`cloudcli-browser` MCP 不可用 + 本机 `github.com` 端到端网络不通（`curl https://github.com` 443 超时），无法走 UI 真实端到端。改用「lldb 直读进程 env + 隔离对照实验 + typecheck + build」组合验证。

### 1. 现场 env 证据（lldb 直读 DeepThink backend 进程 11395）

```
$ lldb -p 11395 -o 'expr (char*)getenv("PATH")' -o 'quit'
(char *) $0 = "/usr/bin:/bin:/usr/sbin:/sbin"      ← 缺 homebrew
```

`npx` 实测位置：`/opt/homebrew/bin/npx`，不在 backend PATH 中。

### 2. 对照实验：修复前 PATH 直接 spawn `npx skills add`

`/tmp/dt-npx-spawn-test.mjs`（已清理）用本地 mock git repo + `file://` URL 绕过 github.com 网络依赖，复刻 DeepThink backend 进程的环境，分别用「修复前 PATH」和「修复后 PATH（含 resolveBackendPath 输出）」调用 `npx -y skills add ...`：

| 场景 | npx exit | npx error | tempHome 内容 | SKILL.md |
|------|---------|-----------|--------------|----------|
| 修复前 PATH=`/usr/bin:/bin:/usr/sbin:/sbin` | null | **ENOENT** | [] | - |
| 修复后 PATH 含 `/opt/homebrew/bin` 等 | 0 | (none) | [pptx] | exists ✅ |

→ **修复点完全验证**：修复前 `spawn npx ENOENT`，修复后 npx 成功拉取 skills CLI 并把 skill 装到 tempHome（且不污染真实 `~/.claude/skills/`，因为 happyclaw 上次修复同时覆盖了 `CLAUDE_CONFIG_DIR`）。

### 3. 复现用户原 bug 的隔离实验

用 DeepThink bundle 内的 `installSkillForUser` + 修复前 PATH 直接调用：

```
$ node -e "...process.env.PATH='/usr/bin:/bin:/usr/sbin:/sbin'; installSkillForUser(uid,'anthropics/skills@pptx')"
[result] { "success": false, "error": "spawn npx ENOENT" }
```

→ **复现用户原 bug**：DeepThink 后端在 GUI 启动时 spawn npx ENOENT，被 `installSkillForUser` catch 块返回 `{success:false, error:"spawn npx ENOENT"}` → HTTP 500 → 前端 "Failed to install skill"。

### 4. TypeScript 全量类型检查

```
$ make typecheck
All shared type copies are in sync.
✓ All 9 prompt references resolved
```

→ 三端类型检查通过。

### 5. desktop 项目独立 typecheck + build

```
$ cd desktop && npx tsc --noEmit    # 静默通过
$ make desktop-build
cd desktop && npm run build
> tsc                                # 通过
```

→ desktop 项目 TypeScript 编译通过，`resolveBackendPath` 函数 / `FALLBACK_PATH_ENTRIES` / `cachedBackendPath` 都正确编译。

### 6. resolveBackendPath 实际输出验证

对照实验中 `resolveBackendPath()` 返回的 PATH（节选）：

```
/Users/xingzhi/.local/bin:/opt/homebrew/bin:/opt/homebrew/sbin:/Library/Frameworks/Python.framework/Versions/3.14/bin:/usr/local/bin:...:/usr/local/sbin
```

→ 包含 `/opt/homebrew/bin`（npx 实际位置），合并去重生效。

## 已知遗留

### 桌面 DMG 端到端 UI 验证

本次只做了隔离实验验证修复点。桌面 DMG 完整 UI 流程（搜索 → 点击安装 → 弹绿色成功提示）需要用户在新打包 DMG 后实测确认。建议步骤：

1. 在 `~/deep-think` 仓库根目录跑 `make desktop-pack-mac` 重新打包 DMG。
2. 安装新 DMG 并启动 DeepThink 应用。
3. 进 Skills 页面，搜索 `pptx`，点击任一结果「安装」按钮。
4. 期望：弹绿色「安装成功」提示，`~/Library/Application Support/DeepThink/data/skills/{userId}/` 出现对应 skill。

### github.com 端到端网络

本机当前 `https://github.com` 443 超时，无法用真实的 `anthropics/skills@pptx` 跑完整 `npx skills add`（skills CLI 内部 clone github 仓库会失败）。修复点用本地 mock git repo + `file://` URL 隔离验证。等 github.com 网络恢复后，用户在新打包 DMG 中实测即可走完整端到端。

## 退出条件达成

| 条件 | 状态 |
|------|------|
| `make typecheck` 通过 | ✅ |
| `make desktop-build` 通过 | ✅ |
| 隔离实验复现原 bug（修复前 `spawn npx ENOENT`） | ✅ |
| 隔离实验验证修复点（修复后 `npx exit 0` + skill 装到 tempHome） | ✅ |
| `resolveBackendPath()` 输出含 `/opt/homebrew/bin` | ✅ |
| 测试报告写入 `docs/test_report/desktop-skill-install-npx-path/TEST-REPORT.md` | ✅ |
| 桌面 DMG 端到端 UI 验证 | ⏳ 由用户在新打包后实测 |

**结论**：修复完成。根因诊断有 lldb 直读 env + 隔离实验双重证据，修复点通过对照实验（修复前 ENOENT / 修复后 success）验证。类型检查与 desktop 构建全部通过。桌面 DMG 端到端 UI 验证留给用户在新打包后实测。
