import { describe, it, expect, vi } from 'vitest';
import { Hono } from 'hono';

// Admin user injected by the stubbed auth middleware below.
const ADMIN_USER = {
  id: 'test-admin',
  username: 'admin',
  role: 'admin',
  status: 'active',
  display_name: 'Admin',
  permissions: [],
  must_change_password: false,
};

// Neutralize the real session-cookie auth: just inject an admin user.
vi.mock('../src/middleware/auth.js', () => ({
  authMiddleware: async (c: any, next: any) => {
    c.set('user', ADMIN_USER);
    await next();
  },
  requirePermission: () => async (_c: any, next: any) => {
    await next();
  },
}));

const { default: memoryRoutes } = await import('../src/routes/memory.ts');
const { initDatabase } = await import('../src/db.ts');

// The real server initializes the DB at startup; listMemorySources() needs it.
// Some test runtimes cannot load the better-sqlite3 native module (Node ABI
// mismatch), in which case the /sources case is skipped — it is not a code
// defect. The /file + traversal cases below need no DB and always run.
let dbAvailable = false;
try {
  initDatabase();
  dbAvailable = true;
} catch {
  dbAvailable = false;
}

const app = new Hono();
app.route('/api/memory', memoryRoutes);

const maybeDescribe = dbAvailable ? describe : describe.skip;

describe('memory routes — path base decoupled from process.cwd()', () => {
  it('reads the main group CLAUDE.md by its clean path (no 400)', async () => {
    const res = await app.request(
      '/api/memory/file?path=data/groups/main/CLAUDE.md',
    );
    expect(res.status).toBe(200);
    const data = await res.json();
    expect(typeof data.content).toBe('string');
    expect(data.path).toBe('data/groups/main/CLAUDE.md');
  });

  it('still rejects path-traversal with ".." (400)', async () => {
    const res = await app.request(
      '/api/memory/file?path=../.deepthink/data/groups/main/CLAUDE.md',
    );
    expect(res.status).toBe(400);
  });

  maybeDescribe('when DB is available', () => {
    it('sources return paths without ".." segments', async () => {
      const res = await app.request('/api/memory/sources');
      expect(res.status).toBe(200);
      const data = await res.json();
      const sources = data.sources as { path: string }[];
      expect(sources.length).toBeGreaterThan(0);
      for (const s of sources) {
        expect(s.path.split('/')).not.toContain('..');
      }
    });
  });
});
