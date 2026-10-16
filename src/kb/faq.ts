/**
 * FAQ knowledge bases: entry metadata, index text, and negative-question
 * matching. Ported from WeKnora's `internal/types/faq.go` and
 * `internal/application/service/knowledge_faq.go`.
 *
 * Pure module — no DB, no network, no config reads.
 *
 * ── The shape of a FAQ entry ────────────────────────────────────────────────
 *
 * Upstream has no FAQ table. An entry is one row in `chunks` with
 * `chunk_type='faq'`, and every business field lives in the row's `metadata`
 * JSON (WeKnora `internal/types/faq.go:17-25`). We keep that shape: one
 * `kb_chunks` row per entry, `chunk_type='faq'`, fields in `metadata`.
 *
 * ── Two different "content" strings, do not conflate them ───────────────────
 *
 * `buildFaqChunkContent` is the **human-readable** body stored on the row
 * ("Q: … / Similar Questions: / Answers:"). `buildFaqIndexTexts` is what
 * actually gets embedded. They differ in prefixing, separator, and — for
 * `separate` mode — in cardinality. Upstream keeps them in separate functions
 * (`knowledge_faq.go:1618` and `:1875`/`:1892`) and so do we.
 *
 * ── Negative questions ──────────────────────────────────────────────────────
 *
 * Never indexed, never in the stored content — they exist only to veto a
 * retrieval result *after* the fact, by exact (lowercased, trimmed) equality
 * (`knowledgebase_search_faq.go:318-334`). Deliberately not substring matching
 * and deliberately not run through `normalizeQuestion`.
 *
 * ── Divergences from upstream ───────────────────────────────────────────────
 *
 * 1. **No traditional→simplified step in `normalizeQuestion`.** Upstream runs
 *    every question through OpenCC dictionaries (~40KB of Apache-2.0 data,
 *    `internal/textconv/`) before hashing. We skip it: the dictionaries exist
 *    only to make the *dedup fingerprint* fold 繁体 onto 简体, and vendoring
 *    that much third-party data for a hash aid fails the simplicity bar.
 *    Consequence, stated plainly: for traditional-Chinese input our
 *    `contentHash` differs from upstream's, so a 繁体 entry and its 简体 twin
 *    will not be detected as duplicates of each other. Everything else in the
 *    pipeline is unaffected, and for 简体 input the hash is byte-identical.
 *
 * 2. **The trailing-punctuation trim set is upstream's bytes exactly, smart
 *    quotes included as absent.** Same mangling as query-expansion.ts: the
 *    author wrote a set containing typographic quotes and the file actually
 *    holds ASCII `"` three times over (`internal/types/faq.go`, hexdump of the
 *    `strings.Trim` line). Unlike query-expansion we do **not** add them back
 *    here — there the missing characters truncated a phrase-boundary class and
 *    cost real recall, here a stray curly quote simply survives normalization
 *    the same way it does upstream. A hash function should match bytes, not
 *    intent.
 *
 * 3. **`answerStrategy: 'random'` is carried but not honoured**, matching
 *    upstream. This is not an omission on our side: WeKnora's answer assembly
 *    (`chat_pipeline/merge_faq.go:93-127`) concatenates every answer
 *    unconditionally and never reads the field. `random` survives only in
 *    storage, clone-sync, and CSV export. Faithful means faithful — we do not
 *    "fix" it into behaviour upstream does not have.
 */

import { createHash } from 'node:crypto';

export type FaqIndexMode = 'question_only' | 'question_answer';
export type FaqQuestionIndexMode = 'combined' | 'separate';
export type AnswerStrategy = 'all' | 'random';

export const FAQ_INDEX_MODES: readonly FaqIndexMode[] = ['question_only', 'question_answer'];
export const FAQ_QUESTION_INDEX_MODES: readonly FaqQuestionIndexMode[] = ['combined', 'separate'];

export interface FaqConfig {
  indexMode: FaqIndexMode;
  questionIndexMode: FaqQuestionIndexMode;
}

