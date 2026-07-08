import { describe, expect, test } from 'vitest';
import {
  buildSlashCommandList,
  detectSlashToken,
  filterSlashCommands,
  completeSlashToken,
} from '../web/src/lib/slash-commands';
import type { Skill } from '../web/src/stores/skills';

function makeSkill(over: Partial<Skill> = {}): Skill {
  return {
    id: 'x',
    name: 'github-trending',
    description: 'GitHub trending crawler',
    source: 'user',
    enabled: true,
    installedAt: '2026-01-01',
    userInvocable: true,
    allowedTools: [],
    argumentHint: null,
    updatedAt: '2026-01-01',
    files: [],
    ...over,
  } as Skill;
}

describe('buildSlashCommandList', () => {
  test('includes builtins + enabled user-invocable skills', () => {
    const list = buildSlashCommandList([
      makeSkill({ name: 'github-trending', description: '爬取 GitHub trending' }),
    ]);
    const names = list.map((c) => c.name);
    expect(names).toContain('clear');
    expect(names).toContain('cost');
    expect(names).toContain('github-trending');
    const skill = list.find((c) => c.name === 'github-trending')!;
    expect(skill.source).toBe('skill');
    const builtin = list.find((c) => c.name === 'clear')!;
    expect(builtin.source).toBe('builtin');
  });

  test('hides disabled skills and non-user-invocable skills', () => {
    const list = buildSlashCommandList([
      makeSkill({ name: 'disabled-skill', enabled: false }),
      makeSkill({ name: 'auto-skill', userInvocable: false }),
    ]);
    const names = list.map((c) => c.name);
    expect(names).not.toContain('disabled-skill');
    expect(names).not.toContain('auto-skill');
  });
});

describe('detectSlashToken', () => {
  test('detects / at start of input', () => {
    expect(detectSlashToken('/cos', 4)?.match).toBe('/cos');
  });
  test('detects / after whitespace', () => {
    expect(detectSlashToken('hello /cl', 9)?.match).toBe('/cl');
  });
  test('returns null for slash inside a path (no leading whitespace)', () => {
    expect(detectSlashToken('https://foo', 11)).toBeNull();
  });
  test('returns null for empty input', () => {
    expect(detectSlashToken('', 0)).toBeNull();
  });
  test('returns null when / is followed by other chars then space', () => {
    expect(detectSlashToken('/cost ', 6)).toBeNull();
  });
});

describe('filterSlashCommands', () => {
  const list = buildSlashCommandList([]);
  test('empty prefix returns full list', () => {
    expect(filterSlashCommands(list, '').length).toBe(list.length);
  });
  test('prefix filters by startswith (case-insensitive)', () => {
    const filtered = filterSlashCommands(list, 'CO');
    const names = filtered.map((c) => c.name);
    expect(names).toContain('cost');
    expect(names).not.toContain('clear');
  });
});

describe('completeSlashToken', () => {
  test('inserts command name + trailing space when argumentHint present', () => {
    const list = buildSlashCommandList([]);
    const requireMention = list.find((c) => c.name === 'require_mention')!;
    const result = completeSlashToken('/req', 0, 4, requireMention);
    expect(result.text).toBe('/require_mention ');
    expect(result.cursorPos).toBe('/require_mention '.length);
  });
  test('inserts command name without trailing space when no argumentHint', () => {
    const list = buildSlashCommandList([]);
    const clear = list.find((c) => c.name === 'clear')!;
    const result = completeSlashToken('hello /cl', 6, 9, clear);
    expect(result.text).toBe('hello /clear');
    expect(result.cursorPos).toBe('hello /clear'.length);
  });
});
