/**
 * zip 容器类文档的解析：pptx / xlsx / epub / xmind。
 *
 * 这四种格式（加上既有走 mammoth 的 docx）本质都是「一个 zip 里装着 XML/JSON」，
 * 所以统一在这里用 jszip 打开。输出一律是 Markdown —— 不是为了好看，是因为**结构
 * 必须进文本**：表格的行列对应、幻灯片的页序、章节边界、思维导图的层级，丢了任何
 * 一样，分块一动刀检索语义就散了（表格尤其明显：平铺之后「药名」和「剂量」会被
 * 切进不同的块，问「某药的剂量」只能命中一段光有药名的文本）。
 *
 * 为什么不用图像/OCR 那条路：这些格式**本来就有文字层**，解析 XML 是确定性的、
 * 零成本的、毫秒级的。OCR 是给扫描件准备的，拿它跑 pptx 属于用错工具。
 */

import type { Buffer } from 'node:buffer';
import JSZip from 'jszip';
import { logger } from './logger.js';

/**
 * 为什么是「变量标识符 + 动态 import」而不是 `import { DOMParser } from '@xmldom/xmldom'`：
 *
 * `@xmldom/xmldom` 的 `index.d.ts` 第一行是 `/// <reference lib="dom" />`。
 * 静态 import 会把这个 reference 带进**整个编译程序** —— `tsconfig.json` 的
 * `lib` 只有 `ES2022`，lib.dom 一旦被拉进来，全局的 `BodyInit` 就从 undici 版本
 * 变成 DOM 版本，于是 `src/routes/files.ts` 与 `src/qq.ts` 里**给 fetch 直接传
 * Buffer 的 5 处**立刻报 `Buffer is not assignable to BodyInit`。那些文件与知识库
 * 毫无关系，纯粹被牵连（实测：main 上 tsc 0 错，加上这个静态 import 后 5 错）。
 *
 * 把模块标识符放进变量，TS 就不做类型解析，那条 reference 也就不会被拾取。
 * **代价**：本文件对 xmldom 的调用没有类型检查，所以下面用一个最小的结构化类型
 * 兜住真正用到的那两个成员。相比「给全项目打开 lib.dom」（那会让服务端代码里
 * `document` / `window` 也能通过类型检查），这个代价是划算的。
 *
 * 顶层 await：模块加载完就已经拿到构造器，`parseXml` 得以保持同步，
 * 不必把 async 传染给它那 8 个调用点。
 */
const XMLDOM_PACKAGE = '@xmldom/xmldom';

interface XmldomParser {
  parseFromString(source: string, mimeType: string): unknown;
}

interface XmldomModule {
  DOMParser: new (options?: {
    errorHandler?: (level: string, message: unknown) => void;
  }) => XmldomParser;
}

const { DOMParser } = (await import(XMLDOM_PACKAGE)) as XmldomModule;

/**
 * 本文件用到的那几个 XML DOM 成员的最小结构化类型。
 *
 * 为什么不直接写 lib.dom 的 `Document` / `Element`：正是上面那段要避免的东西 ——
 * 一旦 lib.dom 进了编译程序，连带代价就不止本文件了。这里只声明真正用到的成员
 * （下面 9 个，用 grep 数过），本文件的类型检查照旧，全局环境保持干净。
 */
interface XmlAttr {
  localName?: string | null;
  name: string;
  value: string;
}

interface XmlNode {
  nodeType: number;
  nodeName: string;
  localName?: string | null;
  textContent?: string | null;
  childNodes: ArrayLike<XmlNode>;
  attributes: ArrayLike<XmlAttr>;
  getAttribute(name: string): string | null;
  getElementsByTagName(name: string): ArrayLike<XmlNode>;
}

/** 目前 `Document` 与 `Element` 的用法没有区别（都只用上面这些成员），故共用一个类型。 */
type XmlElement = XmlNode;
type XmlDocument = XmlNode;

export type ZipDocumentType = 'pptx' | 'xlsx' | 'epub' | 'xmind';

