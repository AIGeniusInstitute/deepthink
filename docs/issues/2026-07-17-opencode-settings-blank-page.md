# OpenCode 引擎配置页白屏（apiKey 脱敏导致前端崩溃 + 保存 400）

> 修复日期：2026-07-17
> 影响页面：`/settings?tab=opencode`
> 严重度：高（页面完全不可用 + 已有配置无法保存）

## 1. 用户现象

用户在 OpenCode 引擎设置页配置好 provider（含 API Key）并保存后，再次访问
`http://127.0.0.1:9898/settings?tab=opencode` 时**整个页面空白**。打开浏览器
控制台可见两类报错：

```
SettingsPage-CL-LB321.js:181 Uncaught TypeError: Cannot read properties of undefined (reading 'startsWith')
    at SettingsPage-CL-LB321.js:181:59794
    at Array.map (<anonymous>)
    at NM (SettingsPage-CL-LB321.js:181:58498)
    ...
```

> 注：`chrome-extension://…/content_script.js:5157 Uncaught TypeError: b.getContext is not a function`
> 来自某个浏览器扩展注入的 content script，与本 bug 无关，忽略。

## 2. 问题描述

`GET /api/config/opencode` 的公开响应（`toPublicOpencodeConfig`）出于脱敏目的，
把每个 provider 的 `apiKey` 字段**整段移除**，只保留 `hasApiKey: boolean` 标志位。
但前端 `OpencodeEngineSection` 把 `apiKey` 当作**必填字符串**直接调用
`p.apiKey.startsWith('****')`——拿到的却是 `undefined`，于是
`undefined.startsWith` 抛 `TypeError`，发生在 `cfg.providers.map(...)` 渲染循环里，
整个 `SettingsPage` 渲染中断 → 白屏。

同时还有一个被白屏掩盖的关联 bug：保存流程本身也是坏的。前端把公开响应原样回
`PUT /api/config/opencode` 时，provider 缺 `apiKey` 字段，而后端
`OpencodeProviderSchema` 要求 `apiKey: z.string().min(1)`，`safeParse` 直接 400，
路由里写好的 keep-existing 恢复逻辑（按 id 从当前配置补回 apiKey）根本没机会执行。

## 3. 根因

代码层面：**前后端对 `apiKey` 字段的契约不一致**。

- 后端公开类型 `PublicOpencodeConfig`（`src/runtime-config.ts:4317-4321`）：
  ```ts
  providers: Array<Omit<OpencodeProvider, 'apiKey'> & { hasApiKey: boolean }>;
  ```
  `toPublicOpencodeConfig`（`src/runtime-config.ts:4443`）通过解构
  `const { apiKey, ...restP } = p;` 把 apiKey 丢弃。
- 前端类型 `OpencodeProvider`（`OpencodeEngineSection.tsx:12-19`）声明
  `apiKey: string`（必填），渲染处 `p.apiKey.startsWith('****')` 无空值保护。
- 后端 `OpencodeProviderSchema`（`src/schemas.ts:332-338`）要求
  `apiKey: z.string().min(1).max(512)`，缺字段即校验失败。

外部依据：
- Zod 默认 strip 模式会剥掉未知字段（`hasApiKey` 被剥），但**缺失的必填字段会报
  invalid`** —— 这是 400 的来源。
- React 渲染期抛错会卸载整个组件树，导致白屏。

## 4. 复现路径

1. 启动 DeepThink（`make start`）并以 admin 登录。
2. 进入 `/settings?tab=opencode`，启用引擎，添加一个 provider：填 id/name/baseURL/
   models/API Key，点击「保存配置」。首次保存成功（因为用户手填了 apiKey，schema
   通过）。
3. 刷新或重新进入 `/settings?tab=opencode`。
4. 页面白屏，控制台报 `Cannot read properties of undefined (reading 'startsWith')`。

附带验证保存 400：在白屏修复后再次进入页面（此时能看到表单，apiKey 输入框为空、
placeholder 显示「已保存」），**不重填 apiKey** 直接点「保存配置」→ 修复前返回
400 `Invalid config`。

## 5. 诊断方法

```bash
# 1. 查看后端公开响应是否真的没有 apiKey
curl -sb cookie.txt http://127.0.0.1:9898/api/config/opencode | jq '.providers[0] | {hasApiKey, apiKey}'
# 修复前：{ "hasApiKey": true, "apiKey": null }（apiKey 字段被剥掉）
# 前端拿到这个再 .startsWith 必崩

# 2. 复现保存 400（用上一步拿到的公开响应原样回 PUT）
curl -sb cookie.txt http://127.0.0.1:9898/api/config/opencode > /tmp/oc.json
# 去掉每个 provider 的 hasApiKey 之外什么也没动，直接回存
curl -X PUT -b cookie.txt -H 'Content-Type: application/json' \
  --data-binary @/tmp/oc.json http://127.0.0.1:9898/api/config/opencode
# 修复前：400 {"error":"Invalid config", ...providers[0].apiKey Required...}

