import { query as sdkQuery } from '@anthropic-ai/claude-agent-sdk';
import { logger } from './logger.js';
import { isSupervisorEnabled } from './supervisor-config.js';

const SUPERVISOR_TIMEOUT_MS = 60_000;

export interface SupervisorDecision {
  action: 'clarify' | 'delegate' | 'auto' | 'accept' | 'retry';
  instruction?: string;
  question?: string;
  reason?: string;
}

/**
 * Ask the Supervisor SubAgent to decide how to handle a user message.
 * Returns the decision or null if the call fails.
 *
 * The Supervisor is a lightweight intent parser — it does NOT call tools.
 * It outputs strict JSON deciding: clarify (ask user), delegate (forward
 * original), or auto (rewrite instruction).
 */
export async function runSupervisorPreDispatch(
  userMessage: string,
  userLanguage: string,
): Promise<SupervisorDecision | null> {
  const prompt = [
    '用户将以下任务托管给你（Supervisor）。请判断如何处理。',
    '',
    `用户语言：${userLanguage}`,
    '',
    '【用户消息】',
    userMessage.slice(0, 4000),
    '',
    '请输出严格 JSON（不要 markdown 代码块）：',
    '{"action":"clarify"|"delegate"|"auto","instruction"?:string,"question"?:string}',
    '- clarify: 消息模糊，向用户提问。question 字段必填。',
    '- delegate: 意图清晰，原样转发。instruction 字段填原消息精简版。',
    '- auto: 意图清晰但可优化表达，instruction 字段填你重写的指令。',
  ].join('\n');

  try {
    const raw = await sdkQuery({
      prompt,
      options: {
        model: process.env.SUPERVISOR_MODEL || undefined,
        maxTurns: 1,
        systemPrompt: '',
      },
    });
    const text = typeof raw === 'string' ? raw : (raw as any)?.text ?? '';
    return parseDecision(text);
  } catch (err) {
    logger.error({ err }, 'Supervisor pre-dispatch failed');
    return null;
  }
}

export function parseDecision(raw: string): SupervisorDecision | null {
  const cleaned = raw.replace(/```json\s*/gi, '').replace(/```\s*$/g, '').trim();
  const start = cleaned.indexOf('{');
  const end = cleaned.lastIndexOf('}');
  if (start < 0 || end < 0 || end <= start) return null;
  try {
    const parsed = JSON.parse(cleaned.slice(start, end + 1));
    const action = parsed.action as SupervisorDecision['action'];
    if (action !== 'clarify' && action !== 'delegate' && action !== 'auto') return null;
    return {
      action,
      instruction: parsed.instruction ? String(parsed.instruction).slice(0, 4000) : undefined,
      question: parsed.question ? String(parsed.question).slice(0, 2000) : undefined,
    };
  } catch {
    return null;
  }
}

export async function isChatSupervisorEnabled(chatJid: string): Promise<boolean> {
  return isSupervisorEnabled(chatJid);
}

export { SUPERVISOR_TIMEOUT_MS };
