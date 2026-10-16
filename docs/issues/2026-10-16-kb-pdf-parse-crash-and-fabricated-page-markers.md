# 知识库上传 PDF 报 `pdfParse is not a function`（并牵出「扫描件被静默入库」的潜伏缺陷）

- 日期：2026-10-16
- 影响范围：知识库（`/knowledge-bases/:id`）所有 PDF 上传，**100% 失败**，与文件大小、内容无关
- 严重级别：P1 —— 通告支持的全部格式里，PDF 是最常用的一个，功能整体不可用
- 关联提交：修复见本文件 §6；回归测试见 `tests/units/document-parser-pdf.test.ts`、`tests/e2e/kb-pdf-upload.mjs`

---

## 1. 用户现象

在知识库页面点「上传文档」选一个 PDF，界面右上角弹出红色提示：

```
pdfParse is not a function
```

任何 PDF 都是这个结果 —— 换文件、换大小都一样。文档列表里不留下任何记录，
既没有"失败"状态的条目，也没有失败原因，像是这次上传从未发生过。

（用户在飞书反馈的原话：*"上传 PDF 了，有报错了： pdfParse is not a function"*）

---

## 2. 问题描述

上传接口 `POST /api/paas/knowledge-bases/:id/documents` 在**请求内同步**完成解析：

```
src/routes/paas-knowledge-bases.ts
  formData → 大小校验 → 类型嗅探 → parseByType() → addKbDocument() → 202/201
                                        ↑
                                  这里抛了 TypeError
```

`parseByType()` 对 `.pdf` 调 `parsePdf(buf)`，而 `parsePdf` 调用 `pdf-parse` 的方式
与该依赖**升级到 v2 之后的导出形态**不匹配，于是抛 `TypeError: pdfParse is not a function`。
接口捕获后把 `err.message` 原样回给前端（400），用户看到的红色提示就是这句。

排查这处代码时发现同一函数里还躺着**第二个从未被触发的缺陷**：`getText()` 默认会给
每一页伪造一条 `-- n of N --` 页码标记，使"无文字层的扫描件"抽出非空文本，
下游的空值守卫失效 —— 后果是纯噪声被当成正文**静默入库**（详见 §3.2）。

---

## 3. 根因

### 3.1 直接原因：pdf-parse v2 是具名类导出，没有默认导出

出问题的旧实现（`git show HEAD:src/document-parser.ts`）：

```ts
export async function parsePdf(buf: Buffer): Promise<string> {
  const mod = await import('pdf-parse');
  const pdfParse = (mod as any).default ?? (mod as any);   // ← v2 下退化
  const result = await pdfParse(buf);                      // ← TypeError
  ...
}
```

依据一 —— 装的是 v2：

```console
$ node -p "require('./node_modules/pdf-parse/package.json').version"
2.4.5
```

依据二 —— 它的 ESM 入口只导出**具名类**，没有 `export default`：

```console
$ grep -n "^export" node_modules/pdf-parse/dist/pdf-parse/esm/index.js
2:export { VerbosityLevel } from 'pdfjs-dist/legacy/build/pdf.mjs';
3:export * from './Exception.js';
4:export * from './geometry/index.js';
5:export { PDFParse };

$ grep -c "export default" node_modules/pdf-parse/dist/pdf-parse/esm/index.js
0
```

于是 `(mod as any).default` 是 `undefined`，`??` 落到右边的 `(mod as any)` ——
即**整个模块命名空间对象**（`{ PDFParse, VerbosityLevel, ... }`）。把命名空间对象当函数调用，
必然抛 `pdfParse is not a function`。v1 那套 `pdf(buffer)` 的函数式调用在 v2 下不存在了，
正确用法是 `new PDFParse({ data })` + `await parser.getText()`。

这个写法是随 `17d6bd1 feat: Agent PaaS Phase 2 — 文档扩展 / 向量混合检索 / …`
一起进来的，自引入起就没跑通过 —— 因为**当时没有任何测试覆盖 PDF 解析**。

