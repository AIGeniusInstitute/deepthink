// 查询理解（改写 + 意图分类）的纯函数层与 LLM 调用层。
//
// 规格来源：WeKnora internal/application/service/chat_pipeline/query_understand.go
// + config/prompt_templates/rewrite.yaml + config/prompt_templates/intent_prompts.yaml。
//
// 本文件里有一条故意断言"和上游不一样"的用例（品牌名）和一条断言"上游有而我们
// 没有"的用例（Task 3 图片路径）。两者都是显式偏离，见模块头注释。

import { afterEach, describe, expect, test, vi } from 'vitest';
import {
  ALL_INTENTS,
  normalizeQueryIntent,
  needsKbRetrieval,
  needsRetrieval,
  parseQueryUnderstanding,
  buildRewriteUserPrompt,
  formatConversationHistory,
  intentSystemPrompt,
  understandQuery,
  REWRITE_SYSTEM_PROMPT,
} from '../../src/kb/query-understand.js';

describe('normalizeQueryIntent', () => {
  test('九个标签全部识别', () => {
    expect(ALL_INTENTS).toHaveLength(9);
    for (const intent of ALL_INTENTS) {
      expect(normalizeQueryIntent(intent)).toBe(intent);
    }
  });

  test('大小写与分隔符被宽容处理', () => {
    expect(normalizeQueryIntent('KB-Search')).toBe('kb_search');
    expect(normalizeQueryIntent('  KB_SEARCH  ')).toBe('kb_search');
    expect(normalizeQueryIntent('Web Search')).toBe('web_search');
  });

  // 上游注释点名的历史事故：把标签原样取用会让任何意外值变成"不检索"，
  // 于是答案在既没查知识库、也没报错的情况下生成出来。
  test('未知标签归为空意图（空意图要检索），不是"不检索"', () => {
    expect(normalizeQueryIntent('unknown_label')).toBe('');
    expect(normalizeQueryIntent('')).toBe('');
    expect(normalizeQueryIntent(undefined)).toBe('');
    expect(needsKbRetrieval('')).toBe(true);
  });
});

describe('needsKbRetrieval / needsRetrieval', () => {
  test('只有 kb_search、clarification 和空意图需要查库', () => {
    expect(needsKbRetrieval('kb_search')).toBe(true);
    expect(needsKbRetrieval('clarification')).toBe(true);
    expect(needsKbRetrieval('')).toBe(true);
    for (const intent of ['greeting', 'chitchat', 'follow_up', 'summarize', 'image_only', 'doc_only'] as const) {
      expect(needsKbRetrieval(intent)).toBe(false);
    }
    // web_search 不在 NeedsKBRetrieval 里，由 NeedsRetrieval 结合开关判断
    expect(needsKbRetrieval('web_search')).toBe(false);
  });

  test('web_search 是否检索取决于 web 检索开关', () => {
    expect(needsRetrieval('web_search', false)).toBe(false);
    expect(needsRetrieval('web_search', true)).toBe(true);
    // 其它意图不受该开关影响
    expect(needsRetrieval('kb_search', false)).toBe(true);
    expect(needsRetrieval('greeting', true)).toBe(false);
  });
});

