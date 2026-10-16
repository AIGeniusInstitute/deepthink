# 技术方案 · 本机内置模型服务 + 扫描件 OCR

- **日期**：2026-10-16
- **PRD**：`docs/prd/2026-10-16-local-model-service/PRD.md`
- **分支**：`worktree-feat-local-model-service`（`~/deepthink/.claude/worktrees/feat-local-model-service`）
- **基线**：`28482f4`

---

## 1. 总体结构

```
                    ┌───────────────────────────────────────┐
                    │  管理员 · 设置 → Embedding 配置        │
                    │  LocalModelPanel.tsx                  │
                    └──────────────┬────────────────────────┘
                                   │ /api/paas/local-model/*
                    ┌──────────────▼────────────────────────┐
                    │  routes/paas-local-model.ts           │
                    │  探测 / 拉起 / 下载 / 一键启用 / OCR 开关 │
                    └───────┬───────────────────┬───────────┘
                            │                   │
              ┌─────────────▼──────┐   ┌────────▼─────────────┐
              │ local-model.ts     │   │ ocr.ts               │
              │ Ollama 适配层       │   │ 光栅化 + 视觉转写      │
              └─────────┬──────────┘   └────────┬─────────────┘
                        │                       │
                        │              ┌────────▼─────────────┐
                        │              │ kb/ocr-ingest.ts     │
                        │              │ 后台任务编排          │
                        │              └────────┬─────────────┘
                        │                       │ 补正文
              ┌─────────▼───────────────────────▼─────────────┐
              │  embedding.ts        db.ts    kb/pipeline.ts  │
              │  embedding.json   占位行/补正文  分块 → 向量化  │
              └───────────────────────────────────────────────┘
                                   │
                    ┌──────────────▼────────────────────────┐
                    │  Ollama  http://127.0.0.1:11434       │
                    │   bge-m3 (1024d)  ·  qwen3-vl:8b      │
                    └───────────────────────────────────────┘
```

两条链路共用同一个「本机模型服务」：向量模型写进 `embedding.json`，视觉模型写进 `ocr.json`，
两者都默认指向 `DEEPTHINK_LOCAL_MODEL_URL`（默认 `http://127.0.0.1:11434`）。

---

## 2. 新增/修改的文件

| 文件 | 类型 | 说明 |
|---|---|---|
| `src/local-model.ts` | 新增 | Ollama 适配层：探测、模型清单、拉取、拉起进程、维度探测 |
| `src/ocr.ts` | 新增 | OCR 配置、PDF 光栅化、视觉转写、整本编排 |
| `src/kb/ocr-ingest.ts` | 新增 | 后台 OCR 任务：进度落库 → 补正文 → 交给既有 ingest 管线 |
| `src/routes/paas-local-model.ts` | 新增 | `/api/paas/local-model` 六个接口 |
| `web/src/components/settings/LocalModelPanel.tsx` | 新增 | 设置页的「本机内置模型服务」面板 |
| `src/document-parser.ts` | 改 | 新增 `PdfHasNoTextLayerError`，`parsePdf` 改抛它 |
| `src/db.ts` | 改 | 新增 `addPendingKbDocument` / `replaceKbDocumentContent` |
| `src/kb/pipeline.ts` | 改 | `ParseStatus` 增加 `'ocr'` |
| `src/routes/paas-knowledge-bases.ts` | 改 | 上传路径分支到扫描件通道 |
| `src/web.ts` | 改 | 挂载新路由 |
| `web/src/pages/KnowledgeBaseDetailPage.tsx` | 改 | `ocr` 状态、进度显示、`pdf_ocr` 标签 |
| `web/src/stores/knowledge-bases.ts` | 改 | 上传返回值带 `ocr` 标志 |
| `web/src/components/settings/EmbeddingSettingsSection.tsx` | 改 | 顶部嵌入 `LocalModelPanel` |
| `tests/units/ocr-pipeline.test.ts` | 新增 | 8 个用例 |
| `tests/units/ocr-rasterize.test.ts` | 新增 | 6 个用例 |
| `tests/units/local-model.test.ts` | 新增 | 11 个用例 |
| `tests/fixtures/pdf/scanned-3p.pdf` + `build-scanned-pdf.mjs` | 新增 | 三页纯图片 PDF 夹具及其可复现构建脚本 |

**没有新增任何 npm 依赖。** 光栅化用的 `@napi-rs/canvas@0.1.80` 和 `pdfjs-dist@5.4.296` 本来就是
`pdf-parse` 的传递依赖，已经在依赖树里。

---