### 3.2 潜伏缺陷：`pageJoiner` 默认值会伪造页码标记，骗过空值守卫

`getText()` 的默认参数把页码标记拼进正文（`node_modules/pdf-parse/dist/pdf-parse/esm/ParseParameters.js`）：

```js
// ParseParameters.js:6
params.pageJoiner = params?.pageJoiner ?? '\n-- page_number of total_number --';
```

拼接发生在这里（`node_modules/pdf-parse/dist/pdf-parse/esm/PDFParse.js:135-146`）：

```js
for (const page of result.pages) {
    if (params.pageJoiner) {                       // ← 传空串即走 else 分支，不拼接
        let pageNumber = params.pageJoiner.replace('page_number', `${page.num}`);
        pageNumber = pageNumber.replace('total_number', `${result.total}`);
        result.text += `${page.text}\n${pageNumber}\n\n`;
    }
    else {
        result.text += `${page.text}\n\n`;         // ← 只留分隔换行
    }
}
```

`parsePdf` 里原本有一道守卫：

```ts
if (!text) throw new Error('PDF has no extractable text (possibly a scanned image)');
```

本意是拦住扫描件。但**不传 `pageJoiner` 时，这个守卫永远不成立** ——
一页纯扫描件本该抽出空串，被拼上标记就成了非空文本。用用户那份 287 页的扫描件实测（§5.3）：

| 调用方式 | 抽出长度 | 伪造标记条数 | `trim()` 后是否为空 |
|---|---|---|---|
| 默认 `pageJoiner` | 5,632 字符 | **287 条** | 否 → 守卫失效 |
| `pageJoiner: ''` | 574 字符（全是换行） | 0 条 | 是 → 守卫生效 |

也就是说，如果只修 §3.1 的崩溃、不动 §3.2，用户这份扫描件会"上传成功"，
知识库入库 5,632 个字符的 `-- 1 of 287 --`、`-- 2 of 287 --` …，被切块、被向量化、
被检索引用回显 —— 一份**看起来完全正常的**垃圾文档。这比直接报错更糟。

---

## 4. 复现路径

前置：实例已启动（`make start-prod PORT=9999`），`admin` 已登录。

1. 打开任意**文档型**知识库：`http://localhost:9999/knowledge-bases/<id>`
2. 点右上角「上传文档」
3. 选任意 `.pdf` 文件（内容无关，1 页纯文字 PDF 即可复现）
4. 观察：右上角红色提示 `pdfParse is not a function`；文档列表**不新增任何条目**

修复后的预期（同一路径、同一操作）：

4′. 观察：红色提示变成 `PDF has no extractable text (possibly a scanned image)`（纯扫描件）
     或绿色 `已上传，正在后台解析与分块`（有文字层的 PDF）；列表要么不新增，要么新增一条**就绪**条目。

---

## 5. 诊断方法

### 5.1 一行复现崩溃本身

```bash
cd ~/deepthink
node -e "
(async()=>{
  const mod = await import('pdf-parse');
  const pdfParse = mod.default ?? mod;
  console.log('typeof mod.default =', typeof mod.default);
  console.log('mod 的键 =', Object.keys(mod).slice(0,6));
  console.log('typeof (mod.default ?? mod) =', typeof pdfParse);
  await pdfParse(Buffer.from('%PDF-1.4\n%%EOF'));
})();
"
# typeof mod.default = undefined
# mod 的键 = [ 'VerbosityLevel', 'PasswordException', ... , 'PDFParse' ]
# typeof (mod.default ?? mod) = object     ← 这就是 TypeError 的来源
```

### 5.2 端到端确认"是解析这一步挂了"，而不是鉴权/上传通道

```bash
# 对照法：同一个界面上传 .md / .txt 是正常的 ⇒ 问题只在 PDF 分支（parsePdf），
# 不在鉴权、不在上传通道、不在大小限制。
# 再翻服务端日志，看解析那一步抛了什么：
grep -A8 "Document parse failed" logs/deepthink-9999.log | sed 's/\x1b\[[0-9;]*m//g'
```