/**
 * zip 是不可信输入。三道闸在**解压前**判 —— 解压后再量已经被炸了。
 *
 * 阈值取得比真实文档宽松很多（一份 500 页的 PPT 解压后也就几十 MB），
 * 目的只是拦住 zip 炸弹，不是限制正常文件。
 */
const MAX_ZIP_ENTRIES = 5_000;
const MAX_ZIP_UNCOMPRESSED_BYTES = 200 * 1024 * 1024;
/** 单条 XML/JSON 的大小上界：超过它就不是「一份文档」了。 */
const MAX_PART_BYTES = 64 * 1024 * 1024;

export class ZipDocumentError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'ZipDocumentError';
  }
}

/**
 * 老二进制 Office 格式（.doc/.xls/.ppt）的 OLE 复合文档头。
 *
 * 单独识别并给出**可执行**的报错：笼统说「不支持的文件类型」会让用户以为平台
 * 漏配了格式，然后去翻文档；说清楚「请另存为 xlsx」他才知道下一步做什么。
 */
const OLE_MAGIC = [0xd0, 0xcf, 0x11, 0xe0];

export function isLegacyOfficeBuffer(buf: Buffer): boolean {
  return buf.length >= 4 && OLE_MAGIC.every((b, i) => buf[i] === b);
}

/**
 * 隐藏项判定：**任一路径段**以 `.` 开头即为隐藏。
 *
 * 这是入库策略，不是安全闸（安全闸在 `openZipDocument` 里）。独立成函数是因为
 * 整目录上传的三个入口（选目录 / 拖拽 / zip）必须用**同一条**规则 —— 三处各写
 * 一遍 `startsWith('.')`，迟早有一处只判了整条路径，于是 `docs/.git/config`
 * 就从那一处漏进库里。
 *
 * `__MACOSX/` 是 macOS 打包 zip 时塞进来的资源分支目录，名字不以 `.` 开头，
 * 但同样必须跳过 —— 它不是用户的文件。
 */
export function isHiddenZipPath(name: string): boolean {
  if (name.startsWith('__MACOSX/') || name === '__MACOSX') return true;
  return name.split('/').some((seg) => seg.startsWith('.'));
}

export function legacyOfficeMessage(filename: string): string {
  const ext = filename.toLowerCase().split('.').pop() ?? '';
  const target: Record<string, string> = { doc: 'docx', xls: 'xlsx', ppt: 'pptx' };
  const to = target[ext] ?? 'docx/xlsx/pptx';
  return `「${filename}」是老版二进制 Office 格式（.${ext}），本平台不支持。请用 Office/WPS 另存为 .${to} 后重新上传。`;
}

/**
 * 打开 zip 并做安全检查。
 *
 * 安全项：条目数、解压总量（读 header 里声称的 uncompressedSize）、路径穿越。
 * 路径穿越这条对**只读**解析来说危害有限，但 `zip` 解包端点会把条目写进知识库，
 * 那里路径就是文件名 —— 与其在两个调用点各判一次，不如在这里统一拦住。
 */
export async function openZipDocument(buf: Buffer, filename: string): Promise<JSZip> {
  let zip: JSZip;
  try {
    zip = await JSZip.loadAsync(buf);
  } catch {
    throw new ZipDocumentError(`「${filename}」不是有效的压缩包，文件可能已损坏。`);
  }

  const entries = Object.values(zip.files);
  if (entries.length > MAX_ZIP_ENTRIES) {
    throw new ZipDocumentError(
      `「${filename}」内部条目过多（${entries.length} > ${MAX_ZIP_ENTRIES}），已拒绝解析。`,
    );
  }

  let total = 0;
  for (const entry of entries) {
    const name = entry.name;
    if (name.includes('\0') || name.startsWith('/') || name.split('/').includes('..')) {
      throw new ZipDocumentError(`「${filename}」内含非法路径「${name}」，已拒绝解析。`);
    }
    // jszip 把声称的解压后大小放在私有字段上；没有这个信息就不累加，
    // 由下面逐条读取时的 MAX_PART_BYTES 兜底。
    const size = (entry as unknown as { _data?: { uncompressedSize?: number } })._data
      ?.uncompressedSize;
    if (typeof size === 'number') {
      total += size;
      if (total > MAX_ZIP_UNCOMPRESSED_BYTES) {
        throw new ZipDocumentError(
          `「${filename}」解压后体积超过 ${MAX_ZIP_UNCOMPRESSED_BYTES / 1024 / 1024}MB，已拒绝解析。`,
        );
      }
    }
  }
  return zip;
}

