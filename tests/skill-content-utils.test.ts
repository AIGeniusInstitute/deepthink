import { describe, expect, test } from 'vitest';
import os from 'node:os';
import path from 'node:path';
import fs from 'node:fs';
import {
  slugifySkillName,
  validateSkillContent,
  validateZipEntries,
  resolveSkillIdConflict,
  writeSkillContent,
  getSkillContentPath,
  backupSkillContent,
} from '../src/skill-content-utils.js';

// Mock DATA_DIR via fs operations on os.tmpdir()
function makeTempUserDir(): string {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'skill-test-'));
  return dir;
}

describe('slugifySkillName', () => {
  test('lowercases and kebab-cases', () => {
    expect(slugifySkillName('GitHub Trending 爬虫')).toBe('github-trending');
  });
  test('collapses repeated hyphens and whitespace', () => {
    expect(slugifySkillName('Hello   World--Foo')).toBe('hello-world-foo');
  });
  test('strips leading/trailing hyphens', () => {
    expect(slugifySkillName('  ---hello---  ')).toBe('hello');
  });
  test('returns fallback for all-non-ascii input', () => {
    expect(slugifySkillName('你好世界')).toBe('untitled-skill');
  });
  test('preserves digits', () => {
    expect(slugifySkillName('Skill v2 Loader')).toBe('skill-v2-loader');
  });
});

describe('validateSkillContent', () => {
  test('accepts valid frontmatter with name + description', () => {
    const content = `---
name: my-skill
description: A test skill
---

# Body
Hello`;
    const r = validateSkillContent(content);
    expect(r.valid).toBe(true);
    expect(r.frontmatter?.name).toBe('my-skill');
  });

  test('accepts folded description', () => {
    const content = `---
name: my-skill
description: >
  A long description
  spanning multiple lines
---

Body`;
    const r = validateSkillContent(content);
    expect(r.valid).toBe(true);
    expect(r.frontmatter?.description).toContain('A long description');
  });

  test('rejects missing frontmatter start', () => {
    expect(validateSkillContent('name: x\n---\nbody').valid).toBe(false);
  });

  test('rejects missing frontmatter end', () => {
    expect(validateSkillContent('---\nname: x\nbody').valid).toBe(false);
  });

  test('rejects missing name field', () => {
    const content = `---
description: missing name
---
body`;
    expect(validateSkillContent(content).valid).toBe(false);
  });

  test('rejects missing description field', () => {
    const content = `---
name: x
---
body`;
    expect(validateSkillContent(content).valid).toBe(false);
  });

  test('rejects invalid name (with space)', () => {
    const content = `---
name: my skill
description: ok
---
body`;
    expect(validateSkillContent(content).valid).toBe(false);
  });

  test('rejects empty content', () => {
    expect(validateSkillContent('').valid).toBe(false);
  });
});

describe('validateZipEntries', () => {
  test('accepts safe relative paths', () => {
    const r = validateZipEntries(['foo/bar.txt', 'SKILL.md']);
    expect(r.safe).toBe(true);
  });
  test('rejects absolute unix path', () => {
    const r = validateZipEntries(['/etc/passwd']);
    expect(r.safe).toBe(false);
  });
  test('rejects absolute windows path', () => {
    const r = validateZipEntries(['C:\\Users\\foo\\bar']);
    expect(r.safe).toBe(false);
  });
  test('rejects path traversal', () => {
    const r = validateZipEntries(['../escape.txt']);
    expect(r.safe).toBe(false);
  });
  test('rejects null byte', () => {
    const r = validateZipEntries(['foo\0bar']);
    expect(r.safe).toBe(false);
  });
});

describe('resolveSkillIdConflict', () => {
  test('returns baseId when dir does not exist', () => {
    const dir = makeTempUserDir();
    expect(resolveSkillIdConflict(dir, 'my-skill')).toBe('my-skill');
    fs.rmSync(dir, { recursive: true, force: true });
  });
  test('appends -2 when baseId exists', () => {
    const dir = makeTempUserDir();
    fs.mkdirSync(path.join(dir, 'my-skill'), { recursive: true });
    expect(resolveSkillIdConflict(dir, 'my-skill')).toBe('my-skill-2');
    fs.rmSync(dir, { recursive: true, force: true });
  });
  test('appends -3 when baseId and -2 both exist', () => {
    const dir = makeTempUserDir();
    fs.mkdirSync(path.join(dir, 'my-skill'), { recursive: true });
    fs.mkdirSync(path.join(dir, 'my-skill-2'), { recursive: true });
    expect(resolveSkillIdConflict(dir, 'my-skill')).toBe('my-skill-3');
    fs.rmSync(dir, { recursive: true, force: true });
  });
});

describe('writeSkillContent / getSkillContentPath / backupSkillContent', () => {
  test('writes content to SKILL.md and reads it back', () => {
    const userDir = makeTempUserDir();
    // Use the userDir as the skills dir by monkey-patching getUserSkillsDir
    // — but since we can't, we test writeSkillContent via the public API
    // which calls getUserSkillsDir(userId). Instead, test the lower-level
    // behavior by writing directly into a controlled structure.
    // We'll set userId = 'test-user' and verify the file lands under
    // DATA_DIR/skills/test-user/<skillId>/SKILL.md
    const content = `---
name: test-skill
description: test
---
body`;
    writeSkillContent('test-user', 'test-skill', content);
    const p = getSkillContentPath('test-user', 'test-skill');
    expect(p).not.toBeNull();
    expect(fs.readFileSync(p!, 'utf-8')).toBe(content);
    // cleanup
    const skillsDir = path.dirname(path.dirname(p!));
    fs.rmSync(skillsDir, { recursive: true, force: true });
  });

  test('backupSkillContent creates a .bak file preserving current content', () => {
    const original = `---
name: backup-skill
description: original
---
original body`;
    writeSkillContent('test-user', 'backup-skill', original);
    const backupPath = backupSkillContent('test-user', 'backup-skill');
    expect(backupPath).not.toBeNull();
    expect(fs.existsSync(backupPath!)).toBe(true);
    expect(fs.readFileSync(backupPath!, 'utf-8')).toBe(original);
    // cleanup
    const contentPath = getSkillContentPath('test-user', 'backup-skill')!;
    const skillsDir = path.dirname(path.dirname(contentPath));
    fs.rmSync(skillsDir, { recursive: true, force: true });
  });

  test('backupSkillContent keeps at most 5 backups', () => {
    writeSkillContent('test-user', 'trim-skill', `---
name: trim-skill
description: test
---
v0`);
    // Create 7 backups
    for (let i = 0; i < 7; i++) {
      backupSkillContent('test-user', 'trim-skill');
    }
    const contentPath = getSkillContentPath('test-user', 'trim-skill')!;
    const skillDir = path.dirname(contentPath);
    const backups = fs.readdirSync(skillDir).filter((n) => n.startsWith('SKILL.md.bak.'));
    expect(backups.length).toBeLessThanOrEqual(5);
    // cleanup
    const skillsDir = path.dirname(path.dirname(contentPath));
    fs.rmSync(skillsDir, { recursive: true, force: true });
  });
});
