/**
 * Knowledge-base chunker.
 *
 * Splits a parsed document into chunks with char-offset provenance, so a
 * retrieval hit can be traced back to an exact span of the source text.
 *
 * Mirrors the three strategies of WeKnora's internal/infrastructure/chunker
 * (heading / heuristic / recursive) and its default sizing (512 / 80).
 *
 * Sizes are measured in **characters**, not tokens: no tokenizer dependency,
 * and for CJK text one character is roughly one token anyway.
 */

export type ChunkStrategy = 'heading' | 'heuristic' | 'recursive';

/** 'text' = 普通块（参与 embedding）；'parent_text' = 父块（只用于回溯，不参与 embedding）。 */
export type ChunkType = 'text' | 'parent_text';

export interface ChunkConfig {
  strategy: ChunkStrategy;
  /** Soft upper bound for a chunk, in characters. Oversized indivisible units may exceed it. */
  chunkSize: number;
  /** Characters of the previous chunk repeated at the head of the next one. */
  chunkOverlap: number;
}

export interface Chunk {
  index: number;
  content: string;
  /** Heading trail such as "A > B"; null when the text has no heading context. */
  headingPath: string | null;
  /** Absolute start offset in the source text. */
  startAt: number;
  /** Absolute end offset in the source text (exclusive). */
  endAt: number;
  /**
   * Chunk kind. `parent_text` rows exist only to be traced back to from a hit
   * child; they are never embedded. Plain `chunkText()` output is all `text`.
   */
  chunkType: ChunkType;
  /**
   * Index of this chunk's parent in the same array, or -1 when there is none —
   * either an ordinary chunk, or a lone child whose parent was not "truly
   * split" and therefore produced no parent row.
   */
  parentIndex: number;
}

export const DEFAULT_CHUNK_CONFIG: ChunkConfig = {
  strategy: 'heuristic',
  chunkSize: 512,
  chunkOverlap: 80,
};

/** A slice of the source text, carrying its absolute offsets. */
interface Seg {
  text: string;
  start: number;
  end: number;
}