修复**后**实测的输出（同一个文件、同一条路径）：

```
[2026-10-16 17:09:21.980] WARN (91185): Document parse failed
    filename: "CSCO非小细胞肺癌治疗指南2026.pdf"
    parserType: "pdf"
    err: {
      "type": "Error",
      "message": "PDF has no extractable text (possibly a scanned image)",
      "stack":
          Error: PDF has no extractable text (possibly a scanned image)
              at parsePdf (.../dist/document-parser.js:91:19)
```

修复**前**同一位置是 `"type": "TypeError", "message": "pdfParse is not a function"`。
（注意：`make start-prod` 会截断该端口的日志文件，排查线上问题时先 `tail`/备份
再重启，否则现场就随重启一起没了。）

### 5.3 判断一份 PDF 到底有没有文字层（决定"该报错"还是"该成功"）

```bash
cd ~/deepthink
node -e "
(async()=>{
  const fs=require('fs');
  const {PDFParse}=await import('pdf-parse');
  const buf=fs.readFileSync('/path/to/file.pdf');
  for (const label of ['默认 pageJoiner','pageJoiner: 空串']) {
    const p=new PDFParse({data:buf});
    const r=await (label==='默认 pageJoiner'?p.getText():p.getText({pageJoiner:''}));
    await p.destroy();
    const markers=(r.text.match(/--\s*\d+\s+of\s+\d+\s*--/g)||[]).length;
    console.log(label.padEnd(20), '页数',r.total, '| 长度',r.text.length,
                '| 伪造标记',markers, '| trim后为空:', r.text.trim()==='');
  }
})();
"
```

实测用户那份 `CSCO非小细胞肺癌治疗指南2026.pdf`（49.7 MiB）：

```
页数 287 | 每页文字项 0 | 每页图片 1 —— 纯扫描件，可抽取字符数为 0
```

### 5.4 回归测试（本次新增，可直接跑）

```bash
npx vitest run tests/units/document-parser-pdf.test.ts        # 4 项，覆盖两个缺陷
DT_BASE=http://127.0.0.1:9999 DT_USER=admin DT_PASS='***' \
DT_KB=<知识库 id> DT_PDF="/path/to/real.pdf" \
  node tests/e2e/kb-pdf-upload.mjs                            # 10 项，真实 UI + 真实文件
```

---

## 6. 修复方案

### 6.1 `src/document-parser.ts` —— 改用 v2 的类式 API，并关掉伪造的 `pageJoiner`

```diff
-export async function parsePdf(buf: Buffer): Promise<string> {
-  const mod = await import('pdf-parse');
-  const pdfParse = (mod as any).default ?? (mod as any);
-  const result = await pdfParse(buf);
-  const text = (result?.text ?? '').trim();
-  if (!text) throw new Error('PDF has no extractable text (possibly a scanned image)');
-  return text;
-}
+export async function parsePdf(buf: Buffer): Promise<string> {
+  const { PDFParse } = (await import('pdf-parse')) as typeof import('pdf-parse');
+  const parser = new PDFParse({ data: buf });
+  try {
+    const result = await parser.getText({ pageJoiner: '' });
+    const text = (result?.text ?? '').trim();
+    if (!text) throw new Error('PDF has no extractable text (possibly a scanned image)');
+    return text;
+  } finally {
+    await parser.destroy().catch(() => {});
+  }
+}
```

选型理由：

- **不锁回 v1**：v1 依赖的 pdfjs 版本更旧，回退会一并丢掉 v2 对压缩对象流等新 PDF 的支持；
  而且 `^2.x` 的 semver 范围意味着迟早要升上来，锁版本只是把同一个坑推后。
- **`pageJoiner: ''` 而不是事后过滤标记**：标记的格式由依赖库决定，事后用正则剔除属于
  "猜它的输出格式"；直接关掉是按它公开的参数关，语义明确。`PDFParse.js:136` 的
  `if (params.pageJoiner)` 保证了空串走 else 分支（只留分隔换行，随后被 `trim()` 去掉）。