/**
 * Upstream's backend default (`types/knowledgebase.go:783-795`). Note the
 * Vue editor ships a *different* default (`question_only` + `separate`,
 * `KnowledgeBaseEditorModal.vue:902`); we follow the backend, since that is
 * what an API caller who omits `faq_config` gets.
 */
export const DEFAULT_FAQ_CONFIG: FaqConfig = {
  indexMode: 'question_answer',
  questionIndexMode: 'combined',
};

/** Upstream's JSON keys, verbatim (`types/faq.go:17-25`). */
export interface FaqMetadata {
  standard_question: string;
  similar_questions?: string[];
  negative_questions?: string[];
  /** Plural — the field is `answers`, not `answer`. */
  answers?: string[];
  answer_strategy?: AnswerStrategy;
  /** `version`, not `revision`. Starts at 1. */
  version?: number;
  source?: string;
}

/**
 * Trim each item, drop empties, drop duplicates — order preserved.
 * Upstream returns nil (not `[]`) for the empty case; we return `[]` and let
 * callers treat it as falsey the same way.
 */
export function sanitizeStrings(values: readonly string[] | undefined | null): string[] {
  if (!values || values.length === 0) return [];
  const seen = new Set<string>();
  const out: string[] = [];
  for (const value of values) {
    const trimmed = String(value ?? '').trim();
    if (trimmed === '' || seen.has(trimmed)) continue;
    seen.add(trimmed);
    out.push(trimmed);
  }
  return out;
}

/** Upstream `FAQChunkMetadata.Sanitize()` (`types/faq.go:116-129`). */
export function sanitizeFaqMetadata(meta: FaqMetadata): FaqMetadata {
  const version = meta.version && meta.version > 0 ? meta.version : 1;
  const out: FaqMetadata = {
    standard_question: String(meta.standard_question ?? '').trim(),
    version,
  };
  const similar = sanitizeStrings(meta.similar_questions);
  const negative = sanitizeStrings(meta.negative_questions);
  const answers = sanitizeStrings(meta.answers);
  if (similar.length > 0) out.similar_questions = similar;
  if (negative.length > 0) out.negative_questions = negative;
  if (answers.length > 0) out.answers = answers;
  if (meta.answer_strategy) out.answer_strategy = meta.answer_strategy;
  if (meta.source) out.source = meta.source;
  return out;
}

export function normalizeAnswerStrategy(raw: string | undefined | null): AnswerStrategy {
  return raw === 'random' ? 'random' : 'all';
}

export function normalizeIndexMode(raw: string | undefined | null): FaqIndexMode {
  return raw === 'question_only' ? 'question_only' : 'question_answer';
}

export function normalizeQuestionIndexMode(
  raw: string | undefined | null,
): FaqQuestionIndexMode {
  return raw === 'separate' ? 'separate' : 'combined';
}

/** Parse a `faq_config` JSON blob, falling back to upstream's defaults. */
export function parseFaqConfig(raw: string | null | undefined): FaqConfig {
  if (!raw) return { ...DEFAULT_FAQ_CONFIG };
  try {
    const parsed = JSON.parse(raw) as Record<string, unknown>;
    return {
      indexMode: normalizeIndexMode(parsed.index_mode as string | undefined),
      questionIndexMode: normalizeQuestionIndexMode(
        parsed.question_index_mode as string | undefined,
      ),
    };
  } catch {
    return { ...DEFAULT_FAQ_CONFIG };
  }
}

/** Parse a chunk's `metadata` blob into FAQ fields, or null when absent/broken. */
export function parseFaqMetadata(raw: string | null | undefined): FaqMetadata | null {
  if (!raw) return null;
  try {
    const parsed = JSON.parse(raw) as FaqMetadata;
    if (!parsed || typeof parsed !== 'object') return null;
    if (typeof parsed.standard_question !== 'string') return null;
    return sanitizeFaqMetadata(parsed);
  } catch {
    return null;
  }
}