const HEADING_RE = /^(#{1,6})[ \t]+(.+?)[ \t]*$/;

/**
 * Split into paragraph-level segments, preserving absolute offsets.
 * Blank-line runs are separators and belong to no segment.
 */
function splitParagraphs(text: string): Seg[] {
  const segs: Seg[] = [];
  const re = /\n[ \t]*\n+/g;
  let cursor = 0;
  let m: RegExpExecArray | null;
  while ((m = re.exec(text)) !== null) {
    if (m.index > cursor) {
      segs.push({ text: text.slice(cursor, m.index), start: cursor, end: m.index });
    }
    cursor = m.index + m[0].length;
  }
  if (cursor < text.length) {
    segs.push({ text: text.slice(cursor), start: cursor, end: text.length });
  }
  return segs;
}

/** Split a segment further on sentence-final punctuation, preserving offsets. */
function splitSentences(seg: Seg): Seg[] {
  const out: Seg[] = [];
  const re = /[^\n。！？!?；;]+[\n。！？!?；;]+|[^\n。！？!?；;]+$/g;
  let m: RegExpExecArray | null;
  while ((m = re.exec(seg.text)) !== null) {
    if (m[0].length === 0) continue;
    out.push({
      text: m[0],
      start: seg.start + m.index,
      end: seg.start + m.index + m[0].length,
    });
  }
  // Regex missed content (e.g. a segment that is only separators) — keep it whole.
  if (out.length === 0 && seg.text.length > 0) out.push(seg);
  return out;
}

/** Last-resort hard split for a unit that alone exceeds chunkSize. */
function hardSplit(seg: Seg, chunkSize: number): Seg[] {
  const out: Seg[] = [];
  for (let i = 0; i < seg.text.length; i += chunkSize) {
    const end = Math.min(i + chunkSize, seg.text.length);
    out.push({ text: seg.text.slice(i, end), start: seg.start + i, end: seg.start + end });
  }
  return out;
}

/** Reduce a segment to pieces no larger than chunkSize. */
function explode(seg: Seg, chunkSize: number): Seg[] {
  if (seg.text.length <= chunkSize) return [seg];
  const pieces: Seg[] = [];
  for (const s of splitSentences(seg)) {
    if (s.text.length <= chunkSize) pieces.push(s);
    else pieces.push(...hardSplit(s, chunkSize));
  }
  return pieces;
}

/**
 * Greedily pack pieces into chunks, repeating the tail of each chunk at the
 * head of the next. Returned offsets remain absolute source positions: an
 * overlapped chunk simply starts earlier in the source.
 *
 * `content` is taken as `source.slice(startAt, endAt)` rather than by joining
 * the pieces. Pieces exclude the separators between them (paragraph breaks),
 * so joining would silently drop those characters and leave a chunk whose text
 * is not what its own offsets point at — which is exactly what makes a citation
 * unverifiable.
 */
function packSegments(
  pieces: Seg[],
  config: ChunkConfig,
  headingOf: (start: number) => string | null,
  source: string,
): Chunk[] {
  const { chunkSize, chunkOverlap } = config;
  const chunks: Chunk[] = [];
  let buf: Seg[] = [];

  const flush = (): void => {
    if (buf.length === 0) return;
    const startAt = buf[0].start;
    const endAt = buf[buf.length - 1].end;
    chunks.push({
      index: chunks.length,
      content: source.slice(startAt, endAt),
      headingPath: headingOf(startAt),
      startAt,
      endAt,
      chunkType: 'text',
      parentIndex: -1,
    });
    buf = [];
  };

  for (const piece of pieces) {
    const bufLen = buf.reduce((n, s) => n + s.text.length, 0);
    if (buf.length > 0 && bufLen + piece.text.length > chunkSize) {
      const prev = chunks.length > 0 ? chunks[chunks.length - 1] : null;
      flush();
      // Seed the next chunk with the previous chunk's tail so context carries
      // across the boundary. The overlap is a genuine source span, so startAt
      // moves back accordingly.
      if (chunkOverlap > 0 && prev) {
        const tail = prev.content.slice(Math.max(0, prev.content.length - chunkOverlap));
        const tailStart = prev.endAt - tail.length;
        if (tailStart >= piece.start) {
          // Tail would swallow the next piece entirely — skip overlap.
          buf.push({ text: tail, start: tailStart, end: prev.endAt });
        }
      }
    }
    buf.push(piece);
  }
  flush();

  return chunks.map((c, i) => ({ ...c, index: i }));
}

/**
 * Heading strategy: split on Markdown headings, carrying the heading trail.
 * Oversized sections fall back to paragraph packing within the section.
 */
function chunkByHeading(text: string, config: ChunkConfig): Chunk[] {
  // Collect heading positions first so every body slice knows its trail.
  const marks: Array<{ start: number; end: number; level: number; title: string }> = [];
  const lineRe = /.*(?:\n|$)/g;
  let m: RegExpExecArray | null;
  while ((m = lineRe.exec(text)) !== null) {
    if (m[0].length === 0) break;
    const raw = m[0].replace(/\n$/, '');
    const h = HEADING_RE.exec(raw);
    if (h) {
      marks.push({
        start: m.index,
        end: m.index + m[0].length,
        level: h[1].length,
        title: h[2].trim(),
      });
    }
    if (m.index + m[0].length >= text.length) break;
  }

  // Resolve each heading's trail once by running the level stack forward.
  const trails: string[] = [];
  const stack: string[] = [];
  for (const mark of marks) {
    stack.length = mark.level - 1;
    stack[mark.level - 1] = mark.title;
    trails.push(stack.filter((p) => p !== undefined && p !== '').join(' > '));
  }

  // Section bodies = text between the end of one heading line and the start of the next.
  const sections: Array<{ start: number; end: number; trail: string | null }> = [];
  if (marks.length === 0) {
    sections.push({ start: 0, end: text.length, trail: null });
  } else {
    if (marks[0].start > 0) sections.push({ start: 0, end: marks[0].start, trail: null });
    for (let i = 0; i < marks.length; i++) {
      const bodyStart = marks[i].end;
      const bodyEnd = i + 1 < marks.length ? marks[i + 1].start : text.length;
      if (bodyEnd > bodyStart) {
        sections.push({ start: bodyStart, end: bodyEnd, trail: trails[i] || null });
      }
    }
  }

  // Pack each section independently: a chunk must never straddle a heading
  // boundary, otherwise its headingPath would only describe part of it.
  const out: Chunk[] = [];
  for (const sec of sections) {
    const seg: Seg = { text: text.slice(sec.start, sec.end), start: sec.start, end: sec.end };
    if (seg.text.trim().length === 0) continue;
    const pieces: Seg[] = [];
    for (const s of splitParagraphs(seg.text)) {
      const abs: Seg = { text: s.text, start: seg.start + s.start, end: seg.start + s.end };
      pieces.push(...explode(abs, config.chunkSize));
    }
    out.push(...packSegments(pieces, config, () => sec.trail, text));
  }

  // 兜底：整篇只有标题、没有任何正文段落时，上面每个 section 的 body 都是空白，
  // 会逐段被跳过 —— 一个块都不剩，调用方只能报「Chunking produced no chunks」，
  // 把一份完全正常的文件说成坏文件。
  //
  // 这不是理论情况：xmind 解析出来的就是这个形状（层级即内容，`### 年龄 18-75 岁`
  // 本身就是那条知识），纯目录型 Markdown 同理。丢掉标题等于把整篇文档丢空。
  //
  // 注意兜底**只在原本产出 0 块时生效**：以前能切出块的文档，切法逐字节不变。
  if (out.length === 0 && marks.length > 0) {
    const trailAt = (start: number): string | null => {
      let lo = 0;
      let hi = marks.length - 1;
      let found = -1;
      while (lo <= hi) {
        const mid = (lo + hi) >> 1;
        if (marks[mid].start <= start) {
          found = mid;
          lo = mid + 1;
        } else {
          hi = mid - 1;
        }
      }
      return found >= 0 ? trails[found] || null : null;
    };
    const pieces: Seg[] = marks.map((mk) => ({
      text: text.slice(mk.start, mk.end),
      start: mk.start,
      end: mk.end,
    }));
    return packSegments(pieces, config, trailAt, text);
  }

  return out.map((c, i) => ({ ...c, index: i }));
}

/** Heuristic strategy: paragraphs first, sentences when a paragraph is too big. */
function chunkByHeuristic(text: string, config: ChunkConfig): Chunk[] {
  const pieces: Seg[] = [];
  for (const p of splitParagraphs(text)) {
    if (p.text.trim().length === 0) continue;
    pieces.push(...explode(p, config.chunkSize));
  }
  return packSegments(pieces, config, () => null, text);
}

const RECURSIVE_SEPARATORS = ['\n\n', '\n', '。', '！', '？', '. ', '! ', '? ', '；', ';', ' ', ''];

/** Recursive strategy: bisect on the coarsest separator that yields fitting pieces. */
function chunkByRecursive(text: string, config: ChunkConfig): Chunk[] {
  const out: Seg[] = [];

  const recurse = (seg: Seg, sepIndex: number): void => {
    if (seg.text.trim().length === 0) return;
    if (seg.text.length <= config.chunkSize || sepIndex >= RECURSIVE_SEPARATORS.length) {
      out.push(seg);
      return;
    }
    const sep = RECURSIVE_SEPARATORS[sepIndex];
    if (sep === '') {
      out.push(...hardSplit(seg, config.chunkSize));
      return;
    }
    const parts: Seg[] = [];
    let cursor = 0;
    let idx = seg.text.indexOf(sep, cursor);
    while (idx !== -1) {
      const end = idx + sep.length;
      parts.push({
        text: seg.text.slice(cursor, end),
        start: seg.start + cursor,
        end: seg.start + end,
      });
      cursor = end;
      idx = seg.text.indexOf(sep, cursor);
    }
    if (cursor < seg.text.length) {
      parts.push({
        text: seg.text.slice(cursor),
        start: seg.start + cursor,
        end: seg.start + seg.text.length,
      });
    }
    if (parts.length <= 1) {
      recurse(seg, sepIndex + 1);
      return;
    }
    for (const p of parts) recurse(p, sepIndex + 1);
  };

  recurse({ text, start: 0, end: text.length }, 0);
  return packSegments(out, config, () => null, text);
}

/**
 * Pick a strategy from the document's shape: heading-rich Markdown gets the
 * heading strategy, everything else the paragraph heuristic.
 */
export function recommendStrategy(text: string): ChunkStrategy {
  const head = text.slice(0, Math.max(2000, Math.floor(text.length * 0.2)));
  let headings = 0;
  for (const line of head.split('\n')) {
    if (HEADING_RE.test(line)) headings++;
    if (headings >= 3) return 'heading';
  }
  return 'heuristic';
}

/**
 * Split `text` into chunks. Never throws; an empty or whitespace-only input
 * yields an empty array.
 */
export function chunkText(text: string, config?: Partial<ChunkConfig>): Chunk[] {
  const resolved: ChunkConfig = {
    ...DEFAULT_CHUNK_CONFIG,
    ...config,
  };
  if (!Number.isFinite(resolved.chunkSize) || resolved.chunkSize <= 0) {
    resolved.chunkSize = DEFAULT_CHUNK_CONFIG.chunkSize;
  }
  if (!Number.isFinite(resolved.chunkOverlap) || resolved.chunkOverlap < 0) {
    resolved.chunkOverlap = 0;
  }
  // WeKnora's ensureDefaults caps overlap at chunkSize/2 — beyond that the
  // buffer can barely advance and chunks balloon.
  if (resolved.chunkOverlap > resolved.chunkSize / 2) {
    resolved.chunkOverlap = Math.floor(resolved.chunkSize / 2);
  }
  if (!text || text.trim().length === 0) return [];

  const strategy = resolved.strategy ?? recommendStrategy(text);
  switch (strategy) {
    case 'heading':
      return chunkByHeading(text, resolved);
    case 'recursive':
      return chunkByRecursive(text, resolved);
    case 'heuristic':
    default:
      return chunkByHeuristic(text, resolved);
  }
}

// --- Parent-child -----------------------------------------------------------
//
// WeKnora 的 SplitParentChild（internal/infrastructure/chunker/strategy.go）。
// 三条语义与直觉不同，实现时必须照做：
//
//   1. 父块 chunkType='parent_text'，**不参与 embedding**。父块是"回溯用的容器"，
//      不是检索单元；把它向量化会用大块稀释召回。
//   2. 父行**只在真分裂时创建**（len(subs) > 1 || subs[0].content !== parent.content）。
//      短文档里父块与子块内容相同，再建一行父块纯属冗余。
//   3. 面包屑（本文件的 headingPath，即 WeKnora 的 ContextHeader）**不进 content**，
//      只在 embedding 时拼接。若把它写进 content，就破坏了
//      `text.slice(startAt, endAt) === content` 这个引用可核验的核心不变式。

/** 父块切分配置。chunkOverlap 见下方 chunkParentChild 的说明。 */
export const DEFAULT_PARENT_CONFIG: ChunkConfig = {
  strategy: 'heuristic',
  chunkSize: 4096,
  chunkOverlap: 0,
};

/** 子块切分配置。overlap = childSize / 5，取自 WeKnora DeriveParentChildConfigs。 */
export const DEFAULT_CHILD_CONFIG: ChunkConfig = {
  strategy: 'heuristic',
  chunkSize: 384,
  chunkOverlap: 76,
};

export interface ParentChildConfig {
  parent?: Partial<ChunkConfig>;
  child?: Partial<ChunkConfig>;
}

/**
 * 把父块的面包屑并入子块，并丢掉子块开头与父块重复的那一段
 * （WeKnora strategy.go:mergeBreadcrumbs）。子块自身没有面包屑时直接继承父块。
 */
function mergeBreadcrumbs(parentPath: string | null, childPath: string | null): string | null {
  const parent = (parentPath ?? '').trim();
  const child = (childPath ?? '').trim();
  if (!parent) return child || null;
  if (!child) return parent;

  const parentParts = parent.split(' > ');
  const childParts = child.split(' > ');
  let shared = 0;
  while (
    shared < childParts.length &&
    shared < parentParts.length &&
    childParts[shared] === parentParts[shared]
  ) {
    shared++;
  }
  // 子块的面包屑整体是父块的子路径（或与之相同）——父块已足够描述。
  if (shared === childParts.length) return parent;
  const rest = childParts.slice(shared).join(' > ');
  return rest ? `${parent} > ${rest}` : parent;
}

/**
 * 父子分块。返回**扁平数组**——`parent_text` 行与其 `text` 子行混排，
 * 子行通过 `parentIndex` 回指父行。调用方据此写库：
 * 父行落 `kb_chunks` 但**不写向量表**，子行写向量表并用 `parent_chunk_id` 指向父行。
 *
 * 偏移量始终是**全文绝对偏移**：子块是在父块的切片内再切的，写回时会加上父块起点。
 */
export function chunkParentChild(text: string, cfg?: ParentChildConfig): Chunk[] {
  if (!text || text.trim().length === 0) return [];

  // 策略在全文上推断一次，父子两级共用——在父块局部推断会导致同一文档内
  // 不同父块走不同策略，分块粒度无法预期。
  const strategy = cfg?.parent?.strategy ?? cfg?.child?.strategy ?? recommendStrategy(text);
  const parentCfg: ChunkConfig = { ...DEFAULT_PARENT_CONFIG, strategy, ...cfg?.parent };
  const childCfg: ChunkConfig = { ...DEFAULT_CHILD_CONFIG, strategy, ...cfg?.child };

  const out: Chunk[] = [];
  for (const parent of chunkText(text, parentCfg)) {
    const subs = chunkText(parent.content, childCfg);
    if (subs.length === 0) continue;

    // 语义 2：只有真的切出了多个子块、或唯一的子块与父块内容不同，父块才值得单独立行。
    const trulySplit = subs.length > 1 || subs[0].content !== parent.content;
    const parentIndex = trulySplit ? out.length : -1;

    if (trulySplit) {
      out.push({
        index: parentIndex,
        content: parent.content,
        headingPath: parent.headingPath,
        startAt: parent.startAt,
        endAt: parent.endAt,
        chunkType: 'parent_text',
        parentIndex: -1,
      });
    }

    for (const sub of subs) {
      out.push({
        index: out.length,
        content: sub.content,
        headingPath: mergeBreadcrumbs(parent.headingPath, sub.headingPath),
        // 子块偏移是相对父块切片的，加回父块起点才是全文坐标。
        startAt: parent.startAt + sub.startAt,
        endAt: parent.startAt + sub.endAt,
        chunkType: 'text',
        parentIndex,
      });
    }
  }

  return out.map((c, i) => ({ ...c, index: i }));
}