- **`destroy()` 放在 `finally`**：pdfjs 的 `PDFDocumentProxy` 持有 worker 与文件句柄，
  50MB 的 PDF 不释放会一直占着内存；异常路径同样要释放，所以用 `finally` 而不是顺序调用。
- **`parser` 构造在 `try` 之外**：构造失败时没有句柄可释放，放进 `try` 反而会让 `finally`
  去 `destroy()` 一个不存在的对象。

### 6.2 新增回归测试（此前 PDF 解析**零覆盖**）

- `tests/units/document-parser-pdf.test.ts`（4 项）
  - 有文字层 PDF 必须抽出**具体句子**（断言内容，不是断言"非空"）
  - 抽出的正文里**不得**出现 `-- n of N --`
  - 无文字层 PDF 必须**抛错**，而不是把标记当正文交出去
  - 夹具自检：无文字层那份必须真的是"有页无字"，否则上一条会退化成平凡通过
- `tests/fixtures/pdf/text-layer.pdf`、`tests/fixtures/pdf/no-text-layer.pdf`
  —— macOS `cupsfilter` 从文本生成的真 PDF（非 mock）
- `tests/e2e/kb-pdf-upload.mjs`（10 项）—— 真实 UI、真实文件，见 §6.3

### 6.3 为什么要专门写一个 e2e，而不是只加单测

单测只能证明"这个函数现在能跑"。用户报的是**界面上传**这条路，从点击到接口到解析
中间还有若干跳，其中至少有一跳真的坏过（`<label>` 吞掉对 `<button>` 的点击，
见 `docs/issues/2026-10-16-kb-upload-button-label-swallows-click.md`）。
所以 e2e 里的两个设计是刻意的：

- **必须点按钮触发 `filechooser`**，不能用 `page.setInputFiles()` 直接给 input 赋值 ——
  后者绕过了"点击 → 转发 → 弹框"这一跳，按钮坏了也照样"通过"。
- **断言界面**确实没多出入库条目**（而不只是断言弹了报错）。§3.2 的危害恰恰是
  "报了错"和"静默入库"两种表现可能同时发生，只断前者会漏掉后者。

外加一组**正向对照**（往对照库里传一份有文字层的真 PDF，必须切出分块、
且分块正文里读得到 PDF 里的原句）：否则"扫描件报错"这条断言在解析器彻底坏掉时
也会通过 —— 那就成了测了个寂寞。

### 6.4 验证

**负面验证（证明测试真的抓得住这两个缺陷）**：

| 回退内容 | 单测结果 |
|---|---|
| 整体回退到旧实现 | 4 项挂 3，报 `TypeError: pdfParse is not a function` |
| 只回退 `pageJoiner: ''`（保留 v2 类式 API） | 4 项挂 2（"不得混入页码标记"、"扫描件必须报错"），另 2 项通过 |

两个缺陷各自都有非平凡的覆盖，不是靠一条断言捎带过去的。

**真实 UI 验收（`tests/e2e/kb-pdf-upload.mjs`，10/10 通过）**：

```
✅ 登录成功
✅ 点「上传文档」能唤起文件选择框
✅ 真实 PDF 不再抛 pdfParse is not a function
✅ 扫描件给出可执行的失败原因（无文字层）
✅ 没有把噪声文档静默入库（列表条数未增加） — 0 → 0
✅ 有文字层的 PDF 被接受（或判为重复）
✅ 有文字层的 PDF 解析并切出分块
✅ 对照文档没有失败 — 就绪
✅ 分块正文里没有伪造的页码标记 -- n of N --
✅ 分块正文就是 PDF 里的真实文字
```

真实文件走真实入口的接口响应：

```
HTTP 400 — {"error":"PDF has no extractable text (possibly a scanned image)"}
```

