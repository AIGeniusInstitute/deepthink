# 测试报告 — WeKnora 知识库整体复刻（P1 知识库内核）

> 需求：把 `~/WeKnora` 的知识库内核整体复刻到 DeepThink
> PRD：`docs/prd/2026-10-16-weknora-full-replica/PRD.md`
> 技术方案：`docs/tech_solution/2026-10-16-weknora-full-replica/SOLUTION.md`
> 执行状态：`docs/task_state/2026-10-16-weknora-full-replica/STATE.md`
> 分支：`worktree-feat-kb-full-replica`　日期：2026-10-16

---

## 1. 结论

**P1（知识库内核 5 个子项）通过。**

| 层次 | 结果 |
|---|---|
| 静态检查 | `tsc --noEmit`（后端 + 前端）无 error |
| 全量单元/集成测试 | **175 文件通过 / 4 跳过（共 179）；2390 条通过 / 16 跳过（共 2406）；0 失败** |
| 生产构建 | 后端 `tsc` + 前端 `vite build` 成功 |
| **Playwright UI 验收（真实浏览器，桩模型实例）** | **18 项，通过 18，失败 0** |
| **Playwright PDF 上传验收（真实浏览器，用户上线实例 9999）** | **10 项，通过 10，失败 0** |
| 需求工作流 | intent → prd → tech_solution → coding → deploy → ui_test → issue（7 篇）→ 本报告 |

P1 五个子项——父子分块 / FAQ 索引 / 预生成问题（Doc2Query）/ 查询改写扩展 / 查询理解——均已实现，
并在**真实浏览器里从界面走通**。

UI 验收过程中发现 **8 个缺陷**，全部按「Issue 修复任务工作流程」处理：定位根因（有证据）→
写 issue 文档 → 修复 → 回归。清单见 §5。

> ⚠️ 本报告的验收方法是**被用户上线实例打回来的**：§3 的 18 项在本地全绿，
> 而用户点「上传文档」时按钮完全没反应（D6）。根因是 `setInputFiles()` 绕过了点击那一跳。
> 此后新增的 PDF 验收（§3.2）一律改成"点按钮拿 `filechooser`"，并且**在用户真实用到的
> 9999 实例上、用他真实上传的那个文件**跑，而不是只在本地隔离实例上跑桩数据。
> **一个只在自建环境里全绿的验收，不算验收。**

---

## 2. 环境与被测对象

| 项 | 值 |
|---|---|
| 被测版本 | `worktree-feat-kb-full-replica` 工作区（含本次 5 处修复） |
| 实例 | `make start-prod PORT=9911`，`DEEPTHINK_DATA_DIR=~/.deepthink-9911` |
| 后端 | `node dist/index.js`（tsc 产物，非 ts-node） |
| 前端 | `web/dist`（vite build 产物，由后端静态服务） |
| 嵌入 / 问答模型 | **自带 OpenAI 兼容桩服务**（`tests/e2e/kb-p1-ui.mjs` 内起，`127.0.0.1:<随机端口>`） |
| 浏览器 | 本机 Google Chrome（`playwright-core`，`channel: 'chrome'`） |

**为什么用桩模型**：真跑一遍向量化与出题需要外部凭据，且模型输出不可复现（同一输入每次问法不同，
用例会静默失效）。桩服务只实现两个端点（确定性向量 + 固定模板出题），**不接任何外部网络**，
让整条链路在真实 UI 上可复现地跑通。

桩的确定性向量在码点上做哈希，**不是语义相似度** —— 这决定了用例的设计：只有索引文本与查询文本
逐字节相同才会得 1.0 分。验收里的「FAQ 相似问题参与检索」正是利用这一点，用**只在相似问题里出现过**
的问法去查，命中即证明走的是问题索引而非正文。

**关键设计**：检索用例的查询串**不是脚本里写死的**，而是从界面上把系统刚刚生成的问题读回来，
并先断言这句话不在文档正文里。写死的话换一个出题模板用例就会静默失效。

---

## 3. UI 验收用例（18 项，全部通过）

执行命令：

```bash
make start-prod PORT=9911
DT_BASE=http://localhost:9911 DT_USER=admin DT_PASS='******' \
DT_DATA_DIR=$HOME/.deepthink-9911 \
  node tests/e2e/kb-p1-ui.mjs
```