/** 读一个条目为 utf8 文本；不存在返回 null。带单条大小上界。 */
async function readPart(zip: JSZip, path: string): Promise<string | null> {
  const file = zip.file(path);
  if (!file) return null;
  const size = (file as unknown as { _data?: { uncompressedSize?: number } })._data
    ?.uncompressedSize;
  if (typeof size === 'number' && size > MAX_PART_BYTES) {
    throw new ZipDocumentError(`「${path}」过大（${Math.round(size / 1024 / 1024)}MB），已拒绝解析。`);
  }
  return file.async('string');
}

function parseXml(text: string, what: string): XmlDocument {
  try {
    // 只给 errorHandler，别的选项一个不给 —— 尤其是 locator 和任何跟 DTD /
    // 外部实体相关的开关。坏 XML 的告警在这里是噪声：这些包是 Office 自己生成的，
    // 真坏了会在下面取不到节点，那时报错信息更有用。
    return new DOMParser({ errorHandler: () => {} }).parseFromString(
      text,
      'text/xml',
    ) as unknown as XmlDocument;
  } catch {
    throw new ZipDocumentError(`${what} 的 XML 无法解析，文件可能已损坏。`);
  }
}

/** 按本地名取元素（OOXML 满是命名空间前缀，按 localName 匹配最省事）。 */
function byLocalName(root: XmlElement, name: string): XmlElement[] {
  const all = root.getElementsByTagName('*');
  const out: XmlElement[] = [];
  for (let i = 0; i < all.length; i++) {
    const el = all[i] as XmlElement;
    if ((el.localName ?? el.nodeName) === name) out.push(el);
  }
  return out;
}

function textOf(el: XmlElement | null | undefined): string {
  if (!el) return '';
  return (el.textContent ?? '').trim();
}

/** 判断一个元素是否是给定 localName（自带子树遍历，避免依赖 getElementsByTagName 的命名空间行为）。 */
function childrenByLocalName(el: XmlElement, name: string): XmlElement[] {
  const out: XmlElement[] = [];
  for (let i = 0; i < el.childNodes.length; i++) {
    const child = el.childNodes[i] as XmlElement;
    if (child.nodeType === 1 && (child.localName ?? child.nodeName) === name) out.push(child);
  }
  return out;
}

// ─── pptx ────────────────────────────────────────────────

/**
 * 幻灯片正文。
 *
 * 页序**不能**按 `slide1.xml`、`slide2.xml` 的文件名数字排 —— PowerPoint 调整页序时
 * 改的是 `presentation.xml` 里的 `sldIdLst`，文件本身不重命名。按文件名排会在
 * 「把第 5 页拖到第 1 页」这种最常见的编辑之后给出错误的页序，而这种错误在
 * 输出里完全看不出来（每页文字都对，就是顺序错）。
 * 所以先查 rels 拿真实顺序，rels 缺失时才回退到文件名数字。
 */
export async function parsePptx(buf: Buffer, filename = 'presentation.pptx'): Promise<string> {
  const zip = await openZipDocument(buf, filename);
  const presentationXml = await readPart(zip, 'ppt/presentation.xml');
  if (!presentationXml) {
    throw new ZipDocumentError(`「${filename}」不是有效的 PPTX（缺少 ppt/presentation.xml）。`);
  }

  const slidePaths = await resolvePptxSlideOrder(zip, presentationXml);
  if (slidePaths.length === 0) {
    throw new ZipDocumentError(`「${filename}」里没有找到任何幻灯片。`);
  }

  const parts: string[] = [];
  for (let i = 0; i < slidePaths.length; i++) {
    const xml = await readPart(zip, slidePaths[i]);
    if (!xml) continue;
    const body = slideToMarkdown(xml);
    if (!body.trim()) continue;
    parts.push(`## 第 ${i + 1} 页\n\n${body.trim()}`);
  }
  if (parts.length === 0) {
    throw new ZipDocumentError(`「${filename}」的幻灯片里没有可提取的文字（可能全是图片）。`);
  }
  return parts.join('\n\n');
}

