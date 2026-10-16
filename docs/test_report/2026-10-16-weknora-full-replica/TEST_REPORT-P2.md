# 测试报告 — WeKnora 知识库复刻（P2 文档接入扩展）

- 日期：2026-10-16
- 被测对象：worktree `feat-kb-full-replica-p2`，**编译产物**（`node dist/index.js`）
- PRD：`docs/prd/2026-10-16-weknora-full-replica/PRD-P2.md`
- 技术方案：`docs/tech_solution/2026-10-16-weknora-full-replica/SOLUTION-P2.md`
- 执行状态：`docs/task_state/2026-10-16-weknora-full-replica/STATE-P2.md`

---

## 1. 结论

**P2 交付完成，验收通过。**

| 项 | 结果 |
|---|---|
| 真机 e2e（真实点击 + 截图） | **35/35 通过** |
| 单测全量 | 183 passed / 4 skipped（187 文件）；2477 passed / 16 skipped（2493 条） |
| 与 main 的差量 | **+4 文件 / +54 条**，无失败、无跳过增加 |
| `tsc --noEmit` | 0 错 |
| `npm run build` | 通过（本轮曾因 §5.1 的依赖问题失败，已修） |
| 验收中发现并修复的缺陷 | **3 个**（2 个既有缺陷 + 1 个本轮自引入），均按 issue 工作流沉淀 |

PRD §5 的 AC-1 ~ AC-14 全部覆盖：AC-1/2/3/6/7/8/14 由 e2e 直接验，
AC-4/5/9/10/11/12 由单测验，AC-13 由全量回归验。

---

## 2. 环境与被测对象

| 项 | 值 |
|---|---|
| 实例 | 隔离实例，端口 **9922**（不是 9999 生产实例） |
| 数据目录 | `~/.deepthink-9922`（独立 DB / 用户表 / 配置） |
| 启动方式 | `DEEPTHINK_DATA_DIR=~/.deepthink-9922 DEEPTHINK_WEB_DIST_DIR=$PWD/web/dist WEB_PORT=9922 node dist/index.js` |
| 前端 | 该 worktree 的 `web/dist`（`npm --prefix web run build` 产物），由后端静态托管 |
| 向量模型 | 本机 Ollama `bge-m3`（1024 维），`config/embedding.json` 指向 `http://127.0.0.1:11434/v1` |
| 浏览器 | Playwright `chromium.launch({ channel: 'chrome' })`（本机 Chrome） |
| 账号 | `admin / 88888888`（隔离库新建，与 9999 无关） |

### 2.1 为什么打 `dist` 而不是 dev server

本轮修掉的 `.html` 缺陷（§5.2）在 vitest 与 `tsx` 下**全都是绿的** ——
两者的模块转换层都会给 ESM 注入 `require` 兼容对象，把缺陷补掉。
只有 `node dist/index.js` 这个真实运行时才暴露它。

**验收必须打在"用户实际会跑的那个东西"上。** 这条现在固定写进了
`tests/e2e/kb-p2-ingest.mjs` 的文件头注释里，避免下一个人图省事换回 dev server。

### 2.2 引导态的处置

全新数据目录的实例在登录后会被 `AuthGuard` 拦到 `/setup/providers`
（`needsSetup` = 没有任何已启用的 Claude provider）。知识库链路完全不碰 Claude，
所以脚本走**引导页自己那条 `POST /api/config/claude/providers`**，填入一个明显的
占位 Key（`sk-ant-api03-e2e-placeholder-not-a-real-key`）把引导过掉 ——
不伪造状态、不手改配置、不引入任何真实凭据。

副作用是检索的「查询理解」这一步会调用失败并回落到原始问题。
这正是生产降级路径，验收里一并覆盖到了（检索仍然命中，见 §3.4）。

---

## 3. 真机验收用例（35 项，全部通过）

脚本：`tests/e2e/kb-p2-ingest.mjs`（`DT_BASE=http://127.0.0.1:9922 node tests/e2e/kb-p2-ingest.mjs`）
截图与原始结果：`screenshots-p2/`（12 张 PNG + `result.json` + `final-docs.json`）

**所有上传/建库都走真实点击路径**：点按钮 → `page.waitForEvent('filechooser')` → 给文件。
不使用 `setInputFiles()` 直接塞隐藏 input —— 那会绕过按钮点击，按钮坏了也照样"通过"
（P1 的 UI 验收里已经踩过这个坑）。

