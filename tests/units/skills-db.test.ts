// Regression test for the skills DB table (FP1): skills table builds in
// SQLite, seedBuiltinSkills seeds the 6 office quick skills, and the helper
// queries (listSkillsForUser / listBuiltinQuickSkills / getSkillById /
// getSkillContents) return correct rows.

import { beforeAll, describe, expect, test, vi } from 'vitest';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'skills-pg-test-'));
const tmpStoreDir = path.join(tmpDir, 'db');
const tmpGroupsDir = path.join(tmpDir, 'groups');
fs.mkdirSync(tmpStoreDir, { recursive: true });
fs.mkdirSync(tmpGroupsDir, { recursive: true });

vi.mock('../../src/config.js', async () => ({
  STORE_DIR: tmpStoreDir,
  GROUPS_DIR: tmpGroupsDir,
}));

const { initDatabase, getDb } = await import('../../src/db.js');
const {
  seedBuiltinSkills,
  listSkillsForUser,
  listBuiltinQuickSkills,
  getSkillById,
  getSkillContents,
} = await import('../../src/db.js');

beforeAll(() => {
  initDatabase();
  // seedBuiltinSkills is called inside initDatabase (best-effort); call again
  // to verify idempotency (ON CONFLICT DO UPDATE).
  seedBuiltinSkills();
});

describe('skills table (FP1)', () => {
  test('skills table exists with expected columns', () => {
    const cols = getDb()
      .prepare("PRAGMA table_info('skills')")
      .all() as Array<{ name: string }>;
    const names = cols.map((c) => c.name);
    expect(names).toContain('id');
    expect(names).toContain('scope');
    expect(names).toContain('quick_label');
    expect(names).toContain('quick_prompt');
    expect(names).toContain('content');
  });

  test('seedBuiltinSkills seeds the 6 office quick skills', () => {
    const quick = listBuiltinQuickSkills();
    // 6 builtin office skills: ppt, excel, pdf, ocr, word, markdown
    expect(quick.length).toBeGreaterThanOrEqual(6);
    const labels = quick.map((s) => s.quick_label);
    expect(labels).toContain('PPT制作');
    expect(labels).toContain('Excel表格');
    expect(labels).toContain('PDF处理');
    expect(labels).toContain('WORD文档');
    expect(labels).toContain('Markdown文档');
  });

  test('seedBuiltinSkills is idempotent (no duplicate rows)', () => {
    const before = getDb().prepare("SELECT COUNT(*) as n FROM skills WHERE scope='builtin'").get() as { n: number };
    seedBuiltinSkills();
    seedBuiltinSkills();
    const after = getDb().prepare("SELECT COUNT(*) as n FROM skills WHERE scope='builtin'").get() as { n: number };
    expect(after.n).toBe(before.n);
  });

  test('listSkillsForUser returns builtin skills for any user', () => {
    const rows = listSkillsForUser('any-user-id');
    const builtin = rows.filter((r) => r.scope === 'builtin');
    expect(builtin.length).toBeGreaterThanOrEqual(6);
  });

  test('getSkillById returns a builtin skill', () => {
    const row = getSkillById('builtin-ppt');
    expect(row).not.toBeNull();
    expect(row!.name).toBeTruthy();
  });

  test('getSkillContents returns content for selected ids', () => {
    const rows = getSkillContents(['builtin-ppt', 'builtin-excel', 'nonexistent']);
    expect(rows.length).toBe(2);
    for (const r of rows) {
      expect(r.content).toBeDefined();
    }
  });
});
