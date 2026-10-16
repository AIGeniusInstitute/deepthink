/**
 * ParserEngineRules —— 按文件类型指定解析通道。
 *
 * 上游 WeKnora 的引擎清单是 `builtin / simple / markitdown / mineru / anydoc`，
 * 其中后三个都是 Python 侧车（docreader）。本仓库没有那条链路，所以照搬名字
 * 只会得到一组永远指向不存在的东西的配置项。DeepThink 只有两条真实通道：
 *
 *   - `builtin`：进程内解析（pdf 文字层 / docx / xlsx / pptx / epub / xmind / 文本）
 *   - `ocr`    ：P3 交付的视觉模型 OCR 通道（光栅化 + VLM 逐页转写）
 *
 * `ocr` 这条规则不是把上游机制搬过来当摆设 —— 它补的是**自动分流盖不住的缺口**：
 * 自动转 OCR 只在 `parsePdf` 抛 `PdfHasNoTextLayerError`（一个字都抽不出来）时触发。
 * 而有些 PDF **有**文字层、只是文字层是坏的（字体缺 ToUnicode 映射，抽出来是乱码），
 * 它不会抛错，于是永远进不了 OCR。这类文件只能靠人显式指定。
 */

import type { ParserType } from '../document-parser.js';

export type ParserEngine = 'builtin' | 'ocr';

export const PARSER_ENGINES: ParserEngine[] = ['builtin', 'ocr'];

export interface ParserEngineRule {
  /** 文件类型，写法宽容：'PDF' / '.pdf' / 'pdf' 等价。存储时归一化。 */
  file_types: string[];
  engine: ParserEngine;
  /** 仅对 xlsx 有意义：是否把首行当表头。 */
  xlsx_first_row_as_header?: boolean;
}

export interface ResolvedParserEngine {
  engine: ParserEngine;
  xlsxFirstRowAsHeader: boolean;
  /**
   * 规则配了但没能生效时的原因（引擎名不认识、或该类型不支持 ocr）。
   * 有值不代表失败 —— 上传照常走 builtin，只是要让管理员知道配置没起作用。
   */
  warning?: string;
}

/**
 * 归一化文件类型：去空白 → 去前导点 → 小写。
 *
 * 上游的测试里 `"PDF"` / `".pptx"` / `"pptx"` 三种写法都出现过（用户在界面上
 * 手填，写法不可能统一），不归一化就会出现「明明配了 pdf 却匹配不上」。
 */
export function normalizeFileType(raw: string): string {
  return raw.trim().replace(/^\.+/, '').toLowerCase();
}

export function isParserEngine(value: unknown): value is ParserEngine {
  return typeof value === 'string' && (PARSER_ENGINES as string[]).includes(value);
}

const DEFAULT_RESOLUTION: ResolvedParserEngine = {
  engine: 'builtin',
  xlsxFirstRowAsHeader: true,
};

/**
 * 解析规则列表。宽容处理坏数据 —— 一条写坏的规则不该让整个知识库的上传瘫痪，
 * 所以非法条目直接丢弃，合法的继续生效。
 */
export function parseParserEngineRules(raw: string | null | undefined): ParserEngineRule[] {
  if (!raw) return [];
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch {
    return [];
  }
  if (!Array.isArray(parsed)) return [];
  const rules: ParserEngineRule[] = [];
  for (const item of parsed) {
    if (!item || typeof item !== 'object') continue;
    const record = item as Record<string, unknown>;
    const types = Array.isArray(record.file_types) ? record.file_types : [];
    const fileTypes = types
      .filter((t): t is string => typeof t === 'string')
      .map(normalizeFileType)
      .filter(Boolean);
    if (fileTypes.length === 0) continue;
    if (!isParserEngine(record.engine)) continue;
    const rule: ParserEngineRule = { file_types: fileTypes, engine: record.engine };
    if (typeof record.xlsx_first_row_as_header === 'boolean') {
      rule.xlsx_first_row_as_header = record.xlsx_first_row_as_header;
    }
    rules.push(rule);
  }
  return rules;
}

export function serializeParserEngineRules(rules: ParserEngineRule[]): string {
  return JSON.stringify(
    rules.map((rule) => ({
      file_types: rule.file_types.map(normalizeFileType).filter(Boolean),
      engine: rule.engine,
      ...(typeof rule.xlsx_first_row_as_header === 'boolean'
        ? { xlsx_first_row_as_header: rule.xlsx_first_row_as_header }
        : {}),
    })),
  );
}

/**
 * 按文件类型解析出该走哪条通道。
 *
 * 未命中任何规则时返回 `builtin` —— 与引入这套机制之前**逐字节一致**的行为，
 * 这是零回归的前提（既有知识库没有规则，必须走原来的路）。
 */
export function resolveParserEngine(
  rules: ParserEngineRule[],
  parserType: ParserType | string,
): ResolvedParserEngine {
  const type = normalizeFileType(String(parserType));
  const rule = rules.find((r) => r.file_types.includes(type));
  if (!rule) return { ...DEFAULT_RESOLUTION };

  const resolution: ResolvedParserEngine = {
    engine: rule.engine,
    xlsxFirstRowAsHeader: rule.xlsx_first_row_as_header !== false,
  };

  // OCR 通道靠光栅化「页面」工作，只有 PDF 有这个模型。给 pptx 配 ocr 不是
  // "暂不支持"，而是语义上就不成立 —— 回落并说清楚，比让它报一个看不懂的错好。
  if (rule.engine === 'ocr' && type !== 'pdf') {
    return {
      ...DEFAULT_RESOLUTION,
      warning: `规则里把 ${type} 指向了 ocr 引擎，但 OCR 通道只支持 pdf（它需要把页面光栅化成图片）。该类型已回落为内置解析。`,
    };
  }

  return resolution;
}