## 3. `src/local-model.ts`

### 3.1 模型名归一化

Ollama 里 `bge-m3` 拉下来叫 `bge-m3:latest`。不做归一化，「已安装」判断永远为假 ——
界面上刚拉完的模型仍显示"未下载"，用户再点一次就是重复下载 1.2GB。

```ts
normalizeModelName('bge-m3')        // 'bge-m3'
normalizeModelName('bge-m3:latest') // 'bge-m3'
normalizeModelName('qwen3-vl:8b')   // 'qwen3-vl:8b'（显式 tag 保留）
```

### 3.2 探测不抛异常

`probeLocalModelService()` 在服务没起时返回 `{available: false, error: 'ECONNREFUSED…'}`，
**不向外抛**。"没启动"是这个功能的正常状态之一，调用方需要的是结构化的原因，不是一个异常。

### 3.3 拉取的错误藏在 HTTP 200 的 body 里

Ollama 的 `/api/pull` 用 HTTP 200 + NDJSON，失败时在流里发 `{"error": "..."}`。
只看 `res.ok` 会把"拉取失败"当成"拉取成功"。所以逐行解析时必须检查 `event.error`。

### 3.4 拉起服务进程

```ts
spawn(bin, ['serve'], { detached: true, stdio: 'ignore' }).unref();
```

`detached` + `unref` 让服务进程不跟随 DeepThink 主进程 —— 否则每次重启后端都要重拉模型到显存。
拉起后 500ms 一次轮询 `/api/version`，最长等 20s。二进制从
`/opt/homebrew/bin/ollama`、`/usr/local/bin/ollama`、`/usr/bin/ollama` 依次找。

---

## 4. `src/ocr.ts`

### 4.1 配置

`data/config/ocr.json`，与 `embedding.json` / `rag.json` 同目录同风格（0600 原子写）。

```jsonc
{
  "enabled": true,
  "provider": "ollama",     // 'ollama' → /api/chat；'openai' → /v1/chat/completions
  "baseUrl": null,          // null = 跟随本机模型服务（http://127.0.0.1:11434）
  "apiKey": "ollama",       // 仅 openai 协议用；Ollama 不校验
  "model": "qwen3-vl:8b",
  "dpi": 150,
  "maxPages": 300,
  "concurrency": 2,
  "timeoutMs": 300000,
  "maxPixels": 6000000,
  "numCtx": 16384           // 仅 ollama 协议生效
}
```

所有数值字段过一遍 `clampInt`，防止手改配置文件写出 `dpi: 99999` 这种把内存打满的值。

### 4.1.1 为什么要分两套协议（本轮实测发现的关键缺陷）

**Ollama 的 OpenAI 兼容端点会静默忽略 `num_ctx`。**

实测证据：在 `/v1/chat/completions` 里传 `options.num_ctx = 16384`，调用后
`GET /api/ps` 显示模型仍是 `qwen3-vl:8b ctx=4096` —— 参数被吞了。

而 Ollama 默认上下文只有 4096。一页 150dpi 的扫描图光图片就占约 2200 token；
`qwen3-vl:8b` 是**思维链模型**，把剩下的额度全花在 reasoning 上，于是：

```
finish_reason: "length"   total_tokens: 4096   contentLen: 0   reasonLen: 4196
```

**content 为空**。旧代码把这个空当成"这页是空白页"跳过 —— 实测 3 页夹具
只留下 1 页正文，287 页的扫描件会静默丢掉大半，且不报任何错。

修法两条，缺一不可：

1. **走原生 `/api/chat`**（`provider: 'ollama'`），只有这条路的 `options.num_ctx` 生效。
   实测 `ctx=16384`、`done_reason=stop`、正文正确且表格是合法的 Markdown 表格。
2. **把截断和空白分开**：`done_reason`/`finish_reason === 'length'`，
   或「有思维链但正文为空」，都判为**该页失败**（正文里留痕「第 N 页 OCR 失败」），
   绝不记成 `emptyPages`。锁死这条的回归用例在 `tests/units/ocr-pipeline.test.ts`
   的「截断必须被当成失败，而不是空白页」一组。

非 Ollama 的服务商仍走 OpenAI 兼容路径，把 `provider` 改成 `'openai'` 即可，代码不用动。

### 4.2 光栅化

```ts
const doc = await pdfjs.getDocument({ data: new Uint8Array(buf), useSystemFonts: true }).promise;
const viewport = page.getViewport({ scale: cfg.dpi / 72 });
// maxPixels 保护：等比缩小
const canvas = createCanvas(w, h);
ctx.fillStyle = '#ffffff'; ctx.fillRect(0, 0, w, h);   // ← 关键
await page.render({ canvasContext: ctx, viewport }).promise;
```

