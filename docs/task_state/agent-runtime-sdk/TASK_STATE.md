# 任务状态：agent-runtime-sdk（M0 = MVP 完整可用）

> 更新：2026-11-09。分支：`worktree-agent-runtime-sdk`（worktree：`.claude/worktrees/agent-runtime-sdk`）

## 当前阶段

✅ **M0 验收通过**（自动化门禁全绿 + TC-9.1 真实 API 走查 7/7，2026-11-09）。待合并 main（工作流步骤 6）。

### M0.2 交付（已提交 ef89d1b）

- `sdk/src/bundle.ts` 加载器（解包/校验/密钥解析，A6.3 显式报错）
- `sdk/src/runtime.ts` Agent/Session 核心（每回合 query() + resume 续接、消息排队不丢、interrupt 兜底为 error result）
- StreamEvent 流式映射（F4）；身份中性 systemPrompt（F8）
- `tests/agent-sdk-runtime.test.ts` 10/10（TC-3.1/3.2/3.3/3.4/4.1/8.1）

### M0.3 交付（已提交 f797c36）

- `sdk/src/tools.ts` 自包含工具包：web_fetch/web_search/disk_*/memory_*（路径穿越防护），`createToolsServer` 注册
- F5 skills 物化到 `{workspace}/.claude/skills/` + 白名单注入；F6 MCP stdio/http 装配
- web-search 第 5 同步源进 sdk/；`tests/agent-sdk-tools.test.ts` 11/11（TC-5.x/6.x/7.x）

### M0.4 交付

- ✅ `sdk/README.md`（安装/快速上手/能力分级/FAQ/Android 说明）
- ✅ `examples/quickstart/quickstart.mjs`（含错误处理示范）
- ✅ F10 回归：全量 vitest 2570 passed / 15 failed，失败集合与 main 纯净副本（git archive 8b5e477）逐条一致 → **零回归**（证据见 `docs/test_report/agent-runtime-sdk/TEST_REPORT.md` §4）
- ✅ 测试报告落盘

## TC-9.1 走查结果（2026-11-09，真实 LLM provider）

7/7 通过：流式单轮 / 多轮 context / skill 触发 / MCP 调用+密钥注入（token 注入证据）/ 跨进程 resume / 篡改检测 / 缺 secret 报错。证据见 `docs/test_report/agent-runtime-sdk/TEST_REPORT.md` §6。走查产物（quickstart/make-demo-bundle.ts fixture 生成器）已沉淀到 examples/quickstart/。

## 剩余

- [ ] 合并 worktree 分支到 main 并 push（工作流步骤 6，待用户确认后执行）

## 已完成

| 项 | 状态 | 产物 |
|---|---|---|
| 源码深度调研（4 专项） | ✅ | 结论沉淀进技术方案 §1 |
| 技术方案（含 bundle×Android 路径结论） | ✅ | `docs/tech_solution/agent-runtime-sdk/TECH_SOLUTION.md` |
| PRD（F1–F10、验收标准、TC 21 条） | ✅ | `docs/prd/agent-runtime-sdk/PRD.md` |
| **M0.1：AgentBundle 格式 v1（F1）** | ✅ | `shared/agent-bundle.ts`（第五同步源，manifest schema / 密钥脱敏 / 确定性 contentHash）；同步链已接 `scripts/sync-stream-event.sh` + check 脚本 |
| **M0.1：平台导出（F2）** | ✅ | `src/agent-bundle-export.ts`（资源本体内联 + env/header 全脱敏）；`POST /api/paas/agents/:id/export`（owner/admin 门禁）；AgentDetailPage「导出 SDK Bundle」按钮 + store `exportBundle` |
| **M0.1 测试（TC-1.x/TC-2.x）** | ✅ | `tests/agent-bundle-export.test.ts` 13/13 通过（结构/篡改检测/密钥脱敏/确定性/越权） |
| sdk/ 子项目骨架 | ✅ | `sdk/package.json`（SDK 版本锁定 0.3.311，不再 `"*"`）+ tsconfig |
| 三端 typecheck | ✅ | backend / web / agent-runner 全过 |

## 下一步（按 PRD §6 里程碑）

- [x] M0.1：AgentBundle 格式 v1（F1）+ 平台导出 API/按钮（F2）→ TC-1.x / TC-2.x ✅
- [ ] M0.2：SDK 核心（F3 会话/resume）+ 流式（F4）+ 身份中性（F8）→ TC-3.x / TC-4.x / TC-8.1
- [ ] M0.3：skills（F5）+ MCP（F6）+ 自包含工具（F7）→ TC-5.x / TC-6.x / TC-7.x
- [ ] M0.4：文档示例（F9）+ 回归（F10）→ 真人走查 → MVP 验收 → 测试报告

## 环境备注（本机 Windows）

- 测试/类型检查用 PATH Node 24 直调：`node node_modules/vitest/vitest.mjs run <file>`、`node node_modules/typescript/bin/tsc --noEmit`。**不要**用 `npx`（会踩 ABI/解析坑）。
- better-sqlite3 现按 Node 24（ABI 137）编译，Node 22（桌面版自带）反而加载不了——与旧记忆相反。
- worktree 三处 node_modules 用 PowerShell `New-Item -ItemType Junction` 链接到主 checkout。

## 风险跟踪

- Claude Agent SDK 版本漂移 → sdk/ 内 semver 锁定 0.3.311（M0.1 起生效）
- 密钥进包 → 导出脱敏 + TC-1.3 全文扫描（M0.1 已覆盖）
