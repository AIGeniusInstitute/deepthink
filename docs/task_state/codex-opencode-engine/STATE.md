# 执行状态跟踪 — Codex & OpenCode 引擎接入 DeepThink

- **分支**：`feat/codex-opencode-engine`
- **开始日期**：2026-07-16
- **基线 commit**：`b138eab`（main）

## 假设核实结论（探索结果）

### Codex（~/codex）
- CLI 真实命令：`codex exec --json --model M --cd DIR [resume <threadId>] <prompt>`
- `resume` 是子命令（非位置参数二段式），SESSION_ID 是 UUIDv7
- JSONL 事件：`thread.started` / `turn.started` / `turn.completed` / `turn.failed` / `item.started` / `item.updated` / `item.completed` / `error`
- item.details.type：`agent_message` / `reasoning` / `command_execution` / `file_change`（无 diff 字段，只有 `changes: Vec<{path, kind}>`）/ `mcp_tool_call` / `web_search` / `todo_list` / `error`
- 必须 `--model` 显式指定（默认动态从 `models.json` 选取）
- 支持 stdin：`codex exec -` 读 stdin

### OpenCode（~/opencode）
- 启动：`bun run packages/opencode/src/index.ts serve --hostname 127.0.0.1 --port <port>`
- env：`OPENCODE_SERVER_PASSWORD`、`OPENCODE_SERVER_USERNAME`（默认 `opencode`）
- 鉴权：Basic Auth `opencode:<password>`
- Readiness：`GET /doc` 返回 200 + OpenAPI spec
- Session：`POST /session`（body 可空），返回 `{id: "ses_..."}`
- 消息：`POST /session/:id/message`，body 必须含 `providerID`、`modelID`、`parts: [{type:"text", text}]`
- SSE：`GET /event?directory=<dir>`，事件名固定 `message`，data JSON `{id, type, properties}`
- 关键事件类型：`message.part.updated`（part.type=text/reasoning/tool/step-start/step-finish）、`session.status`（status.type=idle/busy/retry）、`session.error`
- ToolPart.state.status：pending / running / completed / error
- Session 持久化到 `~/.local/share/opencode/storage/`，进程重启不丢
- package.json version：1.18.2，bun@1.3.14

## 执行进度

| 阶段 | 状态 | 备注 |
|------|------|------|
| 1. PRD/SOLUTION 修正 | ✅ 完成 | resume 子命令格式、file_change 无 diff、OpenCode providerID/modelID、tool error 状态 |
| 2. DB schema 迁移 v51→v52 | ✅ 完成 | codex_thread_id + opencode_session_id 列 + helper 函数 + engine union 扩展 |
| 3. schemas.ts 扩展 | ✅ 完成 | GroupPatchSchema.engine + CodexConfigSchema + OpencodeConfigSchema |
| 4. runtime-config.ts | ✅ 完成 | CodexConfig + OpencodeConfig 读写 + toPublic 脱敏 |
| 5. routes/config.ts | ✅ 完成 | /codex GET/PUT/POST test + /opencode GET/PUT/POST test |
| 6. container-runner.ts | ✅ 完成 | engine 类型 + env 注入 + host/Docker session 分流 |
| 7. src/index.ts 回写 | ✅ 完成 | 4 处 newSessionId 分流 |
| 8. codex-engine.ts | ✅ 完成 | spawn codex exec --json + JSONL 解析 + IPC 轮询 |
| 9. opencode-engine.ts | ✅ 完成 | spawn opencode serve + SSE 解析 + IPC 轮询 |
| 10. agent-runner index.ts 分支 | ✅ 完成 | engine ∈ {atomcode, codex, opencode} 分流 |
| 11. 前端 API 层 | ✅ 完成 | types.ts + stores/chat.ts + EngineSwitcher 拉取 enabled 状态 |
| 12. 前端 EngineSwitcher | ✅ 完成 | 4 引擎按钮 + 禁用状态 |
| 13. 前端 SettingsPage + Section | ✅ 完成 | 2 新 tab + CodexEngineSection + OpencodeEngineSection |
| 14. typecheck + build | ✅ 完成 | 三端 typecheck 通过 + make build 通过 + 1199 vitest 全过零回归 |
| 15. API 实测验证 | ✅ 完成 | GET/PUT/POST /codex/* 和 /opencode/* 全验证,codex 二进制版本返回 0.134.0,opencode serve /doc 200 + /session ses_ id 正常 |
| 16. codex JSONL 格式实测 | ✅ 完成 | codex exec --json 输出 thread.started/turn.started/error/turn.failed,thread_id UUIDv7,与 codex-engine.ts 解析逻辑对齐 |
| 17. opencode SSE 实测 | ✅ 完成 | bun run packages/opencode/src/index.ts serve --port 15001 启动 8s,/doc 200,POST /session 返回 ses_ id,Basic Auth opencode:pwd 工作 |
| 18. test_report | ⏳ 进行中 | |
| 19. commit + merge main + push | ⏳ 待办 | |