三个容易踩的点：

1. **必须先铺白底。** PDF 页面背景是透明的，渲染成 PNG 就是黑色。直接喂给视觉模型会得到"图全黑"，
   而这看起来像模型不行，不像代码写错了。
2. **`maxPixels` 保护。** 真实扫描件的 MediaBox 很大：用户那份 PDF 的第 1 页在 200 DPI 下是
   6886×4697 = 32M 像素。不设上限，单页 canvas 就要 128MB。
3. **逐页吐出去，不攒在内存里。** 287 页 × 400KB PNG ≈ 115MB，再叠一份 base64（+33%）
   和模型自身的内存，没有必要。`forEachPdfPagePng` 是回调式而非收集式。

实测（夹具 3 页 @150DPI）：**约 430ms/页**，PNG 魔数正确，尺寸符合 `dpi/72` 比例。

### 4.3 并发与失败容忍

```
forEachPdfPagePng ──逐页──▶ acquire() ──▶ runPage() ──▶ release()
                              │
                              └─ while (active >= concurrency) await waiter
```

- 用 `while` 复检而不是 `if`：`release()` 唤醒 waiter 走的是微任务，这中间可能有新的 `acquire()`
  抢走名额。`if` 会突破并发上限。
- 队列长度超过 `concurrency * 4` 就 `await Promise.all` 排空一次，防止光栅化远快于 OCR 时
  待处理图片无限堆积。
- **单页失败不中断整本**：287 页里有 2 页模型抽风，丢掉另外 285 页的正确结果是最差的选择。
  失败页码记下来，在正文末尾追加「第 N 页 OCR 失败」。
- **全部页失败必须抛错**：静默返回空文本会让用户以为"这本书是空的"。

实测（桩服务，8 用例）：三页正常 / 单页失败 / 全失败抛错 / 空白页不留痕 / maxPages 截断 /
并发 3 不串页，全部通过。

### 4.4 页码标记

每页正文前加 `【第 N 页】`。这与 D8 那个缺陷**形态相似但性质相反**：D8 是给**没有正文**的页
伪造标记，让空扫描件伪装成有内容；这里是给**确有正文**的页标注真实出处。

判定标准写进代码：`results.get(n)` 为空（含 `''`）的页**不输出标记**。

### 4.5 提示词

```
你是 OCR 引擎。请把这张扫描页图片完整转写为 Markdown 文本。
要求：
1. 逐字转写，不要总结、不要翻译、不要解释、不要补充图中没有的内容。
2. 表格必须转写为 Markdown 表格，保留行列结构；合并单元格在其覆盖的每个位置重复内容。
3. 标题用 # 标记，列表项用 - 标记，正文段落之间空一行。
4. 无法辨认的字符用 □ 代替；空白页直接输出空内容。
5. 只输出转写结果本身，不要任何前后说明。
```

第 1 条和第 5 条是必须的：视觉模型的默认行为是**描述**这张图（"这张图片显示了一张关于……的表格"），
对表格会给出概括而不是转写，那对检索毫无价值。第 2 条正是弃用传统 OCR 的理由。

---

## 5. `src/kb/ocr-ingest.ts` —— 为什么必须异步

### 5.1 时序

```
POST /:id/documents
  ├─ parsePdf(buf) ──▶ throw PdfHasNoTextLayerError
  ├─ 探测：OCR 开关 / 服务可用 / 模型已装      ← 任一不满足，当场 400
  ├─ addPendingKbDocument()                    ← content='', hash='pending:<uuid>'
  ├─ startOcrIngestAsync()                     ← 立刻返回
  └─ 201 { document, ocr: true }

（后台）
  ocrPdf() ──进度──▶ parse_stage = `ocr 12/287`
      ├─ 成功 ──▶ replaceKbDocumentContent() ──▶ setDocumentParserType('pdf_ocr')
      │              └─▶ startIngestAsync()  ← 与普通文档完全相同的分块/向量化
      └─ 失败 ──▶ parse_status='failed', error_message
```

### 5.2 三个必须处理的问题

**(a) 占位 hash 不能是空串的 hash。**
`addKbDocument` 的去重比的是 `content_hash`。空串的 hash 是常量，两份同时待 OCR 的扫描件
会被判成同一份，第二份直接 409。所以占位用 `pending:<uuid>`，真正的去重推迟到正文落库时。

