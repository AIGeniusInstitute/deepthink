# 执行状态 — WeKnora 知识库复刻 P2（文档接入扩展）

> PRD：`docs/prd/2026-10-16-weknora-full-replica/PRD-P2.md`
> 技术方案：`docs/tech_solution/2026-10-16-weknora-full-replica/SOLUTION-P2.md`
> 测试报告：`docs/test_report/2026-10-16-weknora-full-replica/TEST_REPORT-P2.md`
> 分支：`worktree-feat-kb-full-replica-p2`（`~/deepthink/.claude/worktrees/feat-kb-full-replica-p2`）
> 完成时间：2026-10-16

---

## 0. 总览

| 项 | 状态 |
|---|---|
| 代码实施 | ✅ A1–A6 全部落地 |
| 单测 | ✅ 全量 187 文件 / 2493 条（183 passed + 4 skipped；2477 passed + 16 skipped），较 main（183/2439，2423 passed）**+4 文件 / +54 条** |
| `tsc --noEmit` | ✅ 0 错（含 `npm run build` 全绿） |
| 真机 e2e | ✅ **35/35 通过**，打在 `dist` 产物上，逐项截图 |
| 缺陷 | 3 个，均已按 issue 工作流定位根因 → 修复 → 沉淀 |
| 合并 | ✅ ff-merge 回 main 并 push |

---

## 1. 子项进度

| 子项 | 方案章节 | 状态 | 说明 |
|---|---|---|---|
| A1 xlsx / pptx 解析 | §2.1 | ✅ | `src/document-parser-zip.ts`，含 xmind / epub（原计划在 P3，一并提前） |
| A2 扩展名 → 解析器映射 | §2.2 | ✅ | `SUPPORTED_PARSERS` 7 → 11，错误提示自动跟上 |
| A3 手写 Markdown 端点 | §2.3 | ✅ | `POST /:id/documents/text`，落库前先校验（不留孤儿行） |
| A4 整包 zip 上传 | §2.4 | ✅ | `POST /:id/documents/archive`，逐条回执，绝不静默丢条目 |
| A5 目录上传 / 拖拽 | §2.5 | ✅ | `web/src/lib/collect-dropped-files.ts` + 页面上传区改造 |
| A6 ParserEngineRules | §2.6 | ✅ | `src/kb/parser-engines.ts`，按文件类型指定 builtin / ocr |

### 越界完成的部分（记录在案）

| 项 | 原属 | 实际 |
|---|---|---|
| 扫描件 OCR 通道 | P3 B2 | **已在上一轮交付并验证**（9999 生产实例，本机 Ollama `qwen2.5vl:7b`） |
| epub / xmind 解析 | P3 | 本轮随 zip 容器解析一并交付（与 pptx/xlsx 共用同一条路径，拆开做反而要写两遍） |

---

## 2. 本轮修掉的缺陷（3 个）

| # | 缺陷 | 性质 | 证据 | 沉淀 |
|---|---|---|---|---|
| 1 | `.html` 上传与 URL 抓取 100% 失败：`require is not defined` | **既有缺陷**（main 上同样复现） | 9999 生产实例真实请求返回 `400 {"error":"require is not defined"}`；`tsx` 探针本地复现 | `docs/issues/2026-10-16-esm-require-html-ingest.md` |
| 2 | 纯标题文档入库失败：heading 分块产出 0 块 | **既有缺陷**，被 P2 的 xmind 解析器放大成必现 | main 工作树探针：`recommendStrategy → heading`、`chunkText → 0 块` | `docs/issues/2026-10-16-heading-chunker-empty-chunks.md` |
| 3 | 切页签后「上传目录」静默退化成普通文件框 | **P2 自引入** | e2e 中 `setFiles(目录)` 抛 `File input does not support directories`；`hasAttribute('webkitdirectory')` 为 false | `docs/issues/2026-10-16-webkitdirectory-remount.md` |

三个都在 e2e/真机环节暴露，都不是靠"再读一遍代码"发现的 —— 这也是本轮把 e2e 打在
`dist` 产物上、并且刻意让用例顺序"脏"（切走再切回）的原因。

---

## 3. 验收记录（真机 e2e，35/35）

