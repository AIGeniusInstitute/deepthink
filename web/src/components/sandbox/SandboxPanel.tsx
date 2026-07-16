import { useEffect, useState } from 'react';
import { sandboxApi } from '../../api/sandbox';
import { useSandboxStore } from '../../stores/sandbox';
import { useChatStore } from '../../stores/chat';
import { BrowserView } from './BrowserView';
import { SandboxTerminal } from './SandboxTerminal';
import { SandboxFileTree } from './SandboxFileTree';

interface SandboxPanelProps {
  groupJid: string;
}

type Subtab = 'browser' | 'terminal' | 'files';

export function SandboxPanel({ groupJid }: SandboxPanelProps) {
  const [subtab, setSubtab] = useState<Subtab>('browser');
  const [sessionId, setSessionId] = useState<string | null>(null);
  const [browserEnabled, setBrowserEnabled] = useState<boolean>(false);
  const [loading, setLoading] = useState(true);

  // Resolve group folder from chat store — groupJid is the chatJid (e.g. web:main)
  const folder = useChatStore((s) => s.groups[groupJid]?.folder);
  const wireWs = useSandboxStore((s) => s.wireWsHandlers);
  const focusSession = useSandboxStore((s) => s.focusSession);

  // Wire WS handlers + poll for sandbox session binding
  useEffect(() => {
    const off = wireWs();
    return () => {
      off?.();
    };
  }, [wireWs]);

  // Resolve the sandbox session bound to this chat group
  useEffect(() => {
    if (!folder) return;
    let cancelled = false;
    const resolve = async () => {
      try {
        const r = await sandboxApi.getByGroup(folder);
        if (cancelled) return;
        const newSid = r.sessionId;
        setSessionId(newSid);
        setBrowserEnabled(!!r.browserEnabled);
        if (newSid) {
          // Keep store active session in sync so other components can read it
          focusSession(newSid);
        }
      } catch {
        if (!cancelled) setSessionId(null);
      } finally {
        if (!cancelled) setLoading(false);
      }
    };
    resolve();
    // Poll every 5s — picks up new sessions created by agent tool calls
    const timer = setInterval(resolve, 5000);
    return () => {
      cancelled = true;
      clearInterval(timer);
    };
  }, [folder, focusSession]);

  // Listen for sandbox-tool-active custom events from chat store (auto-switch subtab)
  useEffect(() => {
    const handler = (e: Event) => {
      const detail = (e as CustomEvent).detail as {
        sessionId: string;
        subtab: Subtab;
      };
      if (detail.sessionId) {
        setSessionId(detail.sessionId);
        focusSession(detail.sessionId);
      }
      setSubtab(detail.subtab);
    };
    window.addEventListener('sandbox-tool-active', handler as EventListener);
    return () => window.removeEventListener('sandbox-tool-active', handler as EventListener);
  }, [focusSession]);

  if (loading) {
    return (
      <div className="h-full flex items-center justify-center text-xs text-neutral-500">
        加载沙箱状态...
      </div>
    );
  }

  if (!sessionId) {
    return (
      <div className="h-full flex items-center justify-center text-xs text-neutral-500 p-6 text-center">
        Agent 暂未使用沙箱。
        <br />
        在对话中让 Agent 调用 <code className="text-teal-400">sandbox_*</code> 工具后将自动激活。
      </div>
    );
  }

  return (
    <div className="h-full flex flex-col">
      {/* Header: session info + subtab switcher */}
      <div className="flex items-center justify-between px-2 py-1.5 border-b border-white/10 bg-white/5">
        <div className="text-xs text-neutral-400 truncate" title={sessionId}>
          沙箱: <span className="text-neutral-300 font-mono">{sessionId.slice(0, 16)}</span>
        </div>
        <div className="flex items-center gap-0.5">
          {(['browser', 'terminal', 'files'] as Subtab[]).map((t) => (
            <button
              key={t}
              onClick={() => setSubtab(t)}
              className={`px-2 py-1 text-xs rounded transition-colors ${
                subtab === t
                  ? 'bg-teal-500/20 text-teal-300'
                  : 'text-neutral-400 hover:bg-white/5'
              }`}
            >
              {t === 'browser' ? '浏览器' : t === 'terminal' ? '终端' : '文件树'}
            </button>
          ))}
        </div>
      </div>

      {/* Content */}
      <div className="flex-1 min-h-0">
        {subtab === 'browser' ? (
          browserEnabled ? (
            <BrowserView sessionId={sessionId} />
          ) : (
            <div className="h-full flex items-center justify-center text-xs text-neutral-500 p-6 text-center">
              当前沙箱未启用浏览器。
              <br />
              Agent 调用 <code className="text-teal-400">sandbox_browser_navigate</code> 时会自动切换到启用浏览器的沙箱。
            </div>
          )
        ) : subtab === 'terminal' ? (
          <SandboxTerminal sessionId={sessionId} />
        ) : (
          <SandboxFileTree sessionId={sessionId} />
        )}
      </div>
    </div>
  );
}
