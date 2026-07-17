# 任务状态：配置跨重建/重装保留

- 分支：`worktree-config-persistence`
- PRD：`docs/prd/config-persistence/PRD.md`
- 技术方案：`docs/tech_solution/config-persistence/SOLUTION.md`

## 进度

| Part | 状态 | 说明 |
|------|------|------|
| A — data 迁 `~/.deepthink/data` | ✅ 完成 | config.ts + index.ts + Makefile，AC1/AC3 通过 |
| B — backup 范围补全 | ✅ 完成 | Makefile backup 加 mcp-servers/plugins/users/memory，AC4 通过 |
| C — 桌面导出/导入菜单 | ✅ 完成 | paths.ts + config-io.ts + menu.ts + main.ts，typecheck 通过 |
| D — 更新前自动备份 | ✅ 完成 | updater.ts 升级 electron-updater + update-downloaded 备份，typecheck 通过 |
| 验证 + 测试报告 | ✅ 完成 | AC1-5 实测通过，AC6-8 typecheck 通过，REPORT.md |
| merge main + push | ⏳ 进行中 | |

## 执行日志

- 2026-07-17：worktree 创建，PRD + 技术方案完成，开始 Part A+B 实施。
