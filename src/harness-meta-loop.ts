/**
 * Harness Meta-Loop — propose → register → eval → judge → promote|rollback.
 *
 * The Meta-Loop is the "Self-Harness" core: the agent judges its own harness
 * mutations based on **behavior evidence** only, never on the proposal's
 * argumentation text (Self-Harness philosophy: "行为证据 > 提案论证").
 *
 * Verdict rules (judgeVerdict, pure function — unit-testable):
 *   regressed    : proposed introduces a NEW failing case (baseline passed it)
 *   improved     : proposed pass-rate strictly higher, no new failures
 *   neutral      : pass-rate equal, fail set identical
 *   inconclusive : eval errored on either side, or zero cases ran
 *
 * Promote/rollback is a single DB status flip (Continual Harness: reset-free).
 * Failed variants stay in the archive with status=rolled_back — they remain
 * available as parent_id for future proposals (DGM "stepping stone" principle).
 */

import crypto from 'node:crypto';

import {
  createHarnessProposal,
  getHarnessProposal,
  getHarnessVersion,
  getPromotedHarnessVersion,
  listHarnessEvalRuns,
  updateHarnessProposalVerdict,
  type HarnessProposalRow,
  type HarnessVersionRow,
} from './db.js';
import {
  diffVersions,
  promoteVersion,
  rollbackTo,
  snapshotCurrentHarness,
} from './harness-registry.js';
import {
  runEvalForVersion,
  type EvalAggregate,
  type EvalCaseResult,
} from './harness-eval.js';
import { logger } from './logger.js';

export type Verdict = 'improved' | 'regressed' | 'neutral' | 'inconclusive';

export interface MetaLoopResult {
  proposalId: string;
  proposedVersionId: string;
  baselineVersionId: string;
  verdict: Verdict;
  baselineAggregate: EvalAggregate;
  proposedAggregate: EvalAggregate;
  evidenceRunIds: string[];
  traceSummary: string;
}

/** Pure verdict judge — exported for unit testing.
 *
 *  Inputs are the two aggregates (baseline first, proposed second).
 *  Rules order matters: regressed > improved > neutral > inconclusive. */
export function judgeVerdict(
  baseline: EvalAggregate,
  proposed: EvalAggregate,
): Verdict {
  // Inconclusive: either side failed to run at all.
  if (baseline.total === 0 || proposed.total === 0) return 'inconclusive';
  if (baseline.errored > 0 || proposed.errored > 0) return 'inconclusive';

  const baselineFailSet = new Set(
    baseline.results.filter((r) => !r.pass).map((r) => r.case_id),
  );
  const proposedFailSet = new Set(
    proposed.results.filter((r) => !r.pass).map((r) => r.case_id),
  );

  // Regressed: proposed fails a case that baseline passed.
  for (const id of proposedFailSet) {
    if (!baselineFailSet.has(id)) return 'regressed';
  }

  // Improved: proposed strictly higher pass-rate AND no new failures (checked above).
  const baselinePassRate = baseline.passed / baseline.total;
  const proposedPassRate = proposed.passed / proposed.total;
  if (proposedPassRate > baselinePassRate) return 'improved';

  // Neutral: same pass-rate, same fail set.
  return 'neutral';
}

/** Create a proposal: registers a fresh snapshot of the current harness as
 *  the proposed version (parent = current promoted), stores the proposal row.
 *  Does NOT run the meta-loop yet — caller invokes runMetaLoopForProposal(). */
export function createProposal(input: {
  hypothesis: string;
  expectedBehavior: string;
  mutationPatch: string;
  baselineVersionId?: string; // defaults to current promoted
}): { proposalId: string; proposedVersionId: string; baselineVersionId: string } {
  const baseline = input.baselineVersionId
    ? getHarnessVersion(input.baselineVersionId)
    : getPromotedHarnessVersion();
  if (!baseline) {
    throw new Error(
      'no baseline harness version — call snapshotCurrentHarness({status:"promoted"}) first',
    );
  }

  // Snapshot the CURRENT harness as the proposed variant. The caller is
  // expected to have made the harness mutation (e.g. edited CLAUDE.md) before
  // submitting; the proposal records what was mutated via mutationPatch.
  const proposed = snapshotCurrentHarness({
    parentId: baseline.id,
    source: 'proposal',
    status: 'experimental',
  });

  const proposalId = `prop_${Date.now()}_${crypto.randomBytes(4).toString('hex')}`;
  createHarnessProposal({
    id: proposalId,
    proposedVersionId: proposed.id,
    baselineVersionId: baseline.id,
    hypothesis: input.hypothesis,
    expectedBehavior: input.expectedBehavior,
    mutationPatch: input.mutationPatch,
  });

  logger.info(
    { proposalId, proposedId: proposed.id, baselineId: baseline.id },
    'harness proposal created',
  );
  return {
    proposalId,
    proposedVersionId: proposed.id,
    baselineVersionId: baseline.id,
  };
}

