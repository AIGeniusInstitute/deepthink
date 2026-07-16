/**
 * BrowserController — controls a sandboxed Chromium via Playwright's
 * `connectOverCDP`. The browser process lives inside the sandbox container
 * (subject to cap-drop + memory/cpu/pids limits); the host process
 * connects to the CDP forwarder port (127.0.0.1:{dynamic}) and drives it
 * with the Playwright API, which handles auto-wait, selector strategies,
 * screenshots, and frame management internally.
 *
 * Chromium 150 ignores `--remote-debugging-address` and always binds its
 * DevTools endpoint to 127.0.0.1:9222 — unreachable from the host via
 * Docker port mapping. cdp-forwarder.js (shipped in the image) bridges
 * 0.0.0.0:9223 → 127.0.0.1:9222 so the host can connect.
 *
 * Uses `playwright-core` only (no browser binary download); the sandbox
 * image ships Chromium already.
 */

import { chromium, type Browser, type Page } from 'playwright-core';
import { logger } from '../logger.js';
import { spawn } from 'child_process';
import { CHROMIUM_DEVTOOLS_PORT } from './config.js';

export class BrowserController {
  private browser: Browser | null = null;
  private page: Page | null = null;
  private frameTimer: NodeJS.Timeout | null = null;
  private onFrame: (dataUrl: string) => void = () => {};
  private readonly cdpPort: number;
  private readonly containerName: string;
  private processesStarted = false;

  constructor(cdpPort: number, containerName: string) {
    this.cdpPort = cdpPort;
    this.containerName = containerName;
  }

  async start(
    onFrame: (dataUrl: string) => void,
    frameIntervalMs: number,
    initialUrl?: string,
  ): Promise<void> {
    this.onFrame = onFrame;
    await this.ensureProcessesRunning();

    const endpoint = `http://127.0.0.1:${this.cdpPort}`;
    this.browser = await chromium.connectOverCDP(endpoint, { timeout: 15_000 });

    // Reuse the default context + first page (chromium launched with about:blank).
    const ctx = this.browser.contexts()[0] ?? await this.browser.newContext();
    this.page = ctx.pages()[0] ?? await ctx.newPage();

    if (initialUrl) {
      await this.navigate(initialUrl);
    }
    this.startFrameLoop(frameIntervalMs);
  }

  async navigate(url: string): Promise<void> {
    if (!this.page) throw new Error('浏览器未启动');
    await this.page.goto(url, { waitUntil: 'load', timeout: 30_000 });
  }

  async click(selector: string): Promise<void> {
    if (!this.page) throw new Error('浏览器未启动');
    await this.page.click(selector, { timeout: 10_000 });
  }

  async type(selector: string, text: string): Promise<void> {
    if (!this.page) throw new Error('浏览器未启动');
    await this.page.fill(selector, text, { timeout: 10_000 });
  }

  async screenshot(): Promise<string> {
    if (!this.page) throw new Error('浏览器未启动');
    const buf = await this.page.screenshot({ type: 'png' });
    return `data:image/png;base64,${buf.toString('base64')}`;
  }

  async evaluate(expression: string): Promise<any> {
    if (!this.page) throw new Error('浏览器未启动');
    return await this.page.evaluate(`(() => (${expression}))()`);
  }

  async getTitle(): Promise<string | null> {
    if (!this.page) return null;
    try { return await this.page.title(); } catch { return null; }
  }

  async getCurrentUrl(): Promise<string | null> {
    if (!this.page) return null;
    return this.page.url();
  }

  async stop(): Promise<void> {
    if (this.frameTimer) {
      clearInterval(this.frameTimer);
      this.frameTimer = null;
    }
    if (this.browser) {
      try { await this.browser.close(); } catch { /* ignore */ }
      this.browser = null;
    }
    this.page = null;
    if (this.processesStarted) {
      await this.killProcessesInContainer();
      this.processesStarted = false;
    }
  }