const MULTI_SPACE = /\s+/g;
const URL_PATTERN = /https?:\/\/[^\s]+/g;
/**
 * Upstream's trailing-punctuation set, byte for byte. The literal below looks
 * like it contains typographic quotes; it does not — see divergence 2.
 */
const TRIM_PUNCTUATION = new Set([
  '？', // ？
  '。', // 。
  '，', // ，
  '；', // ；
  '、', // 、
  '：', // ：
  '"',
  '！', // ！
  '?',
  '.',
  ',',
  ';',
  '!',
  ':',
  "'",
]);

function isAsciiAlphaNum(ch: string): boolean {
  return /^[0-9A-Za-z]$/.test(ch);
}

/**
 * Upstream `normalizeSpaces` (`types/faq.go:640-676`): collapse runs of
 * whitespace, then keep a space only when *both* neighbours are ASCII
 * alphanumerics. "怎么 绑定 手机" → "怎么绑定手机"; "iphone 15 怎么 激活" →
 * "iphone 15怎么激活".
 */
function normalizeSpaces(input: string): string {
  const collapsed = input.replace(MULTI_SPACE, ' ');
  const chars = Array.from(collapsed);
  let out = '';
  for (let i = 0; i < chars.length; i++) {
    if (chars[i] !== ' ') {
      out += chars[i];
      continue;
    }
    let next = '';
    for (let j = i + 1; j < chars.length; j++) {
      if (chars[j] !== ' ') {
        next = chars[j];
        break;
      }
    }
    const prev = i > 0 ? chars[i - 1] : '';
    if (isAsciiAlphaNum(prev) && isAsciiAlphaNum(next)) out += ' ';
  }
  return out;
}

/** Full-width (U+FF01–U+FF5E) and ideographic space → ASCII (`types/faq.go:752-771`). */
function toHalfWidth(input: string): string {
  let out = '';
  for (const ch of input) {
    const code = ch.codePointAt(0)!;
    if (code === 0x3000) out += ' ';
    else if (code >= 0xff01 && code <= 0xff5e) out += String.fromCharCode(code - 0xff01 + 0x21);
    else out += ch;
  }
  return out;
}

/**
 * Upstream `NormalizeQuestion` (`types/faq.go:591-613`), minus the
 * traditional→simplified step. See divergence 1.
 *
 * Order matters and is preserved: trim → strip URLs → lowercase → trim
 * punctuation → half-width → space folding → trim. Note the punctuation trim
 * happens *before* half-width conversion, so it must recognise the full-width
 * forms itself — which upstream's set does, and ours now does too.
 */
export function normalizeQuestion(question: string): string {
  let q = String(question ?? '').trim();
  if (q === '') return '';
  q = q.replace(URL_PATTERN, '');
  q = q.toLowerCase();
  let start = 0;
  let end = q.length;
  while (start < end && TRIM_PUNCTUATION.has(q[start])) start++;
  while (end > start && TRIM_PUNCTUATION.has(q[end - 1])) end--;
  q = q.slice(start, end);
  q = toHalfWidth(q);
  q = normalizeSpaces(q);
  return q.trim();
}

function normalizeQuestionList(questions: readonly string[] | undefined): string[] {
  return sanitizeStrings(questions).map(normalizeQuestion).filter((q) => q !== '');
}

/**
 * Upstream `CalculateFAQContentHash` (`types/faq.go:211-248`): SHA-256 over
 * `standard | sorted similar (,) | sorted negative (,) | sorted answers (,)`,
 * with every question normalized first and answers only trimmed.
 */
export function calculateFaqContentHash(meta: FaqMetadata): string {
  if (!meta) return '';
  const normalized: FaqMetadata = {
    standard_question: normalizeQuestion(meta.standard_question),
    similar_questions: normalizeQuestionList(meta.similar_questions),
    negative_questions: normalizeQuestionList(meta.negative_questions),
    answers: sanitizeStrings(meta.answers),
  };
  const sorted = (list: string[] | undefined): string[] => [...(list ?? [])].sort();
  const payload = [
    normalized.standard_question,
    sorted(normalized.similar_questions).join(','),
    sorted(normalized.negative_questions).join(','),
    sorted(normalized.answers).join(','),
  ].join('|');
  return createHash('sha256').update(payload, 'utf8').digest('hex');
}

