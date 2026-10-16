# 技术方案 · P2 — 文档接入扩展

- **日期**：2026-10-16
- **PRD**：`docs/prd/2026-10-16-weknora-full-replica/PRD-P2.md`
- **父方案**：`docs/tech_solution/2026-10-16-weknora-full-replica/SOLUTION.md`
- **分支**：`worktree-feat-kb-full-replica-p2`

---

## 1. 总览：改哪几个文件

| # | 文件 | 动作 | 对应 FR |
|---|---|---|---|
| 1 | `src/document-parser-zip.ts` | **新建** — pptx / xlsx / epub / xmind 的解析 | FR-P2-1 |
| 2 | `src/document-parser.ts` | 扩 `ParserType` 与 `detectParser()`，接上 #1 | FR-P2-1 |
| 3 | `src/kb/parser-engines.ts` | **新建** — 引擎规则的归一化、解析、回落 | FR-P2-4 |
| 4 | `src/db.ts` | `knowledge_bases.parser_engine_rules` 列 + 读写函数 | FR-P2-4 |
| 5 | `src/routes/paas-knowledge-bases.ts` | 手写端点 / zip 端点 / 引擎路由 / 文件名含路径 | FR-P2-2/3/4 |
| 6 | `web/src/lib/collect-dropped-files.ts` | **新建** — 拖拽目录递归（照 `webkitGetAsEntry` 的坑写） | FR-P2-3 |
| 7 | `web/src/pages/KnowledgeBaseDetailPage.tsx` | 目录选择、拖拽、手写入口、逐条结果 | FR-P2-2/3 |
| 8 | `web/src/stores/knowledge-bases.ts` | 两个新端点的封装 | FR-P2-2/3 |
| 9 | `package.json` | `jszip` 提为直接依赖 | FR-P2-1 |

**不新建并行机制**：手写与目录上传最终都汇入现有的
`addKbDocument → startIngestAsync` 链路，分块、向量化、检索一行代码不改。

---

## 2. FR-P2-1：zip 容器类文档的解析

### 2.1 核心约束：magic 不够用

`.docx` / `.pptx` / `.xlsx` / `.epub` / `.xmind` 的开头**全都是** `PK\x03\x04`。
现有的 `sniffParserFromBuffer()` 见到这 4 个字节就返回 `docx` —— 对一个没有扩展名的
xlsx 上传，这会把文件交给 mammoth，然后报一个「DOCX 没有可提取文本」的错，
**看起来像文件坏了，其实是走错了通道**。

所以这条路必须**先按扩展名判定**；扩展名缺失时读 zip 内部的 `[Content_Types].xml`
或顶层目录名来区分（`ppt/` → pptx，`xl/` → xlsx，`META-INF/container.xml` → epub，
`content.json` → xmind）。

### 2.2 输出格式：结构必须进文本

统一输出 Markdown。四种格式各自的映射：

**xlsx** —— 一张表一个章节，表头与行必须绑在一起：

```markdown
## Sheet1

| 药物 | 剂量 | 频次 |
| --- | --- | --- |
| Osimertinib | 80 mg | 每日一次 |
```

`xlsx_first_row_as_header=false` 时首行不当表头，输出成普通行（对齐上游语义）。

> 为什么不用「单元格平铺」：平铺之后 `Osimertinib` 与 `80 mg` 之间隔着几十个数字，
> 分块一落刀，剂量就被切到别的块里，检索「Osimertinib 的剂量」会命中一段只有药名的文本。

**pptx** —— 一页一个章节，标题与正文分层：

```markdown
## 第 1 页

# 研究背景

本试验为随机双盲...
```

**epub** —— 按 `spine` 顺序（不是文件名顺序！`toc` 里的顺序才和阅读顺序一致）
逐章输出，章节标题作为 `#`。HTML 走既有的 `stripHtml()`，不另写一套。

**xmind** —— 节点层级用标题层级表达，`content.json`（新）与 `content.xml`（旧）都支持：

```markdown
# 中心主题
## 分支 A
### 子节点 A1
```

### 2.3 安全：zip 是不可信输入

`jszip` 会老老实实把声称的条目都解出来。三道闸：

