/**
 * Object Store — pluggable large-file storage for trace I/O.
 *
 * Backends (selected by OBJECT_STORE_PROVIDER env, default 'fs'):
 *   - fs:  local filesystem under DATA_DIR (default; PVC-mounted in K8s).
 *   - s3:  S3-compatible object store (MinIO / AWS S3). Lazy-imports
 *          @aws-sdk/client-s3 at runtime via a VARIABLE import name so tsc
 *          does not resolve it; install the package (optionalDependency)
 *          when the s3 backend is selected, otherwise put/get throw clearly.
 *
 * Write path (offloadLargeIo) stays SYNCHRONOUS for the fs backend (deterministic,
 * immediately available) and uses a fire-and-forget async put for s3 (the DB
 * output_ref is set to the deterministic s3:// ref upfront; the object lands in
 * S3 within ~100ms, well before any later trace replay). Read path (HTTP route)
 * is async either way.
 *
 * The stored `output_ref` is an opaque string: an absolute fs path (fs backend)
 * or `s3://<bucket>/<key>` (s3 backend). Both write & read go through here so the
 * two ends stay symmetric (see issue: trace read/write path mismatch).
 */

import { writeFileSync, readFileSync, mkdirSync, existsSync, unlinkSync, renameSync, readdirSync, statSync, rmdirSync } from 'node:fs';
import { join, dirname, relative } from 'node:path';
import { DATA_DIR } from './config.js';
import { logger } from './logger.js';

export type ObjectStoreProvider = 'fs' | 's3';

export const objectStoreProvider: ObjectStoreProvider =
  (process.env.OBJECT_STORE_PROVIDER as ObjectStoreProvider) || 'fs';

const S3_BUCKET = process.env.S3_BUCKET || 'deepthink';
const S3_ENDPOINT = process.env.S3_ENDPOINT || ''; // e.g. http://minio:9000
const S3_REGION = process.env.S3_REGION || 'us-east-1';
const S3_FORCE_PATH_STYLE = process.env.S3_FORCE_PATH_STYLE !== 'false'; // MinIO needs true

/** True when the S3 backend is selected. fs is the default. */
export const isS3Enabled = objectStoreProvider === 's3' && !!S3_ENDPOINT;

interface S3Handle { client: any; mod: any; }
let _s3Handle: S3Handle | null = null;
let _s3ImportAttempted = false;

/**
 * Lazy-load @aws-sdk/client-s3. The module name is held in a variable so tsc's
 * module resolution cannot statically resolve it — the package is an
 * optionalDependency and may be absent in fs-only deployments.
 */
async function loadS3(): Promise<S3Handle> {
  if (_s3Handle) return _s3Handle;
  if (_s3ImportAttempted) throw new Error('S3 client unavailable (see prior error)');
  _s3ImportAttempted = true;
  try {
    const modName = '@aws-sdk/client-s3';
    const mod = await import(modName);
    _s3Handle = {
      mod,
      client: new mod.S3Client({
        endpoint: S3_ENDPOINT,
        region: S3_REGION,
        forcePathStyle: S3_FORCE_PATH_STYLE,
        credentials: {
          accessKeyId: process.env.S3_ACCESS_KEY_ID || '',
          secretAccessKey: process.env.S3_SECRET_ACCESS_KEY || '',
        },
      }),
    };
    return _s3Handle;
  } catch (err) {
    logger.error({ err }, 'Failed to load @aws-sdk/client-s3 — install it for the S3 backend');
    throw err;
  }
}

/**
 * Build the object-store ref for a trace I/O blob. Deterministic so write &
 * read agree without coordination.
 */
export function buildTraceIoRef(traceId: string, spanId: string, side: 'in' | 'out'): string {
  const key = `trace-io/${traceId}/${spanId}.${side}.json`;
  if (isS3Enabled) return `s3://${S3_BUCKET}/${key}`;
  return join(DATA_DIR, 'trace-io', traceId, `${spanId}.${side}.json`);
}

/**
 * Put a trace I/O blob.
 * - fs backend: synchronous write (returns immediately, file on disk).
 * - s3 backend: fire-and-forget async upload; the ref is already deterministic.
 */
export function putTraceIo(
  ref: string,
  content: string,
  _traceId: string,
): void {
  if (isS3Enabled) {
    const key = ref.replace(`s3://${S3_BUCKET}/`, '');
    // Fire-and-forget; errors logged, do not block the sync persist path.
    loadS3()
      .then(async ({ client, mod }) => {
        await client.send(new mod.PutObjectCommand({
          Bucket: S3_BUCKET,
          Key: key,
          Body: content,
          ContentType: 'application/json',
        }));
      })
      .catch((err: unknown) => {
        logger.warn({ err, ref }, 'S3 putObject failed for trace I/O');
      });
    return;
  }
  // fs: ensure parent dir, sync write (current behavior).
  mkdirSync(dirname(ref), { recursive: true });
  writeFileSync(ref, content, 'utf8');
}

