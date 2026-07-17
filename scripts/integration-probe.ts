/**
 * Integration probe: exercises SandboxManager end-to-end against the real
 * docker daemon on this host. Run from the worktree root:
 *   npx tsx scripts/integration-probe.ts
 *
 * Verifies the docker API-version auto-negotiation fix and the full
 * create → exec → files → browser → destroy lifecycle.
 */
import { initDatabase } from '../src/db.js';
import { getSandboxManager } from '../src/sandbox/index.js';

initDatabase();
const mgr = getSandboxManager();
const USER = 'probe-user-' + Date.now();

async function sh(cmd: string) {
  const args = ['exec', '-i', 'DUMMY'];
}

async function main() {
  // 1. create (non-browser, python)
  const s = await mgr.create(USER, { language: 'python' });
  console.log('[1] create ok:', { id: s.id, containerName: s.containerName, status: s.status });

  // 2. executeCode
  const r = await mgr.executeCode(s.id, USER, {
    language: 'python',
    code: 'print("hello from sandbox"); import sys; print(sys.version_info[:2])',
  });
  console.log('[2] exec:', { status: r.status, exitCode: r.exitCode });
  console.log('    stdout:', JSON.stringify(r.stdout.trim()));
  if (r.status !== 'completed') throw new Error('exec failed: ' + r.stderr);

  // 3. listFiles
  const entries = await mgr.listFiles(s.id, '/workspace');
  console.log('[3] listFiles /workspace:', entries.length, 'entries');

  // 4. readFile (write a file first via exec)
  await mgr.executeCode(s.id, USER, {
    language: 'sh',
    code: 'echo "hi-from-file" > /workspace/note.txt',
  });
  const fr = await mgr.readFile(s.id, '/workspace/note.txt');
  console.log('[4] readFile:', JSON.stringify(fr.content.trim()));

  // 5. browser-enabled session create + start
  const sb = await mgr.create(USER, { language: 'python', browserEnabled: true });
  console.log('[5] browser create ok:', { id: sb.id, cdpPort: sb.cdpPort });
  if (!sb.cdpPort) throw new Error('browser session missing cdpPort');
  await mgr.startBrowser(sb.id, () => {});
  const browser = await mgr.getBrowser(sb.id);
  if (!browser) throw new Error('browser controller null');
  await browser.navigate('about:blank');
  const title = await browser.getTitle().catch(() => null);
  console.log('[5] browser started, title:', title);
  await mgr.stopBrowser(sb.id);

  // 6. cleanup
  await mgr.destroy(s.id, 'test_done');
  await mgr.destroy(sb.id, 'test_done');
  console.log('[6] destroy ok');
  console.log('ALL GOOD');
}

main().catch((e) => {
  console.error('PROBE FAILED:', e);
  process.exit(1);
});
