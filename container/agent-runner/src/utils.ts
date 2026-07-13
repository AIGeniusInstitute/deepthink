/**
 * Utility functions for DeepThink Agent Runner.
 *
 * Pure utility functions with no side effects or state dependencies.
 */

/**
 * Shorten a string to maxLen, appending "..." if truncated.
 */
export function shorten(input: string, maxLen = 180): string {
  if (input.length <= maxLen) return input;
  return `${input.slice(0, maxLen)}...`;
}

/**
 * Recursively redact sensitive fields (tokens, passwords, API keys, etc.)
 * from an object. Limits recursion depth to 3 levels.
 */
export function redactSensitive(input: unknown, depth = 0): unknown {
  if (depth > 3) return '[truncated]';
  if (input == null) return input;
  if (typeof input === 'string' || typeof input === 'number' || typeof input === 'boolean') {
    return input;
  }
  if (Array.isArray(input)) {
    return input.slice(0, 10).map((item) => redactSensitive(item, depth + 1));
  }
  if (typeof input === 'object') {
    const obj = input as Record<string, unknown>;
    const out: Record<string, unknown> = {};
    for (const [k, v] of Object.entries(obj)) {
      if (/(token|password|secret|api[_-]?key|authorization|cookie)/iu.test(k)) {
        out[k] = '[REDACTED]';
      } else {
        out[k] = redactSensitive(v, depth + 1);
      }
    }
    return out;
  }
  return '[unsupported]';
}

/**
 * Strip well-known secret patterns embedded inside tool input strings before
 * they ride out as `toolInputSummary` to every connected WebSocket client and
 * the persisted stream-event log.
 *
 * `redactSensitive` only matches sensitive *keys* — that's not enough for
 * Bash/curl/WebFetch where the actual command/url string carries a Bearer
 * token, api_key=, sk-…, ghp_…, etc. as inline content. We string-replace
 * those before truncating to 180 chars.
 */
