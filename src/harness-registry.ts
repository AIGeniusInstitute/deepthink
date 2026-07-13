/**
 * Harness Registry — version snapshot, list, diff, promote, rollback.
 *
 * The harness is the model's outer shell: system prompt + subagent defs +
 * tool signatures + skill selection + CLAUDE.md. This module captures that
 * shell as a text manifest (ACE "text-layer evolution") and stores it in the
 * DGM-style archive (data/harness/versions/{id}/manifest.json) + the
 * harness_versions DB table.
 *
 * Design notes:
 * - Manifest is TEXT (JSON), not executable. Mutation unit = prompt/skill
 *   content, never code.
 * - The registry itself is NOT versioned — it's the recorder, not the
 *   recorded. (SEAGym pattern: the eval framework stays out of the archive.)
 * - promote/rollback is a single DB status flip — atomic, reset-free
 *   (Continual Harness).
 * - Failed variants stay in the archive as stepping stones for future
 *   proposals (DGM archive principle).
 */

import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';

import {
  createHarnessVersion,
  getHarnessVersion,
  getPromotedHarnessVersion,
  listHarnessVersions,
  updateHarnessVersionStatus,
  type HarnessVersionRow,
  type HarnessVersionStatus,
} from './db.js';
import { DATA_DIR } from './config.js';
import { logger } from './logger.js';

export const HARNESS_VERSIONS_DIR = path.join(DATA_DIR, 'harness', 'versions');

interface SubagentSnapshot {
  description: string;
  prompt: string;
  tools: string[];
  model: string;
  maxTurns: number;
}

interface ToolSignature {
  name: string;
  description: string;
}

export interface HarnessManifest {
  schema_version: 1;
  captured_at: string;
  system_prompt: string;
  subagents: Record<string, SubagentSnapshot>;
  tool_signatures: ToolSignature[];
  skill_ids: string[];
  claude_md_hash: string;
  source_files: { path: string; hash: string }[];
}

export interface VersionDiff {
  added: string[];
  removed: string[];
  changed: { field: string; from_preview: string; to_preview: string }[];
}

/** Find the repo root by walking up from this file's dirname to locate
 *  CLAUDE.md + container/agent-runner. The compiled dist/ keeps the
 *  same relative structure, so this works in both dev (tsx) and prod. */
function findRepoRoot(): string {
  // Prefer process.cwd() when it contains the expected markers (host-mode
  // admin process runs at repo root).
  const cwd = process.cwd();
  if (
    fs.existsSync(path.join(cwd, 'CLAUDE.md')) &&
    fs.existsSync(path.join(cwd, 'container'))
  ) {
    return cwd;
  }
  // Otherwise walk up from this source file.
  let dir = __dirname;
  for (let i = 0; i < 8; i++) {
    if (
      fs.existsSync(path.join(dir, 'CLAUDE.md')) &&
      fs.existsSync(path.join(dir, 'container'))
    ) {
      return dir;
    }
    const parent = path.dirname(dir);
    if (parent === dir) break;
    dir = parent;
  }
  return cwd;
}

function sha256(content: string): string {
  return crypto.createHash('sha256').update(content).digest('hex');
}

function readFileOrEmpty(filePath: string): string {
  try {
    return fs.readFileSync(filePath, 'utf8');
  } catch {
    return '';
  }
}

/** Parse PREDEFINED_AGENTS from agent-definitions.ts source text.
 *  We read the source rather than import (different ts project) to keep
 *  a single source of truth. */
