import { useEffect, useRef, useState } from 'react';
import { useSandboxStore } from '../../stores/sandbox';
import { wsManager } from '../../api/ws';

interface BrowserViewProps {
  sessionId: string;
}

export function BrowserView({ sessionId }: BrowserViewProps) {
  // Read per-session frame so multiple inline panels can coexist without
  // overwriting each other's frame.
  const frame = useSandboxStore((s) => s.browserFrames[sessionId] ?? null);
  const subscribe = useSandboxStore((s) => s.subscribeBrowser);
  const unsubscribe = useSandboxStore((s) => s.unsubscribeBrowser);
  const isSubscribed = useSandboxStore((s) => s.subscribedSessions.has(sessionId));
  const [started, setStarted] = useState(false);
  const [fps, setFps] = useState(0);
  const frameCountRef = useRef(0);

  useEffect(() => {
    if (!started) return;
    const offFrame = wsManager.on('sandbox_browser_frame', (data: any) => {
      if (data?.sessionId === sessionId) {
        frameCountRef.current += 1;
      }
    });
    const offStarted = wsManager.on('sandbox_browser_started', (data: any) => {
      if (data?.sessionId === sessionId) setStarted(true);
    });
    const offStopped = wsManager.on('sandbox_browser_stopped', (data: any) => {
      if (data?.sessionId === sessionId) setStarted(false);
    });
    const offErr = wsManager.on('sandbox_error', (data: any) => {
      if (data?.sessionId === sessionId) console.error('[sandbox browser]', data.error);
    });

    if (!isSubscribed) {
      subscribe(sessionId);
    }
    const fpsTimer = setInterval(() => {
      setFps(frameCountRef.current);
      frameCountRef.current = 0;
    }, 1000);

    return () => {
      offFrame();
      offStarted();
      offStopped();
      offErr();
      unsubscribe(sessionId);
      clearInterval(fpsTimer);
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [sessionId, started]);

  return (
    <div className="h-full flex flex-col bg-[#0f0f14]">
      <div className="flex items-center justify-between px-3 py-1.5 bg-[#1a1b26] border-b border-[#2a2b36] text-xs">
        <div className="flex items-center gap-2">
          <span className={`inline-block w-2 h-2 rounded-full ${
            started ? 'bg-green-400' : 'bg-neutral-500'
          }`} />
          <span className="text-neutral-400">
            {started ? '浏览器运行中' : '浏览器未启动'}
          </span>
          {started && (
            <span className="text-neutral-500">{fps} fps</span>
          )}
        </div>
        <div className="text-neutral-500">沙箱浏览器视图</div>
      </div>
      <div className="flex-1 min-h-0 flex items-center justify-center overflow-hidden">
        {frame ? (
          <img
            src={frame}
            alt="sandbox browser"
            className="max-w-full max-h-full object-contain"
          />
        ) : (
          <div className="text-neutral-500 text-sm">
            {started ? '等待首帧...' : '点击"启动浏览器"开始'}
          </div>
        )}
      </div>
    </div>
  );
}
