# 知识库 URL 入库存在 SSRF：可被诱导读取云元数据服务

- **日期**：2026-10-16
- **严重度**：高（可读取云元数据凭据 / 探测内网）
- **影响范围**：`POST /api/paas/knowledge-bases/:id/documents/url`
- **引入版本**：`17d6bd1`（Agent PaaS Phase 2），**非** v1 知识库工作引入
- **状态**：已修复并有回归测试

---

## 1. 用户现象

用户（或任何能影响被入库 URL 的人）在知识库里「从 URL 添加文档」时，填入一个内网地址，例如：

```bash
curl -X POST http://127.0.0.1:9999/api/paas/knowledge-bases/<kb_id>/documents/url \
  -H 'Content-Type: application/json' -b cookies.txt \
  -d '{"url": "http://169.254.169.254/latest/meta-data/iam/security-credentials/"}'
```

**服务端会真的去请求这个地址**，并把返回内容当作文档正文解析入库。用户随后可以在知识库里全文检索这段内容——云主机的实例元数据（含临时凭据）、内网服务的响应、`http://127.0.0.1:9999` 本机管理接口，全部可读。

从外部视角看，这就是「知识库莫名其妙多出一篇文档，内容是内网才有的东西」。

## 2. 问题描述

`fetchUrlContent()` 对 URL 只做了一件事：正则匹配 `^https?://`。此后直接 `fetch(url, { redirect: 'follow' })`。

两条路径同时敞开：

1. **字面内网地址**：`http://127.0.0.1/`、`http://169.254.169.254/`、`http://100.100.100.200/`（阿里云元数据）等直接放行。
2. **重定向绕过**：即便首跳是公网地址，服务端返回 `302 Location: http://169.254.169.254/` 时，`redirect: 'follow'` 会静默跟随——**任何基于「只校验首跳」的防护都会被这一步绕过**。

此外还有第三条路径：**DNS rebinding**。攻击者控制的域名首次解析到公网 IP 通过校验，实际连接时解析到内网 IP。仅做字面量判定无法覆盖。

## 3. 根因

**代码层面**：`src/document-parser.ts` 的 `fetchUrlContent()` 从未接入平台既有的 URL 安全模块。

仓库里其实**已有**一个质量相当高的 `src/url-safety.ts`：

- `isPrivateHostname()` 覆盖 RFC1918、loopback、link-local、CGNAT `100.64/10`（含阿里云 `100.100.100.200`）、`198.18/15`、组播、保留段、IPv6 `::1`/`fc00::/7`/`fe80::/10`，并处理 `::ffff:` 十六进制形态与 FQDN 尾点；
- `validateSafeHttpsUrl()` 做字面量校验；
- `resolvePublicAddresses()` 是 DNS rebinding 的 TOCTOU 收口原语。

但它**只在 4 处被显式调用**（git URL 拉取、skill/包安装、workspace-config、result-hook），全是"自愿接入"。

**基础设施层面**：URL 安全校验没有作为**平台不变式**强制——没有 lint 规则、没有统一的 outbound-fetch 封装。新增出站请求的代码复制一段 `fetch()` 是顺手的，接入校验则需要额外想起这个模块。于是流量最大的三条路径（本 issue 的知识库 URL 入库、Agent 的 `web_fetch` 工具、可自定义 baseUrl 的 `web_search`）全部漏掉。

