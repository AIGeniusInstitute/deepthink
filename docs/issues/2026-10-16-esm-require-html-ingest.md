# `.html` 上传与 URL 入库在 ESM 下全部失败：`require is not defined`

- 日期：2026-10-16
- 影响范围：知识库 `.html` / `.htm` 文件上传、`POST /:id/documents/url`（URL 抓取入库）
- 严重级别：高（该功能 100% 不可用，且报错信息对用户毫无意义）
- 引入时间：早于本次 P2 改动（在 main 上同样复现），属既有缺陷

---

## 1. 用户现象

在知识库页面用「URL 抓取」添加一篇网页，界面弹出红色 toast：

```
require is not defined
```

上传一个 `.html` 文件同样如此。用户视角看到的是一个纯技术名词的报错，
既不知道哪个文件有问题，也不知道下一步该做什么 —— 换一篇网页、换一个文件都没用，
因为**这条路径从来没有成功过**。

## 2. 问题描述

`src/document-parser.ts` 的 `stripHtml()` 用 CommonJS 的 `require('cheerio')`
加载依赖，而本仓库是 ESM（`package.json` 里 `"type": "module"`，生产运行
`node dist/index.js`）。ESM 模块里没有 `require` 这个标识符，调用即抛
`ReferenceError: require is not defined`。

`stripHtml` 是 `.html` 上传（`parseHtml`）与 URL 抓取（`fetchUrlContent`）
**共用**的正文抽取函数，所以两条路径一起挂。

## 3. 根因

**代码层面**：`src/document-parser.ts` 中的 `stripHtml` 使用了未定义的 `require`。

```ts
function stripHtml(html: string): string {
  const cheerio = require('cheerio');   // ← ESM 下 ReferenceError
  const $ = cheerio.load(html);
```

同一个文件里其它解析器（`parseDocx`、`parsePdf`）用的都是 `await import(...)`，
只有这一处是旧写法 —— 大概率是迁移到 ESM 时漏改的一处。

**为什么测试没拦住**：vitest 通过 Vite 的模块转换执行测试文件，转换层给 ESM
注入了 `require` 兼容对象。于是**测试里能跑、生产上跑不了**。这类"只在真实运行时
暴露"的缺陷，单测的绿色是假信号。

**为什么上线后没被发现**：`.html` 与 URL 抓取是知识库导入的边缘路径。主路径
（pdf / docx / md / txt）都不经过 `stripHtml`，所以日常使用碰不到。

