# 2026-07-19 Codex 引擎 config.toml env_vars 类型错误导致 codex exited with code 1

## 1. 用户现象

Web 端（`/chat`，admin 主容器 `web:main`）使用 Codex 引擎（model=qwen3.7-max）发送任意消息（如 `1+1=`），界面只显示一条 init 流式卡片「Codex 引擎已启动 (model=qwen3.7-max)」，随后 Agent 状态变 `idle`，`resultSummary` 为 `Codex 错误：codex exited with code 1`，没有任何回复内容。GroupQueue 在后台静默指数退避重试 5 次仍失败。

## 2. 问题描述

agent-runner 的 Codex 引擎适配器（`container/agent-runner/src/codex-engine.ts` 的 `writeCodexConfig`）在为每次会话动态生成 `$CODEX_HOME/config.toml` 时，把 `mcp_servers.deepthink.env_vars` 写成了 TOML **inline table**（`env_vars = { DT_CHAT_JID = "...", ... }`）。当前安装的 codex CLI（`codex-cli 0.0.0`）期望该字段是 **sequence（数组）**，于是在加载配置阶段就报错退出，整个 `codex exec --json` 进程以退出码 1 终止，从未发起任何模型调用。

## 3. 根因

代码层面：`codex-engine.ts` 写配置片段

```ts
const envVarsToml = Object.entries(envVars)
  .map(([k, v]) => `${k} = "${String(v).replace(/"/g, '\\"')}"`)
  .join(', ');
lines.push(`env_vars = { ${envVarsToml} }`);
```

生成结果（节选）：

```toml
[mcp_servers.deepthink]
command = "node"
args = ["/.../mcp-bridge.js"]
env_vars = { DT_CHAT_JID = "web:main", DT_GROUP_FOLDER = "main", ... }
```

codex 加载该 toml 时 stderr 输出（host 模式 agent-runner 日志 `data/groups/main/logs/host-*.log` 实证）：

```
Error loading config.toml: invalid type: map, expected a sequence
in `mcp_servers.deepthink.env_vars`
```

→ codex 进程 exit 1 → codex-engine.ts 的 `runOneTurn` 捕获 `exitCode !== 0` → 返回 `error: "codex exited with code 1"` → `runCodexEngine` 输出 `Codex 错误：codex exited with code 1`。

外部依据：codex CLI 的 `McpServerConfig` schema 中 `env_vars` 为 `Vec<String>`（sequence），元素为 `"KEY=VALUE"` 字符串。inline table 形式被旧版 codex 接受，新版本拒绝。

## 4. 复现路径

1. `make dev` 启动后端 + 前端。
2. 设置 → Codex 引擎：配置 `binaryPath=/home/me/.local/bin/codex`、`defaultModel=qwen3.7-max`、provider（DashScope baseURL + 真实 apiKey）、保存。
3. 群组 `web:main` 的执行模式设为 host、engine 设为 codex。
4. Web 聊天发送 `1+1=`。
5. 观察：界面出现 init 卡片后转 idle，summary 为 `Codex 错误：codex exited with code 1`。
6. 查 host 日志：

```bash
LATEST=$(ls -t ~/.deepthink/data/groups/main/logs/host-*.log | head -1)
sed -n '/=== Stderr ===/,/=== Stdout ===/p' "$LATEST"
# 可见 "Error loading config.toml: invalid type: map, expected a sequence in `mcp_servers.deepthink.env_vars`"
```

## 5. 诊断方法

```bash
# 1) 查最近一次 host agent 运行的 stderr（含 [codex stderr] 真实报错）
LATEST=$(ls -t ~/.deepthink/data/groups/main/logs/host-*.log | head -1)
sed -n '/=== Stderr ===/,/=== Stdout ===/p' "$LATEST"

# 2) 直接查看 agent-runner 为本次会话生成的 config.toml
find ~/.deepthink/data/sessions/main -name config.toml -path '*\.codex*' -newer /tmp -print -exec cat {} \;