async function resolvePptxSlideOrder(zip: JSZip, presentationXml: string): Promise<string[]> {
  const relsXml = await readPart(zip, 'ppt/_rels/presentation.xml.rels');
  const doc = parseXml(presentationXml, 'presentation.xml');

  const ordered: string[] = [];
  if (relsXml) {
    const relMap = new Map<string, string>();
    for (const rel of byLocalName(parseXml(relsXml, 'presentation.xml.rels'), 'Relationship')) {
      const id = rel.getAttribute('Id');
      const target = rel.getAttribute('Target');
      if (id && target) relMap.set(id, target);
    }
    for (const sldId of byLocalName(doc, 'sldId')) {
      // r:id 的 localName 就是 'id'，前缀随文档而变。
      let rid = '';
      for (let i = 0; i < sldId.attributes.length; i++) {
        const attr = sldId.attributes[i];
        if ((attr.localName ?? attr.name) === 'id') rid = attr.value;
      }
      const target = relMap.get(rid);
      if (!target) continue;
      // rels 里的 Target 是相对 ppt/ 的，也可能带 ../ 前缀。
      const normalized = normalizeZipPath('ppt', target);
      if (zip.file(normalized)) ordered.push(normalized);
    }
  }
  if (ordered.length > 0) return ordered;

  // 回退：文件名数字序。
  return Object.keys(zip.files)
    .filter((n) => /^ppt\/slides\/slide\d+\.xml$/.test(n))
    .sort((a, b) => slideNumber(a) - slideNumber(b));
}

function slideNumber(path: string): number {
  return Number.parseInt(path.match(/slide(\d+)\.xml$/)?.[1] ?? '0', 10);
}

function normalizeZipPath(baseDir: string, target: string): string {
  if (target.startsWith('/')) return target.slice(1);
  const segments = `${baseDir}/${target}`.split('/');
  const out: string[] = [];
  for (const seg of segments) {
    if (seg === '.' || seg === '') continue;
    if (seg === '..') out.pop();
    else out.push(seg);
  }
  return out.join('/');
}

/**
 * 一张幻灯片 -> Markdown。
 *
 * 标题占位符（`<p:ph type="title">` / `ctrTitle`）渲染成 `#`，其余形状按段落输出。
 * 不区分标题和正文的话，一页 PPT 会变成一段没有重点的文字，「这页讲什么」检索不出来。
 */
function slideToMarkdown(xml: string): string {
  const doc = parseXml(xml, 'slide');
  const blocks: string[] = [];

  for (const sp of byLocalName(doc, 'sp')) {
    const isTitle = isTitlePlaceholder(sp);
    const paragraphs: string[] = [];
    for (const p of byLocalName(sp, 'p')) {
      // 段落内的文本分散在多个 <a:t> run 里（同一个词可能被拆成几段），拼起来才是整句。
      const runs = childrenByLocalName(p, 'r').map((r) => textOf(byLocalName(r, 't')[0]));
      const line = runs.join('').trim();
      if (line) paragraphs.push(line);
    }
    if (paragraphs.length === 0) continue;
    blocks.push(
      isTitle
        ? paragraphs.map((l) => `# ${l}`).join('\n\n')
        : paragraphs.join('\n\n'),
    );
  }
  return blocks.join('\n\n');
}

function isTitlePlaceholder(sp: XmlElement): boolean {
  const ph = byLocalName(sp, 'ph')[0];
  if (!ph) return false;
  const type = ph.getAttribute('type') ?? '';
  return type === 'title' || type === 'ctrTitle';
}

// ─── xlsx ────────────────────────────────────────────────

