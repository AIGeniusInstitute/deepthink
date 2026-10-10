// FLM LLM 轨道（PRD AC-F3.2）。
//
// 为什么单独一个文件：`flm-evaluate.ts` 的设计约束是**纯函数、无 IO**，全部单测都靠
// 这个约束做到毫秒级、无网络。LLM 调用是 IO 且依赖外部模型，塞进去会破坏那条约束。
// 所以这里只做一件事：把 EvalContext 拼成提示词、调一次模型、解析成 outcome 判定，
// 交给 `evaluateTask({ llmVerdict })` 去与规则轨比对。
//
// 失败一律返回 null（降级为单轨）而不是抛异常：LLM 轨是可选叠加，
// 「模型不可用」绝不能阻断评价，也不该让 `evaluator` 字段撒谎说跑过双轨。

import { sdkQuery } from '../sdk-query.js';
import { logger } from '../logger.js';
import { isFail, type EvalContext } from './flm-evaluate.js';
import type { Outcome } from './flm-types.js';

/** 与规则轨比对用的判定结果。 */
export interface LlmVerdict {
  outcome: Outcome;
  reason: string;
}

const PROMPT_HEAD = `你是任务结果评审员。下面给出一次智能体任务执行的结构化摘要。
请判定这次任务的结果属于以下三档之一：
- achieved：目标达成，输出完整可用
- partial：部分达成，有缺失或需人工补充
- failed：未达成，或产出不可用

只输出一个 JSON 对象，形如 {"outcome":"achieved","reason":"一句话依据"}，
不要输出任何其他文字。`;

function summarize(ctx: EvalContext): string {
  // 用模块统一的谓词，别在这里再手写一份。原先 toolCalls 用的是 `status !== 'success'`，
  // 把 `running`（尚未结束）也算成"失败"，与规则轨的 isFail 口径对不上。
  const failedNodes = ctx.nodes.filter((n) => isFail(n.status));
  const failedCalls = ctx.toolCalls.filter((c) => isFail(c.status));
  const lines: string[] = [
    `任务 ID：${ctx.taskId}`,
    `轨迹节点数：${ctx.nodes.length}（失败 ${failedNodes.length}）`,
    `工具调用数：${ctx.toolCalls.length}（失败 ${failedCalls.length}）`,
    `采集到的事件数：${ctx.events.length}`,
  ];

  if (ctx.nodes.length > 0) {
    lines.push('节点标题（最多 20 条）：');
    for (const n of ctx.nodes.slice(0, 20)) {
      lines.push(`  - [${n.nodeType ?? 'node'}] ${n.title ?? '(无标题)'} · ${n.status ?? 'unknown'}`);
    }
  }
  if (failedCalls.length > 0) {
    lines.push('失败的工具调用（最多 10 条）：');
    for (const c of failedCalls.slice(0, 10)) {
      lines.push(`  - ${c.toolName ?? '(未知工具)'} · ${c.status ?? 'unknown'}`);
    }
  }
  return lines.join('\n');
}

/** 解析模型输出里的第一个 JSON 对象。解析不出来就返回 null，不猜。 */
function parseVerdict(text: string): LlmVerdict | null {
  const match = text.match(/\{[\s\S]*\}/);
  if (!match) return null;
  try {
    const obj = JSON.parse(match[0]) as { outcome?: string; reason?: string };
    const outcome = obj.outcome;
    if (outcome !== 'achieved' && outcome !== 'partial' && outcome !== 'failed') return null;
    return { outcome, reason: typeof obj.reason === 'string' && obj.reason.trim() ? obj.reason.trim() : '（模型未给出依据）' };
  } catch {
    return null;
  }
}

/**
 * 跑一次 LLM 轨判定。模型不可用、超时、输出不可解析时返回 null。
 *
 * 返回 null 的语义是「LLM 轨没跑成」，调用方据此保持单轨并让 `evaluator='rule'` ——
 * 不能假装跑过双轨，否则人工复核队列里会出现根本不存在的"分歧"。
 */
export async function llmVerdictFor(ctx: EvalContext, timeoutMs = 45_000): Promise<LlmVerdict | null> {
  try {
    const prompt = `${PROMPT_HEAD}\n\n${summarize(ctx)}`;
    const raw = await sdkQuery(prompt, { timeout: timeoutMs });
    if (!raw) return null;
    return parseVerdict(raw);
  } catch (err) {
    logger.warn({ err: (err as Error).message?.slice(0, 200), taskId: ctx.taskId }, 'flm llm-judge failed');
    return null;
  }
}
