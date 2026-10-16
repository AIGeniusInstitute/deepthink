// FAQ 条目：元数据清理、问题归一化、内容指纹、两种"内容"的构造、负向匹配。
//
// 规格来源：WeKnora internal/types/faq.go（NormalizeQuestion:591、
// SanitizeStrings:146、CalculateFAQContentHash:211）与
// internal/application/service/knowledge_faq.go（buildFAQChunkContent:1618、
// buildFAQIndexContent:1875、buildFAQIndexInfoList:1892）。
//
// 本文件里有一条**故意断言"和上游不一样"**的用例（繁转简），见模块头注释偏离 1。

import { describe, expect, test } from 'vitest';
import {
  DEFAULT_FAQ_CONFIG,
  buildFaqChunkContent,
  buildFaqIndexTexts,
  calculateFaqContentHash,
  faqVariantSourceId,
  matchesNegativeQuestions,
  normalizeAnswerStrategy,
  normalizeIndexMode,
  normalizeQuestion,
  normalizeQuestionIndexMode,
  parseFaqConfig,
  parseFaqMetadata,
  sanitizeFaqMetadata,
  sanitizeStrings,
  type FaqMetadata,
} from '../../src/kb/faq.js';

describe('sanitizeStrings', () => {
  test('去空白、丢空串、按原顺序去重', () => {
    expect(sanitizeStrings(['  b ', 'a', '', '   ', 'a', 'b'])).toEqual(['b', 'a']);
  });

  test('空输入得到空数组', () => {
    expect(sanitizeStrings([])).toEqual([]);
    expect(sanitizeStrings(undefined)).toEqual([]);
    expect(sanitizeStrings(null)).toEqual([]);
  });
});

describe('sanitizeFaqMetadata', () => {
  test('version 缺省或非正数时补 1', () => {
    expect(sanitizeFaqMetadata({ standard_question: ' Q ' }).version).toBe(1);
    expect(sanitizeFaqMetadata({ standard_question: 'Q', version: 0 }).version).toBe(1);
    expect(sanitizeFaqMetadata({ standard_question: 'Q', version: 7 }).version).toBe(7);
  });

  test('标准问去空白；空的可选字段不进结果', () => {
    const meta = sanitizeFaqMetadata({
      standard_question: '  RAG 是什么  ',
      similar_questions: ['  ', ''],
      answers: [],
    });
    expect(meta.standard_question).toBe('RAG 是什么');
    expect(meta.similar_questions).toBeUndefined();
    expect(meta.answers).toBeUndefined();
  });
});

describe('normalizeQuestion — 处理顺序与上游一致', () => {
  // trim → 去 URL → 转小写 → 去首尾标点 → 全角转半角 → 空白折叠 → trim
  test('去掉 URL', () => {
    expect(normalizeQuestion('https://example.com 怎么用')).toBe('怎么用');
  });

  test('转小写并去掉首尾标点', () => {
    expect(normalizeQuestion('How to configure RAG?')).toBe('how to configure rag');
    expect(normalizeQuestion('？什么是RAG？')).toBe('什么是rag');
  });

  test('全角转半角（含全角字母）', () => {
    expect(normalizeQuestion('ＲＡＧ是什么')).toBe('rag是什么');
  });

  test('空白折叠：中文间去空格，英文/数字间保留', () => {
    expect(normalizeQuestion('怎么 绑定 手机')).toBe('怎么绑定手机');
    expect(normalizeQuestion('iphone 15 怎么 激活')).toBe('iphone 15怎么激活');
  });

  test('标点去重发生在转半角之前，故全角标点同样被去掉', () => {
    // 若把顺序写反，全角"！"会先变成半角"!"、再被"去首尾标点"处理——结果一样；
    // 但"！"若不在字符集里就会留下。这条锁定的是字符集本身的内容。
    expect(normalizeQuestion('你好！')).toBe('你好');
    expect(normalizeQuestion('你好!')).toBe('你好');
  });

  test('空串与纯空白得到空串', () => {
    expect(normalizeQuestion('   ')).toBe('');
    expect(normalizeQuestion('')).toBe('');
  });

  // ⚠️ 断言的是**差异**：上游在这一步之后还有繁体转简体（OpenCC 词典）。
  // 我们不实现，见模块头注释偏离 1。
  test('不做繁体转简体（与上游的显式偏离）', () => {
    expect(normalizeQuestion('什麼是向量資料庫')).toBe('什麼是向量資料庫');
  });
});

