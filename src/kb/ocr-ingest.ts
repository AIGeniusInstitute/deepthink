/**
 * 扫描件入库编排：OCR 在后台跑，跑完把正文补进文档行，再交给常规 ingest 管线。
 *
 * 为什么必须异步：287 页 × 每页数秒 = 半小时。放在上传请求里同步做，浏览器和任何
 * 反向代理都会先超时，"上传成功但列表里什么都没有"会比原来的报错更难排查。
 *
 * 与 pipeline.ts 的关系：本模块只负责「把 content 弄到手」。拿到正文之后走的是
 * 完全相同的 `startIngestAsync`（分块 → 向量化），所以 OCR 文档和普通文档在
 * 检索链路上没有任何区别，不存在第二套索引路径。
 */

import { logger } from '../logger.js';
import {
  getKbDocumentAnyOwner,
  replaceKbDocumentContent,
  updateDocumentParseState,
  setDocumentParserType,
} from '../db.js';
import { getOcrConfig, ocrPdf, type OcrProgress, type OcrResult } from '../ocr.js';
import { startIngestAsync, type IngestOptions } from './pipeline.js';

/** OCR 文档的 parser_type，与普通 `pdf` 区分，界面上据此显示「OCR」。 */
export const PARSER_TYPE_PDF_OCR = 'pdf_ocr';

/** 进度落库节流：287 页每页都写一次 DB 没必要，前端 1.5s 轮询一次就够了。 */
const PROGRESS_MIN_INTERVAL_MS = 2000;

export interface OcrIngestOptions {
  chunkConfig?: IngestOptions['chunkConfig'];
  parentChild?: boolean;
}

/**
 * 启动一次后台 OCR。立即返回，进度通过 `kb_documents.parse_stage` 暴露
 * （形如 `ocr 12/287`），终态是 `parse_status` 变成 `ready` 或 `failed`。
 */
export function startOcrIngestAsync(
  docId: string,
  buf: Buffer,
  options: OcrIngestOptions = {},
): void {
  void runOcrIngest(docId, buf, options).catch((err) => {
    const message = err instanceof Error ? err.message : String(err);
    logger.error({ err, docId }, 'OCR ingest crashed');
    updateDocumentParseState(docId, {
      parse_status: 'failed',
      parse_stage: 'ocr',
      error_message: message,
    });
  });
}

async function runOcrIngest(
  docId: string,
  buf: Buffer,
  options: OcrIngestOptions,
): Promise<void> {
  const doc = getKbDocumentAnyOwner(docId);
  if (!doc) {
    logger.warn({ docId }, 'OCR ingest: document disappeared before OCR started');
    return;
  }

  const cfg = getOcrConfig();
  let lastWrite = 0;
  const onProgress = (p: OcrProgress): void => {
    const now = Date.now();
    if (p.stage !== 'done' && now - lastWrite < PROGRESS_MIN_INTERVAL_MS) return;
    lastWrite = now;
    updateDocumentParseState(docId, {
      parse_status: 'ocr',
      parse_stage: p.totalPages > 0 ? `ocr ${p.donePages}/${p.totalPages}` : 'ocr',
    });
  };

  updateDocumentParseState(docId, { parse_status: 'ocr', parse_stage: 'ocr' });
  const started = Date.now();
  let result: OcrResult;
  try {
    result = await ocrPdf(buf, { config: cfg, onProgress });
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    logger.warn({ docId, err: message }, 'OCR failed');
    updateDocumentParseState(docId, {
      parse_status: 'failed',
      parse_stage: 'ocr',
      error_message: `扫描件 OCR 失败：${message}`,
    });
    return;
  }

  logger.info(
    {
      docId,
      totalPages: result.totalPages,
      ocrPages: result.ocrPages,
      failedPages: result.failedPages.length,
      elapsedMs: Date.now() - started,
      model: result.model,
    },
    'OCR finished',
  );

  if (!result.text.trim()) {
    updateDocumentParseState(docId, {
      parse_status: 'failed',
      parse_stage: 'ocr',
      error_message: `扫描件 OCR 完成但未识别出任何文字（共 ${result.totalPages} 页）`,
    });
    return;
  }

  const { duplicateOf } = replaceKbDocumentContent(docId, result.text);
  if (duplicateOf) {
    // 上传时比的是占位 hash，比不出重复；OCR 出正文后才暴露。这时候还没有分块，
    // 直接把这份标注为失败并说明原因，比静默留下一份永远 pending 的文档清楚。
    updateDocumentParseState(docId, {
      parse_status: 'failed',
      parse_stage: 'ocr',
      error_message: 'OCR 后的正文与知识库中已有文档完全一致（重复上传）',
    });
    return;
  }

  setDocumentParserType(docId, PARSER_TYPE_PDF_OCR);
  updateDocumentParseState(docId, { error_message: null });
  startIngestAsync(docId, {
    chunkConfig: options.chunkConfig,
    parentChild: options.parentChild,
    parserType: PARSER_TYPE_PDF_OCR,
  });
}
