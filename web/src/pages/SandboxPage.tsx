import { useEffect, useMemo, useState } from 'react';
import { useSandboxStore } from '../stores/sandbox';
import { SandboxList } from '../components/sandbox/SandboxList';
import { SandboxTerminal } from '../components/sandbox/SandboxTerminal';
import { BrowserView } from '../components/sandbox/BrowserView';
import { BrowserUsePanel } from '../components/sandbox/BrowserUsePanel';
import { SandboxToolbar } from '../components/sandbox/SandboxToolbar';
import { wsManager } from '../api/ws';

export function SandboxPage() {
  const sessions = useSandboxStore((s) => s.sessions);
  const activeId = useSandboxStore((s) => s.activeSessionId);
  const loadSessions = useSandboxStore((s) => s.loadSessions);
  const wireWs = useSandboxStore((s) => s.wireWsHandlers);
  const [now, setNow] = useState(Date.now());

  // Initial load + WS handler wiring
  useEffect(() => {
    wsManager.connect();
    const off = wireWs();
    loadSessions();
    const t = setInterval(() => setNow(Date.now()), 30_000); // re-render for status freshness
    return () => {
      off?.();
      clearInterval(t);
    };
  }, [loadSessions, wireWs]);

  const activeSession = useMemo(
    () => sessions.find((s) => s.id === activeId) ?? null,
    [sessions, activeId],
  );

  return (
    <div className="h-full flex flex-col">
      {/* Header */}
      <div className="px-4 py-3 border-b border-white/10 bg-white/5 flex items-center justify-between">
        <div>
          <h1 className="text-lg font-semibold">沙箱 Sandbox</h1>
          <p className="text-xs text-neutral-500 mt-0.5">
            在隔离容器内执行代码与浏览器自动化 · 实时观察终端与浏览器画面
          </p>
        </div>
      </div>

      {/* Body */}
      <div className="flex-1 min-h-0 grid grid-cols-12 gap-2 p-2">
        {/* Left: session list */}
        <div className="col-span-3 md:col-span-2 bg-white/5 rounded border border-white/10 min-h-0">
          <SandboxList />
        </div>

        {/* Right: workspace */}
        <div className="col-span-9 md:col-span-10 flex flex-col min-h-0 gap-2">
          <SandboxToolbar sessionId={activeId} />

          {activeSession?.browserEnabled ? (
            <div className="flex-1 min-h-0 grid grid-cols-12 gap-2">
              {/* Browser Use Agent 控制面板 */}
              <div className="col-span-4 xl:col-span-3 bg-[#0f0f14] rounded border border-white/10 min-h-0 overflow-hidden">
                <BrowserUsePanel sessionId={activeId!} />
              </div>
              {/* 浏览器实时视图 */}
              <div className="col-span-8 xl:col-span-9 bg-[#0f0f14] rounded border border-white/10 min-h-0 overflow-hidden">
                <BrowserView sessionId={activeId!} />
              </div>
              {/* 终端 */}
              <div className="col-span-12 h-[30%] min-h-[120px] bg-[#1a1b26] rounded border border-white/10 overflow-hidden">
                <SandboxTerminal sessionId={activeId!} />
              </div>
            </div>
          ) : (
            <div className="flex-1 min-h-0 grid grid-cols-1 lg:grid-cols-2 gap-2">
              <div className="bg-[#1a1b26] rounded border border-white/10 min-h-0 overflow-hidden">
                {activeId ? (
                  <SandboxTerminal sessionId={activeId} />
                ) : (
                  <div className="h-full flex items-center justify-center text-neutral-500 text-sm">
                    选择左侧沙箱，或新建一个沙箱开始使用
                  </div>
                )}
              </div>
              <div className="bg-[#0f0f14] rounded border border-white/10 min-h-0 overflow-hidden">
                <div className="h-full flex items-center justify-center text-neutral-500 text-sm px-6 text-center">
                  {activeId
                    ? '该沙箱未启用浏览器。销毁后重新创建并勾选"启动浏览器"以使用浏览器视图与 Browser Use Agent。'
                    : '选择沙箱以查看浏览器视图'}
                </div>
              </div>
            </div>
          )}
        </div>
      </div>

      {/* Footer status */}
      <div className="px-4 py-2 border-t border-white/10 bg-white/5 text-xs text-neutral-500">
        活跃沙箱: {sessions.length} · 当前: {activeId?.slice(0, 18) ?? '无'} · {new Date(now).toLocaleTimeString()}
      </div>
    </div>
  );
}
