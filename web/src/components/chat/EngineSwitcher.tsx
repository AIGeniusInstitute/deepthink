import { useState } from 'react';
import { Box } from 'lucide-react';
import { useChatStore } from '../../stores/chat';
import type { GroupInfo } from '../../types';

interface EngineSwitcherProps {
  groupJid: string;
  group: GroupInfo | undefined;
}

const ENGINES: Array<{ key: 'claude' | 'atomcode'; label: string }> = [
  { key: 'claude', label: 'Claude' },
  { key: 'atomcode', label: 'AtomCode' },
];

export function EngineSwitcher({ groupJid, group }: EngineSwitcherProps) {
  const switchEngine = useChatStore((s) => s.switchEngine);
  const [busy, setBusy] = useState(false);

  const current = group?.engine ?? 'claude';

  if (!group) return null;

  const handleSwitch = async (engine: 'claude' | 'atomcode') => {
    if (engine === current || busy) return;
    setBusy(true);
    try {
      await switchEngine(groupJid, engine);
    } finally {
      setBusy(false);
    }
  };

  return (
    <div className="hidden lg:flex items-center gap-1 p-1 rounded-lg bg-muted/60 border border-border">
      <Box className="w-3.5 h-3.5 text-muted-foreground ml-1.5" />
      {ENGINES.map((e) => {
        const active = e.key === current;
        return (
          <button
            key={e.key}
            onClick={() => handleSwitch(e.key)}
            disabled={busy}
            className={`px-2 py-1 text-xs rounded-md transition-colors ${
              active
                ? 'bg-primary text-white font-medium'
                : 'text-muted-foreground hover:bg-muted hover:text-foreground'
            } ${busy ? 'opacity-60 cursor-not-allowed' : 'cursor-pointer'}`}
            title={`切换到 ${e.label} 引擎（新会话生效）`}
          >
            {e.label}
          </button>
        );
      })}
    </div>
  );
}
