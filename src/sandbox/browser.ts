/**
 * BrowserController — talks to a sandboxed Chromium via the Chrome DevTools
 * Protocol (CDP) over WebSocket.
 *
 * No external `chrome-remote-interface` dependency — we hand-roll CDP calls
 * using the already-bundled `ws` package. P0 keeps the surface area small
 * (navigate / click / type / screenshot / evaluate / frame stream).
 */

import { WebSocket } from 'ws';
import { logger } from '../logger.js';
import { spawn } from 'child_process';

interface CdpResponse {
  id: number;
  result?: any;
  error?: { code: number; message: string; data?: any };
}

interface CdpEvent {
  method: string;
  params?: any;
  sessionId?: string;
}

export class BrowserController {
  private ws: WebSocket | null = null;
  private nextId = 1;
  private pending = new Map<number, { resolve: (r: any) => void; reject: (e: Error) => void }>();
  private frameTimer: NodeJS.Timeout | null = null;
  private onFrame: (dataUrl: string) => void = () => {};
  private readonly cdpPort: number;
  private readonly containerName: string;
  private chromiumStarted = false;

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
    // Ensure chromium is running inside the container (idempotent).
    await this.ensureChromiumRunning();

    // Find page target
    const target = await this.findPageTarget();
    if (!target) throw new Error('未找到 Chromium page target');

    const wsUrl = target.webSocketDebuggerUrl.replace('localhost', '127.0.0.1');
    this.ws = new WebSocket(wsUrl);
    await new Promise<void>((resolve, reject) => {
      this.ws!.once('open', resolve);
      this.ws!.once('error', (err) => reject(new Error(`CDP 连接失败: ${err.message}`)));
    });

    this.ws.on('message', (raw) => this.handleMessage(raw.toString()));
    this.ws.on('error', (err) => logger.warn({ err: err.message }, 'CDP ws error'));

    await this.call('Page.enable');
    await this.call('Runtime.enable');

