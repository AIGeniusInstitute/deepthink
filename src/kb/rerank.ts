/**
 * Optional cross-encoder reranking for retrieval results.
 *
 * Config lives at data/config/rerank.json (same shape and 0600 handling as
 * embedding.json). Unconfigured — the default — means retrieval returns its
 * fused order untouched; reranking is an enhancement, never a prerequisite.
 *
 * Exposes scores rather than reordered items so callers keep ownership of
 * their own hit type and this module stays free of retrieval imports.
 */

import fs from 'node:fs';
import path from 'node:path';
import { logger } from '../logger.js';
import { DATA_DIR } from '../config.js';

const RERANK_CONFIG_PATH = path.join(DATA_DIR, 'config', 'rerank.json');
const REQUEST_TIMEOUT_MS = 20_000;
/** Cross-encoders are O(n) per document; cap the head we send. */
export const MAX_RERANK_CANDIDATES = 50;

export interface RerankConfig {
  baseUrl: string;
  apiKey: string;
  model: string;
}

let cached: RerankConfig | null | undefined = undefined;
let cachedMtime = 0;

export function getRerankConfig(): RerankConfig | null {
  try {
    if (!fs.existsSync(RERANK_CONFIG_PATH)) {
      cached = null;
      return null;
    }
    const stat = fs.statSync(RERANK_CONFIG_PATH);
    if (cached !== undefined && stat.mtimeMs === cachedMtime) return cached;
    const parsed = JSON.parse(fs.readFileSync(RERANK_CONFIG_PATH, 'utf8')) as Partial<RerankConfig>;
    if (!parsed.baseUrl || !parsed.apiKey || !parsed.model) {
      cached = null;
      return null;
    }
    cached = {
      baseUrl: parsed.baseUrl.replace(/\/+$/, ''),
      apiKey: parsed.apiKey,
      model: parsed.model,
    };
    cachedMtime = stat.mtimeMs;
    return cached;
  } catch {
    cached = null;
    return null;
  }
}

export function isRerankConfigured(): boolean {
  return getRerankConfig() !== null;
}

export function saveRerankConfig(config: RerankConfig): void {
  fs.mkdirSync(path.dirname(RERANK_CONFIG_PATH), { recursive: true });
  const tmp = `${RERANK_CONFIG_PATH}.tmp`;
  fs.writeFileSync(
    tmp,
    JSON.stringify(
      {
        baseUrl: config.baseUrl.replace(/\/+$/, ''),
        apiKey: config.apiKey,
        model: config.model,
      },
      null,
      2,
    ),
    { mode: 0o600 },
  );
  fs.renameSync(tmp, RERANK_CONFIG_PATH);
  cached = undefined;
  cachedMtime = 0;
}

/**
 * Score `texts` against `query`. Returns one score per input, aligned by index,
 * or null when reranking is unavailable or the call fails — callers then keep
 * their existing order.
 */
export async function rerankScores(
  query: string,
  texts: string[],
): Promise<number[] | null> {
  const config = getRerankConfig();
  if (!config || texts.length === 0) return null;

  try {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), REQUEST_TIMEOUT_MS);
    const res = await fetch(`${config.baseUrl}/rerank`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        Authorization: `Bearer ${config.apiKey}`,
      },
      body: JSON.stringify({
        model: config.model,
        query,
        documents: texts,
        top_n: texts.length,
      }),
      signal: controller.signal,
    });
    clearTimeout(timer);
    if (!res.ok) {
      const detail = await res.text().catch(() => '');
      logger.warn(
        { status: res.status, detail: detail.slice(0, 200) },
        'Rerank API returned non-OK status',
      );
      return null;
    }
    const json = (await res.json()) as {
      results?: Array<{ index?: number; relevance_score?: number; score?: number }>;
    };
    if (!Array.isArray(json.results)) return null;

    const scores = new Array<number>(texts.length).fill(0);
    let seen = false;
    for (const r of json.results) {
      const idx = typeof r.index === 'number' ? r.index : -1;
      if (idx < 0 || idx >= texts.length) continue;
      const s = typeof r.relevance_score === 'number' ? r.relevance_score : r.score;
      if (typeof s === 'number' && Number.isFinite(s)) {
        scores[idx] = s;
        seen = true;
      }
    }
    return seen ? scores : null;
  } catch (err) {
    logger.warn({ err }, 'Rerank API call failed');
    return null;
  }
}

export async function testRerankConnection(): Promise<{ success: boolean; error?: string }> {
  const config = getRerankConfig();
  if (!config) return { success: false, error: 'Rerank is not configured' };
  const scores = await rerankScores('ping', ['ping', 'pong']);
  if (!scores) return { success: false, error: 'Rerank endpoint returned no scores' };
  return { success: true };
}
