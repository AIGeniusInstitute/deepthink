import { describe, it, expect } from 'vitest';
import { parseAction } from '../src/sandbox/browser-agent.js';

describe('parseAction (browser agent)', () => {
  it('parses canonical nested form', () => {
    const a = parseAction(
      '```json\n{"action":{"type":"navigate","url":"https://x"},"reason":"go"}\n```',
    );
    expect(a).toEqual({
      type: 'navigate',
      url: 'https://x',
      reason: 'go',
    });
  });

  it('parses flattened form: action as string + top-level fields (glm-5.2)', () => {
    // 真实回归用例：DashScope glm-5.2 把 action.type 简化为字符串 action，
    // url/reason 提到顶层。旧 parser 在此返回 null → "模型未返回可解析的 JSON 动作"。
    const a = parseAction(
      '```json\n{\n  "action": "navigate",\n  "url": "https://www.baidu.com",\n  "reason": "第一步"\n}\n```',
    );
    expect(a).toEqual({
      type: 'navigate',
      url: 'https://www.baidu.com',
      reason: '第一步',
    });
  });

  it('parses top-level type form', () => {
    const a = parseAction('{"type":"click","x":12,"y":34}');
    expect(a).toEqual({ type: 'click', x: 12, y: 34 });
  });

  it('parses click with flattened coordinates', () => {
    const a = parseAction('{"action":"click","x":100,"y":200}');
    expect(a).toEqual({ type: 'click', x: 100, y: 200 });
  });

  it('parses done/failed', () => {
    expect(parseAction('{"action":"done"}')).toEqual({ type: 'done' });
    expect(parseAction('{"action":{"type":"failed","reason":"x"}}')).toEqual({
      type: 'failed',
      reason: 'x',
    });
  });

  it('returns null on empty / unparseable', () => {
    expect(parseAction(null)).toBeNull();
    expect(parseAction('')).toBeNull();
    expect(parseAction('not json at all')).toBeNull();
    expect(parseAction('{"thought":"no action"}')).toBeNull();
  });
});
