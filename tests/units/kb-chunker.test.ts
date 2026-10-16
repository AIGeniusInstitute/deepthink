import { describe, it, expect } from 'vitest';
import {
  chunkText,
  recommendStrategy,
  DEFAULT_CHUNK_CONFIG,
  type Chunk,
} from '../../src/kb/chunker.js';

/** Build a body of `n` characters out of numbered sentences. */
function longText(n: number): string {
  const unit = '这是一段用于测试分块的中文句子，内容本身没有实际意义。';
  let out = '';
  let i = 0;
  while (out.length < n) {
    out += `${unit}${i % 10}。`;
    i++;
  }
  return out.slice(0, n);
}

describe('chunkText — invariants', () => {
  it('returns nothing for empty or whitespace-only input', () => {
    expect(chunkText('')).toEqual([]);
    expect(chunkText('   \n\n  \t ')).toEqual([]);
  });

  it('produces ascending, non-empty offsets that cover the source', () => {
    const text = longText(20_000);
    const chunks = chunkText(text, { strategy: 'heuristic' });
    expect(chunks.length).toBeGreaterThan(0);

    for (const c of chunks) {
      expect(c.endAt).toBeGreaterThan(c.startAt);
      // The recorded span must be the literal source slice.
      expect(text.slice(c.startAt, c.endAt)).toBe(c.content);
    }
    for (let i = 1; i < chunks.length; i++) {
      expect(chunks[i].startAt).toBeLessThan(chunks[i].endAt);
      expect(chunks[i].endAt).toBeGreaterThan(chunks[i - 1].startAt);
    }
    expect(chunks[0].startAt).toBe(0);
    expect(chunks[chunks.length - 1].endAt).toBe(text.length);
  });

  it('assigns sequential index values from 0', () => {
    const chunks = chunkText(longText(5_000), { strategy: 'heuristic' });
    chunks.forEach((c: Chunk, i) => expect(c.index).toBe(i));
  });

  it('keeps every chunk near the configured size', () => {
    const text = longText(20_000);
    const cfg = { strategy: 'heuristic' as const, chunkSize: 512, chunkOverlap: 80 };
    const chunks = chunkText(text, cfg);
    // Soft bound: packing is greedy, so a chunk never exceeds size by more than
    // one indivisible unit, and overlap is re-added on top.
    const ceiling = cfg.chunkSize + cfg.chunkOverlap + 32;
    for (const c of chunks) {
      expect(c.content.length).toBeLessThanOrEqual(ceiling);
    }
  });
});

describe('chunkText — acceptance criteria', () => {
  it('AC-2.1: a 20000-char document yields at least 20 chunks', () => {
    const chunks = chunkText(longText(20_000), { strategy: 'heuristic' });
    expect(chunks.length).toBeGreaterThanOrEqual(20);
  });

  it('AC-2.4: heading strategy assigns a heading trail', () => {
    const text = [
      '# A',
      '',
      'para one',
      '',
      '## B',
      '',
      'para two',
      '',
      '### C',
      '',
      'para three',
    ].join('\n');
    const chunks = chunkText(text, { strategy: 'heading', chunkSize: 512, chunkOverlap: 0 });
    const paths = chunks.map((c) => c.headingPath);
    expect(paths).toContain('A');
    expect(paths).toContain('A > B');
    expect(paths).toContain('A > B > C');
  });

  it('AC-2.1/2.2 regression: a marker late in a long document stays addressable', () => {
    // The pre-existing defect truncated embedding input at 8000 chars, so
    // anything past that offset was unreachable by vector search. Chunking
    // must keep it as a real, addressable span.
    const head = longText(14_000);
    const marker = 'ZZMARKER9X';
    const tail = longText(5_000);
    const text = `${head}${marker}${tail}`;
    const chunks = chunkText(text, { strategy: 'heuristic' });

    const hit = chunks.find((c) => c.content.includes(marker));
    expect(hit).toBeDefined();
    expect(hit!.startAt).toBeGreaterThan(8_000);
    expect(text.slice(hit!.startAt, hit!.endAt)).toBe(hit!.content);
  });
});

