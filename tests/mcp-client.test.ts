import { describe, it, expect } from 'vitest';
import { StreamableHTTPClientTransport } from '@modelcontextprotocol/sdk/client/streamableHttp.js';
import { SSEClientTransport } from '@modelcontextprotocol/sdk/client/sse.js';
import { StdioClientTransport } from '@modelcontextprotocol/sdk/client/stdio.js';
import {
  buildTransport,
  toErrorMessage,
  wrapWinBatchCommand,
  wrapWinBatchServers,
} from '../src/mcp-client.js';

describe('buildTransport', () => {
  it('http 类型映射为 StreamableHTTPClientTransport', () => {
    const t = buildTransport({ type: 'http', url: 'http://127.0.0.1:9999/mcp' });
    expect(t).toBeInstanceOf(StreamableHTTPClientTransport);
  });

  it('sse 类型映射为 SSEClientTransport', () => {
    const t = buildTransport({ type: 'sse', url: 'http://127.0.0.1:9999/sse' });
    expect(t).toBeInstanceOf(SSEClientTransport);
  });

  it('缺省（stdio）映射为 StdioClientTransport', () => {
    const t = buildTransport({ command: 'node', args: ['server.js'] });
    expect(t).toBeInstanceOf(StdioClientTransport);
  });

  it('http/sse 缺少 url 抛错', () => {
    expect(() => buildTransport({ type: 'http' })).toThrow(/missing url/i);
    expect(() => buildTransport({ type: 'sse' })).toThrow(/missing url/i);
  });

  it('stdio 缺少 command 抛错', () => {
    expect(() => buildTransport({})).toThrow(/missing command/i);
  });
});

describe('toErrorMessage', () => {
  it('ENOENT 归一化为友好提示', () => {
    const err = Object.assign(new Error('spawn npx ENOENT'), { code: 'ENOENT' });
    expect(toErrorMessage(err)).toMatch(/命令不存在或无法执行/);
    expect(toErrorMessage(err)).toContain('spawn npx ENOENT');
  });

  it('EINVAL 归一化为 cmd /c 提示', () => {
    const err = Object.assign(new Error('spawn EINVAL'), { code: 'EINVAL' });
    expect(toErrorMessage(err)).toMatch(/cmd \/c/);
    expect(toErrorMessage(err)).toContain('spawn EINVAL');
  });

  it('普通 Error 返回其 message', () => {
    expect(toErrorMessage(new Error('boom'))).toBe('boom');
  });

  it('非 Error 值转字符串', () => {
    expect(toErrorMessage('x')).toBe('x');
    expect(toErrorMessage(42)).toBe('42');
  });
});

describe('wrapWinBatchCommand', () => {
  const cmdExe = process.env.ComSpec || 'cmd.exe';

  it('win32 下把 .cmd 改写为 cmd.exe /c 前缀并保留 args/env', () => {
    const out = wrapWinBatchCommand(
      { command: 'C:\\app\\run.cmd', args: ['--x'], env: { A: '1' } },
      'win32',
    );
    expect(out.command).toBe(cmdExe);
    expect(out.args).toEqual(['/c', 'C:\\app\\run.cmd', '--x']);
    expect(out.env).toEqual({ A: '1' });
  });

  it('win32 下 .bat 同样改写；大小写不敏感；剥掉外层引号', () => {
    const out = wrapWinBatchCommand({ command: '"C:\\app\\RUN.BAT"' }, 'win32');
    expect(out.command).toBe(cmdExe);
    expect(out.args).toEqual(['/c', 'C:\\app\\RUN.BAT']);
  });

  it('win32 下非批处理命令原样返回', () => {
    const cfg = { command: 'node', args: ['server.js'] };
    expect(wrapWinBatchCommand(cfg, 'win32')).toBe(cfg);
  });

  it('非 win32 平台一律原样返回', () => {
    const cfg = { command: 'C:\\app\\run.cmd' };
    expect(wrapWinBatchCommand(cfg, 'linux')).toBe(cfg);
    expect(wrapWinBatchCommand(cfg, 'darwin')).toBe(cfg);
  });

  it('缺 command 的 http/sse 条目原样返回', () => {
    const cfg = { type: 'http', url: 'http://127.0.0.1:9999/mcp' };
    expect(wrapWinBatchCommand(cfg, 'win32')).toBe(cfg);
  });
});

describe('wrapWinBatchServers', () => {
  it('win32 下逐个改写批处理条目，其余保持不变', () => {
    const out = wrapWinBatchServers(
      {
        a: { command: 'C:\\app\\run.cmd' },
        b: { command: 'node' },
        c: { type: 'http', url: 'http://127.0.0.1:9999/mcp' },
      },
      'win32',
    );
    expect(out.a.command).toBe(process.env.ComSpec || 'cmd.exe');
    expect(out.a.args).toEqual(['/c', 'C:\\app\\run.cmd']);
    expect(out.b).toEqual({ command: 'node' });
    expect(out.c).toEqual({ type: 'http', url: 'http://127.0.0.1:9999/mcp' });
  });

  it('非 win32 平台返回原映射', () => {
    const servers = { a: { command: 'C:\\app\\run.cmd' } };
    expect(wrapWinBatchServers(servers, 'linux')).toBe(servers);
  });
});
