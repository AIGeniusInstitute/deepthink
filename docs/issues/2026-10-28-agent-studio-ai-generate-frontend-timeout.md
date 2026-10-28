# Agent Studio「AI 生成」报错：AI 生成失败（provider 可能不可用或超时）

> 日期：2026-10-28
> 影响面：Agent Studio 新建 Agent 的「AI 生成」按钮、Agent 详情页「AI 优化」按钮（同一请求契约）
> 运行环境：DeepThink 桌面版（Windows），前端为打包产物 `resources/web-dist`

## 1. 用户现象

在 Agent Studio 点「新建 Agent」，填写描述后点 **AI 生成**，按钮转圈几秒后弹出红色 toast：

```
AI 生成失败（provider 可能不可用或超时）
```

表单不被填充，重试多次同样报错。而同一台机器上 Agent 对话、Skills 的 AI 生成均正常，
Claude provider（`xiaomi/mimo-v2.6-pro` + 自建网关）在设置页自检也正常——所以
「provider 不可用」的提示明显不符合实际。

## 2. 问题描述

两个独立缺陷叠加在同一用户旅程上：

**缺陷 A（主因）：前端默认 8s 超时把还在跑的 LLM 请求 abort 掉。**

- 后端 `POST /api/paas/agents/generate` 走 `generateAgentContent()` → `sdkQuery()`，
  LLM 预算 `GENERATION_TIMEOUT_MS = 90_000`（`src/agent-ai.ts`），实测整链 **22~30 秒**。
- 前端 `api.post()` 不传 `timeoutMs` 时走 `REQUEST_TIMEOUT_MS = 8000`
  （`web/src/api/client.ts`），8 秒一到 `AbortController` 直接掐断请求。
- 于是无论后端成功与否，用户必然在 8 秒看到失败 toast；请求实际上还在后端正常跑完。
- 同类的 Skills AI 生成（`createSkill`/`optimizeSkill`/`debugSkill`）都显式传了
  150s/90s 超时，唯独 agents-paas 这两个调用漏了——这是**遗漏**，不是设计取舍。

**缺陷 B（次因）：模型偶发输出不可解析的 JSON，后端 502。**

- 模型在 `system_prompt` 的字符串值里写未转义的 ASCII 双引号，例如
  `问题清单填写"未发现阻断性问题"`，JSON 字符串提前闭合，`JSON.parse` 失败。
- 实测约 **1/6** 的采样命中（随机），命中时后端返回
  `502 {"error":"AI generated invalid JSON ..."}`。
- 该失败此前**不落任何日志**（路由直接 `return c.json({error}, 502)`），
  前端又把错误吞掉只报笼统文案，导致线上完全无从定位。

## 3. 根因

### 缺陷 A

`web/src/stores/agents-paas.ts` 的 `generateAgent` / `optimizeAgent` 调 `api.post` 时
**没有传第三个参数 `timeoutMs`**，落进 `web/src/api/client.ts` 的默认值：

```ts
const REQUEST_TIMEOUT_MS = 8000;                       // 前端默认 8s
const timeout = setTimeout(() => controller.abort(), timeoutMs);
```

而后端 LLM 预算是 90s（`src/agent-ai.ts`），一次真实生成实测 22~30s：
**8s < 22s，请求永远不可能在前端超时前返回**。打包产物 `web-dist/assets/index-*.js`
里同样只有 `8e3`，且 `generateAgent:async n=>{...catch{return null}}` 把错误吞成 `null`，
页面只能显示写死的「provider 可能不可用或超时」。

### 缺陷 B

LLM 生成的 JSON 字符串值里偶发未转义 ASCII 双引号（示例见 §2），
`src/agent-ai.ts` 的 `JSON.parse` 失败后直接返回502，无重试、无日志、无原始输出留痕。

## 4. 复现路径

### 缺陷 A（必现）

1. 打开 Agent Studio → 新建 Agent，描述填 ≥10 字符的任意内容。
2. 点「AI 生成」，观察 **恰好 8 秒** 后弹出失败 toast。
3. 同时在后端日志中看不到任何 `sdkQuery failed` / 错误（后端其实跑成功了）。
4. 等价 curl 复现（见 §5）：`--max-time 8` 必然 exit 28，`--max-time 150` 返回 200。