原始输出（节选，完整照录）：

```
✅ 知识库列表页可达（未被首导向导劫持） — http://localhost:9911/knowledge-bases
✅ 界面新建知识库 — P1 验收库 mvamrcw1 → 10343626-ba25-41bd-ba71-e788f5295871
✅ 上传区有「父子分块」开关
✅ 父子分块开关可勾选
✅ 点「上传文档」能唤起文件选择框
✅ 文档上传并入库完成
✅ 分块视图区分父块与子块 — 共 19 块 · 父块 6 · 子块 12
✅ 文档页签有 Doc2Query 面板
✅ Doc2Query 开关落库（刷新后仍为启用）
✅ 点击生成问题有明确反馈且成功 — 生成完成：合格分块 13 · 成功 13（问题 39 条）
✅ 分块上显示预生成问题 — 3 条：这段内容的退相干时间应该怎么测量
✅ 前置：探针问法不在文档正文里 — 这段内容的退相干时间应该怎么测量
✅ 预生成问题扩大了召回：命中分块正文而非问题本身 — kb-p1-e2e-mvamrcw1.md / 测量手册 > 零位检查
✅ 界面新建 FAQ 型知识库 — P1 FAQ 库 mvamrcw1
✅ FAQ 库隐藏「文档」「分块」页签 — kb-tab-faq, kb-tab-search, kb-tab-chat
✅ 界面新建 FAQ 条目 — 校准周期是多久
✅ 索引方式下拉与已保存值一致 — question_only / separate
✅ FAQ 相似问题参与检索（试检索命中该条目） — 1.000 Q: 校准周期是多久 Similar Questions: - 这台仪器多久要重新标定一次

合计 18 项，通过 18，失败 0
```

| # | 用例 | 覆盖子项 | 结果 | 截图 |
|---|---|---|---|---|
| 1 | 知识库列表页可达（未被首导向导劫持） | 环境 | ✅ | — |
| 2 | 界面新建知识库 | 全部 | ✅ | ![01](screenshots/01-kb-detail.png) |
| 3 | 上传区有「父子分块」开关 | §2.1 | ✅ | ![01](screenshots/01-kb-detail.png) |
| 4 | 父子分块开关可勾选 | §2.1 | ✅ | ![01](screenshots/01-kb-detail.png) |
| 5 | 文档上传并入库完成 | 全部 | ✅ | ![02](screenshots/02-kb-doc-ready.png) |
| 6 | **点「上传文档」能唤起文件选择框**（走真实点击） | §2.1 | ✅ | — |
| 7 | **分块视图区分父块与子块**（共 19 块 · 父块 6 · 子块 12） | §2.1 | ✅ | ![03](screenshots/03-kb-chunks-parent-child.png) |
| 8 | 文档页签有 Doc2Query 面板 | §2.3 | ✅ | ![04](screenshots/04-kb-doc2query-generated.png) |
| 9 | Doc2Query 开关落库（刷新后仍为启用） | §2.3 | ✅ | ![04](screenshots/04-kb-doc2query-generated.png) |
| 10 | 点击生成问题有明确反馈且成功（13 块成功 / 39 条问题） | §2.3 | ✅ | ![04](screenshots/04-kb-doc2query-generated.png) |
| 11 | 分块上显示预生成问题 | §2.3 | ✅ | ![05](screenshots/05-kb-chunk-questions.png) |
| 12 | 前置：探针问法**不在**文档正文里 | §2.3 | ✅ | ![05](screenshots/05-kb-chunk-questions.png) |
| 13 | **预生成问题扩大了召回**（命中分块正文而非问题本身） | §2.3 | ✅ | ![06](screenshots/06-kb-search-by-generated-question.png) |
| 14 | 界面新建 FAQ 型知识库 | §2.2 | ✅ | ![07](screenshots/07-kb-faq-panel.png) |
| 15 | FAQ 库隐藏「文档」「分块」页签 | §2.2 | ✅ | ![07](screenshots/07-kb-faq-panel.png) |
| 16 | 界面新建 FAQ 条目 | §2.2 | ✅ | ![08](screenshots/08-kb-faq-entry-created.png) |
| 17 | **索引方式下拉与已保存值一致**（question_only / separate） | §2.2 | ✅ | ![08](screenshots/08-kb-faq-entry-created.png) |
| 18 | **FAQ 相似问题参与检索**（试检索命中该条目，得分 1.000） | §2.2 | ✅ | ![09](screenshots/09-kb-faq-probe-hit.png) |