export interface XlsxParseOptions {
  /** 把首行当表头，后续行渲染成表格。false 时首行也是普通数据行（对齐上游语义）。 */
  firstRowAsHeader?: boolean;
}

/**
 * 工作表正文。
 *
 * 每张表输出成「`## 表名` + Markdown 表格」：表头和它的数据行**必须在同一个块里**。
 * 这是这个函数存在的全部理由 —— 摊平成一行行文本的话，分块边界一旦落在表头和数据
 * 之间，「某药的剂量是多少」就只能命中一段没有列名的数字。
 */
export async function parseXlsx(
  buf: Buffer,
  filename = 'workbook.xlsx',
  options: XlsxParseOptions = {},
): Promise<string> {
  const firstRowAsHeader = options.firstRowAsHeader !== false;
  const zip = await openZipDocument(buf, filename);
  const workbookXml = await readPart(zip, 'xl/workbook.xml');
  if (!workbookXml) {
    throw new ZipDocumentError(`「${filename}」不是有效的 XLSX（缺少 xl/workbook.xml）。`);
  }

  const sharedStrings = await readSharedStrings(zip);
  const relsXml = await readPart(zip, 'xl/_rels/workbook.xml.rels');
  const relMap = new Map<string, string>();
  if (relsXml) {
    for (const rel of byLocalName(parseXml(relsXml, 'workbook.xml.rels'), 'Relationship')) {
      const id = rel.getAttribute('Id');
      const target = rel.getAttribute('Target');
      if (id && target) relMap.set(id, normalizeZipPath('xl', target));
    }
  }

  const sheets = byLocalName(parseXml(workbookXml, 'workbook.xml'), 'sheet');
  const sections: string[] = [];

  for (const sheet of sheets) {
    const name = sheet.getAttribute('name') ?? 'Sheet';
    let rid = '';
    for (let i = 0; i < sheet.attributes.length; i++) {
      const attr = sheet.attributes[i];
      if ((attr.localName ?? attr.name) === 'id') rid = attr.value;
    }
    const path = relMap.get(rid);
    if (!path) continue;
    const sheetXml = await readPart(zip, path);
    if (!sheetXml) continue;

    const rows = readSheetRows(parseXml(sheetXml, path), sharedStrings);
    if (rows.length === 0) continue;

    sections.push(`## ${name}\n\n${rowsToMarkdown(rows, firstRowAsHeader)}`);
  }

  if (sections.length === 0) {
    throw new ZipDocumentError(`「${filename}」里没有找到任何非空工作表。`);
  }
  return sections.join('\n\n');
}

async function readSharedStrings(zip: JSZip): Promise<string[]> {
  const xml = await readPart(zip, 'xl/sharedStrings.xml');
  if (!xml) return [];
  const doc = parseXml(xml, 'sharedStrings.xml');
  return byLocalName(doc, 'si').map((si) =>
    // 一个 <si> 里可能是单个 <t>，也可能是多个 <r><t>（富文本分片），都要拼全。
    byLocalName(si, 't')
      .map((t) => t.textContent ?? '')
      .join('')
      .trim(),
  );
}

interface SheetRow {
  /** 列索引 -> 单元格文本。用 Map 是为了让空列在有数据的列之前/之后都不错位。 */
  cells: Map<number, string>;
}

function readSheetRows(doc: XmlDocument, sharedStrings: string[]): SheetRow[] {
  const rows: SheetRow[] = [];
  for (const rowEl of byLocalName(doc, 'row')) {
    const cells = new Map<number, string>();
    let fallbackIndex = 0;
    for (const c of childrenByLocalName(rowEl, 'c')) {
      const ref = c.getAttribute('r');
      const colIndex = ref ? columnIndexFromRef(ref) : fallbackIndex;
      fallbackIndex = colIndex + 1;
      const value = readCellValue(c, sharedStrings);
      if (value) cells.set(colIndex, value);
    }
    if (cells.size > 0) rows.push({ cells });
  }
  return rows;
}