describe('answer_strategy / index_mode 归一化', () => {
  test('只认 random，其它一律 all', () => {
    expect(normalizeAnswerStrategy('random')).toBe('random');
    expect(normalizeAnswerStrategy('all')).toBe('all');
    expect(normalizeAnswerStrategy(undefined)).toBe('all');
    expect(normalizeAnswerStrategy('RANDOM')).toBe('all');
  });

  test('index_mode 只认 question_only，其余回落 question_answer', () => {
    expect(normalizeIndexMode('question_only')).toBe('question_only');
    expect(normalizeIndexMode('question_answer')).toBe('question_answer');
    expect(normalizeIndexMode(undefined)).toBe('question_answer');
  });

  test('question_index_mode 只认 separate，其余回落 combined', () => {
    expect(normalizeQuestionIndexMode('separate')).toBe('separate');
    expect(normalizeQuestionIndexMode('combined')).toBe('combined');
    expect(normalizeQuestionIndexMode(undefined)).toBe('combined');
  });
});

describe('parseFaqConfig', () => {
  test('读上游的 snake_case 键名', () => {
    expect(parseFaqConfig('{"index_mode":"question_only","question_index_mode":"separate"}')).toEqual({
      indexMode: 'question_only',
      questionIndexMode: 'separate',
    });
  });

  test('缺字段 / 空 / 坏 JSON 都回落上游后端默认值', () => {
    // 上游后端默认是 question_answer + combined（EnsureDefaults :783-795）。
    // 注意 Vue 编辑器给的是另一套默认（question_only + separate），我们跟后端。
    expect(DEFAULT_FAQ_CONFIG).toEqual({
      indexMode: 'question_answer',
      questionIndexMode: 'combined',
    });
    expect(parseFaqConfig(null)).toEqual(DEFAULT_FAQ_CONFIG);
    expect(parseFaqConfig('')).toEqual(DEFAULT_FAQ_CONFIG);
    expect(parseFaqConfig('{ not json')).toEqual(DEFAULT_FAQ_CONFIG);
    expect(parseFaqConfig('{}')).toEqual(DEFAULT_FAQ_CONFIG);
  });
});

describe('parseFaqMetadata', () => {
  test('解析并清理', () => {
    const meta = parseFaqMetadata(
      JSON.stringify({ standard_question: ' Q ', similar_questions: ['a', 'a'], version: 3 }),
    );
    expect(meta).toEqual({ standard_question: 'Q', similar_questions: ['a'], version: 3 });
  });

  test('没有 standard_question 的对象视为解析失败', () => {
    expect(parseFaqMetadata('{"foo":"bar"}')).toBeNull();
    expect(parseFaqMetadata('null')).toBeNull();
    expect(parseFaqMetadata('')).toBeNull();
    expect(parseFaqMetadata(undefined)).toBeNull();
  });
});

describe('buildFaqChunkContent — 存下来给人看的那份', () => {
  const meta: FaqMetadata = {
    standard_question: '什么是RAG',
    similar_questions: ['RAG是什么', '检索增强生成是什么'],
    negative_questions: ['RAG怎么安装'],
    answers: ['检索增强生成'],
  };

  test('question_answer：问题 + Similar Questions + Answers', () => {
    expect(buildFaqChunkContent(meta, 'question_answer')).toBe(
      'Q: 什么是RAG\n' +
        'Similar Questions:\n' +
        '- RAG是什么\n' +
        '- 检索增强生成是什么\n' +
        'Answers:\n' +
        '- 检索增强生成\n',
    );
  });

  test('question_only：不含 Answers 段', () => {
    const content = buildFaqChunkContent(meta, 'question_only');
    expect(content).toContain('Similar Questions:');
    expect(content).not.toContain('Answers:');
  });

  // 上游注释原文："负例不应该包含在 Content 中，因为它们不应该被索引"。
  test('负向问题永远不进 content', () => {
    expect(buildFaqChunkContent(meta, 'question_answer')).not.toContain('RAG怎么安装');
  });
});

