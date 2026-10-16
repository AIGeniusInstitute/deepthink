// 生成 handbook.epub（由 build-fixtures.sh 调用，从仓库树内运行）。
//
// **为什么不用 LibreOffice 转**：`soffice --convert-to epub` 把 `<h1>` 一律拍平成
// `<p class="para0">`，产出的 EPUB 里根本没有标题元素 —— 拿它当 fixture，"标题层级
// 必须保留"这条需求就永远测不到（实测：转出来的 section0001.xhtml 里一个 h1 都没有）。
// 所以这个包手写，结构按 EPUB 3 规范来：container.xml → OPF → spine。
// build-fixtures.sh 会用 LibreOffice 反向读一遍来确认它确实是合法 EPUB。
//
// 刻意覆盖三种章节形态：
//   - 第一章：h1 + p + h2 + p（两级标题）
//   - 第二章：h1 + p
//   - 第三章：只有 ul/li，**没有任何标题**（章内无块级差异时不能整章丢字）
import JSZip from 'jszip';
import fs from 'node:fs';
import path from 'node:path';

const outDir = process.argv[2] ?? '.';

const OPF = `<?xml version="1.0" encoding="UTF-8"?>
<package xmlns="http://www.idpf.org/2007/opf" version="3.0" unique-identifier="pub-id">
  <metadata xmlns:dc="http://purl.org/dc/elements/1.1/">
    <dc:identifier id="pub-id">urn:uuid:deepthink-fixture-epub</dc:identifier>
    <dc:title>eCRF 填写指南</dc:title>
    <dc:language>zh-CN</dc:language>
    <meta property="dcterms:modified">2026-01-06T00:00:00Z</meta>
  </metadata>
  <manifest>
    <item id="nav" href="nav.xhtml" media-type="application/xhtml+xml" properties="nav"/>
    <item id="ch2" href="chapter02.xhtml" media-type="application/xhtml+xml"/>
    <item id="ch1" href="chapter01.xhtml" media-type="application/xhtml+xml"/>
    <item id="ch3" href="chapter03.xhtml" media-type="application/xhtml+xml"/>
  </manifest>
  <spine>
    <itemref idref="ch1"/>
    <itemref idref="ch2"/>
    <itemref idref="ch3"/>
  </spine>
</package>`;

// manifest 的声明顺序（ch2 在 ch1 前）和 spine 顺序（ch1 在前）**故意不一致**：
// 按 manifest 或文件名排都会给出错误的章节序，只有 spine 是对的。
const CHAPTERS = {
  'chapter01.xhtml': `<?xml version="1.0" encoding="UTF-8"?>
<html xmlns="http://www.w3.org/1999/xhtml"><head><title>第一章</title></head><body>
<h1>第一章 访视安排</h1>
<p>受试者需在第 1 天、第 14 天、第 28 天完成访视。</p>
<h2>1.1 窗口期</h2>
<p>每次访视允许提前或延后 3 天。方案编号 CHARLIE-9930。</p>
</body></html>`,
  'chapter02.xhtml': `<?xml version="1.0" encoding="UTF-8"?>
<html xmlns="http://www.w3.org/1999/xhtml"><head><title>第二章</title></head><body>
<h1>第二章 不良事件记录</h1>
<p>所有不良事件须在 24 小时内录入系统，编号规则为 AE-2026-0001。</p>
</body></html>`,
  'chapter03.xhtml': `<?xml version="1.0" encoding="UTF-8"?>
<html xmlns="http://www.w3.org/1999/xhtml"><head><title>第三章</title></head><body>
<ul><li>原始病历归档至研究中心</li><li>电子数据保留 5 年</li></ul>
</body></html>`,
};

const CONTAINER = `<?xml version="1.0" encoding="UTF-8"?>
<container version="1.0" xmlns="urn:oasis:names:tc:opendocument:xmlns:container">
  <rootfiles><rootfile full-path="OEBPS/content.opf" media-type="application/oebps-package+xml"/></rootfiles>
</container>`;

const zip = new JSZip();
// mimetype 必须是第一个条目且不压缩（EPUB 规范的 OCF 要求）。
zip.file('mimetype', 'application/epub+zip', { compression: 'STORE' });
zip.file('META-INF/container.xml', CONTAINER);
zip.file('OEBPS/content.opf', OPF);
for (const [name, body] of Object.entries(CHAPTERS)) zip.file(`OEBPS/${name}`, body);

const buf = await zip.generateAsync({ type: 'nodebuffer', compression: 'DEFLATE' });
fs.writeFileSync(path.join(outDir, 'handbook.epub'), buf);
console.log('handbook.epub ok');
