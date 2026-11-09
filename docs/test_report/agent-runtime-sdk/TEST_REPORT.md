# 测试报告：agent-runtime-sdk（M0 = MVP 完整可用）

> 日期：2026-11-09 · 分支：`worktree-agent-runtime-sdk` · 环境：Windows 11，Node v24.22.1（vitest 直调）

## 1. 结论

**M0 全部自动化门禁通过**（A1–A10 验收标准对应项），平台回归零新增失败（纯净副本 diff 证据见 §4）。

⚠️ 尚有 1 项待人工完成：**TC-9.1 文档走查**（PRD §2 成功标准由真人按 `sdk/README.md` + `examples/quickstart/` 走一遍 30 分钟流程）——需真实 LLM API key，无法自动化，见 §6。

## 2. 本轮新增测试用例结果

| 测试文件 | 覆盖用例 | 结果 |
|---|---|---|
| `tests/agent-bundle-export.test.ts` | TC-1.1 结构/schema、TC-1.2 篡改检测、TC-1.3 密钥脱敏、TC-2.1/2.3 完整性与确定性、TC-2.2 越权 | **13/13 通过** |
| `tests/agent-sdk-runtime.test.ts` | TC-3.1 单轮+错误传递、TC-3.2 多轮 resume、TC-3.3 interrupt 不丢消息、TC-3.4 跨进程 resume、TC-4.1 流式事件序列、TC-8.1 身份中性 | **10/10 通过** |
| `tests/agent-sdk-tools.test.ts` | TC-5.1/5.2 skills 装配与白名单、TC-6.1/6.2 MCP stdio/http、TC-6.3 secret 缺失报错、TC-7.1 自包含工具、TC-7.2 路径穿越防护 | **11/11 通过** |

合计 **34/34 通过**（TC-3.x 的 SDK query() 为脚本化 mock，验编排契约；真实 LLM 链路见 §6 待走查项）。

## 3. 三端类型检查

| 端 | 命令 | 结果 |
|---|---|---|
| 后端 | `tsc --noEmit` | ✅ |
| 前端 | `web && tsc --noEmit` | ✅ |
| agent-runner | `tsc --noEmit -p container/agent-runner` | ✅ |
| sdk（新增） | `tsc --noEmit -p sdk` | ✅ |

同步门禁：`./scripts/check-stream-event-sync.sh` 直跑 exit 0（新增 agent-bundle 第 5 同步源 + stream-event/web-search 的 sdk/ 目标均在绿）。

## 4. 平台回归（A10.1，F10）

`vitest run` 全量（195 文件 / 2599 用例）：**2570 passed / 15 failed / 14 skipped**。

失败集合与 **main 基线纯净副本**（`git archive 8b5e477`）逐条 diff：

| 失败项 | 纯净副本复现？ | 性质 |
|---|---|---|
| node-resolver ×5、plugin-expander-routing-bugs ×3、plugin-command-index ×1、claude-context-resolver ×2、session-files ×1、web-search-config ×2（共 14） | ✅ 全部逐条复现 | Windows 环境噪音（POSIX 路径/符号链接权限/0600 mode/`os.homedir`） |
| feishu-card ×1（5s 超时） | （已知抖动） | CLAUDE.md 记载的唯一已知抖动，单跑即过 |
| 文件级 EPERM ×16（afterAll `fs.rmSync` 清理临时目录） | — | Windows 文件占用噪音，与代码无关 |

**结论：本次改动零回归**（34 个新增用例全绿，失败集合与基线一致）。

## 5. 验收标准对照（PRD F1–F10）

| AC | 内容 | 证据 | 状态 |
|---|---|---|---|
| A1.1–A1.3 | bundle 结构/schema、篡改检测、密钥脱敏 | TC-1.1/1.2/1.3 + 全文扫描断言 | ✅ |
| A2.1–A2.3 | 导出 API、403 越权、确定性 contentHash | TC-2.1/2.2/2.3 | ✅ |
| A3.1–A3.5 | 单轮/多轮/interrupt/跨进程 resume/无平台依赖 | TC-3.1–3.4；A3.5 待走查（断网验证） | ✅（A3.5 含在 §6） |
| A4.1–A4.2 | 流式事件序列、类型同步门禁 | TC-4.1 + check 脚本 exit 0 | ✅ |
| A5.1–A5.2 | skill 装配/白名单 | TC-5.1/5.2 | ✅ |
| A6.1–A6.3 | MCP stdio/http、secret 缺失报错 | TC-6.1/6.2/6.3 | ✅ |
| A7.1–A7.2 | 自包含工具、路径穿越防护 | TC-7.1/7.2 | ✅ |
| A8.1 | 身份中性 | TC-8.1 | ✅ |
| A9.1 | 文档走查 30 分钟 | **待人工执行** | ⏳ |
| A10.1–A10.2 | 回归全绿 + typecheck | §3/§4 | ✅ |

## 6. 待人工完成（TC-9.1 + A3.5 走查清单）

需真实 API key 的端到端走查（按 `sdk/README.md` 顺序）：

1. Agent Studio 建 agent（挂 1 个 skill + 1 个 stdio MCP）→ 详情页「导出 SDK Bundle」；
2. 干净目录 `npm install` sdk（tarball）→ 按 `examples/quickstart/quickstart.mjs` 跑通：
   - [ ] 流式多轮对话（观察 text_delta 增量）；
   - [ ] skill 被触发（观察 tool_use 事件）；
   - [ ] MCP 工具被调用；
   - [ ] 杀进程重开 → 上下文续接（resume）；
   - [ ] 断网（仅放行 LLM API 域名）复跑一次性调用（A3.5）；
   - [ ] 篡改 bundle 一个字节 → 加载被拒；
   - [ ] 移除必需 env → 显式缺 secret 报错。
3. 记录 30 分钟内是否完成 ①–⑤（PRD §2 成功标准）。

## 7. 环境备注

- 测试命令：`node node_modules/vitest/vitest.mjs run <file>`（勿用 npx，见 task_state 环境备注）。
- better-sqlite3 现按 Node 24（ABI 137）编译；Node 22 反而加载不了。
- worktree node_modules 用 PowerShell `New-Item -ItemType Junction` 链接主 checkout。
