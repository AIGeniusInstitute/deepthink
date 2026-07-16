/**
 * CDP port forwarder — bridges the Chromium 127.0.0.1 bind to 0.0.0.0.
 *
 * Chromium 150 (and recent versions) ignore `--remote-debugging-address`
 * for security reasons and always bind the DevTools endpoint to
 * 127.0.0.1:9222. That binding is unreachable from the host via Docker
 * port mapping, which forwards to the container's eth0 IP — not its
 * loopback. This forwarder accepts on 0.0.0.0:9223 and pipes to
 * 127.0.0.1:9222 so Docker's `-p 127.0.0.1::9223` can expose CDP to the
 * host process.
 */
const net = require('net');

const SRC_PORT = 9223;
const DST_PORT = 9222;
const DST_HOST = '127.0.0.1';

const server = net.createServer((client) => {
  const upstream = net.connect(DST_PORT, DST_HOST);
  client.pipe(upstream);
  upstream.pipe(client);
  client.on('error', () => upstream.destroy());
  upstream.on('error', () => client.destroy());
  client.on('close', () => upstream.destroy());
});

server.on('error', (err) => {
  console.error('cdp-forwarder error:', err.message);
  process.exit(1);
});

server.listen(SRC_PORT, '0.0.0.0', () => {
  console.log(`cdp-forwarder listening on 0.0.0.0:${SRC_PORT} -> ${DST_HOST}:${DST_PORT}`);
});
