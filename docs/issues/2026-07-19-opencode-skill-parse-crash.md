# OpenCode 引擎 skill 解析崩溃 + provider 配置格式错误，导致无法回答

- 日期：2026-07-19
- 范围：OpenCode 引擎（`engine=opencode`）会话型 Agent
- 结论：**已真正修复**（双根因，对照实验 + 端到端验证）

## 1. 用户现象

修复「回复复读 / system_context」之后，OpenCode 会话型 Agent 对任何提问（「你是谁」「who are u」「1+1=」）都直接报错，对话框**无任何输出**：

```
OpenCode 错误：session.error: {"error":{"name":"UnknownError","data":{"message":"Failed to parse skill /home/me/.claude/skills/officecli/SKILL.md"}}}
```

修好 skill 崩溃后，又暴露出第二个问题：LLM 根本没被调用（之前「echo 回复」其实只是用户输入被原样复读，没有真实模型输出）。

## 2. 问题描述

两个独立根因叠加：

1. **skill 解析崩溃**：OpenCode serve 自动扫描宿主 `~/.claude/skills/**/SKILL.md`（Claude Code skill 兼容），用其自带 markdown 解析器逐个解析。本机 `officecli/SKILL.md` 是断链（`-> ../../SKILL.md`，目标不存在）→ `ConfigMarkdown.parse` ENOENT。OpenCode 对此 publish 一条 `session.error`（非致命，OpenCode 自身继续），但 DeepThink 的 opencode-engine 把**任何** `session.error` 当致命错误 → 立即终止回合、无输出。
2. **provider 配置格式错误**：DeepThink 的 `writeOpencodeConfigFile` 写的 provider 配置用顶层蛇形 `api_key`/`base_url`、且漏了 `api` 字段。但 OpenCode v1 provider schema 要求 `options.apiKey`/`options.baseURL`（驼峰、在 `options` 下）+ 顶层 `api`（API 类型）。字段名不对 → OpenCode 读不到 baseURL → 解析成 `undefined/chat/completions` → LLM 未被调用。

## 3. 根因

### skill 崩溃

OpenCode 源码（`packages/opencode/src/skill/index.ts` `add()`）：

```ts
const md = yield* Effect.tryPromise({
  try: () => ConfigMarkdown.parse(match),
  catch: (err) => err,
}).pipe(Effect.catch(function* (err) {
  const message = ... `Failed to parse skill ${match}`
  const { Session } = yield* Effect.promise(() => import("@/session/session"))
  yield* events.publish(Session.Event.Error, { error: new NamedError.Unknown({ message }).toObject() })  // ← 非致命错误却发 session.error
  yield* Effect.logError("failed to load skill", { skill: match, error: err })
  return undefined   // OpenCode 自身继续
}))
```

DeepThink `container/agent-runner/src/opencode-engine.ts` `runOneTurn` 把 `session.error` 当致命：

```ts
} else if (type === 'session.error') {
  errorMessage = `session.error: ${JSON.stringify(props).slice(0, 500)}`;
  done = true; break;   // ← 立即终止，收不到后续 assistant 文本
}
```

现场：`/home/me/.claude/skills/officecli/SKILL.md -> ../../SKILL.md`（断链）。

### provider 配置格式

DeepThink `writeOpencodeConfigFile` 原写法：

```ts
(config.provider as Record<string, unknown>)[p.id] = {
  name: p.name || p.id,
  api_key: p.apiKey,     // ← 错：应为 options.apiKey
  base_url: p.baseURL,   // ← 错：应为 options.baseURL
  models: modelsMap,     // ← 漏顶层 api 字段
};
```

OpenCode v1 provider schema（`packages/core/src/v1/config/provider.ts` `Info`）：

