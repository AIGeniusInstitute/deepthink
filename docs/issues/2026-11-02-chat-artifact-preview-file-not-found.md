# Agent 对话产物渲染 404 `{"error":"File not found"}`

## 1. 用户现象

Agent 在对话里产出 HTML 调研报告并给出链接：

```
深度调研完成，报告已产出：
[`docs/research/游戏空间与出行空间深度调研-report.html`](docs/research/游戏空间与出行空间深度调研-report.html)
```

Web 聊天界面把该链接渲染成产物卡片（工具条显示 `HTML` + 文件路径，路径显示正确），
但卡片正文（sandbox iframe）里显示的不是报告，而是后端返回的 JSON：

```json
{"error":"File not found"}
```

文件其实好好地躺在工作区里，文件面板也能看到，只有对话流里的产物预览 404。
**中文文件名的产物 100% 复现**；纯 ASCII 文件名的产物不受影响。

## 2. 问题描述

前端产物渲染把 markdown 链接的 **href（URI）** 直接当成**工作区相对路径**拼进
`/api/groups/:jid/files/preview/:path`。而 react-markdown 的 remark/micromark 管线
（`micromark-util-sanitize-uri` 的 `normalizeUri`）会把链接目的地里的非 ASCII 字符
做百分号编码——中文文件名会变成 `%E6%B8%B8…` 形式。于是：

- 前端请求的路径 = `docs/research/%E6%B8%B8%E6%88%8F…-report.html`
- 后端在磁盘上按**字面** `%E6%B8%B8…` 文件名查找 → `fs.existsSync` = false
- 返回 404 `{"error":"File not found"}`（`src/routes/files.ts` preview 路由）

卡片头部的文件名显示正常，是因为它取自**链接文本**（未编码），与 href 无关——
所以现象是"路径显示对、内容 404"，极具迷惑性。

## 3. 根因

代码层面，两段拼接缺少一次 URI → 路径的解码：

1. `web/src/components/chat/MarkdownRenderer.tsx` 的 `a` / `img` 处理器把
   react-markdown 传来的 `href` / `src`（percent-encoded）直接写进
   `ArtifactSource.filePath` / `resolveImageSrc(src)`；
2. `web/src/components/chat/artifacts/useArtifactUrl.ts` 对该字符串做
   `toBase64Url` 后拼 `/files/preview/{encoded}`；
3. 后端 `src/routes/files.ts` 的 preview/download/content 等路由
   `Buffer.from(encodedPath, 'base64url')` 解出的仍是 `%E6…` 字面路径，
   `validateAndResolvePath(group.folder, relativePath, getFileRootOverride(group))`
   解析出的绝对路径指向一个不存在的文件名 → 404。

外部依据：CommonMark 规范中链接目的地即 URL，micromark 按 URL 语义对非 ASCII
字符做 percent-encode（`normalizeUri`），这是**规范行为**而非 bug；问题在于
DeepThink 的文件 API 期望的是文件系统路径，两者之间缺一次 `decodeURIComponent`。

实测四组输入（remark-parse@11 + remark-rehype 管线输出的 href）：

| markdown 源里的目的地 | 管线输出的 href |
|---|---|
| `docs/research/游戏空间与出行空间深度调研-report.html` | `docs/research/%E6%B8%B8%E6%88%8F…%E7%A0%94-report.html` |
| `docs/research/%E6%B8%B8%E6%88%8F-space-report.html`（Agent 预编码） | 原样保留（不二次编码） |
| `docs/100%-report.html`（文件名带裸 `%`） | `docs/100%25-report.html` |
| `docs/100%25-report.html` | 原样保留 |

结论：**单次 `decodeURIComponent`（非法序列回退原文）对所有情形恰好正确**。

## 4. 复现路径

1. 打开任一工作区（`custom_cwd` 或默认 `data/groups/{folder}` 都一样），让 Agent 产出一个**中文文件名**的 HTML 报告，例如 `docs/research/测试报告.html`；
2. 让 Agent 在回复里用 markdown 链接引用它（Claude 引用产物的惯用写法）；
3. 刷新 Web 聊天页，点击/展开该消息的产物卡片 → 卡片正文显示 `{"error":"File not found"}`；
4. 对照：同一条消息里英文文件名的产物预览正常。

## 5. 诊断方法

**① 验证 remark 管线确实编码了 href**（在 `web/` 依赖环境下）：

```js
// node 脚本，require 路径指向 web/ 以复用其 node_modules
const { createRequire } = require('module');
const require2 = createRequire(require('path').resolve('web/package.json'));
const { unified } = require2('unified');
const remarkParse = require2('remark-parse').default;
const remarkRehype = require2('remark-rehype').default;
const md = '[t](docs/research/游戏空间与出行空间深度调研-report.html)';
const tree = unified().use(remarkParse).use(remarkRehype)
  .runSync(unified().use(remarkParse).use(remarkRehype).parse(md));
const walk = (n) => {
  if (n.tagName === 'a') console.log('href:', n.properties.href);
  (n.children || []).forEach(walk);
};
walk(tree);
// 输出: href: docs/research/%E6%B8%B8%E6%88%8F%E7%A9%BA%E9%97%B4...（被百分号编码）
```

**② 确认消息原文与磁盘文件一致**（排除文件真不存在 / Unicode 归一化差异）：