    if (initialUrl) {
      await this.navigate(initialUrl);
    }
    this.startFrameLoop(frameIntervalMs);
  }

  async navigate(url: string): Promise<void> {
    if (!this.ws) throw new Error('浏览器未启动');
    await this.call('Page.navigate', { url });
    // Wait for load event (best-effort, 10s timeout)
    await this.waitForLoadEvent(10_000);
  }

  async click(selector: string): Promise<void> {
    await this.evaluate(
      `(() => { const el = document.querySelector(${JSON.stringify(selector)}); if (el) el.click(); return !!el; })()`,
    );
  }

  async type(selector: string, text: string): Promise<void> {
    await this.evaluate(
      `(() => {
        const el = document.querySelector(${JSON.stringify(selector)});
        if (!el) return false;
        el.focus();
        el.value = ${JSON.stringify(text)};
        el.dispatchEvent(new Event('input', { bubbles: true }));
        el.dispatchEvent(new Event('change', { bubbles: true }));
        return true;
      })()`,
    );
  }

  async screenshot(): Promise<string> {
    const { data } = await this.call('Page.captureScreenshot', { format: 'png' });
    return `data:image/png;base64,${data}`;
  }

  async evaluate(expression: string): Promise<any> {
    const r = await this.call('Runtime.evaluate', {
      expression,
      returnByValue: true,
      awaitPromise: true,
    });
    return r?.result?.value;
  }

  async getTitle(): Promise<string | null> {
    return this.evaluate('document.title');
  }

  async getCurrentUrl(): Promise<string | null> {
    return this.evaluate('location.href');
  }

  async stop(): Promise<void> {
    if (this.frameTimer) {
      clearInterval(this.frameTimer);
      this.frameTimer = null;
    }
    if (this.ws) {
      try { await this.ws.close(); } catch { /* ignore */ }
      this.ws = null;
    }
    // Stop chromium inside container
    if (this.chromiumStarted) {
      try {
        await new Promise<void>((resolve) => {
          const p = spawn(
            'docker',
            ['exec', this.containerName, 'sh', '-c', 'pkill -f "chromium --headless" 2>/dev/null; true'],
            { stdio: 'ignore' },
          );
          p.on('close', () => resolve());
          p.on('error', () => resolve());
        });
      } catch { /* ignore */ }
      this.chromiumStarted = false;
    }
  }

  private startFrameLoop(intervalMs: number): void {
    this.frameTimer = setInterval(async () => {
      try {
        const { data } = await this.call('Page.captureScreenshot', {
          format: 'jpeg',
          quality: 60,
        });
        this.onFrame(`data:image/jpeg;base64,${data}`);
      } catch (e) {
        // swallow — frame loop must not die
      }
    }, intervalMs);
  }

  private async call(method: string, params: any = {}): Promise<any> {
    if (!this.ws || this.ws.readyState !== WebSocket.OPEN) {
      throw new Error('CDP socket not open');
    }
    const id = this.nextId++;
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => {
        this.pending.delete(id);
        reject(new Error(`CDP call timeout: ${method}`));
      }, 15_000);
      this.pending.set(id, {
        resolve: (r) => { clearTimeout(timer); resolve(r); },
        reject: (e) => { clearTimeout(timer); reject(e); },
      });
      const payload = JSON.stringify({ id, method, params });
      this.ws!.send(payload, (err) => {
        if (err) {
          this.pending.delete(id);
          reject(new Error(`CDP send error: ${err.message}`));
        }
      });
    });
  }

  private handleMessage(raw: string): void {
    let msg: CdpResponse | CdpEvent;
    try { msg = JSON.parse(raw); } catch { return; }
    if ('id' in msg && msg.id) {
      const p = this.pending.get(msg.id);
      if (!p) return;
      this.pending.delete(msg.id);
      if (msg.error) p.reject(new Error(`CDP error: ${msg.error.message}`));
      else p.resolve(msg.result);
    } else if ('method' in msg) {
      // event — currently only loadEventFired is handled via waitForLoadEvent
      if (msg.method === 'Page.loadEventFired') {
        this.loadListeners.forEach((fn) => fn());
      }
    }
  }

  private loadListeners = new Set<() => void>();

  private waitForLoadEvent(timeoutMs: number): Promise<void> {
    return new Promise((resolve) => {
      const timer = setTimeout(() => {
        this.loadListeners.delete(fn);
        resolve(); // resolve anyway — load event may have already fired
      }, timeoutMs);
      const fn = () => {
        clearTimeout(timer);
        this.loadListeners.delete(fn);
        resolve();
      };
      this.loadListeners.add(fn);
    });
  }

  private async ensureChromiumRunning(): Promise<void> {
    if (this.chromiumStarted) return;
    // Start chromium in background inside the container.
    // --no-sandbox is acceptable here: the container already drops ALL caps,
    // runs as uid 1000 with seccomp + pids/memory limits. The kernel sandbox
    // isn't needed because the container IS the sandbox.
    const args = [
      'exec', '-d', this.containerName,
      'chromium',
      '--headless=new',
      '--no-sandbox',
      '--disable-gpu',
      '--remote-debugging-port=9222',
      '--remote-debugging-address=127.0.0.1',
      '--disable-dev-shm-usage',
      '--user-data-dir=/tmp/chromium',
      'about:blank',
    ];
    await new Promise<void>((resolve) => {
      const p = spawn('docker', args, { stdio: 'ignore' });
      p.on('close', () => resolve());
      p.on('error', () => resolve());
    });
    this.chromiumStarted = true;
    // Wait for CDP endpoint to be reachable
    const start = Date.now();
    while (Date.now() - start < 10_000) {
      const ok = await this.pingCdp();
      if (ok) return;
      await new Promise((r) => setTimeout(r, 200));
    }
    throw new Error('Chromium CDP 启动超时');
  }

  private async pingCdp(): Promise<boolean> {
    try {
      const res = await fetch(`http://127.0.0.1:${this.cdpPort}/json/version`);
      return res.ok;
    } catch { return false; }
  }

  private async findPageTarget(): Promise<any | null> {
    const res = await fetch(`http://127.0.0.1:${this.cdpPort}/json`);
    if (!res.ok) return null;
    const targets = await res.json() as any[];
    return targets.find((t) => t.type === 'page') ?? null;
  }
}