/** Run the meta-loop for a proposal: eval baseline + proposed, judge, promote
 *  or rollback. Returns the full evidence record. */
export async function runMetaLoopForProposal(proposalId: string): Promise<MetaLoopResult> {
  const proposal = getHarnessProposal(proposalId);
  if (!proposal) throw new Error(`proposal not found: ${proposalId}`);
  const baselineVersion = getHarnessVersion(proposal.baseline_version_id);
  const proposedVersion = getHarnessVersion(proposal.proposed_version_id);
  if (!baselineVersion || !proposedVersion) {
    throw new Error('proposal references missing version');
  }

  logger.info({ proposalId }, 'harness meta-loop starting');

  // Run eval on both versions. The eval runner is the external judge — it
  // does NOT read the proposal's hypothesis or expected_behavior text.
  const baselineEval = await runEvalForVersion(baselineVersion.id, { proposalId });
  const proposedEval = await runEvalForVersion(proposedVersion.id, { proposalId });

  const verdict = judgeVerdict(baselineEval.aggregate, proposedEval.aggregate);

  const evidenceRunIds = [
    ...baselineEval.runs.map((r) => r.id),
    ...proposedEval.runs.map((r) => r.id),
  ];

  const traceSummary = buildTraceSummary({
    baseline: baselineEval.aggregate,
    proposed: proposedEval.aggregate,
    verdict,
  });

  updateHarnessProposalVerdict(proposalId, verdict, {
    runIds: evidenceRunIds,
    traceSummary,
  });

  // Promote / rollback based on verdict. Only "improved" promotes; everything
  // else rolls the proposed back (keeping it in the archive as a stepping stone).
  if (verdict === 'improved') {
    promoteVersion(proposedVersion.id);
  } else {
    rollbackTo(proposedVersion.id);
  }

  logger.info({ proposalId, verdict }, 'harness meta-loop completed');

  return {
    proposalId,
    proposedVersionId: proposedVersion.id,
    baselineVersionId: baselineVersion.id,
    verdict,
    baselineAggregate: baselineEval.aggregate,
    proposedAggregate: proposedEval.aggregate,
    evidenceRunIds,
    traceSummary,
  };
}

/** Build a human-readable trace summary for the proposal row. */
function buildTraceSummary(input: {
  baseline: EvalAggregate;
  proposed: EvalAggregate;
  verdict: Verdict;
}): string {
  const { baseline, proposed, verdict } = input;
  const line = (label: string, agg: EvalAggregate) =>
    `${label}: ${agg.passed}/${agg.total} passed, ${agg.failed} failed, ${agg.errored} errored, score=${agg.score.toFixed(3)}`;
  const details = baseline.results
    .map((br) => {
      const pr = proposed.results.find((p) => p.case_id === br.case_id);
      const sym = !pr ? '?' : br.pass && pr.pass ? '=' : !br.pass && pr.pass ? '↑' : br.pass && !pr.pass ? '↓' : '=';
      return `  ${sym} ${br.case_id}: base=${br.pass ? 'P' : 'F'} prop=${pr?.pass ? 'P' : pr ? 'F' : '?'}`;
    })
    .join('\n');
  return `verdict=${verdict}\n${line('baseline', baseline)}\n${line('proposed', proposed)}\n${details}`;
}

/** Get a proposal + its evidence run rows. */
export function getProposalWithEvidence(proposalId: string): {
  proposal: HarnessProposalRow | null;
  baselineVersion: HarnessVersionRow | null;
  proposedVersion: HarnessVersionRow | null;
  diff: ReturnType<typeof diffVersions> | null;
  evalRuns: ReturnType<typeof listHarnessEvalRuns>;
} {
  const proposal = getHarnessProposal(proposalId) ?? null;
  if (!proposal) {
    return {
      proposal: null,
      baselineVersion: null,
      proposedVersion: null,
      diff: null,
      evalRuns: [],
    };
  }
  const baselineVersion = getHarnessVersion(proposal.baseline_version_id) ?? null;
  const proposedVersion = getHarnessVersion(proposal.proposed_version_id) ?? null;
  const diff = diffVersions(proposal.baseline_version_id, proposal.proposed_version_id);
  const evalRuns = listHarnessEvalRuns({ proposalId, limit: 500 });
  return { proposal, baselineVersion, proposedVersion, diff, evalRuns };
}