/**
 * The row's stored body — what a FAQ list/detail view shows.
 * Upstream `buildFAQChunkContent` (`knowledge_faq.go:1618-1636`).
 * Negative questions are deliberately absent.
 */
export function buildFaqChunkContent(meta: FaqMetadata, indexMode: FaqIndexMode): string {
  let out = `Q: ${meta.standard_question}\n`;
  const similar = meta.similar_questions ?? [];
  if (similar.length > 0) {
    out += 'Similar Questions:\n';
    for (const q of similar) out += `- ${q}\n`;
  }
  const answers = meta.answers ?? [];
  if (indexMode === 'question_answer' && answers.length > 0) {
    out += 'Answers:\n';
    for (const a of answers) out += `- ${a}\n`;
  }
  return out;
}

/**
 * The strings that actually get embedded — one per vector.
 *
 * `combined` yields exactly one: standard question, then similar questions,
 * then (for `question_answer`) answers, all joined by `"\n"`.
 * `separate` yields `1 + similar_questions.length`: the standard question gets
 * its own vector and so does every similar question. Both variants append the
 * answers under `question_answer`.
 *
 * Upstream `buildFAQIndexContent` + `buildFAQIndexInfoList`
 * (`knowledge_faq.go:1875-1990`). Note the join here is a bare newline — no
 * `Q:` prefix and no `- ` bullets, unlike the stored content above.
 */
export function buildFaqIndexTexts(
  meta: FaqMetadata,
  indexMode: FaqIndexMode,
  questionIndexMode: FaqQuestionIndexMode,
): string[] {
  const answers = indexMode === 'question_answer' ? (meta.answers ?? []) : [];
  const withAnswers = (question: string): string =>
    answers.length === 0 ? question : [question, ...answers].join('\n');

  if (questionIndexMode === 'combined') {
    const parts = [meta.standard_question, ...(meta.similar_questions ?? []), ...answers];
    return [parts.join('\n')];
  }
  return [
    withAnswers(meta.standard_question),
    ...(meta.similar_questions ?? []).map(withAnswers),
  ];
}

/**
 * The retrieval-time `source_id` for variant `i` of a chunk.
 * Upstream uses `chunk.ID` for the standard question and `chunk.ID-<i>` for
 * each similar question (`knowledge_faq.go:1974`).
 *
 * Upstream has a *second*, incompatible rule on the incremental-reindex path
 * (`chunk.ID-<md5(question)[0:4]>`, `knowledge_faq_import.go:1932`), which is
 * why its incremental delete can miss rows the full path wrote. We implement
 * only the index-based rule, consistently on both paths — one rule, always
 * correct, rather than two that disagree.
 */
export function faqVariantSourceId(chunkId: string, variantIndex: number): string {
  return variantIndex === 0 ? chunkId : `${chunkId}-${variantIndex}`;
}

/**
 * Does this query exactly match one of the entry's negative questions?
 *
 * Upstream `matchesNegativeQuestions` (`knowledgebase_search_faq.go:318-334`):
 * compare `lower(trim(query))` against `lower(trim(negative))` for equality.
 * No substring matching, and deliberately no `normalizeQuestion` — so a
 * negative written in traditional characters will not veto a simplified query,
 * which is upstream's behaviour and therefore ours.
 */
export function matchesNegativeQuestions(
  queryText: string,
  negativeQuestions: readonly string[] | undefined,
): boolean {
  if (!negativeQuestions || negativeQuestions.length === 0) return false;
  const query = String(queryText ?? '').trim().toLowerCase();
  for (const negative of negativeQuestions) {
    const candidate = String(negative ?? '').trim().toLowerCase();
    if (candidate === '') continue;
    if (query === candidate) return true;
  }
  return false;
}
