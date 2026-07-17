/**
 * BrowserController — controls a sandboxed Chromium via Playwright's
 * `connectOverCDP`. The browser process lives inside the sandbox container
 * (subject to cap-drop + memory/cpu/pids limits); the host process
 * connects to the CDP forwarder port (127.0.0.1:{dynamic}) and drives it
 * with the Playwright API.
 *
 * Chromium 150 ignores `--remote-debugging-address` and always binds its
 * DevTools endpoint to 127.0.0.1:9222 — unreachable from the host via
 * Docker port mapping. cdp-forwarder.js (shipped in the image) bridges
 * 0.0.0.0:9223 → 127.0.0.1:9222 so the host can connect.
 *
 * Crash recovery: page.on('crash') triggers an async restart() that
 * re-runs ensureProcessesRunning + connectOverCDP + new page. The frame
 * loop keeps the old onFrame callback, so subscribers keep receiving
 * frames after recovery.
 */

import { chromium, type Browser, type Page } from 'playwright-core';
import { logger } from '../logger.js';
import { spawn } from 'child_process';
import { CHROMIUM_DEVTOOLS_PORT } from './config.js';
import { dockerEnvSync } from './docker-env.js';

const CHROMIUM_FLAGS = [
  '--headless=new',
  '--no-sandbox',
  '--disable-gpu',
  '--use-gl=angle',
  '--use-angle=swiftshader',
  `--remote-debugging-port=${CHROMIUM_DEVTOOLS_PORT}`,
  '--disable-dev-shm-usage',
  '--user-data-dir=/tmp/chromium',
  // Reduce crash surface on heavy sites (amap / baidu / etc.)
  '--no-first-run',
  '--no-zygote',
  '--disable-extensions',
  '--disable-default-apps',
  '--disable-component-extensions-with-background-pages',
  // Site isolation in headless mode sometimes causes net::ERR_ABORTED on
  // cross-origin redirects (e.g. baidu.com → www.baidu.com).
  '--disable-features=IsolateOrigins,site-per-process,Translate',
  '--disable-site-isolation-trials',
  // Prevent GPU-process crashes from cascading into renderer kills.
  '--disable-software-rasterizer',
  '--disable-gpu-compositing',
  'about:blank',
].join(' ');

export class BrowserController {
  private browser: Browser | null = null;
  private page: Page | null = null;
  private frameTimer: NodeJS.Timeout | null = null;
  private onFrame: (dataUrl: string) => void = () => {};
  private readonly cdpPort: number;
  private readonly containerName: string;
  private processesStarted = false;
  private restarting = false;
  private frameIntervalMs = 250;
  private lastUrl: string | null = null;

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
    this.frameIntervalMs = frameIntervalMs;
    this.lastUrl = initialUrl ?? null;
    await this.ensureProcessesRunning();

    const endpoint = `http://127.0.0.1:${this.cdpPort}`;
    this.browser = await chromium.connectOverCDP(endpoint, { timeout: 15_000 });

    const ctx = this.browser.contexts()[0] ?? await this.browser.newContext();
    this.page = ctx.pages()[0] ?? await ctx.newPage();
    this.attachPageListeners(this.page);

    if (initialUrl) {
      await this.navigate(initialUrl);
    }
    this.startFrameLoop(frameIntervalMs);
  }

  /**
   * Update the frame callback without restarting. Used when a WebSocket
   * subscriber attaches after a REST /browser/start already launched the
   * browser with a no-op onFrame.
   */
  setOnFrame(onFrame: (dataUrl: string) => void): void {
    this.onFrame = onFrame;
  }

  async navigate(url: string): Promise<void> {
    if (!this.page) throw new Error('浏览器未启动');
    this.lastUrl = url;
    // 'domcontentloaded' returns as soon as the DOM is ready, avoiding
    // ERR_ABORTED on heavy sites (amap, baidu) whose window.onload fires
    // late or never under memory pressure.
    await this.page.goto(url, { waitUntil: 'domcontentloaded', timeout: 30_000 });
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

  /**
   * Restart chromium + forwarder + browser context. Used by:
   *   - page.on('crash') auto-recovery
   *   - POST /sessions/:id/browser/restart manual trigger
   * Preserves onFrame + frameIntervalMs so subscribers keep receiving.
   */
  async restart(): Promise<void> {
    if (this.restarting) return;
    this.restarting = true;
    logger.warn({ containerName: this.containerName }, 'browser restarting after crash');
    try {
      await this.stop();
      await this.start(this.onFrame, this.frameIntervalMs, this.lastUrl ?? undefined);
    } finally {
      this.restarting = false;
    }
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

  private attachPageListeners(page: Page): void {
    page.on('crash', () => {
      logger.error({ containerName: this.containerName }, 'page crashed — auto-restarting');
      this.restart().catch((e) => {
        logger.error({ containerName: this.containerName, err: e.message }, 'auto-restart failed');
      });
    });
    page.on('pageerror', (err) => {
      logger.warn({ containerName: this.containerName, err: err.message }, 'pageerror');
    });
  }

  private startFrameLoop(intervalMs: number): void {
    this.frameTimer = setInterval(async () => {
      try {
        if (!this.page) return;
        const buf = await this.page.screenshot({ type: 'jpeg', quality: 60 });
        this.onFrame(`data:image/jpeg;base64,${buf.toString('base64')}`);
      } catch {
        // swallow — frame loop must not die. Restart flow handles recovery.
      }
    }, intervalMs);
  }

  private async ensureProcessesRunning(): Promise<void> {
    if (this.processesStarted) return;
    await this.spawnInContainer(
      `chromium ${CHROMIUM_FLAGS} > /tmp/chromium.log 2>&1`,
    );
    // Wait for chromium to bind 9222 before starting the forwarder.
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
      const p = spawn('docker', args, { stdio: 'ignore', env: dockerEnvSync() });
      p.on('close', () => resolve());
      p.on('error', () => resolve());
    });
  }

  private async waitForTcpReady(host: string, port: number, timeoutMs: number): Promise<void> {
    const start = Date.now();
    while (Date.now() - start < timeoutMs) {
      const ok = await new Promise<boolean>((resolve) => {
        const p = spawn(
          'docker',
          ['exec', '-u', '1000:1000', this.containerName, 'sh', '-c',
           `curl -sf http://${host}:${port}/json/version > /dev/null 2>&1`],
          { stdio: 'ignore', env: dockerEnvSync() },
        );
        p.on('close', (code) => resolve(code === 0));
        p.on('error', () => resolve(false));
      });
      if (ok) return;
      await new Promise((r) => setTimeout(r, 200));
    }
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
        { stdio: 'ignore', env: dockerEnvSync() },
      );
      p.on('close', () => resolve());
      p.on('error', () => resolve());
    });
  }
}