describe('buildFaqIndexTexts — 真正拿去算向量的那些文本', () => {
  const meta: FaqMetadata = {
    standard_question: '什么是RAG',
    similar_questions: ['RAG是什么', '检索增强生成是什么'],
    answers: ['检索增强生成'],
  };

  test('combined：只有 1 条，用换行连接，不带 Q:/- 前缀', () => {
    const texts = buildFaqIndexTexts(meta, 'question_answer', 'combined');
    expect(texts).toEqual(['什么是RAG\nRAG是什么\n检索增强生成是什么\n检索增强生成']);
  });

  test('question_only + combined：不拼答案', () => {
    expect(buildFaqIndexTexts(meta, 'question_only', 'combined')).toEqual([
      '什么是RAG\nRAG是什么\n检索增强生成是什么',
    ]);
  });

  test('separate：1 + N 条，标准问与每个相似问各一条', () => {
    const texts = buildFaqIndexTexts(meta, 'question_only', 'separate');
    expect(texts).toEqual(['什么是RAG', 'RAG是什么', '检索增强生成是什么']);
  });

  test('separate + question_answer：每条问题各自拼上答案', () => {
    expect(buildFaqIndexTexts(meta, 'question_answer', 'separate')).toEqual([
      '什么是RAG\n检索增强生成',
      'RAG是什么\n检索增强生成',
      '检索增强生成是什么\n检索增强生成',
    ]);
  });

  test('没有相似问时 separate 也只剩 1 条', () => {
    const solo: FaqMetadata = { standard_question: '什么是RAG' };
    expect(buildFaqIndexTexts(solo, 'question_answer', 'separate')).toEqual(['什么是RAG']);
  });

  test('负向问题不进索引文本（与 content 同一条规则）', () => {
    const withNegative: FaqMetadata = {
      standard_question: '什么是RAG',
      negative_questions: ['RAG怎么安装'],
    };
    for (const mode of ['combined', 'separate'] as const) {
      expect(buildFaqIndexTexts(withNegative, 'question_answer', mode).join('\n')).not.toContain(
        'RAG怎么安装',
      );
    }
  });
});

describe('faqVariantSourceId', () => {
  test('第 0 条用 chunk id 本身，其余按下标加后缀', () => {
    expect(faqVariantSourceId('c1', 0)).toBe('c1');
    expect(faqVariantSourceId('c1', 1)).toBe('c1-1');
    expect(faqVariantSourceId('c1', 2)).toBe('c1-2');
  });
});

describe('calculateFaqContentHash', () => {
  const base: FaqMetadata = {
    standard_question: '什么是RAG',
    similar_questions: ['RAG是什么'],
    negative_questions: ['RAG怎么安装'],
    answers: ['检索增强生成'],
  };

  test('与列表顺序无关（比较前会排序）', () => {
    const a = calculateFaqContentHash({ ...base, similar_questions: ['x', 'y'] });
    const b = calculateFaqContentHash({ ...base, similar_questions: ['y', 'x'] });
    expect(a).toBe(b);
  });

  test('问题先归一化，故首尾标点与大小写不影响指纹', () => {
    expect(calculateFaqContentHash({ standard_question: '什么是RAG' })).toBe(
      calculateFaqContentHash({ standard_question: '  什么是ＲＡＧ？  ' }),
    );
  });

  test('标准问不同 → 指纹不同', () => {
    expect(calculateFaqContentHash({ standard_question: 'A' })).not.toBe(
      calculateFaqContentHash({ standard_question: 'B' }),
    );
  });

  test('答案不归一化，只去空白——所以大小写不同即指纹不同', () => {
    expect(calculateFaqContentHash({ standard_question: 'Q', answers: ['RAG'] })).not.toBe(
      calculateFaqContentHash({ standard_question: 'Q', answers: ['rag'] }),
    );
  });

  test('是 64 位十六进制 SHA-256', () => {
    expect(calculateFaqContentHash(base)).toMatch(/^[0-9a-f]{64}$/);
  });
});

describe('matchesNegativeQuestions', () => {
  const negatives = ['RAG怎么安装', ' 如何部署 RAG '];

  test('精确相等命中，忽略大小写与首尾空白', () => {
    expect(matchesNegativeQuestions('RAG怎么安装', negatives)).toBe(true);
    expect(matchesNegativeQuestions('  如何部署 RAG  ', negatives)).toBe(true);
    expect(matchesNegativeQuestions('如何部署 rag', negatives)).toBe(true);
  });

  // 上游是 == 比较，不是 contains。子串不该被否决。
  test('子串不命中', () => {
    expect(matchesNegativeQuestions('请问RAG怎么安装呢', negatives)).toBe(false);
    expect(matchesNegativeQuestions('如何部署', negatives)).toBe(false);
  });

  test('空负例列表与空串都不命中', () => {
    expect(matchesNegativeQuestions('随便', [])).toBe(false);
    expect(matchesNegativeQuestions('随便', undefined)).toBe(false);
    expect(matchesNegativeQuestions('随便', ['', '  '])).toBe(false);
  });

  // 上游这里刻意不调 NormalizeQuestion，所以标点仍参与比较。
  test('不做归一化：带标点的查询不会命中不带标点的负例', () => {
    expect(matchesNegativeQuestions('RAG怎么安装？', negatives)).toBe(false);
    expect(matchesNegativeQuestions('RAG怎么安装？', ['RAG怎么安装？'])).toBe(true);
  });
});