### 3.1 三条承重用例为什么可信（不是"跑过一次绿"）

Supervisor 原则要求二选一结论、证据支撑，故对最关键的三条说明其**非平凡性**：

**#12 预生成问题扩大了召回。** 若只写"搜到了就算数"，在一个只有单个分块的库里普通向量臂必然
命中，用例会平凡通过 —— §2.8 的负向验证已经证明过这一点（把检索里的 `generated_question`
合并整行删掉，旧版用例照样全绿）。现在是：先断言那句问法**不在正文里**（#11），再断言命中
**分块的正文**而不是问题本身。这样"搜到了"只能归因于问题索引。

**#6 父子分块的两层结构。** `共 19 块 · 父块 6 · 子块 12`——12 与库里 `parent_chunk_id` 非空的
行数一致（13 个子块去掉 1 个不属于任何父块的首块）。且用的是**足够长**的文档：父块 4096 字 /
子块 384 字，短文里父块与子块内容相同、按上游语义压根不建父块行，拿短文测等于测空气。

**#17 FAQ 相似问题。** 查询串是**只在「相似问题」字段里出现过**的问法，得分 `1.000`（桩向量是
确定性哈希，1.000 意味着索引文本与查询文本逐字节相同）—— 只有 `question_only` + `separate`
模式下「仅问题」那条变体向量才能同时满足这两点。这同时证明了三件事：条目建完就被索引了、
索引方式真的落在了 `question_only`/`separate`、相似问题确实各自成向量。

### 3.2 PDF 上传验收（10 项，全部通过）——在用户上报问题的那个实例上跑

D3–D6 都是**在隔离实例上用桩数据**验出来的，D7/D8（PDF）不一样：它们由用户在
**上线实例 `localhost:9999`** 上手动上传 PDF 时报告（`pdfParse is not a function`）。
所以这一轮的验收环境、验收文件、验收入口全部对齐用户的真实路径：

| 项 | 值 |
|---|---|
| 实例 | **`localhost:9999`（用户正在用的那个）**，`make start-prod PORT=9999` |
| 数据目录 | `~/.deepthink-9999`（用户自己建的知识库 `Harness 工程`） |
| 验收文件 | `/Users/edy/Downloads/CSCO非小细胞肺癌治疗指南2026.pdf`（49.7 MiB，用户原件） |
| 入口 | 界面点「上传文档」→ `filechooser` → 选中该文件（**不用 `setInputFiles`**） |
| 嵌入模型 | 该实例**未配置** `embedding.json` ⇒ 向量化不执行（见 §6 N11），不影响解析链路的验收 |

```bash
make start-prod PORT=9999
DT_BASE=http://127.0.0.1:9999 DT_USER=admin DT_PASS='******' \
DT_KB=40585997-0346-4468-bd71-8522134f7a1e \
DT_PDF="/Users/edy/Downloads/CSCO非小细胞肺癌治疗指南2026.pdf" \
  node tests/e2e/kb-pdf-upload.mjs
```

原始输出（完整照录）：

```
✅ 登录成功 — http://127.0.0.1:9999/chat
ℹ️  上传前该库文档数：0
ℹ️  真实文件：CSCO非小细胞肺癌治疗指南2026.pdf（49.7 MiB）
✅ 点「上传文档」能唤起文件选择框
ℹ️  界面提示："PDF has no extractable text (possibly a scanned image) | 已恢复连接"
ℹ️  接口响应：HTTP 400 — {"error":"PDF has no extractable text (possibly a scanned image)"}
✅ 真实 PDF 不再抛 pdfParse is not a function
✅ 扫描件给出可执行的失败原因（无文字层）
✅ 没有把噪声文档静默入库（列表条数未增加） — 0 → 0
ℹ️  正向对照：往一个对照知识库里传一份有文字层的真 PDF
ℹ️  复用对照库：PDF 解析验证 713131（6960c018-dc29-4486-83ba-12f32a36344f）
✅ 有文字层的 PDF 被接受（或判为重复） — Duplicate document (same content hash)
✅ 有文字层的 PDF 解析并切出分块 — text-layer.pdf 就绪 pdf 0.2 KB · 分块 1 · 已向量化 0
✅ 对照文档没有失败 — 就绪
✅ 分块正文里没有伪造的页码标记 -- n of N --
✅ 分块正文就是 PDF 里的真实文字

—— 共 10 项，通过 10，失败 0 ——
```