| 闸 | 阈值 | 理由 |
|---|---|---|
| 条目数 | ≤ 5,000 | `entries()` 本身要遍历，先卡数量 |
| 解压总量 | ≤ 200 MB（按 `uncompressedSize` 累加，**解压前**判） | zip 炸弹：一个 200KB 的包能解出 10GB |
| 单条路径 | 拒绝含 `..`、以 `/` 开头、含 NUL | 路径穿越 |

判 `uncompressedSize` 而**不是**解压后再量——后者已经被炸了。

XML 侧：只读文本节点，不解析 DTD / 外部实体（`@xmldom/xmldom` 默认不解析外部实体，
这里显式不传 DTD 相关选项，并在方案里记一笔，防止将来有人"顺手"打开）。

### 2.4 老格式

`.ppt` / `.xls` / `.doc` 是 OLE 复合文档（magic `D0 CF 11 E0`）。新增一条嗅探：

```
D0 CF 11 E0 ⇒ 抛错「这是 .doc/.xls/.ppt 老二进制格式，请另存为 .docx/.xlsx/.pptx 后重新上传」
```

**不能**笼统报「不支持的文件类型」——那会让用户以为平台漏配了格式，而不是文件需要转存。

---

## 3. FR-P2-2：手写 Markdown

### 3.1 端点

```
POST /api/paas/knowledge-bases/:id/documents/text
{ "title": "会议纪要 2026-10-16", "content": "# 结论\n\n..." }
→ 201 { "document": {...} }
```

### 3.2 实现

复用文件上传的**后半段**，不复制逻辑：

```ts
const title = (body.title ?? '').trim();
const content = (body.content ?? '').trim();
if (!title) return c.json({ error: '标题不能为空' }, 400);
if (!content) return c.json({ error: '正文不能为空' }, 400);

const result = addKbDocument(id, user.id, title, content);   // ← 同一函数，同一判重
if (result.duplicate) return c.json({ error: '...', doc_id: result.row.id }, 409);
updateDocumentParseState(docId, { parse_status: 'pending', error_message: null });
setDocumentParserType(docId, 'markdown');
startIngestAsync(docId, { parserType: 'markdown' });
```

**关键点**：`addKbDocument` 是同一个函数，所以内容哈希判重、`size_bytes`、`content_hash`
这些**天然一致**——手写进来的文档和上传进来的文档在库里没有区别。
这是"不新建并行机制"的具体体现。

`filename` 直接用 `title`。**不追加 `.md`**——标题是用户输入的展示名，
给它加后缀会在列表里变成一个用户没写过的字符串。

---

## 4. FR-P2-3：整目录上传

### 4.1 三条入口 -> 两条后端路径

```
① 选目录 (webkitdirectory)  ┐
② 拖拽目录 (webkitGetAsEntry)┼─→ 前端逐文件 POST /:id/documents   （复用现有单文件端点）
③ zip 压缩包                ─→ 后端 POST /:id/documents/archive  （服务端解包）
```

**为什么 ①② 走前端循环而不是做成一个批量端点**：
- 200 个文件打包成一个 multipart 请求，任何一个失败都不知道是哪个；
- 单文件端点已经存在且经过验证（含扫描件 OCR 分流），复用它等于零风险；
- 重试天然按文件粒度。

**为什么 ③ 反过来放服务端**：500MB 的 zip 不该在浏览器里解，而且用户可能只想传个 zip
就完事；服务端一次解包、逐条入库、逐条回执。

### 4.2 拖拽目录：必须走 `webkitGetAsEntry()`

这是**实测过的坑**，不是理论担忧（上游 `collectDroppedFiles.ts` 注释里写得很明确）：

> Chrome/Edge 拖文件夹时，`dataTransfer.files` 里放的是 size 为 0、没有扩展名的**假条目**；
> Firefox 拖文件夹时 `dataTransfer.files` **是空的**。

所以顺序必须是：先试 `webkitGetAsEntry()` 递归；只有该 API 不可用才回退 `dataTransfer.files`。

`web/src/lib/collect-dropped-files.ts` 的职责：

```ts
traverseEntry(entry, path): Promise<File[]>   // 递归，返回带 webkitRelativePath 的 File
collectDroppedFiles(dt): Promise<File[]>      // 入口：优先 entry API，回退 files
isHiddenSegment(seg)                          // 以 '.' 开头即隐藏
```

