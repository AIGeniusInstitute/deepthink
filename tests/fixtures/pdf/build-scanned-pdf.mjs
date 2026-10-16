/**
 * 生成 `scanned-3p.pdf` —— 一份**纯图片、无文字层**的三页 PDF，用作 OCR 回归夹具。
 *
 * 为什么要现造而不是拿真实扫描件：真实的临床指南扫描件有 3MB / 287 页，塞进仓库
 * 不合适，而且内容是随机的、没法断言。这里的三页内容是我们自己画的、已知的，
 * OCR 结果可以直接比对。
 *
 * 用法：`node tests/fixtures/pdf/build-scanned-pdf.mjs`
 * 依赖：@napi-rs/canvas（pdf-parse 的传递依赖，已在依赖树里）+ Python Pillow。
 */

import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import { execFileSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { createCanvas, GlobalFonts } from '@napi-rs/canvas';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const OUT_PDF = path.join(HERE, 'scanned-3p.pdf');

// 画三页"扫描件"。内容刻意包含英文单词 + 数字 + 一张两列表格，
// 这样 OCR 结果的断言既能验字，也能验表格有没有被转成结构化文本。
const PAGES = [
  {
    title: 'DeepThink OCR Fixture',
    lines: ['Page One', 'Keyword: ALPHA-7749', 'This page has no text layer at all.'],
  },
  {
    title: 'Treatment Recommendation',
    lines: ['Page Two', 'Drug        Dosage', 'Osimertinib 80 mg once daily', 'Code: BRAVO-2251'],
  },
  {
    title: 'Follow Up',
    lines: ['Page Three', 'Review every 6 weeks', 'Keyword: CHARLIE-9930'],
  },
];

function renderPage({ title, lines }, index) {
  const width = 1240;
  const height = 1754; // A4 @150dpi
  const canvas = createCanvas(width, height);
  const ctx = canvas.getContext('2d');
  ctx.fillStyle = '#ffffff';
  ctx.fillRect(0, 0, width, height);
  ctx.fillStyle = '#111111';
  ctx.font = 'bold 46px sans-serif';
  ctx.fillText(title, 120, 200);
  ctx.font = '34px sans-serif';
  let y = 300;
  for (const line of lines) {
    ctx.fillText(line, 120, y);
    y += 70;
  }
  // 画几条横线，模拟扫描件的表格框线
  ctx.strokeStyle = '#333333';
  ctx.lineWidth = 3;
  ctx.strokeRect(110, 250, 900, 300);
  ctx.beginPath();
  ctx.moveTo(110, 400);
  ctx.lineTo(1010, 400);
  ctx.stroke();
  ctx.font = '28px sans-serif';
  ctx.fillText(`- ${index + 1} -`, width / 2 - 30, height - 120);
  return canvas.toBuffer('image/png');
}

const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'ocr-fixture-'));
const pngs = PAGES.map((page, i) => {
  const file = path.join(tmp, `page-${i + 1}.png`);
  fs.writeFileSync(file, renderPage(page, i));
  return file;
});

// Pillow 能把多张图片直接写成多页 PDF —— 生成的 PDF 里只有图片 XObject，
// 没有任何字体/文字操作符，也就是真实的"扫描件"形态。
execFileSync('python3', [
  '-c',
  `
import sys
from PIL import Image
imgs = [Image.open(p).convert("RGB") for p in sys.argv[1:-1]]
imgs[0].save(sys.argv[-1], save_all=True, append_images=imgs[1:], resolution=150)
`,
  ...pngs,
  OUT_PDF,
]);

fs.rmSync(tmp, { recursive: true, force: true });
const size = fs.statSync(OUT_PDF).size;
console.log(`wrote ${OUT_PDF} (${size} bytes, ${PAGES.length} pages)`);
console.log('font families available:', GlobalFonts.families.length);
