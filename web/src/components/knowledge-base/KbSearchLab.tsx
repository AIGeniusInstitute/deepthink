import { useState } from 'react';
import { Button } from '@/components/ui/button';
import { Card, CardContent } from '@/components/ui/card';
import { toast } from 'sonner';
import { Search } from 'lucide-react';
import { useKnowledgeBasesStore, type KbHit, type KbSearchParams } from '@/stores/knowledge-bases';

const MODES: Array<{ value: NonNullable<KbSearchParams['mode']>; label: string; hint: string }> = [
  { value: 'hybrid', label: '混合', hint: '向量 + 关键词，RRF 融合' },
  { value: 'vector', label: '向量', hint: '仅语义相似度' },
  { value: 'keyword', label: '关键词', hint: '仅字面匹配' },
];

/**
 * 检索测试台。
 *
 * 存在的理由：检索效果调不好，多半是因为看不到中间过程。这里把每条命中的两条
 * 臂分数、融合来源和字符偏移一并摊开，让人能判断「没搜到」是切块问题、向量问题
 * 还是查询本身的问题，而不是黑盒式地反复改 topK。
 */
export function KbSearchLab({ kbId }: { kbId: string }) {
  const { search, getDocumentContent } = useKnowledgeBasesStore();
  const [query, setQuery] = useState('');
  const [mode, setMode] = useState<NonNullable<KbSearchParams['mode']>>('hybrid');
  const [topK, setTopK] = useState(5);
  const [minScore, setMinScore] = useState(0);
  const [rerank, setRerank] = useState(false);
  const [debug, setDebug] = useState(false);
  const [hits, setHits] = useState<KbHit[]>([]);
  const [debugInfo, setDebugInfo] = useState<any>(null);
  const [running, setRunning] = useState(false);
  const [source, setSource] = useState<{ chunkId: string; text: string } | null>(null);

  const run = async () => {
    if (!query.trim()) {
      toast.error('请输入查询内容');
      return;
    }
    setRunning(true);
    try {
      const res = await search(kbId, query.trim(), {
        mode,
        top_k: topK,
        min_score: minScore > 0 ? minScore : undefined,
        rerank,
        debug,
      });
      setHits(res.hits);
      setDebugInfo(res.debug ?? null);
      setSource(null);
    } catch (e: any) {
      toast.error(e?.message ?? '检索失败');
    } finally {
      setRunning(false);
    }
  };

  const openSource = async (hit: KbHit) => {
    if (source?.chunkId === hit.chunk_id) {
      setSource(null);
      return;
    }
    try {
      const text = await getDocumentContent(hit.doc_id, hit.start_at, hit.end_at);
      setSource({ chunkId: hit.chunk_id, text });
    } catch {
      toast.error('回源失败');
    }
  };

  return (
    <div className="space-y-3">
      <div className="flex flex-wrap items-center gap-2">
        <input
          type="text"
          data-testid="kb-search-input"
          placeholder="输入查询，例如：如何配置检索模型"
          value={query}
          onChange={(e) => setQuery(e.target.value)}
          onKeyDown={(e) => e.key === 'Enter' && run()}
          className="flex-1 min-w-[240px] px-3 py-1.5 text-sm border rounded-md bg-background"
        />
        <Button size="sm" data-testid="kb-search-button" onClick={run} disabled={running}>
          <Search className="size-4 mr-1" /> {running ? '检索中…' : '检索'}
        </Button>
      </div>

      <div className="flex flex-wrap items-center gap-3 text-xs">
        <div className="flex items-center gap-1">
          <span className="text-muted-foreground">模式</span>
          {MODES.map((m) => (
            <button
              key={m.value}
              title={m.hint}
              onClick={() => setMode(m.value)}
              className={`px-2 py-1 rounded border ${
                mode === m.value ? 'bg-teal-600 text-white border-teal-600' : 'bg-background'
              }`}
            >
              {m.label}
            </button>
          ))}
        </div>
        <label className="flex items-center gap-1">
          <span className="text-muted-foreground">TopK</span>
          <input
            type="number"
            min={1}
            max={50}
            value={topK}
            onChange={(e) => setTopK(Number(e.target.value) || 5)}
            className="w-16 px-1.5 py-1 border rounded bg-background"
          />
        </label>
        <label className="flex items-center gap-1">
          <span className="text-muted-foreground">最低分</span>
          <input
            type="number"
            step="0.05"
            min={0}
            max={1}
            value={minScore}
            onChange={(e) => setMinScore(Number(e.target.value) || 0)}
            className="w-20 px-1.5 py-1 border rounded bg-background"
          />
        </label>
        <label className="flex items-center gap-1">
          <input type="checkbox" checked={rerank} onChange={(e) => setRerank(e.target.checked)} />
          <span className="text-muted-foreground">重排</span>
        </label>
        <label className="flex items-center gap-1">
          <input type="checkbox" checked={debug} onChange={(e) => setDebug(e.target.checked)} />
          <span className="text-muted-foreground">调试信息</span>
        </label>
      </div>

      {debugInfo && (
        <Card>
          <CardContent className="p-3 text-xs space-y-1">
            <div className="font-medium">检索诊断</div>
            <div className="grid grid-cols-2 md:grid-cols-4 gap-2 text-muted-foreground">
              <div>请求模式：{debugInfo.mode}</div>
              <div>实际模式：{debugInfo.effective_mode}</div>
              <div>候选池：{debugInfo.pool_size}</div>
              <div>是否重排：{debugInfo.reranked ? '是' : '否'}</div>
              <div>向量候选：{debugInfo.vector_candidates}</div>
              <div>关键词候选：{debugInfo.keyword_candidates}</div>
              <div>融合后：{debugInfo.fused_candidates}</div>
              <div>
                总耗时：{debugInfo.timings_ms?.total} ms（向量 {debugInfo.timings_ms?.vector} / 关键词{' '}
                {debugInfo.timings_ms?.keyword}）
              </div>
            </div>
            {debugInfo.effective_mode === 'keyword' && debugInfo.mode !== 'keyword' && (
              <div className="text-amber-600">
                向量检索未生效，已降级为关键词检索 —— 通常是 embedding 未配置或查询向量化失败。
              </div>
            )}
          </CardContent>
        </Card>
      )}

      {hits.length === 0 ? (
        <div className="text-sm text-muted-foreground">暂无结果</div>
      ) : (
        <div className="space-y-2">
          <div className="text-sm font-medium">命中 {hits.length} 条</div>
          {hits.map((h) => (
            <Card key={h.chunk_id} data-testid="kb-search-hit">
              <CardContent className="p-3 space-y-1.5">
                <div className="flex items-center justify-between text-xs">
                  <div className="flex items-center gap-2 min-w-0">
                    <span className="font-medium truncate">{h.filename}</span>
                    {h.heading_path && (
                      <span className="truncate px-1.5 py-0.5 rounded bg-indigo-100 text-indigo-700">
                        {h.heading_path}
                      </span>
                    )}
                    <span
                      className={`px-1.5 py-0.5 rounded ${
                        h.source === 'hybrid'
                          ? 'bg-purple-100 text-purple-700'
                          : h.source === 'vector'
                            ? 'bg-blue-100 text-blue-700'
                            : 'bg-amber-100 text-amber-700'
                      }`}
                    >
                      {h.source === 'hybrid' ? '双路命中' : h.source === 'vector' ? '向量' : '关键词'}
                    </span>
                  </div>
                  <div className="font-mono text-muted-foreground shrink-0">
                    {h.score.toFixed(4)} · [{h.start_at}, {h.end_at})
                  </div>
                </div>
                <pre className="whitespace-pre-wrap text-sm bg-muted/40 rounded p-2 max-h-48 overflow-auto">
                  {h.content}
                </pre>
                <div className="flex items-center gap-3 text-xs text-muted-foreground">
                  <span>向量分：{h.vector_score === null ? '—' : h.vector_score.toFixed(4)}</span>
                  <span>关键词分：{h.keyword_score === null ? '—' : h.keyword_score.toFixed(4)}</span>
                  <button className="underline" onClick={() => void openSource(h)}>
                    {source?.chunkId === h.chunk_id ? '收起原文' : '回源核验'}
                  </button>
                </div>
                {source?.chunkId === h.chunk_id && (
                  <div className="text-xs border-t pt-1.5">
                    <div className="font-medium mb-1">
                      原文切片：
                      <span className={source.text === h.content ? 'text-emerald-600' : 'text-red-600'}>
                        {source.text === h.content ? ' 与命中内容一致 ✓' : ' 与命中内容不一致 ✗'}
                      </span>
                    </div>
                    <pre className="whitespace-pre-wrap text-muted-foreground bg-muted/40 rounded p-2 max-h-40 overflow-auto">
                      {source.text}
                    </pre>
                  </div>
                )}
              </CardContent>
            </Card>
          ))}
        </div>
      )}
    </div>
  );
}