### 3.1 入口可用性（3 项）

| # | 用例 | 结果 |
|---|---|---|
| 1 | 登录成功 | ✅ |
| 2 | 走真实新建弹窗建文档库 | ✅ |
| 3 | 点「上传文档」弹出文件选择框 | ✅ |

> 第 3 项直接对应 **2026-10-16 16:18 用户在 9999 上报的那个"点击上传文档没反应"**。

### 3.2 手写 Markdown（3 项）

| # | 用例 | 结果 | 证据 |
|---|---|---|---|
| 4 | AC-4 空标题 → 拒绝，且**不留文档行** | ✅ | 弹窗仍开；列表行数 0 → 0 |
| 5 | AC-1 正常提交 → 到「就绪」 | ✅ | `手写备忘 HANDTOKEN-9182 · markdown · 分块 1 · 已向量化 1` |
| 6 | AC-5 同内容二次提交 → 判重，列表不新增 | ✅ | 行数 1 → 1 |

第 4 项验的是"不留孤儿行"：校验发生在落库**之前**，所以 4xx 之后列表长度不变 ——
这条只有对比前后行数才看得出来，只看返回码是不够的。

截图：`02-text-empty-title-rejected.png`、`03-text-created.png`、`04-text-duplicate.png`

### 3.3 格式矩阵（10 项）

逐个上传，每个都要求到「就绪」且分块数 > 0：

| 格式 | 夹具 | 分块 / 已向量化 |
|---|---|---|
| pptx | `office/slides.pptx` | 2 / 2 |
| xlsx | `office/dosing.xlsx` | 1 / 1 |
| epub | `office/handbook.epub` | 3 / 3 |
| xmind | `office/design.xmind` | 1 / 1 |
| html | `formats/notes.html` | 1 / 1 |
| csv | `formats/labs.csv` | 1 / 1 |
| json | `formats/protocol.json` | 1 / 1 |
| md | `formats/README.md` | 3 / 3 |
| txt | `formats/memo.txt` | 1 / 1 |
| pdf | `pdf/text-layer.pdf` | 1 / 1 |

**10/10 通过，且每一项的「已向量化」都等于「分块」** —— 说明向量是真实算出来的
（本机 `bge-m3`），不是"上传成功但没建索引"。

xmind 这一项是本轮的**回归点**：它第一次跑是失败的（§5.2），修完才绿。

截图：`05-format-matrix.png`

### 3.4 检索命中（4 项）

在「检索测试台」用夹具正文里的关键词发问，要求命中对应文档：

| 查询 | 期望命中 | 结果 |
|---|---|---|
| `CHARLIE-9930` | `slides.pptx` | ✅ 命中 5 条 |
| `HTMLTOKEN-4471` | `notes.html` | ✅ 命中 5 条 |
| `TXTTOKEN-7723` | `memo.txt` | ✅ 命中 5 条 |
| `ARCHIVETOKEN-2255` | 整包上传的 `notes/plan.md` | ✅ |

`HTMLTOKEN-4471` 这一条是 **§5.2 那个 `require` 缺陷的回归点**：修复前，
`.html` 根本进不了库，这条断言必然失败。它现在绿，是"抽正文这条路真的通了"的证据。

截图：`06/07/08-search-*.png`、`11-search-archive.png`

### 3.5 目录上传（7 项）

用例顺序是**刻意"脏"的**：先切到「检索测试台」再切回「文档」，然后才点「上传目录」。
这不是为了好看 —— 本轮第 3 个缺陷就是被这个顺序抓出来的（§5.4）。

| # | 用例 | 结果 | 证据 |
|---|---|---|---|
| 15 | 点「上传目录」弹出文件选择框（真实点击） | ✅ | |
| 16 | 切页签回来后 `webkitdirectory` 仍在 | ✅ | 显式断言属性存在 |
| 17 | 隐藏**文件**未入库 | ✅ | `.draft.md`（内容含 `SHOULD-NOT-APPEAR-DRAFT`）不在列表 |
| 18 | 隐藏**目录**未入库 | ✅ | `.cache/`（含 `SHOULD-NOT-APPEAR-CACHE`）不在列表 |
| 19 | 相对路径保留 | ✅ | 列表中出现 `dirtree/protocol/visit.md`、`dirtree/analysis/stats.csv` |
| 20 | 回执逐条给出结果 | ✅ | `上传进度 3/3 · 成功 3 · 跳过 0 · 失败 0` + 每行 ✓/⊘/✗ |
| 21 | 子目录文件也到「就绪」 | ✅ | `dirtree/analysis/stats.csv · 分块 1 · 已向量化 1` |

