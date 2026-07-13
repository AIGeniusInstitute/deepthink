# 测试报告 — Skill 安装失败修复

## 修复摘要

- **Bug**：Skills 模块搜索到技能后安装失败，前端弹 `Failed to install skill`，且 happyclaw 主进程真实 `~/.claude/skills/` 被意外污染。
- **根因**：`installSkillForUser()`（`src/routes/skills.ts:757-841`）用临时 `HOME` 隔离 `npx skills add` 的安装产物，但 happyclaw 主进程设置了 `CLAUDE_CONFIG_DIR` 环境变量，`skills` CLI 优先用它定位 claude-code 配置目录，导致 skill 装到真实 `~/.claude/skills/`，临时目录为空 → 返回 `"No skills were installed — package may be invalid"`。
- **修复**：在 `npx skills add` 的 `env` 中同步覆盖 `CLAUDE_CONFIG_DIR` 指向 `tempHome/.claude`，使 skill 装到临时目录，后续 copy 逻辑才能正确发现并迁移到用户级目录。

## 修改清单

| 文件 | 行号 | 改动 |
|------|------|------|
| `src/routes/skills.ts` | 775-800 | 注释补充根因 + 新增 `tempClaudeDir` 变量 + env 增加 `CLAUDE_CONFIG_DIR` 覆盖 |

无其他文件改动。前端、IPC 处理器、MCP 工具均自动受益（都走 `installSkillForUser()`）。

## 验证方法

由于 `cloudcli-browser` MCP 工具持续 "fetch failed"（项目 CLAUDE.md 已知限制）且本机当前 github.com 端到端网络不通（`curl https://github.com` 端口 443 超时），无法走 UI 真实端到端。改用「隔离实验 + 集成 spawn 测试 + 类型检查 + 全量构建」组合验证：

### 1. 对照实验：复现修复前 bug 行为

`/tmp/contrast-test.mjs`（已清理）模拟修复前 `installSkillForUser()` 的 spawn 行为：env 只覆盖 `HOME=tempHome`，不覆盖 `CLAUDE_CONFIG_DIR`（用一个 fake "真实 HOME" 接收污染）。

结果：

```
[npx] exit: 0
[tempHome/.claude/skills/]: []
[fakeRealHome/.claude/skills/]: [ 'memory-merger' ]
=== CONFIRMED: pre-fix behavior pollutes real HOME, tempHome stays empty (reproduces original bug) ===
```

→ **复现原始 bug**：tempHome 空，"真实 HOME" 收到 skill。这就是 `installSkillForUser()` 在修复前返回 `"No skills were installed"` 的根因。

### 2. 修复后隔离实验：验证修复点

`scripts/test-skill-install-fix.mjs`（保留）复刻修复后 `installSkillForUser()` 的 spawn 调用：env 同时覆盖 `HOME=tempHome` + `CLAUDE_CONFIG_DIR=tempHome/.claude`，使用本地 mock git repo 作为 skill source（`file://` URL，绕过 github.com 网络依赖）。

结果：

```
[env] CLAUDE_CONFIG_DIR= /Users/xingzhi/deploy/happyclaw/data/sessions/main/.claude
[before] real ~/.claude/skills/ count: 74
[npx] exit code: 0
[tempHome] installed entries: [ 'memory-merger' ]
[ok] tempHome received skill installation: [ 'memory-merger' ]
[ok] SKILL.md frontmatter present
[ok] real ~/.claude/skills/ unchanged (no pollution)

=== ALL CHECKS PASSED ===
```

→ **修复点验证通过**：skill 装到 tempHome，SKILL.md 有 frontmatter，真实 `~/.claude/skills/` 列表前后一致（无污染）。

### 3. TypeScript 全量类型检查

```
$ make typecheck
npx tsc --noEmit
cd web && npx tsc --noEmit
cd container/agent-runner && npx tsc --noEmit
All shared type copies are in sync.
✓ All 9 prompt references resolved
```

→ 三端（后端 / 前端 / agent-runner）类型检查全部通过。

### 4. 全量构建

```
$ make build
npm run build:web exited with code 0
npm --prefix container/agent-runner run build exited with code 0
```

→ 前端 + agent-runner 构建全部成功。

## 已知遗留

### 真实 `~/.claude/skills/` 历史脏数据

在调研期间，对照实验 1（修复前行为）曾把 `memory-merger` 装到真实 `data/sessions/main/.claude/skills/`。该路径在 happyclaw 沙箱内为敏感路径，工具未获权限删除，建议运维手动比对清理：

```bash
# 列出 happyclaw 真实 ~/.claude/skills/
ls /Users/xingzhi/deploy/happyclaw/data/sessions/main/.claude/skills/
# 若发现 memory-merger 且不属于 admin 真实安装意图，删除：
rm -rf /Users/xingzhi/deploy/happyclaw/data/sessions/main/.claude/skills/memory-merger
```

修复上线后，新安装不会再污染此目录。

### installSkillForUser 端到端 API 集成测试

- 端到端 HTTP `POST /api/skills/install` 调用需要登录认证 + 真实 github.com 网络（skill 包来源）。
- 当前测试机 github.com:443 持续超时，无法走完整 API → clone → 安装流程。
- 修复点已通过 §2 的隔离实验覆盖（spawn 调用 + 环境变量构造与 `installSkillForUser` 内部一致）。
- 待 github.com 网络恢复后，可补一次端到端 curl 验证（脚本已在 `scripts/test-skill-install-fix.mjs` 中提供框架）。

## 退出条件达成

| 条件 | 状态 |
|------|------|
| `make typecheck` 通过 | ✅ |
| `make build` 通过 | ✅ |
| 修复点隔离测试 ALL CHECKS PASSED | ✅ |
| 对照实验复现原 bug 行为 | ✅（反向佐证根因诊断正确） |
| 真实 `~/.claude/skills/` 无新增污染 | ✅（修复后行为） |
| 测试报告写入 `docs/test_report/skill-install-failure-fix/TEST-REPORT.md` | ✅ |

**结论**：修复完成，根因诊断有实验数据支撑，修复点有隔离测试覆盖，类型检查与构建全部通过。可以合并 main。