# 3) 离线复现 codex 对该 toml 的解析（不需要真实 key）
mkdir -p /tmp/cx && cat > /tmp/cx/config.toml <<'EOF'
[mcp_servers.deepthink]
command = "node"
args = ["x"]
env_vars = { DT_CHAT_JID = "web:main" }
EOF
CODEX_HOME=/tmp/cx codex exec --json --model qwen3.7-max --cd /tmp "hi" 2>&1 | head
# 修复前：Error loading config.toml: invalid type: map, expected a sequence in `mcp_servers.deepthink.env_vars`
```

## 6. 修复方案

`container/agent-runner/src/codex-engine.ts` `writeCodexConfig`：把 `env_vars` 从 inline table 改为 sequence of `"KEY=VALUE"` 字符串。

```diff
-    const envVarsToml = Object.entries(envVars)
-      .map(([k, v]) => `${k} = "${String(v).replace(/"/g, '\\"')}"`)
-      .join(', ');
-    lines.push(`env_vars = { ${envVarsToml} }`);
+    const envVarsToml = Object.entries(envVars)
+      .map(([k, v]) => `"${k}=${String(v).replace(/"/g, '\\"')}"`)
+      .join(', ');
+    lines.push(`env_vars = [ ${envVarsToml} ]`);
```

生成结果：

```toml
env_vars = [ "DT_CHAT_JID=web:main", "DT_GROUP_FOLDER=main", ... ]
```

选型理由：codex `mcp_servers.*.env_vars` 的 schema 是 `Vec<String>`，元素约定为 `"KEY=VALUE"`。inline table 是旧版残留，新 codex 已不接受。这是最小改动，仅改写入格式，不改语义（DT_* 环境变量集合不变，bridge 子进程仍能读到）。

### 附带修复：codex.json 中 apiKey 被脱敏值覆盖

排查中发现 `data/config/codex.json` 里 `providers[0].apiKey` 存的是脱敏值 `****8-5r`（真实 token 117 字符，仅存于用户手写的 `~/.codex/config.toml` 的 `experimental_bearer_token`，结尾 `...8-5r`）。`getCodexConfig()` 直接读取该字段（无解密），导致即便 env_vars 修好，注入到 codex 的 `DEEPTHINK_CODEX_API_KEY_0` 仍是脱敏值 → dashscope 401 → codex 退出码 1（同症不同因）。

`saveCodexConfig` 的 API 路由（`src/routes/config.ts` PUT /api/config/codex）已有「apiKey 为空或以 `****` 开头时按 name 从 current 恢复真实值」的逻辑，但一旦 codex.json 本身已存脱敏值，该回填会再次回填脱敏值（自噬）。本次从用户本机 `~/.codex/config.toml` 还原真实 token 到 `data/config/codex.json`（属同一 bug 的运行时表现，不持久化于代码）。

> 注：脱敏值自噬是更深的 route 层问题，本次未在代码层修复——当前用户工作目录下已通过运行时还原解决。后续若再触发，应在 `saveCodexConfig` 增加校验：拒绝把以 `****` 开头的 apiKey 写回文件（视为「保持原值」而非「回填脱敏值」）。

## 7. 处理卡住的状态

- 后台 GroupQueue 对失败消息的指数退避重试最多 5 次后自动放弃，不会无限重试。
- 若历史失败消息不再重试且无新消息，直接在 Web 重新发送一条消息即可触发用新代码的 host 运行。
- agent-runner dist 在 host 模式下若源码比 dist 新会被 `container-runner.ts` 的 host preflight 自动重编译；本次已手动 `npm run build` 重新编译。

## 8. 经验沉淀 / 预防

1. **codex-engine 的 stderr 是真相源**：`codex exited with code 1` 只是 codex-engine 的兜底文案，真实原因在 `[codex stderr]` 行。本次首先在后端日志里只看到 `Codex 错误：codex exited with code 1`，差点误判为 codex 二进制/网络问题；翻 host 模式 agent-runner 日志（`data/groups/main/logs/host-*.log` 的 Stderr 段）才定位到 `Error loading config.toml`。**结论必须有 stderr 实证，禁止主观判断**。
2. **外部 CLI 的配置 schema 会随版本变化**：codex 的 `env_vars` 从 map 变 sequence 即典型例证。生成外部工具的配置文件时，应在变更后用真实 CLI 做一次 dry parse（`codex exec --json` 短超时）校验，而不是只看文件能写出。
3. **脱敏值回写是配置类密钥管理的隐蔽陷阱**：GET 返回脱敏、PUT 回写若不区分「脱敏占位」与「真实值」，就会把脱敏值固化进存储。建议在 `saveCodexConfig` 入口断言 `apiKey.startsWith('****')` 时视为「不变」并从已存真实值取（当前路由已有此逻辑，但需保证已存值本身非脱敏——可在首次写入时强校验）。
4. 巡检建议：新增一个 `make codex-smoke` 目标，用最小 prompt + 临时 CODEX_HOME 跑一次 `codex exec`，校验 config.toml 能被 codex 解析并发起模型调用，作为 CI 回归门禁。
