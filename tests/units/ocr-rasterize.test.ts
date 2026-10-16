/**
 * PDF → PNG 光栅化的回归测试。
 *
 * 单独测这一层是因为它是整条 OCR 链路里唯一"看不见"的一步：识别结果对不对，
 * 取决于送进去的是不是一张能看清字的图。尺寸算错、透明底没铺白、图片被截断，
 * 表现出来都只是"OCR 结果很差"，很难反推到光栅化。
 */

import { describe, expect, it } from 'vitest';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { DEFAULT_OCR_CONFIG, forEachPdfPagePng, type OcrConfig } from '../../src/ocr.js';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const FIXTURE = path.join(HERE, '..', 'fixtures', 'pdf', 'scanned-3p.pdf');
const PNG_MAGIC = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]);

function cfg(overrides: Partial<OcrConfig> = {}): OcrConfig {
  return { ...DEFAULT_OCR_CONFIG, dpi: 96, maxPixels: 8_000_000, ...overrides };
}

async function rasterize(overrides: Partial<OcrConfig> = {}) {
  const pages: Array<{ pageNumber: number; png: Buffer; width: number; height: number }> = [];
  const meta = await forEachPdfPagePng(
    fs.readFileSync(FIXTURE),
    cfg(overrides),
    async (page) => {
      pages.push(page);
    },
  );
  return { pages, meta };
}

describe('forEachPdfPagePng', () => {
  it('逐页吐出真实的 PNG，页数与页码连续', async () => {
    const { pages, meta } = await rasterize();
    expect(meta.totalPages).toBe(3);
    expect(meta.renderedPages).toBe(3);
    expect(meta.truncated).toBe(false);
    expect(pages.map((p) => p.pageNumber)).toEqual([1, 2, 3]);
    for (const page of pages) {
      expect(page.png.subarray(0, 8).equals(PNG_MAGIC)).toBe(true);
      expect(page.png.length).toBeGreaterThan(1000);
    }
  });

  it('DPI 直接影响输出尺寸 —— 96dpi 的宽高约是 192dpi 的一半', async () => {
    const low = await rasterize({ dpi: 96 });
    const high = await rasterize({ dpi: 192 });
    expect(high.pages[0].width).toBeGreaterThan(low.pages[0].width * 1.8);
    expect(high.pages[0].height).toBeGreaterThan(low.pages[0].height * 1.8);
  });

  it('超过 maxPixels 时等比缩小，不会 OOM', async () => {
    const { pages } = await rasterize({ dpi: 300, maxPixels: 500_000 });
    for (const page of pages) {
      expect(page.width * page.height).toBeLessThanOrEqual(500_000 * 1.02);
      expect(page.width).toBeGreaterThan(0);
      expect(page.height).toBeGreaterThan(0);
    }
  });

  it('maxPages 截断时如实报告 truncated，而不是假装只有这么多页', async () => {
    const { pages, meta } = await rasterize({ maxPages: 2 });
    expect(pages.map((p) => p.pageNumber)).toEqual([1, 2]);
    expect(meta.totalPages).toBe(3);
    expect(meta.renderedPages).toBe(2);
    expect(meta.truncated).toBe(true);
  });

  it('onRasterized 回调逐页推进，供后台任务写进度', async () => {
    const seen: number[] = [];
    await forEachPdfPagePng(
      fs.readFileSync(FIXTURE),
      cfg(),
      async () => {},
      (pageNumber) => seen.push(pageNumber),
    );
    expect(seen).toEqual([1, 2, 3]);
  });

  it('文字层 PDF 也能光栅化（不是只对扫描件有效）', async () => {
    const textFixture = path.join(HERE, '..', 'fixtures', 'pdf', 'text-layer.pdf');
    const pages: number[] = [];
    const meta = await forEachPdfPagePng(
      fs.readFileSync(textFixture),
      cfg(),
      async (page) => {
        expect(page.png.subarray(0, 8).equals(PNG_MAGIC)).toBe(true);
        pages.push(page.pageNumber);
      },
    );
    expect(meta.renderedPages).toBe(pages.length);
    expect(pages.length).toBeGreaterThan(0);
  });
});