第 16 项为什么要单独断言：Playwright 在属性丢失时的报错是
`File input does not support directories` —— 它描述的是**症状**，指不到根因。
显式断言 `hasAttribute('webkitdirectory')`，报错时才指得到属性本身。

截图：`09-dir-upload-result.png`

### 3.6 整包 zip 上传（6 项）

在**第二个空知识库**上做（判重按内容哈希；同一个包在矩阵库上传会被正确判成
「与库内已有文档内容相同」而跳过 —— 那样测的是判重，不是解包）。

| # | 用例 | 结果 | 证据 |
|---|---|---|---|
| 22 | 建第二个（空）文档库 | ✅ | |
| 23 | AC-8 解出 3 份文档 | ✅ | 空库行数 = 3；回执 `解包后：入库 3 · 跳过 3 · 失败 0` |
| 24 | `__MACOSX/` 未入库 | ✅ | |
| 25 | 隐藏项与不支持格式未入库 | ✅ | `notes/.draft.md`、`archive/logo.png` 均未入库 |
| 26 | 包内相对路径保留 | ✅ | `protocol/slides.pptx`、`notes/plan.md` |
| 27 | 解出的文档到「就绪」 | ✅ | `notes/plan.md · markdown · 分块 1 · 已向量化 1` |

回执的完整文本（`10-zip-archive-result.png` 里可见）：

```
上传进度 1/1 · 成功 1 · 跳过 3 · 失败 0
✓ mixed-archive.zip — 解包后：入库 3 · 跳过 3 · 失败 0
⊘ mixed-archive.zip › __MACOSX/._slides.pptx — 隐藏项
⊘ mixed-archive.zip › notes/.draft.md — 隐藏项
⊘ mixed-archive.zip › archive/logo.png — 不支持的格式
```

**跳过项逐条给出理由**，没有一个是静默消失的 —— 这是 A4 实现里刻意保证的
（超上限的条目也一样，见 `tests/units/kb-archive-upload.test.ts` 的 205 条目用例）。

### 3.7 全量收尾（2 项）

| # | 用例 | 结果 | 证据 |
|---|---|---|---|
| 28 | 所有文档均为「就绪」，无卡在解析中/失败 | ✅ | 14 份全部就绪 |
| 29 | 每份文档都有分块 | ✅ | 14 份均有分块 |

截图：`12-final-list.png`

---

## 4. 回归验证

| 层 | main 基线 | 本分支 | 差量 |
|---|---|---|---|
| 测试文件 | 179 passed / 4 skipped（183） | 183 passed / 4 skipped（187） | **+4** |
| 测试用例 | 2423 passed / 16 skipped（2439） | 2477 passed / 16 skipped（2493） | **+54** |
| 跳过数 | 16 | 16 | 0（没有靠 skip 变绿） |
| `tsc --noEmit` | 0 错 | 0 错 | 0 |
| `npm run build` | 通过 | 通过 | — |

新增的 4 个文件：

| 文件 | 条数 |
|---|---|
| `tests/units/document-parser-zip.test.ts` | 17 |
| `tests/units/kb-archive-upload.test.ts` | 12 |
| `tests/units/kb-parser-engines.test.ts` | 11 |
| `tests/units/kb-text-ingest.test.ts` | 8 |
| `tests/units/kb-chunker.test.ts`（既有文件，新增一组） | +6 |

**AC-11（未命中规则时行为与 P2 之前完全一致）是怎么验的**：
不是靠"跑一遍绿了"，而是把修复前的输出**逐字节写进断言**。例如
`tests/units/kb-chunker.test.ts` 里那条"有正文的文档切法不变"的用例，
期望值 `[["\n正文一","One",6,10], ...]` 是从 **main 工作树实跑**取出来的，
包含 content / headingPath / startAt / endAt 四个字段 —— 改分块器时任何一个字段动了都会红。

---

## 5. 验收发现并修复的缺陷（3 个）

### 5.1 `@xmldom/xmldom` 把 `lib.dom` 拖进整个编译程序（本轮自引入）

