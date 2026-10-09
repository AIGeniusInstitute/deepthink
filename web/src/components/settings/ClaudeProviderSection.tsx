import { useCallback, useEffect, useRef, useState } from 'react';
import {
  Loader2,
} from 'lucide-react';

import { ConfirmDialog } from '@/components/common/ConfirmDialog';
import { api } from '../../api/client';
import type {
  ProviderWithHealth,
  ProvidersListResponse,
  BalancingConfig,
  ProviderHealthStatus,
} from './types';
import { getErrorMessage } from './types';
import { ProviderList } from './ProviderList';
import { ProviderEditor } from './ProviderEditor';
import { BalancingSettings } from './BalancingSettings';

interface ClaudeProviderSectionProps {
  setNotice: (msg: string | null) => void;
  setError: (msg: string | null) => void;
}

export function ClaudeProviderSection({ setNotice, setError }: ClaudeProviderSectionProps) {
  const [providers, setProviders] = useState<ProviderWithHealth[]>([]);
  const [balancing, setBalancing] = useState<BalancingConfig>({
    strategy: 'round-robin',
    unhealthyThreshold: 3,
    recoveryIntervalMs: 300000,
  });
  const [enabledCount, setEnabledCount] = useState(0);

  const [loading, setLoading] = useState(true);
  const [togglingId, setTogglingId] = useState<string | null>(null);
  const [deletingId, setDeletingId] = useState<string | null>(null);

  // 编辑器状态
  const [editorOpen, setEditorOpen] = useState(false);
  const [editingProvider, setEditingProvider] = useState<ProviderWithHealth | null>(null);

  // 确认对话框
  const [pendingDeleteProvider, setPendingDeleteProvider] = useState<ProviderWithHealth | null>(null);

  // 健康轮询标记
  const healthTimerRef = useRef<ReturnType<typeof setInterval> | null>(null);

  // ─── 加载提供商列表 ──────────────────────────────────────────
  const loadProviders = useCallback(async () => {
    try {
      const data = await api.get<ProvidersListResponse>('/api/config/claude/providers');
      setProviders(data.providers);
      setBalancing(data.balancing);
      setEnabledCount(data.enabledCount);
    } catch (err) {
      setError(getErrorMessage(err, '加载提供商列表失败'));
    } finally {
      setLoading(false);
    }
  }, [setError]);

  useEffect(() => {
    loadProviders();
  }, [loadProviders]);

  // ─── 健康状态轮询（启用 >= 2 个提供商时） ────────────────────
  useEffect(() => {
    if (healthTimerRef.current) {
      clearInterval(healthTimerRef.current);
      healthTimerRef.current = null;
    }

    if (enabledCount < 2) return;

    const pollHealth = async () => {
      try {
        const data = await api.get<{ statuses: ProviderHealthStatus[] }>(
          '/api/config/claude/providers/health',
        );
        setProviders((prev) =>
          prev.map((p) => {
            const updated = data.statuses.find((s) => s.profileId === p.id);
            return updated ? { ...p, health: updated } : p;
          }),
        );
      } catch {
        // 静默忽略
      }
    };

    healthTimerRef.current = setInterval(pollHealth, 10000);
    return () => {
      if (healthTimerRef.current) {
        clearInterval(healthTimerRef.current);
        healthTimerRef.current = null;
      }
    };
  }, [enabledCount]);

  // ─── 切换提供商启用/禁用 ──────────────────────────────────────
  const handleToggle = useCallback(
    async (provider: ProviderWithHealth) => {
      setTogglingId(provider.id);
      try {
        await api.post(`/api/config/claude/providers/${provider.id}/toggle`);
        await loadProviders();
        setNotice(provider.enabled ? `已禁用「${provider.name}」` : `已启用「${provider.name}」`);
      } catch (err) {
        setError(getErrorMessage(err, '切换提供商状态失败'));
      } finally {
        setTogglingId(null);
      }
    },
    [loadProviders, setNotice, setError],
  );

  // ─── 重置健康状态 ─────────────────────────────────────────────
  const handleResetHealth = useCallback(
    async (provider: ProviderWithHealth) => {
      try {
        await api.post(`/api/config/claude/providers/${provider.id}/reset-health`);
        await loadProviders();
        setNotice('健康状态已重置');
      } catch (err) {
        setError(getErrorMessage(err, '重置健康状态失败'));
      }
    },
    [loadProviders, setNotice, setError],
  );

  // ─── 删除提供商 ───────────────────────────────────────────────
  const handleDeleteConfirm = useCallback(async () => {
    if (!pendingDeleteProvider) return;

    const provider = pendingDeleteProvider;
    setDeletingId(provider.id);
    setPendingDeleteProvider(null);

    try {
      await api.delete(`/api/config/claude/providers/${provider.id}`);
      setNotice(`已删除提供商「${provider.name}」`);
      await loadProviders();
    } catch (err) {
      setError(getErrorMessage(err, '删除提供商失败'));
    } finally {
      setDeletingId(null);
    }
  }, [pendingDeleteProvider, loadProviders, setNotice, setError]);

  // ─── 复制第三方提供商 ────────────────────────────────────────────
  const handleDuplicate = useCallback(
    async (provider: ProviderWithHealth) => {
      try {
        await api.post('/api/config/claude/providers', {
          name: `${provider.name} (副本)`,
          type: 'third_party',
          anthropicBaseUrl: provider.anthropicBaseUrl,
          anthropicModel: provider.anthropicModel,
          customEnv: provider.customEnv,
          enabled: false,
        });
        await loadProviders();
        setNotice(`已复制提供商「${provider.name}」，密钥需要重新填写`);
      } catch (err) {
        setError(getErrorMessage(err, '复制提供商失败'));
      }
    },
    [loadProviders, setNotice, setError],
  );

  // ─── 编辑器回调 ───────────────────────────────────────────────
  const handleEditorSave = useCallback(() => {
    setEditorOpen(false);
    setEditingProvider(null);
    loadProviders();
  }, [loadProviders]);

  const handleEditorCancel = useCallback(() => {
    setEditorOpen(false);
    setEditingProvider(null);
  }, []);

  // ─── 负载均衡配置变更 ─────────────────────────────────────────
  const handleBalancingChange = useCallback(
    async (updates: Partial<BalancingConfig>) => {
      const newBalancing = { ...balancing, ...updates };
      setBalancing(newBalancing);
      try {
        await api.put('/api/config/claude/balancing', newBalancing);
        setNotice('负载均衡配置已保存');
      } catch (err) {
        setError(getErrorMessage(err, '保存负载均衡配置失败'));
        // 回滚
        await loadProviders();
      }
    },
    [balancing, loadProviders, setNotice, setError],
  );

  const busy = loading || togglingId !== null || deletingId !== null;

  if (loading && providers.length === 0) {
    return (
      <div className="flex items-center justify-center py-12">
        <Loader2 className="w-6 h-6 animate-spin text-muted-foreground" />
      </div>
    );
  }

  return (
    <div className="space-y-4">
      {/* 提供商列表 */}
      <ProviderList
        providers={providers}
        balancingStrategy={balancing.strategy}
        onEdit={(p) => {
          setEditingProvider(p);
          setEditorOpen(true);
        }}
        onDelete={(p) => setPendingDeleteProvider(p)}
        onToggle={handleToggle}
        onResetHealth={handleResetHealth}
        onDuplicate={handleDuplicate}
        onAdd={() => {
          setEditingProvider(null);
          setEditorOpen(true);
        }}
        togglingId={togglingId}
        deletingId={deletingId}
        disabled={busy}
      />

      {/* 负载均衡设置（启用 >= 2 个提供商时显示） */}
      {enabledCount >= 2 && (
        <BalancingSettings
          balancing={balancing}
          onChange={handleBalancingChange}
          disabled={busy}
        />
      )}

      {/* 编辑器弹窗 */}
      <ProviderEditor
        open={editorOpen}
        provider={editingProvider}
        balancingStrategy={balancing.strategy}
        onSave={handleEditorSave}
        onCancel={handleEditorCancel}
        setNotice={setNotice}
        setError={setError}
      />

      {/* 确认删除对话框 */}
      <ConfirmDialog
        open={pendingDeleteProvider !== null}
        onClose={() => setPendingDeleteProvider(null)}
        onConfirm={handleDeleteConfirm}
        title="删除提供商"
        message={pendingDeleteProvider ? `确认删除提供商「${pendingDeleteProvider.name}」？` : '确认删除该提供商？'}
        confirmText="确认删除"
        confirmVariant="danger"
        loading={deletingId !== null}
      />
    </div>
  );
}