/**
 * Read a trace I/O blob by ref. Async (HTTP route caller awaits).
 * - fs backend: synchronous readFileSync wrapped in a resolved promise.
 * - s3 backend: GetObject → Body.transformToString.
 */
export async function getTraceIo(ref: string): Promise<string> {
  if (ref.startsWith('s3://')) {
    const { client, mod } = await loadS3();
    const key = ref.replace(`s3://${S3_BUCKET}/`, '');
    const resp = await client.send(new mod.GetObjectCommand({ Bucket: S3_BUCKET, Key: key }));
    return resp.Body.transformToString('utf8');
  }
  return readFileSync(ref, 'utf8');
}

// ─── Workspace File Operations (MinIO / S3 backend) ───
// These mirror file-manager.ts operations but route through the object store
// when S3 is enabled, so workspace files are accessible from any K8s pod.
//
// Contract:
// - Write-through: S3 is primary, local cache under /data/file-cache/ is best-effort.
// - Read-through: try S3 first, fall back to local filesystem.
// - All keys are relative to the group folder root.

const WS_BUCKET = process.env.S3_WS_BUCKET || 'deepthink-workspaces';
const FILE_CACHE_DIR = join(DATA_DIR, 'file-cache');

/** Normalize a group folder + file path into an S3 key. */
function wsS3Key(groupFolder: string, filePath: string): string {
  // filePath is relative to group root, e.g. "src/index.ts"
  return `groups/${groupFolder}/files/${filePath}`;
}

/** Parse S3 key back to group folder + file path. */
function wsFromS3Key(key: string): { groupFolder: string; filePath: string } | null {
  const m = key.match(/^groups\/([^/]+)\/files\/(.+)$/);
  if (!m) return null;
  return { groupFolder: m[1], filePath: m[2] };
}

/** Local cache path for a workspace file (best-effort, not critical). */
function wsLocalPath(groupFolder: string, filePath: string): string {
  return join(FILE_CACHE_DIR, groupFolder, filePath);
}

/** Write a workspace file (sync for fs, async-fire for s3). */
export async function putWorkspaceFile(
  groupFolder: string,
  filePath: string,
  content: string | Buffer,
  contentType?: string,
): Promise<void> {
  if (isS3Enabled) {
    const { client, mod } = await loadS3();
    const key = wsS3Key(groupFolder, filePath);
    await client.send(new mod.PutObjectCommand({
      Bucket: WS_BUCKET,
      Key: key,
      Body: content,
      ContentType: contentType || 'application/octet-stream',
    }));
    // Best-effort local cache write.
    try {
      mkdirSync(dirname(wsLocalPath(groupFolder, filePath)), { recursive: true });
      writeFileSync(wsLocalPath(groupFolder, filePath), content);
    } catch { /* cache write failure is non-fatal */ }
  } else {
    // fs backend: write through file-manager utilities (caller handles).
    // This function is only meaningful under S3 mode.
    throw new Error('putWorkspaceFile requires S3 backend (OBJECT_STORE_PROVIDER=s3)');
  }
}

/** Read a workspace file (async). */
export async function getWorkspaceFile(
  groupFolder: string,
  filePath: string,
): Promise<Buffer | null> {
  if (isS3Enabled) {
    try {
      const { client, mod } = await loadS3();
      const key = wsS3Key(groupFolder, filePath);
      const resp = await client.send(new mod.GetObjectCommand({
        Bucket: WS_BUCKET,
        Key: key,
      }));
      const buf = Buffer.from(await resp.Body.transformToByteArray());
      // Refresh local cache.
      try {
        mkdirSync(dirname(wsLocalPath(groupFolder, filePath)), { recursive: true });
        writeFileSync(wsLocalPath(groupFolder, filePath), buf);
      } catch { /* cache write failure is non-fatal */ }
      return buf;
    } catch (err: any) {
      if (err?.name === 'NoSuchKey') {
        // Fall back to local cache.
        const lp = wsLocalPath(groupFolder, filePath);
        if (existsSync(lp)) return readFileSync(lp);
        return null;
      }
      throw err;
    }
  }
  // fs backend: read from local fs.
  const lp = wsLocalPath(groupFolder, filePath);
  if (existsSync(lp)) return readFileSync(lp);
  return null;
}

/** Delete a workspace file (async). */
export async function deleteWorkspaceFile(
  groupFolder: string,
  filePath: string,
): Promise<void> {
  if (isS3Enabled) {
    const { client, mod } = await loadS3();
    const key = wsS3Key(groupFolder, filePath);
    await client.send(new mod.DeleteObjectCommand({
      Bucket: WS_BUCKET,
      Key: key,
    }));
    // Also delete local cache.
    try { unlinkSync(wsLocalPath(groupFolder, filePath)); } catch { /* ok */ }
  } else {
    try { unlinkSync(wsLocalPath(groupFolder, filePath)); } catch { /* ok */ }
  }
}