| # | 用例 | 结果 | 截图 |
|---|---|---|---|
| 1 | 登录成功 | ✅ | — |
| 2 | 点「上传文档」能唤起文件选择框（真实点击） | ✅ | ![10](screenshots/10-real-pdf-before.png) |
| 3 | 真实 PDF 不再抛 `pdfParse is not a function` | ✅ | ![11](screenshots/11-real-pdf-result.png) |
| 4 | 扫描件给出可执行的失败原因（无文字层） | ✅ | ![11](screenshots/11-real-pdf-result.png) |
| 5 | **没有把噪声文档静默入库**（列表 0 → 0） | ✅ | ![12](screenshots/12-real-pdf-nothing-ingested.png) |
| 6 | 有文字层的 PDF 被接受（或判为重复） | ✅ | — |
| 7 | 有文字层的 PDF 解析并切出分块 | ✅ | ![13](screenshots/13-textlayer-pdf-chunks.png) |
| 8 | 对照文档没有失败 | ✅ | ![13](screenshots/13-textlayer-pdf-chunks.png) |
| 9 | 分块正文里没有伪造的页码标记 | ✅ | ![13](screenshots/13-textlayer-pdf-chunks.png) |
| 10 | **分块正文就是 PDF 里的真实文字** | ✅ | ![13](screenshots/13-textlayer-pdf-chunks.png) |

#### 3.2.1 这份用户文件为什么"仍然失败"，以及为什么这是正确结果

`CSCO非小细胞肺癌治疗指南2026.pdf` 是 **287 页纯图片扫描件**：每页 0 个文字项、1 张图片，
可抽取字符数为 **0**。没有 OCR 就无法把它变成可检索的文本 —— 这不是本次修复能改变的，
也**不该**被"修"成"上传成功"：那等于把 287 页的图片索引成空内容。

修复前后对这份文件的处理：

| | 修复前 | 修复后（只修崩溃，不动 `pageJoiner`） | 修复后（两个都修） |
|---|---|---|---|
| 用户看到 | 红色 `pdfParse is not a function` | 绿色 `已上传` | 红色 `PDF has no extractable text (possibly a scanned image)` |
| 库里留下什么 | 什么都没留（解析在入库前） | **5,632 字符的 `-- 1 of 287 --` 噪声**，状态"就绪" | 什么都没留 |

中间那一列才是真正危险的：一份"看起来完全正常"的垃圾文档，会被切块、被向量化、
被检索引用回显。它之所以没发生，只因为崩溃挡在了前面 —— 修掉崩溃而不修 `pageJoiner`，
反而会把一个显式失败变成一次静默污染。

**结论（二选一）**：本文件在**无 OCR** 的前提下**无法入库，这是正确且已明确告知的结果**；
PDF 格式本身的上传链路**已修复并可用**（第 6–10 项，用带文字层的真 PDF 端到端验证）。

#### 3.2.2 两条断言为什么不是"空转"

- **第 5 项（静默入库）**：断言的是"上传前后文档列表条数不变"，而不只是"弹了错误提示"。
  §3.2.1 中间那一列的坏法恰恰是"提示看起来正常 + 库里多了脏数据"，只断提示会漏掉它。
- **第 10 项（分块正文）**：必须在分块页**先选中文档**再读页面文本。第一版脚本没选，
  页面上只有"请选择一份文档"，于是"正文里没有伪造标记"这条断言在空页面上恒真 ——
  脚本已经犯过一次这个错（截图 13 第一版是空页面），现在同时断言
  **分块正文里读得到 PDF 里的原句**（`DeepThink PDF 解析回归夹具` / `ASCII mixed content 12345`）。

---

## 4. 回归验证

```
npx tsc --noEmit -p tsconfig.json       → 通过（无 error 行）
npx tsc --noEmit -p web/tsconfig.json   → 通过（无 error 行）
npx vitest run                          → Test Files  175 passed | 4 skipped (179)
                                          Tests  2390 passed | 16 skipped (2406)
                                          Duration 9.20s
```

基线对照（每一步都是全量回归，不是只跑新用例）：