  private startFrameLoop(intervalMs: number): void {
    this.frameTimer = setInterval(async () => {
      try {
        if (!this.page) return;
        const buf = await this.page.screenshot({ type: 'jpeg', quality: 60 });
        this.onFrame(`data:image/jpeg;base64,${buf.toString('base64')}`);
      } catch {
        // swallow — frame loop must not die
      }
    }, intervalMs);
  }

  private async ensureProcessesRunning(): Promise<void> {
    if (this.processesStarted) return;
    // Start chromium in background inside the container.
    // --no-sandbox is acceptable: the container already drops ALL caps,
    // runs as uid 1000 with memory/cpu/pids limits. The kernel sandbox
    // isn't needed because the container IS the sandbox.
    // Wrap in `sh -c` so chromium resolves via PATH (docker exec doesn't
    // source the shell environment by default).
    // Chromium binds 127.0.0.1:9222 (its remote-debugging-address flag is
    // ignored by Chromium 150 for security), so cdp-forwarder.js bridges
    // 0.0.0.0:9223 → 127.0.0.1:9222.
    await this.spawnInContainer(
      `chromium --headless=new --no-sandbox --disable-gpu `
      + `--use-gl=angle --use-angle=swiftshader `
      + `--remote-debugging-port=${CHROMIUM_DEVTOOLS_PORT} `
      + `--disable-dev-shm-usage --user-data-dir=/tmp/chromium about:blank `
      + `> /tmp/chromium.log 2>&1`,
    );
    // Wait briefly for chromium to bind 9222 before starting the forwarder,
    // otherwise the forwarder's first connections will ECONNREFUSE.
    await this.waitForTcpReady('127.0.0.1', CHROMIUM_DEVTOOLS_PORT, 5_000);
    await this.spawnInContainer(
      `node /usr/local/lib/cdp-forwarder.js > /tmp/cdp-forwarder.log 2>&1`,
    );
    this.processesStarted = true;
    // Wait for CDP forwarder to be reachable from the host
    const start = Date.now();
    while (Date.now() - start < 10_000) {
      const ok = await this.pingCdp();
      if (ok) return;
      await new Promise((r) => setTimeout(r, 200));
    }
    throw new Error('Chromium CDP 启动超时');
  }

  private async spawnInContainer(cmd: string): Promise<void> {
    const args = [
      'exec', '-d', '-u', '1000:1000', this.containerName,
      'sh', '-c', cmd,
    ];
    await new Promise<void>((resolve) => {
      const p = spawn('docker', args, { stdio: 'ignore' });
      p.on('close', () => resolve());
      p.on('error', () => resolve());
    });
  }

  private async waitForTcpReady(host: string, port: number, timeoutMs: number): Promise<void> {
    // Probe via `docker exec` curl since /tmp/chromium.log is mode 0700 and
    // we'd need user 1000 to read it — easier to just probe the port.
    const start = Date.now();
    while (Date.now() - start < timeoutMs) {
      const ok = await new Promise<boolean>((resolve) => {
        const p = spawn(
          'docker',
          ['exec', '-u', '1000:1000', this.containerName, 'sh', '-c',
           `curl -sf http://${host}:${port}/json/version > /dev/null 2>&1`],
          { stdio: 'ignore' },
        );
        p.on('close', (code) => resolve(code === 0));
        p.on('error', () => resolve(false));
      });
      if (ok) return;
      await new Promise((r) => setTimeout(r, 200));
    }
    // Non-fatal: forwarder will retry, chromium.log will tell us why.
  }

  private async pingCdp(): Promise<boolean> {
    try {
      const res = await fetch(`http://127.0.0.1:${this.cdpPort}/json/version`);
      return res.ok;
    } catch { return false; }
  }

  private async killProcessesInContainer(): Promise<void> {
    return new Promise<void>((resolve) => {
      const p = spawn(
        'docker',
        ['exec', this.containerName, 'sh', '-c',
         'pkill -f "chromium --headless" 2>/dev/null; '
         + 'pkill -f "cdp-forwarder.js" 2>/dev/null; true'],
        { stdio: 'ignore' },
      );
      p.on('close', () => resolve());
      p.on('error', () => resolve());
    });
  }
}
