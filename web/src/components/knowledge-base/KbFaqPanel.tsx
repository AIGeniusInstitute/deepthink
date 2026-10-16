import { useCallback, useEffect, useState } from 'react';
import { Button } from '@/components/ui/button';
import { Card, CardContent } from '@/components/ui/card';
import { toast } from 'sonner';
import { Pencil, Plus, RefreshCw, Trash2 } from 'lucide-react';
import {
  useKnowledgeBasesStore,
  type FaqEntryInput,
  type KbFaqEntry,
  type KnowledgeBase,
} from '@/stores/knowledge-bases';

/** 多行输入 ↔ 字符串数组：一行一条，空行丢掉。 */
function linesToArray(value: string): string[] {
  return value
    .split('\n')
    .map((s) => s.trim())
    .filter(Boolean);
}

function arrayToLines(values: string[] | undefined): string {
  return (values ?? []).join('\n');
}

interface Draft {
  id?: string;
  standard_question: string;
  similar_questions: string;
  negative_questions: string;
  answers: string;
}

const EMPTY_DRAFT: Draft = {
  standard_question: '',
  similar_questions: '',
  negative_questions: '',
  answers: '',
};

/**
 * FAQ 条目管理。
 *
 * FAQ 库与文档库是两条互不相通的入库路径（FAQ 库不接受文件上传），所以这里不是
 * 文档列表的变体，而是独立的一屏。三条语义在前端可见：
 *   - 负向问题不参与索引，只在命中后否决——所以它能和相似问题并列填写，但语义相反；
 *   - 任何改动都会让该条目的向量失效，需要重新向量化才可检索；
 *   - `separate` 模式下相似问题各占一条向量，`combined` 模式下合并成一条。
 */
