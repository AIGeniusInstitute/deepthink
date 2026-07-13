/**
 * Skill content utilities — validation, slugify, atomic write, backup.
 * Used by the upgraded skills routes (create/edit/upload/optimize/debug).
 */
import fs from 'fs';
import path from 'path';
import { DATA_DIR } from './config.js';
import {
  parseFrontmatter,
  validateSkillId,
} from './skill-utils.js';

export function getUserSkillsDir(userId: string): string {
  return path.join(DATA_DIR, 'skills', userId);
}

/**
 * Slugify a natural-language string into a valid skill ID ([\w-]+).
 * "GitHub Trending 爬爬虫" → "github-trending"
 */
export function slugifySkillName(input: string): string {
  const s = input
    .toLowerCase()
    .trim()
    // ASCII alphanumerics + hyphens preserved
    .replace(/[^a-z0-9\s-]/g, ' ')
    // collapse whitespace to single hyphen
    .replace(/\s+/g, '-')
    // collapse repeated hyphens
    .replace(/-+/g, '-')
    // strip leading/trailing hyphens
    .replace(/^-+|-+$/g, '');
  return s || 'untitled-skill';
}

/**
 * Resolve a skill ID conflict by appending -2, -3, ... if the directory exists.
 */
export function resolveSkillIdConflict(userDir: string, baseId: string): string {
  if (!fs.existsSync(path.join(userDir, baseId))) return baseId;
  for (let i = 2; i < 100; i++) {
    const candidate = `${baseId}-${i}`;
    if (!fs.existsSync(path.join(userDir, candidate))) return candidate;
  }
  throw new Error('Too many skills with similar name — please choose another name');
}

/**
 * Validate SKILL.md content: must start with --- frontmatter, have name + description,
 * name must match [\w-]+.
 */
export function validateSkillContent(
  content: string,
): { valid: boolean; error?: string; frontmatter?: Record<string, string> } {
  if (!content || typeof content !== 'string') {
    return { valid: false, error: 'Content must be a non-empty string' };
  }
  if (!content.startsWith('---')) {
    return { valid: false, error: 'Missing YAML frontmatter start (---)' };
  }
  const endIndex = content.indexOf('\n---', 3);
  if (endIndex === -1) {
    return { valid: false, error: 'Missing YAML frontmatter end (---)' };
  }
  const frontmatter = parseFrontmatter(content);
  if (!frontmatter.name) {
    return { valid: false, error: 'Missing required frontmatter field: name' };
  }
  if (!frontmatter.description) {
    return { valid: false, error: 'Missing required frontmatter field: description' };
  }
  if (!validateSkillId(frontmatter.name)) {
    return { valid: false, error: `Invalid skill name in frontmatter: ${frontmatter.name}` };
  }
  return { valid: true, frontmatter };
}

/**
 * Return the actual path to the skill's SKILL.md or SKILL.md.disabled file.
 * Returns null if neither exists.
 */
export function getSkillContentPath(userId: string, skillId: string): string | null {
  const skillDir = path.join(getUserSkillsDir(userId), skillId);
  const enabled = path.join(skillDir, 'SKILL.md');
  const disabled = path.join(skillDir, 'SKILL.md.disabled');
  if (fs.existsSync(enabled)) return enabled;
  if (fs.existsSync(disabled)) return disabled;
  return null;
}

/**
 * Atomic write of SKILL.md content.
 * Writes to .tmp then renames. Preserves the enabled/disabled state by writing to
 * whichever file currently exists (defaults to SKILL.md).
 */
export function writeSkillContent(
  userId: string,
  skillId: string,
  content: string,
): void {
  const skillDir = path.join(getUserSkillsDir(userId), skillId);
  fs.mkdirSync(skillDir, { recursive: true });
  const targetPath = getSkillContentPath(userId, skillId) ?? path.join(skillDir, 'SKILL.md');
  const tmpPath = `${targetPath}.tmp.${process.pid}.${Date.now()}`;
  fs.writeFileSync(tmpPath, content, 'utf-8');
  fs.renameSync(tmpPath, targetPath);
}

/**
 * Backup current SKILL.md content to SKILL.md.bak.<timestamp>.
 * Returns the backup path, or null if no content to back up.
 */
export function backupSkillContent(userId: string, skillId: string): string | null {
  const src = getSkillContentPath(userId, skillId);
  if (!src || !fs.existsSync(src)) return null;
  const skillDir = path.dirname(src);
  const backupName = `SKILL.md.bak.${Date.now()}`;
  const backupPath = path.join(skillDir, backupName);
  fs.copyFileSync(src, backupPath);
  // Keep at most 5 most recent backups
  try {
    const backups = fs
      .readdirSync(skillDir)
      .filter((n) => n.startsWith('SKILL.md.bak.'))
      .sort();
    while (backups.length > 5) {
      const old = backups.shift()!;
      fs.unlinkSync(path.join(skillDir, old));
    }
  } catch {
    // ignore cleanup errors
  }
  return backupPath;
}

/**
 * Validate zip entry paths for path traversal / absolute path / null byte attacks.
 */
export function validateZipEntries(entries: string[]): { safe: boolean; reason?: string } {
  for (const entry of entries) {
    if (entry.startsWith('/') || /^[a-zA-Z]:/.test(entry)) {
      return { safe: false, reason: `Absolute path in zip: ${entry}` };
    }
    if (entry.includes('..')) {
      return { safe: false, reason: `Path traversal in zip: ${entry}` };
    }
    if (entry.includes('\0')) {
      return { safe: false, reason: `Null byte in zip entry: ${entry}` };
    }
  }
  return { safe: true };
}
