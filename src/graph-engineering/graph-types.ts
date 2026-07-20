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