| 阶段 | 文件 | 用例 |
|---|---|---|
| §2.1 父子分块 | 166 | 2214 |
| §2.4 查询扩展 | 168 | 2239 |
| §2.5 查询理解 | 170 | 2274 |
| §2.2 FAQ 索引 | 172 | 2348 |
| §2.3 Doc2Query | 173 | 2401 |
| P1 收尾（D6 上传按钮） | 174 | 2402 |
| **本次（D7/D8 PDF 解析）** | **175** | **2406** |

本次净增的 4 条全部来自新增的 `tests/units/document-parser-pdf.test.ts`
（2402 + 4 = 2406，与上表一致）。**这个文件此前不存在** —— PDF 解析在 `17d6bd1`
引入后一直没有测试，这正是 D7 能躺这么久的原因。

**§3 的 18 项 P1 UI 验收本轮未重跑**，理由与证据：D7/D8 的改动只在
`parsePdf`（`src/document-parser.ts`），而 P1 用例上传的是 `.md` 文件 ——
`detectParser()` 命中 `markdown` 分支，`parseByType()` 走 `default: buf.toString('utf8')`，
**根本不经过 `parsePdf`**。受影响的路径由 §3.2 的 10 项覆盖。

本次 +1 条来自 `tests/units/kb-faq-search.test.ts`：原本一条用例同时断言"PUT 后条目可检索"与
"PUT 会把 embedding 置空"，而 D4 的修复（PUT 后立刻重建向量）让后半句不再成立（是**语义变了**，
不是回归）。已拆成两条——一条锁路由行为（PUT 返回时已有新向量），一条锁 db 层机制
（改内容必然清空旧向量）——**"改了内容却留旧向量"这条静默错误召回路径仍然被断言锁住**。

**§4 历次记录里的那条偶发失败**（`tests/feishu-card.test.ts` 动态 import 超时，约 4 次挂 1 次）
本次全量运行中通过。该条在更早的父提交上就被证明与 KB 改动无关（独立 worktree 复现同一条、
同 5007ms），按"只清理自己弄脏的地方"未改动。

---

## 5. 验收发现并修复的 8 个缺陷

全部走 Issue 修复任务工作流程，每篇含固定的 8 节结构（用户现象 / 问题描述 / 根因 / 复现路径 /
诊断方法 / 修复方案 / 处理卡住的状态 / 经验沉淀）。**8 个缺陷里有 7 个单测全绿也照样漏**
——它们都在"数据对、链路对"之后的那一公里。

| # | issue 文档 | 用户现象 | 根因层 | 修复 |
|---|---|---|---|---|
| D1 | [start-prod 服务的是桌面版内置前端](../../issues/2026-10-16-start-prod-serves-desktop-web-dist.md) | 改了代码页面不变，UI 脚本找不到元素 | 基础设施 | `_start-direct` 显式钉死 `DEEPTHINK_WEB_DIST_DIR` |
| D2 | [stop-prod 报成功、几秒后端口又被占](../../issues/2026-10-16-stop-prod-watchdog-resurrects-instance.md) | 停止命令报成功但没停掉；启动命令报成功但服务的是旧进程 | 基础设施 | `stop-prod` 给看门狗发 TERM；启动成功判据比对 pid 而非"端口有人听" |
| D3 | [父子分块界面上完全不可用](../../issues/2026-10-16-kb-parent-child-invisible-end-to-end.md) | 勾不上、看不到父/子标记、只有父块没子块 | 前端入口 + 呈现 + 接口字段（**3 处**） | 上传面板补开关、分块视图补标记、`serializeChunk` 补 `parent_chunk_id` |
| D4 | [FAQ 条目建完不被向量化](../../issues/2026-10-16-faq-entry-not-indexed-on-create.md) | 条目永远"待向量化"，试检索永远不命中 | 后端漏调用索引 | POST/PUT 后内联 `indexFaqEntry`（对齐上游同步索引语义） |
| D5 | [FAQ 索引方式下拉改完自己弹回旧值](../../issues/2026-10-16-faq-index-mode-select-reverts.md) | 界面显示旧值、服务端其实已改、检索行为是新配置 | 前端漏回写 store | `updateFaqConfig` 把 PATCH 响应写回 `list` |
| D6 | [「上传文档」按钮点了没反应](../../issues/2026-10-16-kb-upload-button-label-swallows-click.md) | 不弹文件框、不报错，界面完全无法上传文档 | `<label>` 按规范**不转发**对 `<button>` 的点击 | 改 `ref.current?.click()`，与仓库其余 5 处一致 |
| D7 | [上传 PDF 报 `pdfParse is not a function`](../../issues/2026-10-16-kb-pdf-parse-crash-and-fabricated-page-markers.md) | 任何 PDF 上传 100% 失败，列表不留痕迹 | `pdf-parse` v2 改成**具名类导出**，`mod.default ?? mod` 退化成了模块命名空间对象 | 改 `new PDFParse({data})` + `getText()` + `finally destroy()` |
| D8 | 同上（同一函数里的第二个缺陷） | 无 —— 单看界面一切正常 | `getText()` 的 `pageJoiner` 默认值**给每页伪造 `-- n of N --`**，空值守卫永远不触发 | 传 `pageJoiner: ''` 关掉伪造 |