新增的 zip 解析器静态 `import { DOMParser } from '@xmldom/xmldom'`。
该包的 `index.d.ts` 第一行是 `/// <reference lib="dom" />`，**一个静态 import 就把
`lib.dom` 拉进了整个 tsc program**，于是全局 `BodyInit` 从 undici 版本换成 DOM 版本，
`src/routes/files.ts` / `src/qq.ts` 里给 `fetch` 传 `Buffer` 的 5 处报
`Buffer is not assignable to BodyInit` —— 那些文件与知识库毫无关系，纯属被牵连。

**定位过程**（先证伪了三个猜测，才找到真因）：

| 假设 | 证伪方式 |
|---|---|
| 增量编译缓存 `dist/.tsbuildinfo` 掩盖了 main 的错误 | `npx tsc --noEmit --incremental false` 在 main 上仍 0 错 |
| worktree 的 `node_modules` 软链坏掉导致解析到别的类型 | 修好软链后错误依旧 |
| `@types/node` 版本不同 | 两边都解析到 22.20.1；`--showConfig` 输出完全一致 |
| **→ 真因** | `npx tsc --noEmit --explainFiles` 显示 worktree 含 `lib.dom.d.ts`，main 为 0；其 `Library referenced via 'dom' from file '.../@xmldom/xmldom/index.d.ts'` |

**修法**：把模块标识符放进变量再动态 import，TS 就不做类型解析，那条 reference 不再被拾取；
同时在本文件内声明用到的 9 个 DOM 成员的最小结构化类型，保住类型检查。
代价（本文件对 xmldom 的调用无类型检查）写在代码注释里。

**为什么不给全项目打开 `lib.dom`**：那等于让服务端代码里的 `document` / `window`
也能通过类型检查 —— 用全局环境的污染换 5 行代码，不划算。

**为什么不把 33 处 XML 遍历改写到 cheerio**：正确性风险大于收益，
且 17 条基于真实 Office 产物的解析测试正是为了锁住这层行为。

修完 `npx tsc --noEmit --explainFiles` 里 `lib.dom.d.ts` 计数回到 **0**（与 main 一致）。

### 5.2 `.html` 上传与 URL 抓取 100% 失败：`require is not defined`（既有缺陷）

已沉淀：`docs/issues/2026-10-16-esm-require-html-ingest.md`

`src/document-parser.ts` 的 `stripHtml()` 用了 CommonJS 的 `require('cheerio')`，
而本仓库是 ESM（`"type": "module"`，生产 `node dist/index.js`）→ `ReferenceError`。
`stripHtml` 是 `.html` 上传与 URL 抓取**共用**的抽正文函数，两条路径一起挂。

- **证据**：9999 生产实例真实请求 → `400 {"error":"require is not defined"}`；
  `tsx` 探针本地复现；`grep -rn "[^a-zA-Z_.]require(" src/` 全仓扫同类写法
- **为什么测试没拦住**：vitest 的模块转换层注入了 `require` 兼容对象 →
  **测试里能跑、生产上跑不了**
- **为什么上线没被发现**：`.html` / URL 抓取是边缘路径，主路径（pdf/docx/md/txt）不走 `stripHtml`
- **修法**：改 `await import('cheerio')`，与同文件既有的 `parseDocx` / `parsePdf` 写法一致
- **回归点**：e2e 的 `HTMLTOKEN-4471` 检索命中（§3.4）

### 5.3 纯标题文档入库失败：heading 分块产出 0 块（既有缺陷，被 P2 放大成必现）

已沉淀：`docs/issues/2026-10-16-heading-chunker-empty-chunks.md`

`chunkByHeading()` 把 section 定义为「一个标题行结束到下一个标题行开始之间的正文」，
并跳过空白 section。一份**整篇只有标题、没有正文段落**的文档，每个 section 都是换行符
→ 全部被跳过 → `out` 为空 → 流水线在 `pipeline.ts:195` 判定
`Chunking produced no chunks` → 文档标记失败。

xmind 解析出来的正是这个形状（层级即内容，`### 年龄 18-75 岁` 本身就是那条知识），
于是从"边缘情况"变成"传一个挂一个"。纯目录型 Markdown 同样能触发。

- **证据**：main 工作树探针 —— `recommendStrategy → 'heading'`、`chunkText → 0 块`；
  9999 同款日志 `stage: "chunk" / message: "Chunking produced no chunks"`
- **修法**：在 `chunkByHeading()` 返回处加兜底 —— 正常路径 0 块但存在标题行时，
  退化成"以标题行为内容"来切（复用 `packSegments`，保住 `startAt/endAt` 与源文的对应，
  引用回源才不会指错）
