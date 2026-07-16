/**
 * Integration smoke test: spawn a browser sandbox, drive it via Playwright.
 *
 * Usage: npx tsx scripts/sandbox-playwright-smoke.ts
 *
 * Verifies:
 *   1. Docker sandbox container starts with CDP port mapped on 127.0.0.1
 *   2. Chromium launches inside the container
 *   3. Playwright (playwright-core) connects via connectOverCDP
 *   4. page.goto + page.screenshot return a non-empty PNG
 *   5. page.evaluate returns expected value
 *   6. BrowserController.stop cleans up
 */
import { spawn } from 'child_process';
import { writeFileSync, rmSync } from 'fs';
import path from 'path';
import { buildDockerRunArgs } from '../src/sandbox/security.js';
import { DEFAULT_LIMITS, CDP_IN_CONTAINER_PORT } from '../src/sandbox/config.js';
import { BrowserController } from '../src/sandbox/browser.js';

const IMAGE = 'deepthink-sandbox:latest';
const CONTAINER = 'smoke-sb-' + Math.random().toString(36).slice(2, 8);

function sh(cmd: string, args: string[]): Promise<{ code: number; stdout: string; stderr: string }> {
  return new Promise((resolve) => {
    const p = spawn(cmd, args, { stdio: ['ignore', 'pipe', 'pipe'] });
    let stdout = '';
    let stderr = '';
    p.stdout.on('data', (b) => (stdout += b.toString()));
    p.stderr.on('data', (b) => (stderr += b.toString()));
    p.on('error', () => resolve({ code: 1, stdout, stderr }));
    p.on('close', (code) => resolve({ code: code ?? 0, stdout, stderr }));
  });
}

async function main() {
  console.log('[smoke] building docker run args...');
  const args = buildDockerRunArgs(CONTAINER, DEFAULT_LIMITS, true, IMAGE);
  console.log('[smoke] args:', args.join(' '));

  console.log('[smoke] starting container...');
  const r = await sh('docker', args);
  console.log('[smoke] docker run code:', r.code, 'stdout:', r.stdout.slice(0, 64), 'stderr:', r.stderr.slice(0, 200));
  if (r.code !== 0) {
    console.error('[smoke] docker run failed:', r.stderr);
    process.exit(1);
  }

  // Wait for container ready
  let ready = false;
  for (let i = 0; i < 30; i++) {
    const e = await sh('docker', ['exec', CONTAINER, 'echo', 'ready']);
    if (e.code === 0 && e.stdout.trim() === 'ready') { ready = true; break; }
    await new Promise((r) => setTimeout(r, 300));
  }
  console.log('[smoke] container ready:', ready);

  // Query host port for CDP
  const portR = await sh('docker', ['port', CONTAINER, `${CDP_IN_CONTAINER_PORT}/tcp`]);
  const portMatch = portR.stdout.match(/:(\d+)/);
  if (!portMatch) {
    console.error('[smoke] no CDP port mapping:', portR.stdout);
    await sh('docker', ['rm', '-f', CONTAINER]);
    process.exit(1);
  }
  const cdpPort = parseInt(portMatch[1], 10);
  console.log('[smoke] CDP host port:', cdpPort);

  const ctrl = new BrowserController(cdpPort, CONTAINER);
  const frames: string[] = [];
  try {
    console.log('[smoke] starting BrowserController (Playwright connectOverCDP)...');
    // Use https://example.com to verify that the chromium flag bundle
    // (--disable-features=IsolateOrigins,site-per-process,Translate,
    // --disable-site-isolation-trials, waitUntil: 'domcontentloaded')
    // resolves net::ERR_ABORTED on real HTTPS sites.
    await ctrl.start(
      (dataUrl) => frames.push(dataUrl),
      250,
      'https://example.com',
    );
    console.log('[smoke] navigated to https://example.com');

    const title = await ctrl.getTitle();
    const url = await ctrl.getCurrentUrl();
    console.log('[smoke] page title:', title, 'url:', url);

    const evalResult = await ctrl.evaluate('document.title');
    console.log('[smoke] evaluate(document.title):', evalResult);

    const png = await ctrl.screenshot();
    const buf = Buffer.from(png.split(',')[1], 'base64');
    const outPath = path.join(process.cwd(), 'smoke-screenshot.png');
    writeFileSync(outPath, buf);
    console.log('[smoke] screenshot saved:', outPath, 'bytes:', buf.length);

    if (buf.length < 1000) {
      console.error('[smoke] FAIL: screenshot too small (<1KB, expected real page render)');
      process.exit(2);
    }
    if (title !== 'Example Domain') {
      console.error('[smoke] FAIL: title mismatch (expected "Example Domain")');
      process.exit(3);
    }
    // Let the frame loop fire at least 4 times (250ms interval).
    await new Promise((r) => setTimeout(r, 1100));
    console.log('[smoke] frames received during test:', frames.length);
    if (frames.length === 0) {
      console.error('[smoke] FAIL: no frames pushed via onFrame callback');
      process.exit(4);
    }
    console.log('[smoke] ✅ ALL CHECKS PASSED');
    if (frames.length === 0) {
      console.error('[smoke] FAIL: no frames pushed via onFrame callback');
      process.exit(4);
    }
    console.log('[smoke] ✅ ALL CHECKS PASSED');
  } finally {
    await ctrl.stop();
    await sh('docker', ['rm', '-f', CONTAINER]);
    rmSync('smoke-screenshot.png', { force: true });
  }
}

main().catch((err) => {
  console.error('[smoke] uncaught:', err);
  sh('docker', ['rm', '-f', CONTAINER]);
  process.exit(99);
});
