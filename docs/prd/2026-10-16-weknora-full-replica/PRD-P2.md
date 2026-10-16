# PRD · P2 — 文档接入扩展

- **日期**：2026-10-16
- **父 PRD**：`docs/prd/2026-10-16-weknora-full-replica/PRD.md`（§4 分期表：P2 行）
- **参照物**：`~/WeKnora` v0.8.3
- **上游依赖**：P1 已完成（父子分块 / FAQ 索引 / 预生成问题 / 查询改写 / 意图识别）
- **并行完成**：P3 的 **B2 扫描件 OCR 入库**已提前交付（用户点名要求），见
  `docs/test_report/2026-10-16-local-model-service/`。本文档不重复该部分。

---

## 1. 一句话

把知识库能吃进去的东西**从 7 种扩到 12 种**，让用户**一次能传一整个目录**，
并且让「哪种文件走哪条解析通道」这件事**可配置**而不是硬编码。

---

## 2. 现状（实测，非推断）

| # | 能力 | 现状 | 证据 |
|---|---|---|---|
| A1 | 上传格式 | pdf / docx / md / html / csv / tsv / json / txt | `src/document-parser.ts:12-30` `SUPPORTED_PARSERS` |
| A1 | 缺的格式 | pptx / xlsx / epub / xmind | `detectParser()` 无对应分支（`:35-55`） |
| A3 | 手写 Markdown | 无。只能先存成 `.md` 文件再上传 | 端点只有 `POST /:id/documents`(multipart) 与 `/:id/documents/url` |
| A4 | 整目录上传 | 单文件。`formData.get('file')` 只取一个 | `src/routes/paas-knowledge-bases.ts:571` |
| B6 | ParserEngineRules | 无。`parseByType()` 是 `switch (parserType)` 硬编码 | `paas-knowledge-bases.ts:711-724` |

上游 WeKnora 的对应实现（作为参照）：

| 项 | 上游做法 | 位置 |
|---|---|---|
| pptx/pptx | 路由到 `markitdown` 引擎（Python） | `internal/types/knowledgebase.go:306` |
| 引擎规则 | `ParserEngineRule{file_types[], engine}` + `xlsx_first_row_as_header` | `internal/types/knowledgebase.go:252-258` |
| 规则解析 | 归一化文件类型后查规则，未命中回落到 `DefaultParserEngine(fileType)` | `:341-350` |
| 目录上传 | 拖拽走 `webkitGetAsEntry()` 递归；跳过隐藏段（`.git`/`.DS_Store`）；保留 `webkitRelativePath` | `frontend/src/views/platform/collectDroppedFiles.ts` |
| 手写入口 | 上传来源菜单 `manualCreate`（「在线编辑」） | `KbUploadSourceDropdown.vue:140-160` |

---

## 3. FR

### FR-P2-1（A1）格式补齐：pptx / xlsx / epub / xmind

**要求**：这 4 种格式都能上传、解析出正文、进入既有的分块与向量化流水线。

**为什么不是"能读出字就行"**——每种格式的**结构信息**必须体现成文本，否则检索语义会乱：

| 格式 | 必须保留的结构 | 反例（不算通过） |
|---|---|---|
| **xlsx** | 工作表名、行列表格、**表头与行的对应** | 把整张表按单元格顺序平铺成一串，`Osimertinib` 和它旁边的剂量被隔开几十个数字 |
| **pptx** | 幻灯片序号、标题与正文的层级 | 把整份 PPT 的文字揉成一段，不知哪句属于哪页 |
| **epub** | 章节顺序、章节标题 | 只抽出一坨正文，章节边界丢失 |
| **xmind** | 节点层级（父子缩进） | 所有节点平铺，主题与子主题的关系丢失 |

**验收口径**：对每种格式有夹具，断言**既定关键词命中**（与 P3 OCR 同一套思路：
「返回了非空字符串」和「转写对了」是两件事）。