```ts
export const Info = Schema.Struct({
  api: Schema.optional(Schema.String),     // API 类型，如 "openai"
  name: Schema.optional(Schema.String),
  options: Schema.optional(Schema.StructWithRest(Schema.Struct({
    apiKey: Schema.optional(Schema.String),   // ← 驼峰，在 options 下
    baseURL: Schema.optional(Schema.String),  // ← 驼峰，在 options 下
    ...
  }), ...)),
  models: Schema.optional(Schema.Record(Schema.String, Model)),
})
```

## 4. 复现路径

### skill 崩溃（对照实验，不依赖 provider）

```bash
# 不带任何 env：复现 skill 解析错误
HOME=/home/me OPENCODE_SERVER_PASSWORD=test \
  opencode serve --hostname 127.0.0.1 --port 15190 --print-logs --log-level INFO > /tmp/oc.log 2>&1 &
curl -s -X POST "http://127.0.0.1:15190/session?directory=/tmp" -u opencode:test -H 'Content-Type: application/json' -d '{}'
curl -s -X POST "http://127.0.0.1:15190/session/<id>/message?directory=/tmp" -u opencode:test -H 'Content-Type: application/json' \
  -d '{"providerID":"anthropic","modelID":"x","parts":[{"type":"text","text":"hi"}]}'
grep "failed to load skill" /tmp/oc.log
# 命中：skill=/home/me/.claude/skills/officecli/SKILL.md error="ENOENT ..."
# SSE 流里出现 "type":"session.error" 含 "Failed to parse skill"
```

### provider 配置错误

用 DeepThink 实际写出的 `opencode.jsonc`（`~/.deepthink/data/sessions/main/agents/<agentId>/.claude/.opencode/opencode.jsonc`）跑 serve 发消息 → SSE 出现：

```json
{"type":"session.error","properties":{"error":{"name":"UnknownError","data":{"message":"\"undefined/chat/completions\" cannot be parsed as a URL."}}}}
```

`undefined` 即 baseURL 未被读到。

## 5. 诊断方法

- agent_status resultSummary 含 `Failed to parse skill <path>` → skill 崩溃。
- agent_status resultSummary 含 `undefined/chat/completions cannot be parsed as a URL` → provider 配置格式错。
- 列断链 skill：`find /home/me/.claude/skills -maxdepth 2 -name SKILL.md -type l ! -exec test -e {} \; -print`
- 看 DeepThink 写出的配置：`find ~/.config/DeepThink ~/.deepthink -name opencode.jsonc`，检查 provider 是否有 `options.apiKey/baseURL` + `api`。
- opencode serve 日志：`data/groups/<folder>/logs/opencode-serve.log`（grep `failed to load skill`）。

## 6. 修复方案

### Fix 1：OpenCode 源码 — skill 解析失败不再发 session.error

`/home/me/opencode/packages/opencode/src/skill/index.ts` `add()` 的 catch 分支：

```diff
     Effect.catch(
       Effect.fnUntraced(function* (err) {
-        const message = FrontmatterError.isInstance(err) ? err.data.message : `Failed to parse skill ${match}`
-        const { Session } = yield* Effect.promise(() => import("@/session/session"))
-        yield* events.publish(Session.Event.Error, { error: new NamedError.Unknown({ message }).toObject() })
+        // DeepThink: 单个不可解析/缺失的 SKILL.md（如宿主 ~/.claude/skills 里的断链）
+        // 不得终止整段会话。跳过该 skill、记日志、继续 —— 清单里其余 skill 照常加载。
+        // 不要 publish Session.Event.Error：DeepThink 的 engine 把 session.error 当致命处理。
         yield* Effect.logError("failed to load skill", { skill: match, error: err })
         return undefined
       }),
```

同时删掉因此变未使用的 `NamedError`、`FrontmatterError` 两个 import。

然后重新打包二进制：

```bash
cd /home/me/opencode/packages/opencode
bun run script/build.ts --single --skip-embed-web-ui --skip-install
# 产物：dist/opencode-linux-x64/bin/opencode（147MB，无嵌入 Web UI；DeepThink 只用 serve 模式）
cp -a ~/.local/bin/opencode ~/.local/bin/opencode.bak.20260719   # 备份原 178MB 二进制
cp -f dist/opencode-linux-x64/bin/opencode ~/.local/bin/opencode
```

