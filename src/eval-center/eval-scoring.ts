// DeepThink Eval Center — multi-dimension scoring engine
// Deterministic scorer (reuses harness-eval scoreAssertion patterns) +
// LLM-as-Judge (CoT, multi-dim 1-5) + weighted aggregation with confidence compensation.

import { sdkQuery } from '../sdk-query.js';
import { logger } from '../logger.js';
import { listTraceSpans, getAgentTraceByResult } from './eval-db.js';
import type { RubricDimension, RubricVersionRow, TestCaseRow } from './eval-types.js';

// ==================== Deterministic assertions ====================
// Reuse the 7 sync assertion kinds from harness-eval. Inlined here to keep
// eval-center self-contained (same semantics, pure functions).

export type AssertionKind =
  | 'contains' | 'not_contains' | 'regex' | 'no_error'
  | 'json_schema' | 'json_path' | 'numeric_range' | 'tool_call_match';

export interface DetAssertion {
  kind: AssertionKind | string;
  value?: string;
  operator?: 'equals' | 'contains' | 'exists';
  expected?: string;
  min?: number;
  max?: number;
  /** for tool_call_match: expected tool name sequence */
  tool_names?: string[];
}

export function scoreDetAssertion(a: DetAssertion, responseText: string, hadError: boolean): { pass: boolean; detail: string } {
  switch (a.kind) {
    case 'contains': {
      const pass = !hadError && responseText.includes(a.value ?? '');
      return { pass, detail: `contains "${a.value?.slice(0, 60)}": ${pass ? 'HIT' : 'MISS'}` };
    }
    case 'not_contains': {
      const pass = !responseText.includes(a.value ?? '');
      return { pass, detail: `not_contains "${a.value?.slice(0, 60)}": ${pass ? 'OK' : 'VIOLATED'}` };
    }
    case 'regex': {
      try {
        const re = new RegExp(a.value ?? '');
        const pass = re.test(responseText);
        return { pass, detail: `regex /${(a.value ?? '').slice(0, 60)}/: ${pass ? 'MATCH' : 'NO MATCH'}` };
      } catch (e) {
        return { pass: false, detail: `regex invalid: ${(e as Error).message}` };
      }
    }
    case 'no_error': {
      return { pass: !hadError, detail: `no_error: ${!hadError ? 'OK' : 'HAD ERROR'}` };
    }
    case 'json_schema': {
      try {
        const schema = JSON.parse(a.value ?? '{}');
        const data = JSON.parse(responseText);
        const ok = validateJsonSchema(data, schema);
        return { pass: ok, detail: `json_schema: ${ok ? 'VALID' : 'INVALID'}` };
      } catch (e) {
        return { pass: false, detail: `json_schema parse error: ${(e as Error).message}` };
      }
    }
    case 'json_path': {
      try {
        const data = JSON.parse(responseText);
        const val = getByPath(data, a.value ?? '');
        const exp = a.expected ?? null;
        let pass = false;
        if (a.operator === 'exists') pass = val !== undefined;
        else if (a.operator === 'contains') pass = val != null && String(val).includes(String(exp));
        else pass = val != null && String(val) === String(exp);
        return { pass, detail: `json_path ${a.value} ${a.operator ?? 'equals'} ${exp}: ${pass ? 'OK' : 'FAIL'}` };
      } catch (e) {
        return { pass: false, detail: `json_path error: ${(e as Error).message}` };
      }
    }
    case 'numeric_range': {
      try {
        const data = JSON.parse(responseText);
        const num = a.value ? Number(getByPath(data, a.value)) : Number(responseText);
        if (Number.isNaN(num)) return { pass: false, detail: `numeric_range: not a number` };
        const okMin = a.min === undefined ? true : num >= a.min;
        const okMax = a.max === undefined ? true : num <= a.max;
        const pass = okMin && okMax;
        return { pass, detail: `numeric_range [${a.min ?? '-∞'}, ${a.max ?? '+∞'}] val=${num}: ${pass ? 'IN' : 'OUT'}` };
      } catch (e) {
        return { pass: false, detail: `numeric_range error: ${(e as Error).message}` };
      }
    }
    case 'tool_call_match': {
      // evaluated externally with trace spans; placeholder here
      return { pass: false, detail: 'tool_call_match requires trace context' };
    }
    default:
      return { pass: false, detail: `unknown assertion kind: ${a.kind}` };
  }
}

// Minimal JSON Schema validator (subset: type, required, properties, items, enum)
function validateJsonSchema(data: any, schema: any): boolean {
  if (!schema || typeof schema !== 'object') return true;
  if (schema.type) {
    const t = schema.type;
    if (t === 'object' && (typeof data !== 'object' || Array.isArray(data) || data === null)) return false;
    if (t === 'array' && !Array.isArray(data)) return false;
    if (t === 'string' && typeof data !== 'string') return false;
    if (t === 'number' && typeof data !== 'number') return false;
    if (t === 'boolean' && typeof data !== 'boolean') return false;
  }
  if (schema.enum && !schema.enum.includes(data)) return false;
  if (schema.required && Array.isArray(schema.required) && typeof data === 'object' && data !== null) {
    for (const k of schema.required) if (!(k in data)) return false;
  }
  if (schema.properties && typeof data === 'object' && data !== null && !Array.isArray(data)) {
    for (const [k, sub] of Object.entries(schema.properties)) {
      if (k in data && !validateJsonSchema(data[k], sub)) return false;
    }
  }
  if (schema.items && Array.isArray(data)) {
    for (const item of data) if (!validateJsonSchema(item, schema.items)) return false;
  }
  return true;
}

