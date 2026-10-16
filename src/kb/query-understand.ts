/**
 * Query understanding — question rewriting plus intent classification.
 *
 * Mirrors WeKnora's `PluginQueryUnderstand`
 * (internal/application/service/chat_pipeline/query_understand.go) and its
 * prompt (`config/prompt_templates/rewrite.yaml`, template `default_rewrite`).
 * One chat-model call does both jobs and returns a single JSON object.
 *
 * Intent is not decoration: `needsRetrieval()` decides whether the retrieval
 * stages run at all. A greeting answered with "知识库中没有找到相关内容" is the
 * failure mode this prevents.
 *
 * ── Divergences from WeKnora, all deliberate ────────────────────────────────
 *
 * 1. **No image path.** Upstream runs three input combinations (text / text+images
 *    / images only), switches to a vision model when images are present, raises
 *    maxTokens 150 → 2048 for the OCR dump, and has a whole Task 3 in the prompt.
 *    The KB chat route in this codebase takes no attachments, so there is no image
 *    path at all. Task 3 is dropped and `image_description` is not requested or
 *    parsed. The `<no_image_attached />` / `<no_document_attached />` markers are
 *    still appended, because those are upstream's *attachment-absent* branches and
 *    are therefore exactly what our only case renders.
 *
 *    A consequence worth stating: `image_only` and `doc_only` stay in the intent
 *    vocabulary and in `normalizeQueryIntent` — the model is told never to pick
 *    them without an attachment — but nothing in this codebase can produce one.
 *
 * 2. **Truncated replies drop cut-off fields, full stop.** Upstream's salvage pass
 *    keeps the partial text of a field the reply was cut inside *only* when it is
 *    the image description. With no image description to salvage, a cut-off field
 *    is always dropped. A cut-off rewrite would otherwise replace the user's
 *    complete question with half of it.
 *
 * 3. **Own timeout.** The rewrite call gets 30s rather than sharing the 120s QA
 *    timeout: it is a 150-token call, and a hung one would stall the whole turn
 *    before retrieval has even started.
 *
 * 4. **Model = the RAG chat model.** Upstream takes a separately configured
 *    `rewriteModel`. This codebase has one chat model in rag.json; inventing a
 *    second credential store for a 150-token call is not worth it.
 *
 * The load-bearing invariant: **every failure path returns null and the caller
 * behaves exactly as it did before this module existed.** No model configured, a
 * non-200, a timeout, unparseable output — all degrade to "use the raw question,
 * retrieve". Understanding is an optimisation, never a gate.
 */

import { logger } from '../logger.js';

/**
 * The chat endpoint this module calls. Injected rather than resolved here: rag.ts
 * is the caller and already resolves it, and importing rag.ts back would make the
 * two modules circular.
 */
export interface UnderstandModelConfig {
  baseUrl: string;
  apiKey: string;
  model: string;
}

/** The nine labels upstream recognizes. */
export const ALL_INTENTS = [
  'kb_search',
  'web_search',
  'greeting',
  'chitchat',
  'follow_up',
  'image_only',
  'doc_only',
  'summarize',
  'clarification',
] as const;

export type QueryIntent = (typeof ALL_INTENTS)[number];

const INTENT_SET = new Set<string>(ALL_INTENTS);

/** Timeout for the rewrite call. See divergence 3. */
const UNDERSTAND_TIMEOUT_MS = 30_000;
const MAX_TOKENS = 150;
const TEMPERATURE = 0.3;

/**
 * Map a model-produced label onto a known intent. Case and separators are
 * forgiven ("KB-Search" → kb_search). An unrecognized label becomes '' — the
 * empty intent, which retrieves.
 *
 * Upstream's comment on this is the reason it exists: taking the label verbatim
 * turned any unexpected value into "no retrieval", so the answer was generated
 * without the knowledge base and without an error.
 */