隐藏规则：**任一路径段**以 `.` 开头即跳过（`.git/`、`.DS_Store`、`__MACOSX/`）。
对 zip：跳过 `__MACOSX/` 前缀与任何 `.` 开头的段。

### 4.3 逐个结果 + 并发上界

```ts
const CONCURRENCY = 3;
// 结果逐条 push：{ path, filename, ok, docId?, error? }
```

界面上给一个结果清单：`成功 197 / 跳过 2（.git/config、logo.ai 格式不支持）/ 失败 1（原因）`。
**用户必须能看到失败的为什么失败**（PRD FR-P2-3）。

并发 3 的依据：上传后半段是解析 + 入库，解析是 CPU 密集（xlsx/pptx 解 zip），
并发太高只会互相抢 CPU；而扫描件走的是后台 OCR，不占这个池子。

### 4.4 相对路径怎么进库

前端 `webkitRelativePath`（形如 `docs/guide/intro.md`）作为 `filename` 传给后端。
后端**不需要改**——`filename` 本来就是 TEXT。列表里直接显示带路径的名字，
用户一眼能看出它来自哪个子目录。

**不建目录树表**：PRD §6 已划界，树形浏览属独立一档。

---

## 5. FR-P2-4：ParserEngineRules

### 5.1 存储

```sql
ALTER TABLE knowledge_bases ADD COLUMN parser_engine_rules TEXT;
```

沿用 `faq_config` / `question_generation_config` 的既有模式（`ensureColumn` + JSON 文本）。

### 5.2 规则模型

```ts
export type ParserEngine = 'builtin' | 'ocr';
export interface ParserEngineRule {
  file_types: string[];        // 归一化后：'pdf' | 'xlsx' | ...
  engine: ParserEngine;
  xlsx_first_row_as_header?: boolean;
}
```

**归一化**（对齐上游 `normalizeParserFileType`，上游测试里 `"PDF"` / `".pptx"` / `"pptx"`
三种写法都出现过）：

```ts
normalizeFileType('PDF') === normalizeFileType('.pdf') === normalizeFileType('pdf') === 'pdf'
// 去空白 → 去前导 '.' → 小写
```

### 5.3 解析与回落

```ts
resolveParserEngine(kb, fileType): { engine: ParserEngine; headerRow: boolean; invalidRule?: string }
```

- 命中规则 → 用规则里的 engine；
- 未命中 → `builtin`（= P2 之前的既有行为，**一行都不变**）；
- 规则里的 engine 不在枚举内 → 回落 `builtin`，并在响应里带一条 `engine_warning`，
  **不让上传失败**（PRD AC-12）。理由：配置写错是管理员的问题，
  不该让用户上传不了文档——但要让他知道配置没生效。

### 5.4 引擎语义：只有 pdf 支持 ocr

```ts
if (engine === 'ocr' && parserType !== 'pdf') {
  // 回落 builtin，附理由
}
```

理由：OCR 通道要**光栅化页面**（`ocr-rasterize.ts` 用 pdftoppm/pdfjs）。
epub/xmind/xlsx 不是"页"的模型，强行走 OCR 只会得到一个错误。
这是如实的技术边界，写进 doc 注释和响应提示。

### 5.5 `ocr` 引擎的真正价值

已有的自动分流只在 `parsePdf` **抛 `PdfHasNoTextLayerError`** 时触发。
有一类 PDF 不抛：**有文字层但文字层是坏的**（字体缺 ToUnicode 映射，
抽出来是 `���` 或乱码）。这类文件靠自动分流永远进不了 OCR，只能靠人指定。

所以这个规则不是把上游的机制照搬过来当摆设——它补的正是自动分流盖不住的那个缺口。
**验收 AC-9 就用这种 PDF**：一份能抽出乱码文字层的 PDF，不加规则走 builtin（得到乱码），
加规则走 OCR（得到正确正文）。

### 5.6 API

```
GET  /:id            → knowledge_base.parser_engine_rules  （读）
PATCH /:id           → { parser_engine_rules: [...] }       （写，与 faq_config 同风格）
```

---

## 6. 兼容性与回归

