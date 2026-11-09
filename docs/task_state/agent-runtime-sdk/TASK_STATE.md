# 任务状态：agent-runtime-sdk（M0 = MVP 完整可用）

> 更新：2026-11-09。分支：`worktree-agent-runtime-sdk`（worktree：`.claude/worktrees/agent-runtime-sdk`）

## 当前阶段

✅ **立项完成** —— PRD / 技术方案已落盘，进入 M0.1 编码实施前。

## 已完成

| 项 | 状态 | 产物 |
|---|---|---|
| 源码深度调研（4 专项：AaaS 链路 / agent-runner 依赖面 / agent 定义打包 / 打包先例） | ✅ | 结论沉淀进技术方案 §1 |
| 技术方案 | ✅ | `docs/tech_solution/agent-runtime-sdk/TECH_SOLUTION.md` |
| PRD（含功能点 F1–F10、验收标准、测试用例 TC 21 条） | ✅ | `docs/prd/agent-runtime-sdk/PRD.md` |
| worktree + 分支 | ✅ | `worktree-agent-runtime-sdk` |

## 下一步（按 PRD §6 里程碑）

- [ ] M0.1：AgentBundle 格式 v1（F1）+ 平台导出 API/按钮（F2）→ TC-1.x / TC-2.x
- [ ] M0.2：SDK 核心（F3 会话/resume）+ 流式（F4）+ 身份中性（F8）→ TC-3.x / TC-4.x / TC-8.1
- [ ] M0.3：skills（F5）+ MCP（F6）+ 自包含工具（F7）→ TC-5.x / TC-6.x / TC-7.x
- [ ] M0.4：文档示例（F9）+ 回归（F10）→ 真人走查 → MVP 验收 → 测试报告

## 风险跟踪

- Claude Agent SDK 版本漂移 → sdk/ 内 semver 锁定（M0.2 起生效）
- 密钥进包 → 导出脱敏 + TC-1.3 全文扫描（M0.1 起生效）
