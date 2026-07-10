import { describe, expect, test } from 'vitest';
import { TraceNodeAllocator } from '../container/agent-runner/src/trace-node-allocator.js';
import type { StreamEvent } from '../container/agent-runner/src/stream-event.types.js';

function makeToolStartEvent(over: Partial<StreamEvent> = {}): StreamEvent {
  return {
    eventType: 'tool_use_start',
    toolName: 'Bash',
    toolUseId: 'tu_1',
    toolInputSummary: 'ls',
    ...over,
  } as StreamEvent;
}

describe('TraceNodeAllocator', () => {
  test('tool_use_start allocates a tool node with parent turn', () => {
    const alloc = new TraceNodeAllocator();
    alloc.startTurn('user input');
    const event = makeToolStartEvent();
    alloc.decorate(event);
    expect(event.traceNode).toBeDefined();
    expect(event.traceNode!.nodeType).toBe('tool');
    expect(event.traceNode!.title).toBe('Bash');
    expect(event.traceNode!.inputSummary).toBe('ls');
    expect(event.traceNode!.status).toBe('running');
  });

  test('tool_use_start auto-allocates a turn if none was started', () => {
    const alloc = new TraceNodeAllocator();
    const event = makeToolStartEvent();
    alloc.decorate(event);
    expect(event.traceNode!.parentNodeId).toBeDefined();
  });

  test('Skill tool_use_start is reclassified as nodeType="skill"', () => {
    const alloc = new TraceNodeAllocator();
    alloc.startTurn();
    const event = makeToolStartEvent({
      toolName: 'Skill',
      skillName: 'github-trending',
      toolInputSummary: '{"name":"github-trending"}',
    });
    alloc.decorate(event);
    expect(event.traceNode!.nodeType).toBe('skill');
    expect(event.traceNode!.title).toBe('Skill:github-trending');
  });

  test('tool_use_start with skillName field but non-Skill toolName still becomes a skill node', () => {
    const alloc = new TraceNodeAllocator();
    alloc.startTurn();
    const event = makeToolStartEvent({
      toolName: 'Bash',
      skillName: 'github-trending',
    });
    alloc.decorate(event);
    expect(event.traceNode!.nodeType).toBe('skill');
  });

  test('tool_use_end + tool_result updates node status and writes outputSummary', () => {
    const alloc = new TraceNodeAllocator();
    alloc.startTurn();
    const startEvent = makeToolStartEvent();
    alloc.decorate(startEvent);
    // tool_use_end fires first — sets status=done but NOT outputSummary
    // (the actual output arrives in a separate tool_result event).
    const endEvent: StreamEvent = {
      eventType: 'tool_use_end',
      toolUseId: 'tu_1',
    } as StreamEvent;
    alloc.decorate(endEvent);
    expect(endEvent.traceNode).toBeDefined();
    expect(endEvent.traceNode!.nodeType).toBe('tool');
    expect(endEvent.traceNode!.status).toBe('done');
    expect(endEvent.traceNode!.outputSummary).toBeUndefined();
    // tool_result fires next — carries the actual output text.
    const resultEvent: StreamEvent = {
      eventType: 'tool_result',
      toolUseId: 'tu_1',
      toolResult: 'file1\nfile2',
    } as StreamEvent;
    alloc.decorate(resultEvent);
    expect(resultEvent.traceNode).toBeDefined();
    expect(resultEvent.traceNode!.outputSummary).toBe('file1\nfile2');
    expect(resultEvent.traceNode!.status).toBe('done');
  });

  test('tool_progress updates node inputSummary from input_json_delta', () => {
    const alloc = new TraceNodeAllocator();
    alloc.startTurn();
    // tool_use_start at content_block_start fires with empty input → inputSummary=null
    const startEvent = makeToolStartEvent({ toolInputSummary: undefined });
    alloc.decorate(startEvent);
    expect(startEvent.traceNode!.inputSummary).toBeUndefined();
    // tool_progress later carries the resolved input summary
    const progressEvent: StreamEvent = {
      eventType: 'tool_progress',
      toolUseId: 'tu_1',
      toolInputSummary: 'command: ls -la',
    } as StreamEvent;
    alloc.decorate(progressEvent);
    expect(progressEvent.traceNode).toBeDefined();
    expect(progressEvent.traceNode!.inputSummary).toBe('command: ls -la');
  });

  test('task_start allocates a subagent node', () => {
    const alloc = new TraceNodeAllocator();
    alloc.startTurn();
    const event: StreamEvent = {
      eventType: 'task_start',
      subagentType: 'web-researcher',
      taskDescription: 'research foo',
    } as StreamEvent;
    alloc.decorate(event);
    expect(event.traceNode!.nodeType).toBe('subagent');
    expect(event.traceNode!.title).toBe('web-researcher');
    expect(event.traceNode!.inputSummary).toBe('research foo');
    expect(event.traceNode!.status).toBe('running');
  });

  test('non-trace events are not decorated', () => {
    const alloc = new TraceNodeAllocator();
    alloc.startTurn();
    const event: StreamEvent = {
      eventType: 'text_delta',
      text: 'hello',
    } as StreamEvent;
    alloc.decorate(event);
    expect(event.traceNode).toBeUndefined();
  });

  test('already-populated traceNode is not overwritten', () => {
    const alloc = new TraceNodeAllocator();
    alloc.startTurn();
    const event = makeToolStartEvent();
    event.traceNode = {
      nodeId: 999,
      nodeType: 'tool',
      parentNodeId: 1,
      status: 'custom',
    };
    alloc.decorate(event);
    expect(event.traceNode.nodeId).toBe(999);
    expect(event.traceNode.status).toBe('custom');
  });

  test('resetTurn clears current turn and active tools', () => {
    const alloc = new TraceNodeAllocator();
    alloc.startTurn();
    const event = makeToolStartEvent();
    alloc.decorate(event);
    alloc.resetTurn();
    // After reset, a new tool_use_start will allocate a fresh turn
    const event2 = makeToolStartEvent({ toolUseId: 'tu_2' });
    alloc.decorate(event2);
    // The new tool's parent should be a fresh turn (different from the first)
    expect(event2.traceNode!.parentNodeId).not.toBe(event.traceNode!.parentNodeId);
  });

  test('nodeIds are allocated monotonically', () => {
    const alloc = new TraceNodeAllocator();
    alloc.startTurn();
    const e1 = makeToolStartEvent({ toolUseId: 'a' });
    const e2 = makeToolStartEvent({ toolUseId: 'b' });
    const e3 = makeToolStartEvent({ toolUseId: 'c' });
    alloc.decorate(e1);
    alloc.decorate(e2);
    alloc.decorate(e3);
    expect(e3.traceNode!.nodeId).toBeGreaterThan(e2.traceNode!.nodeId);
    expect(e2.traceNode!.nodeId).toBeGreaterThan(e1.traceNode!.nodeId);
  });
});
