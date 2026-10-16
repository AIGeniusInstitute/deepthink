// Doc2Query 纯逻辑：配置夹取、输出解析、SourceID 规则、提示词渲染、合格判定。
//
// 这一层刻意不含 DB 与网络，编排侧的行为在 kb-doc2query-flow.test.ts 里验证。
// 断言的依据都来自 WeKnora v0.8.3 的对应实现，行号见 src/kb/doc2query.ts 模块头。
//
// 有三条看着像"实现细节"、其实是契约的东西，写在这里免得后人"顺手修好"：
//   1. 输出解析的长度门槛是**字节数** `> 5`，不是字符数；
//   2. 输出解析**不去重**；
//   3. 未提供的占位符保留字面量，而不是替换成空串。

import { describe, it, expect } from 'vitest';
import {
  DEFAULT_QUESTION_COUNT,
  MAX_QUESTION_COUNT,
  MAX_CUSTOM_INSTRUCTIONS_LENGTH,
  clampQuestionCount,
  parseQuestionGenerationConfig,
  serializeQuestionGenerationConfig,
  buildQuestionIndexContent,
  generatedQuestionSourceId,
  parseGeneratedQuestions,
  buildSurroundingContext,
  appendCustomInstructions,
  languageName,
  buildQuestionPrompt,
  hasExtractableText,
  isQuestionGenerationEligible,
  makeQuestionId,
  buildGeneratedQuestionsMetadata,
  areQuestionsCurrent,
} from '../../src/kb/doc2query.js';

describe('clampQuestionCount', () => {
  it('<=0 一律当默认值 3，>10 一律压到 10', () => {
    expect(clampQuestionCount(0)).toBe(DEFAULT_QUESTION_COUNT);
    expect(clampQuestionCount(-5)).toBe(DEFAULT_QUESTION_COUNT);
    expect(clampQuestionCount(3)).toBe(3);
    expect(clampQuestionCount(10)).toBe(MAX_QUESTION_COUNT);
    expect(clampQuestionCount(11)).toBe(MAX_QUESTION_COUNT);
    expect(clampQuestionCount(9999)).toBe(MAX_QUESTION_COUNT);
  });

  it('非数字与小数：取整后再夹，取不到就当 0 走默认值', () => {
    expect(clampQuestionCount(3.7)).toBe(3);
    expect(clampQuestionCount(0.9)).toBe(DEFAULT_QUESTION_COUNT);
    expect(clampQuestionCount('5')).toBe(DEFAULT_QUESTION_COUNT);
    expect(clampQuestionCount(Number.NaN)).toBe(DEFAULT_QUESTION_COUNT);
    expect(clampQuestionCount(null)).toBe(DEFAULT_QUESTION_COUNT);
    expect(clampQuestionCount(undefined)).toBe(DEFAULT_QUESTION_COUNT);
  });
});

describe('parseQuestionGenerationConfig', () => {
  it('空值 / 非法 JSON 都退回"关着的默认配置"', () => {
    for (const raw of [null, undefined, '', 'not json', '[]', '"x"']) {
      const cfg = parseQuestionGenerationConfig(raw as string | null);
      expect(cfg).toEqual({
        enabled: false,
        questionCount: DEFAULT_QUESTION_COUNT,
        customInstructions: '',
      });
    }
  });

  it('enabled 只在严格 true 时为真，question_count 走夹取', () => {
    const cfg = parseQuestionGenerationConfig(
      JSON.stringify({ enabled: true, question_count: 99, custom_instructions: '用中文问' }),
    );
    expect(cfg.enabled).toBe(true);
    expect(cfg.questionCount).toBe(MAX_QUESTION_COUNT);
    expect(cfg.customInstructions).toBe('用中文问');

    // 上游 JSON 解出来是 bool，字符串 "true" 不该被当成真
    expect(parseQuestionGenerationConfig('{"enabled":"true"}').enabled).toBe(false);
    expect(parseQuestionGenerationConfig('{"enabled":1}').enabled).toBe(false);
  });

  it('自定义指令超长时按 rune 长度截断到 4000', () => {
    const long = '中'.repeat(MAX_CUSTOM_INSTRUCTIONS_LENGTH + 500);
    const cfg = parseQuestionGenerationConfig(
      JSON.stringify({ enabled: true, custom_instructions: long }),
    );
    expect([...cfg.customInstructions]).toHaveLength(MAX_CUSTOM_INSTRUCTIONS_LENGTH);
  });

  it('序列化再解析是幂等的，且空指令不落键', () => {
    const cfg = { enabled: true, questionCount: 7, customInstructions: '' };
    const json = serializeQuestionGenerationConfig(cfg);
    expect(json).not.toContain('custom_instructions');
    expect(parseQuestionGenerationConfig(json)).toEqual(cfg);
  });
});

