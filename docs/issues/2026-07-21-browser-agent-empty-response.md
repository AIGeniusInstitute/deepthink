# Browser Use Agent 全步骤 "模型未返回可解析的 JSON 动作 / 空响应"

- 日期：2026-07-21
- 涉及模块：`src/sandbox/browser-agent.ts`、`src/sdk-query.ts`、`web/src/components/sandbox/BrowserView.tsx`
- 严重度：P0（Browser Use Agent 功能完全不可用）

## 1. 用户现象

在沙箱页右侧「Browser Use Agent」面板输入任务（如 `打开百度搜索 DeepThink, 并截图`，起始 URL `https://www.baidu.com`）并点击「执行任务」后，每一步都立即失败：

```
step #1  failed  模型未返回可解析的 JSON 动作
→ (空响应)
```

多步重试均同样失败，结果为 `[failed] 模型响应无法解析为动作`。同时浏览器主区域空状态文案为「点击"启动浏览器"开始」，但该区域并无此按钮，用户不知道该点哪里。

前端控制台报：
```
POST http://127.0.0.1:5173/api/sandbox/sessions/sb-.../browser/agent  (200, 但循环失败)
```

## 2. 问题描述

`BrowserUseAgent` 循环每一步：截图 → 调 `sdkQueryMessages([{role:'user', content:[text, image]}])` → 期望返回 JSON 动作 → `parseAction` 解析。

实际：`sdkQueryMessages` 始终返回 `null`（空响应），`parseAction(null)` → `null` → 命中「模型未返回可解析的 JSON 动作」分支，循环立即终止。

后端日志（dev server，`/tmp/deepthink-dev`）在用户报错时段反复出现：
```
[WARN] sdkQueryMessages failed
```

## 3. 根因

`src/sdk-query.ts` 的 `sdkQueryMessages` 把 `messages` 数组直接传给 Claude Agent SDK 的 `query()`：

```ts
const conversation = query({
  messages: messages as any,   // ❌ query() 不存在该参数
  options: { ... },
} as any);
```

但 `@anthropic-ai/claude-agent-sdk`（v0.3.212）的 `query()` 签名为：

```ts
export declare function query(_params: {
  prompt: string | AsyncIterable<SDKUserMessage>;
  options?: Options;
}): Query;
```

**`query()` 只接受 `prompt`（字符串或 `AsyncIterable<SDKUserMessage>`），没有 `messages` 参数。** 传入的 `messages` 被静默忽略，`prompt` 缺失，SDK 立即抛出 `Error: Operation aborted`（内部 abort），被 `catch` 吞掉后返回 `null`。因此无论是否带图像、无论任务内容，`sdkQueryMessages` 永远返回空 → Browser Use Agent 全步失败。

> 关键证据：复现脚本（`scripts/repro-browser-agent.ts`，临时）用同一 provider 配置对比三种调用：
> - A. `prompt`（纯文本）→ ✅ `result/success`，返回 JSON
> - B. `messages`（纯文本）→ ❌ `THROWN: Operation aborted`，events=[]
> - C. `messages`（含图像）→ ❌ `THROWN: Operation aborted`，events=[]
>
> 即问题与图像无关，纯粹是 `messages` 参数不被 SDK 支持。

外部依据：SDK 类型定义
`node_modules/@anthropic-ai/claude-agent-sdk/sdk.d.ts:2544-2547`。

> 注：当前 provider 为第三方 DashScope（`anthropicBaseUrl=https://dashscope.aliyuncs.com/apps/anthropic`，`model=glm-5.2`），通过 Anthropic 兼容端点调用。纯文本 `sdkQuery`（用 `prompt`）在该 provider 下工作正常，证明 provider/凭据无问题。

## 4. 复现路径

1. dev server 已运行：`WEB_PORT=9898 DEEPTHINK_DATA_DIR=/tmp/deepthink-dev npm run dev:all`（Vite 5173 → API 9898）。
2. Web 端登录 → 沙箱页 → 新建沙箱（勾选「启动浏览器」）→ 浏览器子页签启动浏览器。
3. 右侧 Browser Use Agent：起始 URL `https://www.baidu.com`，任务 `打开百度搜索 DeepThink, 并截图`，点击「执行任务」。
4. 观察第 1 步立即 `failed → (空响应)`。
5. 后端日志出现 `sdkQueryMessages failed`。

或直接复现函数级调用：
```bash
DEEPTHINK_DATA_DIR=/tmp/deepthink-dev npx tsx -e "
import { sdkQueryMessages } from './src/sdk-query.js';
const r = await sdkQueryMessages([{role:'user',content:[{type:'text',text:'回复 {\"action\":{\"type\":\"done\"}}'},{type:'image',source:{type:'base64',media_type:'image/png',data:'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmWIQAAAABJRU5ErkJggg=='}}]}],{timeout:60000});
console.log(r);
"
```
修复前输出 `null`；修复后输出含 `{"action":{"type":"done"}}` 的文本。

## 5. 诊断方法

```bash
# 1) 确认 dev server 在跑
ss -tlnp | grep 5173

# 2) 查后端日志中的失败记录
grep -n 'sdkQueryMessages failed' /tmp/deepthink-dev/groups/main/logs/host-*.log

# 3) 查 SDK debug 日志（含 API 请求/流式细节）
ls -t ~/.config/DeepThink/data/sessions/main/.claude/debug/sdk-*.txt | head
grep -E 'API REQUEST|result|subtype|aborted' <最新 sdk-*.txt>

# 4) 函数级复现（见 §4 脚本）
```