**外部依据**：
- [Node.js Docs — ESM: `require` is not defined](https://nodejs.org/api/esm.html#no-require-exports-or-moduleexports)
  （"No `require`, `exports`, or `module.exports`"）
- [Vitest — Modules: `require` interop](https://vitest.dev/guide/mocking.html)

## 4. 复现路径

1. 打开 `http://localhost:9999/login`，用 `admin / 88888888` 登录
2. 进入任意知识库 → 「文档」页签
3. 点「URL 抓取」，填 `https://example.com/`，点「抓取」→ **报 `require is not defined`**
4. 或者点「上传文档」，选一个 `.html` 文件 → **同样报 `require is not defined`**

无需特殊数据，任意 `.html` / 任意公网 URL 都能复现。

## 5. 诊断方法

```bash
# 1. 直接调用解析函数（tsx 就是 `npm run dev` 用的运行时）
cd ~/deepthink
cat > _probe-html.mts <<'TS'
import { parseHtml } from './src/document-parser.js';
try { console.log('parseHtml →', await parseHtml('<h1>标题</h1><p>正文</p>')); }
catch (e) { console.log('失败:', (e as Error).constructor.name, (e as Error).message); }
TS
npx tsx ./_probe-html.mts; rm -f ./_probe-html.mts
# 期望（修复前）：失败: ReferenceError require is not defined

# 2. 确认生产运行时确实是 ESM
grep '"type"' package.json          # "type": "module"
ps aux | grep 'dist/index.js'       # node dist/index.js

# 3. 对线上实例发真实请求（会自建临时库并在结束时删除）
#    完整脚本见本次提交附带的复现记录；关键两步：
#      POST /api/auth/login                     → 拿会话 Cookie
#      POST /api/paas/knowledge-bases           → 建临时库
#      POST .../documents        (multipart .html)  → 400 {"error":"require is not defined"}
#      POST .../documents/url    {url}              → 400 {"error":"require is not defined"}
#      DELETE /api/paas/knowledge-bases/<id>        → 清理

# 4. 全仓扫描同类写法
grep -rn "[^a-zA-Z_.]require(" src/ --include='*.ts'
```

## 6. 修复方案

```diff
-function stripHtml(html: string): string {
-  const cheerio = require('cheerio');
+async function stripHtml(html: string): Promise<string> {
+  const cheerio = await import('cheerio');
   const $ = cheerio.load(html);
```

两个调用点都已经是 `async` 函数并且是 `return stripHtml(...)`，改签名不需要动它们。

**选型理由**：用动态 `import()` 而不是 `createRequire(import.meta.url)`。
后者也能让 `require` 重新可用，但会把一个同步依赖塞回异步解析路径里，
而且和文件内 `parseDocx` / `parsePdf` 既有的 `await import(...)` 写法不一致 ——
同一件事在一个文件里出现两种写法，下一个人还会踩。顺带把 cheerio 的加载推迟到
真正解析 HTML 时，PDF/docx 路径不再无谓地加载它。

**同时修掉**：本次 P2 新增的 `src/document-parser-zip.ts` 里 `xhtmlToMarkdown`
写了同样的 `require('cheerio')`（epub 分支），一并改为动态 import。
这是本次改动**自己引入**的同类缺陷，在写单测时由端到端冒烟暴露 ——
说明这个坑很容易被重复踩，所以扫描命令（§5.4）留在这里。

## 7. 处理卡住的状态

本缺陷不产生"卡住"的运行态：请求在解析阶段就抛错并返回 400，
不会建立文档行、不会残留 pending 状态的记录。用户重试即可，无需人工清理。

（若用户此前在别的实例上遇到过"上传成功但内容为空"的 html 文档，那是另一条路径的问题，
不在本 issue 范围内。）

## 8. 经验沉淀 / 预防

### 8.1 这类缺陷的通用特征

**测试环境的模块转换层补上了生产环境没有的东西**，于是缺陷只在真实运行时出现。
同类风险还有：
- `require` / `__dirname` / `__filename` / `module`（vitest 都注入）
- `process.env.NODE_ENV` 被测试配置覆盖掉的分支
- 只在 dev server 上存在的代理与 CORS 放宽

### 8.2 预防手段

1. **回归用例**：`tests/units/document-parser-html.test.ts` 直接断言
   `parseHtml` / `fetchUrlContent` 能返回正文。它在 vitest 里**也会**通过
   （转换层补了 `require`），所以它拦不住这个缺陷本身 —— 它的价值在于锁住
   "抽正文"这条行为，防止日后重写时再退化。真正的守门员是下面第 2 条。
2. **改成 import 而非 require，并用 lint 拦住**：建议加一条 ESLint 规则
3. `no-restricted-globals` / `no-undef` 覆盖 `src/**/*.ts`，把裸 `require(...)`
   在 CI 阶段就挡下（目前仓库没有覆盖到这一处）。
4. **发布前的真机冒烟**：`npm run build && node dist/index.js` 起一次，
   把"每种支持的格式各传一个"作为上线前清单的一行。本次的 `tsx` 探针（§5.1）
   就是最小版本，可以固化成脚本。
5. **格式矩阵加进 P2 的 e2e**：e2e 用例逐个格式上传并断言入库成功，
   `.html` 从此有真实运行的覆盖（见 `tests/e2e/kb-p2-ingest.mjs`）。