选型理由：用户要求 OpenCode 兼容 DeepThink 的 skill 清单（统一 skill 层），因此**不禁用** skill 扫描（不用 `OPENCODE_DISABLE_CLAUDE_CODE_SKILLS`），而是让 OpenCode 对坏 skill 容错跳过。实测：新二进制下 82 个 DeepThink skill 全部加载（`init count=82`），断链 officecli 仅 log、SSE 无 `Failed to parse skill` 的 session.error。

### Fix 2：DeepThink — provider 配置用 OpenCode v1 正确格式

`container/agent-runner/src/opencode-engine.ts` `writeOpencodeConfigFile`：

```diff
     (config.provider as Record<string, unknown>)[p.id] = {
       name: p.name || p.id,
-      api_key: p.apiKey,
-      base_url: p.baseURL,
+      api: 'openai',
+      options: {
+        apiKey: p.apiKey,
+        baseURL: p.baseURL,
+      },
       models: modelsMap,
     };
```

选型理由：DeepThink 的 opencode provider 都是 OpenAI 兼容 baseURL（如 dashscope `/compatible-mode/v1`），故 `api: "openai"`。OpenAI 兼容是自定义 provider 的通用场景；若未来要支持 Anthropic 原生等，再给 `OpencodeProvider` 加可选 `api` 字段（本次不做，避免越界）。

## 7. 验证（端到端）

用 DeepThink 同款 provider（glm-5.2 / dashscope）+ 新二进制 + 修正后的配置格式，直连 serve 发 `who are u`：

- skill：SSE 中 `Failed to parse skill` / `failed to load skill` 的 session.error = **0**；`init count=82`。
- provider：无 `undefined/chat/completions` 错误；SSE 收到真实 assistant 文本：
  > "I'm DeepThink, an enterprise-grade autonomous Agent superintelligence platform for self-evolving AI coding and multi-agent collaboration."

SSE 里还有一个文本 part 是用户输入 `who are u` 的 echo（OpenCode 会把用户消息 part 也经 `message.part.updated` 推送）—— 已由 [[2026-07-19-opencode-engine-echo-and-session]] 的 Bug B 修复（按 `message.updated` 的 role 过滤用户 part）过滤掉。

约束测试：`make typecheck-agent-runner` 通过；dist 构建通过且含 `api: "openai"` / `options.apiKey` / `options.baseURL`。

## 8. 经验沉淀 / 预防

- **OpenCode 把非致命错误也走 `session.error`**：skill 解析失败只跳过、不中断，却仍 publish session.error。DeepThink engine 无差别把 session.error 当致命。后续可考虑：仅当回合内一直无 assistant 输出且未到 idle 时才把 session.error 升级致命。本次通过改 OpenCode 源码从源头消除，未改 engine 语义。
- **OpenCode config schema 演进**：v1 provider 配置从「顶层 `api_key`/`base_url`」迁到「`options.apiKey`/`options.baseURL` + 顶层 `api`」。DeepThink 各引擎适配器写第三方配置时必须对照目标版本的真实 schema（`packages/core/src/v1/config/`），不能想当然。
- **断链 skill 是雷区**：`~/.claude/skills/*/SKILL.md` 任一断链/格式异常都会让兼容扫描出问题。巡检：`find ~/.claude/skills -maxdepth 2 -name SKILL.md -type l ! -exec test -e {} \; -print`。
- **进程泄漏**：agent-runner 被强杀时 `stopServe` 不执行，serve 子进程残留（本次清理了 14 个 02:47–14:08 的泄漏进程）。建议给 serve 子进程加进程组或在主进程启动时扫杀孤儿。单独 issue 处理。
- **二进制替换覆盖范围**：`/home/me/.local/bin/opencode` 被 DeepThink 桌面版与 `make dev` 共用；替换后两者都生效。已备份原二进制至 `opencode.bak.20260719`。