```bash
# 从消息库里取 Agent 输出的链接目的地
node -e "const db=require('better-sqlite3')('<DATA_DIR>/db/messages.db',{readonly:true});
const r=db.prepare(\"SELECT content FROM messages WHERE content LIKE '%报告已产出%' ORDER BY id DESC LIMIT 1\").get();
console.log(r.content.match(/\]\(([^)]+)\)/)[1]);"
ls <custom_cwd>/docs/research/   # 对照磁盘文件名
```

**③ 直接请求 preview 端点**（原始路径 200 vs 编码路径 404，即根因的直接证据）：

```js
// 铸一个临时会话（用 data/config/session-secret.key 做 HMAC 签名），
// 分别请求 base64url(原始路径) 与 base64url(百分号编码路径)：
const rel = 'docs/research/游戏空间与出行空间深度调研-report.html';
const url = `http://localhost:${PORT}/api/groups/${encodeURIComponent('web:main')}/files/preview/${Buffer.from(rel).toString('base64url')}`;
// → 200 text/html（报告内容）
const enc = encodeURI(rel); // 模拟 remark 输出
const url2 = `http://localhost:${PORT}/api/groups/${encodeURIComponent('web:main')}/files/preview/${Buffer.from(enc).toString('base64url')}`;
// → 404 {"error":"File not found"}   ← 修复前前端请求的就是这种 URL
```

## 6. 修复方案

在 **markdown URI → filePath 边界**（`MarkdownRenderer` 的 `a` / `img` 入口与
`resolveImageSrc`）解码一次。选这里而不是 `useArtifactUrl` 内部解码，是因为
`ArtifactSource.filePath` 还有别的消费方（下载文件名、复制路径），在源头统一成
真实路径语义更干净，且避免对已经解码过的路径二次解码（文件名带字面 `%` 时会错）。

```diff
--- a/web/src/components/chat/artifacts/types.ts
+++ b/web/src/components/chat/artifacts/types.ts
+/**
+ * 将 markdown 链接/图片的 URI 还原为工作区相对路径。
+ * remark/micromark 的 normalizeUri 会对链接目的地做百分号编码，中文等非 ASCII
+ * 文件名会被编码成 %XX 序列；文件 API 期望磁盘上的真实相对路径，直接把 href 当
+ * 路径会按字面 "%E6…" 文件名找文件 → 404 {"error":"File not found"}。
+ * 非法 %XX 序列原样返回。
+ */
+export function decodeMarkdownPath(uri: string): string {
+  try {
+    return decodeURIComponent(uri);
+  } catch {
+    return uri;
+  }
+}

--- a/web/src/components/chat/MarkdownRenderer.tsx
+++ b/web/src/components/chat/MarkdownRenderer.tsx
-import { detectInlineKind, EXTENSION_TO_KIND, getExt } from './artifacts/types';
+import { detectInlineKind, EXTENSION_TO_KIND, getExt, decodeMarkdownPath } from './artifacts/types';
@@ resolveImageSrc
-  const encoded = toBase64Url(src);
+  const encoded = toBase64Url(decodeMarkdownPath(src));
@@ img 处理器（非图片产物分支）
-  filePath: src,
-  fileName: alt || src.split('/').pop() || src,
+  filePath: decodeMarkdownPath(src),
+  fileName: alt || decodeMarkdownPath(src).split('/').pop() || src,
@@ a 处理器（产物链接分支）
-  const label = extractText(children) || href.split('/').pop() || href;
+  const decodedHref = decodeMarkdownPath(href);
+  const label = extractText(children) || decodedHref.split('/').pop() || decodedHref;
-  filePath: href,
+  filePath: decodedHref,
```

回归测试：`tests/artifact-markdown-path.test.ts`（5 用例：remark 中文编码、
Agent 预编码、字面 `%`、非法序列回退、ASCII 不变）。

**选型权衡**：
- 后端 fallback（路径不存在时再试 decode 后的）能兜住所有客户端，但会在每次 404
  上做双查找、掩盖前端语义错误，且 Android 端等新客户端复制同样的转换逻辑更脆。
  前端一处边界修复 + 测试即可，暂不加后端双查找。
- 不在 `toBase64Url` 里解码：文件面板（FilePanel/OfficeFileOverlay）传的是 API
  返回的真实路径（可含字面 `%`），在那里解码会把 `100%25.txt` 这类真名改坏。

## 7. 处理卡住的状态

无需救活任何运行态。产物渲染是前端每次加载消息时实时构建 URL 的，
部署修复后**刷新页面即恢复正常**（包括历史消息的产物卡片）。

## 8. 经验沉淀 / 预防

- **markdown 里的 href/src 是 URI，不是文件路径**。任何把 markdown 链接接到文件
  API 的地方，都要经过 `decodeMarkdownPath` 这类 URI → 路径转换。新增渲染入口
  （如移动端、分享页）时按同样边界处理。
- 同类潜在问题（本次未修，超出事故范围）：链接带 `#fragment`（如
  `report.html#目录`）时 fragment 会被带进文件路径导致 404。若后续出现，同在
  该边界 strip `#`/`?` 之后的部分即可。
- 回归测试固化了 remark 管线四种编码行为的 fixture，若升级 react-markdown/
  micromark 后行为变化，`tests/artifact-markdown-path.test.ts` 会先报警。
- 巡检建议：前端 `ArtifactRenderer` 可在 preview 404 时显示"文件不存在（路径：…）"
  而不是裸 JSON，降低下次同类问题的定位成本（UI 改进，未在本次修复范围内）。
