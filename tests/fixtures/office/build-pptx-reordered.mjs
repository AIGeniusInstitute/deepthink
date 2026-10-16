// 生成 slides-reordered.pptx（由 build-fixtures.sh 调用，从仓库树内运行）。
//
// 用途：钉住「页序必须来自 presentation.xml 的 sldIdLst，而不是 slideN.xml 的文件名」。
//
// 为什么需要单独一个 fixture：python-pptx 产出的包，页序和文件名数字恰好一致，
// 拿它测不出区别 —— 按文件名排的实现会**同样通过**。这里把 sldIdLst 里的 r:id
// 顺序倒过来（模拟「用户把最后一页拖到最前面」），文件名保持不动。
// 于是：按 rels 读 → 第一页是「给药方案」；按文件名读 → 第一页是「项目启动会」。
import JSZip from 'jszip';
import fs from 'node:fs';
import path from 'node:path';

const outDir = process.argv[2] ?? '.';
const src = path.join(outDir, 'slides.pptx');

const zip = await JSZip.loadAsync(fs.readFileSync(src));
const presPath = 'ppt/presentation.xml';
const xml = await zip.file(presPath).async('string');

// <p:sldIdLst><p:sldId id="256" r:id="rId2"/><p:sldId id="257" r:id="rId3"/>…</p:sldIdLst>
const listMatch = xml.match(/<p:sldIdLst>([\s\S]*?)<\/p:sldIdLst>/);
if (!listMatch) throw new Error('presentation.xml 里没有 sldIdLst，fixture 结构变了');

const items = listMatch[1].match(/<p:sldId\b[^>]*\/>/g) ?? [];
if (items.length < 2) throw new Error(`sldIdLst 里只有 ${items.length} 个 sldId，倒序没有意义`);

// 倒序：原本 [rId2, rId3, rId4] → [rId4, rId3, rId2]
// `id` 属性保持原样（它只是 sldId 自身的编号，PowerPoint 不靠它排序）。
const reversed = [...items].reverse().join('');
const patched = xml.replace(listMatch[0], `<p:sldIdLst>${reversed}</p:sldIdLst>`);

zip.file(presPath, patched);
const buf = await zip.generateAsync({ type: 'nodebuffer', compression: 'DEFLATE' });
fs.writeFileSync(path.join(outDir, 'slides-reordered.pptx'), buf);
console.log(`slides-reordered.pptx ok（${items.length} 页，sldIdLst 已倒序）`);
