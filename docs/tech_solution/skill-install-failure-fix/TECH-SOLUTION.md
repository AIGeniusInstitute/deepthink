# 技术方案 — Skill 安装失败修复

## 问题定位

### 现场数据

happyclaw 主进程环境：

```
CLAUDE_CONFIG_DIR=/Users/xingzhi/deploy/happyclaw/data/sessions/main/.claude
HOME=/Users/xingzhi/deploy/happyclaw/data/sessions/main
```

`skills` CLI 通过 `CLAUDE_CONFIG_DIR` 优先于 `HOME` 来定位 claude-code 的配置目录。这一点在以下实验中验证：

#### 实验 1：仅覆盖 HOME（当前代码行为）

```
tempHome=$(mktemp -d)
mkdir -p "$tempHome/.claude/skills"
HOME="$tempHome" npx -y skills add "github/awesome-copilot@memory-merger" --global --yes -a claude-code
```

输出（节选）：

```
✓ memory-merger (copied)
  → /Users/xingzhi/deploy/happyclaw/data/sessions/main/.claude/skills/memory-merger
```

`tempHome/.claude/skills/` 为空；真实 `~/.claude/skills/memory-merger` 被创建 → `installSkillForUser()` 扫 tempHome 找不到任何目录 → 返回 "No skills were installed — package may be invalid" → HTTP 500 → 前端 "Failed to install skill"。

#### 实验 2：同时覆盖 CLAUDE_CONFIG_DIR

```
HOME="$tempHome" CLAUDE_CONFIG_DIR="$tempHome/.claude" npx -y skills add "github/awesome-copilot@memory-merger" --global --yes -a claude-code
```

输出：

```
✓ memory-merger (copied)
  → ~/.claude/skills/memory-merger
```

`tempHome/.claude/skills/memory-merger` 出现；真实 `~/.claude/skills/` 未被污染 → 验证修复有效。

### 涉及代码

- `src/routes/skills.ts:757-841` — `installSkillForUser()` 函数。
- `src/routes/skills.ts:847-862` — HTTP 路由 `POST /api/skills/install`。
- `src/index.ts:6480-6552` — IPC 处理器 `install_skill`，同样调用 `installSkillForUser()`，修复后自动受益。

## 修复方案

### 主修改：覆盖 CLAUDE_CONFIG_DIR

`src/routes/skills.ts` 中 `installSkillForUser()` 的 `npx skills add` 调用，把环境变量从：

```ts
env: { ...process.env, HOME: tempHome },
```

改为：

```ts
env: { ...process.env, HOME: tempHome, CLAUDE_CONFIG_DIR: path.join(tempHome, '.claude') },
```

这样 `skills` CLI 在解析 claude-code 配置目录时，会优先用我们指定的 tempHome 内路径，skill 内容装到 `tempHome/.claude/skills/<name>/`，后续扫描逻辑（`src/routes/skills.ts:794-802`）就能正确发现并 copy 到用户级目录。

### 不改的部分

1. **`uninstall_skill` 路径**：`uninstallSkillForUser()` 直接操作用户级目录，不调 `npx`，不受影响。
2. **search 路径**：`searchSkillsApi()` 调的是 `https://skills.sh/api/search`，与 `CLAUDE_CONFIG_DIR` 无关。
3. **MCP IPC 流程**：`src/index.ts` 的 IPC 处理器只是包装 `installSkillForUser()`，自动获得修复。
4. **前端 SkillsPage**：错误展示逻辑不变，因为后端会返回 success。

### 副作用分析

- `CLAUDE_CONFIG_DIR` 指向 tempHome 内的新空目录，`skills` CLI 内部若有读取其他 Claude 配置（如 `settings.json`、`creds.json`）的行为，会读到空目录而读不到数据。但这些数据对 `skills add --global --yes -a claude-code` 的安装流程非必需（实验已证明可成功安装）。如果未来 `skills` CLI 升级后强依赖这些文件，会以错误形式暴露，到时再处理。
- tempHome 在 `finally` 块中已用 `fs.rmSync(tempHome, { recursive: true, force: true })` 清理，覆盖 `CLAUDE_CONFIG_DIR` 不会引入残留。

## 验证策略

### 单元层（无需新增测试）

- 现有约束测试集不覆盖 `skills.ts` 的安装逻辑（这个文件没有对应 `tests/units/*.test.ts`）。本次修改范围小（一行环境变量），由以下集成验证 + 真实 API 调用保证：

### 集成层

1. **后端 API 直接 curl**：登录后调用 `POST /api/skills/install`，验证返回 200 + `{ success: true, installed: [...] }`。
2. **真实 skills.sh package**：使用搜索结果 `github/awesome-copilot@memory-merger` 作为入参。
3. **副作用断言**：在调用前后扫描 `data/sessions/main/.claude/skills/` 目录列表，断言没有新增子目录。

### 端到端层

- 浏览器 UI E2E 受限于 `cloudcli-browser` MCP 工具持续 "fetch failed"（项目 CLAUDE.md 已知限制），用「typecheck + build + 后端 curl + 文件系统断言」替代。

## 退出条件

满足以下全部条件后视为修复完成：

1. `make typecheck` 通过。
2. `make build` 通过。
3. 真实 `POST /api/skills/install` 调用（package=`github/awesome-copilot@memory-merger`）返回 200 + `{ success: true, installed: ['memory-merger'] }`。
4. 调用后 `data/skills/{userId}/memory-merger/SKILL.md` 存在。
5. 调用前后 `data/sessions/main/.claude/skills/` 子目录列表一致（无新增）。
6. 测试报告写入 `docs/test_report/skill-install-failure-fix/TEST-REPORT.md`。
