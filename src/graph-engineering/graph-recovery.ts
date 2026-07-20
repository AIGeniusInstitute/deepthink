/**
 * Graph Recovery — boot recovery for interrupted graph runs.
 *
 * Mirrors bootRecoverSupervisor (supervisor-agent.ts:745). On process restart,
 * any graph_run / graph_node_run left in 'running' (the process died mid-node)
 * is flipped to 'failed' so the run is resumable, not stuck. The user can then
 * POST /api/graph/runs/:id/resume to continue from the last checkpoint.
 *
 * See SOLUTION.md §6.2.
 */

import {
  listGraphNodeRuns,
  listNonTerminalGraphRuns,
  updateGraphNodeRun,
  updateGraphRunStatus,
} from '../db.js';
import { logger } from '../logger.js';

export interface GraphRecoveryResult {
  runsFlipped: number;
  nodesFlipped: number;
}

/**
 * Flip stale 'running' graph runs + node runs to 'failed'. Does NOT auto-resume
 * — resume requires the orchestrator + deps, which is triggered explicitly via
 * the /resume route or a future scheduler tick. Non-idempotent nodes require
 * user confirmation before resume (AC3.6), so we stop at 'failed'.
 */
export function bootRecoverGraphRuns(): GraphRecoveryResult {
  const nowIso = new Date().toISOString();
  let runsFlipped = 0;
  let nodesFlipped = 0;

  const nonTerminal = listNonTerminalGraphRuns();
  for (const run of nonTerminal) {
    // Flip stale node_runs inside this run first.
    const nodes = listGraphNodeRuns(run.id).filter((n) => n.status === 'running');
    for (const n of nodes) {
      updateGraphNodeRun(n.id, {
        status: 'failed',
        ended_at: nowIso,
        error: 'crashed before recovery (process restart)',
      });
      nodesFlipped++;
    }
    // Only flip runs that were actively running (paused runs keep their status;
    // the user explicitly paused them and can resume).
    if (run.status === 'running' || run.status === 'pending') {
      updateGraphRunStatus(run.id, 'failed', {
        endedAt: nowIso,
        cancelReason: 'crashed before recovery (process restart)',
      });
      runsFlipped++;
    }
  }

  if (runsFlipped > 0 || nodesFlipped > 0) {
    logger.info(
      { runsFlipped, nodesFlipped },
      'Graph boot recovery completed',
    );
  }
  return { runsFlipped, nodesFlipped };
}