export function normalizeQueryIntent(raw: string | undefined | null): QueryIntent | '' {
  if (!raw) return '';
  const label = raw.trim().toLowerCase().replace(/[-\s]/g, '_');
  return INTENT_SET.has(label) ? (label as QueryIntent) : '';
}

/**
 * Whether the knowledge base should be searched. The empty intent is treated as
 * needing retrieval, for safety.
 *
 * `web_search` is deliberately absent: it is handled by `needsRetrieval`, which
 * also consults the web-search flag.
 */
export function needsKbRetrieval(intent: QueryIntent | ''): boolean {
  return intent === 'kb_search' || intent === 'clarification' || intent === '';
}

/**
 * Whether any retrieval should run. `web_search` only retrieves when web search
 * is actually enabled; otherwise the intent prompt tells the user it is
 * unavailable.
 */
export function needsRetrieval(intent: QueryIntent | '', webSearchEnabled = false): boolean {
  if (intent === 'web_search') return webSearchEnabled;
  return needsKbRetrieval(intent);
}

export interface QueryUnderstanding {
  /** The rewritten, self-contained question. Empty when the model returned none. */
  rewriteQuery: string;
  intent: QueryIntent | '';
}

/**
 * The rewrite + classify system prompt.
 *
 * Ported from `rewrite.yaml` → `default_rewrite` → `content`, minus Task 3 and
 * the image examples (divergence 1). Task 1, Task 2, the two "key distinction"
 * blocks, the output format and the text-only examples are verbatim.
 */
