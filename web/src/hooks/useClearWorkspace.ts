import { useState } from 'react';
import { toast } from 'sonner';
import { useChatStore } from '../stores/chat';

export function useClearWorkspace() {
  const clearHistory = useChatStore((s) => s.clearHistory);
  const [clearState, setClearState] = useState({ open: false, jid: '', name: '' });
  const [clearLoading, setClearLoading] = useState(false);

  const openClear = (jid: string, name: string) => setClearState({ open: true, jid, name });
  const closeClear = () => setClearState({ open: false, jid: '', name: '' });

  const handleClearConfirm = async () => {
    setClearLoading(true);
    try {
      const ok = await clearHistory(clearState.jid);
      if (!ok) toast.error('重建工作区失败，请稍后重试');
      closeClear();
    } catch (err) {
      toast.error(err instanceof Error ? err.message : '重建工作区失败，请稍后重试');
      closeClear();
    } finally {
      setClearLoading(false);
    }
  };

  return { clearState, clearLoading, openClear, closeClear, handleClearConfirm };
}
