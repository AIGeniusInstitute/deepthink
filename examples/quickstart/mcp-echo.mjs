/**
 * mcp-echo —— 零依赖的最小 MCP stdio server（走查 / 演示用）。
 * 暴露一个 echo 工具：原样返回 text，并带上环境变量 DEMO_TOKEN 的值，
 * 用于验证 bundle 的 ${ENV:...} 密钥解析确实注入到了 MCP 子进程。
 *
 * 协议：MCP stdio transport = 换行分隔的 JSON-RPC 2.0。
 */
let buf = '';
process.stdin.on('data', (d) => {
  buf += d;
  let idx;
  while ((idx = buf.indexOf('\n')) >= 0) {
    const line = buf.slice(0, idx).trim();
    buf = buf.slice(idx + 1);
    if (line) {
      try {
        handle(JSON.parse(line));
      } catch {
        /* ignore malformed */
      }
    }
  }
});

function send(msg) {
  process.stdout.write(JSON.stringify(msg) + '\n');
}

function handle(msg) {
  const { id, method, params } = msg;
  if (method === 'initialize') {
    send({
      jsonrpc: '2.0',
      id,
      result: {
        protocolVersion: params?.protocolVersion ?? '2024-11-05',
        capabilities: { tools: {} },
        serverInfo: { name: 'echo', version: '1.0.0' },
      },
    });
  } else if (method === 'notifications/initialized' || method === 'notifications/cancelled') {
    // notification — no response
  } else if (method === 'tools/list') {
    send({
      jsonrpc: '2.0',
      id,
      result: {
        tools: [
          {
            name: 'echo',
            description: 'Echo the given text back, prefixed with "echo:" and the configured greeting token.',
            inputSchema: {
              type: 'object',
              properties: { text: { type: 'string', description: 'Text to echo' } },
              required: ['text'],
            },
          },
        ],
      },
    });
  } else if (method === 'tools/call') {
    const text = params?.arguments?.text ?? '';
    send({
      jsonrpc: '2.0',
      id,
      result: {
        content: [
          { type: 'text', text: `echo: ${text} (token=${process.env.DEMO_TOKEN ?? 'NONE'})` },
        ],
      },
    });
  } else if (id !== undefined) {
    send({ jsonrpc: '2.0', id, result: {} });
  }
}