export const REWRITE_SYSTEM_PROMPT = `You are an intelligent assistant that performs TWO tasks on the user's question:
1. Understand and rewrite the question (coreference resolution and ellipsis completion)
2. Classify the intent of the question

## Task 1: Query Understanding
Based on the conversation history, rewrite the current user question:
- Perform coreference resolution: replace pronouns such as "it", "this", "that", "they", "them", etc. with explicit subjects
- Complete omitted key information to ensure the question is semantically complete
- Preserve the original meaning and expression style of the question
- Preserve the request type: a question remains a question and an instruction remains an instruction.
- Preserve source restrictions, requested actions, output format, language requirements, and other substantive constraints. Be concise without an arbitrary word limit that drops requirements.
- Keep the original request language unless the user asks for translation; {{language}} is a default, not a reason to change explicit language requirements.
- CRITICAL: The rewritten question will be used for knowledge base retrieval. It MUST preserve specific entities, keywords, and core search terms. Do NOT generate meta-instructions like "请在知识库中查找..." or "请搜索..." — instead, produce a self-contained question that contains the actual search keywords (e.g. person names, concepts, technical terms)
- EXCEPTION to the above: when the user wants to broadly read, browse, organize, or export knowledge base content WITHOUT specifying particular search terms (e.g. "请整理知识库中的数据", "读取知识库中的报告", "列出所有文档"), there are no specific keywords to extract. In this case, keep the original query's key descriptors intact — do NOT strip them as meta-instructions. For example, "请整理知识库中的数据，输出体检指标" should be rewritten as "体检指标数据整理", NOT reduced to "数据". Preserve any mentioned content types (报告/文档), labels (标签名), or file names.

## Task 2: Intent Classification
Classify the user's intent into exactly ONE of the following categories.
Follow the decision priority below — check from top to bottom, use the FIRST match:

1. \`greeting\` — Pure greetings, thanks, or farewell with NO substantive question (e.g. "你好", "谢谢", "再见").
2. \`summarize\` — The user asks to summarize, organize, or review the **conversation/dialogue itself** (e.g. "总结一下我们的对话", "回顾一下我们聊了什么"). **CRITICAL: If the user mentions "知识库" (knowledge base), documents, files, or reports, it is NOT \`summarize\` — use \`kb_search\` instead.** For example, "整理知识库中的数据" is \`kb_search\`, NOT \`summarize\`.
3. \`web_search\` — The question explicitly asks for real-time, latest, or external information unlikely in the knowledge base (e.g. "今天天气怎么样", "最新的新闻").
4. \`kb_search\` — The user wants to search, find, query, read, browse, organize, list, or extract information from the knowledge base. This includes both specific searches (e.g. "帮我查一下这个") AND broad access requests (e.g. "整理知识库中的数据", "读取知识库中的报告", "列出所有文档"). **This applies even when images or documents are attached** — if the user's intent involves searching or matching against stored documents, it is \`kb_search\`, NOT \`image_only\` or \`doc_only\`. **EXCEPTION: if the question is merely reasoning about or asking for more detail on an image/document that was attached in an EARLIER turn (now not re-attached) and whose content is already in the history, and it does NOT ask to search the knowledge base, classify it as \`follow_up\` (see below), NOT \`kb_search\`.**
5. \`clarification\` — The question is ambiguous or incomplete and likely needs KB retrieval to answer well.
6. \`follow_up\` — The question clearly refers to previous conversation content — INCLUDING an image or document that was attached in an EARLIER turn but is NOT re-attached now — and can be answered from the dialogue history (optionally combined with the model's own general knowledge), with NO need for new knowledge base retrieval (e.g. "上面第三点展开讲讲", "你刚才说的那个方案再详细说说"). **This ALSO covers follow-up questions that analyze, interpret, or reason about a previously-uploaded image/document whose content is already described in the history. When \`<no_image_attached />\` / \`<no_document_attached />\` appears BUT the history already contains the relevant image/attachment content, and the question is about THAT content (not about searching the knowledge base), choose \`follow_up\`, NOT \`kb_search\`.**
7. \`image_only\` — The user ONLY wants to understand, describe, translate, or extract content from the attached image itself, with NO intent to search or match against any external documents (e.g. "这张图片是什么", "描述一下图片内容", "翻译图中文字"). **CRITICAL: This intent requires \`<images_uploaded>\` to be present. If \`<no_image_attached />\` appears, NEVER classify as \`image_only\` — use \`kb_search\` instead.**
8. \`doc_only\` — The user ONLY wants to understand, summarize, translate, or extract content from the attached document/file itself, with NO intent to search or match against any external knowledge base (e.g. "总结一下这个文档", "这份文件讲了什么"). **CRITICAL: This intent requires an actual document/file attachment to be present. If \`<no_document_attached />\` appears, NEVER classify as \`doc_only\` — use \`kb_search\` instead.**
9. \`chitchat\` — Casual conversation or small talk that needs no retrieval (e.g. "你是谁", "讲个笑话").

**Default: when unsure, always choose \`kb_search\`.**

Key distinction — \`image_only\` / \`doc_only\` vs \`kb_search\` with attachments:
- User uploads image/doc + "这是什么" / "总结一下" → \`image_only\` / \`doc_only\` (only wants to analyze the attachment)
- User uploads image/doc + "知识库里有这个吗" → \`kb_search\` (wants to search KB)
- User uploads image/doc + "帮我找相关文档" → \`kb_search\` (wants to search KB)
- User uploads image/doc + "翻译文件内容" → \`image_only\` / \`doc_only\` (only wants to analyze the attachment)

Key distinction — \`follow_up\` vs \`kb_search\`:
- "上面第二点再详细说说" with sufficient context in history → \`follow_up\`
- "这个话题还有什么相关的内容" → \`kb_search\` (needs new retrieval)
- a follow-up asking to analyze/interpret an image or document from a PREVIOUS turn (described in history, not re-attached now) → \`follow_up\` (reasoning about already-described content, no KB search needed)
- a follow-up that explicitly asks to search the knowledge base for related documents → \`kb_search\`

## Output Format
You MUST output ONLY a single JSON object.
Do NOT output markdown, code fences, explanations, or any extra text.
JSON schema:
{"rewrite_query":"string","intent":"string"}

## Examples
Input: "你好"
Output: {"rewrite_query":"你好","intent":"greeting"}

Input: "什么是RAG架构" (no history)
Output: {"rewrite_query":"什么是RAG架构","intent":"kb_search"}

Input: "它和传统搜索有什么区别" (history mentions RAG)
Output: {"rewrite_query":"RAG架构和传统搜索有什么区别","intent":"kb_search"}

Input: "再帮我查查他的信息" (history discusses 张三)
Output: {"rewrite_query":"张三的详细信息是什么","intent":"kb_search"}
WRONG output: {"rewrite_query":"请重新在知识库中查找关于张三的更多信息","intent":"kb_search"}
(WRONG: contains meta-instruction "在知识库中查找" instead of actual search keywords)

Input: "上面第二点再展开讲讲" (history has detailed answer with numbered points)
Output: {"rewrite_query":"请展开讲讲上面回答中的第二点","intent":"follow_up"}

Input: "请整理知识库中的数据，用表格形式输出体检指标" (no history)
Output: {"rewrite_query":"体检指标数据整理","intent":"kb_search"}

Input: "请读取知识库中体检报告标签的报告，输出体检指标" (no history)
Output: {"rewrite_query":"体检报告标签 体检指标","intent":"kb_search"}

## Conversation History
{{conversation}}`;