**边界**：
- `.ppt` / `.xls`（二进制老格式）**不做**。它们是 OLE 复合文档，需要另一套解析器；
  报错要明确指向「请另存为 pptx/xlsx」，不能报「不支持的文件类型」让人以为是漏配。
- xmind 的新旧两种存储（`content.json` / `content.xml`）都要支持——同一个产品两个版本
  的文件都真实存在。

### FR-P2-2（A3）手写 Markdown 入库

**要求**：不落盘、不经过文件系统，直接把一段文本存成知识库文档。

- 端点：`POST /api/paas/knowledge-bases/:id/documents/text`
- 入参：`{ title: string, content: string }`
- 行为：与文件上传**完全一致**（同样的分块、同样的向量化、同样的列表呈现与检索），
  只是 source 是「手写」而不是文件名。
- `title` 为空时拒绝（列表里一条无标题的记录没法认领）。
- `content` 为空/纯空白时拒绝。
- **不能**因为走的是新端点就绕开重复检测：同样的正文再存一次应当被判重。

### FR-P2-3（A4）整目录上传

**要求**：用户能把一个目录（含子目录）里的文档一次性加进来。

三条入口都要有：
1. `<input type="file" webkitdirectory>` —— 点按钮选目录；
2. **拖拽目录**进上传区 —— 必须走 `webkitGetAsEntry()` 递归。
   **不能只看 `dataTransfer.files`**：Chrome/Edge 拖文件夹时那里放的是 size 为 0 的假条目，
   文件名都没有；Firefox 更是空的。这条是实测过的坑，上游注释里写得很清楚。
3. **zip 压缩包** —— 传一个 `.zip` 等价于传它里面的所有支持格式。

**必须做到**：
- **保留相对路径**：`docs/guide/intro.md` 存进去后在列表里能看出它来自哪个目录。
  不保留的话 200 个 `index.md` 会糊成一片，用户无法认领。
- **跳过隐藏项**：`.git/`、`.DS_Store`、`__MACOSX/` 等不进库（上游规则：任一路径段以 `.` 开头即跳过）。
- **跳过不支持的格式**，但要**告诉用户跳过了几个**，不能静默丢弃。
- **逐个展现结果**：200 个文件里有 3 个失败，用户要能看到是哪 3 个、为什么。
  一次性把 200 个打包成一个请求返回「成功/失败」是不可接受的。
- **并发有上界**：不能把 200 个请求同时打出去。

### FR-P2-4（B6）ParserEngineRules（按文件类型指定解析通道）

**要求**：知识库级别可配置「某类文件走哪条解析通道」。

**DeepThink 的引擎清单**（不是照搬上游的 `mineru`/`markitdown`/`anydoc`——那是 Python 侧车，
本仓库没有）：

| 引擎 | 含义 |
|---|---|
| `builtin` | 进程内解析（pdf 文字层 / docx / 表格 / 上述 4 种新格式）——**默认** |
| `ocr` | 强制走视觉模型 OCR 通道（P3 已交付的能力） |

**`ocr` 这条规则是这套机制在 DeepThink 里真正的用武之地**：有些 PDF **有**文字层，
但文字层是坏的（字体缺 ToUnicode 映射，抽出来是乱码）——它不会抛
`PdfHasNoTextLayerError`，于是永远不会自动转 OCR。这类文件只能靠人指定「这份走 OCR」。

**规则语义**（对齐上游）：
- `file_types` 的写法要归一化：`"PDF"` / `".pdf"` / `"pdf"` 都指向 `pdf`。
- 没命中规则 → 回落到默认行为（既有代码怎么走还怎么走），**不新增一次探测**。
- `xlsx_first_row_as_header`：把首行当表头，后续每行渲染成 `列名: 值` 的形式。
  关掉时按原样输出表格。
- 规则配错（引用不存在的引擎名）**不能**让上传失败——回落默认并在响应里提示。

---

## 4. 非功能需求