/** Move/rename a workspace file (async). S3: copy + delete. */
export async function moveWorkspaceFile(
  groupFolder: string,
  fromPath: string,
  toPath: string,
): Promise<void> {
  if (isS3Enabled) {
    const { client, mod } = await loadS3();
    const fromKey = wsS3Key(groupFolder, fromPath);
    const toKey = wsS3Key(groupFolder, toPath);
    // Copy then delete (S3 has no native rename).
    await client.send(new mod.CopyObjectCommand({
      Bucket: WS_BUCKET,
      Key: toKey,
      CopySource: `/${WS_BUCKET}/${fromKey}`,
    }));
    await client.send(new mod.DeleteObjectCommand({
      Bucket: WS_BUCKET,
      Key: fromKey,
    }));
    // Update local cache.
    try {
      renameSync(wsLocalPath(groupFolder, fromPath), wsLocalPath(groupFolder, toPath));
    } catch { /* cache move failure is non-fatal */ }
  } else {
    renameSync(wsLocalPath(groupFolder, fromPath), wsLocalPath(groupFolder, toPath));
  }
}

/** Metadata for a workspace file entry returned by listWorkspaceFiles. */
export interface WsFileMeta {
  name: string;
  path: string;
  type: 'file' | 'directory';
  size: number;
  modifiedAt: string;
}

/** List workspace files under a prefix (async). */
export async function listWorkspaceFiles(
  groupFolder: string,
  prefix = '',
): Promise<WsFileMeta[]> {
  if (isS3Enabled) {
    const { client, mod } = await loadS3();
    const baseKey = wsS3Key(groupFolder, prefix);
    const listPrefix = prefix ? baseKey : `groups/${groupFolder}/files/`;
    // Ensure prefix ends with / for directory listing semantics, except when empty.
    const effectivePrefix = prefix && !prefix.endsWith('/') ? `groups/${groupFolder}/files/${prefix}` : listPrefix;

    const resp = await client.send(new mod.ListObjectsV2Command({
      Bucket: WS_BUCKET,
      Prefix: effectivePrefix,
      Delimiter: '/',
    }));

    const entries: WsFileMeta[] = [];

    // Directories (CommonPrefixes).
    if (resp.CommonPrefixes) {
      for (const cp of resp.CommonPrefixes) {
        const dirKey = cp.Prefix!;
        const rel = wsFromS3Key(dirKey.replace(/\/$/, ''));
        if (!rel) continue;
        entries.push({
          name: rel.filePath.split('/').pop() || rel.filePath,
          path: rel.filePath,
          type: 'directory',
          size: 0,
          modifiedAt: new Date().toISOString(),
        });
      }
    }

    // Files.
    if (resp.Contents) {
      for (const obj of resp.Contents) {
        if (!obj.Key || obj.Key.endsWith('/')) continue;
        const rel = wsFromS3Key(obj.Key);
        if (!rel) continue;
        // Skip the prefix item itself.
        if (rel.filePath === prefix) continue;
        entries.push({
          name: rel.filePath.split('/').pop() || rel.filePath,
          path: rel.filePath,
          type: 'file',
          size: obj.Size ?? 0,
          modifiedAt: obj.LastModified?.toISOString() || new Date().toISOString(),
        });
      }
    }

    return entries;
  }

  // fs backend.
  const dir = wsLocalPath(groupFolder, prefix);
  if (!existsSync(dir)) return [];
  const entries: WsFileMeta[] = [];
  const items = readdirSync(dir, { withFileTypes: true });
  for (const item of items) {
    const relPath = prefix ? `${prefix}/${item.name}` : item.name;
    const absPath = join(dir, item.name);
    const st = statSync(absPath);
    entries.push({
      name: item.name,
      path: relPath,
      type: item.isDirectory() ? 'directory' : 'file',
      size: st.size,
      modifiedAt: st.mtime.toISOString(),
    });
  }
  return entries;
}

/** Ensure the workspace bucket exists (idempotent, called at startup). */
export async function ensureWorkspaceBucket(): Promise<void> {
  if (!isS3Enabled) return;
  try {
    const { client, mod } = await loadS3();
    await client.send(new mod.CreateBucketCommand({ Bucket: WS_BUCKET }));
    logger.info({ bucket: WS_BUCKET }, 'MinIO workspace bucket ensured');
  } catch (err: any) {
    // BucketAlreadyOwnedByYou / BucketAlreadyExists — ok.
    if (err?.name === 'BucketAlreadyOwnedByYou' || err?.name === 'BucketAlreadyExists') {
      logger.info({ bucket: WS_BUCKET }, 'MinIO workspace bucket already exists');
      return;
    }
    logger.warn({ err, bucket: WS_BUCKET }, 'Failed to ensure workspace bucket (non-blocking)');
  }
}