**(b) 上传前就检查 OCR 能不能跑。**
OCR 失败要几十分钟后才暴露，而失败原因（模型没装 / 服务没起）上传前就已知。
让用户等半小时再看"识别失败"，不如当场 400 并告诉他去设置页做什么。代价是扫描件上传
多一次 3 秒内的探测。

**(c) 补上正文后才发现重复。**
此时还没有分块，直接把这份标为失败并写明「OCR 后的正文与知识库中已有文档完全一致（重复上传）」，
比留一份永远 pending 的文档清楚。

### 5.3 进度写入

`parse_status = 'ocr'`，进度写 `parse_stage`（`ocr 12/287`）。
节流 2 秒 —— 287 页每页写一次 DB 没必要，前端 1.5s 轮询一次就够了。

---

## 6. 数据库改动（`src/db.ts`）

```ts
addPendingKbDocument(kbId, userId, filename): KbDocumentRow
// INSERT ... content='', content_hash='pending:<uuid>', parse_status='ocr'

replaceKbDocumentContent(docId, content): { duplicateOf: string | null }
// 重算 sha256 → 同库查重 → UPDATE content / content_hash / size_bytes
```

`kb_documents_fts` 上有 `kb_docs_au` UPDATE 触发器，所以改 `content` 后全文索引自动跟上，
不需要额外 rebuild。

---

## 7. 接口

挂载点 `/api/paas/local-model`，全部要求登录 + admin。

| 方法 | 路径 | 说明 |
|---|---|---|
| GET | `/` | 服务状态、模型清单、推荐模型（已装/已启用）、当前 embedding 与 ocr 配置 |
| POST | `/start` | 拉起本机服务进程并等待就绪 |
| POST | `/pull` | 拉取模型，**NDJSON 流式返回进度** |
| PUT | `/embedding` | 一键启用本机向量模型（探测 → 验模型 → 问维度 → 写配置） |
| GET | `/ocr-config` | 读 OCR 配置 |
| PUT | `/ocr-config` | 改 OCR 配置（enabled / model / dpi / maxPages / concurrency） |

`POST /pull` 用流而不是等拉完再返回：qwen3-vl 有 6GB，同步返回会让客户端只能挂一个转圈，
也无从判断是在下载还是卡死。响应头带 `X-Accel-Buffering: no` 防止反向代理缓冲。

`PUT /embedding` 的顺序是刻意的：**任何一步失败都不留下半截配置**。

---

## 8. 前端

- `LocalModelPanel.tsx`：服务状态行（不可用时显示「启动服务」）、向量模型行、扫描件 OCR 行、
  已安装模型清单。下载进度条直接读 NDJSON 流。
- `EmbeddingSettingsSection.tsx`：面板放在最上方 —— 绝大多数管理员没有现成的 Embedding API Key，
  本机模型的路径最短，且启用后下面那些字段就不需要手工填。
- `KnowledgeBaseDetailPage.tsx`：`ocr` 加入 `PENDING_STATUSES`（否则轮询在 OCR 一开始就停了）、
  加 `ocr` 的状态标签与配色、把 `parse_stage` 摊开显示成进度、`pdf_ocr` 显示为 `PDF·OCR`。
- 上传成功的 toast 区分扫描件与普通文档。

---

## 9. 9999 实例落地

1. `~/.deepthink-9999/config/embedding.json` 由**界面上的「一键启用」**写入（不是手工写文件）：
   `{baseUrl: "http://127.0.0.1:11434/v1", apiKey: "ollama", model: "bge-m3", dimensions: 1024}`。
2. 维度从 1536（默认值）变为 1024，`syncVecDimensionFromConfig()` 会 drop + recreate `vec0` 表。
   切换前已确认 9999 的 `kb_chunks` 中 `embedding IS NOT NULL` 计数为 **0** —— 没有向量可丢。
3. 重启 9999（`make start-prod PORT=9999`）后重新走一遍上传 + 检索验证。

---

## 10. 已知限制

| 限制 | 说明 |
|---|---|
| 页眉页脚重复 | 287 页的页眉会在每页重复出现，进入索引形成噪声。未做去重 —— 规则容易误删正文 |
| OCR 质量取决于模型 | qwen3-vl:8b 对清晰印刷体表格够用，对低质量扫描/手写体不保证。可换模型 |
| 无跨页表格合并 | 跨页拆开的表格被当成两张表 |
| `maxPages` 默认 300 | 超出的页不转写，正文末尾留痕说明 |
| 首次启用需下载 7GB+ | bge-m3 1.2GB + qwen3-vl:8b 6.1GB |
