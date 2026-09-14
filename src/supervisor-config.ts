import { readFile, writeFile, mkdir } from 'node:fs/promises';
import { dirname, join } from 'node:path';
import { logger } from './logger.js';
import { isRedisConnected } from './redis-bus.js';

const CONFIG_DIR = join(process.env.DATA_DIR || './data', 'config');
const CONFIG_FILE = join(CONFIG_DIR, 'supervisor-enabled.json');

/** Redis key: single hash where field=chatJid, value=JSON GroupMode. */
const REDIS_KEY = 'deepthink:supervisor-config';

interface GroupMode {
  /** Whether the pre-dispatch Supervisor intent parser is enabled for this chat. Default false. */
  supervisor?: boolean;
  /** Whether this chat runs in 全托管 (autonomous) mode. Default false.
   *  When true, Supervisor clarify is bypassed and agent-runner auto-continues
   *  on end-of-turn questions. */
  autonomous?: boolean;
}

interface SupervisorConfig {
  /** Map of chatJid → mode flags. Backward compatible: legacy entries
   * (plain booleans) are auto-migrated to { supervisor: boolean } on read. */
  groups: Record<string, boolean | GroupMode>;
}

let cache: SupervisorConfig | null = null;

/** Return the Redis pub client (connected), or null if Redis is unavailable. */
async function getRedisPub(): Promise<any | null> {
  if (!isRedisConnected()) return null;
  try {
    const { createClient } = await import('redis');
    const pub = createClient({ url: process.env.REDIS_URL! });
    await pub.connect();
    return pub;
  } catch {
    return null;
  }
}

function normalizeGroupMode(raw: boolean | GroupMode | undefined): GroupMode {
  if (raw === undefined || raw === null) return {};
  if (typeof raw === 'boolean') return { supervisor: raw };
  return {
    supervisor: raw.supervisor,
    autonomous: raw.autonomous,
  };
}

async function loadConfigFromFile(): Promise<SupervisorConfig> {
  try {
    const raw = await readFile(CONFIG_FILE, 'utf8');
    const parsed = JSON.parse(raw) as SupervisorConfig;
    const normalized: Record<string, GroupMode> = {};
    for (const [jid, val] of Object.entries(parsed.groups ?? {})) {
      normalized[jid] = normalizeGroupMode(val);
    }
    return { groups: normalized };
  } catch {
    return { groups: {} };
  }
}

/** Load config: Redis-first, file fallback. On Redis miss, seed from file. */
async function loadConfig(): Promise<SupervisorConfig> {
  if (cache) return cache;

  const pub = await getRedisPub();
  if (pub) {
    try {
      const raw = await pub.hGetAll(REDIS_KEY);
      // raw is Record<string, string> — each value is JSON of GroupMode
      const groups: Record<string, GroupMode> = {};
      for (const [jid, json] of Object.entries(raw)) {
        try {
          groups[jid] = normalizeGroupMode(JSON.parse(json as string));
        } catch { /* skip corrupt entry */ }
      }
      await pub.quit();
      cache = { groups };
      return cache!;
    } catch {
      // Redis read failed — fall through to file
      try { await pub.quit(); } catch { /* ignore */ }
    }
  }

  // File fallback
  cache = await loadConfigFromFile();
  return cache!;
}

async function saveConfig(cfg: SupervisorConfig): Promise<void> {
  // Write to Redis (primary, best-effort)
  const pub = await getRedisPub();
  if (pub) {
    try {
      // Build multi-exec: HSET all entries, then DEL removed ones
      // Use a transaction to keep it atomic
      const entries: string[] = [];
      for (const [jid, mode] of Object.entries(cfg.groups)) {
        entries.push(jid, JSON.stringify(mode));
      }
      // Read existing keys to find removed ones
      const existingKeys = await pub.hKeys(REDIS_KEY);
      const newKeys = new Set(Object.keys(cfg.groups));
      const removed = existingKeys.filter((k: string) => !newKeys.has(k));

      const multi = pub.multi();
      if (entries.length > 0) {
        multi.hSet(REDIS_KEY, entries);
      }
      if (removed.length > 0) {
        multi.hDel(REDIS_KEY, removed);
      }
      await multi.exec();
    } catch (err) {
      logger.warn({ err }, 'Failed to write supervisor config to Redis (non-fatal)');
    }
    try { await pub.quit(); } catch { /* ignore */ }
  }

  // Write to file (fallback, best-effort)
  try {
    await mkdir(dirname(CONFIG_FILE), { recursive: true });
    await writeFile(CONFIG_FILE, JSON.stringify(cfg, null, 2), 'utf8');
  } catch (err) {
    logger.error({ err }, 'Failed to save supervisor config file');
  }

  cache = cfg;
}

export async function isSupervisorEnabled(chatJid: string): Promise<boolean> {
  const cfg = await loadConfig();
  return normalizeGroupMode(cfg.groups[chatJid]).supervisor ?? false;
}

export async function setSupervisorEnabled(chatJid: string, enabled: boolean): Promise<void> {
  const cfg = await loadConfig();
  const cur = normalizeGroupMode(cfg.groups[chatJid]);
  cfg.groups[chatJid] = { ...cur, supervisor: enabled };
  await saveConfig(cfg);
}

export async function getAllSupervisorEnabled(): Promise<Record<string, boolean>> {
  const cfg = await loadConfig();
  const out: Record<string, boolean> = {};
  for (const [jid, mode] of Object.entries(cfg.groups)) {
    out[jid] = normalizeGroupMode(mode).supervisor ?? false;
  }
  return out;
}

export async function isAutonomousEnabled(chatJid: string): Promise<boolean> {
  const cfg = await loadConfig();
  return normalizeGroupMode(cfg.groups[chatJid]).autonomous ?? false;
}

export async function setAutonomousEnabled(chatJid: string, enabled: boolean): Promise<void> {
  const cfg = await loadConfig();
  const cur = normalizeGroupMode(cfg.groups[chatJid]);
  cfg.groups[chatJid] = { ...cur, autonomous: enabled };
  await saveConfig(cfg);
}

export async function getAllAutonomousEnabled(): Promise<Record<string, boolean>> {
  const cfg = await loadConfig();
  const out: Record<string, boolean> = {};
  for (const [jid, mode] of Object.entries(cfg.groups)) {
    out[jid] = normalizeGroupMode(mode).autonomous ?? false;
  }
  return out;
}
