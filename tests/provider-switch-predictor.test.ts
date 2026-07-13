import { beforeEach, describe, expect, test, vi } from 'vitest';

// container-runner.willClearSessionOnProviderSwitch reads enabled providers,
// the group env override, and the balancing config from runtime-config, the
// sticky binding from db, and provider health from the shared providerPool
// singleton. We mock the config/db reads and drive the real pool's health so
// the test exercises the actual decision branches.

const mocks = vi.hoisted(() => ({
  enabledProviders: [] as Array<{
    id: string;
    enabled: boolean;
    weight: number;
  }>,
  envOverride: {} as {
    anthropicApiKey?: string;
    anthropicAuthToken?: string;
    anthropicBaseUrl?: string;
  },
  boundId: undefined as string | undefined,
}));

vi.mock('../src/logger.js', () => ({
  logger: { warn: vi.fn(), info: vi.fn(), error: vi.fn(), debug: vi.fn() },
}));

vi.mock('../src/runtime-config.js', async () => {
  const actual = await vi.importActual<
    typeof import('../src/runtime-config.js')
  >('../src/runtime-config.js');
  return {
    ...actual,
    getEnabledProviders: () => mocks.enabledProviders,
    getContainerEnvConfig: () => mocks.envOverride,
    getBalancingConfig: () => ({
      strategy: 'round-robin' as const,
      unhealthyThreshold: 3,
      recoveryIntervalMs: 300_000,
    }),
  };
});

vi.mock('../src/db.js', async () => {
  const actual =
    await vi.importActual<typeof import('../src/db.js')>('../src/db.js');
  return {
    ...actual,
    getSessionProviderId: () => mocks.boundId,
  };
});

const { willClearSessionOnProviderSwitch } =
  await import('../src/container-runner.ts');
const { providerPool } = await import('../src/provider-pool.ts');

function setProviders(...ids: string[]) {
  mocks.enabledProviders = ids.map((id) => ({ id, enabled: true, weight: 1 }));
  providerPool.refreshFromConfig(mocks.enabledProviders, {
    strategy: 'round-robin',
    unhealthyThreshold: 3,
    recoveryIntervalMs: 300_000,
  });
  for (const id of ids) providerPool.resetHealth(id);
}

beforeEach(() => {
  mocks.enabledProviders = [];
  mocks.envOverride = {};
  mocks.boundId = undefined;
});

/**
 * Story (PR #549, ACCEPTANCE #3): a proactive provider switch clears the SDK
 * session inside the runner, so the orchestration layer must inject recent
 * history beforehand. willClearSessionOnProviderSwitch is the trigger; it must
 * fire exactly when trySelectPoolProvider would set resetSession.
 */
describe('willClearSessionOnProviderSwitch', () => {
  test('false when there is no bound provider (fresh session)', () => {
    setProviders('A', 'B');
    mocks.boundId = undefined;
    expect(willClearSessionOnProviderSwitch('grp', null)).toBe(false);
  });

  test('false when the bound provider is still healthy and enabled', () => {
    setProviders('A', 'B');
    mocks.boundId = 'A';
    expect(willClearSessionOnProviderSwitch('grp', null)).toBe(false);
  });

  test('true when the bound provider is unhealthy (will switch away)', () => {
    setProviders('A', 'B');
    mocks.boundId = 'A';
    providerPool.reportFailure('A', true); // force unhealthy immediately
    expect(providerPool.getHealthStatus('A').healthy).toBe(false);
    expect(willClearSessionOnProviderSwitch('grp', null)).toBe(true);
  });

  test('true when the bound provider was removed/disabled', () => {
    setProviders('B', 'C'); // A no longer enabled
    mocks.boundId = 'A';
    expect(willClearSessionOnProviderSwitch('grp', null)).toBe(true);
  });

  test('false when an env-level override bypasses the pool entirely', () => {
    setProviders('B', 'C');
    mocks.boundId = 'A'; // would otherwise be a switch
    mocks.envOverride = { anthropicApiKey: 'sk-xxx' };
    expect(willClearSessionOnProviderSwitch('grp', null)).toBe(false);
  });

  test('false for a single enabled provider equal to the binding', () => {
    setProviders('A');
    mocks.boundId = 'A';
    expect(willClearSessionOnProviderSwitch('grp', null)).toBe(false);
  });

  test('true for a single enabled provider different from the binding', () => {
    setProviders('B');
    mocks.boundId = 'A';
    expect(willClearSessionOnProviderSwitch('grp', null)).toBe(true);
  });

  test('false when no providers are enabled', () => {
    mocks.enabledProviders = [];
    mocks.boundId = 'A';
    expect(willClearSessionOnProviderSwitch('grp', null)).toBe(false);
  });
});