export function redactInlineSecrets(value: string): string {
  // 长度兜底：超过 32KB 直接整段标记，跳过昂贵的多 regex 扫描。攻击者
  // 若用 prompt-injection 让 agent 跑出 60KB+ 的 toolInput（接近 schema
  // 上限），原 regex 在 lazy-prefix 下退化为 O(n^2)（10k char ≈ 16ms,
  // 60k ≈ 600ms），可被多次链式 tool-call 钉住单 agent CPU。
  if (value.length > 32 * 1024) {
    return '[REDACTED LARGE INPUT]';
  }
  return (
    value
      // OAuth bearer (case-insensitive)
      .replace(/\bbearer\s+[A-Za-z0-9._\-+/=]{8,}/gi, 'Bearer [REDACTED]')
      // basic auth in URLs (https://user:pass@host) — extend beyond http(s)
      // to cover postgres / mongodb / redis / mysql / ftp / ssh / git etc.
      // The DSN form `<scheme>://user:pass@host/...` is universal; restrict
      // the scheme to a reasonable identifier shape to avoid colon-rich text.
      .replace(/(\b[a-z][a-z0-9+.\-]{1,15}:\/\/[^\s\/:@]+:)[^\s@\/?#]+(@)/gi,
        '$1[REDACTED]$2')
      // key=value / key:value with explicit secret-shaped key. Anchor 不再
      // 用 lazy `[A-Za-z0-9_]*?` 兜底（O(n^2) ReDoS 源头），改成显式枚举
      // 常见前缀 + 限定长度。截止字符增加 ; , 拦多 cookie 行。
      .replace(
        /(?:^|[^A-Za-z0-9])((?:gh|github|gitlab|npm|access|refresh|auth|api)[_-]token|api[_-]?key|access[_-]?token|refresh[_-]?token|auth[_-]?token|x-api-key|authorization|password|secret|cookie|token|pat)\s*[:=]\s*["']?[^"'\s;,&]+/giu,
        (m, k) => {
          const prefix = m.startsWith(k) ? '' : m[0];
          return `${prefix}${k}=[REDACTED]`;
        },
      )
      // CLI 形态 `--token <value>` / `--api-key value` / `-H 'Authorization: …'`
      .replace(
        /(--?(?:api[_-]?key|access[_-]?token|refresh[_-]?token|token|secret|password|x-api-key))\s+(?!--)\S{4,}/gi,
        '$1 [REDACTED]',
      )
      // 主流厂商 token 前缀
      .replace(/\bsk-(?:ant-)?[A-Za-z0-9_\-]{16,}/g, '[REDACTED]')
      .replace(/\b(ghp|gho|ghu|ghs|ghr)_[A-Za-z0-9]{20,}/g, '[REDACTED]')
      .replace(/\bgithub_pat_[A-Za-z0-9_]{20,}/g, '[REDACTED]')
      .replace(/\bglpat-[A-Za-z0-9_\-]{20,}/g, '[REDACTED]')
      .replace(/\bxox[abeprs]-[A-Za-z0-9-]{10,}/g, '[REDACTED]')
      .replace(/\b(?:AKIA|ASIA)[0-9A-Z]{12,20}\b/g, '[REDACTED]')
      .replace(/\bAIza[0-9A-Za-z_\-]{35}/g, '[REDACTED]')
      .replace(/\bsk_(?:live|test)_[A-Za-z0-9]{16,}/g, '[REDACTED]')
      .replace(/\bSG\.[A-Za-z0-9_\-]{16,}\.[A-Za-z0-9_\-]{16,}/g, '[REDACTED]')
      .replace(/\bnpm_[A-Za-z0-9]{30,}/g, '[REDACTED]')
      // private key / pem 头标识，整段一路擦到 END 标记
      .replace(/-----BEGIN [A-Z ]+PRIVATE KEY-----[\s\S]*?-----END [A-Z ]+PRIVATE KEY-----/g, '[REDACTED PRIVATE KEY]')
  );
}

/**
 * Summarize tool input for display in stream events.
 * Extracts key fields (command, query, path, etc.) or serializes the object.
 */
export function summarizeToolInput(input: unknown): string | undefined {
  if (input == null) return undefined;

  if (typeof input === 'string') {
    return shorten(redactInlineSecrets(input.trim()));
  }

  if (typeof input === 'object') {
    const obj = input as Record<string, unknown>;
    const keyCandidates = ['command', 'query', 'path', 'pattern', 'prompt', 'url', 'name'];
    for (const key of keyCandidates) {
      const value = obj[key];
      if (typeof value === 'string' && value.trim()) {
        return `${key}: ${shorten(redactInlineSecrets(value.trim()))}`;
      }
    }
    try {
      const json = JSON.stringify(redactSensitive(obj));
      // Skip empty or trivial objects (e.g. {} at content_block_start)
      if (!json || json === '{}' || json === '[]') return undefined;
      return shorten(redactInlineSecrets(json));
    } catch {
      return undefined;
    }
  }

  return undefined;
}

/**
 * Summarize a tool_result block's content for streaming display.
 *
 * The SDK delivers tool results as either a plain string or an array of content
 * blocks ({type:'text'|'image'|...}). We flatten the text, redact inline secrets,
 * and clamp the length so the trace stays readable without dumping a 10K-line
 * bash output into the card. Returns undefined for empty / non-textual results.
 */
export function summarizeToolResult(content: unknown, maxLen = 400): string | undefined {
  let text: string | undefined;
  if (typeof content === 'string') {
    text = content;
  } else if (Array.isArray(content)) {
    text = content
      .map((b) => {
        if (typeof b === 'string') return b;
        if (b && typeof b === 'object') {
          const block = b as { type?: string; text?: string };
          if (block.type === 'text') return block.text ?? '';
          if (block.type === 'image') return '[image]';
        }
        return '';
      })
      .filter(Boolean)
      .join('\n');
  }
  const trimmed = text?.trim();
  if (!trimmed) return undefined;
  return shorten(redactInlineSecrets(trimmed), maxLen);
}

/**
 * Extract a skill name from Skill tool input.
 * Tries skillName, skill, name, command fields, then regex-matches leading slashes.
 */
export function extractSkillName(toolName: unknown, input: unknown): string | undefined {
  if (toolName !== 'Skill') return undefined;
  if (!input || typeof input !== 'object') return undefined;
  const obj = input as Record<string, unknown>;
  const raw =
    (typeof obj.skillName === 'string' && obj.skillName) ||
    (typeof obj.skill === 'string' && obj.skill) ||
    (typeof obj.name === 'string' && obj.name) ||
    (typeof obj.command === 'string' && obj.command) ||
    '';
  if (!raw) return undefined;
  const matched = raw.match(/\/([A-Za-z0-9._-]+)/);
  if (matched && matched[1]) return matched[1];
  return raw.replace(/^\/+/, '').trim() || undefined;
}

/**
 * Sanitize a string for use as a filename.
 * Lowercases, replaces non-alphanumeric characters with hyphens, trims, and limits length.
 */
export function sanitizeFilename(summary: string): string {
  return summary
    .toLowerCase()
    .replace(/[^\p{L}\p{N}]+/gu, '-')
    .replace(/^-+|-+$/g, '')
    .slice(0, 50);
}

/**
 * Generate a fallback conversation archive filename based on current time.
 */
export function generateFallbackName(): string {
  const time = new Date();
  return `conversation-${time.getHours().toString().padStart(2, '0')}${time.getMinutes().toString().padStart(2, '0')}`;
}

/**
 * 判定一个 subtype=success 的 SDK result 是否为「上游断流截断」的合成结果。
 *
 * 指纹来源（实测事故）：第三方网关在长文本生成中途断流时，SDK 收不到终结帧
 * （message_delta/message_stop + usage），只能把已缓冲的 partial 文本按
 * subtype=success 收口，此时 result.usage 的 input/output tokens 均为 0——
 * 而健康 turn 的 result.usage 恒为正（query 级累计值，且真实 turn 必产生
 * output tokens）。正文非空 + usage 双零 = 截断合成结果的确定性指纹。
 *
 * 保守起见 usage 缺失不判定为截断（避免误伤未知的 SDK 变体）；误报的代价是
 * 多发一次"请继续"的续写 turn（有次数上限），漏报的代价是半截回复被当成
 * 完整回复交付。
 */
export function isSuspectTruncatedStreamResult(
  usage: { input_tokens?: number; output_tokens?: number } | null | undefined,
  resultTextLength: number,
): boolean {
  if (resultTextLength <= 0) return false;
  if (!usage) return false;
  return (usage.input_tokens ?? 0) === 0 && (usage.output_tokens ?? 0) === 0;
}

/** AssistantTextTracker 处理的 content block 最小形状（SDK assistant 消息的 content 数组元素）。 */
export interface AssistantContentBlock {
  type: string;
  text?: string;
}

/**
 * Turn 内 assistant 文本分段追踪：把「工具调用之间的过程旁白」与「最后一次
 * 工具调用之后的最终回复」分开。
 *
 * SDK 把 assistant 输出按 tool_use 切成多条消息（text → tool_use → text → …）。
 * 旧实现把 turn 内所有 top-level text block 无分隔拼接为定稿正文，导致模型在
 * 每次工具调用前输出的过程叙述（"我先检查 X"、"现在打开 Y"）混进最终回复，
 * 且句子之间无缝粘连。本类按 content block 顺序维护：遇到 top-level tool_use
 * 时把已累积文本归入 narration（旁白，不进定稿正文）；turn 结束时
 * currentSegment 即最后一次工具调用之后的文本——与 SDK result 字段 /
 * Claude Code 的最终回复语义一致。
 */
export class AssistantTextTracker {
  private currentSegment = '';
  private narrationSegments: string[] = [];

  /**
   * 按顺序处理一条 top-level assistant 消息的 content blocks。
   * 返回该消息是否含文本（调用方据此更新 canonical uuid）。
   */
  addContentBlocks(blocks: AssistantContentBlock[]): boolean {
    let sawText = false;
    for (const block of blocks) {
      if (block.type === 'text' && typeof block.text === 'string' && block.text) {
        this.currentSegment += block.text;
        sawText = true;
      } else if (block.type === 'tool_use') {
        this.rotateSegment();
      }
    }
    return sawText;
  }

  private rotateSegment(): void {
    if (this.currentSegment.trim()) {
      this.narrationSegments.push(this.currentSegment);
    }
    this.currentSegment = '';
  }

  /**
   * 定稿正文选择链：最终段 → SDK result → 最后一段旁白。
   * 旁白兜底针对「模型以工具调用收尾」的 turn（如挂起序列的中间 turn 派完
   * 后台任务即停），此时最后一段旁白通常是对用户有意义的状态说明
   * （"三个调研任务已派出，等待完成"）。
   */
  pickFinalText(sdkResult: string | null | undefined): string | null {
    if (this.currentSegment.trim()) return this.currentSegment;
    if (sdkResult && sdkResult.trim()) return sdkResult;
    return this.narrationSegments.at(-1) ?? null;
  }

  /** mid-query follow-up 产生第二条 result 时与 turnId 一起重置。 */
  reset(): void {
    this.currentSegment = '';
    this.narrationSegments = [];
  }
}

/**
 * 解析当前时区名（IANA）。与主服务 src/config.ts 的 TIMEZONE 同一条 fallback 链
 * （agent-runner 是独立项目，无法 import src/，故在此复刻）。容器模式下 entrypoint
 * 注入了 TZ；host 模式可能没设 TZ，退回系统解析的时区，最后兜底 Asia/Shanghai。
 */
export function currentTimeZone(): string {
  return (
    process.env.TZ ||
    Intl.DateTimeFormat().resolvedOptions().timeZone ||
    'Asia/Shanghai'
  );
}

interface LocalParts {
  date: string; // YYYY-MM-DD
  time: string; // HH:mm:ss
  offset: string; // +08:00 / -05:00 / +00:00
}

function localDateTimeParts(d: Date, tz: string): LocalParts {
  const dtParts = new Intl.DateTimeFormat('en-CA', {
    timeZone: tz,
    year: 'numeric',
    month: '2-digit',
    day: '2-digit',
    hour: '2-digit',
    minute: '2-digit',
    second: '2-digit',
    hour12: false,
  }).formatToParts(d);
  const get = (t: string) => dtParts.find((p) => p.type === t)?.value ?? '';
  // en-CA + hour12:false 在午夜可能给出 '24'，归一到 '00'。
  let hour = get('hour');
  if (hour === '24') hour = '00';

  const offsetParts = new Intl.DateTimeFormat('en-US', {
    timeZone: tz,
    timeZoneName: 'longOffset',
  }).formatToParts(d);
  const offsetName =
    offsetParts.find((p) => p.type === 'timeZoneName')?.value ?? 'GMT+00:00';
  const m = offsetName.match(/GMT([+-]\d{2}:?\d{2})/);
  let offset = m ? m[1] : '+00:00';
  if (offset.length === 5) offset = `${offset.slice(0, 3)}:${offset.slice(3)}`; // +0800 -> +08:00

  return {
    date: `${get('year')}-${get('month')}-${get('day')}`,
    time: `${hour}:${get('minute')}:${get('second')}`,
    offset,
  };
}

/**
 * 当前时刻的本地 ISO-8601-with-offset 串 + 时区名，供注入 agent 上下文做相对时间推理。
 * 形如：2026-06-12T10:50:00+08:00 (Asia/Shanghai)
 */
export function formatLocalNow(d: Date = new Date()): string {
  const tz = currentTimeZone();
  const { date, time, offset } = localDateTimeParts(d, tz);
  return `${date}T${time}${offset} (${tz})`;
}

/**
 * 把一个 UTC ISO 串（如存储层的 next_run）转成本地时区的可读串，供回执/列表展示。
 * 形如：2026-06-12 10:50:00 (+08:00)。空/非法输入分别返回 'N/A' / 原样。
 */
export function formatIsoLocal(iso: string | null | undefined): string {
  if (!iso) return 'N/A';
  const d = new Date(iso);
  if (Number.isNaN(d.getTime())) return iso;
  const tz = currentTimeZone();
  const { date, time, offset } = localDateTimeParts(d, tz);
  return `${date} ${time} (${offset})`;
}