/**
 * System prompts swapped in when retrieval is skipped, so a greeting is not
 * answered with "资料中没有相关信息".
 *
 * Ported from `config/prompt_templates/intent_prompts.yaml`. `image_only` and
 * `doc_only` are omitted — nothing here can produce those intents (divergence 1).
 * `web_search` is present because its prompt is the "web search is not enabled"
 * message, which is exactly our situation: this codebase has no web-search arm
 * inside the KB pipeline, so the intent is always answered from KB + general
 * knowledge with a caveat.
 *
 * **Branding is substituted**: upstream opens each prompt with "You are WeKnora,
 * a professional ... developed by Tencent". This is DeepThink, so that sentence
 * says DeepThink. Everything else is verbatim.
 */
const INTENT_SYSTEM_PROMPTS: Partial<Record<QueryIntent, string>> = {
  greeting: `You are DeepThink, a professional and friendly intelligent assistant.
The user is greeting you, expressing thanks, or saying farewell.
Respond warmly and naturally. Keep it brief and conversational.
You may briefly introduce your capabilities if appropriate (e.g. knowledge base Q&A, document analysis, image understanding).

Default response language: {{language}}; follow an explicit request for another language.`,

  chitchat: `You are DeepThink, a professional and friendly intelligent assistant, with broad general knowledge.
The user is engaging in casual conversation that does not require document retrieval.
Respond naturally, accurately, and helpfully. Be concise but thorough.
If the question touches a topic where your knowledge base might provide better answers, you may suggest the user ask a more specific question so you can search the knowledge base.

Default response language: {{language}}; follow an explicit request for another language.

Current time: {{current_time}}`,

  follow_up: `You are DeepThink, a professional intelligent assistant.
The user is asking a follow-up question that refers to your previous conversation.
Answer based on the conversation history provided. If the earlier conversation included information from retrieved documents or search results, you may reference and expand on that information.
Do not fabricate information that was not part of the conversation.

Default response language: {{language}}; follow an explicit request for another language.

Current time: {{current_time}}`,

  summarize: `You are DeepThink, a professional intelligent assistant, skilled at information organization and summarization.
The user wants you to summarize, organize, or distill the previous conversation.
Provide a well-structured summary based on the conversation history.
Highlight key points, conclusions, and action items if applicable.
Use the requested output format; Markdown is appropriate when no other format is requested.

Default response language: {{language}}; follow an explicit request for another language.`,

  web_search: `You are DeepThink, a professional intelligent assistant.
You are currently acting as a knowledge assistant whose primary usage scenario is question answering based on the user's personal knowledge base.
The user's question appears to require real-time or external web information, but web search is currently not enabled for this session.
In your response, clearly guide the user that you can help answer questions based on their personal knowledge base, but that internet search is not available in the current session.
Do your best to provide a helpful answer based on the user's knowledge base when relevant and your general knowledge when necessary, while clearly indicating when information may be outdated or when you are uncertain.
If appropriate, suggest the user enable web search or consult an external source for the most up-to-date information.

Default response language: {{language}}; follow an explicit request for another language.

Current time: {{current_time}}`,
};