判定要点：若 `sdkQueryMessages` 返回 `null` 而 `sdkQuery`（纯文本）正常，即为本 issue。

## 6. 修复方案

### 6.1 核心：`src/sdk-query.ts` —— 用 `prompt: AsyncIterable<SDKUserMessage>` 取代 `messages`

```diff
   const abortController = new AbortController();
   const timer = setTimeout(() => abortController.abort(), timeout);

   try {
     const model = opts?.model || config.anthropicModel || undefined;
     let result = '';
-    const conversation = query({
-      // SDK 接受 messages（含图像 content block）
-      messages: messages as any,
-      options: {
-        ...(model && { model }),
-        env,
-        maxTurns: 1,
-        allowedTools: [],
-        permissionMode: 'bypassPermissions' as const,
-        allowDangerouslySkipPermissions: true,
-        abortController,
-      },
-    } as any);
+    // query() 只接受 prompt（string | AsyncIterable<SDKUserMessage>），
+    // 没有 messages 参数。旧实现把 messages 直接传入被静默忽略 → prompt
+    // 缺失 → SDK 立即 abort → 返回 null → Browser Use Agent 全步空响应。
+    // SDKUserMessage.message 是 MessageParam，content 支持 text/image block，
+    // 图像截图可照常携带。
+    const promptStream = (async function* () {
+      for (const m of messages) {
+        yield {
+          type: 'user' as const,
+          message: { role: m.role, content: m.content },
+          parent_tool_use_id: null,
+        };
+      }
+    })();
+    const conversation = query({
+      prompt: promptStream as any,
+      options: { ...(model && { model }), env, maxTurns: 1, allowedTools: [],
+        permissionMode: 'bypassPermissions' as const,
+        allowDangerouslySkipPermissions: true, abortController },
+    });
```

**选型理由**：SDK 的 `SDKUserMessage.message` 字段是 `MessageParam`（来自 `@anthropic-ai/sdk`），其 `content` 原生支持 `text` 与 `image`（base64）content block。因此把现有 `{role, content}` 包装成 `{type:'user', message:{role,content}, parent_tool_use_id:null}` 的流即可，**无需改动调用方 `browser-agent.ts` 的消息构造与图像格式**，改动最小且语义正确。

### 6.2 UX：`web/src/components/sandbox/BrowserView.tsx` —— 让"启动浏览器"真正可点

原空状态文案 `点击"启动浏览器"开始` 具有误导性：浏览器视图内并无该按钮，真正的「启动浏览器」是建沙箱时的复选框。新增一个真正可点的「启动浏览器」按钮（调用 `sandboxApi.browserStart(sessionId)`），并配文案说明后续操作：

```diff
-        ) : (
-          <div className="text-neutral-500 text-sm">
-            {started ? '等待首帧...' : '点击"启动浏览器"开始'}
-          </div>
-        )}
+        ) : started ? (
+          <div className="text-neutral-500 text-sm">等待首帧...</div>
+        ) : (
+          <div className="h-full flex flex-col items-center justify-center gap-3 ...">
+            <div className="text-sm">浏览器尚未启动</div>
+            <button onClick={startBrowser} className="...emerald...">启动浏览器</button>
+            <div className="text-[11px] text-neutral-600 ...">
+              点击上方按钮启动；启动后可在工具栏输入网址回车导航，或在右侧
+              Browser Use Agent 输入任务自动操作。
+            </div>
+          </div>
+        )}
```

新增 `startBrowser` 方法：`await sandboxApi.browserStart(sessionId)`（失败 toast）。

## 7. 处理卡住的状态

无需救活 stuck 运行态：失败是每步即时返回 null 后主动 `return` 终止循环，并非进程卡死。如需重试，直接再次点击「执行任务」即可（路由层会先 `stop` 旧 run）。

## 8. 经验沉淀 / 预防

1. **勿用 `as any` 掩盖 SDK 签名**：本次根因正是 `query({ messages: ... } as any)` 绕过了类型检查。修复后已去掉 `as any`，让 `tsc` 能在未来 SDK 变更时再次暴露此类问题。
2. **失败要可观测**：`sdkQueryMessages` 的 `catch` 仅 `logger.warn` 且截断 200 字符，前端只看到"空响应"。建议后续把 `err.message` 透传到 `browser-agent` 的 step `result`，便于排障（本次未改，避免扩大 diff）。
3. **函数级回归测试**：可补一条 `sdkQueryMessages` 带图像的契约测试（mock `query()` 断言收到 `prompt` 为 AsyncIterable 且含 image block），防止回退。本次未加，因依赖真实 provider 凭据；列为后续 TODO。
4. **验证证据**：
   - 后端 `tsc --noEmit` ✅
   - 前端 `tsc --noEmit` ✅
   - `vitest` 全量 1240 用例通过（含 sandbox 相关）✅
   - 函数级实跑：修复后 `sdkQueryMessages`（带 1×1 PNG）返回 `{"action":{"type":"done","reason":"测试"}}`，`parseAction` 成功解析 ✅

> 注：要在运行中的 dev app 内复测，需重启 dev server（tsx 无热重载）使 `src/sdk-query.ts` 改动生效。
