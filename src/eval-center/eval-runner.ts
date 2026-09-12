// DeepThink Eval Center — eval run orchestrator
// Validates config → creates run → per case: evalQuery + scoreCase → aggregate.

import { getAgentDefinitionById } from '../db.js';
import { logger } from '../logger.js';
import {
  createEvalRun, updateEvalRun, getEvalRun, getEvalResult, createEvalResult, updateEvalResult,
  getDatasetVersion, getRubricVersion, listTestCases, createAgentTrace, updateAgentTrace,
} from './eval-db.js';
import { evalQuery } from './eval-query.js';
import { scoreCase } from './eval-scoring.js';
import type { EvalRunRow, EvalResultRow, RubricVersionRow, TestCaseRow } from './eval-types.js';

export interface StartEvalRunInput {
  projectId: string;
  datasetVersionId: string;
  rubricVersionId: string;
  agentId: string;             // agent_definition.id
  llmModel: string;
  modelParams?: any;
  rubricId?: string;
  createdBy: string;
  maxTurns?: number;
  judgeModel?: string | null;
}

export async function startEvalRun(input: StartEvalRunInput): Promise<EvalRunRow> {
  // 1. Validate dataset version is published
  const dv = await getDatasetVersion(input.datasetVersionId);
  if (!dv) throw new Error('dataset version not found');
  if (dv.status !== 'published') {
    throw new Error(`dataset version status is '${dv.status}', must be 'published' to run eval`);
  }
  // 2. Validate rubric version published
  const rv = await getRubricVersion(input.rubricVersionId);
  if (!rv) throw new Error('rubric version not found');
  if (rv.status !== 'published') {
    throw new Error(`rubric version status is '${rv.status}', must be 'published'`);
  }
  // 3. Resolve agent definition
  const agentDef = getAgentDefinitionById(input.agentId);
  if (!agentDef) throw new Error(`agent '${input.agentId}' not found`);
  const systemPrompt = agentDef.system_prompt || undefined;
  const model = input.llmModel || agentDef.model || undefined;
  const maxTurns = input.maxTurns ?? agentDef.max_turns ?? 1;

  // 4. Load cases
  const cases = await listTestCases(dv.id, { status: 'active' });
  if (cases.length === 0) throw new Error('no active test cases in dataset version');

  // 5. Create run
  const run = await createEvalRun({
    projectId: input.projectId, datasetVersionId: dv.id, rubricVersionId: rv.id,
    agentId: input.agentId, agentVersion: agentDef.updated_at,
    llmModel: model ?? 'default', modelParams: input.modelParams ?? {},
    configSnapshot: {
      dataset: { id: dv.id, version: dv.version, label: dv.version_label, hash: dv.content_hash },
      rubric: { id: rv.id, version: rv.version, label: rv.version_label },
      agent: { id: agentDef.id, name: agentDef.name, system_prompt_preview: (agentDef.system_prompt || '').slice(0, 200) },
      model: model ?? null, maxTurns, judgeModel: input.judgeModel ?? rv.judge_model,
    }, createdBy: input.createdBy,
  });
  await updateEvalRun(run.id, {
    status: 'running', started_at: new Date().toISOString(),
    total_cases: cases.length, completed_cases: 0, passed_cases: 0,
  });

  // 6. Run cases (async, but sequential for MVP — no concurrency needed)
  let passed = 0;
  let completed = 0;
  let scoreSum = 0;
  let scoreCount = 0;
  for (const tc of cases) {
    const result = await runOneCase({
      runId: run.id, testCase: tc, rubric: rv,
      systemPrompt, model, maxTurns, judgeModel: input.judgeModel ?? rv.judge_model,
    });
    completed++;
    if (result.is_pass) passed++;
    if (typeof result.overall_score === 'number') { scoreSum += result.overall_score; scoreCount++; }
    await updateEvalRun(run.id, { completed_cases: completed, passed_cases: passed });
  }

  // 7. Aggregate
  const overallScore = scoreCount > 0 ? Math.round((scoreSum / scoreCount) * 100) / 100 : 0;
  const passRate = cases.length > 0 ? Math.round((passed / cases.length) * 10000) / 10000 : 0;
  await updateEvalRun(run.id, {
    status: 'completed', completed_at: new Date().toISOString(),
    overall_score: overallScore, pass_rate: passRate,
  });
  logger.info({ runId: run.id, passed, total: cases.length, overallScore }, 'eval run completed');
  return (await getEvalRun(run.id))!;
}

async function runOneCase(input: {
  runId: string; testCase: TestCaseRow; rubric: RubricVersionRow;
  systemPrompt?: string; model?: string; maxTurns: number; judgeModel?: string | null;
}): Promise<{ is_pass: boolean; overall_score: number | null }> {
  const tc = input.testCase;
  // Create/refresh result row
  const result = await createEvalResult(input.runId, tc.id);
  await updateEvalResult(result.id, { status: 'running' });

  // Create trace
  const trace = await createAgentTrace({
    evalResultId: result.id, runId: input.runId, inputSummary: tc.input_text.slice(0, 500),
    metadata: { case_id: tc.id, difficulty: tc.difficulty, category: tc.category },
  });

  try {
    // Run agent
    const qres = await evalQuery(tc.input_text, {
      systemPrompt: input.systemPrompt, model: input.model,
      maxTurns: input.maxTurns, traceId: trace.id, timeoutMs: 120_000,
    });

    const agentOutput = qres.output ?? '';
    await updateAgentTrace(trace.id, {
      output_summary: agentOutput.slice(0, 1000), total_latency_ms: qres.totalLatencyMs,
      total_tokens: qres.totalTokens, span_count: qres.spanCount,
    });

    // Score
    const score = await scoreCase({
      rubric: input.rubric, testCase: tc, agentOutput,
      hadError: qres.hadError, evalResultId: result.id, judgeModel: input.judgeModel,
    });

    await updateEvalResult(result.id, {
      status: 'completed', agent_output: agentOutput, agent_latency_ms: qres.totalLatencyMs,
      token_usage: { total_tokens: qres.totalTokens }, dimension_scores: score.dimension_scores,
      overall_score: score.overall_score, is_pass: score.is_pass,
      judge_reasoning: score.judge_reasoning, assertion_results: score.assertion_results,
    });

    return { is_pass: score.is_pass, overall_score: score.overall_score };
  } catch (err) {
    await updateEvalResult(result.id, {
      status: 'failed', error_message: (err as Error).message?.slice(0, 500),
    });
    return { is_pass: false, overall_score: null };
  }
}

export async function retryCase(runId: string, caseId: string, judgeModel?: string | null): Promise<EvalResultRow | null> {
  const run = await getEvalRun(runId);
  if (!run) throw new Error('run not found');
  const rv = await getRubricVersion(run.rubric_version_id);
  if (!rv) throw new Error('rubric version not found');
  const agentDef = getAgentDefinitionById(run.agent_id);
  if (!agentDef) throw new Error('agent not found');
  const cases = await listTestCases(run.dataset_version_id, { status: 'active' });
  const tc = cases.find(c => c.id === caseId);
  if (!tc) throw new Error('case not found');
  const result = await runOneCase({
    runId, testCase: tc, rubric: rv,
    systemPrompt: agentDef.system_prompt || undefined,
    model: run.llm_model, maxTurns: 1, judgeModel: judgeModel ?? rv.judge_model,
  });
  void result;
  return getEvalResult((await createEvalResult(runId, caseId)).id);
}