describe('chunkText — strategies', () => {
  const sample = longText(4_000);

  it.each(['heading', 'heuristic', 'recursive'] as const)(
    '%s produces non-overlapping-order chunks that map to the source',
    (strategy) => {
      const chunks = chunkText(sample, { strategy });
      expect(chunks.length).toBeGreaterThan(1);
      for (const c of chunks) {
        expect(sample.slice(c.startAt, c.endAt)).toBe(c.content);
      }
    },
  );

  it('recursive falls back to a hard split rather than dropping text', () => {
    const blob = 'x'.repeat(2_000); // no separators at all
    const chunks = chunkText(blob, { strategy: 'recursive', chunkSize: 300, chunkOverlap: 0 });
    const joined = chunks.map((c) => c.content).join('');
    expect(joined).toBe(blob);
  });

  it('recommendStrategy prefers heading for heading-rich markdown', () => {
    const md = '# One\n\ntext\n\n## Two\n\ntext\n\n## Three\n\ntext';
    expect(recommendStrategy(md)).toBe('heading');
    expect(recommendStrategy(longText(2_000))).toBe('heuristic');
  });

  // ── 纯标题文档（大纲 / 思维导图）───────────────────────────
  // 回归自 docs/issues/2026-10-16-heading-chunker-empty-chunks.md：
  // section 的定义是「标题行之间的正文」，整篇只有标题时每一段都是空白，
  // 全部被跳过 → 0 块 → 入库报 "Chunking produced no chunks"。
  describe('outline documents (headings with no body at all)', () => {
    const outline = '# 项目设计\n\n# 研究设计\n## 入组标准\n### 年龄 18-75 岁\n### ECOG 评分 0-1\n## 主要终点\n### 客观缓解率 ORR';

    it('produces chunks instead of silently returning nothing', () => {
      const chunks = chunkText(outline, { strategy: 'heading' });
      expect(chunks.length).toBeGreaterThan(0);
      // 标题行本身就是内容，一个字都不能丢。
      const joined = chunks.map((c) => c.content).join('');
      for (const line of outline.split('\n').filter((l) => l.trim())) {
        expect(joined).toContain(line);
      }
    });

    it('keeps the source offsets exact so citations still resolve', () => {
      const chunks = chunkText(outline, { strategy: 'heading' });
      for (const c of chunks) {
        expect(outline.slice(c.startAt, c.endAt)).toBe(c.content);
      }
    });

    it('still carries a heading trail on the chunks it emits', () => {
      const chunks = chunkText(outline, { strategy: 'heading' });
      // 整篇 110 字符，默认 chunkSize 下会打成一块，trail 取块首那个标题。
      expect(chunks[0].headingPath).toBe('项目设计');
    });

    it('invariant: any non-blank text yields at least one chunk under every strategy', () => {
      for (const strategy of ['heading', 'heuristic', 'recursive'] as const) {
        expect(chunkText(outline, { strategy }).length).toBeGreaterThan(0);
        expect(chunkText('### 只有一个标题', { strategy }).length).toBeGreaterThan(0);
      }
    });

    it('splits a huge outline by chunkSize rather than emitting one giant chunk', () => {
      const big = Array.from({ length: 400 }, (_, i) => `## 小节 ${i}\n`).join('');
      const chunks = chunkText(big, { strategy: 'heading', chunkSize: 400, chunkOverlap: 0 });
      expect(chunks.length).toBeGreaterThan(1);
      for (const c of chunks) {
        expect(big.slice(c.startAt, c.endAt)).toBe(c.content);
      }
    });

    it('leaves documents that do have body text byte-for-byte unchanged', () => {
      // 兜底只在「原本 0 块」时生效，所以这一组必须与本 issue 修复前的输出**逐字节相同**。
      // 期望值取自 main（修复前）实跑：
      //   [["\n正文一","One",6,10],["\n正文二","One > Two",19,23],["\n正文三","One > Three",34,38]]
      const withBody = '# One\n\n正文一\n\n## Two\n\n正文二\n\n## Three\n\n正文三';
      const chunks = chunkText(withBody, { strategy: 'heading' });
      expect(chunks.map((c) => [c.content, c.headingPath, c.startAt, c.endAt])).toEqual([
        ['\n正文一', 'One', 6, 10],
        ['\n正文二', 'One > Two', 19, 23],
        ['\n正文三', 'One > Three', 34, 38],
      ]);
    });
  });
});

describe('chunkText — overlap and configuration', () => {
  it('repeats the configured overlap between adjacent chunks', () => {
    const text = longText(4_000);
    const overlap = 100;
    const chunks = chunkText(text, { strategy: 'heuristic', chunkSize: 500, chunkOverlap: overlap });
    expect(chunks.length).toBeGreaterThan(2);
    for (let i = 1; i < chunks.length; i++) {
      const prev = chunks[i - 1];
      const cur = chunks[i];
      const repeated = prev.endAt - cur.startAt;
      // Overlap is capped by the previous chunk's length and skipped when it
      // would swallow the next unit entirely.
      expect(repeated).toBeLessThanOrEqual(overlap);
    }
  });

  it('clamps a nonsensical overlap instead of hanging', () => {
    const chunks = chunkText(longText(3_000), {
      strategy: 'heuristic',
      chunkSize: 200,
      chunkOverlap: 5_000,
    });
    expect(chunks.length).toBeGreaterThan(0);
    expect(chunks[chunks.length - 1].endAt).toBe(3_000);
  });

  it('falls back to defaults for a non-positive chunkSize', () => {
    const chunks = chunkText(longText(3_000), { chunkSize: 0 });
    expect(chunks.length).toBeGreaterThan(0);
    for (const c of chunks) {
      expect(c.content.length).toBeLessThanOrEqual(
        DEFAULT_CHUNK_CONFIG.chunkSize + DEFAULT_CHUNK_CONFIG.chunkOverlap + 32,
      );
    }
  });

  it('handles a single character and a single oversized paragraph', () => {
    expect(chunkText('a')).toHaveLength(1);
    const oneParagraph = 'y'.repeat(3_000); // no blank line to split on
    const chunks = chunkText(oneParagraph, { strategy: 'heuristic', chunkSize: 512 });
    expect(chunks.length).toBeGreaterThan(1);
    expect(chunks.map((c) => c.content).join('')).toBe(oneParagraph);
  });
});