1. **零回归**：全套单测（P1 后 179 文件 / 2423 项）保持通过。
2. **向后兼容**：`SUPPORTED_PARSERS` 只增不减；既有端点路径与响应字段只增不改。
3. **不新增重量依赖**：4 种新格式都是 zip+XML，用**已有**的 `jszip` 实现，
   不引入 Python 侧车、不引入需要下载模型的解析器。
4. **优雅降级**：新格式解析失败时，错误信息要能区分「格式不支持」「文件损坏」「加密」，
   并保持既有约定——**被拒绝的上传不留文档行**。
5. **不受信任输入**：xlsx/pptx/epub/xmind 都是 zip，必须防 **zip 炸弹**（解压总量上界）
   和 **XML 实体膨胀**；路径穿越（`../`）必须被拒绝。

---

## 5. 验收标准

| # | 验收项 | 判定 |
|---|---|---|
| AC-1 | 5 种新格式（含 A3 手写）各上传一份夹具，全部到达「就绪」 | 状态 = `ready` |
| AC-2 | 每种格式的**结构关键词**命中（表格表头-行对应、幻灯片页序、章节标题、思维导图层级） | 分块正文断言 |
| AC-3 | 新格式的文档能被检索命中（用夹具里的词发问） | `search` 返回该文档 |
| AC-4 | 手写 Markdown：标题空 / 正文空 → 拒绝且**不留文档行** | HTTP 4xx + 行数不变 |
| AC-5 | 手写 Markdown：同样正文二次提交 → 判重 | HTTP 409 |
| AC-6 | 目录上传：含隐藏文件与不支持格式的目录，**支持的都进库、隐藏的被跳过**、跳过的有明确回执 | 逐条结果 |
| AC-7 | 目录上传：相对路径保留 | 列表里的文件名含目录段 |
| AC-8 | zip：传一个含 3 种格式的 zip，解出 3 份文档 | 文档数 +3 |
| AC-9 | ParserEngineRules：`{"file_types":["pdf"],"engine":"ocr"}` 时 PDF 走 OCR 通道 | 文档 `parser_type=pdf_ocr` |
| AC-10 | ParserEngineRules：`"PDF"` / `".pdf"` / `"pdf"` 三种写法等价 | 同一份 PDF 三次都走 OCR |
| AC-11 | ParserEngineRules：未命中规则时行为与 P2 之前**完全一致** | 既有用例不破 |
| AC-12 | ParserEngineRules：配了不存在的引擎名 → 回落默认 + 响应提示，**上传仍成功** | 201 |
| AC-13 | 零回归 | 全套单测通过 |
| AC-14 | UI 验收：真实点击走目录选择与手写入口，截图留档 | Playwright + 截图 |

---

## 6. 不做（明确划界）

| 不做 | 理由 |
|---|---|
| `.ppt` / `.xls`（OLE 二进制） | 需要另一套解析器，收益低；报错里指明转存路径 |
| 版式分析（B1）、表格抽取（B3）、VLM 图片描述（B4）、ASR（B5） | 属 **P3** |
| Wiki / 知识图谱（C5/C6） | 属 **P4** |
| 外部数据源 connector（A5） | 属 **P5** |
| 目录上传的断点续传 | 200 个文件量级不需要；失败的文件重新拖一次即可 |
| 目录结构在知识库列表里渲染成树 | 本轮只保留相对路径（AC-7）。树形浏览的上游实现是 `KbFolderTree.vue` + FolderPickerMenu，属独立一档工作 |

---

## 7. 风险

| 风险 | 应对 |
|---|---|
| xlsx 表格转文本的方式直接决定检索质量 | 夹具里的断言点必须落在「表头-行对应」上，而不是「有没有字」 |
| zip 炸弹 / XML 膨胀 | 解压总量上界 + 单条 XML 大小上界；超限即拒绝并说明 |
| 目录上传把 200 个请求打满 | 并发上界（见 SOLUTION），逐个回执 |
| 新增 4 种格式会稀释既有 `sniffParserFromBuffer` 的判定 | 这 4 种都是 `PK\x03\x04`（zip），与 docx **magic 相同**——必须靠扩展名区分，magic 单独不足以判定 |
