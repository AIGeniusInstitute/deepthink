import { execFileSync } from 'child_process';
import path from 'path';

// Subdirectories excluded from export: runtime transient state that is
// rebuilt on startup, plus SQLite WAL/shared-memory files (a stopped backend
// has already checkpointed WAL into the main db, but exclude to be safe and
// to match `make backup` semantics).
const EXCLUDES = [
  'data/ipc',
  'data/env',
  'data/deepthink.log',
  'data/db/messages.db-shm',
  'data/db/messages.db-wal',
  'data/groups/*/logs',
  'data/plugins/catalog',
  'data/plugins/runtime',
  'data/harness',
];

export interface BackendLifecycle {
  stop(): Promise<void>;
  start(): Promise<unknown>;
}

function tarData(dataDir: string, destPath: string): void {
  const parent = path.dirname(dataDir);
  const base = path.basename(dataDir);
  execFileSync('tar', [
    '-czf', destPath,
    '-C', parent,
    ...EXCLUDES.flatMap((ex) => ['--exclude', ex]),
    base,
  ]);
}

function untarData(srcPath: string, dataDir: string): void {
  const parent = path.dirname(dataDir);
  execFileSync('tar', ['-xzf', srcPath, '-C', parent]);
}

/**
 * Export the full data/ directory to a tar.gz backup. Stops the backend first
 * so SQLite is quiescent (WAL checkpointed), then restarts it. The backup
 * contains plaintext session-secret.key and claude-provider.key — caller must
 * warn the user to keep the file safe.
 */
export async function exportConfig(opts: {
  dataDir: string;
  destPath: string;
  backend: BackendLifecycle;
}): Promise<void> {
  await opts.backend.stop();
  try {
    tarData(opts.dataDir, opts.destPath);
  } finally {
    await opts.backend.start();
  }
}

/**
 * Import (restore) a tar.gz backup over the current data/. Stops the backend,
 * extracts (overwrites), then restarts. Caller should reload the window after.
 */
export async function importConfig(opts: {
  srcPath: string;
  dataDir: string;
  backend: BackendLifecycle;
}): Promise<void> {
  await opts.backend.stop();
  try {
    untarData(opts.srcPath, opts.dataDir);
  } finally {
    await opts.backend.start();
  }
}