| 面 | 保证 |
|---|---|
| `SUPPORTED_PARSERS` | 只增（7 → 11，加 pptx/xlsx/epub/xmind），错误提示里的列表自动跟上 |
| 上传端点 | 路径、字段、响应结构不变 |
| `parseByType()` | 从 `switch` 改成"查表 + 默认"，**既有 7 种走的分支一字不动** |
| `sniffParserFromBuffer` | 行为**不变**：它仍然只对 zip 魔数返回 `'docx'`（`src/document-parser.ts`，本次未改）。4 种新格式靠 `detectZipDocumentType()` **在它之后**逐个看包内文件名来区分（`docProps`/`xl`/`ppt`/`mimetype`/`content.json`），且这条链只在扩展名给不出答案时才走 |
| 未配置规则的库 | `resolveParserEngine` 返回 `builtin` ⇒ 与 P2 之前逐字节一致 |

---

## 7. 测试计划

| 层 | 文件 | 覆盖 |
|---|---|---|
| 单测 | `tests/units/document-parser-zip.test.ts`（17） | 4 种格式的结构断言（pptx 页序按 rels、xlsx 表头-行对应、epub spine 序、xmind 层级/游离主题排除）、zip 炸弹、路径穿越、老格式报错 |
| 单测 | `tests/units/kb-parser-engines.test.ts`（11） | 归一化、命中/回落、非法引擎名、xlsx 表头开关、ocr 仅 pdf |
| 单测 | `tests/units/kb-text-ingest.test.ts`（8） | 手写端点：空标题/空正文拒绝且不留行、判重 409、正常入库走到 ready |
| 单测 | `tests/units/kb-archive-upload.test.ts`（12） | zip 端点：混合格式、隐藏项跳过、逐条回执、超上限、坏包 |
| e2e | `tests/e2e/kb-p2-ingest.mjs`（35 项断言） | 真实 UI + **跑 dist 产物**：手写入口、目录选择、整包上传、格式矩阵、检索命中 + 逐项截图 |

**夹具的实际构建方式**（与最初设想的一支 `build-office-fixtures.mjs` 不同，按格式拆开了，
因为它们的产出工具根本不一样）：

| 夹具 | 构建方式 | 为什么这样做 |
|---|---|---|
| `office/slides.pptx` | `tests/fixtures/office/build-fixtures.sh` 里的 python-pptx | 真由 Office 工具产出，含真实的 rels / 命名空间前缀 |
| `office/slides-reordered.pptx` | 同上脚本 + `build-pptx-reordered.mjs` 反转 `sldIdLst` | 专测「页序按 rels 而非文件名」——文件名序恰好相反 |
| `office/dosing.xlsx` | 同上脚本里 `soffice --headless --convert-to xlsx` | sharedStrings / 表结构都是 LibreOffice 的真产物 |
| `office/handbook.epub` | `build-epub.mjs` **手搓**，再用 LibreOffice 反读校验 | LibreOffice 把 `<h1>` 压成 `<p class="para0">`，导不出带标题层级的 epub；手搓是唯一能测 heading 层级的办法 |
| `office/design.xmind` | `build-xmind.mjs` | XMind Zen 的 `content.json`，另含一个 `children.detached` 游离主题（不该被渲染） |
| `office/mixed-archive.zip` | `build-archive.mjs` | 整包上传夹具，刻意混入 `__MACOSX/`、隐藏文件、png |
| `formats/*.{html,csv,json,md,txt}` | 直接提交的文本夹具 | 矩阵用，内容里埋了各自的关键词 token |
| `dirtree/` | 直接提交的目录树 | 目录上传用，含 `.draft.md` 与 `.cache/` 两处隐藏项 |

夹具必须**可复现构建**而不是塞几个二进制进仓库：一是能看出里面到底有什么，
二是断言才有据可依（P3 的 `scanned-3p.pdf` 已经证明这条路的价值——
预置关键词是唯一能抓出 `moondream` 那种"协议对、结果是错的"的手段）。

**e2e 必须打在 `dist` 上**：本次修掉的 `require is not defined`
（`docs/issues/2026-10-16-esm-require-html-ingest.md`）只在真实 ESM 运行时暴露，
vitest / tsx 的转换层会把它补掉。所以 e2e 的启动方式固定为
`node dist/index.js`（见 §5 验收记录里的实例启动命令），而不是 `npm run dev`。