describe('parseQueryUnderstanding', () => {
  test('严格 JSON', () => {
    expect(parseQueryUnderstanding('{"rewrite_query":"你好","intent":"greeting"}')).toEqual({
      rewriteQuery: '你好',
      intent: 'greeting',
    });
  });

  test('字段别名与意图归一化', () => {
    expect(parseQueryUnderstanding('{"rewritten_query":"a","intent":"KB-Search"}')).toEqual({
      rewriteQuery: 'a',
      intent: 'kb_search',
    });
    expect(parseQueryUnderstanding('{"question":"b","intent":"kb_search"}')).toEqual({
      rewriteQuery: 'b',
      intent: 'kb_search',
    });
  });

  test('容忍 markdown 包裹与前后废话', () => {
    const raw = '好的，结果如下：\n```json\n{"rewrite_query":"x","intent":"greeting"}\n```\n以上。';
    expect(parseQueryUnderstanding(raw)).toEqual({ rewriteQuery: 'x', intent: 'greeting' });
  });

  // 被 token 上限截断的回复不是合法 JSON，但截断前写好的字段仍然可用。
  // 截断在第几个字段里，那个字段就必须丢掉——半截的改写会把用户完整的问题换掉。
  test('截断回复的抢救：完整字段保留，被截断的字段丢弃', () => {
    const truncated = '{"rewrite_query":"RAG架构和传统搜索有什么区别","intent":"kb_se';
    expect(parseQueryUnderstanding(truncated)).toEqual({
      rewriteQuery: 'RAG架构和传统搜索有什么区别',
      intent: '',
    });
  });

  test('完全无法解析时返回 null（调用方保持原问题并检索）', () => {
    expect(parseQueryUnderstanding('完全不是 JSON')).toBeNull();
    expect(parseQueryUnderstanding('')).toBeNull();
    expect(parseQueryUnderstanding('   ')).toBeNull();
  });

  test('空对象解析为空字段，空意图仍会检索', () => {
    const parsed = parseQueryUnderstanding('{}');
    expect(parsed).toEqual({ rewriteQuery: '', intent: '' });
    expect(needsKbRetrieval(parsed!.intent)).toBe(true);
  });
});

describe('formatConversationHistory', () => {
  test('与上游同格式，一问一答成对', () => {
    expect(
      formatConversationHistory([
        { role: 'user', content: '什么是RAG' },
        { role: 'assistant', content: 'RAG是检索增强生成' },
      ]),
    ).toBe('------BEGIN------\nUser question: 什么是RAG\nAssistant answer: RAG是检索增强生成\n------END------\n');
  });

  test('无历史时为空串', () => {
    expect(formatConversationHistory([])).toBe('');
  });
});

describe('提示词', () => {
  test('改写提示词含九类意图与"拿不准就 kb_search"的兜底', () => {
    expect(REWRITE_SYSTEM_PROMPT).toContain('Default: when unsure, always choose `kb_search`');
    for (const intent of ALL_INTENTS) {
      expect(REWRITE_SYSTEM_PROMPT).toContain(`\`${intent}\``);
    }
  });

  // 偏离 1：本仓库知识库问答链路不接受附件，图片路径整条去掉。
  test('不含 Task 3 图片分析（与上游的显式偏离）', () => {
    expect(REWRITE_SYSTEM_PROMPT).not.toContain('Task 3');
    expect(REWRITE_SYSTEM_PROMPT).not.toContain('image_description');
  });

  test('用户提示词带运行上下文、无附件标记与 JSON 输出段', () => {
    const prompt = buildRewriteUserPrompt({
      query: '你好',
      now: new Date('2026-10-16T00:00:00Z'),
    });
    expect(prompt).toContain('<no_image_attached />');
    expect(prompt).toContain('<no_document_attached />');
    expect(prompt).toContain('## User Question\n你好');
    expect(prompt).toContain('## JSON Output');
  });

  test('意图提示词：检索类意图没有覆盖提示词', () => {
    expect(intentSystemPrompt('greeting')).toContain('The user is greeting you');
    expect(intentSystemPrompt('follow_up')).toContain('follow-up question');
    expect(intentSystemPrompt('summarize')).toContain('summarize, organize, or distill');
    expect(intentSystemPrompt('web_search')).toContain('web search is currently not enabled');
    expect(intentSystemPrompt('kb_search')).toBeNull();
    expect(intentSystemPrompt('clarification')).toBeNull();
    expect(intentSystemPrompt('')).toBeNull();
  });

  test('{{language}} 与 {{current_time}} 被替换', () => {
    const prompt = intentSystemPrompt('chitchat', { language: 'zh-CN', now: new Date('2026-10-16T00:00:00Z') });
    expect(prompt).toContain('Default response language: zh-CN');
    expect(prompt).toContain('Current time: 2026-10-16');
    expect(prompt).not.toContain('{{');
  });

  // ⚠️ 断言的是**差异**：上游写的是 "You are WeKnora, ... developed by Tencent"。
  // 这里是 DeepThink，照搬那句子是错的。见模块头注释。
  test('品牌名替换为 DeepThink（与上游的显式偏离）', () => {
    const prompt = intentSystemPrompt('greeting')!;
    expect(prompt).toContain('You are DeepThink');
    expect(prompt).not.toContain('WeKnora');
    expect(prompt).not.toContain('Tencent');
  });
});