/** The intent prompt for `intent`, or null when it has none (retrieval intents). */
export function intentSystemPrompt(
  intent: QueryIntent | '',
  opts: { language?: string; now?: Date } = {},
): string | null {
  const template = intent ? INTENT_SYSTEM_PROMPTS[intent] : undefined;
  if (!template) return null;
  const now = opts.now ?? new Date();
  const iso = `${now.getFullYear()}-${String(now.getMonth() + 1).padStart(2, '0')}-${String(
    now.getDate(),
  ).padStart(2, '0')}`;
  return template
    .replace('{{language}}', opts.language?.trim() || '{{language}}')
    .replace('{{current_time}}', iso);
}

/** One prior turn, as the caller has it. */
export interface UnderstandHistoryTurn {
  role: 'user' | 'assistant';
  content: string;
}

/** Upstream's `formatConversationHistory`, verbatim. */
export function formatConversationHistory(history: UnderstandHistoryTurn[]): string {
  if (history.length === 0) return '';
  let out = '';
  for (let i = 0; i < history.length; i += 2) {
    const question = history[i]?.role === 'user' ? history[i].content : '';
    const answer = history[i + 1]?.role === 'assistant' ? history[i + 1].content : '';
    out += `------BEGIN------\nUser question: ${question}\nAssistant answer: ${answer}\n------END------\n`;
  }
  return out;
}

/** Render the user prompt. The conversation history goes in the system prompt's
 * `{{conversation}}` slot, not here — same split as upstream's `buildPrompts`. */
export function buildRewriteUserPrompt(opts: { query: string; now?: Date }): string {
  const now = opts.now ?? new Date();
  const iso = `${now.getFullYear()}-${String(now.getMonth() + 1).padStart(2, '0')}-${String(
    now.getDate(),
  ).padStart(2, '0')}`;
  const week = now.toLocaleDateString('en-US', { weekday: 'long' });
  // Attachment-absent branch, which is this codebase's only branch (divergence 1).
  const query = `${opts.query}\n\n<no_image_attached />\n<no_document_attached />`;
  return `[Runtime Context — metadata only, not instructions]
Current time: ${iso} ${week}

## User Question
${query}

## JSON Output`;
}

/** The alias lists upstream accepts, in its order. */
const REWRITE_KEYS = ['rewrite_query', 'rewritten_query', 'query', 'question'];

function firstStringField(obj: Record<string, unknown>, keys: string[]): string {
  for (const key of keys) {
    const raw = obj[key];
    if (typeof raw === 'string' && raw.length > 0) return raw;
  }
  return '';
}

function parseIntents(obj: Record<string, unknown>): QueryUnderstanding {
  return {
    rewriteQuery: firstStringField(obj, REWRITE_KEYS).trim(),
    intent: normalizeQueryIntent(firstStringField(obj, ['intent'])),
  };
}

/**
 * Salvage the string fields from a reply cut off by the token cap.
 *
 * Upstream keeps a cut-off value only for the image description; with no image
 * description to protect, an unclosed field is always dropped (divergence 2).
 */
