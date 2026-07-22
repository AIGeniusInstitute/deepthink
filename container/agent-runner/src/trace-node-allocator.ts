/**
 * Allocates stable nodeIds for the DAG visualization and attaches `traceNode`
 * metadata to stream events as they pass through.
 *
 * Lives at module scope (per agent-runner process) so nodeIds are monotonic
 * across multiple queries within the same process lifetime — this prevents
 * later turns from overwriting earlier turn nodes in the DB.
 *
 * Node types covered (PRD §3.3.2):
 *   - turn:     one per user message → assistant response cycle
 *   - tool:     each tool_use_start/end pair
 *   - subagent: each task_start (Task tool invocation)
 *
 * Not covered in this iteration:
 *   - review, goal_check — these are loop-engineering concepts; regular chat
 *     does not emit them.
 */

import type { StreamEvent } from './stream-event.types.js';

interface ActiveTool {
  nodeId: number;
  parentTurnId: number;
  nodeType: 'tool' | 'skill';
}

interface ActiveTask {
  nodeId: number;
  parentTurnId: number;
}

export interface TraceNodeDescriptor {
  nodeId: number;
  nodeType: 'turn' | 'tool' | 'review' | 'goal_check' | 'skill' | 'subagent';
  parentNodeId?: number | null;
  title?: string;
  inputSummary?: string;
  outputSummary?: string;
  tokens?: number;
  status?: string;
  /** Super Agent Team: graph linkage (set from ContainerInput). */
  graphRunId?: string;
  graphNodeId?: string;
  toolName?: string;
  toolUseId?: string;
}

/** SDK task patch statuses that signal a terminal subagent result. */
const TERMINAL_TASK_STATUSES = new Set([
  'completed',
  'failed',
  'cancelled',
  'timeout',
]);

export class TraceNodeAllocator {
  private nextId = 1;
  private currentTurnId: number | null = null;
  private toolByUseId = new Map<string, ActiveTool>();
  private taskById = new Map<string, ActiveTask>();
  /** Super Agent Team: graph linkage for the current agent-runner process.
   *  Set from ContainerInput.graphRunId/graphNodeId at query start so every
   *  trace node emitted by this process is tagged → forms the agent node's
   *  internal sub-graph in the trace DB. Undefined for plain (non-graph) chats. */
  private graphRunId?: string;
  private graphNodeId?: string;

  /** Allocate a fresh nodeId. */
  private alloc(): number {
    return this.nextId++;
  }

  /**
   * Super Agent Team: set the graph run/node context for this process. Called
   * once per query from index.ts after parsing ContainerInput. When unset
   * (undefined), trace nodes are not graph-linked (plain chat behavior).
   */
  setGraphContext(graphRunId?: string, graphNodeId?: string): void {
    this.graphRunId = graphRunId;
    this.graphNodeId = graphNodeId;
  }

  /**
   * Start a new turn. Allocates a nodeId and returns a traceNode descriptor
   * for the turn root node (parent_node_id=null). The caller is responsible
   * for emitting a stream event that carries this descriptor so the main
   * process persists it and the frontend live-upserts it.
   */
  startTurn(inputSummary?: string): TraceNodeDescriptor {
    const id = this.alloc();
    this.currentTurnId = id;
    return {
      nodeId: id,
      nodeType: 'turn',
      parentNodeId: null,
      title: 'Turn',
      inputSummary: inputSummary,
      status: 'running',
      graphRunId: this.graphRunId,
      graphNodeId: this.graphNodeId,
    };
  }

  /**
   * Finalize the current turn. Returns a traceNode descriptor that updates
   * the turn node with the assistant's output and a terminal status.
   * Returns null if there is no active turn.
   */
  endTurn(outputSummary?: string, status: 'done' | 'failed' = 'done'): TraceNodeDescriptor | null {
    if (this.currentTurnId == null) return null;
    return {
      nodeId: this.currentTurnId,
      nodeType: 'turn',
      outputSummary,
      status,
      graphRunId: this.graphRunId,
      graphNodeId: this.graphNodeId,
    };
  }

