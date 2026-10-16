/**
 * 父子分块（parent-child）测试。
 *
 * 锁住三条与直觉相反的 WeKnora 语义：
 *   1. 父块 chunkType='parent_text'，不参与 embedding
 *   2. 父行只在"真分裂"时创建，短文档不得产生冗余父行
 *   3. 面包屑进 headingPath，**不进 content**——否则破坏
 *      `text.slice(startAt, endAt) === content` 这个引用可核验的不变式
 */
import { describe, expect, it } from 'vitest';
import {
  chunkParentChild,
  chunkText,
  DEFAULT_CHILD_CONFIG,
  DEFAULT_PARENT_CONFIG,
  type Chunk,
} from '../../src/kb/chunker.js';

/** 生成 markdown 文档：每个 section 足够长，保证父块会被真分裂。 */
function makeDoc(sections: number, bodySize = 900): string {
  const parts: string[] = ['# 运维手册', ''];
  for (let i = 1; i <= sections; i++) {
    parts.push(`## 第 ${i} 节 主题${i}`, '');
    parts.push(`正文${i}：${'内容'.repeat(bodySize / 2)}。`, '');
  }
  return parts.join('\n');
}

/** 全文逐块断言核心不变式。 */
function assertOffsets(text: string, chunks: Chunk[]): void {
  for (const c of chunks) {
    expect(text.slice(c.startAt, c.endAt)).toBe(c.content);
  }
}

