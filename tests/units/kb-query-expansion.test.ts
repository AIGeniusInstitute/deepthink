// 查询改写 / 扩展的纯函数层。
//
// 规格来源：WeKnora internal/application/service/chat_pipeline/query_expansion.go
// 及其自带测试 query_expansion_test.go。
//
// 注意本文件里有一条**故意断言"和 WeKnora 不一样"**的用例（见最后一条）。本模块
// 不做 jieba 分词，这是显式偏离而非疏漏，模块头注释列了全部 6 条偏离及理由。
// 把它写成断言，是为了让偏离一直可见，而不是藏在注释里随时间腐烂。

import { describe, expect, test } from 'vitest';
import {
  expandQueries,
  extractKeywords,
  extractPhrases,
  removeQuestionWords,
  splitByDelimiters,
  MAX_EXPANSIONS,
  EXPANSION_CONCURRENCY_CAP,
} from '../../src/kb/query-expansion.js';

describe('extractKeywords', () => {
  test('英文停用词按整词剔除，单字符词被丢弃', () => {
    expect(extractKeywords('the vector database')).toEqual(['vector', 'database']);
    // 'a' 是停用词，'b' 单字符（WeKnora 的 RuneCountInString(w) > 1）
    expect(extractKeywords('a b')).toEqual([]);
  });

  test('中英混排按脚本切分，不跨越边界', () => {
    const keywords = extractKeywords('RAG如何配置PostgreSQL');
    expect(keywords).toContain('RAG');
    expect(keywords).toContain('PostgreSQL');
    expect(keywords).not.toContain('RAG如何配置');
  });

  test('中文停用字就地剔除（的/是/在/了/和/与/或）', () => {
    expect(extractKeywords('向量数据库的索引')).toEqual(['向量数据库索引']);
    // 他/我 不在 WeKnora 的停用词表里（表里没有代词），所以只掉 和/在，
    // 剩下的 他我北京 整体保留——这是照做，不是漏删。
    expect(extractKeywords('他和我在北京')).toEqual(['他我北京']);
  });
});

describe('extractPhrases', () => {
  test('ASCII 引号与中文书名号都能取到', () => {
    expect(extractPhrases('查询"向量数据库"的配置')).toEqual(['向量数据库']);
    expect(extractPhrases('查询「向量数据库」的配置')).toEqual(['向量数据库']);
    expect(extractPhrases('查询『向量数据库』的配置')).toEqual(['向量数据库']);
  });

  test('智能引号也能取到（对 WeKnora 的有意超集，见模块头注释偏离 4）', () => {
    expect(extractPhrases('查询“向量数据库”的配置')).toEqual(['向量数据库']);
  });

  test('短语短于 3 个字符时丢弃', () => {
    expect(extractPhrases('"a" 和 "bb"')).toEqual([]);
    expect(extractPhrases('"abc"')).toEqual(['abc']);
  });
});

describe('splitByDelimiters', () => {
  test('中英文分隔符混用', () => {
    expect(splitByDelimiters('a, b；c。d！e？f')).toEqual(['a', 'b', 'c', 'd', 'e', 'f']);
  });
});

describe('removeQuestionWords', () => {
  test('只剥前缀，不动句中', () => {
    expect(removeQuestionWords('如何配置数据库')).toBe('配置数据库');
    // "如何" 出现在句中，正则以 ^ 锚定，不应被剥掉
    expect(removeQuestionWords('配置数据库如何做')).toBe('配置数据库如何做');
  });

  test('长疑问词优先（什么是 先于 什么）', () => {
    expect(removeQuestionWords('什么是RAG')).toBe('RAG');
  });
});

describe('expandQueries', () => {
  test('空查询与纯空白产出空数组', () => {
    expect(expandQueries('')).toEqual([]);
    expect(expandQueries('   ')).toEqual([]);
  });

  test('疑问词前缀被剥掉，产出去疑问词变体', () => {
    expect(expandQueries('如何配置向量数据库')).toEqual(['配置向量数据库']);
    // 两条变体：规则 1 只掉停用字（是），"什么" 不在停用词表里所以留着；
    // 规则 4 才负责把整个疑问词前缀剥掉。WeKnora 同样如此——它的停用词表
    // 有 what/how/why，却没有 什么/如何。
    expect(expandQueries('什么是向量数据库')).toEqual(['什么向量数据库', '向量数据库']);
  });

  // 这条锁的是偏离 3：没有分词器时，纯中文查询会塌成单个 run。
  // 若沿用 WeKnora 的 len(keywords) >= 2 门槛，这里会一条变体都产不出——
  // 那不是字符串差异，是能力丢失。
  test('纯中文且无疑问词时，仍产出去停用字的变体', () => {
    expect(expandQueries('向量数据库的索引参数配置')).toEqual(['向量数据库索引参数配置']);
  });

  test('不把原查询当成变体回吐（大小写不敏感去重）', () => {
    // 规则 1 拼出的 'vector database' 与入参相同 → 被 seen 拦截；
    // 规则 3 切出的两个片段都长于 5 字符 → 正常加入。
    expect(expandQueries('vector database')).toEqual(['vector', 'database']);
  });

  test('引号短语作为独立变体参与', () => {
    const variants = expandQueries('查询"向量数据库索引"的方法');
    expect(variants).toContain('向量数据库索引');
  });

  test('变体数量上限可配置，默认 5', () => {
    expect(MAX_EXPANSIONS).toBe(5);
    const capped = expandQueries('什么是向量数据库的索引配置', { max: 1 });
    expect(capped).toHaveLength(1);
    expect(expandQueries('什么是向量数据库的索引配置').length).toBeLessThanOrEqual(MAX_EXPANSIONS);
  });

  test('并发上限常量与 WeKnora 一致（仅用于对齐 debug 载荷）', () => {
    expect(EXPANSION_CONCURRENCY_CAP).toBe(16);
  });

  // ⚠️ 这条断言的是**差异**，不是一致。WeKnora 走 jieba，会得到
  // ['RAG','配置','PostgreSQL']；本模块无分词器，中文 run 整体保留。
  // 见模块头注释偏离 1。
  test('中文不做 jieba 分词——与 WeKnora 的显式偏离', () => {
    expect(extractKeywords('RAG如何配置PostgreSQL')).toEqual(['RAG', '如何配置', 'PostgreSQL']);
  });
});
