import { useEffect, useState } from 'react';
import { Compass } from 'lucide-react';
import { apiFetch } from '../../api/client';
import { cn } from '@/lib/utils';
import { showToast } from '../../utils/toast';

interface Props {
  chatJid: string;
}

export function SupervisorToggle({ chatJid }: Props) {
  const [enabled, setEnabled] = useState(false);
  const [loading, setLoading] = useState(false);

  useEffect(() => {
    let cancelled = false;
    (async () => {
      try {
        const data = await apiFetch<{ chat_jid: string; enabled: boolean }>(
          `/api/config/supervisor?chat_jid=${encodeURIComponent(chatJid)}`,
        );
        if (!cancelled) setEnabled(data.enabled);
      } catch {
        // default off
      }
    })();
    return () => {
      cancelled = true;
    };
  }, [chatJid]);

  const toggle = async () => {
    setLoading(true);
    const next = !enabled;
    try {
      await apiFetch('/api/config/supervisor', {
        method: 'PUT',
        body: JSON.stringify({ chat_jid: chatJid, enabled: next }),
      });
      setEnabled(next);
      showToast(next ? 'Supervisor 已开启，消息将先经 Supervisor 解析' : 'Supervisor 已关闭');
    } catch (err) {
      showToast(`切换失败：${(err as Error).message}`);
    } finally {
      setLoading(false);
    }
  };

  return (
    <button
      onClick={toggle}
      disabled={loading}
      title={enabled ? 'Supervisor 已开启（点击关闭）' : '开启 Supervisor（托管给 AI 监督者）'}
      className={cn(
        'hidden lg:flex p-2 rounded-lg transition-colors cursor-pointer',
        enabled
          ? 'bg-purple-100 text-purple-700 dark:bg-purple-950/60 dark:text-purple-300'
          : 'hover:bg-accent text-muted-foreground',
      )}
      aria-label={enabled ? '关闭 Supervisor' : '开启 Supervisor'}
    >
      <Compass className={cn('w-5 h-5', enabled && 'animate-pulse')} />
    </button>
  );
}
