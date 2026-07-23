# 执行状态 — 重写 WebSearch / WebFetch（中国可用）

> 需求：`docs/prd/rewrite-web-search-fetch/PRD.md`
> 分支：`feat/rewrite-web-tools`（worktree：`.claude/worktrees/rewrite-web-tools`）

## 执行时间线

| 时间 | 步骤 | 状态 |
|------|------|------|
| 16:37 | 探查：deepthink 仓库 + zhipu_web_search 项目 + agent-runner 架构 | ✅ |
| 16:45 | 定位机制：SDK `toolAliases`（sdk.d.ts:1358-1382）为官方内置工具重定向机制 | ✅ |
| 16:50 | 建 worktree `feat/rewrite-web-tools` | ✅ |
| 16:52 | 写 PRD + 验收标准 + 测试用例 | ✅ |
| 16:55 | 写技术方案 | ✅ |
| 16:58 | 编码：mcp-tools.ts 新增 web_search / web_fetch + helpers | ✅ |
| 16:59 | 编码：index.ts 加 toolAliases | ✅ |
| 17:00 | 编码：container-runner.ts 注入 ZHIPU_API_KEY（docker 路径） | ✅ |
| 17:00 | 编码：prompts/web-fetch.md 更新 | ✅ |
| 17:01 | 编译 agent-runner（tsc）+ 后端（tsc）均通过 | ✅ |
| 17:01 | 冒烟测试：智谱 API 200 + GBK 解码（独立脚本） | ✅ |
| 17:05 | 单元：加载 dist/mcp-tools.js，确认 28 工具含 web_search/web_fetch | ✅ |
| 17:06 | 集成：经编译 handler 实调 web_search（ok,3结果）/ web_fetch（example.com ok）/ 缺 key 降级 / 非法 url 降级 | ✅ |
| 17:08 | 集成：GBK 中文页（新浪/gov.cn）经 handler 解码无乱码 | ✅ |
| 17:01 | SDK 路由：最小 query harness，模型 emit WebSearch/WebFetch → toolAliases 路由到 mcp__deepthink__web_search/web_fetch（debug 日志证实） | ✅ |
| 17:10 | 全栈准备：dev 后端从 worktree 跑（tsx live） | 进行中 |
| 17:14 | **Issue 定位**：home 组跑 host 模式，DEEPTHINK_AGENT_RUNNER_DIR 继承 prod（/opt/DeepThink），未加载 worktree 代码；且 host 模式 env 不经 buildContainerEnvLines，ZHIPU 注入缺失 | 🐞 |
| 17:16 | **修复**：① host 模式 hostEnv 也注入 ZHIPU_API_KEY；② 测试时 DEEPTHINK_AGENT_RUNNER_DIR 指向 worktree；③ symlink worktree agent-runner node_modules 满足依赖检查 | ✅ |
| 17:18 | **全栈端到端**：admin 登录 → 发消息 → host agent(worktree dist) → toolAliases → 智谱搜索 5 条结果 + WebFetch example.com 标题 "Example Domain" | ✅ |

## 编码改动文件

| 文件 | 改动 |
|------|------|
| `container/agent-runner/src/mcp-tools.ts` | 新增 `web_search`、`web_fetch` 两个 `tool()` + helpers（filterByDomain/sniffCharset/decodeHtmlEntities/stripTags/htmlToMarkdown/fetchUrlAsMarkdown） |
| `container/agent-runner/src/index.ts` | `query()` options 新增 `toolAliases`（WebSearch→web_search, WebFetch→web_fetch） |
| `container/agent-runner/prompts/web-fetch.md` | 说明已重写、中国可用 |
| `src/container-runner.ts` | 新增 `resolveZhipuApiKey()`；docker envLines 注入 ZHIPU_API_KEY；host 模式 hostEnv 注入 ZHIPU_API_KEY |

## 遇到并修复的 Issue（详见 docs/test_report）

- **I1**：home 组 host 模式默认用 prod agent-runner（DEEPTHINK_AGENT_RUNNER_DIR 继承自会话 env），导致 toolAliases 不生效。修复：host 模式补 ZHIPU 注入；测试环境指向 worktree。
- **I2**：host 模式 env 构建不经 buildContainerEnvLines，原 ZHIPU 注入只覆盖 docker 路径。修复：在 runHostAgent 的 hostEnv 段对称注入。

## 退出状态

全部验收标准通过（证据见 test_report）。准备合并 main 并 push。