describe('parseGeneratedQuestions', () => {
  it('剥掉行首序号与项目符号，逐行一条', () => {
    const out = parseGeneratedQuestions(
      ['1. 什么是 RAG 检索增强生成', '2. 向量数据库如何选型', '- 混合检索怎么融合打分'].join('\n'),
      10,
    );
    expect(out).toEqual(['什么是 RAG 检索增强生成', '向量数据库如何选型', '混合检索怎么融合打分']);
  });

  it('空行跳过，且长度门槛是字节数不是字符数', () => {
    // "What?" 恰好 5 字节，被丢掉；中文"如何做"9 字节，留下
    const out = parseGeneratedQuestions(['', '   ', 'What?', '如何做', 'ok'].join('\n'), 10);
    expect(out).toEqual(['如何做']);
  });

  it('不去重：模型给两条一样的就存两条', () => {
    const out = parseGeneratedQuestions(
      ['向量检索是怎么工作的', '向量检索是怎么工作的'].join('\n'),
      10,
    );
    expect(out).toHaveLength(2);
    expect(out[0]).toBe(out[1]);
  });

  it('数量上限按 questionCount 截断', () => {
    const lines = ['第一条问题内容', '第二条问题内容', '第三条问题内容', '第四条问题内容'];
    expect(parseGeneratedQuestions(lines.join('\n'), 2)).toEqual([
      '第一条问题内容',
      '第二条问题内容',
    ]);
    expect(parseGeneratedQuestions(lines.join('\n'), 10)).toHaveLength(4);
  });

  it('空响应产出空数组，不抛错', () => {
    expect(parseGeneratedQuestions('', 3)).toEqual([]);
  });
});

describe('generatedQuestionSourceId', () => {
  it('总长不超过 64 时用 chunkID-questionID 原样拼接', () => {
    expect(generatedQuestionSourceId('chunk1', 'q123')).toBe('chunk1-q123');
    // 边界：拼起来正好 64 → 仍然原样
    const chunkId = 'c'.repeat(61);
    const candidate = `${chunkId}-q1`;
    expect(candidate).toHaveLength(64);
    expect(generatedQuestionSourceId(chunkId, 'q1')).toBe(candidate);
  });

  it('超过 64 时只哈希 questionID：保留 chunkID，前缀换 -q，后缀 24 位十六进制', () => {
    const chunkId = 'c'.repeat(61);
    const id = generatedQuestionSourceId(chunkId, 'q1234567890');
    expect(id.startsWith(`${chunkId}-q`)).toBe(true);
    expect(id).toHaveLength(61 + 2 + 24);
    expect(id.slice(63)).toMatch(/^[0-9a-f]{24}$/);
    // 同一个 questionID 必然得到同一个 id，否则删除与重建索引会对不上
    expect(generatedQuestionSourceId(chunkId, 'q1234567890')).toBe(id);
    expect(generatedQuestionSourceId(chunkId, 'q1234567891')).not.toBe(id);
  });
});

describe('buildQuestionIndexContent', () => {
  it('标题去空白后拼在正文前，空标题则不拼', () => {
    expect(buildQuestionIndexContent('手册.md', '什么是 RAG')).toBe('手册.md\n什么是 RAG');
    expect(buildQuestionIndexContent('  手册.md  ', '什么是 RAG')).toBe('手册.md\n什么是 RAG');
    expect(buildQuestionIndexContent('', '什么是 RAG')).toBe('什么是 RAG');
    expect(buildQuestionIndexContent(null, '什么是 RAG')).toBe('什么是 RAG');
  });
});

