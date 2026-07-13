import { describe, expect, test } from 'vitest';
import { optimizeMarkdownStyle } from '../src/feishu-markdown-style.js';

describe('optimizeMarkdownStyle 代码块保护', () => {
  test('代码块中的 $& / $\' / $` / $1 不被 GetSubstitution 损坏', () => {
    // shell / regex / perl 代码块中这些模式极常见。
    // 历史 bug: String.replace(str, block) 的字符串替换形式会把 $& 展开为
    // 匹配文本($& → ___CB_0___)、$' 展开为后文,导致内容重复/损坏。
    const code = [
      '```bash',
      'echo "$& $\' $` $1 $$PID"',
      "sed 's/foo/$&-bar/'",
      '```',
    ].join('\n');
    const input = `前文\n\n${code}\n\n后文`;
    const out = optimizeMarkdownStyle(input, 2);
    expect(out).toContain('echo "$& $\' $` $1 $$PID"');
    expect(out).toContain("sed 's/foo/$&-bar/'");
    // 占位符不应泄漏到输出
    expect(out).not.toContain('___CB_');
  });

  test('多个代码块均正确还原', () => {
    const input = '```js\nconst a = "$1";\n```\n\n中间\n\n```py\nx = "$&"\n```';
    const out = optimizeMarkdownStyle(input, 1);
    expect(out).toContain('const a = "$1";');
    expect(out).toContain('x = "$&"');
    expect(out).not.toContain('___CB_');
  });
});