function parseSubagentsFromSource(
  sourceText: string,
): Record<string, SubagentSnapshot> {
  const result: Record<string, SubagentSnapshot> = {};
  // Match blocks like `'agent-id': { ... }` — tolerant regex, not a full TS parser.
  const blockRe = /'([\w-]+)':\s*\{([\s\S]*?)\n\s*\},/g;
  let m: RegExpExecArray | null;
  while ((m = blockRe.exec(sourceText)) !== null) {
    const id = m[1];
    const body = m[2];
    const description = (body.match(/description:\s*'([\s\S]*?)',/)?.[1] ?? '').replace(/\s*\+\s*$/g, '').trim();
    // prompt is often multi-string concatenation; join the segments.
    const promptMatch = body.match(/prompt:\s*([\s\S]*?),\n\s*tools:/);
    const promptRaw = promptMatch ? promptMatch[1].trim() : '';
    const prompt = promptRaw
      .replace(/^[']*|'$/g, '')
      .replace(/'\s*\+\s*'/g, '')
      .replace(/\\n/g, '\n')
      .trim();
    const toolsRaw = body.match(/tools:\s*\[([\s\S]*?)\]/)?.[1] ?? '';
    const tools = (toolsRaw.match(/'([\w-]+)'/g) ?? []).map((t) => t.replace(/'/g, ''));
    const model = body.match(/model:\s*([^,]+),/)?.[1]?.trim().replace(/'/g, '') ?? 'inherit';
    const maxTurns = parseInt(body.match(/maxTurns:\s*(\d+)/)?.[1] ?? '10', 10);
    result[id] = { description, prompt, tools, model, maxTurns };
  }
  return result;
}

/** Extract tool names from mcp-tools.ts source by scanning `tool({...name: 'xxx'})` patterns. */
function parseToolSignaturesFromSource(sourceText: string): ToolSignature[] {
  const sigs: ToolSignature[] = [];
  const re = /tool\(\s*\{[\s\S]*?name:\s*'([\w-]+)'[\s\S]*?description:\s*'([\s\S]*?)'/g;
  let m: RegExpExecArray | null;
  while ((m = re.exec(sourceText)) !== null) {
    sigs.push({ name: m[1], description: m[2].slice(0, 200) });
  }
  return sigs;
}

/** Scan container/skills/ for skill directory names (the project-level skills). */
function listProjectSkills(repoRoot: string): string[] {
  const skillsDir = path.join(repoRoot, 'container', 'skills');
  try {
    return fs
      .readdirSync(skillsDir, { withFileTypes: true })
      .filter((e) => e.isDirectory())
      .map((e) => e.name);
  } catch {
    return [];
  }
}

/** Capture the current harness as a manifest. Pure function (no DB writes). */
export function captureCurrentHarness(): HarnessManifest {
  const repoRoot = findRepoRoot();
  const agentDefsSrc = readFileOrEmpty(
    path.join(repoRoot, 'container', 'agent-runner', 'src', 'agent-definitions.ts'),
  );
  const mcpToolsSrc = readFileOrEmpty(
    path.join(repoRoot, 'container', 'agent-runner', 'src', 'mcp-tools.ts'),
  );
  const claudeMd = readFileOrEmpty(path.join(repoRoot, 'CLAUDE.md'));

  const subagents = parseSubagentsFromSource(agentDefsSrc);
  const tool_signatures = parseToolSignaturesFromSource(mcpToolsSrc);
  const skill_ids = listProjectSkills(repoRoot);

  const source_files = [
    { path: 'CLAUDE.md', hash: sha256(claudeMd) },
    {
      path: 'container/agent-runner/src/agent-definitions.ts',
      hash: sha256(agentDefsSrc),
    },
    {
      path: 'container/agent-runner/src/mcp-tools.ts',
      hash: sha256(mcpToolsSrc),
    },
  ];

  // System prompt — the SDK preset 'claude_code' is the base; we record the
  // appended pieces (CLAUDE.md body is the main dynamic piece in this repo).
  const system_prompt = claudeMd.slice(0, 32_000);

  return {
    schema_version: 1,
    captured_at: new Date().toISOString(),
    system_prompt,
    subagents,
    tool_signatures,
    skill_ids,
    claude_md_hash: sha256(claudeMd),
    source_files,
  };
}

/** Compute a stable hash for a manifest (used as harness_versions.hash). */
export function hashManifest(manifest: HarnessManifest): string {
  // Hash over the semantically-meaningful fields, excluding captured_at.
  const { captured_at: _ignored, ...rest } = manifest;
  return sha256(JSON.stringify(rest, null, 2));
}

/** Write manifest to data/harness/versions/{id}/manifest.json. */
function writeManifestToDisk(versionId: string, manifest: HarnessManifest): void {
  const dir = path.join(HARNESS_VERSIONS_DIR, versionId);
  fs.mkdirSync(dir, { recursive: true });
  fs.writeFileSync(path.join(dir, 'manifest.json'), JSON.stringify(manifest, null, 2), 'utf8');
}

/** Read manifest from disk (or DB json if disk file missing). */
export function readManifest(versionId: string): HarnessManifest | null {
  const diskPath = path.join(HARNESS_VERSIONS_DIR, versionId, 'manifest.json');
  try {
    const raw = fs.readFileSync(diskPath, 'utf8');
    return JSON.parse(raw) as HarnessManifest;
  } catch {
    // fall back to DB json
    const row = getHarnessVersion(versionId);
    if (!row) return null;
    try {
      return JSON.parse(row.manifest_json) as HarnessManifest;
    } catch {
      return null;
    }
  }
}

/** Snapshot the current harness into a new version row.
 *  If an identical hash already exists and is not rolled_back, returns the
 *  existing row (dedup) — this keeps the archive clean when nothing changed. */
export function snapshotCurrentHarness(opts: {
  source?: string;
  parentId?: string | null;
  notes?: string | null;
  status?: HarnessVersionStatus;
} = {}): HarnessVersionRow {
  const manifest = captureCurrentHarness();
  const hash = hashManifest(manifest);

  // Dedup: if an existing version has the same hash and isn't rolled_back,
  // return it. (DGM keeps variants, but identical re-snapshots are noise.)
  const existing = listHarnessVersions({ limit: 500 });
  const dup = existing.find((v) => v.hash === hash && v.status !== 'rolled_back');
  if (dup) {
    return dup;
  }

  const id = `hv_${Date.now()}_${crypto.randomBytes(6).toString('hex')}`;
  const manifestJson = JSON.stringify(manifest);
  writeManifestToDisk(id, manifest);
  createHarnessVersion({
    id,
    parentId: opts.parentId ?? null,
    hash,
    manifestJson,
    status: opts.status ?? 'experimental',
    source: opts.source ?? 'manual',
    notes: opts.notes ?? null,
  });
  logger.info({ harnessVersionId: id, hash: hash.slice(0, 12) }, 'harness snapshot created');
  return getHarnessVersion(id)!;
}

/** List all versions (newest first). */
export function listVersions(
  opts: { status?: HarnessVersionStatus; limit?: number } = {},
): HarnessVersionRow[] {
  return listHarnessVersions(opts);
}

/** Get one version row. */
export function getVersion(id: string): HarnessVersionRow | undefined {
  return getHarnessVersion(id);
}

/** Get the currently-promoted version (the "live" harness of record). */
export function getPromotedVersion(): HarnessVersionRow | undefined {
  return getPromotedHarnessVersion();
}

/** Promote a version: demote the current promoted to archived, mark target promoted. */
export function promoteVersion(versionId: string): void {
  const target = getHarnessVersion(versionId);
  if (!target) throw new Error(`harness version not found: ${versionId}`);
  if (target.status === 'rolled_back') {
    throw new Error('cannot promote a rolled_back variant — snapshot it fresh instead');
  }
  const current = getPromotedHarnessVersion();
  if (current && current.id !== versionId) {
    updateHarnessVersionStatus(current.id, 'archived');
  }
  updateHarnessVersionStatus(versionId, 'promoted');
  logger.info(
    { promotedId: versionId, demotedId: current?.id ?? null },
    'harness version promoted',
  );
}

/** Rollback to a previously-promoted version: re-promote it, archive the current one.
 *  The failed variant stays in the archive (status=rolled_back) as a stepping stone. */
export function rollbackTo(versionId: string): void {
  const target = getHarnessVersion(versionId);
  if (!target) throw new Error(`harness version not found: ${versionId}`);
  if (target.status === 'rolled_back') {
    // Reviving a rolled_back variant — allowed, it's the DGM "stepping stone" use.
  }
  const current = getPromotedHarnessVersion();
  if (current && current.id !== versionId) {
    // Mark the failed live version as rolled_back (NOT archived — rolled_back
    // signals "tried and rejected", which is the DGM stepping-stone signal).
    updateHarnessVersionStatus(current.id, 'rolled_back');
  }
  updateHarnessVersionStatus(versionId, 'promoted');
  logger.info(
    { rolledBackTo: versionId, failedId: current?.id ?? null },
    'harness version rolled back',
  );
}

/** Diff two manifests by version id. Returns high-level field changes. */
export function diffVersions(aId: string, bId: string): VersionDiff {
  const a = readManifest(aId);
  const b = readManifest(bId);
  if (!a || !b) {
    return { added: [], removed: [], changed: [] };
  }
  const added: string[] = [];
  const removed: string[] = [];
  const changed: VersionDiff['changed'] = [];

  // Subagents
  const aSubs = Object.keys(a.subagents);
  const bSubs = Object.keys(b.subagents);
  for (const k of bSubs) if (!aSubs.includes(k)) added.push(`subagent:${k}`);
  for (const k of aSubs) if (!bSubs.includes(k)) removed.push(`subagent:${k}`);
  for (const k of aSubs.filter((k) => bSubs.includes(k))) {
    if (a.subagents[k].prompt !== b.subagents[k].prompt) {
      changed.push({
        field: `subagent:${k}.prompt`,
        from_preview: a.subagents[k].prompt.slice(0, 80),
        to_preview: b.subagents[k].prompt.slice(0, 80),
      });
    }
  }

  // Tool signatures
  const aTools = new Set(a.tool_signatures.map((t) => t.name));
  const bTools = new Set(b.tool_signatures.map((t) => t.name));
  for (const t of bTools) if (!aTools.has(t)) added.push(`tool:${t}`);
  for (const t of aTools) if (!bTools.has(t)) removed.push(`tool:${t}`);

  // Skills
  for (const s of b.skill_ids) if (!a.skill_ids.includes(s)) added.push(`skill:${s}`);
  for (const s of a.skill_ids) if (!b.skill_ids.includes(s)) removed.push(`skill:${s}`);

  // CLAUDE.md hash
  if (a.claude_md_hash !== b.claude_md_hash) {
    changed.push({
      field: 'CLAUDE.md',
      from_preview: a.claude_md_hash.slice(0, 12),
      to_preview: b.claude_md_hash.slice(0, 12),
    });
  }

  // System prompt
  if (a.system_prompt !== b.system_prompt) {
    changed.push({
      field: 'system_prompt',
      from_preview: a.system_prompt.slice(0, 80),
      to_preview: b.system_prompt.slice(0, 80),
    });
  }

  return { added, removed, changed };
}