describe('buildSurroundingContext', () => {
  it('没有相邻分块时整段是空串，不是空标签', () => {
    expect(buildSurroundingContext(null, null)).toBe('');
    expect(buildSurroundingContext('  ', undefined)).toBe('');
  });

  it('只有一侧时只出那一侧', () => {
    const prevOnly = buildSurroundingContext('上文', null);
    expect(prevOnly).toContain('<preceding_content>\n上文\n\n</preceding_content>');
    expect(prevOnly).not.toContain('following_content');

    const nextOnly = buildSurroundingContext(null, '下文');
    expect(nextOnly).toContain('<following_content>\n下文\n\n</following_content>');
    expect(nextOnly).not.toContain('preceding_content');
  });

  it('两侧都有时同段交给模型', () => {
    const both = buildSurroundingContext('上文', '下文');
    expect(both).toContain('<surrounding_context>');
    expect(both).toContain('</surrounding_context>');
    expect(both.indexOf('preceding_content')).toBeLessThan(both.indexOf('following_content'));
  });
});

describe('appendCustomInstructions', () => {
  it('空指令原样返回，不留下空标签', () => {
    expect(appendCustomInstructions('PROMPT', '')).toBe('PROMPT');
    expect(appendCustomInstructions('PROMPT', '   ')).toBe('PROMPT');
    expect(appendCustomInstructions('PROMPT', undefined)).toBe('PROMPT');
  });

  it('非空指令包进具名标签，并追加固定的优先级说明', () => {
    const out = appendCustomInstructions('PROMPT', '只问性能相关的问题');
    expect(out).toContain('<question_generation_business_instructions>\n只问性能相关的问题\n</question_generation_business_instructions>');
    expect(out).toContain(
      'Follow the business instructions above when they do not conflict with the core requirements.',
    );
  });
});

describe('languageName', () => {
  it('常见 locale 给自然语言名，未知 locale 原样返回', () => {
    expect(languageName('zh-CN')).toBe('Chinese (Simplified)');
    expect(languageName('en')).toBe('English');
    expect(languageName('ja')).toBe('Japanese');
    expect(languageName('pt-BR')).toBe('pt-BR');
    expect(languageName(null)).toBe('Chinese (Simplified)');
  });
});

describe('buildQuestionPrompt', () => {
  const base = { docName: '手册.md', content: '正文内容', questionCount: 3 };

  it('五个占位符全部被替换，不留字面量', () => {
    const prompt = buildQuestionPrompt({ ...base, prevContent: '上文', nextContent: '下文' });
    expect(prompt).not.toContain('{{context}}');
    expect(prompt).not.toContain('{{question_count}}');
    expect(prompt).not.toContain('{{content}}');
    expect(prompt).not.toContain('{{doc_name}}');
    expect(prompt).not.toContain('{{language}}');
    expect(prompt).toContain('Document name: 手册.md');
    expect(prompt).toContain('正文内容');
    expect(prompt).toContain('Generate 3 questions, one per line');
    expect(prompt).toContain('Generate questions in Chinese (Simplified)');
  });

  it('正文里的 $& / $\' 不被当成反向引用展开', () => {
    // 字符串形式的 replacement 会把 $& 展开成匹配到的占位符本身，正文就被改坏了
    const nasty = '价格是 $& 元，引用 $\' 后面那段';
    const prompt = buildQuestionPrompt({ ...base, content: nasty });
    expect(prompt).toContain(nasty);
    expect(prompt).not.toContain('{{content}} 元');
  });

  it('没有相邻分块时 surrounding_context 段整段消失', () => {
    // 注意：模板正文里本来就有 "surrounding_context" 这个词（那句说明），
    // 所以断言不能拿它当标志，要看具体的内容标签。
    const prompt = buildQuestionPrompt(base);
    expect(prompt).not.toContain('<preceding_content>');
    expect(prompt).not.toContain('<following_content>');
    expect(prompt).toContain('<main_content>');
  });

  it('question_count 走夹取，越界不会原样写进提示词', () => {
    expect(buildQuestionPrompt({ ...base, questionCount: 50 })).toContain('Generate 10 questions');
    expect(buildQuestionPrompt({ ...base, questionCount: 0 })).toContain('Generate 3 questions');
  });

  it('自定义指令拼在末尾', () => {
    const prompt = buildQuestionPrompt({ ...base, customInstructions: '问题里必须带模块名' });
    expect(prompt).toContain('问题里必须带模块名');
    expect(prompt.trimEnd().endsWith('requirements.')).toBe(true);
  });
});

