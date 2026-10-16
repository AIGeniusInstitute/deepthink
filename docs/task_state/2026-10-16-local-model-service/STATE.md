# 执行状态 · 本机内置模型服务 + 扫描件 OCR

- **日期**：2026-10-16
- **分支**：`worktree-feat-local-model-service`
- **PRD**：`docs/prd/2026-10-16-local-model-service/PRD.md`
- **方案**：`docs/tech_solution/2026-10-16-local-model-service/SOLUTION.md`

---

## 1. 当前结论（一句话）

**代码链路已打通并经真模型验证**：扫描件能 OCR、能按 Markdown 保留表格、失败页会留痕而不再静默丢页。
**但默认视觉模型的吞吐不达标**，正在用实测数据选型（见 §4）。

---

## 2. 已完成

| # | 事项 | 证据 |
|---|---|---|
| 1 | Ollama 适配层（探测 / 拉起 / 拉取 / 维度探测） | `tests/units/local-model.test.ts` 11 项通过 |
| 2 | PDF 光栅化（dpi、maxPixels、maxPages、并发池） | `tests/units/ocr-rasterize.test.ts` 6 项通过 |
| 3 | OCR 编排（失败容忍、页码标记、截断判定） | `tests/units/ocr-pipeline.test.ts` 13 项通过 |
| 4 | 扫描件后台入库链路（占位行 → 补正文 → 走既有 ingest） | `src/kb/ocr-ingest.ts` |
| 5 | `/api/paas/local-model` 六个接口 + 设置页面板 | `src/routes/paas-local-model.ts`、`LocalModelPanel.tsx` |
| 6 | 前端 `ocr` 状态 / 进度 / `PDF·OCR` 标签 | `KnowledgeBaseDetailPage.tsx` |
| 7 | 后端 + 前端 `tsc --noEmit` 均干净 | 见 §5 |
| 8 | 三页扫描件夹具（可复现构建） | `tests/fixtures/pdf/scanned-3p.pdf`，175,013 字节 |

---

## 3. 本轮发现并修复的缺陷（真模型实测暴露）

### 3.1 静默丢页 —— 截断被当成空白页

**现象**：3 页夹具跑完，`ocrPages: 3` 但正文里只有【第 3 页】，第 1、2 页凭空消失，**没有任何报错**。

**根因**：`qwen3-vl:8b` 是思维链模型。Ollama 默认 `num_ctx=4096`，一页 150dpi 扫描图
光图片就占约 2200 token，模型把剩余额度全用在 reasoning 上，然后：

```
finish_reason: "length"   total_tokens: 4096   contentLen: 0   reasonLen: 4196
```

`content` 为空。旧代码把空内容当成"这页是空白页"跳过。

**为什么比崩溃更危险**：287 页的扫描件可能静默丢掉大半，用户看到的是"上传成功、状态就绪"，
检索不到内容却无从追查。

**修法**（两条，缺一不可）：

| # | 改动 | 位置 |
|---|---|---|
| a | 走 Ollama 原生 `/api/chat` —— 只有这条路的 `num_ctx` 生效 | `src/ocr.ts` `ocrViaOllama` |
| b | `done_reason`/`finish_reason === 'length'` 或「有思维链无正文」→ 判为该页**失败**并留痕，绝不记 `emptyPages` | `src/ocr.ts` `assertNotTruncated` |

**为什么必须走原生协议**：实测在 `/v1/chat/completions` 里传 `options.num_ctx = 16384`，
调用后 `GET /api/ps` 仍显示 `ctx=4096` —— **OpenAI 兼容端点静默忽略了它**。
换原生 `/api/chat` 后 `ctx=16384`、`done_reason=stop`、正文正确。

**回归用例**：`tests/units/ocr-pipeline.test.ts` → 「截断必须被当成失败，而不是空白页」4 项。

### 3.2 修复后实测（qwen3-vl:8b，原生协议，num_ctx=16384）

```
总耗时 404s  单页 51s / 300s / 52s
页数 3  空页 0  失败 1
  失败 P2: 单页 OCR 超时（>300s）
  ✓ ALPHA-7749   ✗ BRAVO-2251   ✓ CHARLIE-9930   ✗ Osimertinib
```

