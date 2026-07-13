import net from 'net';

export async function findFreePort(start: number, end: number): Promise<number> {
  for (let port = start; port <= end; port++) {
    if (await isFree(port)) return port;
  }
  throw new Error(`No free port in ${start}-${end}`);
}

// Probe :: (IPv6 any, dual-stack also covers IPv4). Backend uses @hono/node-server
// which listens on :: by default; checking :: alone is sufficient and avoids
// false-negatives from dual-stack IPv4 collision.
function isFree(port: number): Promise<boolean> {
  return new Promise((resolve) => {
    const server = net.createServer();
    let settled = false;
    const done = (ok: boolean) => {
      if (settled) return;
      settled = true;
      try { server.close(); } catch { /* ignore */ }
      resolve(ok);
    };
    server.once('error', () => done(false));
    server.listen(port, '::', () => done(true));
  });
}