实例：`DEEPTHINK_DATA_DIR=~/.deepthink-9922 DEEPTHINK_WEB_DIST_DIR=$PWD/web/dist WEB_PORT=9922 node dist/index.js`
（**跑编译产物**，不是 dev server —— 见 §4 的说明）
脚本：`tests/e2e/kb-p2-ingest.mjs`　截图：`docs/test_report/2026-10-16-weknora-full-replica/screenshots-p2/`

| 组 | 断言数 | 结果 |
|---|---|---|
| 登录 / 建库 / 上传按钮弹框 | 3 | ✅ |
| 手写 Markdown：空标题拒绝 + 入库 + 判重 | 3 | ✅ |
| 格式矩阵 10 种（pptx/xlsx/epub/xmind/html/csv/json/md/txt/pdf） | 10 | ✅ |
| 检索命中（pptx / html / txt 三段正文） | 3 | ✅ |
| 目录上传：真实选目录 + 隐藏项 + 相对路径 + 回执 | 6 | ✅ |
| 整包 zip：空库解出 3 份 + 相对路径 + 隐藏项 | 5 | ✅ |
| 全量收尾（全部「就绪」、全部有分块） | 2 | ✅ |
| 其它（引导态、截图留档等） | 3 | ✅ |
| **合计** | **35** | **35/35** |

关键数值（取自 `logs/e2e-kb-p2/result.json` 与 `final-docs.json`）：

- 格式矩阵 10 种全部到「就绪」，且 `已向量化 == 分块`（向量模型是本机 Ollama `bge-m3`，非空跑）
- 目录上传：`上传进度 3/3 · 成功 3 · 跳过 0 · 失败 0`；`.draft.md` 与 `.cache/` 均未入库；
  文件名保留 `dirtree/protocol/visit.md` 形态
- 整包 zip：`解包后：入库 3 · 跳过 3 · 失败 0`；跳过项**逐条给出理由**
  （`隐藏项` ×2、`不支持的格式` ×1）

---

## 4. 为什么 e2e 必须跑 `dist`

`.html` 那个缺陷（§2 第 1 条）在 vitest 与 `tsx` 下**都是绿的** —— 两者的模块转换层
都会给 ESM 注入 `require` 兼容对象。只有 `node dist/index.js` 这个真实运行时才会暴露。
所以 P2 的验收实例固定用编译产物启动，而不是 `npm run dev`。

---

## 5. 合并

| 步骤 | 结果 |
|---|---|
| `npx tsc --noEmit` | 0 错 |
| `npm run build` + `npm run build:web` | ✅ |
| 全量单测 | 187 文件：183 passed / 4 skipped；2493 条：2477 passed / 16 skipped |
| e2e（隔离实例 9922） | 35/35 |
| ff-merge → main（`3b152e2` → `bce0b69`） | ✅ |
| push `origin` | ✅（atomgit + github 双推，均在 `bce0b69`） |
| 9999 生产实例重新部署（`make stop-prod` → `make start-prod PORT=9999`） | ✅ |
| 9999 上线自检（真实点击） | ✅ **14/14** |

---

## 6. 9999 上线自检（`logs/e2e-kb-9999-livecheck/`）

部署后打生产实例跑的一遍真机复核，脚本 `tests/e2e/kb-9999-livecheck.mjs`，
截图留档 `docs/test_report/2026-10-16-weknora-full-replica/screenshots-9999-livecheck/`。

| 断言 | 结果 |
|---|---|
| 登录 9999 | ✅ |
| 打开**用户报的那个库**（`40585997-…`，只读） | ✅ |
| 点「上传文档」弹出**原生文件选择框**（复核 16:18 那条"没反应"） | ✅ |
| 新建自检库 → 手写 Markdown 入库 | ✅ |
| 整包 zip：`解包后：入库 3 · 跳过 3 · 失败 0`（逐条给理由） | ✅ |
| 目录上传：`3/3 · 成功 3`，保留 `dirtree/protocol/visit.md` 相对路径，隐藏项未入库 | ✅ |
| 检索命中自写文档 | ✅ 5 条命中 |
| 切到「检索测试台」再切回，`webkitdirectory` 仍在 | ✅ |

**没有往用户的库里写任何数据**：用户那个库全程只读打开；所有写入动作都落在自检新建的
`上线自检 <时间>` 库里（可随时删除）。上传进自检库的文档同理。