**外部依据**：
- [OWASP SSRF Prevention Cheat Sheet](https://cheatsheetseries.owasp.org/cheatsheets/Server_Side_Request_Forgery_Prevention_Cheat_Sheet.html) —— 明确要求「校验每一跳重定向」而非仅首跳。
- [AWS IMDS 文档](https://docs.aws.amazon.com/AWSEC2/latest/UserGuide/instancedata-data-retrieval.html) —— `169.254.169.254` 的可用性是 SSRF 危害放大的关键。

## 4. 复现路径

1. 启动隔离实例并登录：

```bash
cd ~/deepthink
export DEEPTHINK_DATA_DIR=/tmp/dt-ssrf
mkdir -p "$DEEPTHINK_DATA_DIR" && npx tsx src/admin-account-cli.js create admin 88888888
make dev-isolated ISOLATED_PORT=9899 ISOLATED_DATA_DIR=/tmp/dt-ssrf
```

2. 建一个知识库拿到 `kb_id`：

```bash
curl -s -c /tmp/dt-ssrf/c.txt -X POST http://127.0.0.1:9899/api/auth/login \
  -H 'Content-Type: application/json' -d '{"username":"admin","password":"88888888"}'
curl -s -b /tmp/dt-ssrf/c.txt -X POST http://127.0.0.1:9899/api/paas/knowledge-bases \
  -H 'Content-Type: application/json' -d '{"name":"ssrf-demo"}' | python3 -m json.tool
```

3. 提交内网 URL（本机自测用一个必然存在的内网地址即可，例如 `http://127.0.0.1:9899/health`）：

```bash
curl -s -b /tmp/dt-ssrf/c.txt -X POST \
  http://127.0.0.1:9899/api/paas/knowledge-bases/<kb_id>/documents/url \
  -H 'Content-Type: application/json' \
  -d '{"url":"http://127.0.0.1:9899/health"}'
```

修复前：返回 201，文档入库成功，内容为本机 `/health` 的响应体。
修复后：返回 400，`{"error":"Blocked URL: Hostname not allowed (private/link-local): 127.0.0.1"}`。

## 5. 诊断方法

**静态定位**——找出所有未接入校验的出站请求：

```bash
cd ~/deepthink

# 1. 校验模块被谁调用了（应当覆盖所有用户可控 URL 的出站路径）
grep -rn "validateSafeHttpsUrl\|resolvePublicAddresses\|assertResolvesToPublicAddress" src/ | grep -v url-safety.ts

# 2. 全仓 fetch() 调用点，逐个人工判定是否用户可控
grep -rn "fetch(" src/ --include=*.ts | grep -v node_modules
```

**运行时验证**——单测直接断言「拒绝时不应发出请求」：

```bash
cd ~/deepthink
npx vitest run tests/units/document-parser-ssrf.test.ts
```

关键断言不是「抛异常」，而是 `expect(fetchMock).not.toHaveBeenCalled()` —— 只抛异常但已经发出了请求，等于没防住。

## 6. 修复方案

**选型理由**：平台已有 `url-safety.ts` 且质量高于一般实现，因此**接入既有模块，不重写防护逻辑**（Simplicity First / Surgical Changes）。改动集中在 `fetchUrlContent` 一个函数内，调用方 `paas-knowledge-bases.ts:431` 无需改动。

```diff
 import type { Buffer } from 'node:buffer';
+import { assertResolvesToPublicAddress, validateSafeHttpsUrl } from './url-safety.js';
 
+/** 重定向跳数上限。设为 0 可禁用跟随（URL 入库不需要跨站跳转）。 */
+const MAX_REDIRECTS = 5;
+
+/**
+ * 校验单个跳转目标。字面量判定（快，且填内网字面 IP 时不依赖网络）之后
+ * 再做 DNS 解析判定——域名可以指向内网，只查字面量会漏。
+ */
+async function assertSafeFetchTarget(rawUrl: string): Promise<void> {
+  const reason = validateSafeHttpsUrl(rawUrl, { allowHttp: true });
+  if (reason) {
+    throw new Error(`Blocked URL: ${reason}`);
+  }
+  await assertResolvesToPublicAddress(new URL(rawUrl).hostname, 'URL hostname');
+}
+
 export async function fetchUrlContent(url: string, opts?: { timeoutMs?: number; maxBytes?: number }): Promise<string> {
   const timeoutMs = opts?.timeoutMs ?? 15_000;
   const maxBytes = opts?.maxBytes ?? 1_000_000;
 
-  if (!/^https?:\/\//i.test(url)) {
-    throw new Error('Only http(s) URLs are supported');
-  }
-
   const controller = new AbortController();
   const timer = setTimeout(() => controller.abort(), timeoutMs);
   try {
-    const res = await fetch(url, {
-      signal: controller.signal,
-      redirect: 'follow',
-      headers: { 'User-Agent': 'DeepThink-KB-Fetcher/1.0' },
-    });
-    if (!res.ok) {
-      throw new Error(`Fetch failed: ${res.status} ${res.statusText}`);
-    }
-    const contentType = res.headers.get('content-type') ?? '';
-    if (!/text\/(html|plain)/i.test(contentType) && !/xml/i.test(contentType)) {
-      throw new Error(`Unsupported content type: ${contentType}`);
+    // 逐跳校验：`redirect: 'follow'` 只校验首跳，一个指向内网的重定向即可绕过。
+    let current = url;
+    for (let hop = 0; ; hop++) {
+      await assertSafeFetchTarget(current);
+
+      const res = await fetch(current, {
+        signal: controller.signal,
+        redirect: 'manual',
+        headers: { 'User-Agent': 'DeepThink-KB-Fetcher/1.0' },
+      });
+
+      if (res.status >= 300 && res.status < 400) {
+        const location = res.headers.get('location');
+        if (!location) {
+          throw new Error(`Redirect (${res.status}) without Location header`);
+        }
+        if (hop >= MAX_REDIRECTS) {
+          throw new Error(`Too many redirects (max ${MAX_REDIRECTS})`);
+        }
+        current = new URL(location, current).toString();
+        continue;
+      }
+
+      if (!res.ok) {
+        throw new Error(`Fetch failed: ${res.status} ${res.statusText}`);
+      }
+      const contentType = res.headers.get('content-type') ?? '';
+      if (!/text\/(html|plain)/i.test(contentType) && !/xml/i.test(contentType)) {
+        throw new Error(`Unsupported content type: ${contentType}`);
+      }
+      const html = await res.text();
+      const truncated = html.length > maxBytes ? html.slice(0, maxBytes) : html;
+      return stripHtml(truncated);
     }
-    const html = await res.text();
-    const truncated = html.length > maxBytes ? html.slice(0, maxBytes) : html;
-    return stripHtml(truncated);
   } finally {
     clearTimeout(timer);
   }
```

**三处关键决定**：

| 决定 | 理由 |
|---|---|
| `allowHttp: true` | 保持既有行为（原实现允许 http）。本 issue 的漏洞是**内网可达**，不是传输明文；把 http 一并禁掉属于超范围变更。 |
| 字面量 → DNS 两级校验 | 字面内网 IP 不依赖网络即可拒绝（快，且离线可测）；域名必须查 DNS 才能覆盖 rebinding。 |
| `redirect: 'manual'` + 逐跳校验 | `follow` 让所有首跳校验形同虚设。改为手动循环后，每一跳都走同一套校验，并限制跳数。 |

**未做**（有意）：未把 socket 钉到已校验 IP。彻底关闭 DNS rebinding 的 TOCTOU 窗口需要在连接层固定地址（上游 `url-safety.ts` 注释中提到的 safe-git-proxy 思路），改动面涉及自定义 agent/dispatcher，超出本 issue 范围。当前实现把窗口从「任意」收窄到「解析与连接之间的毫秒级」，并已在注释中如实标注。

**测试**：新增 `tests/units/document-parser-ssrf.test.ts`，21 例。**已用修复前代码验证其中 16 例会失败**——包括「云元数据地址被拒且未发出请求」在修复前失败（即旧代码确实发出了请求）。这是漏洞成立的客观证据，而非推断。

```
修复前：Tests 16 failed | 5 passed (21)
修复后：Tests 21 passed (21)
```

5 例在修复前也通过：`file://` 协议拒绝与「既有行为不回退」组（404 / content-type / maxBytes），符合预期。

## 7. 处理卡住的状态

不适用——本 issue 是安全防护缺失，不涉及卡住的运行态。

若线上已有实例曾被填入内网 URL，清理方式（先列出可疑 URL 对应的文档再决定是否删除）：

```bash
curl -s -b cookies.txt "http://127.0.0.1:9999/api/paas/knowledge-bases/<kb_id>/documents" \
  | python3 -c "import sys,json;[print(d['id'],d.get('source_url',''),d['filename']) for d in json.load(sys.stdin)['documents']]"
```

## 8. 经验沉淀 / 预防

**同类问题的根因是「防护自愿接入」，不是「防护不存在」。** 只修这一处，下一条出站路径还会再犯。因此：

1. **仍有两条已知未接入的路径，已在 PRD `§2.9` 登记**，不得视为已解决：
   - `container/agent-runner/src/mcp-tools.ts:2809`（Agent `web_fetch` 工具，`redirect: 'follow'`）
   - `container/agent-runner/src/web-search.ts:355`（可自定义 baseUrl 的搜索后端）

2. **巡检建议**——把「出站请求必须经过校验」变成可自动检查的约束：

```bash
# 定期跑：列出所有 fetch( 调用点，人工核对是否都在白名单内
grep -rn "fetch(" src/ container/agent-runner/src/ --include=*.ts | grep -v node_modules
```

更强的做法是引入统一的 `safeFetch()` 封装并禁止裸 `fetch()`，但那是架构级改动，应单独立项。

3. **告警建议**：知识库 URL 入库的失败日志中，`Blocked URL` 前缀应单独计数并告警——**正常用户不会填内网地址，一旦出现就是有人在试探**。

4. **给未来自己的提醒**：写「拒绝」类断言时，`expect(fn).rejects.toThrow()` 是不够的——必须同时断言**副作用未发生**（此处即 `fetch` 未被调用）。只抛异常但已经发出请求，等于没防住，而这类测试会给人虚假的安全感。