  /**
   * Attach traceNode to a stream event in place. Returns the (same) event
   * reference for chaining; mutation is intentional to avoid object spread
   * in the hot path.
   */
  decorate(event: StreamEvent): StreamEvent {
    if (event.traceNode) return event; // already populated, skip

    switch (event.eventType) {
      case 'tool_use_start': {
        const parentTurnId = this.currentTurnId ?? this.startTurn().nodeId;
        const nodeId = this.alloc();
        const toolUseId = event.toolUseId;
        const isSkill = event.toolName === 'Skill' || !!event.skillName;
        const nodeType: 'tool' | 'skill' = isSkill ? 'skill' : 'tool';
        if (toolUseId) {
          this.toolByUseId.set(toolUseId, { nodeId, parentTurnId, nodeType });
        }
        event.traceNode = {
          nodeId,
          nodeType,
          parentNodeId: parentTurnId,
          title: isSkill
            ? `Skill:${event.skillName ?? 'unknown'}`
            : (event.toolName ?? undefined),
          inputSummary: event.toolInputSummary ?? undefined,
          status: 'running',
        };
        break;
      }
      case 'tool_use_end': {
        const toolUseId = event.toolUseId;
        if (toolUseId && this.toolByUseId.has(toolUseId)) {
          const active = this.toolByUseId.get(toolUseId)!;
          event.traceNode = {
            nodeId: active.nodeId,
            nodeType: active.nodeType,
            parentNodeId: active.parentTurnId,
            status: 'done',
          };
          // NOTE: do NOT delete from toolByUseId here — the actual tool
          // output arrives in a separate `tool_result` event that follows.
          // We delete there once outputSummary is set.
        }
        break;
      }
      case 'tool_progress': {
        // input_json_delta arrives as tool_progress with toolInputSummary.
        // Update the tool node's inputSummary (the initial tool_use_start at
        // content_block_start fires with empty input → inputSummary=null).
        const toolUseId = event.toolUseId;
        if (toolUseId && this.toolByUseId.has(toolUseId) && event.toolInputSummary) {
          const active = this.toolByUseId.get(toolUseId)!;
          event.traceNode = {
            nodeId: active.nodeId,
            nodeType: active.nodeType,
            parentNodeId: active.parentTurnId,
            inputSummary: event.toolInputSummary,
          };
        }
        break;
      }
      case 'tool_result': {
        // The actual tool output arrives here (separate from tool_use_end).
        const toolUseId = event.toolUseId;
        if (toolUseId && this.toolByUseId.has(toolUseId)) {
          const active = this.toolByUseId.get(toolUseId)!;
          event.traceNode = {
            nodeId: active.nodeId,
            nodeType: active.nodeType,
            parentNodeId: active.parentTurnId,
            outputSummary: event.toolResult ?? undefined,
            status: 'done',
          };
          this.toolByUseId.delete(toolUseId);
        }
        break;
      }
      case 'task_start': {
        const parentTurnId = this.currentTurnId ?? this.startTurn().nodeId;
        const nodeId = this.alloc();
        const taskId = event.taskId;
        if (taskId) {
          this.taskById.set(taskId, { nodeId, parentTurnId });
        }
        event.traceNode = {
          nodeId,
          nodeType: 'subagent',
          parentNodeId: parentTurnId,
          title: event.subagentType ?? undefined,
          inputSummary: event.taskDescription ?? undefined,
          status: 'running',
        };
        break;
      }
      case 'task_updated': {
        const taskId = event.taskId;
        const patchStatus = event.taskPatch?.status;
        if (taskId && this.taskById.has(taskId) && patchStatus && TERMINAL_TASK_STATUSES.has(patchStatus)) {
          const active = this.taskById.get(taskId)!;
          const status = patchStatus === 'completed' ? 'done' : 'failed';
          event.traceNode = {
            nodeId: active.nodeId,
            nodeType: 'subagent',
            parentNodeId: active.parentTurnId,
            outputSummary: (event.taskPatch?.error || event.summary) ?? undefined,
            status,
          };
          this.taskById.delete(taskId);
        }
        break;
      }
      default:
        break;
    }
    // Super Agent Team: stamp graph linkage + tool identity onto any traceNode
    // the switch populated, so the persist layer can link the node into the
    // agent node's sub-graph and join trace_tool_calls. No-op when graphRunId
    // is unset (plain chat — backward compat).
    if (event.traceNode && this.graphRunId) {
      event.traceNode.graphRunId = this.graphRunId;
      event.traceNode.graphNodeId = this.graphNodeId;
      if (event.toolName) event.traceNode.toolName = event.toolName;
      if (event.toolUseId) event.traceNode.toolUseId = event.toolUseId;
    }
    return event;
  }

  /** Reset per-turn state for a new user message. Does NOT reset nextId
   *  (nodeIds stay monotonic across turns within the process lifetime). */
  resetTurn(): void {
    this.currentTurnId = null;
    this.toolByUseId.clear();
    this.taskById.clear();
  }
}

export const traceAllocator = new TraceNodeAllocator();
