/**
 * 重建 `tests/fixtures/office/mixed-archive.zip` —— 整包上传（A4）用的夹具。
 *
 * 内容刻意混合了「该进的」和「该跳过的」：
 *   protocol/slides.pptx      应入库（parser_type=pptx）
 *   protocol/dosing.xlsx      应入库（parser_type=xlsx）
 *   notes/plan.md             应入库，且 filename 保留 `notes/` 目录段
 *   __MACOSX/._slides.pptx    macOS 资源分支，跳过
 *   notes/.draft.md           隐藏文件，跳过
 *   archive/logo.png          图片，不支持，跳过
 *
 * 用法：node tests/fixtures/office/build-archive.mjs
 */
import JSZip from 'jszip';
import { readFileSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const here = dirname(fileURLToPath(import.meta.url));
const zip = new JSZip();

zip.file('protocol/slides.pptx', readFileSync(join(here, 'slides.pptx')));
zip.file('protocol/dosing.xlsx', readFileSync(join(here, 'dosing.xlsx')));
zip.file(
  'notes/plan.md',
  '# 整包上传计划\n\n代号 ARCHIVETOKEN-2255。\n\n- 解析 pptx\n- 解析 xlsx\n',
);
zip.file('__MACOSX/._slides.pptx', 'macOS resource fork junk');
zip.file('notes/.draft.md', '# 隐藏草稿，不该入库\n');
zip.file('archive/logo.png', Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 0, 0, 0, 0]));

const buf = await zip.generateAsync({ type: 'nodebuffer', compression: 'DEFLATE' });
const out = join(here, 'mixed-archive.zip');
writeFileSync(out, buf);
console.log(`✅ ${out} (${buf.length} 字节, ${Object.keys(zip.files).length} 条目)`);
