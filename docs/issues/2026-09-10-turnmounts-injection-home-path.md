# 2026-09-10 — turnMounts 运行时注入在 home 组路径失效

## 1. 用户现象

用户在 DeepThink Web 对话界面选择「PPT 制作」技能后发送消息，期望 Agent 加载该技能运行。但 Agent 回复称"未收到 PPT 技能的指令注入"——技能内容没有进入 Agent 的系统指令。

## 2. 问题描述

`selectedMounts`（对话下拉选择的技能/MCP/知识库）经 in-memory Map（`pendingTurnMounts`）桥接到 `processAgentConversation` 的 `ContainerInput.turnMounts`，再由 `container-runner.ts` 的 `applyTurnMounts()` 注入 systemPrompt。

但 home 组（`web:main`，`agent_def_id=null`，`execution_mode=host`）不走 `processAgentConversation`，而是走 `processGroupMessages` → `runAgent` → `runHostAgent` 路径。`runAgent` 函数签名不含 `turnMounts`，其三处 input 对象（distributed Redis / host / container）均未传 `turnMounts`，导致 `applyTurnMounts` 虽在 `runHostAgent` 内被调用（line 2467），但 `input.turnMounts` 恒为 `undefined`，函数在 line 1214（`if (!turnMounts) return agentDef`）直接返回，技能内容从未注入。

## 3. 根因

**代码层面**：`runAgent`（`src/index.ts:5030`）是 home 组的 dispatch 入口，但遗漏了 `turnMounts` 参数传递链。

数据流断点：
```
web.ts setPendingTurnMounts(msgId)  ✅ 写入 Map
  → processGroupMessages (3276)     ❌ 未 pop pendingTurnMounts
  → runAgent (5030)                  ❌ 签名无 turnMounts
  → runHostAgent input               ❌ input 对象无 turnMounts
  → applyTurnMounts(input.turnMounts=undefined) → line 1214 return ❌ 跳过注入
```

对比：`processAgentConversation`（7689，conversation/spawn agent 路径）正确 pop 并传 `turnMounts`（line 8685-8702），所以该路径功能正常。仅 home 组路径断裂。

**外部依据**：Agent 输出日志（2026-09-10 02:08:21）：
> "结论：未收到 PPT 制作技能的"指令注入"，仅完成了磁盘层面的技能挂载。"

## 4. 复现路径

1. 启动 DeepThink（`node dist/index.js`，端口 9999）
2. 登录 `http://127.0.0.1:9999/login`（admin/88888888）
3. 进入 /chat，选 home 组（web:main）
4. 点技能下拉 → 选「PPT 制作」→ 发送任意消息
5. 观察 Agent 回复：修复前 Agent 称未收到技能指令；修复后 Agent 确认收到

**诊断命令**（发送带 selectedMounts 的消息后查日志）：
```bash
# 发送测试消息
curl -s -b cookie.txt -X POST http://127.0.0.1:9999/api/messages \
  -H "Content-Type: application/json" \
  -d '{"chatJid":"web:main","content":"确认你收到 PPT 技能了吗","selectedMounts":{"skills":["builtin-ppt"]}}'

# 查注入日志（修复后应出现）
grep "applyTurnMounts" ~/deepthink/logs/deepthink-9999.log | tail -3
# 期望: "applyTurnMounts: skills injected into systemPrompt" skillCount: 1
```

## 5. 诊断方法

```bash
# 确认 runAgent 路径不含 turnMounts（修复前）
grep -n "turnMounts" src/index.ts
# 修复前: 仅 959/960(define/pop) + 8685/8702(processAgentConversation)
# runAgent(5030) 及其 3 处 input 对象无 turnMounts

# 确认 home 组走 runAgent 而非 processAgentConversation
grep -n "processGroupMessages\|runAgent(" src/index.ts | grep -E "3789|4955|11659"
# 11659: queue.setProcessMessagesFn(processGroupMessages) — home 组经此入口

# 发送测试消息后查 agent 输出
tail -60 ~/deepthink/logs/deepthink-9999.log | grep -A5 "Agent output"
```

## 6. 修复方案

**选型理由**：`turnMounts` 已在 `processAgentConversation` 路径完整实现（pop → ContainerInput → applyTurnMounts）。home 组路径只需补齐同样的 3 站传递——这是外科手术式补缺，不引入新机制。

**关键 diff**（`src/index.ts`）：

```diff
 // 1. runAgent 签名加 turnMounts 参数
 async function runAgent(
   group: RegisteredGroup,
   prompt: string,
   chatJid: string,
   turnId?: string,
   onOutput?: (output: ContainerOutput) => Promise<void>,
   images?: Array<{ data: string; mimeType?: string }>,
   messageTaskId?: string,
   currentSourceJid?: string,
+  turnMounts?: SelectedMounts,
 ): Promise<...> {

 // 2. processGroupMessages 中 pop + 传参
+  const turnMounts = lastProcessed?.id
+    ? popPendingTurnMounts(lastProcessed.id)
+    : undefined;
   output = await runAgent(
     effectiveGroup, prompt, chatJid, lastProcessed.id,
     async (result) => { ... },
     imagesForAgent, messageTaskId, currentSourceJid,
+    turnMounts,
   );

 // 3. runAgent 三处 input 对象加 turnMounts
 //    distributed Redis taskInput (line ~5150)
 //    runHostAgent input (line ~5208)
 //    runContainerAgent input (line ~5229)
+    turnMounts,
```

**附带修复**：`tests/units/super-agent-team-trace.test.ts` 和 `workflows.test.ts` 的 `schema_version` 断言从 58 更新为 61（上一特性 SCHEMA_VERSION→61 升级后遗留的过时断言）。

## 7. 处理卡住的状态

无 stuck 运行态。修复前 home 组的 turn 消息正常 completed（只是没注入技能），无 hung 进程。

## 8. 经验沉淀 / 预防

1. **双 dispatch 路径覆盖**：DeepThink 有两条消息 dispatch 路径——`processGroupMessages`→`runAgent`（home/IM 组）和 `processAgentConversation`（conversation/spawn agent）。任何 per-turn 注入字段（如 `turnMounts`、`autonomous`）必须同时在两条路径的 4 个站点（pop → runAgent 签名 → input 对象 → applyTurnMounts）补齐。未来新增 per-turn 字段时，用 `grep -n "turnMounts\|autonomous" src/index.ts` 确认两条路径均有覆盖。

2. **端到端验证优于 UI 断言**：UI 测试（Playwright）只验证下拉选择+POST 200，无法发现 Agent 实际未收到注入。本次 bug 靠 Agent 自述"未收到技能指令"才暴露。建议 per-turn 注入类功能加服务端日志（`applyTurnMounts: skills injected`），测试时 grep 日志验证。

3. **`runAgent` 参数膨胀风险**：`runAgent` 已有 9 个参数，加 `turnMounts` 后 10 个。若后续再加 per-turn 字段，考虑改为 options 对象（`{ turnMounts, autonomous, ... }`）。当前保持位置参数（Simplicity First，不重构既有签名）。
