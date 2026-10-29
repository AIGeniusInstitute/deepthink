import { exec } from 'child_process';
import path from 'path';

import { GROUPS_DIR } from './config.js';
import { getJidsByFolder, getRegisteredGroup } from './db.js';
import { logger } from './logger.js';
import { getSystemSettings } from './runtime-config.js';
import { resolveWorkspaceRoot } from './workspace-root.js';

export interface ScriptRunResult {
  stdout: string;
  stderr: string;
  exitCode: number | null;
  timedOut: boolean;
  durationMs: number;
}

let activeScriptCount = 0;

export function getActiveScriptCount(): number {
  return activeScriptCount;
}

export function hasScriptCapacity(): boolean {
  const { maxConcurrentScripts } = getSystemSettings();
  return activeScriptCount < maxConcurrentScripts;
}

const MAX_BUFFER = 1024 * 1024; // 1MB

/**
 * 脚本任务的工作目录 = 该 group 的工作区根（customCwd 优先）。
 * 之前固定用 data/groups/{folder}，自定义工作区目录的组跑脚本会落在错误 cwd。
 */
export function resolveScriptCwd(groupFolder: string): string {
  for (const jid of getJidsByFolder(groupFolder)) {
    const group = getRegisteredGroup(jid);
    if (group) return resolveWorkspaceRoot(group);
  }
  return path.join(GROUPS_DIR, groupFolder);
}

export async function runScript(
  command: string,
  groupFolder: string,
): Promise<ScriptRunResult> {
  const { scriptTimeout } = getSystemSettings();
  const cwd = resolveScriptCwd(groupFolder);
  const startTime = Date.now();

  activeScriptCount++;

  try {
    return await new Promise<ScriptRunResult>((resolve) => {
      const child = exec(
        command,
        {
          cwd,
          timeout: scriptTimeout,
          maxBuffer: MAX_BUFFER,
          env: {
            PATH: process.env.PATH,
            LANG: process.env.LANG || 'en_US.UTF-8',
            TZ:
              process.env.TZ ||
              Intl.DateTimeFormat().resolvedOptions().timeZone,
            GROUP_FOLDER: groupFolder,
            HOME: process.env.HOME || cwd,
          },
          shell: '/bin/sh',
        },
        (error, stdout, stderr) => {
          activeScriptCount--;
          const durationMs = Date.now() - startTime;
          const timedOut = error?.killed === true;

          if (timedOut) {
            logger.warn(
              { command: command.slice(0, 100), groupFolder, durationMs },
              'Script timed out',
            );
          }

          resolve({
            stdout: stdout.slice(0, MAX_BUFFER),
            stderr: stderr.slice(0, MAX_BUFFER),
            exitCode: timedOut ? null : (child.exitCode ?? (error ? 1 : 0)),
            timedOut,
            durationMs,
          });
        },
      );
    });
  } catch (err) {
    activeScriptCount--;
    const durationMs = Date.now() - startTime;
    logger.error(
      { command: command.slice(0, 100), groupFolder, err },
      'Script exec() threw synchronously',
    );
    return {
      stdout: '',
      stderr: err instanceof Error ? err.message : String(err),
      exitCode: 1,
      timedOut: false,
      durationMs,
    };
  }
}
