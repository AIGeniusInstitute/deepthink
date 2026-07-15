import { useEffect, useState } from 'react';
import { useMarketplaceStore, type MarketplaceItemType } from '../stores/marketplace';
import { PageHeader } from '@/components/common/PageHeader';
import { Button } from '@/components/ui/button';
import { Card, CardContent } from '@/components/ui/card';
import { toast } from 'sonner';
import { Download, ShoppingBag } from 'lucide-react';

const TYPE_LABEL: Record<MarketplaceItemType, string> = {
  agent_template: 'Agent',
  mcp_template: 'MCP',
  skill_template: 'Skill',
  kb_template: 'KB',
};

const ALL_TYPES: MarketplaceItemType[] = ['agent_template', 'mcp_template', 'skill_template', 'kb_template'];

export function MarketplacePage() {
  const { list, loading, load, install } = useMarketplaceStore();
  const [filter, setFilter] = useState<MarketplaceItemType | 'all'>('all');

  useEffect(() => { load(); }, [load]);

  const handleInstall = async (id: string, name: string) => {
    const res = await install(id);
    if (res.success) toast.success(`Installed: ${name}`);
    else toast.error(res.message);
  };

  const filtered = filter === 'all' ? list : list.filter((i) => i.itemType === filter);

  return (
    <div className="mx-auto max-w-7xl px-4 py-6">
      <PageHeader
        title="市场"
        subtitle="浏览并安装管理员发布的 Agent / MCP / Skill / KB 模板"
      />

      <div className="mt-4 flex flex-wrap gap-2">
        <button
          className={`px-3 py-1 text-sm rounded-md border ${filter === 'all' ? 'bg-teal-500 text-white' : 'bg-background'}`}
          onClick={() => setFilter('all')}
        >
          全部
        </button>
        {ALL_TYPES.map((t) => (
          <button
            key={t}
            className={`px-3 py-1 text-sm rounded-md border ${filter === t ? 'bg-teal-500 text-white' : 'bg-background'}`}
            onClick={() => setFilter(t)}
          >
            {TYPE_LABEL[t]}
          </button>
        ))}
      </div>

      {loading && <div className="text-sm text-muted-foreground mt-4">加载中…</div>}

      {filtered.length === 0 && !loading && (
        <div className="mt-10 text-center text-sm text-muted-foreground">
          <ShoppingBag className="size-10 mx-auto mb-2 opacity-50" />
          市场暂无内容。
        </div>
      )}

      <div className="mt-6 grid grid-cols-1 sm:grid-cols-2 lg:grid-cols-3 gap-4">
        {filtered.map((item) => (
          <Card key={item.id}>
            <CardContent className="p-4 space-y-2">
              <div className="flex items-start justify-between">
                <div className="font-medium truncate flex-1">{item.name}</div>
                <span className="text-xs px-1.5 py-0.5 rounded bg-muted">{TYPE_LABEL[item.itemType]}</span>
              </div>
              <div className="text-sm text-muted-foreground line-clamp-3 min-h-[3.5rem]">
                {item.description || '无描述'}
              </div>
              <div className="text-xs text-muted-foreground">
                作者 {item.authorName || '匿名'} · 安装 {item.installedCount}
              </div>
              {item.tags && item.tags.length > 0 && (
                <div className="flex flex-wrap gap-1">
                  {item.tags.map((t) => (
                    <span key={t} className="text-xs px-1.5 py-0.5 rounded bg-muted/50">#{t}</span>
                  ))}
                </div>
              )}
              <div className="pt-2">
                <Button size="sm" className="w-full" onClick={() => handleInstall(item.id, item.name)}>
                  <Download className="size-4 mr-1" /> 安装
                </Button>
              </div>
            </CardContent>
          </Card>
        ))}
      </div>
    </div>
  );
}