### 缺陷 B（随机，约 1/6）

1. 用 §5 的采样脚本连续请求 6 次生成接口。
2. 其中约 1 次返回 `502 {"error":"AI generated invalid JSON ..."}`。
3. 抓原始模型输出可看到字符串值内未转义引号。

## 5. 诊断方法

**① 确认后端生成链路是否真的坏**（排除 provider 因素）——用 scratch 数据目录 +
provider 配置副本直接跑后端真实函数，只打印耗时与结果，不打印凭据：

```powershell
# 私有配置只做不透明拷贝（含解密密钥），脚本不输出任何密钥字段
New-Item -ItemType Directory -Force "$env:TEMP\dt-diag\config" | Out-Null
Copy-Item "$env:APPDATA\DeepThink\data\config\claude-provider.json" "$env:TEMP\dt-diag\config\"
Copy-Item "$env:APPDATA\DeepThink\data\config\claude-provider.key"  "$env:TEMP\dt-diag\config\"
npx tsx probe-generate.ts   # import generateAgentContent 并计时
```

实测输出（关键行）：

```
provider config: hasBaseUrl=true hasAuthToken=true model=xiaomi/mimo-v2.6-pro
OK after 27.1s
fields.name=代码评审助手
```

→ 后端链路健康，单次生成 22~30s。**8s 的前端超时注定失败。**

**② 端到端复现前端 abort**（隔离实例 + curl 等价前端两个超时档位）：

```bash
curl -s -b cookie.txt -X POST http://127.0.0.1:9912/api/paas/agents/generate \
  -H "Content-Type: application/json" \
  -d '{"name":"代码评审助手","description":"一个帮助团队做代码评审的 Agent：…"}' \
  --max-time 8   -w "HTTP=%{http_code} time=%{time_total}s\n"   # 旧前端：exit 28
curl ... --max-time 150  # 修后前端：HTTP=200 time≈25s
```

实测：`--max-time 8` → `curl exit=28`，`time=8.00s`（用户看到的 toast）；
`--max-time 150` → `HTTP=200 time=23.5~26.0s`，`{"fields":{...}}`。

**③ 定位缺陷 B 的坏样本形态**——把模型原始输出直接打出来（`sdkQuery` 拿原文），
再复刻 `stripCodeFences + extractJsonObject + JSON.parse` 管线看哪一步炸：

```
[1] FAIL len=1792 reason=Expected ',' or '}' after property value in JSON at position 830
    …清单填写"未发现阻断性问题"…        ← 字符串值里的裸 ASCII 引号
```

**④ 看后端日志**（本次修复后生效）：`Agent AI generate failed` / `Agent AI optimize failed`
warn 日志会带上真实 error；解析重试会打 `agent-ai: LLM returned unparseable JSON, retrying`。

## 6. 修复方案

### 6.1 前端：给 AI 生成/优化请求显式放宽超时 + 把真实错误透出到 UI

```diff
// web/src/stores/agents-paas.ts
+// AI 生成/优化走后端 LLM 调用（src/agent-ai.ts 预算 90s）。apiFetch 默认 8s 会提前
+// abort 掉仍在跑的生成请求（实测整链约 27s），必须显式放宽，与 skills 的 AI 生成一致。
+const AI_GENERATE_TIMEOUT_MS = 150_000;

 generateAgent: async (data) => {
-  try {
-    const res = await api.post<{ fields: GeneratedAgentFields }>('/api/paas/agents/generate', data);
-    return res.fields ?? null;
-  } catch {
-    return null;                      // 吞掉真实原因 → 页面只能报笼统文案
-  }
+  const res = await api.post<{ fields: GeneratedAgentFields }>(
+    '/api/paas/agents/generate', data, AI_GENERATE_TIMEOUT_MS,
+  );
+  return res.fields ?? null;          // ApiError 透传，message = 后端 body.error
 },
```

`optimizeAgent` 同样补 `AI_GENERATE_TIMEOUT_MS` 并透传错误；
`AgentStudioPage.handleGenerate` / `OptimizeAgentDialog.handleOptimize` 增加 catch，
toast 改为 `AI 生成失败：<真实原因>`（408 时提示超时）。

