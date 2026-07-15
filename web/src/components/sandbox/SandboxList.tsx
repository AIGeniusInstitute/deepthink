import { useSandboxStore } from '../../stores/sandbox';

export function SandboxList() {
  const sessions = useSandboxStore((s) => s.sessions);
  const activeId = useSandboxStore((s) => s.activeSessionId);
  const setActive = useSandboxStore((s) => s.setActive);

  return (
    <div className="h-full overflow-auto">
      <div className="text-xs text-neutral-500 px-3 py-2 border-b border-white/10">
        活跃沙箱 ({sessions.length})
      </div>
      {sessions.length === 0 ? (
        <div className="text-neutral-500 text-xs p-4 text-center">
          暂无沙箱。在右侧工具栏创建一个。
        </div>
      ) : (
        <ul className="space-y-1 p-2">
          {sessions.map((s) => (
            <li key={s.id}>
              <button
                onClick={() => setActive(s.id)}
                className={`w-full text-left p-2 rounded text-xs transition-colors ${
                  activeId === s.id
                    ? 'bg-brand-500/20 border border-brand-500/40'
                    : 'bg-white/5 border border-transparent hover:bg-white/10'
                }`}
              >
                <div className="font-mono truncate text-neutral-200">
                  {s.id.slice(0, 18)}
                </div>
                <div className="flex items-center gap-2 mt-1 text-neutral-500">
                  <span>{s.language}</span>
                  {s.browserEnabled && <span>🌐</span>}
                  <span className={`inline-block w-1.5 h-1.5 rounded-full ${
                    s.status === 'running' ? 'bg-green-400' :
                    s.status === 'idle' ? 'bg-yellow-400' :
                    s.status === 'stopped' ? 'bg-neutral-500' :
                    'bg-red-400'
                  }`} />
                  <span>{s.status}</span>
                </div>
                <div className="text-neutral-600 text-[10px] mt-1">
                  {new Date(s.createdAt).toLocaleTimeString()}
                </div>
              </button>
            </li>
          ))}
        </ul>
      )}
    </div>
  );
}
