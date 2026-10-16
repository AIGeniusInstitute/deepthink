/**
 * Local query expansion — the recall rescue path.
 *
 * Mirrors WeKnora's `query_expansion.go` (internal/application/service/chat_pipeline).
 * When the first retrieval comes back short, the same query is rewritten into a
 * handful of variants locally — no LLM call — and each variant is searched
 * **keyword-only**, because a variant is a local rewrite: its embedding would sit
 * next to the original query's, so re-embedding it and repeating the vector arm
 * would buy nothing. That is also why expansion does nothing when keyword
 * matching is switched off.
 *
 * ── Divergences from WeKnora, all deliberate ────────────────────────────────
 *
 * 1. **No Jieba.** WeKnora's `tokenize()` hands Han runs to `types.Jieba.CutForSearch`
 *    and `extractKeywords` returns jieba *words* ("如何配置向量数据库" → 配置/向量/数据库).
 *    This codebase has no segmenter and deliberately does not want one: its keyword
 *    arm is FTS5 with the **trigram** tokenizer (`KB_CHUNK_FTS_TOKENIZER` in db.ts),
 *    which needs no word boundaries, and `chunker.ts` already states the house
 *    position that for CJK one character is roughly one token.
 *
 *    So Han runs are segmented the way the index segments them — as characters —
 *    and the function-word removal that jieba+stopword-list achieves is done at the
 *    character level instead. This works because every CJK stopword in WeKnora's
 *    list is itself a single character (的/是/在/了/和/与/或). The observable effect
 *    is the same class — the variant is the query minus its function words — but the
 *    variant *string* differs from WeKnora's, so tests ported verbatim from
 *    `query_expansion_test.go` that assert jieba words (e.g. 网易/大厦) do not apply.
 *
 * 2. **Length thresholds count runes, not bytes.** WeKnora writes `len(s) < 3`,
 *    `len(m[1]) > 2`, `len(seg) > 5` on Go strings, which are **bytes**. For CJK,
 *    where one character is 3 bytes, those thresholds are effectively ~3× more
 *    permissive than the numbers suggest (a single Chinese character passes the
 *    "3" gate). Byte-length is an artifact of Go string indexing rather than a
 *    designed threshold, so rune count is used here — the evident intent. This makes
 *    the gates *stricter* than WeKnora's for Chinese input.
 *
 * 3. **Rule 1 also fires on a single CJK run.** Upstream gates the keyword variant
 *    on `len(keywords) >= 2`, which jieba satisfies easily ("如何配置向量数据库" →
 *    配置/向量/数据库). Without a segmenter a Han query collapses to one run, so that
 *    gate would silence the rule outright for Chinese — not a string difference but
 *    a lost capability ("向量数据库的索引参数配置" would yield *no* variant at all).
 *    The gate is therefore relaxed to: ≥2 keywords, **or** a single keyword that
 *    already differs from the query (i.e. function words were actually removed —
 *    a lone keyword equal to the query is not a rewrite and is skipped).
 *
 * 4. **Quoted phrases also accept curly quotes.** WeKnora's character class is
 *    `["'"'「」『』]` — hexdumped, the two ASCII quote bytes 0x22/0x27 are each
 *    present twice, i.e. the smart quotes U+201C/U+201D/U+2018/U+2019 the author
 *    clearly intended were lost to the ASCII ones. This module keeps the ASCII pair
 *    *and* adds the curly pair, so a phrase quoted either way is picked up.
 *
 * 5. **Sequential, not concurrent.** WeKnora fans variants × search targets across
 *    goroutines capped at `min(16, jobs)`. `keywordSearchChunks` here is synchronous
 *    (better-sqlite3 is), and it takes the whole kbId list in one call, so there is
 *    one job per variant and nothing to overlap. The cap is recorded in the debug
 *    payload for parity, but no scheduling happens.
 *
 * 6. **No keyword threshold.** Upstream scales the keyword threshold for expansion
 *    hits (`expKwTh = KeywordThreshold * 0.8`). This codebase's keyword arm filters
 *    nothing — bm25 has no absolute scale — so there is no threshold to scale, and
 *    expansion hits are exempt from `minScore` for the same reason.
 *
 * Pure module: no DB, no network, no config reads.
 */

/** Max variants produced from one query (WeKnora hard-codes 5). */
export const MAX_EXPANSIONS = 5;

/** Minimum length of a variant, in runes. See divergence 2. */
const MIN_VARIANT_RUNES = 3;

/** Minimum length of a quoted phrase, in runes. See divergence 2. */
const MIN_PHRASE_RUNES = 2;

/** Minimum length of a delimiter-split segment, in runes. See divergence 2. */
const MIN_SEGMENT_RUNES = 5;

/** Concurrency cap WeKnora uses; reported for parity only (see divergence 4). */
export const EXPANSION_CONCURRENCY_CAP = 16;

/**
 * WeKnora's stopword list, verbatim. The CJK entries are all single characters,
 * which is what makes character-level removal equivalent (divergence 1).
 */
const STOPWORDS = new Set([
  '的', '是', '在', '了', '和', '与', '或',
  'a', 'an', 'the', 'is', 'are', 'was', 'were',
  'be', 'been', 'being', 'have', 'has', 'had',
  'do', 'does', 'did', 'will', 'would', 'could',
  'should', 'may', 'might', 'must', 'can',
  'to', 'of', 'in', 'for', 'on', 'with', 'at',
  'by', 'from', 'as', 'into', 'through', 'about',
  'what', 'how', 'why', 'when', 'where', 'which',
  'who', 'whom', 'whose',
]);