function getByPath(obj: any, path: string): any {
  if (!path) return obj;
  return path.replace(/^\$./, '').split('.').reduce((acc, k) => (acc == null ? acc : acc[k]), obj);
}

// ==================== LLM-as-Judge ====================

export interface JudgeScore {
  scores: Record<string, number>;     // dim name -> raw score (1..scale)
  reasoning: string;
  confidence: Record<string, number>; // dim name -> 0..1 (1 = judge scored it)
}

const DEFAULT_JUDGE_PROMPT = `You are an expert evaluator for AI agents. Score the agent's response on each dimension using the provided scale (1..{{scale}}).

For each dimension:
1. Briefly reason about the agent's response against the criteria (1-2 sentences).
2. Give an integer score.

Return STRICT JSON only, no markdown fences:
{
  "reasoning": "<overall reasoning>",
  "scores": { "<dim_name_1>": <int>, "<dim_name_2>": <int> }
}

Agent task input:
{{input}}

Expected output (for reference):
{{expected}}

Agent actual output:
{{output}}

Dimensions:
{{dimensions}}

Context:
{{context}}`;

export async function llmJudgeScore(input: {
  rubric: RubricVersionRow;
  testCase: TestCaseRow;
  agentOutput: string;
  judgeModel?: string | null;
}): Promise<JudgeScore> {
  const dims = rubricDimensions(input.rubric);
  const scale = (dims[0]?.scale ?? 5);
  const dimsText = dims.map(d =>
    `- ${d.name} (weight ${d.weight}, scale 1..${d.scale ?? 5}): ${d.description ?? ''}${d.judge_criteria ? ` [criteria: ${d.judge_criteria}]` : ''}`,
  ).join('\n');
  const prompt = (input.rubric.judge_prompt || DEFAULT_JUDGE_PROMPT)
    .replace('{{scale}}', String(scale))
    .replace('{{input}}', input.testCase.input_text)
    .replace('{{expected}}', input.testCase.expected_output ?? '(none)')
    .replace('{{output}}', input.agentOutput ?? '(empty)')
    .replace('{{dimensions}}', dimsText)
    .replace('{{context}}', JSON.stringify(input.testCase.context ?? {}));

  const model = input.judgeModel || input.rubric.judge_model || undefined;
  const resp = await sdkQuery(prompt, { model: model ?? undefined, timeout: 60_000 });
  return parseJudgeResult(resp ?? '', dims);
}

function parseJudgeResult(text: string, dims: RubricDimension[]): JudgeScore {
  // Extract first {...} JSON
  const m = text.match(/\{[\s\S]*\}/);
  const scores: Record<string, number> = {};
  const confidence: Record<string, number> = {};
  let reasoning = '';
  if (m) {
    try {
      const obj = JSON.parse(m[0]);
      reasoning = obj.reasoning ?? '';
      const raw = obj.scores ?? {};
      for (const d of dims) {
        const v = raw[d.name];
        if (typeof v === 'number') { scores[d.name] = v; confidence[d.name] = 1; }
        else { scores[d.name] = 0; confidence[d.name] = 0; }
      }
      return { scores, reasoning, confidence };
    } catch {
      // fall through
    }
  }
  reasoning = text.slice(0, 500);
  for (const d of dims) { scores[d.name] = 0; confidence[d.name] = 0; }
  return { scores, reasoning, confidence };
}

// ==================== Tool call match (trace-based) ====================

export async function scoreToolCallMatch(
  evalResultId: string, expectedToolNames: string[],
): Promise<{ pass: boolean; detail: string; actualTools: string[] }> {
  if (!expectedToolNames || expectedToolNames.length === 0) {
    return { pass: true, detail: 'no expected tool calls specified', actualTools: [] };
  }
  const trace = await getAgentTraceByResult(evalResultId);
  if (!trace) return { pass: false, detail: 'no trace found', actualTools: [] };
  const spans = await listTraceSpans(trace.id);
  const actualTools = spans.filter(s => s.span_type === 'tool_call').map(s => s.name ?? '').filter(Boolean);
  const pass = JSON.stringify(actualTools) === JSON.stringify(expectedToolNames) ||
    expectedToolNames.every(t => actualTools.includes(t));
  return { pass, detail: `expected [${expectedToolNames.join(',')}] actual [${actualTools.join(',')}]`, actualTools };
}

// ==================== Aggregation (confidence compensation) ====================