/** `C12` -> 2（0 基列索引）。 */
function columnIndexFromRef(ref: string): number {
  let index = 0;
  for (const ch of ref) {
    const code = ch.charCodeAt(0);
    if (code < 65 || code > 90) break;
    index = index * 26 + (code - 64);
  }
  return Math.max(0, index - 1);
}

function readCellValue(c: XmlElement, sharedStrings: string[]): string {
  const type = c.getAttribute('t') ?? '';
  if (type === 'inlineStr') {
    return byLocalName(c, 't')
      .map((t) => t.textContent ?? '')
      .join('')
      .trim();
  }
  const v = childrenByLocalName(c, 'v')[0] ?? byLocalName(c, 'v')[0];
  const raw = v?.textContent?.trim() ?? '';
  if (!raw) return '';
  if (type === 's') {
    const idx = Number.parseInt(raw, 10);
    return Number.isFinite(idx) ? (sharedStrings[idx] ?? '') : '';
  }
  if (type === 'b') return raw === '1' ? 'TRUE' : 'FALSE';
  return raw;
}

function rowsToMarkdown(rows: SheetRow[], firstRowAsHeader: boolean): string {
  const width = Math.max(...rows.map((r) => Math.max(...r.cells.keys()) + 1), 1);
  const toLine = (row: SheetRow) =>
    Array.from({ length: width }, (_, i) => escapeCell(row.cells.get(i) ?? ''));

  if (firstRowAsHeader && rows.length >= 1) {
    // 表头全空的行没有当表头的资格（常见于表格上方留了空行的 Excel），
    // 这时整张表按无表头处理，否则会输出一个 `| | | |` 的假表头。
    const header = toLine(rows[0]);
    if (!header.every((c) => c === '')) {
      const out = [
        `| ${header.join(' | ')} |`,
        `| ${header.map(() => '---').join(' | ')} |`,
        ...rows.slice(1).map((r) => `| ${toLine(r).join(' | ')} |`),
      ];
      return out.join('\n');
    }
  }
  return rows.map((r) => toLine(r).join(' | ')).join('\n');
}

function escapeCell(value: string): string {
  // 竖线会破坏表格结构，换行会把一行拆成两行 —— 都换掉。
  return value.replace(/\|/g, '\\|').replace(/\r?\n/g, ' ').trim();
}

// ─── epub ────────────────────────────────────────────────

/**
 * 电子书正文，按 `spine` 顺序逐章输出。
 *
 * 顺序必须来自 spine，**不能**按 manifest 或文件名排 —— 章节目录名是
 * `chapter01.xhtml`、`part2.html`、`c3.xhtml` 这种毫无规律的命名，
 * spine 才是「读者实际翻页的顺序」这个唯一权威。
 */
export async function parseEpub(buf: Buffer, filename = 'book.epub'): Promise<string> {
  const zip = await openZipDocument(buf, filename);
  const containerXml = await readPart(zip, 'META-INF/container.xml');
  if (!containerXml) {
    throw new ZipDocumentError(`「${filename}」不是有效的 EPUB（缺少 META-INF/container.xml）。`);
  }
  const rootfile = byLocalName(parseXml(containerXml, 'container.xml'), 'rootfile')[0];
  const opfPath = rootfile?.getAttribute('full-path');
  if (!opfPath) throw new ZipDocumentError(`「${filename}」的 container.xml 里没有声明 rootfile。`);

  const opfXml = await readPart(zip, opfPath);
  if (!opfXml) throw new ZipDocumentError(`「${filename}」缺少 OPF 文件（${opfPath}）。`);

  const opfDir = opfPath.includes('/') ? opfPath.slice(0, opfPath.lastIndexOf('/')) : '';
  const opf = parseXml(opfXml, 'content.opf');

  const hrefById = new Map<string, string>();
  for (const item of byLocalName(opf, 'item')) {
    const id = item.getAttribute('id');
    const href = item.getAttribute('href');
    if (id && href) hrefById.set(id, normalizeZipPath(opfDir, href));
  }

  const chapters: string[] = [];
  for (const itemref of byLocalName(opf, 'itemref')) {
    const idref = itemref.getAttribute('idref');
    const path = idref ? hrefById.get(idref) : undefined;
    if (!path) continue;
    const html = await readPart(zip, path);
    if (!html) continue;
    // 只剥成纯文本的话章节标题会和正文糊在一起，「这一章讲什么」检索不出来；
    // 也不复用 document-parser 的 stripHtml —— 那个是给网页正文抽词用的，
    // 丢掉全部标签，还会在正文为空时抛错（一本只有插图的绘本不该整本失败）。
    const text = await xhtmlToMarkdown(html);
    if (!text) continue;
    chapters.push(text);
  }

  if (chapters.length === 0) {
    throw new ZipDocumentError(`「${filename}」里没有可提取的正文。`);
  }
  return chapters.join('\n\n');
}

