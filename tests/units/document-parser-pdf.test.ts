/**
 * PDF 解析回归测试。
 *
 * 之前**没有任何测试覆盖 PDF 解析**，于是两个缺陷同时躺着没被发现：
 *
 *   1. `pdf-parse` 升到 v2 后改成**具名类导出**（`export { PDFParse }`），没有默认导出。
 *      旧代码 `(mod as any).default ?? (mod as any)` 在 v2 下退化成命名空间对象，
 *      调用即抛 `pdfParse is not a function` —— 界面上传 PDF 直接失败。
 *   2. `getText()` 的 `pageJoiner` 默认值是 `'\n-- {n} of {total} --'`，**给每一页
 *      伪造一条页码标记**。纯扫描件（无文字层）本该抽出空串，被这么一加就成了非空文本，
 *      `parsePdf` 的空值守卫永远不会触发，知识库会把纯噪声当正文**静默入库**。
 *
 * 两个夹具都是真实 PDF（macOS `cupsfilter` 从文本生成），不是 mock：
 *   - `text-layer.pdf`     1 页，有文字层 → 必须抽出真实正文
 *   - `no-text-layer.pdf`  1 页，无文字层 → 必须**报错**而不是返回页码标记
 */
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, test } from 'vitest';

import { parsePdf } from '../../src/document-parser.js';

const FIXTURES = path.join(path.dirname(fileURLToPath(import.meta.url)), '..', 'fixtures', 'pdf');
const readFixture = (name: string) => fs.readFileSync(path.join(FIXTURES, name));

describe('parsePdf', () => {
  test('有文字层的 PDF 能抽出真实正文（覆盖 pdf-parse v2 的类式 API）', async () => {
    const text = await parsePdf(readFixture('text-layer.pdf'));
    // 断言抽取结果里应当出现的具体内容 —— 断言「非空」是不够的：
    // 旧代码崩溃前的那一版用错 API，任何"能跑通"的假象都骗不过这行。
    expect(text).toContain('DeepThink PDF 解析回归夹具');
    expect(text).toContain('ASCII mixed content 12345');
    expect(text).toContain('向量数据库');
  });

  test('PDF 正文里不得混入库自己伪造的页码标记', async () => {
    const text = await parsePdf(readFixture('text-layer.pdf'));
    // `getText()` 默认会加 '\n-- 1 of 1 --'；这种标记进 content 就成了分块正文的一部分，
    // 会被切块、被向量化、被引用回显。
    expect(text).not.toMatch(/--\s*\d+\s+of\s+\d+\s*--/);
  });

  test('无文字层的扫描件必须报错，而不是把页码标记当正文交出去', async () => {
    await expect(parsePdf(readFixture('no-text-layer.pdf'))).rejects.toThrow(
      /no extractable text/i,
    );
  });

  test('无文字层夹具确实是"有页无字"（否则上一条会退化成平凡通过）', async () => {
    // 前提断言：夹具必须**页数 ≥ 1 且文字为空**。若哪天它被换成零页的损坏文件，
    // 上面那条 rejects 会因为别的原因通过，等于没测。
    const { PDFParse } = (await import('pdf-parse')) as typeof import('pdf-parse');
    const parser = new PDFParse({ data: readFixture('no-text-layer.pdf') });
    try {
      const r = await parser.getText({ pageJoiner: '' });
      expect(r.total).toBeGreaterThan(0); // 有页
      expect(r.text.trim()).toBe(''); // 无字
    } finally {
      await parser.destroy();
    }
  });
});