export interface DimensionScoreDetail {
  score: number;          // normalized 0..100
  raw: number;            // raw score
  scale: number;
  weight: number;
  confidence: number;     // 0..1
  reasoning?: string;
}

export interface CaseScore {
  dimension_scores: Record<string, any>;     // dim name -> detail
  overall_score: number;                      // 0..100
  is_pass: boolean;
  judge_reasoning: string;
  assertion_results: any[];
}

export function aggregateScore(
  dimDetails: DimensionScoreDetail[], passThreshold: number,
): { overall_score: number } {
  // Confidence-compensated weighted mean:
  // OverallScore = Σ(w × S_norm × conf) / Σ(w × conf)
  let num = 0, den = 0;
  for (const d of dimDetails) {
    num += d.weight * d.score * d.confidence;
    den += d.weight * d.confidence;
  }
  const overall = den > 0 ? num / den : 0;
  return { overall_score: Math.round(overall * 100) / 100 };
}

function rubricDimensions(rubric: RubricVersionRow): RubricDimension[] {
  const dims = (rubric.dimensions as any) as RubricDimension[];
  return Array.isArray(dims) ? dims : [];
}

export function normalizeScore(raw: number, scale: number): number {
  if (scale <= 0) return 0;
  return (raw / scale) * 100;
}

// Score a single case: combine deterministic + llm_judge dimensions
export async function scoreCase(input: {
  rubric: RubricVersionRow;
  testCase: TestCaseRow;
  agentOutput: string;
  hadError: boolean;
  evalResultId: string;
  judgeModel?: string | null;
}): Promise<CaseScore> {
  const dims = rubricDimensions(input.rubric);
  const dimDetails: DimensionScoreDetail[] = [];
  const dimensionScores: Record<string, any> = {};
  const assertionResults: any[] = [];
  let judgeReasoning = '';
  let judgeResult: JudgeScore | null = null;

  // Run LLM judge once if any dim needs it.
  // A dim needs the judge unless it is explicitly deterministic OR it has
  // assertions (presence of assertions implies deterministic scoring, so a
  // rubric that omits `scorer` but provides `assertions` still works).
  const needsJudge = dims.some(d => {
    const hasAssertions = (d.assertions?.length ?? 0) > 0;
    const scorer = d.scorer ?? (hasAssertions ? 'deterministic' : 'llm_judge');
    return scorer === 'llm_judge';
  });
  if (needsJudge) {
    try {
      judgeResult = await llmJudgeScore({
        rubric: input.rubric, testCase: input.testCase,
        agentOutput: input.agentOutput, judgeModel: input.judgeModel,
      });
      judgeReasoning = judgeResult.reasoning;
    } catch (e) {
      logger.warn({ err: e }, 'LLM judge failed');
    }
  }

  for (const d of dims) {
    const scale = d.scale ?? 5;
    // If `scorer` is omitted, infer from presence of assertions: a dimension
    // with assertions is deterministic; otherwise it is LLM-judged.
    const hasAssertions = (d.assertions?.length ?? 0) > 0;
    const scorer = d.scorer ?? (hasAssertions ? 'deterministic' : 'llm_judge');
    let raw = 0, confidence = 0; let reasoning: string | undefined;

    if (scorer === 'deterministic') {
      const assertions: DetAssertion[] = d.assertions ?? [];
      if (assertions.length > 0) {
        let passed = 0;
        for (const a of assertions) {
          let r: { pass: boolean; detail: string };
          if (a.kind === 'tool_call_match') {
            const tm = await scoreToolCallMatch(input.evalResultId, a.tool_names ?? []);
            r = { pass: tm.pass, detail: tm.detail };
          } else {
            r = scoreDetAssertion(a, input.agentOutput, input.hadError);
          }
          assertionResults.push({ dim: d.name, ...a, pass: r.pass, detail: r.detail });
          if (r.pass) passed++;
        }
        raw = (passed / assertions.length) * scale;
        confidence = 1;
        reasoning = `${passed}/${assertions.length} assertions passed`;
      } else {
        confidence = 0;
      }
    } else {
      // llm_judge
      if (judgeResult) {
        const s = judgeResult.scores[d.name];
        const c = judgeResult.confidence[d.name] ?? 0;
        raw = typeof s === 'number' ? s : 0;
        confidence = c;
        reasoning = `judge score ${raw}/${scale}`;
      } else {
        confidence = 0;
      }
    }

    const norm = normalizeScore(raw, scale);
    const detail: DimensionScoreDetail = {
      score: norm, raw, scale, weight: d.weight ?? 0, confidence, reasoning,
    };
    dimDetails.push(detail);
    dimensionScores[d.name] = detail;
  }

  const { overall_score } = aggregateScore(dimDetails, input.rubric.pass_threshold);
  const isPass = overall_score >= (input.rubric.pass_threshold * 100);
  return {
    dimension_scores: dimensionScores,
    overall_score,
    is_pass: isPass,
    judge_reasoning: judgeReasoning,
    assertion_results: assertionResults,
  };
}
