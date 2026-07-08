/**
 * Harness Eval Runner — behavior-evidence-based scoring for harness versions.
 *
 * Design notes (see docs/tech_solution/self-evolving-harness/TECH-SOLUTION.md §3.2):
 * - The eval runner is NOT versioned — it stays in code as the external judge
 *   (SEAGym pattern) to avoid the bootstrapping paradox.
 * - Each case runs as a single-turn sdkQuery (maxTurns=1, no tools) so the
 *   eval measures prompt response quality, not tool-call luck.
 * - Verdict is based on assertion matches against the response text — pure
 *   behavior evidence, no proposal-argument reading (Self-Harness philosophy).
 * - Trace: each case creates one chat_trace_nodes row under a synthetic
 *   chat_jid (harness-eval:{version_id}:{case_id}) so the evidence is
 *   inspectable later via the existing chat-trace UI.
 */

import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';

import yaml from 'yaml';

import {
  createHarnessEvalRun,
  listHarnessEvalCases,
  listHarnessEvalRuns,
  upsertHarnessEvalCase,
  updateHarnessEvalRun,
  type HarnessEvalCaseRow,
  type HarnessEvalRunRow,
} from './db.js';
import { DATA_DIR, HARNESS_EVAL_CASES_SRC_DIR } from './config.js';
import { upsertChatTraceNode } from './db.js';
import { sdkQuery } from './sdk-query.js';
import { logger } from './logger.js';

export const EVAL_CASES_DIR = path.join(DATA_DIR, 'harness', 'eval-cases');

export type AssertionKind =
  | 'contains'
  | 'not_contains'
  | 'regex'
  | 'no_error';

export interface EvalAssertion {
  kind: AssertionKind;
  value: string;
}

export interface EvalRubric {
  weights?: Record<string, number>;
  pass_threshold: number;
}

export interface EvalCase {
  case_id: string;
  name: string;
  prompt: string;
  assertions: EvalAssertion[];
  rubric: EvalRubric;
}

export interface EvalCaseResult {
  case_id: string;
  name: string;
  pass: boolean;
  score: number;
  trace_chat_jid: string;
  trace_node_id: number;
  evidence_summary: string;
  error?: string;
}

export interface EvalAggregate {
  total: number;
  passed: number;
  failed: number;
  errored: number;
  score: number; // 0..1
  results: EvalCaseResult[];
}

/** Parse a YAML case file into an EvalCase. */
export function parseCaseYaml(raw: string): EvalCase | null {
  try {
    const obj = yaml.parse(raw) as any;
    if (!obj || !obj.case_id || !obj.prompt || !Array.isArray(obj.assertions)) {
      return null;
    }
    const assertions: EvalAssertion[] = obj.assertions
      .map((a: any) => ({
        kind: a.kind as AssertionKind,
        value: String(a.value ?? ''),
      }))
      .filter((a: EvalAssertion) => ['contains', 'not_contains', 'regex', 'no_error'].includes(a.kind));
    const rubric: EvalRubric = {
      weights: obj.rubric?.weights ?? { default: 1.0 },
      pass_threshold: Number(obj.rubric?.pass_threshold ?? 1.0),
    };
    return {
      case_id: obj.case_id,
      name: obj.name ?? obj.case_id,
      prompt: String(obj.prompt),
      assertions,
      rubric,
    };
  } catch {
    return null;
  }
}

/** Load all eval cases from the tracked source dir (config/harness/eval-cases/)
 *  AND the runtime data dir (data/harness/eval-cases/), then upsert into DB.
 *  Source dir is tracked in git; runtime dir is for user-added ad-hoc cases. */
export function loadAndSyncEvalCases(): EvalCase[] {
  const cases: EvalCase[] = [];
  const seen = new Set<string>();
  const dirs = [HARNESS_EVAL_CASES_SRC_DIR, EVAL_CASES_DIR];
  for (const dir of dirs) {
    let files: string[] = [];
    try {
      files = fs.readdirSync(dir).filter((f) => f.endsWith('.yaml') || f.endsWith('.yml'));
    } catch {
      continue;
    }
    for (const f of files) {
      const raw = fs.readFileSync(path.join(dir, f), 'utf8');
      const c = parseCaseYaml(raw);
      if (c && !seen.has(c.case_id)) {
        seen.add(c.case_id);
        cases.push(c);
        upsertHarnessEvalCase({
          caseId: c.case_id,
          name: c.name,
          prompt: c.prompt,
          assertionsJson: JSON.stringify(c.assertions),
          rubricJson: JSON.stringify(c.rubric),
          enabled: true,
        });
      }
    }
  }
  return cases;
}

/** Load cases from DB (already synced by loadAndSyncEvalCases on startup). */
export function loadEvalCasesFromDb(enabledOnly = true): EvalCase[] {
  return listHarnessEvalCases(enabledOnly).map((row) => ({
    case_id: row.case_id,
    name: row.name,
    prompt: row.prompt,
    assertions: JSON.parse(row.assertions_json) as EvalAssertion[],
    rubric: JSON.parse(row.rubric_json) as EvalRubric,
  }));
}

/** Score a single assertion against response text. Pure function (unit-testable). */
export function scoreAssertion(
  assertion: EvalAssertion,
  responseText: string,
  hadError: boolean,
): { pass: boolean; detail: string } {
  switch (assertion.kind) {
    case 'contains': {
      const pass = responseText.includes(assertion.value);
      return { pass, detail: pass ? `found "${assertion.value}"` : `missing "${assertion.value}"` };
    }
    case 'not_contains': {
      const pass = !responseText.includes(assertion.value);
      return { pass, detail: pass ? `absent "${assertion.value}"` : `present "${assertion.value}"` };
    }
    case 'regex': {
      let pass = false;
      try {
        pass = new RegExp(assertion.value).test(responseText);
      } catch {
        pass = false;
      }
      return { pass, detail: pass ? `matched /${assertion.value}/` : `no match /${assertion.value}/` };
    }
    case 'no_error': {
      const pass = !hadError;
      return { pass, detail: pass ? 'no error' : 'had error' };
    }
    default:
      return { pass: false, detail: `unknown kind ${assertion.kind}` };
  }
}