/**
 * EPUB 的 XHTML 章节 -> Markdown。
 *
 * 保留标题层级（`h1`-`h6`）是这里唯一不能省的事：分块策略 `heading` 正是按
 * Markdown 标题切的，标题丢了章节就会被切在句子中间。
 */
async function xhtmlToMarkdown(html: string): Promise<string> {
  // 同 document-parser.ts 的 stripHtml：ESM 下没有 `require`，必须动态 import。
  const cheerio = await import('cheerio');
  const $ = cheerio.load(html);
  $('script,style,nav,header,footer,aside,form,iframe,svg').remove();

  const blocks: string[] = [];
  const push = (line: string) => {
    const trimmed = line.replace(/\s+/g, ' ').trim();
    if (trimmed) blocks.push(trimmed);
  };

  // 按文档顺序遍历块级元素，避免把 <h1> 和它后面的 <p> 拆成两趟读。
  $('h1,h2,h3,h4,h5,h6,p,li,blockquote,pre').each((_i, el) => {
    const tag = (el as { tagName?: string }).tagName?.toLowerCase() ?? '';
    const text = $(el).text().replace(/\s+/g, ' ').trim();
    if (!text) return;
    if (/^h[1-6]$/.test(tag)) push(`${'#'.repeat(Number(tag[1]))} ${text}`);
    else if (tag === 'li') push(`- ${text}`);
    else if (tag === 'blockquote') push(`> ${text}`);
    else push(text);
  });

  // 章节里没有块级元素时（罕见但合法）退回整篇取文本。
  if (blocks.length === 0) {
    const fallback = $.root().text().replace(/\s+/g, ' ').trim();
    return fallback;
  }
  return blocks.join('\n\n');
}

// ─── xmind ───────────────────────────────────────────────

/**
 * 思维导图：中心主题 + 分支层级，用标题层级表达。
 *
 * 两种存储都要支持，因为两个版本的文件都真实存在：
 *   - XMind Zen / 2020+ : `content.json`
 *   - XMind 8 及更早    : `content.xml`
 * 只支持一种的话，用户会遇到「同一个软件的旧文件传不进来」。
 */
export async function parseXmind(buf: Buffer, filename = 'map.xmind'): Promise<string> {
  const zip = await openZipDocument(buf, filename);

  const json = await readPart(zip, 'content.json');
  if (json !== null) {
    const sections = xmindJsonToMarkdown(json, filename);
    if (sections) return sections;
  }

  const xml = await readPart(zip, 'content.xml');
  if (xml !== null) {
    const sections = xmindXmlToMarkdown(xml, filename);
    if (sections) return sections;
  }

  throw new ZipDocumentError(`「${filename}」里没有找到可提取的导图内容。`);
}

function xmindJsonToMarkdown(json: string, filename: string): string | null {
  let parsed: unknown;
  try {
    parsed = JSON.parse(json);
  } catch {
    return null;
  }
  const sheets = Array.isArray(parsed) ? parsed : [];
  const out: string[] = [];
  for (const sheet of sheets as Array<Record<string, unknown>>) {
    const title = typeof sheet.title === 'string' ? sheet.title.trim() : '';
    const root = sheet.rootTopic as Record<string, unknown> | undefined;
    if (!root) continue;
    const lines: string[] = [];
    walkJsonTopic(root, 1, lines);
    if (lines.length === 0) continue;
    out.push(title ? `# ${title}\n\n${lines.join('\n')}` : lines.join('\n'));
  }
  return out.length > 0 ? out.join('\n\n') : null;
}