**关键点**：失败的那一页**写进了正文**——

```
【注意：第 2 页 OCR 失败，正文缺失。】
```

并且 `空页 0`。旧代码在同样的情况下会报 `空页 1` 并把这一页静默丢掉。表格也按预期转成了
合法 Markdown 表格（`| Keyword: ALPHA-7749 |`），这正是弃用传统 OCR 的理由。

---

## 4. 未完成（当前卡点）

### 4.1 默认视觉模型选型 —— **已定论，改用 `qwen2.5vl:7b`**

同一份 3 页夹具、同一套产品代码 `ocrPdf()`、原生 `/api/chat`、`num_ctx=16384`、串行：

| 模型 | 单页耗时（实测） | 3 页结果 | 关键词 | 287 页（并发 2）估算 |
|---|---|---|---|---|
| `qwen3-vl:8b` | 51s / **>300s 超时** / 52s | 丢 1 页 | 2/4 | **6–12 小时** ❌ |
| **`qwen2.5vl:7b`** | **20s / 15s / 14s** | **全中，0 失败** | **4/4** | **约 38 分钟** ✅ |
| `moondream` | 7.5s | 3 页都"成功" | 幻觉 | ❌ 质量不合格 |

**`moondream` 的失败方式值得记一笔**：3 页 API 调用全部成功、7.5 秒完成、返回非空字符串 ——
只看接口指标它是"最好"的。实际上它**忽略了转写指令去描述图片**
（"The image shows a white piece of paper with black text on it…"），并把 `CHARLIE-9930`
幻觉成 `charlee-9000`。**协议正确而模型质量不合格，只能靠对着已知答案断言关键词才能发现** ——
这正是夹具里预置 `ALPHA-7749` / `BRAVO-2251` / `CHARLIE-9930` / `Osimertinib` 的原因。

**`qwen2.5vl:7b` 质量并不比 `qwen3-vl:8b` 差**：夹具第 2 页的关键词
（`Osimertinib` / `BRAVO-2251`）qwen3-vl 因该页超时而漏掉，qwen2.5vl 全部认出。
另外 qwen2.5vl 输出的是**带 `| --- |` 分隔行的合法 Markdown 表格**，qwen3-vl 的输出缺这一行。

已改 `RECOMMENDED_VISION_MODEL = 'qwen2.5vl:7b'`。链路对两种模型都支持，
想换回思维链模型只需改 `data/config/ocr.json` 的 `model`。

### 4.2 其余待办

- [x] ~~按实测数据定下默认视觉模型~~ → 已定 `qwen2.5vl:7b`（§4.1）
- [ ] e2e 验收 AC-1…AC-9（真实实例、真实文件选择框、分块正文含真实扫描词、检索命中）+ 截图
- [ ] `docs/test_report/2026-10-16-local-model-service/TEST_REPORT.md`
- [ ] 9999 落地：合并 main → 重建 → **先备份日志再** `make start-prod PORT=9999` → 用界面「一键启用」
- [ ] 清理 `spike-*.ts` 与 `/tmp/ocr-spike/*.png`

---

## 5. 验证命令与结果

```bash
# 单元测试（本机模块服务 + 光栅化 + OCR 编排 + PDF 解析）
npx vitest run tests/units/local-model.test.ts tests/units/ocr-rasterize.test.ts \
                tests/units/ocr-pipeline.test.ts tests/units/document-parser-pdf.test.ts
# → 19 passed（ocr-pipeline + ocr-rasterize）；全套见 §2

# 类型检查
npx tsc --noEmit                      # 后端：干净
cd web && npx tsc --noEmit            # 前端：干净

# 真模型验收（产品代码本身，非另写脚本）
npx tsx spike-real-ocr.ts <model> ollama
```

---

## 6. 附：结论口径

严格按监督者规则，本文件区分三种状态：

- **已验证**：§3.2 的截断修复（有真模型输出、有正文留痕、有 `空页 0` 的对照）
- **待验证**：扫描件从上传到"检索命中"的端到端链路（§4.2，尚未跑）
- **不达标**：`qwen3-vl:8b` 吞吐（§4.1，有实测单页 300s 超时为证）

**在 §4.1 定论、§4.2 跑完之前，不宣称「扫描件已支持」交付完成。**
