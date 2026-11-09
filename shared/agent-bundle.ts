/**
 * AgentBundle —— bundle 格式单一真相源（schema / 密钥脱敏 / contentHash）。
 *
 * 同步目标（make sync-types）：
 *   - src/agent-bundle.ts              （后端：导出器）
 *   - sdk/src/agent-bundle.ts          （SDK：加载器）
 *
 * 与其他 shared/ 文件的差异：本文件允许 `node:crypto`（Node 内置，非三方依赖），
 * 因为它只同步到 Node 侧目标（不进 web/），而 contentHash 必须两端逐字节一致，
 * 不能各写一份哈希实现。仍然禁止任何第三方 import。
 */
import { createHash } from 'node:crypto';

// ---------- Manifest ----------

export const BUNDLE_SCHEMA_VERSION = 1;

export interface BundleSecretRef {
  /** `${ENV:NAME}` 形式的引用 */
  ref: string;
  /** 引用被谁使用，如 `mcp/foo` */
  usedBy: string;
  /** 原值为空时为 true，加载端可不提供 */
  optional: boolean;
}

export interface AgentBundleManifest {
  schemaVersion: number;
  agent: { id: string; name: string; kind: string };
  requires: { tier: 'T0' | 'T1' | 'T2'; hostTools: string[] };
  secrets: BundleSecretRef[];
  runtime: {
    engines: string[];
    sdkRange: string;
    nodeRange: string;
    /** Android/移动预留（M0 只写不消费，向前兼容） */
    platform?: 'any' | 'desktop' | 'mobile';
    /** 每个 MCP server 的依赖形态（M0 只写空对象） */
    mcpDeps?: Record<string, 'pure-js' | 'node' | 'native' | 'system'>;
  };
  /** 覆盖除 manifest.json 外全部文件的 sha256（确定性打包） */
  contentHash: string;
}

/** manifest.json 自身不含入 contentHash（它承载 hash），其余全部文件都含入。 */
const HASH_EXCLUDED = new Set(['manifest.json']);

// ---------- 密钥引用 ----------

export const SECRET_REF_RE = /^\$\{ENV:([A-Za-z_][A-Za-z0-9_]*)\}$/;

export function makeSecretRef(envName: string): string {
  return `\${ENV:${envName}}`;
}

export function parseSecretRef(value: string): string | null {
  const m = SECRET_REF_RE.exec(value);
  return m ? m[1] : null;
}

/** HTTP header 名 → 环境变量名：`X-Api-Key` → `X_API_KEY` */
export function envNameForHeader(header: string): string {
  return (
    header
      .toUpperCase()
      .replace(/[^A-Za-z0-9]+/g, '_')
      .replace(/^_+|_+$/g, '') || 'HEADER'
  );
}

/**
 * 把 MCP env map 的全部值替换为 `${ENV:KEY}` 引用（A1.3：值一律不进包）。
 * 原值为空 → optional。
 */
export function redactEnvMap(
  env: Record<string, string> | undefined,
  usedBy: string,
): { redacted: Record<string, string>; secrets: BundleSecretRef[] } {
  const redacted: Record<string, string> = {};
  const secrets: BundleSecretRef[] = [];
  for (const [key, value] of Object.entries(env ?? {})) {
    const ref = makeSecretRef(key);
    redacted[key] = ref;
    secrets.push({ ref, usedBy, optional: !value });
  }
  return { redacted, secrets };
}

/** 同 redactEnvMap，用于 MCP headers（引用名经 envNameForHeader 归一）。 */
export function redactHeadersMap(
  headers: Record<string, string> | undefined,
  usedBy: string,
): { redacted: Record<string, string>; secrets: BundleSecretRef[] } {
  const redacted: Record<string, string> = {};
  const secrets: BundleSecretRef[] = [];
  for (const [key, value] of Object.entries(headers ?? {})) {
    const ref = makeSecretRef(envNameForHeader(key));
    redacted[key] = ref;
    secrets.push({ ref, usedBy, optional: !value });
  }
  return { redacted, secrets };
}

