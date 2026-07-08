/**
 * Allocates stable nodeIds for the DAG visualization and attaches `traceNode`
 * metadata to stream events as they pass through.
 *
 * Lives next to `index.ts`'s `decorateStreamEvent` hook so the stream-processor
 * stays untouched (Surgical Changes). Node IDs are allocated monotonically
 * within a single agent-runner process — the main process persists them with
 * `upsertChatTraceNode`, keyed on (chat_jid, id).
 *
 * Node types covered (PRD §3.3.2):
 *   - turn:     one per user message → assistant response cycle
 *   - tool:     each tool_use_start/end pair
 *   - subagent: each task_start (Task tool invocation)
 *
 * Not covered in this iteration:
 *   - review, goal_check — these are loop-engineering concepts; regular chat
 *     does not emit them.
 *   - skill — skills execute via tool calls (Skill tool), so they appear as
 *     `tool` nodes with `title='Skill:<name>'`. A future iteration can post-
 *     process the title to recategorize.
 */

import type { StreamEvent } from './stream-event.types.js';

interface ActiveTool {
  nodeId: number;
  parentTurnId: number;
}

export class TraceNodeAllocator {
  private nextId = 1;
  private currentTurnId: number | null = null;
  private toolByUseId = new Map<string, ActiveTool>();
  private startedAt = new Date().toISOString();

  /** Allocate a fresh nodeId. */
  private alloc(): number {
    return this.nextId++;
  }

  /**
   * Mark the start of a new turn (user message → assistant response cycle).
   * Called when the agent starts processing a new user input. Returns the
   * allocated turn nodeId.
   */
  startTurn(inputSummary?: string): number {
    const id = this.alloc();
    this.currentTurnId = id;
    return id;
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
        const parentTurnId = this.currentTurnId ?? this.startTurn();
        const nodeId = this.alloc();
        if (event.toolUseId) {
          this.toolByUseId.set(event.toolUseId, { nodeId, parentTurnId });
        }
        event.traceNode = {
          nodeId,
          nodeType: 'tool',
          parentNodeId: parentTurnId,
          title: event.toolName ?? undefined,
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
            nodeType: 'tool',
            parentNodeId: active.parentTurnId,
            outputSummary: event.toolResult ?? undefined,
            status: 'done',
          };
          this.toolByUseId.delete(toolUseId);
        }
        break;
      }
      case 'task_start': {
        const parentTurnId = this.currentTurnId ?? this.startTurn();
        const nodeId = this.alloc();
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
      default:
        break;
    }
    return event;
  }

  /** Reset state for a new conversation turn (called on new user message). */
  resetTurn(): void {
    this.currentTurnId = null;
    this.toolByUseId.clear();
  }
}