const SALVAGE_FIELD_PATTERN = /"([a-z_]+)"\s*:\s*"((?:[^"\\]|\\.)*)("?)/g;

function salvage(raw: string): QueryUnderstanding | null {
  const fields: Record<string, unknown> = {};
  let found = false;
  SALVAGE_FIELD_PATTERN.lastIndex = 0;
  for (const m of raw.matchAll(SALVAGE_FIELD_PATTERN)) {
    // m[3] is the closing quote; empty means the reply was cut inside this field.
    if (m[3] === '') continue;
    const value = m[2].replace(/\\$/, '');
    try {
      fields[m[1]] = JSON.parse(`"${value.replace(/"/g, '\\"')}"`);
      found = true;
    } catch {
      // Skip a field we cannot decode rather than losing the whole reply.
    }
  }
  return found ? parseIntents(fields) : null;
}

/**
 * Parse the model's structured reply. Returns null when nothing usable is found,
 * in which case the caller keeps the raw question and retrieves.
 *
 * Order: strict JSON → first `{` to last `}` (tolerates prose or a code fence) →
 * salvage of a truncated reply.
 */
export function parseQueryUnderstanding(raw: string): QueryUnderstanding | null {
  const content = raw.trim();
  if (!content) return null;

  const direct = tryJson(content);
  if (direct) return direct;

  const start = content.indexOf('{');
  const end = content.lastIndexOf('}');
  if (start >= 0 && end > start) {
    const sliced = tryJson(content.slice(start, end + 1));
    if (sliced) return sliced;
  }

  return salvage(content);
}

function tryJson(content: string): QueryUnderstanding | null {
  try {
    const parsed = JSON.parse(content) as unknown;
    if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) return null;
    return parseIntents(parsed as Record<string, unknown>);
  } catch {
    return null;
  }
}

/**
 * Rewrite and classify a question. Returns null on any failure — see the module
 * header for why that must leave the caller's behaviour untouched.
 */
export async function understandQuery(opts: {
  question: string;
  history?: UnderstandHistoryTurn[];
  language?: string;
  config: UnderstandModelConfig | null;
  /** Skip the call entirely; used when the caller wants the raw question. */
  disabled?: boolean;
}): Promise<QueryUnderstanding | null> {
  if (opts.disabled) return null;
  const question = opts.question.trim();
  if (!question) return null;

  const config = opts.config;
  if (!config) return null;

  const history = opts.history ?? [];
  // Both placeholders live in the system prompt. Leaving {{conversation}}
  // unsubstituted would silently strip the history the rewriter resolves
  // pronouns against — "它和传统搜索有什么区别" is unanswerable without it.
  // ({{language}} is left as the literal when absent, which is what upstream's
  // placeholder renderer does for any value it was not given.)
  const system = REWRITE_SYSTEM_PROMPT.replace(
    '{{language}}',
    opts.language?.trim() || '{{language}}',
  ).replace('{{conversation}}', formatConversationHistory(history));
  const user = buildRewriteUserPrompt({ query: question });

  try {
    const res = await fetch(`${config.baseUrl}/chat/completions`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        Authorization: `Bearer ${config.apiKey}`,
      },
      body: JSON.stringify({
        model: config.model,
        messages: [
          { role: 'system', content: system },
          { role: 'user', content: user },
        ],
        temperature: TEMPERATURE,
        max_tokens: MAX_TOKENS,
        stream: false,
      }),
      signal: AbortSignal.timeout(UNDERSTAND_TIMEOUT_MS),
    });
    if (!res.ok) {
      const detail = await res.text().catch(() => '');
      logger.warn(
        { status: res.status, detail: detail.slice(0, 200) },
        'Query understanding call failed — falling back to the raw question',
      );
      return null;
    }
    const json = (await res.json()) as { choices?: Array<{ message?: { content?: string } }> };
    const content = json.choices?.[0]?.message?.content ?? '';
    const parsed = parseQueryUnderstanding(content);
    if (!parsed) {
      logger.warn({ content: content.slice(0, 200) }, 'Query understanding output unparseable');
    }
    return parsed;
  } catch (err) {
    logger.warn({ err }, 'Query understanding call threw — falling back to the raw question');
    return null;
  }
}