describe('hasExtractableText', () => {
  it('纯图片占位的分块没有可问的文字', () => {
    expect(hasExtractableText('![图](a.png)')).toBe(false);
    expect(hasExtractableText('<image>base64...</image>')).toBe(false);
    expect(hasExtractableText('  ![图](a.png)\n<image>x</image>  ')).toBe(false);
    expect(hasExtractableText('')).toBe(false);
  });

  it('图文混排有真文字就算合格', () => {
    expect(hasExtractableText('![图](a.png)\n这段有字')).toBe(true);
    expect(hasExtractableText('<image>x</image>说明文字')).toBe(true);
  });
});

describe('isQuestionGenerationEligible', () => {
  const text = { chunk_type: 'text', content: '有内容的正文', is_enabled: 1 };

  it('只有启用的 text 型分块参与', () => {
    expect(isQuestionGenerationEligible(text)).toBe(true);
  });

  it('父块与 FAQ 条目不参与（上游按 ChunkType 过滤，不是按库类型）', () => {
    expect(isQuestionGenerationEligible({ ...text, chunk_type: 'parent_text' })).toBe(false);
    expect(isQuestionGenerationEligible({ ...text, chunk_type: 'faq' })).toBe(false);
    expect(isQuestionGenerationEligible({ ...text, chunk_type: 'image_ocr' })).toBe(false);
  });

  it('被停用的分块不参与', () => {
    expect(isQuestionGenerationEligible({ ...text, is_enabled: 0 })).toBe(false);
    expect(isQuestionGenerationEligible({ ...text, is_enabled: false })).toBe(false);
  });

  it('图片占位分块不参与', () => {
    expect(isQuestionGenerationEligible({ ...text, content: '![图](a.png)' })).toBe(false);
    expect(isQuestionGenerationEligible({ ...text, content: null })).toBe(false);
  });
});

describe('生成问题的元数据与时效判定', () => {
  it('问题 id 是 q + 纳秒时间戳 + 序号，同批内递增不重复', () => {
    const ids = [0, 1, 2].map((j) => makeQuestionId(1_700_000_000_000_000_000, j));
    expect(ids).toEqual(['q1700000000000000000', 'q1700000000000000001', 'q1700000000000000002']);
  });

  it('元数据整体替换：带上生成时的 revision', () => {
    const meta = buildGeneratedQuestionsMetadata(['问题一内容', '问题二内容'], 4, 1_000);
    expect(meta.generated_questions_revision).toBe(4);
    expect(meta.generated_questions.map((q) => q.contentRevision)).toEqual([4, 4]);
    expect(meta.generated_questions.map((q) => q.question)).toEqual(['问题一内容', '问题二内容']);
  });

  it('revision 对得上才算新鲜', () => {
    const meta = buildGeneratedQuestionsMetadata(['问题一内容'], 4, 1_000);
    expect(areQuestionsCurrent(meta, 4)).toBe(true);
    expect(areQuestionsCurrent(meta, 5)).toBe(false);
  });

  it('没有问题时一律算过期，空 metadata 不抛错', () => {
    expect(areQuestionsCurrent(null, 1)).toBe(false);
    expect(areQuestionsCurrent({ generated_questions: [] }, 1)).toBe(false);
  });

  it('单条没记 revision 时回落到整块的 revision', () => {
    const meta = {
      generated_questions: [{ id: 'q1', question: '问题一内容' }],
      generated_questions_revision: 7,
    };
    expect(areQuestionsCurrent(meta, 7)).toBe(true);
    expect(areQuestionsCurrent(meta, 8)).toBe(false);
  });
});