export function dedupeSecrets(secrets: BundleSecretRef[]): BundleSecretRef[] {
  const seen = new Map<string, BundleSecretRef>();
  for (const s of secrets) {
    const k = `${s.ref} ${s.usedBy}`;
    const prev = seen.get(k);
    if (!prev || (prev.optional && !s.optional)) seen.set(k, s);
  }
  return [...seen.values()].sort((a, b) =>
    a.ref === b.ref ? a.usedBy.localeCompare(b.usedBy) : a.ref.localeCompare(b.ref),
  );
}

// ---------- contentHash（确定性） ----------

function toBytes(content: string | Uint8Array): Uint8Array {
  return typeof content === 'string' ? new TextEncoder().encode(content) : content;
}

/**
 * 计算 contentHash：路径归一（正斜杠）→ 排除 manifest.json → 按路径字典序 →
 * 逐条喂 `path \0 byteLength \0 content \0`。与打包顺序 / zip 时间戳无关。
 */
export function computeContentHash(
  files: Iterable<[string, string | Uint8Array]>,
): string {
  const entries: Array<[string, Uint8Array]> = [];
  for (const [p, content] of files) {
    const norm = p.replace(/\\/g, '/').replace(/^\.\//, '');
    if (HASH_EXCLUDED.has(norm)) continue;
    entries.push([norm, toBytes(content)]);
  }
  entries.sort((a, b) => (a[0] < b[0] ? -1 : a[0] > b[0] ? 1 : 0));
  const h = createHash('sha256');
  for (const [p, buf] of entries) {
    h.update(p);
    h.update('\0');
    h.update(String(buf.byteLength));
    h.update('\0');
    h.update(buf);
    h.update('\0');
  }
  return `sha256:${h.digest('hex')}`;
}

export function verifyContentHash(
  manifest: AgentBundleManifest,
  files: Iterable<[string, string | Uint8Array]>,
): { ok: boolean; error?: string } {
  const actual = computeContentHash(files);
  if (actual !== manifest.contentHash) {
    return {
      ok: false,
      error: `contentHash mismatch: manifest declares ${manifest.contentHash}, computed ${actual} — bundle may have been tampered with`,
    };
  }
  return { ok: true };
}

// ---------- manifest 校验 ----------

export function validateManifest(m: unknown): { ok: boolean; error?: string; manifest?: AgentBundleManifest } {
  if (!m || typeof m !== 'object') return { ok: false, error: 'manifest.json is not an object' };
  const man = m as Partial<AgentBundleManifest>;
  if (man.schemaVersion !== BUNDLE_SCHEMA_VERSION) {
    return { ok: false, error: `unsupported schemaVersion: ${man.schemaVersion} (expected ${BUNDLE_SCHEMA_VERSION})` };
  }
  if (!man.agent || typeof man.agent.id !== 'string' || !man.agent.name) {
    return { ok: false, error: 'manifest.agent must have id and name' };
  }
  if (!man.requires || !Array.isArray(man.secrets) || !man.runtime) {
    return { ok: false, error: 'manifest missing requires / secrets / runtime' };
  }
  if (typeof man.contentHash !== 'string' || !man.contentHash.startsWith('sha256:')) {
    return { ok: false, error: 'manifest.contentHash must be sha256:<hex>' };
  }
  return { ok: true, manifest: man as AgentBundleManifest };
}

// ---------- 加载端密钥解析 ----------

/**
 * 递归解析值树中的 `${ENV:...}` 引用。lookup 顺序由调用方决定（显式 secrets 优先）。
 * 返回缺失的必需引用清单（optional 的不算）。
 */
export function resolveSecretRefs<T>(
  value: T,
  lookup: (envName: string) => string | undefined,
): { value: T; missing: string[] } {
  const missing = new Set<string>();
  const walk = (v: unknown): unknown => {
    if (typeof v === 'string') {
      const name = parseSecretRef(v);
      if (!name) return v;
      const resolved = lookup(name);
      if (resolved === undefined || resolved === '') {
        missing.add(name);
        return v;
      }
      return resolved;
    }
    if (Array.isArray(v)) return v.map(walk);
    if (v && typeof v === 'object') {
      const out: Record<string, unknown> = {};
      for (const [k, val] of Object.entries(v as Record<string, unknown>)) out[k] = walk(val);
      return out;
    }
    return v;
  };
  return { value: walk(value) as T, missing: [...missing].sort() };
}