/**
 * Leading question words. Order matters: "什么是" must precede "什么" so the
 * longer alternative wins (Go's regexp is leftmost-first, as is JS's).
 */
const QUESTION_WORD_PREFIX =
  /^(什么是|什么|如何|怎么|怎样|为什么|为何|哪个|哪些|谁|何时|何地|请问|请告诉我|帮我|我想知道|我想了解)/;

/** WeKnora's delimiter set, verbatim. */
const DELIMITERS = /[,，;；、。！？!?\s]+/;

/** ASCII quotes plus 「」『』 (as upstream) and the curly quotes upstream lost. */
const QUOTE_CHARS = `"'“”‘’「」『』`;
const PHRASE_RE = new RegExp(`[${QUOTE_CHARS}]([^${QUOTE_CHARS}]+)[${QUOTE_CHARS}]`, 'g');

const HAN = /\p{Script=Han}/u;

/** Rune count. `[...s]` iterates by code point, unlike `s.length`. */
function runeCount(s: string): number {
  return [...s].length;
}

interface Run {
  text: string;
  isHan: boolean;
}

/**
 * Split into alternating Han / non-Han runs — the same boundary rule WeKnora's
 * `tokenize()` uses (it flushes on every script change), minus the jieba step.
 */
function toRuns(text: string): Run[] {
  const runs: Run[] = [];
  let current = '';
  let currentIsHan = false;

  const flush = () => {
    if (current) runs.push({ text: current, isHan: currentIsHan });
    current = '';
  };

  for (const ch of text) {
    const isHan = HAN.test(ch);
    const isWord = isHan || /[\p{L}\p{N}]/u.test(ch);
    if (!isWord) {
      flush();
      continue;
    }
    if (current && isHan !== currentIsHan) flush();
    currentIsHan = isHan;
    current += ch;
  }
  flush();
  return runs;
}

/**
 * Drop function words from each run. ASCII words are matched whole against the
 * stopword list; Han runs lose the stopword *characters* in place. Runs that end
 * up empty (or a single rune, matching WeKnora's `RuneCountInString(w) > 1`) are
 * discarded.
 */
export function extractKeywords(text: string): string[] {
  const out: string[] = [];
  for (const run of toRuns(text)) {
    if (run.isHan) {
      const kept = [...run.text].filter((ch) => !STOPWORDS.has(ch)).join('');
      if (runeCount(kept) > 1) out.push(kept);
      continue;
    }
    const word = run.text.toLowerCase();
    if (!STOPWORDS.has(word) && runeCount(run.text) > 1) out.push(run.text);
  }
  return out;
}

/** Quoted phrases. See divergence 3 for the character class. */
export function extractPhrases(text: string): string[] {
  const out: string[] = [];
  PHRASE_RE.lastIndex = 0;
  for (const m of text.matchAll(PHRASE_RE)) {
    const phrase = m[1];
    if (phrase && runeCount(phrase) > MIN_PHRASE_RUNES) out.push(phrase);
  }
  return out;
}

/** Split on WeKnora's delimiters, dropping empty pieces. */
export function splitByDelimiters(text: string): string[] {
  return text
    .split(DELIMITERS)
    .map((p) => p.trim())
    .filter((p) => p !== '');
}

/** Strip a leading question word (prefix-anchored, as upstream). */
export function removeQuestionWords(text: string): string {
  return text.replace(QUESTION_WORD_PREFIX, '').trim();
}

export interface ExpandOptions {
  /** Cap on variants. Defaults to `MAX_EXPANSIONS`. */
  max?: number;
}

/**
 * Generate local query variants, in WeKnora's four-rule order:
 *
 *   1. function words dropped → a keyword-only variant (needs ≥2 keywords)
 *   2. quoted phrases, each standing alone
 *   3. delimiter-split segments longer than 5 runes
 *   4. the query with its leading question word removed
 *
 * The variant list is deduplicated case-insensitively and seeded with the query
 * itself, so no variant echoes the input. WeKnora also seeds its seen-set with
 * `chatManage.Query` because that call site expands `RewriteQuery`, which may
 * differ. There is no query-rewriting stage in this codebase yet, so the two are
 * the same string; when rewriting lands, the original query must be seeded here
 * too or a variant could duplicate it.
 */
export function expandQueries(query: string, options: ExpandOptions = {}): string[] {
  const trimmed = query.trim();
  if (!trimmed) return [];

  const max = options.max ?? MAX_EXPANSIONS;
  const seen = new Set<string>([trimmed.toLowerCase()]);
  const expansions: string[] = [];

  const addIfNew = (raw: string): void => {
    const s = raw.trim();
    if (!s || runeCount(s) < MIN_VARIANT_RUNES) return;
    const key = s.toLowerCase();
    if (seen.has(key)) return;
    seen.add(key);
    expansions.push(s);
  };

  // 1. Keyword-only variant. See divergence 3 for the relaxed gate.
  const keywords = extractKeywords(trimmed);
  if (keywords.length >= 2 || (keywords.length === 1 && keywords[0] !== trimmed)) {
    addIfNew(keywords.join(' '));
  }

  // 2. Quoted phrases.
  for (const phrase of extractPhrases(trimmed)) addIfNew(phrase);

  // 3. Longest delimiter-split segments.
  for (const seg of splitByDelimiters(trimmed)) {
    if (runeCount(seg) > MIN_SEGMENT_RUNES) addIfNew(seg);
  }

  // 4. Question word removed.
  const cleaned = removeQuestionWords(trimmed);
  if (cleaned !== trimmed) addIfNew(cleaned);

  return expansions.length > max ? expansions.slice(0, max) : expansions;
}