- **为什么不做成"按层级重组 section"**：那会改变**所有**标题型文档的切分结果，
  与 AC-11 冲突。兜底只在"原本 0 块"这一种输入上生效
- **零回归的验法**：把修复前（main）的输出逐字节写进断言 ——
  `[["\n正文一","One",6,10],["\n正文二","One > Two",19,23],["\n正文三","One > Three",34,38]]`
- **新增 6 条单测**，含一条不变量：**任何非空文本 + 任何策略 → 至少 1 块**

### 5.4 切页签后「上传目录」静默失效（P2 自引入）

已沉淀：`docs/issues/2026-10-16-webkitdirectory-remount.md`

`webkitdirectory` 是非标准属性，React JSX 不认，只能挂载后 `setAttribute`。
最初的写法是 `useEffect(..., [])` —— 只在**组件**首次挂载时跑一次。
但文档页签是 `{tab === 'documents' && ...}` 条件渲染的，切到「检索测试台」再切回来时
input 是**新节点**，effect 不会再跑 → 新节点上没有 `webkitdirectory` →
「上传目录」退化成普通多选文件框，**不报错、不发请求、静默失效**。

- **修法**：改成 **ref 回调**（`useCallback`），节点每次挂载都打补丁
- **为什么不把 `tab` 加进依赖数组**：那只对"页签切换"这一种卸载原因有效；
  ref 回调表达的是真正的约束 ——「这个节点存在期间必须有这个属性」
- **为什么能抓到**：e2e 的用例顺序是"脏"的（先切走再切回）
- **新增断言**：`hasAttribute('webkitdirectory')`，不让报错停在
  `File input does not support directories` 这种症状描述上

---

## 6. 已知缺口（显式登记，不声称已解决）

| # | 缺口 | 影响 | 处置 |
|---|---|---|---|
| 1 | 图片类入库：`sniffTextFromBuffer` 会把 ASCII 可打印、无 NUL 的文件当文本吃下（如 PostScript 的 `.ai`） | `.ai` 会被当文本入库，而不是被当图片拒绝 | **P2 未改变该行为**，并在 `tests/units/kb-archive-upload.test.ts` 里用一条显式用例把现状钉住。真正的图片入库（OCR / 多模态）属 P3 |
| 2 | 目录上传的根目录名会进文件名 | `.dirtree/protocol/visit.md` 而非 `protocol/visit.md` | 这是浏览器 `webkitdirectory` 的语义（`webkitRelativePath` 含所选目录名），非缺陷；PRD 只要求保留相对路径 |
| 3 | e2e 未覆盖 drag & drop 路径 | `collectDroppedFiles()`（`webkitGetAsEntry` 递归 + 100 条 `readEntries` 循环）只有单测 | 拖拽在 Playwright 里需要构造 `DataTransfer` 并注入 `webkitGetAsEntry`，本轮未做。**登记为缺口，不声称已验证** |
| 4 | `ParserEngineRules` 的 OCR 通道未在 e2e 里跑 | AC-9/10/11/12 由单测覆盖 | OCR 单页要 14–20s（本机 `qwen2.5vl:7b`），且上一轮已在 9999 上真机验证过 OCR 通道本身 |

---

## 7. 交付物

| 类型 | 路径 |
|---|---|
| 代码 | `src/document-parser-zip.ts`、`src/kb/parser-engines.ts`、`src/document-parser.ts`、`src/kb/chunker.ts`、`src/routes/paas-knowledge-bases.ts` |
| 前端 | `web/src/lib/collect-dropped-files.ts`、`web/src/pages/KnowledgeBaseDetailPage.tsx`、`web/src/stores/knowledge-bases.ts` |
| 单测 | `tests/units/{document-parser-zip,kb-parser-engines,kb-text-ingest,kb-archive-upload}.test.ts`（+48）、`tests/units/kb-chunker.test.ts`（+6） |
| e2e | `tests/e2e/kb-p2-ingest.mjs` |
| 夹具 | `tests/fixtures/office/`（含 `build-fixtures.sh` 等 4 个可复现构建脚本）、`tests/fixtures/formats/`、`tests/fixtures/dirtree/` |
| 截图 | `docs/test_report/2026-10-16-weknora-full-replica/screenshots-p2/`（12 张 + `result.json` + `final-docs.json`） |
| issue | `docs/issues/2026-10-16-esm-require-html-ingest.md`、`…-heading-chunker-empty-chunks.md`、`…-webkitdirectory-remount.md` |
