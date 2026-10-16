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
  // An overlap at or above the chunk size would make the buffer never advance.
  if (resolved.chunkOverlap >= resolved.chunkSize) {
    resolved.chunkOverlap = Math.floor(resolved.chunkSize / 4);
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