/** Score all assertions for a case; pass if score >= rubric.pass_threshold. */
export function scoreCase(
  evalCase: EvalCase,
  responseText: string,
  hadError: boolean,
): { pass: boolean; score: number; details: string[] } {
  const details: string[] = [];
  let passed = 0;
  let total = 0;
  for (const a of evalCase.assertions) {
    total += 1;
    const r = scoreAssertion(a, responseText, hadError);
    if (r.pass) passed += 1;
    details.push(`[${r.pass ? 'PASS' : 'FAIL'}] ${a.kind}: ${r.detail}`);
  }
  const score = total === 0 ? 0 : passed / total;
  const pass = total > 0 && score >= evalCase.rubric.pass_threshold;
  return { pass, score, details };
}

/** Trace chat_jid convention: harness-eval:{versionId}:{caseId}. */
export function traceChatJid(versionId: string, caseId: string): string {
  return `harness-eval:${versionId}:${caseId}`;
}

/** Run a single case against a response (no sdkQuery call). Exported for unit tests. */
export function runCaseAgainstResponse(
  evalCase: EvalCase,
  responseText: string,
  hadError: boolean,
): EvalCaseResult {
  const chatJid = traceChatJid('test', evalCase.case_id);
  const { pass, score, details } = scoreCase(evalCase, responseText, hadError);
  return {
    case_id: evalCase.case_id,
    name: evalCase.name,
    pass,
    score,
    trace_chat_jid: chatJid,
    trace_node_id: 0,
    evidence_summary: details.join('\n'),
  };
}

/** Run eval for a version: invoke sdkQuery for each case, score, persist.
 *  Returns the aggregate + per-case results. */
export async function runEvalForVersion(
  versionId: string,
  opts: { caseIds?: string[]; proposalId?: string | null; timeoutMs?: number } = {},
): Promise<{ runs: HarnessEvalRunRow[]; aggregate: EvalAggregate }> {
  const cases = loadEvalCasesFromDb(true).filter(
    (c) => !opts.caseIds || opts.caseIds.includes(c.case_id),
  );
  const results: EvalCaseResult[] = [];
  const runs: HarnessEvalRunRow[] = [];

  for (const evalCase of cases) {
    const runId = `er_${Date.now()}_${crypto.randomBytes(4).toString('hex')}`;
    const startedAt = new Date().toISOString();
    const chatJid = traceChatJid(versionId, evalCase.case_id);
    createHarnessEvalRun({
      id: runId,
      versionId,
      proposalId: opts.proposalId ?? null,
      caseId: evalCase.case_id,
      startedAt,
    });

    try {
      const response = await sdkQuery(evalCase.prompt, {
        timeout: opts.timeoutMs ?? 60_000,
      });
      const hadError = response === null;
      const responseText = response ?? '';
      const { pass, score, details } = scoreCase(evalCase, responseText, hadError);

      // Persist a trace node so the evidence is inspectable later.
      const nodeId = Math.floor(Date.now() / 1000) + Math.floor(Math.random() * 1000);
      upsertChatTraceNode({
        id: nodeId,
        chat_jid: chatJid,
        node_type: 'turn',
        title: `[harness-eval] ${evalCase.name}`,
        input_summary: evalCase.prompt.slice(0, 800),
        output_summary: responseText.slice(0, 800),
        tokens: 0,
        status: pass ? 'pass' : 'fail',
        started_at: startedAt,
        ended_at: new Date().toISOString(),
      });

      const finishedAt = new Date().toISOString();
      updateHarnessEvalRun(runId, {
        status: 'completed',
        pass: pass ? 1 : 0,
        score,
        traceNodeRootId: nodeId,
        finishedAt,
      });

      results.push({
        case_id: evalCase.case_id,
        name: evalCase.name,
        pass,
        score,
        trace_chat_jid: chatJid,
        trace_node_id: nodeId,
        evidence_summary: details.join('\n'),
      });
    } catch (err) {
      const finishedAt = new Date().toISOString();
      const errorMsg = (err as Error).message?.slice(0, 500) ?? 'unknown error';
      updateHarnessEvalRun(runId, {
        status: 'failed',
        pass: 0,
        score: 0,
        finishedAt,
        error: errorMsg,
      });
      results.push({
        case_id: evalCase.case_id,
        name: evalCase.name,
        pass: false,
        score: 0,
        trace_chat_jid: chatJid,
        trace_node_id: 0,
        evidence_summary: `error: ${errorMsg}`,
        error: errorMsg,
      });
      logger.warn({ err: errorMsg, caseId: evalCase.case_id, versionId }, 'harness eval case failed');
    }
    runs.push(listHarnessEvalRuns({ versionId, limit: 500 }).find((r) => r.id === runId)!);
  }

  const aggregate: EvalAggregate = {
    total: results.length,
    passed: results.filter((r) => r.pass).length,
    failed: results.filter((r) => !r.pass && !r.error).length,
    errored: results.filter((r) => !!r.error).length,
    score: results.length === 0 ? 0 : results.reduce((s, r) => s + r.score, 0) / results.length,
    results,
  };
  return { runs, aggregate };
}

/** List eval runs from DB. */
export function listEvalRuns(
  opts: { versionId?: string; proposalId?: string; limit?: number } = {},
): HarnessEvalRunRow[] {
  return listHarnessEvalRuns(opts);
}