describe('chunkParentChild', () => {
  it('空输入与纯空白输入返回空数组', () => {
    expect(chunkParentChild('')).toEqual([]);
    expect(chunkParentChild('   \n\n \t ')).toEqual([]);
  });

  it('保持核心不变式：全文逐块 text.slice(startAt,endAt) === content', () => {
    const text = makeDoc(12);
    const chunks = chunkParentChild(text, { parent: { strategy: 'heading' }, child: { strategy: 'heading' } });
    expect(chunks.length).toBeGreaterThan(3);
    assertOffsets(text, chunks);
  });

  it('父块标记为 parent_text，子块标记为 text', () => {
    const text = makeDoc(12);
    const chunks = chunkParentChild(text, { parent: { strategy: 'heading' }, child: { strategy: 'heading' } });

    const parents = chunks.filter((c) => c.chunkType === 'parent_text');
    expect(parents.length).toBeGreaterThan(0);
    // 非父块即子块
    for (const c of chunks) {
      expect(c.chunkType === 'text' || c.chunkType === 'parent_text').toBe(true);
    }
    // 父块自身没有父块
    for (const p of parents) expect(p.parentIndex).toBe(-1);
  });

  it('短文档不产生父行（未发生真分裂）', () => {
    const text = '# 标题\n\n很短的一段正文。\n';
    const chunks = chunkParentChild(text);
    expect(chunks).toHaveLength(1);
    expect(chunks[0].chunkType).toBe('text');
    expect(chunks[0].parentIndex).toBe(-1);
  });

  it('子块的 parentIndex 指向真实存在的父行，且子块区间落在父块区间内', () => {
    const text = makeDoc(12);
    const chunks = chunkParentChild(text, { parent: { strategy: 'heading' }, child: { strategy: 'heading' } });

    const children = chunks.filter((c) => c.parentIndex >= 0);
    expect(children.length).toBeGreaterThan(0);

    for (const child of children) {
      const parent = chunks[child.parentIndex];
      expect(parent).toBeDefined();
      expect(parent.chunkType).toBe('parent_text');
      expect(child.startAt).toBeGreaterThanOrEqual(parent.startAt);
      expect(child.endAt).toBeLessThanOrEqual(parent.endAt);
    }
  });

  it('每个真分裂的父块都有自己的子块，且子块覆盖父块全部内容', () => {
    const text = makeDoc(12);
    const chunks = chunkParentChild(text, { parent: { strategy: 'heading' }, child: { strategy: 'heading' } });

    const parents = chunks.filter((c) => c.chunkType === 'parent_text');
    for (let i = 0; i < chunks.length; i++) {
      if (chunks[i].chunkType !== 'parent_text') continue;
      const kids = chunks.filter((c) => c.parentIndex === i);
      expect(kids.length).toBeGreaterThan(0);

      // 子块必须完整覆盖父块区间。父子起点允许有偏差，但**偏差只能落在空白上**：
      // 父块起点取自段落切分（保留标题后的那个 \n），子块起点取自句子切分（跳过 \n）。
      // 这里刻意断言缺口是空白而非直接判等，以免把"真的漏了内容"也一起放过。
      const first = kids[0];
      const last = kids[kids.length - 1];
      expect(text.slice(chunks[i].startAt, first.startAt).trim()).toBe('');
      expect(text.slice(last.endAt, chunks[i].endAt).trim()).toBe('');
    }
    expect(parents.length).toBeGreaterThan(0);
  });

  it('子块偏移是全文绝对坐标，不是相对父块的偏移', () => {
    const text = makeDoc(12);
    const chunks = chunkParentChild(text, { parent: { strategy: 'heading' }, child: { strategy: 'heading' } });
    const children = chunks.filter((c) => c.chunkType === 'text');

    // 后段文档的子块偏移必须显著大于 0，否则说明偏移没有平移回全文坐标
    const lastChild = children[children.length - 1];
    expect(lastChild.startAt).toBeGreaterThan(DEFAULT_PARENT_CONFIG.chunkSize / 2);
    assertOffsets(text, chunks);
  });

  it('面包屑进 headingPath，但不进 content', () => {
    const text = makeDoc(6);
    const chunks = chunkParentChild(text, { parent: { strategy: 'heading' }, child: { strategy: 'heading' } });

    const withBreadcrumb = chunks.filter((c) => c.chunkType === 'text' && c.headingPath);
    expect(withBreadcrumb.length).toBeGreaterThan(0);

    for (const c of withBreadcrumb) {
      // 面包屑里的分隔符不应出现在 content 中——content 必须是源文本的精确切片
      expect(c.content).not.toContain(' > ');
      expect(text.slice(c.startAt, c.endAt)).toBe(c.content);
    }
  });

  it('子块面包屑继承父块', () => {
    const text = makeDoc(6);
    const chunks = chunkParentChild(text, { parent: { strategy: 'heading' }, child: { strategy: 'heading' } });

    for (const child of chunks.filter((c) => c.parentIndex >= 0)) {
      const parent = chunks[child.parentIndex];
      if (parent.headingPath && child.headingPath) {
        // 父块面包屑是子块面包屑的前缀（合并语义）
        expect(child.headingPath.startsWith(parent.headingPath.split(' > ')[0])).toBe(true);
      }
    }
  });

  it('子块尺寸默认 384，父块默认 4096', () => {
    expect(DEFAULT_CHILD_CONFIG.chunkSize).toBe(384);
    expect(DEFAULT_CHILD_CONFIG.chunkOverlap).toBe(76);
    expect(DEFAULT_PARENT_CONFIG.chunkSize).toBe(4096);
  });

  it('父块尺寸显著大于子块尺寸', () => {
    const text = makeDoc(12);
    const chunks = chunkParentChild(text, { parent: { strategy: 'heading' }, child: { strategy: 'heading' } });
    const parents = chunks.filter((c) => c.chunkType === 'parent_text');
    const children = chunks.filter((c) => c.chunkType === 'text');
    const avg = (xs: Chunk[]) => xs.reduce((n, c) => n + c.content.length, 0) / xs.length;

    expect(avg(parents)).toBeGreaterThan(avg(children));
  });

  it('index 连续且等于数组下标', () => {
    const text = makeDoc(12);
    const chunks = chunkParentChild(text);
    chunks.forEach((c, i) => expect(c.index).toBe(i));
  });
});

describe('chunkText 不回归', () => {
  it('普通分块的每个块都是 text 且无父块', () => {
    const chunks = chunkText(makeDoc(6));
    expect(chunks.length).toBeGreaterThan(0);
    for (const c of chunks) {
      expect(c.chunkType).toBe('text');
      expect(c.parentIndex).toBe(-1);
    }
  });
});