# 3. 跑回归测试
npx vitest run tests/units/opencode-config-roundtrip.test.ts
```

## 6. 修复方案

核心思路：让前后端契约对齐——**`apiKey` 在公开往返中是可选的**，前端空值安全，
后端 schema 接受缺省并由路由按 id 补回原值。

### 6.1 前端 `OpencodeEngineSection.tsx`

`apiKey` 改可选，渲染用 `?? ''` + `hasApiKey`，删除脱离实际的 `startsWith('****')`
死分支（后端从不返回 `****` 形态的 apiKey，它直接剥字段）：

```diff
 interface OpencodeProvider {
   id: string;
   name: string;
-  apiKey: string;
+  /** GET /api/config/opencode 公开响应中不返回 apiKey，仅为本地编辑态存在 */
+  apiKey?: string;
   baseURL: string;
   models: string[];
   hasApiKey?: boolean;
 }
```

```diff
-  value={p.apiKey.startsWith('****') ? '' : p.apiKey}
-  onChange={(e) => updateProvider(i, { apiKey: e.target.value })}
-  placeholder={p.apiKey.startsWith('****') || p.hasApiKey ? `已保存 (${p.apiKey.startsWith('****') ? p.apiKey : '****'})` : 'sk-...'}
+  value={p.apiKey ?? ''}
+  onChange={(e) => updateProvider(i, { apiKey: e.target.value })}
+  placeholder={p.hasApiKey ? '已保存（留空保留原值）' : 'sk-...'}
```

### 6.2 后端 schema `src/schemas.ts`

`apiKey` 改可选，让缺省 provider 通过校验进入 keep-existing 逻辑：

```diff
 export const OpencodeProviderSchema = z.object({
   id: z.string().min(1).max(64),
   name: z.string().min(1).max(64),
-  apiKey: z.string().min(1).max(512),
+  // 公开 GET 响应不返回 apiKey；PUT 时空/缺省表示保留原值（见路由 keep-existing 逻辑）
+  apiKey: z.string().min(1).max(512).optional(),
   baseURL: z.string().min(1).max(512),
   models: z.array(z.string().min(1).max(128)).min(1),
 });
```

### 6.3 路由 keep-existing 提取为纯函数 `src/runtime-config.ts`

把内联在 `PUT /api/config/opencode` 里的 masking 逻辑提取为可测的
`resolveOpencodeProvidersForSave(input, current)`：缺省/`****` 遮蔽的 apiKey 按 id
从 current 恢复；仍无 key 的未填新条目被丢弃（与 `sanitizeOpencodeProviders` 一致）。
路由侧改为调用它：

```diff
-  if (data.password === undefined) {
-    const current = getOpencodeConfig();
-    data.password = current.password;
-  }
-  if (Array.isArray(data.providers)) {
-    const current = getOpencodeConfig();
-    const currentById = new Map(current.providers.map((p) => [p.id, p.apiKey]));
-    data.providers = data.providers.map((p) => { ... });
-  }
-  const saved = saveOpencodeConfig(data);
+  const current = getOpencodeConfig();
+  const password = data.password === undefined ? current.password : data.password;
+  const providers = Array.isArray(data.providers)
+    ? resolveOpencodeProvidersForSave(data.providers, current.providers)
+    : undefined;
+  const saved = saveOpencodeConfig({ ...data, password, providers });
```

选型理由：
- **不改为返回脱敏占位字符串**（如 `****`）——会污染真实 key 长度信息、且需前端再
  剥离，更复杂。剥字段 + `hasApiKey` 标志位是更干净的数据契约。
- **提取纯函数**而非保留内联——keep-existing 是本次修复的核心逻辑，提取后路由与
  测试共用同一份真实代码（Goal-Driven：可验证）。
- 前端只改最小渲染逻辑，不动表单结构。

### 6.4 回归测试 `tests/units/opencode-config-roundtrip.test.ts`

5 个用例覆盖：公开响应剥 apiKey、schema 接受缺省 apiKey、按 id 恢复 key、丢弃未填
新条目、纯函数 round-trip。

## 7. 处理卡住的状态

- 白屏状态下页面无法操作，但后端配置文件
  `data/config/opencode.json` 本身完好（首次保存已成功）。修复后刷新即可恢复。
- 如需手动核验配置未丢 key：
  ```bash
  sudo cat data/config/opencode.json | jq '.providers[] | {id, hasKey: (.apiKey | length > 0)}'
  ```
  （文件由 `writeSecretFile` 写入 0600 权限，需对应权限读取。）

## 8. 经验沉淀 / 预防

- **教训**：脱敏 API 的公开类型与内部类型不同字段集时，前端类型必须镜像公开类型
  （可选字段 + 标志位），不能直接复用内部必填类型。本次前端 `OpencodeProvider` 照抄
  了内部 `OpencodeProvider`（apiKey 必填），却用来接收公开响应，是根因。
- **预防**：建议把 `PublicOpencodeConfig` 类型也导出并在前端复用（单一真相源），
  而非在前端重写一份易漂移的接口。后续可作为一个独立小重构。
- **巡检**：`grep -rn "apiKey.startsWith\|\.apiKey\." web/src/` 检查前端是否还有把
  脱敏字段当必填字符串用的残留。
- **测试**：已补 `opencode-config-roundtrip.test.ts`，覆盖「公开响应缺 apiKey 字段
  → 前端回存 → schema 通过 → keep-existing 恢复」全链路，防止回归。
