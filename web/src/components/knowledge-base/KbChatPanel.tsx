import { useEffect, useRef, useState } from 'react';
import { Button } from '@/components/ui/button';
import { Card, CardContent } from '@/components/ui/card';
import { toast } from 'sonner';
import { Eraser, Send, Square } from 'lucide-react';
import {
  streamKbChat,
  useKnowledgeBasesStore,
  type KbChatMessage,
  type KbCitation,
} from '@/stores/knowledge-bases';

/**
 * 知识库问答。
 *
 * 回答里的 [1] [2] 是模型按参考资料编号写的，因此引用列表必须和本次回答一起
 * 呈现 —— 用户点开编号要能看到依据的原文，否则「有引用」只是装饰。
 */
export function KbChatPanel({ kbId, isFaq = false }: { kbId: string; isFaq?: boolean }) {
  const { getDocumentContent, clearChatSession } = useKnowledgeBasesStore();
  const [messages, setMessages] = useState<KbChatMessage[]>([]);
  const [input, setInput] = useState('');
  const [streaming, setStreaming] = useState(false);
  const [sessionId, setSessionId] = useState<string | undefined>(undefined);
  const [expanded, setExpanded] = useState<string | null>(null);
  const [source, setSource] = useState<string | null>(null);
  const abortRef = useRef<AbortController | null>(null);
  const bottomRef = useRef<HTMLDivElement | null>(null);

  useEffect(() => {
    bottomRef.current?.scrollIntoView({ behavior: 'smooth' });
  }, [messages]);

  const ask = async () => {
    const question = input.trim();
    if (!question || streaming) return;
    setInput('');
    setMessages((prev) => [...prev, { role: 'user', content: question }]);
    // 先放一条空的回答占位，流式增量往里填。
    setMessages((prev) => [...prev, { role: 'assistant', content: '', citations: [] }]);
    setStreaming(true);

    const controller = new AbortController();
    abortRef.current = controller;
    try {
      await streamKbChat(
        { question, session_id: sessionId, kb_ids: [kbId], top_k: 5, mode: 'hybrid' },
        (event) => {
          if (event.type === 'session') {
            setSessionId(event.session_id);
          } else if (event.type === 'citations') {
            setMessages((prev) => {
              const next = [...prev];
              next[next.length - 1] = { ...next[next.length - 1], citations: event.citations };
              return next;
            });
          } else if (event.type === 'delta') {
            setMessages((prev) => {
              const next = [...prev];
              const last = next[next.length - 1];
              next[next.length - 1] = { ...last, content: last.content + event.text };
              return next;
            });
          } else if (event.type === 'error') {
            toast.error(event.message);
          }
        },
        controller.signal,
      );
    } catch (e: any) {
      if (e?.name !== 'AbortError') toast.error(e?.message ?? '问答失败');
    } finally {
      setStreaming(false);
      abortRef.current = null;
    }
  };

  const openCitation = async (citation: KbCitation) => {
    if (expanded === citation.chunk_id) {
      setExpanded(null);
      setSource(null);
      return;
    }
    setExpanded(citation.chunk_id);
    // FAQ 条目的 content 是合成的问答文本，按偏移回源只会切出容器文档里的无关内容。
    if (isFaq) {
      setSource(citation.content);
      return;
    }
    try {
      setSource(await getDocumentContent(citation.doc_id, citation.start_at, citation.end_at));
    } catch {
      setSource(null);
      toast.error('回源失败');
    }
  };

  return (
    <div className="space-y-3">
      <div className="flex items-center justify-between">
        <div className="text-sm text-muted-foreground">
          基于本知识库检索结果作答，回答中的 [n] 对应下方引用出处。
        </div>
        <Button
          size="sm"
          variant="outline"
          disabled={streaming || messages.length === 0}
          onClick={async () => {
            if (sessionId) await clearChatSession(sessionId);
            setMessages([]);
            setSessionId(undefined);
            setExpanded(null);
            setSource(null);
          }}
        >
          <Eraser className="size-4 mr-1" /> 清空会话
        </Button>
      </div>

      <div className="space-y-2 max-h-[520px] overflow-auto pr-1">
        {messages.length === 0 && (
          <div className="text-sm text-muted-foreground">向这个知识库提问，例如：这份文档讲了什么？</div>
        )}
        {messages.map((m, i) => (
          <Card
            key={i}
            data-testid={`kb-chat-${m.role}`}
            className={m.role === 'user' ? 'bg-teal-50 dark:bg-teal-950/30' : ''}
          >
            <CardContent className="p-3 space-y-2">
              <div className="text-xs font-medium text-muted-foreground">
                {m.role === 'user' ? '我' : '知识库助手'}
              </div>
              <pre className="whitespace-pre-wrap text-sm font-sans">
                {m.content || (streaming && i === messages.length - 1 ? '思考中…' : '')}
              </pre>

              {(m.citations?.length ?? 0) > 0 && (
                <div className="border-t pt-2 space-y-1">
                  <div className="text-xs font-medium">引用出处（{m.citations!.length}）</div>
                  {m.citations!.map((c, ci) => (
                    <div key={c.chunk_id} className="text-xs">
                      <button
                        className="text-left w-full hover:bg-muted/50 rounded px-1.5 py-1"
                        onClick={() => void openCitation(c)}
                      >
                        <span className="font-mono mr-1">[{ci + 1}]</span>
                        <span className="font-medium">{c.filename}</span>
                        {c.heading_path && <span className="text-muted-foreground"> · {c.heading_path}</span>}
                        {!isFaq && (
                          <span className="text-muted-foreground font-mono">
                            {' '}
                            · [{c.start_at}, {c.end_at})
                          </span>
                        )}
                        <div className="text-muted-foreground truncate">{c.content}</div>
                      </button>
                      {expanded === c.chunk_id && source !== null && (
                        <pre className="whitespace-pre-wrap text-muted-foreground bg-muted/40 rounded p-2 mt-1 max-h-40 overflow-auto">
                          {source}
                        </pre>
                      )}
                    </div>
                  ))}
                </div>
              )}
            </CardContent>
          </Card>
        ))}
        <div ref={bottomRef} />
      </div>

      <div className="flex gap-2">
        <input
          type="text"
          data-testid="kb-chat-input"
          placeholder="输入问题…"
          value={input}
          onChange={(e) => setInput(e.target.value)}
          onKeyDown={(e) => e.key === 'Enter' && ask()}
          disabled={streaming}
          className="flex-1 px-3 py-1.5 text-sm border rounded-md bg-background"
        />
        {streaming ? (
          <Button size="sm" variant="outline" onClick={() => abortRef.current?.abort()}>
            <Square className="size-4 mr-1" /> 停止
          </Button>
        ) : (
          <Button size="sm" data-testid="kb-chat-send" onClick={ask}>
            <Send className="size-4 mr-1" /> 提问
          </Button>
        )}
      </div>
    </div>
  );
}
