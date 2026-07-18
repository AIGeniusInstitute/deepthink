# 2026-07-19 Codex 引擎 agent_message 文本丢失导致 "(Codex 返回空回复)"

## 1. 用户现象

Codex 引擎（env_vars 类型 bug 修复后）对话不再报 `codex exited with code 1`，但每条消息的回复都是固定字符串 `(Codex 返回空回复)`。无论问 `1+1=`、`你是谁`、`你能干什么`，DeepThink 头像下都只显示这一句。后端日志可见 `Agent output: (Codex 返回空回复)`。

## 2. 问题描述

`codex exec --json` 实际正确返回了模型答案（如 `1+1=?` → `2`），但 agent-runner 的 codex-engine 适配器（`container/agent-runner/src/codex-engine.ts`）没有把答案文本提取到 `fullText`，导致 `result.fullText` 为空字符串，`runCodexEngine` 走兜底分支输出 `(Codex 返回空回复)`：

```ts
writeOutput({
  status: 'success',
  result: result.fullText || '(Codex 返回空回复)',
  ...
});
```

## 3. 根因

codex-engine 的 JSONL 事件解析只对 `item.started` / `item.updated` 处理 `agent_message`（增量提取 `ev.item.text` 到 `fullText` + 发 `text_delta`），而 `item.completed` 分支只处理 `command_execution` / `file_change` / `mcp_tool_call` / `web_search`，**不处理 `agent_message`**。

但当前模型组合（qwen3.7-max 经 DashScope `wire_api = "responses"`）只把 `agent_message` 作为 **`item.completed`** 发出，根本没有 `item.started` / `item.updated` 事件。实测 `codex exec --json` 的 JSONL 流事件分布：

```json
{
  "thread.started": 1,
  "turn.started": 1,
  "item.completed/reasoning": 1,
  "item.completed/agent_message": 1,
  "item.completed/error": 1,
  "turn.completed": 1
}
```

`item.completed/agent_message` 的 payload：

```json
{ "type": "item.completed",
  "item": { "id": "item_2", "type": "agent_message", "text": "2" } }
```

由于 `item.completed` 分支不识别 `agent_message`，`text="2"` 被丢弃，`fullText` 全程为空 → `(Codex 返回空回复)`。

外部依据：codex CLI 的 JSONL schema 中 `agent_message` 可出现在 `item.started`（开始，可能空 text）、`item.updated`（流式增量，text 为累积全文）、`item.completed`（最终全文）三种事件。不同 model/wire_api 组合的发射模式不同——OpenAI 原生 responses 多用 started+updated 流式，DashScope 兼容层只发 completed。解析器必须三种都覆盖。

## 4. 复现路径

1. `make dev`，Codex 引擎配置就绪（env_vars bug 已修、apiKey 已还原）。
2. Web 发 `1+1=? 请直接回答`。
3. 回复为 `(Codex 返回空回复)`。
4. 抓 codex 原始 JSONL 确认模型其实有答：

```bash
REALKEY=$(grep experimental_bearer_token ~/.codex/config.toml | sed -E 's/.*= *"([^"]+)".*/\1/')
mkdir -p /tmp/cx && cat > /tmp/cx/config.toml <<'EOF'
model = "qwen3.7-max"
model_provider = "deepthink"
[model_providers.deepthink]
name = "qwen3.7-max"
base_url = "https://dashscope.aliyuncs.com/compatible-mode/v1"
env_key = "DEEPTHINK_CODEX_API_KEY_0"
EOF
CODEX_HOME=/tmp/cx DEEPTHINK_CODEX_API_KEY_0="$REALKEY" \
  codex exec --json --model qwen3.7-max --cd ~/.deepthink/data/groups/main "1+1=?" </dev/null
# 可见 item.completed/agent_message 的 text="2"，但前端只显示 "(Codex 返回空回复)"
```

## 5. 诊断方法