// ── LLM 调用层 ──────────────────────────────────────────────

const CONFIG = { baseUrl: 'https://example.test/v1', apiKey: 'k', model: 'm' };

function chatResponse(content: string, status = 200): Response {
  return new Response(
    status === 200
      ? JSON.stringify({ choices: [{ message: { content } }] })
      : 'boom',
    { status, headers: { 'Content-Type': 'application/json' } },
  );
}

afterEach(() => {
  vi.unstubAllGlobals();
});

describe('understandQuery — 失败一律返回 null', () => {
  test('未配置模型时不发请求', async () => {
    const fetchMock = vi.fn();
    vi.stubGlobal('fetch', fetchMock);
    expect(await understandQuery({ question: '你好', config: null })).toBeNull();
    expect(fetchMock).not.toHaveBeenCalled();
  });

  test('disabled 时不发请求', async () => {
    const fetchMock = vi.fn();
    vi.stubGlobal('fetch', fetchMock);
    expect(await understandQuery({ question: '你好', config: CONFIG, disabled: true })).toBeNull();
    expect(fetchMock).not.toHaveBeenCalled();
  });

  test('空问题不发请求', async () => {
    const fetchMock = vi.fn();
    vi.stubGlobal('fetch', fetchMock);
    expect(await understandQuery({ question: '   ', config: CONFIG })).toBeNull();
    expect(fetchMock).not.toHaveBeenCalled();
  });

  test('非 200 → null', async () => {
    vi.stubGlobal('fetch', vi.fn(async () => chatResponse('', 500)));
    expect(await understandQuery({ question: '你好', config: CONFIG })).toBeNull();
  });

  test('抛异常 → null', async () => {
    vi.stubGlobal('fetch', vi.fn(async () => {
      throw new Error('network down');
    }));
    expect(await understandQuery({ question: '你好', config: CONFIG })).toBeNull();
  });

  test('输出无法解析 → null', async () => {
    vi.stubGlobal('fetch', vi.fn(async () => chatResponse('我不知道')));
    expect(await understandQuery({ question: '你好', config: CONFIG })).toBeNull();
  });

  test('成功时返回改写与意图，且请求参数符合上游（temperature 0.3 / max_tokens 150）', async () => {
    const fetchMock = vi.fn(async () =>
      chatResponse('{"rewrite_query":"RAG架构是什么","intent":"kb_search"}'),
    );
    vi.stubGlobal('fetch', fetchMock);

    const result = await understandQuery({
      question: '它是什么',
      history: [{ role: 'user', content: 'RAG是什么' }, { role: 'assistant', content: '...' }],
      language: 'zh-CN',
      config: CONFIG,
    });
    expect(result).toEqual({ rewriteQuery: 'RAG架构是什么', intent: 'kb_search' });

    expect(fetchMock).toHaveBeenCalledTimes(1);
    const [url, init] = fetchMock.mock.calls[0] as unknown as [string, RequestInit];
    expect(url).toBe('https://example.test/v1/chat/completions');
    const body = JSON.parse(init.body as string);
    expect(body.temperature).toBe(0.3);
    expect(body.max_tokens).toBe(150);
    expect(body.stream).toBe(false);
    expect(body.messages[0].role).toBe('system');
    expect(body.messages[0].content).toContain('Classify the intent');
    // {{language}} 已被替换为实际语言
    expect(body.messages[0].content).not.toContain('{{language}}');
    expect(body.messages[0].content).toContain('zh-CN');
    // 会话历史进的是 system 里的 {{conversation}} 占位符，user 消息只放当前问题
    expect(body.messages[0].content).toContain('User question: RAG是什么');
    expect(body.messages[1].content).toContain('它是什么');
  });
});
