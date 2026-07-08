import { describe, expect, test } from 'vitest';

import { hashManifest, type HarnessManifest } from '../../src/harness-registry.js';

function baseManifest(overrides: Partial<HarnessManifest> = {}): HarnessManifest {
  return {
    schema_version: 1,
    captured_at: '2026-07-09T00:00:00.000Z',
    system_prompt: 'you are an agent',
    subagents: {
      'code-reviewer': {
        description: 'reviewer',
        prompt: 'review code',
        tools: ['Read'],
        model: 'inherit',
        maxTurns: 10,
      },
    },
    tool_signatures: [{ name: 'Read', description: 'read file' }],
    skill_ids: ['agent-browser'],
    claude_md_hash: 'abc',
    source_files: [{ path: 'CLAUDE.md', hash: 'abc' }],
    ...overrides,
  };
}

describe('harness-registry: hashManifest', () => {
  test('is stable across calls with identical content', () => {
    const m = baseManifest();
    expect(hashManifest(m)).toBe(hashManifest({ ...m }));
  });

  test('changes when system_prompt changes', () => {
    const a = baseManifest({ system_prompt: 'x' });
    const b = baseManifest({ system_prompt: 'y' });
    expect(hashManifest(a)).not.toBe(hashManifest(b));
  });

  test('changes when subagent prompt changes', () => {
    const a = baseManifest({
      subagents: { 'code-reviewer': { description: 'r', prompt: 'p1', tools: [], model: 'inherit', maxTurns: 10 } },
    });
    const b = baseManifest({
      subagents: { 'code-reviewer': { description: 'r', prompt: 'p2', tools: [], model: 'inherit', maxTurns: 10 } },
    });
    expect(hashManifest(a)).not.toBe(hashManifest(b));
  });

  test('ignores captured_at (non-semantic field)', () => {
    const a = baseManifest({ captured_at: '2026-01-01' });
    const b = baseManifest({ captured_at: '2026-12-31' });
    expect(hashManifest(a)).toBe(hashManifest(b));
  });

  test('changes when tool added', () => {
    const a = baseManifest({ tool_signatures: [{ name: 'Read', description: 'r' }] });
    const b = baseManifest({ tool_signatures: [{ name: 'Read', description: 'r' }, { name: 'Write', description: 'w' }] });
    expect(hashManifest(a)).not.toBe(hashManifest(b));
  });

  test('changes when skill added', () => {
    const a = baseManifest({ skill_ids: ['a'] });
    const b = baseManifest({ skill_ids: ['a', 'b'] });
    expect(hashManifest(a)).not.toBe(hashManifest(b));
  });
});
