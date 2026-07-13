import { describe, expect, test } from 'vitest';

import {
  buildClaudeEnvLines,
  type ClaudeProviderConfig,
} from '../src/runtime-config.js';

function config(
  patch: Partial<ClaudeProviderConfig>,
): ClaudeProviderConfig {
  return {
    anthropicBaseUrl: 'https://example.test/anthropic',
    anthropicAuthToken: '',
    anthropicApiKey: '',
    claudeCodeOauthToken: '',
    claudeOAuthCredentials: null,
    anthropicModel: 'test-model',
    updatedAt: null,
    ...patch,
  };
}

// Always pass an explicit (empty) profileCustomEnv so buildClaudeEnvLines does
// NOT fall through to getActiveProfileCustomEnv() → readStoredStateV4(), which
// reads (and may lazily migrate-write) the real on-disk claude-provider.json.
// Keeping the test hermetic avoids leaking ambient config and disk mutation.
const NO_CUSTOM_ENV: Record<string, string> = {};

describe('buildClaudeEnvLines', () => {
  test('maps plain third-party auth tokens to ANTHROPIC_API_KEY', () => {
    const lines = buildClaudeEnvLines(
      config({ anthropicAuthToken: 'plain-token' }),
      NO_CUSTOM_ENV,
    );

    expect(lines).toContain('ANTHROPIC_API_KEY=plain-token');
    expect(lines).not.toContain('ANTHROPIC_AUTH_TOKEN=plain-token');
  });

  test('routes explicit Bearer tokens to ANTHROPIC_AUTH_TOKEN without doubling the prefix', () => {
    const lines = buildClaudeEnvLines(
      config({ anthropicAuthToken: 'Bearer upstream-token' }),
      NO_CUSTOM_ENV,
    );

    // The SDK emits `Authorization: Bearer <value>` itself, so the stored value
    // must be the bare token — otherwise the header becomes `Bearer Bearer …`.
    expect(lines).toContain('ANTHROPIC_AUTH_TOKEN=upstream-token');
    expect(lines).not.toContain('ANTHROPIC_AUTH_TOKEN=Bearer upstream-token');
    expect(lines).not.toContain('ANTHROPIC_API_KEY=upstream-token');
  });

  test('preserves newlines in ANTHROPIC_CUSTOM_HEADERS', () => {
    const lines = buildClaudeEnvLines(config({}), {
      ANTHROPIC_CUSTOM_HEADERS: 'x-one: 1\nx-two: 2',
    });

    expect(lines).toContain('ANTHROPIC_CUSTOM_HEADERS=x-one: 1\nx-two: 2');
  });
});
