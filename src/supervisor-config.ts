import { readFile, writeFile, mkdir } from 'node:fs/promises';
import { dirname, join } from 'node:path';
import { logger } from './logger.js';

const CONFIG_DIR = join(process.env.DATA_DIR || './data', 'config');
const CONFIG_FILE = join(CONFIG_DIR, 'supervisor-enabled.json');

interface SupervisorConfig {
  /** Map of chatJid → enabled boolean. Default false. */
  groups: Record<string, boolean>;
}

let cache: SupervisorConfig | null = null;

async function loadConfig(): Promise<SupervisorConfig> {
  if (cache) return cache;
  try {
    const raw = await readFile(CONFIG_FILE, 'utf8');
    cache = JSON.parse(raw) as SupervisorConfig;
  } catch {
    cache = { groups: {} };
  }
  return cache!;
}

async function saveConfig(cfg: SupervisorConfig): Promise<void> {
  try {
    await mkdir(dirname(CONFIG_FILE), { recursive: true });
    await writeFile(CONFIG_FILE, JSON.stringify(cfg, null, 2), 'utf8');
    cache = cfg;
  } catch (err) {
    logger.error({ err }, 'Failed to save supervisor config');
  }
}

export async function isSupervisorEnabled(chatJid: string): Promise<boolean> {
  const cfg = await loadConfig();
  return cfg.groups[chatJid] ?? false;
}

export async function setSupervisorEnabled(chatJid: string, enabled: boolean): Promise<void> {
  const cfg = await loadConfig();
  cfg.groups[chatJid] = enabled;
  await saveConfig(cfg);
}

export async function getAllSupervisorEnabled(): Promise<Record<string, boolean>> {
  const cfg = await loadConfig();
  return cfg.groups;
}
