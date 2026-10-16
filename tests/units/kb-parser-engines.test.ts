// 解析通道规则（ParserEngineRules）的纯函数层。
//
// 这组用例守的是一条**零回归**边界：没有配规则的库必须和引入这套机制之前
// 逐字节一致。所以最重要的断言不是"规则生效了"，而是"没规则时什么都没变"。

import { describe, expect, test } from 'vitest';
import {
  PARSER_ENGINES,
  isParserEngine,
  normalizeFileType,
  parseParserEngineRules,
  resolveParserEngine,
  serializeParserEngineRules,
  type ParserEngineRule,
} from '../../src/kb/parser-engines.js';

describe('normalizeFileType', () => {
  test('大小写 / 前导点 / 空白三种写法归一', () => {
    // 用户在界面上手填，写法不可能统一 —— 不归一化就会出现
    // 「明明配了 pdf 却匹配不上」。
    expect(normalizeFileType('PDF')).toBe('pdf');
    expect(normalizeFileType('.pdf')).toBe('pdf');
    expect(normalizeFileType('  PDF  ')).toBe('pdf');
    expect(normalizeFileType('..pptx')).toBe('pptx');
    expect(normalizeFileType('.')).toBe('');
  });
});

describe('parseParserEngineRules', () => {
  test('坏数据不让整个知识库瘫痪：非法条目丢弃，合法的继续生效', () => {
    const raw = JSON.stringify([
      { file_types: ['PDF'], engine: 'ocr' },
      { file_types: [], engine: 'builtin' }, // 无类型 -> 丢
      { file_types: ['xlsx'], engine: 'mineru' }, // 不认识的引擎 -> 丢
      null,
      'not an object',
      { file_types: ['.XLSX'], engine: 'builtin', xlsx_first_row_as_header: false },
    ]);
    const rules = parseParserEngineRules(raw);
    expect(rules).toHaveLength(2);
    expect(rules[0]).toEqual({ file_types: ['pdf'], engine: 'ocr' });
    expect(rules[1]).toEqual({
      file_types: ['xlsx'],
      engine: 'builtin',
      xlsx_first_row_as_header: false,
    });
  });

  test('非 JSON / 非数组 / 空值一律当作没有规则', () => {
    expect(parseParserEngineRules(null)).toEqual([]);
    expect(parseParserEngineRules(undefined)).toEqual([]);
    expect(parseParserEngineRules('')).toEqual([]);
    expect(parseParserEngineRules('{')).toEqual([]);
    expect(parseParserEngineRules('{"a":1}')).toEqual([]);
  });

  test('序列化时归一化并保留 xlsx_first_row_as_header', () => {
    const rules: ParserEngineRule[] = [
      { file_types: ['PDF', '.Pdf'], engine: 'ocr' },
      { file_types: ['XLSX'], engine: 'builtin', xlsx_first_row_as_header: false },
    ];
    const raw = serializeParserEngineRules(rules);
    expect(JSON.parse(raw)).toEqual([
      { file_types: ['pdf', 'pdf'], engine: 'ocr' },
      { file_types: ['xlsx'], engine: 'builtin', xlsx_first_row_as_header: false },
    ]);
    // 序列化 -> 解析 是恒等变换（除了归一化）。
    expect(parseParserEngineRules(raw)).toEqual(JSON.parse(raw));
  });
});

describe('isParserEngine', () => {
  test('只认 builtin / ocr', () => {
    // 上游的 simple / markitdown / mineru / anydoc 都是 Python 侧车，本仓库没有
    // 那条链路 —— 照搬名字只会得到一组永远指向不存在的东西的配置项。
    expect(PARSER_ENGINES).toEqual(['builtin', 'ocr']);
    expect(isParserEngine('builtin')).toBe(true);
    expect(isParserEngine('ocr')).toBe(true);
    expect(isParserEngine('markitdown')).toBe(false);
    expect(isParserEngine(undefined)).toBe(false);
  });
});

describe('resolveParserEngine', () => {
  test('没有规则时是 builtin + 首行当表头（零回归的前提）', () => {
    expect(resolveParserEngine([], 'pdf')).toEqual({
      engine: 'builtin',
      xlsxFirstRowAsHeader: true,
    });
    expect(resolveParserEngine(parseParserEngineRules(null), 'xlsx')).toEqual({
      engine: 'builtin',
      xlsxFirstRowAsHeader: true,
    });
  });

  test('没命中类型的规则不影响其它类型', () => {
    const rules = parseParserEngineRules(
      JSON.stringify([{ file_types: ['pdf'], engine: 'ocr' }]),
    );
    expect(resolveParserEngine(rules, 'docx').engine).toBe('builtin');
    expect(resolveParserEngine(rules, 'docx').warning).toBeUndefined();
    expect(resolveParserEngine(rules, 'pdf').engine).toBe('ocr');
  });

  test('xlsx_first_row_as_header 显式 false 才关，缺省为开', () => {
    const on = parseParserEngineRules(JSON.stringify([{ file_types: ['xlsx'], engine: 'builtin' }]));
    const off = parseParserEngineRules(
      JSON.stringify([{ file_types: ['xlsx'], engine: 'builtin', xlsx_first_row_as_header: false }]),
    );
    expect(resolveParserEngine(on, 'xlsx').xlsxFirstRowAsHeader).toBe(true);
    expect(resolveParserEngine(off, 'xlsx').xlsxFirstRowAsHeader).toBe(false);
  });

  test('给非 pdf 配 ocr：回落 builtin 并带回执说明，而不是报错', () => {
    // OCR 通道靠光栅化「页面」工作，只有 PDF 有这个模型。给 pptx 配 ocr 不是
    // "暂不支持"，而是语义上就不成立 —— 配置写错是管理员的事，不该让用户传不了文档，
    // 但也不能让他以为配置生效了。
    const rules = parseParserEngineRules(
      JSON.stringify([{ file_types: ['pptx'], engine: 'ocr' }]),
    );
    const resolved = resolveParserEngine(rules, 'pptx');
    expect(resolved.engine).toBe('builtin');
    expect(resolved.warning).toMatch(/只支持 pdf/);
  });

  test('ocr 规则对 pdf 生效且没有 warning', () => {
    const rules = parseParserEngineRules(JSON.stringify([{ file_types: ['pdf'], engine: 'ocr' }]));
    const resolved = resolveParserEngine(rules, 'pdf');
    expect(resolved.engine).toBe('ocr');
    expect(resolved.warning).toBeUndefined();
  });

  test('类型比对也走归一化（规则里写 PDF、解析器给 pdf）', () => {
    const rules = parseParserEngineRules(JSON.stringify([{ file_types: ['PDF'], engine: 'ocr' }]));
    expect(resolveParserEngine(rules, 'pdf').engine).toBe('ocr');
  });
});
