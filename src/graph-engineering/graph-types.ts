/**
 * Graph Engineering — core type definitions.
 *
 * Graph = orchestration layer over Loop. A GraphDefinition declares nodes +
 * edges (a DAG). A GraphRun is an execution instance. Each node runs in its
 * own workspace and persists a checkpoint (graph_node_runs) so the run can be
 * resumed after crash/pause.
 *
 * See docs/tech_solution/graph-engineering/SOLUTION.md for the full design.
 */

/** Node kinds. Mirrors graph_node_runs.node_type CHECK constraint in db.ts. */
export type GraphNodeType = 'agent' | 'gate' | 'branch' | 'join' | 'human';

/** Edge kinds. A data edge carries state dependency; a control edge only gates. */
export type GraphEdgeType = 'data' | 'control';

/** Runtime status of a single node run. Mirrors graph_node_runs.status. */
export type NodeRunStatus =
  | 'pending'
  | 'running'
  | 'completed'
  | 'failed'
  | 'skipped'
  | 'paused';

/** Runtime status of a whole graph run. Mirrors graph_runs.status. */
export type GraphRunStatus =
  | 'pending'
  | 'running'
  | 'paused'
  | 'completed'
  | 'failed'
  | 'cancelled';

/**
 * A node in the graph. One node = one deliverable or one independently
 * verifiable stage (Simplicity First: don't make one LLM call one node).
 */
export interface GraphNode {
  id: string;
  type: GraphNodeType;
  title: string;
  /** For 'agent' nodes: the prompt fed to runHostAgent/runContainerAgent. */
  prompt?: string;
  /**
   * For 'gate' nodes: success criteria text fed to buildReviewerPrompt.
   * Reviewer must return 'pass' for the node to complete.
   */
  successCriteria?: string;
  /**
   * For 'branch' nodes: a predicate key. The runner evaluates the predicate
   * against current state and activates matching conditional outgoing edges.
   */
  branchKey?: string;
  /** Mark this node idempotent so resume auto-replays it without confirmation. */
  isIdempotent?: boolean;
  /** Max attempts on failure (default 3). */
  maxAttempts?: number;
  /** Per-attempt backoff base in ms (default 5000, mirrors loop MAX_RETRIES). */
  backoffMs?: number;
  /** Hard timeout per attempt in ms. */
  timeoutMs?: number;

  // ---- Super Agent Team extensions (v53) ----
  /**
   * For 'agent' nodes: references an agent_definitions.id created by the Team
   * Builder. When set, runAgentNode puts it on the synthetic RegisteredGroup so
   * container-runner's existing loadGroupAgentDefinition(group.agentDefId, ...)
   * loads the Team-designed systemPrompt/engine/skills/mcp — zero change to
   * container-runner. Missing → falls back to the default agent (backward compat).
   */
  agentDefId?: string;
  /** Member name (human-readable, for the UI); pairs with agentDefId. */
  agentMember?: string;
  /**
   * For 'agent' nodes: the original goal + acceptance criteria + role +
   * deliverable, prepended to the prompt on every execution so the goal is
   * re-anchored each turn (fixes "forget the original goal"). Missing → the
   * node runs with just its prompt (backward compat).
   */
  goalAnchor?: string;
  /**
   * For 'gate' nodes: behavioral-evidence assertions (harness-eval style) run
   * against the upstream agent's output text. Any assertion failing → gate
   * failed, no LLM reviewer fallback. Missing → LLM-only review (backward compat).
   */
  assertions?: GraphAssertion[];
  /**
   * For 'gate' nodes: an optional shell command run in the owner group folder
   * (via runScript). Non-zero exit → gate failed (behavioral evidence). Runs
   * before assertions and the LLM reviewer. Missing → no shell check.
   */
  shellCheck?: string;
  /**
   * For 'gate' nodes: which upstream agent node's output to assert against
   * (reads state[node_<upstreamNodeId>_output]). Defaults to the nearest
   * predecessor agent node.
   */
  upstreamNodeId?: string;
}

/**
 * A behavioral-evidence assertion for a gate node. Mirrors harness-eval's
 * EvalAssertion shape so scoreAssertion can be reused directly. Plain
 * JSON-serializable so it persists in graph_definitions.nodes_json.
 */
export interface GraphAssertion {
  kind: 'contains' | 'not_contains' | 'regex' | 'no_error';
  value: string;
}


/** A directed edge between nodes. */
export interface GraphEdge {
  id: string;
  from: string;
  to: string;
  type?: GraphEdgeType;
  /**
   * For conditional edges leaving a 'branch' node: the value the branch
   * predicate must return to activate this edge. Omit for unconditional edges.
   */
  condition?: string;
}

/** Shared mutable state passed between nodes. Nodes return patches merged in. */
export type GraphState = Record<string, unknown>;

/** A state field declared by the definition (for validation). */
export interface GraphStateField {
  name: string;
  description?: string;
  /** Default value if unset at run start. */
  default?: unknown;
}

/** In-memory graph definition (DB stores JSON-serialized form). */
export interface GraphDefinition {
  id: string;
  version: number;
  name: string;
  description?: string;
  nodes: GraphNode[];
  edges: GraphEdge[];
  stateSchema?: GraphStateField[];
}

/** Result of validating a graph definition. */
export interface GraphValidationResult {
  ok: boolean;
  errors: string[];
}

/** A node's contribution to state after completing. */
export interface StatePatch {
  [key: string]: unknown;
}

/** Per-node execution outcome returned by the runner. */
export interface NodeRunOutcome {
  status: 'completed' | 'failed' | 'skipped' | 'paused';
  output: string;
  statePatch?: StatePatch;
  inputTokens: number;
  outputTokens: number;
  costUsd: number;
  error?: string;
  /** For branch nodes: the predicate result determining which edges to take. */
  branchResult?: string;
}