截图留档：`docs/test_report/2026-10-16-weknora-full-replica/screenshots/`
（`10-real-pdf-before.png`、`11-real-pdf-result.png`、`12-real-pdf-nothing-ingested.png`、
`13-textlayer-pdf-chunks.png`）。

**这份用户文件仍然无法入库，且这是正确结果**：它是 287 页纯图片扫描件，无文字层
（§5.3 实测每页 0 个文字项）。要让它可检索需要 OCR（每页送视觉模型），
那是**另一个功能决策**，不在本次修复范围内。本次修复保证的是：不再崩溃，
并且给出可执行的失败原因，而不是静默入库一库页码标记。

---

## 7. 处理卡住的状态

本次**没有产生需要救活的卡住状态**，原因是失败发生在入库之前：
上传接口的顺序是"解析 → 落库 → 起后台流水线"，`parsePdf` 抛错时
`addKbDocument()` 还没被调用，因此没有残留的 `pending` 文档行、
没有孤儿分块、也没有半截的向量。这一点是可以直接查证的：

```bash
sqlite3 ~/.deepthink-9999/db/messages.db \
  "select count(*) from kb_documents where kb_id='<知识库 id>';"
# 修复前：0 —— 每次失败的 PDF 上传都没留下任何记录，与界面表现一致
```

反过来说，这也意味着**这个缺陷不会在库里留下需要清理的脏数据**；
§3.2 的静默入库才是会留脏数据的那个，而它在本次修复里被堵住了。
若在更早的版本上已经入过库的扫描件需要清理，按"删文档"处理即可：

```bash
# 定位可疑文档（分块正文里出现库自己伪造的页码标记）
sqlite3 ~/.deepthink-9999/db/messages.db \
  "select d.id, d.filename, count(*) as 可疑分块数
     from kb_documents d join kb_chunks c on c.doc_id = d.id
    where c.content like '%-- 1 of %' group by d.id;"
# 实测：0 行 —— 本次修复之后不再产生这类脏数据
```

---

## 8. 经验沉淀 / 预防

1. **依赖大版本升级后，函数式 API 可能变成类式 API，而 `(mod as any).default ?? (mod as any)`
   这种"兜底写法"会**把错误从"找不到导出"退化成"调用了非函数"**，报错信息完全指不到根因。
   宁可写成 `const { PDFParse } = await import('pdf-parse')` —— 导出名对不上时
   在**编译期**就报错，而不是等到运行时某个用户传 PDF。
2. **断言"非空"是弱断言**。这次两份缺陷都在"返回了非空字符串"这个层面完全正常：
   一份崩溃前是空的，另一份返回的是 5,632 字符的伪造标记。回归测试直接断言
   **PDF 里的具体句子**，才让这两种坏法都无处可藏。
3. **第三方的默认参数可能主动伪造数据**。`pageJoiner` 的默认值会往正文里注入库自己造的
   字符串 —— 任何"用输出来判断输入是否为空"的守卫，在遇到这种默认值时都会失效。
   凡是依赖"抽取结果为空"做分支的地方，都要先确认抽取器没有替我们编内容。
4. **新测试必须做负面验证**：把修复回退掉、确认测试变红，否则无法区分
   "测试真的在守着"和"测试恰好通过"。本次两个缺陷分别回退，各自都让对应的用例变红（§6.4）。
5. **没有覆盖的代码路径等于没有代码**。`parsePdf` 从 `17d6bd1` 起就是坏的，
   期间经历过多次发布、多轮知识库相关的验收（包括 P1 的 18 项 UI 验收）都没发现 ——
   因为验收里传的全是 `.md`。**"支持 N 种格式"这类宣称，每种格式至少要有一条用例**。
6. **e2e 要用真实入口**：`setInputFiles()` 直接给 `<input type=file>` 赋值会绕过按钮点击，
   按钮坏掉时它照样通过（这个教训来自上一次的上传按钮缺陷）。凡是要验证"用户点得到"，
   就必须走 `filechooser` 事件。
