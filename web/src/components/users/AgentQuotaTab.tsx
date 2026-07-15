import { useEffect, useState } from 'react';
import { RefreshCw, Save } from 'lucide-react';
import { Button } from '@/components/ui/button';
import { Card } from '@/components/ui/card';
import { Input } from '@/components/ui/input';
import { useUsersStore, type AgentQuota } from '../../stores/users';
import type { TabNotification } from './utils';

export function AgentQuotaTab({ setNotice, setError }: TabNotification) {
  const { quotas, loading, fetchQuotas, updateQuota } = useUsersStore();
  const [editing, setEditing] = useState<Record<string, string>>({});

  useEffect(() => { void fetchQuotas(); }, [fetchQuotas]);

  const handleSave = async (q: AgentQuota) => {
    const raw = editing[q.user_id];
    if (raw === undefined) return;
    const num = Number(raw);
    if (!Number.isInteger(num) || num < 0 || num > 10000) {
      setError('配额必须是 0-10000 的整数');
      return;
    }
    if (num === q.quota) {
      setEditing((prev) => { const n = { ...prev }; delete n[q.user_id]; return n; });
      return;
    }
    const ok = await updateQuota(q.user_id, num);
    if (ok) {
      setNotice(`已更新 ${q.username} 的配额为 ${num}`);
      setEditing((prev) => { const n = { ...prev }; delete n[q.user_id]; return n; });
    } else {
      setError('配额更新失败');
    }
  };

  return (
    <div className="space-y-4">
      <div className="flex items-center justify-between">
        <div className="text-sm text-muted-foreground">
          Agent 配额决定单用户最多可创建的 Agent 定义数量。默认 10，范围 0-10000。
        </div>
        <Button variant="outline" onClick={() => fetchQuotas()} disabled={loading}>
          <RefreshCw className={`w-4 h-4 ${loading ? 'animate-spin' : ''}`} /> 刷新
        </Button>
      </div>

      <Card className="divide-y divide-border overflow-hidden">
        {quotas.length === 0 ? (
          <div className="p-6 text-center text-sm text-muted-foreground">暂无数据</div>
        ) : (
          quotas.map((q) => {
            const editingValue = editing[q.user_id];
            const isEditing = editingValue !== undefined;
            const over = q.used > q.quota;
            return (
              <div key={q.user_id} className="px-5 py-4 flex items-center gap-4">
                <div className="flex-1 min-w-0">
                  <div className="text-sm font-medium truncate">{q.username}</div>
                  <div className="text-xs text-muted-foreground font-mono">{q.user_id}</div>
                </div>
                <div className={`text-sm tabular-nums ${over ? 'text-red-600 font-medium' : 'text-muted-foreground'}`}>
                  已用 {q.used} / 配额
                </div>
                <div className="flex items-center gap-2">
                  <Input
                    type="number"
                    min={0}
                    max={10000}
                    value={isEditing ? editingValue : String(q.quota)}
                    onChange={(e) => setEditing((prev) => ({ ...prev, [q.user_id]: e.target.value }))}
                    className="w-24 text-sm h-auto px-2.5 py-1.5"
                  />
                  {isEditing && (
                    <Button size="sm" onClick={() => handleSave(q)}>
                      <Save className="w-4 h-4" /> 保存
                    </Button>
                  )}
                </div>
              </div>
            );
          })
        )}
      </Card>
    </div>
  );
}
