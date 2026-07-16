import { useEffect, useRef, useState } from 'react';
import { Terminal } from '@xterm/xterm';
import { FitAddon } from '@xterm/addon-fit';
import '@xterm/xterm/css/xterm.css';
import { wsManager } from '../../api/ws';
import { useSandboxStore } from '../../stores/sandbox';

type ConnectionState = 'idle' | 'connecting' | 'connected' | 'disconnected';

interface SandboxTerminalProps {
  sessionId: string;
}

export function SandboxTerminal({ sessionId }: SandboxTerminalProps) {
  const termRef = useRef<HTMLDivElement>(null);
  const xtermRef = useRef<Terminal | null>(null);
  const fitAddonRef = useRef<FitAddon | null>(null);
  const [connState, setConnState] = useState<ConnectionState>('idle');
  const connStateRef = useRef<ConnectionState>('idle');
  const syncConnState = (s: ConnectionState) => {
    connStateRef.current = s;
    setConnState(s);
  };
  const sendTerminalInput = useSandboxStore((s) => s.sendTerminalInput);
  const startTerminal = useSandboxStore((s) => s.startTerminal);
  const stopTerminal = useSandboxStore((s) => s.stopTerminal);
  const resizeTerminal = useSandboxStore((s) => s.resizeTerminal);

  useEffect(() => {
    if (!termRef.current) return;

    const terminal = new Terminal({
      cursorBlink: true,
      fontSize: 13,
      lineHeight: 1.15,
      fontFamily: "'JetBrains Mono', 'Fira Code', Menlo, monospace",
      scrollback: 5000,
      convertEol: true,
      theme: {
        background: '#1a1b26',
        foreground: '#a9b1d6',
        cursor: '#c0caf5',
        selectionBackground: '#33467c',
        black: '#32344a',
        red: '#f7768e',
        green: '#9ece6a',
        yellow: '#e0af68',
        blue: '#7aa2f7',
        magenta: '#ad8ee6',
        cyan: '#449dab',
        white: '#787c99',
        brightBlack: '#444b6a',
        brightRed: '#ff7a93',
        brightGreen: '#b9f27c',
        brightYellow: '#ff9e64',
        brightBlue: '#7da6ff',
        brightMagenta: '#bb9af7',
        brightCyan: '#0db9d7',
        brightWhite: '#acb0d0',
      },
    });
    const fitAddon = new FitAddon();
    terminal.loadAddon(fitAddon);
    terminal.open(termRef.current);
    xtermRef.current = terminal;
    fitAddonRef.current = fitAddon;
    setTimeout(() => fitAddon.fit(), 100);

    const sendStart = () => {
      startTerminal(sessionId, terminal.cols, terminal.rows);
    };
    const requestStart = () => {
      syncConnState('connecting');
      if (wsManager.isConnected()) sendStart();
      else wsManager.connect();
    };

    const unsubOutput = wsManager.on('sandbox_terminal_output', (data: any) => {
      if (data?.sessionId === sessionId) terminal.write(data.data);
    });
    const unsubStarted = wsManager.on('sandbox_terminal_started', (data: any) => {
      if (data?.sessionId === sessionId) syncConnState('connected');
    });
    const unsubExit = wsManager.on('sandbox_terminal_exit', (data: any) => {
      if (data?.sessionId === sessionId) {
        syncConnState('disconnected');
        terminal.write(`\r\n\x1b[33m[进程退出 code=${data.exitCode}]\x1b[0m\r\n`);
      }
    });
    const unsubStopped = wsManager.on('sandbox_terminal_stopped', (data: any) => {
      if (data?.sessionId === sessionId) {
        syncConnState('disconnected');
      }
    });
    const unsubErr = wsManager.on('sandbox_error', (data: any) => {
      if (data?.sessionId === sessionId) {
        syncConnState('disconnected');
        terminal.write(`\r\n\x1b[31m[错误: ${data.error}]\x1b[0m\r\n`);
      }
    });
    const unsubWsConn = wsManager.on('connected', () => {
      if (connStateRef.current !== 'connected') {
        syncConnState('connecting');
        sendStart();
      }
    });
    const unsubWsDisc = wsManager.on('disconnected', () => {
      syncConnState('disconnected');
      terminal.write('\r\n\x1b[33m[WebSocket 已断开，等待重连]\x1b[0m\r\n');
    });

    // IME 组合事件处理
    let composing = false;
    const textarea = termRef.current?.querySelector('textarea');
    const onCs = () => { composing = true; };
    const onCe = () => { setTimeout(() => { composing = false; }, 50); };
    if (textarea) {
      textarea.addEventListener('compositionstart', onCs);
      textarea.addEventListener('compositionend', onCe);
    }

    const onDataDisposable = terminal.onData((data) => {
      if (composing) return;
      if (connStateRef.current === 'connected') sendTerminalInput(sessionId, data);
    });

    // ResizeObserver
    let resizeTimer: ReturnType<typeof setTimeout> | null = null;
    const ro = new ResizeObserver(() => {
      if (resizeTimer) clearTimeout(resizeTimer);
      resizeTimer = setTimeout(() => {
        fitAddonRef.current?.fit();
        if (connStateRef.current === 'connected') {
          resizeTerminal(sessionId, terminal.cols, terminal.rows);
        }
      }, 150);
    });
    ro.observe(termRef.current);

    requestStart();

    return () => {
      if (resizeTimer) clearTimeout(resizeTimer);
      ro.disconnect();
      if (textarea) {
        textarea.removeEventListener('compositionstart', onCs);
        textarea.removeEventListener('compositionend', onCe);
      }
      onDataDisposable.dispose();
      unsubOutput();
      unsubStarted();
      unsubExit();
      unsubStopped();
      unsubErr();
      unsubWsConn();
      unsubWsDisc();
      if (wsManager.isConnected()) stopTerminal(sessionId);
      terminal.dispose();
      xtermRef.current = null;
      fitAddonRef.current = null;
    };
  }, [sessionId]);

  return (
    <div className="h-full flex flex-col">
      <div className="flex items-center justify-between px-3 py-1.5 bg-[#1a1b26] border-b border-[#2a2b36] text-xs">
        <div className="flex items-center gap-2">
          <span className={`inline-block w-2 h-2 rounded-full ${
            connState === 'connected' ? 'bg-green-400' :
            connState === 'connecting' ? 'bg-yellow-400 animate-pulse' :
            'bg-neutral-500'
          }`} />
          <span className="text-neutral-400">
            {connState === 'connected' ? '已连接' :
             connState === 'connecting' ? '连接中...' :
             connState === 'disconnected' ? '已断开' : '空闲'}
          </span>
        </div>
        <div className="text-neutral-500">沙箱终端 · {sessionId.slice(0, 14)}</div>
      </div>
      <div ref={termRef} className="flex-1 min-h-0 overflow-hidden bg-[#1a1b26]" />
    </div>
  );
}