function walkJsonTopic(topic: Record<string, unknown>, level: number, out: string[]): void {
  const title = typeof topic.title === 'string' ? topic.title.trim() : '';
  if (title) out.push(`${'#'.repeat(Math.min(level, 6))} ${title}`);
  const children = topic.children as Record<string, unknown> | undefined;
  const attached = children?.attached;
  if (!Array.isArray(attached)) return;
  for (const child of attached as Array<Record<string, unknown>>) {
    walkJsonTopic(child, level + 1, out);
  }
}

function xmindXmlToMarkdown(xml: string, filename: string): string | null {
  const doc = parseXml(xml, 'content.xml');
  const sheets = byLocalName(doc, 'sheet');
  const out: string[] = [];
  for (const sheet of sheets) {
    const title = textOf(childrenByLocalName(sheet, 'title')[0]);
    const topic = childrenByLocalName(sheet, 'topic')[0];
    if (!topic) continue;
    const lines: string[] = [];
    walkXmlTopic(topic, 1, lines);
    if (lines.length === 0) continue;
    out.push(title ? `# ${title}\n\n${lines.join('\n')}` : lines.join('\n'));
  }
  return out.length > 0 ? out.join('\n\n') : null;
}

function walkXmlTopic(topic: XmlElement, level: number, out: string[]): void {
  const title = textOf(childrenByLocalName(topic, 'title')[0]);
  if (title) out.push(`${'#'.repeat(Math.min(level, 6))} ${title}`);

  // 子主题藏在 <children><topics type="attached"><topic> 里，层级不固定；
  // 用「直接子元素」递归而不是全树遍历，保证每个节点只渲染一次。
  const queue = [...childrenByLocalName(topic, 'topic')];
  for (const child of byLocalName(topic, 'topics')) queue.push(...childrenByLocalName(child, 'topic'));
  for (const child of queue) walkXmlTopic(child, level + 1, out);
}

// ─── 类型判定 ────────────────────────────────────────────

/**
 * 扩展名缺失时，靠 zip 内部结构判定是哪一种。
 *
 * **不能靠 magic**：docx / pptx / xlsx / epub / xmind 的开头全都是 `PK\x03\x04`，
 * 拿它判等于把它们当成同一种东西。现有的 `sniffParserFromBuffer` 正是这么做的
 * （返回 docx），所以对没有扩展名的 xlsx 会把它交给 mammoth，报出
 * 「DOCX 没有可提取文本」—— 看起来像文件坏了，其实是走错了通道。
 */
export async function detectZipDocumentType(buf: Buffer): Promise<ZipDocumentType | null> {
  let zip: JSZip;
  try {
    zip = await JSZip.loadAsync(buf);
  } catch {
    return null;
  }
  const names = Object.keys(zip.files);
  if (names.some((n) => n === 'ppt/presentation.xml')) return 'pptx';
  if (names.some((n) => n === 'xl/workbook.xml')) return 'xlsx';
  if (names.some((n) => n === 'META-INF/container.xml')) return 'epub';
  if (names.some((n) => n === 'content.json' || n === 'content.xml')) return 'xmind';
  return null;
}

/** 解析分发；失败只记日志不吞错 —— 调用方要拿到原因去回执给用户。 */
export async function parseZipDocument(
  type: ZipDocumentType,
  buf: Buffer,
  filename: string,
  options: XlsxParseOptions = {},
): Promise<string> {
  logger.debug({ type, filename }, 'Parsing zip-container document');
  switch (type) {
    case 'pptx':
      return parsePptx(buf, filename);
    case 'xlsx':
      return parseXlsx(buf, filename, options);
    case 'epub':
      return parseEpub(buf, filename);
    case 'xmind':
      return parseXmind(buf, filename);
  }
}