export function KbFaqPanel({ kb }: { kb: KnowledgeBase }) {
  const {
    listFaqEntries,
    createFaqEntry,
    updateFaqEntry,
    deleteFaqEntries,
    updateFaqConfig,
    search,
  } = useKnowledgeBasesStore();

  const [entries, setEntries] = useState<KbFaqEntry[]>([]);
  const [loading, setLoading] = useState(false);
  const [draft, setDraft] = useState<Draft | null>(null);
  const [saving, setSaving] = useState(false);
  const [probe, setProbe] = useState('');
  const [hits, setHits] = useState<Array<{ id: string; text: string; score: number }> | null>(null);
  const [probing, setProbing] = useState(false);

  const refresh = useCallback(async () => {
    setLoading(true);
    try {
      setEntries(await listFaqEntries(kb.id));
    } catch {
      setEntries([]);
    } finally {
      setLoading(false);
    }
  }, [kb.id, listFaqEntries]);

  useEffect(() => {
    void refresh();
  }, [refresh]);

  const save = async () => {
    if (!draft) return;
    const input: FaqEntryInput = {
      standard_question: draft.standard_question.trim(),
      similar_questions: linesToArray(draft.similar_questions),
      negative_questions: linesToArray(draft.negative_questions),
      answers: linesToArray(draft.answers),
    };
    if (!input.standard_question) {
      toast.error('标准问题必填');
      return;
    }
    setSaving(true);
    const res = draft.id
      ? await updateFaqEntry(kb.id, draft.id, input)
      : await createFaqEntry(kb.id, input);
    setSaving(false);
    if (!res.ok) {
      toast.error(res.error ?? '保存失败');
      return;
    }
    toast.success(draft.id ? '已保存，需重新向量化才能检索到新内容' : '条目已创建');
    setDraft(null);
    await refresh();
  };

  const remove = async (entry: KbFaqEntry) => {
    if (!confirm(`删除条目「${entry.standard_question}」？`)) return;
    const deleted = await deleteFaqEntries(kb.id, [entry.id]);
    if (deleted > 0) {
      toast.success('已删除');
      await refresh();
    } else {
      toast.error('删除失败');
    }
  };

  const runProbe = async () => {
    if (!probe.trim()) return;
    setProbing(true);
    try {
      const { hits: fresh } = await search(kb.id, probe.trim(), { mode: 'vector', top_k: 5 });
      setHits(
        fresh.map((h) => ({ id: h.chunk_id, text: h.content, score: h.score })),
      );
    } catch (e: any) {
      toast.error(e?.message ?? '试检索失败');
    } finally {
      setProbing(false);
    }
  };

  const config = kb.faqConfig ?? { indexMode: 'question_answer' as const, questionIndexMode: 'combined' as const };

  return (
    <div className="space-y-3">
      <Card>
        <CardContent className="p-4 space-y-3">
          <div className="flex flex-wrap items-center justify-between gap-2">
            <div className="text-sm font-medium">索引方式</div>
            <div className="flex items-center gap-2">
              <select
                data-testid="kb-faq-index-mode"
                className="px-2 py-1 border rounded-md bg-background text-sm"
                value={config.indexMode}
                onChange={(e) =>
                  void updateFaqConfig(kb.id, { indexMode: e.target.value as any }).then(() => {
                    toast.success('已切换索引方式，需重新向量化');
                    void refresh();
                  })
                }
              >
                <option value="question_answer">问题 + 答案</option>
                <option value="question_only">仅问题</option>
              </select>
              <select
                data-testid="kb-faq-question-index-mode"
                className="px-2 py-1 border rounded-md bg-background text-sm"
                value={config.questionIndexMode}
                onChange={(e) =>
                  void updateFaqConfig(kb.id, { questionIndexMode: e.target.value as any }).then(() => {
                    toast.success('已切换问题索引方式，需重新向量化');
                    void refresh();
                  })
                }
              >
                <option value="combined">合并为一条向量</option>
                <option value="separate">每个问题各一条向量</option>
              </select>
            </div>
          </div>
          <div className="text-xs text-muted-foreground">
            FAQ 库没有关键词索引，只走向量检索——用「关键词」模式搜它永远是 0 条，这不是故障。
            负向问题不参与索引，只在命中之后按「忽略大小写与首尾空白的精确相等」否决。
          </div>
        </CardContent>
      </Card>

      <div className="flex flex-wrap items-center gap-2">
        <Button size="sm" data-testid="kb-faq-create" onClick={() => setDraft({ ...EMPTY_DRAFT })}>
          <Plus className="size-4 mr-1" /> 新建条目
        </Button>
        <Button size="sm" variant="outline" onClick={() => void refresh()}>
          <RefreshCw className="size-4 mr-1" /> 刷新
        </Button>
        <span className="text-xs text-muted-foreground">{entries.length} 条</span>
      </div>

      {draft && (
        <Card>
          <CardContent className="p-4 space-y-3">
            <div className="font-semibold text-sm">{draft.id ? '编辑条目' : '新建条目'}</div>
            <div className="space-y-2">
              <label className="text-xs text-muted-foreground">标准问题（必填）</label>
              <input
                data-testid="kb-faq-standard-question"
                className="w-full px-3 py-2 border rounded-md bg-background text-sm"
                value={draft.standard_question}
                onChange={(e) => setDraft({ ...draft, standard_question: e.target.value })}
              />
              <label className="text-xs text-muted-foreground">相似问题（一行一条）</label>
              <textarea
                data-testid="kb-faq-similar-questions"
                rows={3}
                className="w-full px-3 py-2 border rounded-md bg-background text-sm"
                value={draft.similar_questions}
                onChange={(e) => setDraft({ ...draft, similar_questions: e.target.value })}
              />
              <label className="text-xs text-muted-foreground">
                负向问题（一行一条，命中即否决该条目）
              </label>
              <textarea
                data-testid="kb-faq-negative-questions"
                rows={2}
                className="w-full px-3 py-2 border rounded-md bg-background text-sm"
                value={draft.negative_questions}
                onChange={(e) => setDraft({ ...draft, negative_questions: e.target.value })}
              />
              <label className="text-xs text-muted-foreground">答案（一行一条，最多 5 条）</label>
              <textarea
                data-testid="kb-faq-answers"
                rows={3}
                className="w-full px-3 py-2 border rounded-md bg-background text-sm"
                value={draft.answers}
                onChange={(e) => setDraft({ ...draft, answers: e.target.value })}
              />
            </div>
            <div className="flex justify-end gap-2">
              <Button variant="outline" size="sm" onClick={() => setDraft(null)}>
                取消
              </Button>
              <Button size="sm" data-testid="kb-faq-save" disabled={saving} onClick={() => void save()}>
                保存
              </Button>
            </div>
          </CardContent>
        </Card>
      )}

      {loading && <div className="text-sm text-muted-foreground">加载中…</div>}
      {!loading && entries.length === 0 && (
        <div className="text-sm text-muted-foreground">暂无条目。</div>
      )}

      <div className="space-y-2">
        {entries.map((entry) => (
          <Card key={entry.id} data-testid="kb-faq-entry">
            <CardContent className="p-4">
              <div className="flex items-start justify-between gap-3">
                <div className="min-w-0 flex-1 space-y-1">
                  <div className="font-medium text-sm">{entry.standard_question}</div>
                  {entry.similar_questions.length > 0 && (
                    <div className="text-xs text-muted-foreground">
                      相似：{entry.similar_questions.join(' / ')}
                    </div>
                  )}
                  {entry.negative_questions.length > 0 && (
                    <div className="text-xs text-amber-600">
                      负向：{entry.negative_questions.join(' / ')}
                    </div>
                  )}
                  {entry.answers.length > 0 && (
                    <div className="text-xs text-muted-foreground">答案：{entry.answers.join(' | ')}</div>
                  )}
                  <div className="text-xs text-muted-foreground">
                    v{entry.version} · {entry.embedded ? '已向量化' : '待向量化'}
                  </div>
                </div>
                <div className="flex items-center gap-0.5 shrink-0">
                  <Button
                    size="sm"
                    variant="ghost"
                    onClick={() =>
                      setDraft({
                        id: entry.id,
                        standard_question: entry.standard_question,
                        similar_questions: arrayToLines(entry.similar_questions),
                        negative_questions: arrayToLines(entry.negative_questions),
                        answers: arrayToLines(entry.answers),
                      })
                    }
                  >
                    <Pencil className="size-4" />
                  </Button>
                  <Button size="sm" variant="ghost" onClick={() => void remove(entry)}>
                    <Trash2 className="size-4 text-red-500" />
                  </Button>
                </div>
              </div>
            </CardContent>
          </Card>
        ))}
      </div>

      <Card>
        <CardContent className="p-4 space-y-2">
          <div className="text-sm font-medium">试检索</div>
          <div className="flex gap-2">
            <input
              data-testid="kb-faq-probe-input"
              className="flex-1 px-3 py-2 border rounded-md bg-background text-sm"
              placeholder="输入一个问法，看向量检索命中哪条"
              value={probe}
              onChange={(e) => setProbe(e.target.value)}
              onKeyDown={(e) => e.key === 'Enter' && void runProbe()}
            />
            <Button size="sm" data-testid="kb-faq-probe-run" disabled={probing} onClick={() => void runProbe()}>
              检索
            </Button>
          </div>
          {hits && (
            <div className="space-y-1">
              {hits.length === 0 && <div className="text-xs text-muted-foreground">没有命中。</div>}
              {hits.map((h) => (
                <div key={h.id} className="rounded border p-2 text-xs whitespace-pre-wrap">
                  <span className="text-muted-foreground">{h.score.toFixed(3)}</span> {h.text}
                </div>
              ))}
            </div>
          )}
        </CardContent>
      </Card>
    </div>
  );
}
