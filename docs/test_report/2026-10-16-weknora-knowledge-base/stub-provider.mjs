// 本地 OpenAI 兼容 stub：提供 /v1/embeddings 与 /v1/chat/completions(含 SSE)。
// 仅作为 UI 验收的测试替身——隔离实例不该依赖外部 API Key，但向量检索与
// 流式问答这两条链路又必须被真实走一遍，否则「向量模式 0 命中」和
// 「问答无引用」都无法与真实缺陷区分开。
import http from 'node:http';

const DIM = 256;
const PORT = 9898;

const norm = (v) => {
  const n = Math.sqrt(v.reduce((s, x) => s + x * x, 0)) || 1;
  return v.map((x) => x / n);
};

/** 词袋哈希 + 字符二元组（对中文按字切分才会有词重叠）。 */
function embed(text) {
  const v = new Array(DIM).fill(0);
  const chars = [...text.toLowerCase()];
  const grams = chars.length <= 2 ? chars : [];
  for (let i = 0; i < chars.length; i++) {
    grams.push(chars[i]);
    if (i + 1 < chars.length) grams.push(chars[i] + chars[i + 1]);
    if (i + 2 < chars.length) grams.push(chars[i] + chars[i + 1] + chars[i + 2]);
  }
  for (const g of grams) {
    let h = 2166136261;
    for (let i = 0; i < g.length; i++) {
      h ^= g.charCodeAt(i);
      h = Math.imul(h, 16777619);
    }
    v[(h >>> 0) % DIM] += 1;
  }
  return norm(v);
}

const answerFor = (messages) => {
  const user = [...messages].reverse().find((m) => m.role === 'user');
  const body = user?.content ?? '';
  const ctx = body.split('---')[0] ?? '';
  const first = ctx.split('\n').filter((l) => l.trim()).slice(0, 3).join(' ');
  return `依据知识库中的资料，回答如下：\n\n1. ${first.slice(0, 80)} [1]\n2. 该结论来自上传文档的分块，可在「分块」页按偏移回源核对 [2]。`;
};

const readBody = (req) =>
  new Promise((resolve) => {
    let raw = '';
    req.on('data', (c) => (raw += c));
    req.on('end', () => resolve(raw ? JSON.parse(raw) : {}));
  });

const server = http.createServer(async (req, res) => {
  const url = new URL(req.url, 'http://localhost');
  if (req.method === 'GET' && url.pathname.endsWith('/models')) {
    res.writeHead(200, { 'Content-Type': 'application/json' });
    return res.end(JSON.stringify({ data: [{ id: 'stub-embed', object: 'model' }] }));
  }
  const body = await readBody(req).catch(() => ({}));

  if (url.pathname.endsWith('/embeddings')) {
    const inputs = Array.isArray(body.input) ? body.input : [body.input ?? ''];
    res.writeHead(200, { 'Content-Type': 'application/json' });
    return res.end(
      JSON.stringify({
        object: 'list',
        model: body.model ?? 'stub-embed',
        data: inputs.map((t, index) => ({ object: 'embedding', index, embedding: embed(String(t)) })),
        usage: { prompt_tokens: 1, total_tokens: 1 },
      }),
    );
  }

  if (url.pathname.endsWith('/chat/completions')) {
    const answer = answerFor(body.messages ?? []);
    if (body.stream) {
      res.writeHead(200, {
        'Content-Type': 'text/event-stream',
        'Cache-Control': 'no-cache',
        Connection: 'keep-alive',
      });
      const pieces = answer.match(/[\s\S]{1,12}/g) ?? [];
      for (const p of pieces) {
        res.write(
          `data: ${JSON.stringify({ choices: [{ delta: { content: p }, index: 0 }] })}\n\n`,
        );
        await new Promise((r) => setTimeout(r, 25));
      }
      res.write('data: [DONE]\n\n');
      return res.end();
    }
    res.writeHead(200, { 'Content-Type': 'application/json' });
    return res.end(
      JSON.stringify({
        choices: [{ message: { role: 'assistant', content: answer }, finish_reason: 'stop' }],
        usage: { prompt_tokens: 10, completion_tokens: 20, total_tokens: 30 },
      }),
    );
  }

  res.writeHead(404, { 'Content-Type': 'application/json' });
  res.end(JSON.stringify({ error: { message: `no route ${url.pathname}` } }));
});

server.listen(PORT, '127.0.0.1', () => console.log(`stub provider on :${PORT}`));