**D7/D8 是"修一个必须连着修另一个"的典型**：D7 挡在前面时，扫描件在上传时直接崩掉；
只修 D7 而不修 D8，同一份文件会"上传成功"并入库 5,632 字符的伪造页码标记 ——
**从一次显式失败，变成一次静默污染**。两个缺陷各自都有独立的回归用例，
并分别做过负面验证（回退 D7 → 挂 3 条；只回退 D8 → 挂 2 条）。

**D1/D2 值得单独讲**：它们不是产品缺陷，是**验证基础设施的缺陷**，而且是最危险的一类——
D1 让"我改的代码"根本没被服务（编译成功但没人用），D2 让"启动成功"是假的（服务的是上一轮的
进程）。两者都会让后续**所有**验证结论失效。D2 修复前的 symptom 就是"命令说成功、实际服务旧进程"，
按 Supervisor 原则这比直接失败更贵。两条都补了身份校验：D1 比对前端 bundle 名，D2 比对监听 pid
与 pidfile。

**D3 是三个缺陷串行暴露的**（修好前一个才看得见后一个），完整过程留在 issue 文档里：
上传参数没接 → 补上开关后仍看不到标记 → 补上标记后只有父块 → 才发现接口漏吐 `parent_chunk_id`。

**D4 与 D5 在同一块界面上、现象都是"改了没用"，根因完全不同**（一个后端没存、一个前端没显示）。
issue 文档末尾附了对照表，下次遇到先看服务端真值就能一步区分。

**D6 是用户在上线实例上报出来的，而且暴露了本报告的验收方法有一个漏洞**：Playwright 的
`setInputFiles()` 直接给 `<input type=file>` 赋值，**绕过了"点按钮"这一跳**——于是
「按钮点不动」这个最直白的失败，恰好落在全部 17 条断言之外。验收脚本已改为
`waitForEvent('filechooser')` + `fileChooser.setFiles()`，必须点得动按钮才能拿到文件句柄
（这正是第 6 项用例）。配对负向验证：同一探针脚本打修前/修后两个构建，
`inputClicks` 0 → 1、`filechooser` ❌ → ✅，唯一变量就是那处 JSX。

---

## 6. 已知缺口（显式登记，不声称已解决）

完整清单在 `docs/task_state/2026-10-16-weknora-full-replica/STATE.md` §5。本次新增/仍然开放的：

