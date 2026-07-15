/**
 * Sandbox type definitions.
 */

import type { SandboxLanguage, SandboxStatus } from './config.js';

export interface SandboxSession {
  id: string;
  userId: string;
  containerName: string;
  language: SandboxLanguage;
  browserEnabled: boolean;
  status: SandboxStatus;
  createdAt: number;
  lastActiveAt: number;
  stoppedAt: number | null;
  stoppedReason: string | null;
  /** Mapped host port for CDP (only when browserEnabled). */
  cdpPort: number | null;
}

export type SandboxExecStatus =
  | 'completed'
  | 'timeout'
  | 'oom'
  | 'killed'
  | 'error';

export interface SandboxExecResult {
  executionId: string;
  sessionId: string;
  status: SandboxExecStatus;
  exitCode: number | null;
  stdout: string;
  stderr: string;
  truncated: boolean;
  durationMs: number;
}

export interface SandboxExecReq {
  language: SandboxLanguage;
  code: string;
  stdin?: string;
  timeoutMs?: number;
}

export interface SandboxBrowserState {
  started: boolean;
  currentUrl: string | null;
  title: string | null;
}
