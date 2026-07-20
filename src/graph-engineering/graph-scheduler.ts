/**
 * Graph Scheduler — pure topology logic: ready-queue derivation, fan-out /
 * fan-in, conditional branch routing, retry budget.
 *
 * Stateless over the DB: takes a definition + completed-set + branch decisions,
 * returns the next batch of ready nodes. The orchestrator (graph-orchestrator.ts)
 * owns persistence and concurrency. This separation keeps the scheduling logic
 * testable without spinning up agents (TC1-5, TC14).
 *
 * See SOLUTION.md §4 for the algorithm.
 */

import type { GraphDefinition, GraphNode } from './graph-types.js';

/** Get all predecessors (incoming edges) of a node. */
function predecessors(def: GraphDefinition, nodeId: string) {
  return def.edges.filter((e) => e.to === nodeId);
}

/** Source nodes (no incoming edges) — initial ready set. */
export function sourceNodes(def: GraphDefinition): GraphNode[] {
  const hasIncoming = new Set(def.edges.map((e) => e.to));
  return def.nodes.filter((n) => !hasIncoming.has(n.id));
}

/**
 * Compute the set of node ids that are ready to run.
 * A node is ready iff:
 *  - it is not yet completed
 *  - every incoming edge's source is completed, AND
 *  - for conditional edges (leaving a branch node), the branch decision
 *    matches the edge's condition (i.e. this edge was "taken")
 *
 * @param completed  node ids that reached 'completed'
 * @param branchDecisions  branchNodeId → chosen condition value
 */
export function computeReadyNodes(
  def: GraphDefinition,
  completed: Set<string>,
  branchDecisions: Map<string, string>,
): GraphNode[] {
  const ready: GraphNode[] = [];
  for (const node of def.nodes) {
    if (completed.has(node.id)) continue;
    const preds = predecessors(def, node.id);
    if (preds.length === 0) {
      // source node — ready only if not completed (handles resume skip)
      ready.push(node);
      continue;
    }
    let allSatisfied = true;
    for (const edge of preds) {
      if (!completed.has(edge.from)) {
        allSatisfied = false;
        break;
      }
      // Conditional edge: only active if the branch chose this edge's condition.
      if (edge.condition) {
        const chosen = branchDecisions.get(edge.from);
        if (chosen !== edge.condition) {
          allSatisfied = false;
          break;
        }
      }
    }
    if (allSatisfied) ready.push(node);
  }
  return ready;
}

/**
 * Pick up to `maxParallel` nodes from the ready list, respecting a global
 * concurrency ceiling (TC14 — never exceed MAX_CONCURRENT_*).
 *
 * @param globalSlots  available global concurrency slots (MAX_CONCURRENT_* -
 *                     currently in-flight agent processes). The orchestrator
 *                     tracks this; scheduler just won't over-subscribe.
 */
export function nextReadyBatch(
  ready: GraphNode[],
  maxParallel: number,
  globalSlots: number,
): GraphNode[] {
  const limit = Math.max(0, Math.min(maxParallel, globalSlots, ready.length));
  return ready.slice(0, limit);
}

/** True iff every node is completed (run finished successfully). */
export function allCompleted(def: GraphDefinition, completed: Set<string>): boolean {
  return def.nodes.every((n) => completed.has(n.id));
}

/**
 * Downstream node ids of a given node (transitive), used by rerun: resetting
 * a node invalidates its downstream so the scheduler re-derives them.
 */
export function downstreamNodeIds(def: GraphDefinition, nodeId: string): Set<string> {
  const result = new Set<string>();
  const stack = [nodeId];
  while (stack.length) {
    const cur = stack.pop()!;
    for (const edge of def.edges) {
      if (edge.from === cur && !result.has(edge.to)) {
        result.add(edge.to);
        stack.push(edge.to);
      }
    }
  }
  return result;
}

/** Validate that a branch node has matching outgoing conditional edges. */
export function branchEdgeCoverage(def: GraphDefinition): string[] {
  const errors: string[] = [];
  for (const n of def.nodes) {
    if (n.type !== 'branch') continue;
    const out = def.edges.filter((e) => e.from === n.id);
    const conds = out.map((e) => e.condition).filter(Boolean) as string[];
    if (new Set(conds).size !== conds.length) {
      errors.push(`branch node ${n.id}: duplicate conditional edge values`);
    }
  }
  return errors;
}
