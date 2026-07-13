import os from 'node:os';
import { describe, expect, test } from 'vitest';

import { sanitizeLogs } from '../src/routes/bug-report.js';

// sanitizeLogs is a security boundary: it masks credentials, env values, and
// absolute paths before log text is embedded in a bug report and sent to the
// LLM / GitHub. These tests pin the behavior so a future regex/cap change that
// re-introduces a leak (or destroys benign context) fails CI instead of slipping
// through review.
describe('sanitizeLogs — credential masking', () => {
  test('masks a comma-separated secret value whole (no post-comma leak)', () => {
    expect(sanitizeLogs('secret=part1,part2')).toBe('secret=***');
    expect(sanitizeLogs('cookie=a,b,c')).toBe('cookie=***');
  });

  test('masks a value that begins with a comma', () => {
    expect(sanitizeLogs('secret=,abc,def')).toBe('secret=***');
  });

  test('masks a quoted secret that was truncated mid-value (no closing quote)', () => {
    // readRecentLogs slices the buffer and routinely cuts inside a quoted value.
    expect(sanitizeLogs('"api_secret": "9f8e7d6c5b4a')).toBe('"api_secret=***');
    expect(sanitizeLogs('{"feishu":{"app_secret":"cli_9f8e7d6c5b4a')).toBe(
      '{"feishu":{"app_secret=***',
    );
  });

  test('keeps a space-separated non-secret neighbour intact', () => {
    expect(sanitizeLogs('apikey=v, region=us')).toBe('apikey=*** region=us');
  });

  test('masks a JSON secret value but preserves the following field', () => {
    expect(sanitizeLogs('{"secret":"abc","other":"x"}')).toBe(
      '{"secret=***,"other":"x"}',
    );
  });

  test('masks Bearer/Basic scheme tokens and known key formats', () => {
    expect(sanitizeLogs('Authorization: Bearer abc123def456')).not.toContain(
      'abc123def456',
    );
    // The sk- format pass redacts the token body (keeping the sk- prefix marker).
    const out = sanitizeLogs('key=sk-abcdefgh12345');
    expect(out).toBe('key=sk-***');
    expect(out).not.toContain('abcdefgh12345');
  });

  test('does not over-mask ordinary prose that merely mentions a keyword', () => {
    expect(sanitizeLogs('no secret here just text')).toBe(
      'no secret here just text',
    );
  });
});

describe('sanitizeLogs — multi-line safety', () => {
  test('an unterminated quote masks only its own line, not the lines after it', () => {
    const input = 'secret="oops\nhost=prod region=us\napi_key=realvalue123';
    const out = sanitizeLogs(input);
    expect(out).toBe('secret=***\nhost=prod region=us\napi_key=***');
    // The benign middle line and the trailing real credential are handled
    // independently — no cross-line over-masking, no leak.
    expect(out).not.toContain('realvalue123');
    expect(out).toContain('host=prod region=us');
  });
});

describe('sanitizeLogs — absolute path redaction', () => {
  // Use os.homedir() (a leaf path) rather than the project root: depending on
  // the cwd/home layout the home string can be a substring of the project root,
  // which complicates the placeholder. The home path redacts cleanly either way.
  test('replaces an absolute home path with a placeholder', () => {
    const out = sanitizeLogs(os.homedir() + '/some/file.ts');
    expect(out).toContain('<home>');
    expect(out).not.toContain(os.homedir());
  });

  test('redacts a path even when the line straddles the truncation cap', () => {
    // Path redaction runs BEFORE the per-line truncation, so a path crossing the
    // 2000-char cut point is replaced (→ <home>) rather than sliced mid-string
    // and left as a leaked raw fragment. A regression that truncates first would
    // slice the home path before replaceAll could match it, dropping the <home>
    // placeholder — which this test catches.
    const home = os.homedir();
    const line = 'x'.repeat(1990) + home + '/secret-file.ts';
    const out = sanitizeLogs(line);
    expect(out).toContain('<home>');
    expect(out).not.toContain(home);
  });
});

describe('sanitizeLogs — ReDoS resistance', () => {
  test('a long keyword-dense single line is masked quickly (no quadratic stall)', () => {
    // Pre-cap this took ~1.5s and stalled the event loop; the per-line cap keeps
    // it well under a generous bound.
    const huge = 'secret'.repeat(16000); // ~96KB, no separators
    const start = Date.now();
    sanitizeLogs(huge);
    expect(Date.now() - start).toBeLessThan(200);
  });

  test('truncates an over-long line with a marker', () => {
    const line = 'x'.repeat(5000);
    expect(sanitizeLogs(line)).toContain('…[truncated]');
  });
});