选型理由：
- 与既有约定对齐——Skills 的 AI 生成同样传 150s（后端预算 90s + 余量），不引入第三种超时档位。
- 透传 `ApiError.message`（= 后端 `body.error`）而不是自造文案，是把「不可定位」变成「可定位」的关键。
- 不改 `api/client.ts` 的全局 8s 默认值：那会影响全部 ~200 个普通 CRUD 调用的报错时效，
  与本次问题无关（Surgical Changes）。

### 6.2 后端：不可解析的 LLM JSON 重试一次 + 失败落日志

```diff
// src/agent-ai.ts
+const PARSE_RETRY_ATTEMPTS = 2;   // 只对「有响应但解析失败」重试；空响应/超时不重试
+
+async function queryAndParseJson(prompt, timeoutMs) {
+  for (let attempt = 1; attempt <= PARSE_RETRY_ATTEMPTS; attempt++) {
+    const result = await sdkQuery(prompt, { timeout: timeoutMs });
+    if (!result || result.trim().length === 0) return { error: 'empty' };
+    const obj = tryParseJsonObject(result);
+    if (obj) return { obj };
+    logger.warn({ attempt, snippet: result.slice(0, 200) },
+      'agent-ai: LLM returned unparseable JSON, retrying');
+  }
+  return { error: 'invalid' };
+}

// src/routes/paas-agents.ts（/generate 与 /:id/optimize）
 if ('error' in result) {
+  logger.warn({ userId: user.id, err: result.error }, 'Agent AI generate failed');
   return c.json({ error: result.error }, 502);
 }
```

选型理由：
- 坏样本是随机的（约 1/6），**重试一次**是最小且有效的兜底；不做启发式 JSON 修补
  （容易把合法内容改坏）。
- 只对解析失败重试，不对空响应/超时重试——provider 真不可用时不能把等待时间翻倍
  （前端预算150s，单次预算90s，两次 90s 会互相挤掉）。
- 错误文案从「provider may be unavailable or misconfigured」改为「model output not
  parseable」——本次排障正是被这句误导。

### 6.3 回归测试

- `tests/agents-paas-ai-generate.test.ts`（5 用例）：锁请求契约——两个 AI 调用必须带
  `timeoutMs ≥ 后端 LLM 预算 90s`；失败必须抛出后端真实原因，不允许吞成 `null`。
- `tests/agent-ai-json-parse.test.ts`（6 用例）：锁重试语义——解析失败重试一次；
  连续两次失败返回 invalid 错误；空响应不重试；首次合法不重试。

## 7. 处理卡住的状态

无运行态卡住需要救活。注意：**桌面版是打包产物**，仓库修复要重新打包/升级后才会
到达用户端；在升级前用户可临时把描述写得更短或改用 Skills 的 AI 生成（其超时是正确的）。

## 8. 经验沉淀 / 预防

1. **凡后端是 LLM 调用的接口，前端必须显式传 `timeoutMs`，且 > 后端 LLM 预算。**
   `api/client.ts` 的 8s 默认值只适用于 CRUD。建议后续把
   「后端预算 → 前端超时」做成常量对照表或 lint 约定；本次新增测试已把该契约锁在
   agents-paas 域内。
2. **502/错误分支必须落日志**。本次最耗时的一步就是：前端只有笼统 toast、后端 502
   静默、`sdkQuery failed` 又没触发（因为后端其实成功了）——三个信号面互相矛盾，
   排障只能靠搭隔离实例复测。`src/routes/paas-agents.ts` 现已补 warn 日志。
3. **LLM JSON 输出要按「可能坏」设计**：解析失败重试 + 记录原始片段。后续若仍见
   `agent-ai: LLM returned unparseable JSON` 日志，可考虑改用工具调用（tool-use）
   强约束 schema 输出，从根上消除转义问题。
4. **巡检建议**：对 `Agent AI generate failed` / `retrying` 日志做阈值告警；
   两者同时升高通常意味着 provider 或模型行为退化。
5. 诊断用的 scratch 数据目录（provider 配置副本含解密密钥）用完必须删除，别留在 %TEMP%。