```bash
# 1) 查最近 host 运行：stdout 只有 init+tokens+success(空回复)，无 text_delta
LATEST=$(ls -t ~/.deepthink/data/groups/main/logs/host-*.log | head -1)
sed -n '/=== Stdout ===/,$p' "$LATEST" | grep -o '"eventType":"[^"]*"\|"result":"[^"]*"'

# 2) 直跑 codex 抓 JSONL，统计事件类型分布
node -e 'const l=require("fs").readFileSync("/tmp/cx/jsonl.log","utf8").split("\n").filter(Boolean);const t={};for(const x of l){try{const e=JSON.parse(x);const k=e.type+(e.item?"/"+e.item.type:"");t[k]=(t[k]||0)+1;}catch{}}console.log(JSON.stringify(t,null,2));'

# 3) 若 item.completed/agent_message 存在但前端无 text_delta → 即本 bug
```

## 6. 修复方案

`container/agent-runner/src/codex-engine.ts` 的 `item.completed` 分支，在 `command_execution` 之前增加 `agent_message` 处理，复用既有的 `lastItemText[itemId]` 增量追踪：

```diff
       case 'item.completed': {
         if (!ev.item) break;
+        // Some codex/model combos (e.g. qwen3.7-max via DashScope responses API)
+        // only emit the agent_message as item.completed — never item.started/
+        // item.updated — so without this branch the final text is lost and the
+        // turn ends with "(Codex 返回空回复)". Reuse the lastItemText delta
+        // tracker so models that DO stream via item.updated don't double-emit.
+        if (ev.item.type === 'agent_message' && ev.item.text) {
+          const itemId = ev.item.id ?? '_anon';
+          const prev = lastItemText[itemId] ?? '';
+          const full = ev.item.text;
+          const delta = full.startsWith(prev) ? full.slice(prev.length) : full;
+          lastItemText[itemId] = full;
+          if (delta) {
+            fullText += delta;
+            emitStream(writeOutput, { eventType: 'text_delta', agentScope: 'main', text: delta }, currentSessionId, turnId);
+          }
+        } else if (ev.item.type === 'command_execution') {
-        if (ev.item.type === 'command_execution') {
```

选型理由：
- **复用 `lastItemText` 增量而非直接追加全文**：若某 model 同时发了 `item.updated`（已把累积文本流给前端）和 `item.completed`（最终全文），`full.startsWith(prev)` → `delta = ""`，不会重复发送。对只发 `completed` 的 model，`prev = ""` → `delta = full`，一次性发出全文。一行逻辑兼顾两种发射模式。
- 只在 `item.completed` 补这一分支，不动 `item.started`/`item.updated` 既有逻辑（Surgical Changes）。
- `reasoning` 不在此分支处理：`item.updated` 已发 `thinking_delta`，且 `item.completed/reasoning` 不含新增文本，无需重复。

## 7. 处理卡住的状态

无需特殊处理。修复后重新发消息即可。host 模式 dist 已重新编译（`npm run build`），dev 服务无需重启——下次 host agent 运行自动加载新 dist。

## 8. 经验沉淀 / 预防

1. **"返回空回复"几乎总是解析层丢事件，而非模型没答**：第一步应直跑 `codex exec --json` 抓原始 JSONL，统计 `event.type/item.type` 分布，对比解析器覆盖的事件集合。本次模型其实答了 `2`。
2. **外部 CLI 的流式事件协议有多种合法发射模式**：`agent_message` 可走 started/updated/completed 任一或组合。解析器必须对三种事件都覆盖 `agent_message`，并用以 id 为键的「累积全文」增量去重，避免按"哪种事件"硬编码假设。
3. **增量去重用 `full.startsWith(prev)` 而非 `delta = full.slice(prev.length)`**：前者在 prev 非前缀（model 重写文本）时 fallback 为全文，更鲁棒——这正是 `item.updated` 分支已有的写法，本次直接复用。
4. 巡检建议：扩展 `make codex-smoke`（见上一 issue）不仅校验 config 解析，还断言最终 `result` 非空且包含模型实际文本，覆盖此类"跑通但丢文本"回归。