| # | 缺口 | 说明 |
|---|---|---|
| N1 | 切换「索引方式」会让全库向量一次性作废，**没有重建入口**（toast 仍提示"需重新向量化"） | D4 只修了"新建/编辑即索引"；改配置这条路径仍无 UI 入口，与 D4 同因同源 |
| N2 | `make status` 未做看门狗一致性巡检 | D2 的建议项，本次未改（超出修复范围） |
| N3 | `src/web.ts` 未在启动日志里打印实际的静态资源根目录 | D1 的建议项，下次同类问题可一眼看出，本次未改 |
| N4 | FAQ `separate` 模式变体向量走**精确线性扫描**，无 ANN 索引 | 性能取舍非召回取舍；量级上来要重建索引（STATE §5 #7/#12） |
| N5 | Doc2Query 生成的问题**只进向量索引、不进关键词索引**（上游两边都进） | 有意取舍，召回只增不减（STATE §5 #11） |
| N6 | 生成是**同步接口且不记进度**，几百个分块时请求一直挂着、刷新页面查不到进度 | 单进程无任务队列的必然结果（STATE §5 #13） |
| N7 | KB 级 chat 模型取全局 `rag.json`，不按库指定（上游 `kb.SummaryModelID`） | 本仓库无按库配模型的存储（STATE §5 #14） |
| N8 | 同类 SSRF 路径仍有 2 处未修：`container/agent-runner/src/mcp-tools.ts:2809`、`container/agent-runner/src/web-search.ts:355` | 已登记 PRD §2.9，未修 |
| N9 | `GET /api/paas/marketplace/:id` 不按 `status` 过滤 | 已报告，等用户决策 |
| N10 | **纯扫描件（无文字层）的 PDF 无法入库，本仓库没有 OCR** | 用户那份 287 页扫描件属于此类。当前行为是**明确报错**（不再崩溃、不再静默入库）。要支持需要接 OCR / 视觉模型逐页识别，**成本与选型需用户决策**（见 §3.2.1） |
| N11 | `~/.deepthink-9999` **未配置 `embedding.json`**，向量化不执行（`已向量化 0`） | 该实例上知识库目前只有关键词（FTS）可用，混合检索的向量臂是空的。属于**环境配置**，不是代码缺陷；配置后需点「重建索引」补向量（该入口存在） |
| N12 | 上传接口先 `c.req.formData()` 再判大小，**整个请求体先落内存** | 100MB 限制是**可用性闸门，不是内存保护**（STATE §5 #19） |
| N13 | 解析类错误信息是英文（`PDF has no extractable text…`），直接透传到界面 toast | 与仓库其余解析器错误（DOCX / CSV / JSON）风格一致，故未单独本地化；若要面向最终用户，建议统一在接口层做一次错误文案映射 |

**HONESTY 声明**：本报告的"通过"仅指 §3 的 18 项 UI 用例、§3.2 的 10 项 PDF 验收与 §4 的全量回归。桩模型验证的是
**链路的正确性**（索引文本、召回路径、配置落库），**不是模型语义质量**——换成真实模型后，
"预生成问题是否真的扩大了召回"需要在真实语义空间里重新评估。

---

## 7. 交付物

```
docs/intent/2026-10-16-weknora-full-replica/
docs/prd/2026-10-16-weknora-full-replica/PRD.md
docs/tech_solution/2026-10-16-weknora-full-replica/SOLUTION.md
docs/task_state/2026-10-16-weknora-full-replica/STATE.md
docs/issues/2026-10-16-start-prod-serves-desktop-web-dist.md
docs/issues/2026-10-16-stop-prod-watchdog-resurrects-instance.md
docs/issues/2026-10-16-kb-parent-child-invisible-end-to-end.md
docs/issues/2026-10-16-faq-entry-not-indexed-on-create.md
docs/issues/2026-10-16-faq-index-mode-select-reverts.md
docs/issues/2026-10-16-kb-upload-button-label-swallows-click.md
docs/issues/2026-10-16-kb-pdf-parse-crash-and-fabricated-page-markers.md   ← D7/D8
docs/test_report/2026-10-16-weknora-full-replica/
  ├─ TEST_REPORT.md          ← 本文
  ├─ ui-test.mjs             ← 早期 UI 探路脚本（保留，未作为验收依据）
  ├─ stub-provider.mjs       ← 桩模型服务（被 kb-p1-ui.mjs 内联复用）
  ├─ fixtures/               ← 测试夹具
  └─ screenshots/            ← 13 张通过截图（01–13）
tests/e2e/kb-p1-ui.mjs       ← 18 项 P1 UI 验收（可复跑）
tests/e2e/kb-pdf-upload.mjs  ← 10 项 PDF 上传验收（可复跑，需 DT_PDF 指定真实 PDF）
tests/e2e/_probe-upload.mjs  ← 一次性探针：验证「点击 → filechooser」这一跳（诊断用，保留）
tests/units/document-parser-pdf.test.ts   ← 4 项 PDF 解析回归（此前零覆盖）
tests/fixtures/pdf/{text-layer,no-text-layer}.pdf  ← 真 PDF 夹具（cupsfilter 生成，非 mock）
```

复跑方式：`make start-prod PORT=9911` 后执行 §3 的命令即可。
