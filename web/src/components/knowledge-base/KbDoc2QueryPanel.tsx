import { useEffect, useState } from 'react';
import { Button } from '@/components/ui/button';
import { Card, CardContent } from '@/components/ui/card';
import { toast } from 'sonner';
import { Sparkles } from 'lucide-react';
import {
  useKnowledgeBasesStore,
  type KnowledgeBase,
  type QuestionGenerationConfig,
} from '@/stores/knowledge-bases';

/**
 * Doc2Query（预生成问题）配置。
 *
 * 这个能力对召回是"加法"：问题不会进分块正文，只作为额外索引条目存在，命中后
 * 仍归并回父分块。所以界面上必须说清两件事 —— 开关默认是**关**的（对齐上游
 * `QuestionGenerationConfig` 的零值），以及生成本身要逐块调模型、耗时与分块数
 * 成正比，不是一次点完就回来的操作。
 */
export function KbDoc2QueryPanel({ kb }: { kb: KnowledgeBase }) {
  const { updateQuestionGenConfig, generateQuestions } = useKnowledgeBasesStore();
  const [cfg, setCfg] = useState<QuestionGenerationConfig>(
    kb.questionGenerationConfig ?? { enabled: false, questionCount: 3, customInstructions: '' },
  );
  const [saving, setSaving] = useState(false);
  const [running, setRunning] = useState(false);

  useEffect(() => {
    if (kb.questionGenerationConfig) setCfg(kb.questionGenerationConfig);
  }, [kb.questionGenerationConfig]);

  const persist = async (patch: Partial<QuestionGenerationConfig>) => {
    const next = { ...cfg, ...patch };
    setCfg(next);
    setSaving(true);
    const updated = await updateQuestionGenConfig(kb.id, patch);
    setSaving(false);
    if (!updated) {
      toast.error('保存失败');
      return;
    }
    if (updated.questionGenerationConfig) setCfg(updated.questionGenerationConfig);
  };

  const run = async () => {
    setRunning(true);
    const res = await generateQuestions(kb.id);
    setRunning(false);
    if (!res.ok || !res.stats) {
      toast.error(res.error ?? '生成失败');
      return;
    }
    const s = res.stats;
    toast.success(
      `生成完成：合格分块 ${s.eligible} · 成功 ${s.generated}（问题 ${s.questions} 条）` +
        (s.skipped ? ` · 跳过 ${s.skipped}` : '') +
        (s.stale ? ` · 正文已改而丢弃 ${s.stale}` : ''),
    );
  };

  return (
    <Card data-testid="kb-doc2query-panel">
      <CardContent className="p-4 space-y-3">
        <div className="flex items-center justify-between gap-3 flex-wrap">
          <div className="min-w-0">
            <div className="text-sm font-medium flex items-center gap-1.5">
              <Sparkles className="size-4 text-teal-600" /> 预生成问题（Doc2Query）
            </div>
            <div className="text-xs text-muted-foreground mt-0.5">
              为每个分块生成"这段内容能回答的问题"，作为额外索引条目扩大召回。
              问题不会出现在分块正文里，命中后仍返回原分块。
            </div>
          </div>
          <div className="flex items-center gap-3 shrink-0">
            <label className="flex items-center gap-2 text-xs select-none cursor-pointer">
              <input
                type="checkbox"
                data-testid="kb-doc2query-enabled"
                className="size-4 accent-teal-600"
                checked={cfg.enabled}
                disabled={saving}
                onChange={(e) => void persist({ enabled: e.target.checked })}
              />
              启用
            </label>
            <label className="text-xs">
              <span className="text-muted-foreground mr-1">每块问题数</span>
              <input
                type="number"
                min={1}
                max={10}
                data-testid="kb-doc2query-count"
                className="w-16 px-2 py-1 text-sm border rounded-md bg-background"
                value={cfg.questionCount}
                disabled={saving}
                onChange={(e) => setCfg({ ...cfg, questionCount: Number(e.target.value) || 3 })}
                onBlur={(e) => void persist({ questionCount: Number(e.target.value) || 3 })}
              />
            </label>
            <Button
              size="sm"
              data-testid="kb-doc2query-run"
              onClick={() => void run()}
              disabled={running || !cfg.enabled}
              title={cfg.enabled ? '对全部合格分块生成问题' : '需要先启用'}
            >
              {running ? '生成中…' : '生成问题'}
            </Button>
          </div>
        </div>

        <label className="block text-xs">
          <div className="text-muted-foreground mb-1">
            业务指令（可选，上限 4000 字；与核心要求冲突时以核心要求为准）
          </div>
          <textarea
            data-testid="kb-doc2query-instructions"
            className="w-full px-2 py-1.5 text-sm border rounded-md bg-background"
            rows={2}
            placeholder="例如：问题里必须带上模块名，不要问版本号"
            value={cfg.customInstructions}
            disabled={saving}
            onChange={(e) => setCfg({ ...cfg, customInstructions: e.target.value })}
            onBlur={(e) => void persist({ customInstructions: e.target.value })}
          />
        </label>

        <div className="text-xs text-muted-foreground">
          {cfg.enabled
            ? '已启用。生成会逐块调用问答模型（每次一条消息，温度 0.7），分块多时耗时较长；正文在生成期间被改动过的分块，其结果会被丢弃。'
            : '当前关闭。关闭状态下入库与检索都照常，只是没有预生成问题这条召回路径。'}
        </div>
      </CardContent>
    </Card>
  );
}
