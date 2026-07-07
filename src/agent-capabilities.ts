/**
 * Agent Capability Preflight — shared capability declarations for host mode.
 *
 * Container mode gets these tools via Dockerfile; host mode relies on the
 * host OS having them installed.  This module detects what's available and
 * returns environment variables + log messages so `runHostAgent()` can act
 * on the results.
 */

import { execFile } from 'child_process';
import { promisify } from 'util';
import fs from 'fs';
import os from 'os';
import path from 'path';
import { fileURLToPath } from 'url';
import { logger } from './logger.js';

const execFileAsync = promisify(execFile);

// Anchor on this source file rather than process.cwd() — pm2 / host mode may
// launch from a different working directory.
const PROJECT_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');

export interface AgentCapability {
  /** Human-readable name */
  name: string;
  /** Binary to look up in $PATH */
  binary: string;
  /** Extra env vars to inject when the tool is present */
  envVars?: Record<string, string>;
  /** Platform-specific overrides for envVars (merged on top) */
  platformEnvVars?: Partial<Record<NodeJS.Platform, Record<string, string>>>;
  /** If true the preflight logs an error; otherwise a warning */
  required: boolean;
  /** One-liner install command shown in the log */
  installHint: string;
}

export const AGENT_CAPABILITIES: AgentCapability[] = [
  {
    name: 'claude-code',
    binary: 'claude',
    required: true,
    installHint:
      'See https://docs.claude.com/claude-code/install.html or: curl -fsSL https://claude.ai/install.sh | bash',
  },
  {
    name: 'feishu-cli',
    binary: 'feishu-cli',
    required: false,
    installHint:
      'See scripts/install-host-tools.sh or: curl -fsSL https://github.com/riba2534/feishu-cli/releases/latest/download/install.sh | sh',
  },
  {
    name: 'agent-browser',
    binary: 'agent-browser',
    platformEnvVars: {
      darwin: {
        AGENT_BROWSER_EXECUTABLE_PATH:
          '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome',
      },
      linux: {
        AGENT_BROWSER_EXECUTABLE_PATH: '/usr/bin/chromium',
      },
    },
    required: false,
    installHint: 'npm install -g agent-browser',
  },
  {
    name: 'uv',
    binary: 'uv',
    required: false,
    installHint: 'curl -LsSf https://astral.sh/uv/install.sh | sh',
  },
];

async function isBinaryAvailable(binary: string): Promise<boolean> {
  if (binary === 'claude' && resolveSdkBundledClaude()) return true;
  try {
    await execFileAsync('which', [binary], { timeout: 5_000 });
    return true;
  } catch {
    return false;
  }
}

/**
 * Locate the platform-specific Claude CLI binary shipped inside the SDK package
 * at `container/agent-runner/node_modules/@anthropic-ai/claude-agent-sdk-<plat>-<arch>/claude`.
 *
 * Prefer this over `which claude` because:
 *   1. PATH may be polluted by third-party wrappers (e.g. cmux ships its own
 *      `claude` wrapper that hijacks the command and outputs "Not logged in"
 *      when run outside its own terminal session).
 *   2. The SDK binary is the upstream Anthropic build, version-pinned with the
 *      SDK we actually use.
 */
function resolveSdkBundledClaude(): string | null {
  const platMap: Record<string, string> = {
    darwin: 'darwin',
    linux: 'linux',
    win32: 'win32',
  };
  const archMap: Record<string, string> = {
    arm64: 'arm64',
    x64: 'x64',
  };
  const plat = platMap[process.platform];
  const arch = archMap[process.arch];
  if (!plat || !arch) return null;
  const binName = process.platform === 'win32' ? 'claude.exe' : 'claude';
  const candidate = path.join(
    PROJECT_ROOT,
    'container',
    'agent-runner',
    'node_modules',
    '@anthropic-ai',
    `claude-agent-sdk-${plat}-${arch}`,
    binName,
  );
  try {
    fs.accessSync(candidate, fs.constants.X_OK);
    return candidate;
  } catch {
    return null;
  }
}

/**
 * Resolve the actual path of a binary.
 *
 * For `claude`, the SDK-bundled binary takes precedence over PATH lookup —
 * this avoids cmux-style wrappers that shadow `claude` in PATH and break
 * subprocess invocation.
 *
 * Fallback uses `which` because `node_modules/.bin/` may contain stubs that
 * shadow the actual working binary.
 */
async function resolveBinaryPath(binary: string): Promise<string | null> {
  if (binary === 'claude') {
    const bundled = resolveSdkBundledClaude();
    if (bundled) return bundled;
  }
  try {
    const { stdout } = await execFileAsync('which', [binary], {
      timeout: 5_000,
    });
    return stdout.trim() || null;
  } catch {
    return null;
  }
}

export interface CapabilityCheckResult {
  available: AgentCapability[];
  missing: AgentCapability[];
  /** Env vars to inject into the host process (only for available tools) */
  envVars: Record<string, string>;
  /** Resolved paths for specific binaries (keyed by binary name) */
  resolvedPaths: Record<string, string>;
}

let cachedCheck: Promise<CapabilityCheckResult> | null = null;

/** Test-only: drop the cached result so the next call re-probes the host. */
export function resetHostCapabilitiesCache(): void {
  cachedCheck = null;
}

/** Detect which agent capabilities are present on the host. Result is cached
 * for the process lifetime — host tools don't appear/disappear at runtime. */
export function checkHostCapabilities(): Promise<CapabilityCheckResult> {
  if (!cachedCheck) {
    cachedCheck = doCheckHostCapabilities().catch((err) => {
      cachedCheck = null;
      throw err;
    });
  }
  return cachedCheck;
}

async function doCheckHostCapabilities(): Promise<CapabilityCheckResult> {
  const results = await Promise.all(
    AGENT_CAPABILITIES.map(async (cap) => ({
      cap,
      available: await isBinaryAvailable(cap.binary),
    })),
  );

  const available: AgentCapability[] = [];
  const missing: AgentCapability[] = [];
  const envVars: Record<string, string> = {};
  const resolvedPaths: Record<string, string> = {};

  for (const { cap, available: ok } of results) {
    if (ok) {
      available.push(cap);
      if (cap.envVars) Object.assign(envVars, cap.envVars);
      const platformVars = cap.platformEnvVars?.[os.platform()];
      if (platformVars) Object.assign(envVars, platformVars);

      if (cap.binary === 'claude') {
        const resolvedPath = await resolveBinaryPath(cap.binary);
        if (resolvedPath) {
          resolvedPaths[cap.binary] = resolvedPath;
        }
      }
    } else {
      missing.push(cap);
    }
  }

  return { available, missing, envVars, resolvedPaths };
}

/** Log preflight results — warnings for missing, nothing for available. */
export function logCapabilityPreflight(
  groupName: string,
  result: CapabilityCheckResult,
): void {
  if (result.missing.length === 0) return;

  for (const cap of result.missing) {
    const logFn = cap.required
      ? logger.error.bind(logger)
      : logger.warn.bind(logger);
    logFn(
      { group: groupName, tool: cap.name },
      `Host preflight: ${cap.name} not found — some agent capabilities will be unavailable. Install: ${cap.installHint}`,
    );
  }
}
