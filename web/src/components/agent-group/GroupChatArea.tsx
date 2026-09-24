/**
 * GroupChatArea — chat message list + input for a swarm group.
 *
 * Seats run as background graph nodes, so their replies arrive twice: as
 * `group_message_delta` while the seat is still writing, and as
 * `group_message_created` once the seat has settled and the row is persisted.
 * Both ride the same `stream_event` WebSocket channel the normal chat uses.
 *
 * Full agent capabilities are now rendered per seat: streaming thoughts,
 * tool call cards, tool results, token usage summaries, and execution
 * state indicators — mirroring the main agent experience.
 */
import { useEffect, useRef, useState, useCallback } from 'react';
import { Loader2, Send, Brain, Wrench, CheckCircle2, XCircle, ChevronDown, ChevronRight, Clock } from 'lucide-react';
import { useAgentGroupStore } from '@/stores/agent-group';
import { useChatMountsStore } from '@/stores/chat-mounts';
import { wsManager } from '@/api/ws';
import { ChatToolbar } from '@/components/chat/ChatToolbar';
import { MarkdownRenderer } from '@/components/chat/MarkdownRenderer';
import type { GroupMessage, SelectedMounts } from '@/api/agent-groups';

/** Per-seat streaming activity state — full capabilities mirroring main agent. */
interface SeatActivity {
  name: string;
  text: string;
  thinking: string;
  thinkingOpen: boolean;
  toolCalls: SeatToolCall[];
  status: 'idle' | 'thinking' | 'tool_exec' | 'done' | 'failed';
  tokenIn: number;
  tokenOut: number;
  startedAt: number;
}

interface SeatToolCall {
  id: string;
  name: string;
  input: string;
  output: string;
  status: 'running' | 'done' | 'error';
  open: boolean;
}

/** Recover the seat id from a swarm node id (`seat-<id>`), or null. */
function seatIdFromNodeId(nodeId: unknown): number | null {
  const m = /^seat-(\d+)$/.exec(typeof nodeId === 'string' ? nodeId : '');
  return m ? Number(m[1]) : null;
}

function AgentAvatar({ label }: { label: string }) {
  return (
    <div className="size-7 rounded-full bg-accent flex items-center justify-center text-[10px] font-medium shrink-0 mt-0.5 text-white">
      {label[0] ?? 'A'}
    </div>
  );
}

function TokenBadge({ tokenIn, tokenOut }: { tokenIn: number; tokenOut: number }) {
  if (!tokenIn && !tokenOut) return null;
  return (
    <span className="text-[10px] text-muted-foreground ml-2 flex items-center gap-1">
      <span className="inline-flex items-center gap-0.5">
        <span className="text-[9px] opacity-60">↑</span>{tokenIn.toLocaleString()}
      </span>
      <span className="inline-flex items-center gap-0.5">
        <span className="text-[9px] opacity-60">↓</span>{tokenOut.toLocaleString()}
      </span>
    </span>
  );
}

function ThinkingBlock({ thinking, open, onToggle }: { thinking: string; open: boolean; onToggle: () => void }) {
  if (!thinking) return null;
  return (
    <div className="mt-1.5 border border-amber-500/20 rounded-md bg-amber-500/5 overflow-hidden">
      <button
        onClick={onToggle}
        className="flex items-center gap-1.5 w-full px-2.5 py-1.5 text-[11px] text-amber-600 dark:text-amber-400 font-medium hover:bg-amber-500/10 transition-colors"
      >
        {open ? <ChevronDown className="size-3" /> : <ChevronRight className="size-3" />}
        <Brain className="size-3" />思考过程 {open ? '' : `(${thinking.length} 字)`}
      </button>
      {open && (
        <div className="px-3 py-2 text-[11px] text-amber-700/80 dark:text-amber-300/70 whitespace-pre-wrap max-h-48 overflow-y-auto border-t border-amber-500/10">
          {thinking}
        </div>
      )}
    </div>
  );
}

function ToolCallCard({ tc, onToggle }: { tc: SeatToolCall; onToggle: () => void }) {
  return (
    <div className="mt-1.5 border border-blue-500/20 rounded-md bg-blue-500/5 overflow-hidden">
      <button
        onClick={onToggle}
        className="flex items-center gap-1.5 w-full px-2.5 py-1.5 text-[11px] text-blue-600 dark:text-blue-400 font-medium hover:bg-blue-500/10 transition-colors"
      >
        {tc.open ? <ChevronDown className="size-3" /> : <ChevronRight className="size-3" />}
        <Wrench className="size-3" />
        {tc.name}
        {tc.status === 'running' && <Loader2 className="size-3 animate-spin ml-1" />}
        {tc.status === 'done' && <CheckCircle2 className="size-3 text-green-500 ml-1" />}
        {tc.status === 'error' && <XCircle className="size-3 text-red-500 ml-1" />}
      </button>
      {tc.open && (
        <div className="px-3 py-2 text-[11px] space-y-1.5 border-t border-blue-500/10">
          {tc.input && (
            <div>
              <span className="text-blue-500/70 font-medium">入参:</span>
              <pre className="mt-0.5 text-[10px] whitespace-pre-wrap break-all bg-black/10 dark:bg-white/5 rounded p-1 max-h-24 overflow-y-auto">
                {tc.input}
              </pre>
            </div>
          )}
          {tc.output && (
            <div>
              <span className="text-blue-500/70 font-medium">结果:</span>
              <pre className="mt-0.5 text-[10px] whitespace-pre-wrap break-all bg-black/10 dark:bg-white/5 rounded p-1 max-h-32 overflow-y-auto">
                {tc.output}
              </pre>
            </div>
          )}
        </div>
      )}
    </div>
  );
}

function DurationBadge({ ms }: { ms: number }) {
  if (!ms) return null;
  const sec = (ms / 1000).toFixed(1);
  return (
    <span className="text-[10px] text-muted-foreground ml-2 flex items-center gap-1">
      <Clock className="size-2.5" />{sec}s
    </span>
  );
}

function MessageBubble({ msg, groupJid }: { msg: GroupMessage; groupJid?: string }) {
  const isUser = msg.senderType === 'user';
  const isSystem = msg.senderType === 'system';

  if (isSystem) {
    return (
      <div className="text-center py-1">
        <span className="text-[11px] text-muted-foreground bg-muted px-2 py-0.5 rounded">
          {msg.contentRef ?? ''}
        </span>
      </div>
    );
  }

  const displayName = isUser ? 'Me' : (msg.senderSeatId ? `Agent #${msg.senderSeatId}` : 'Agent');

  return (
    <div className={`flex gap-2 px-4 py-2 ${isUser ? 'justify-end' : 'justify-start'}`}>
      {!isUser && <AgentAvatar label={displayName} />}
      <div className={`max-w-[75%] rounded-lg px-3.5 py-2 text-sm ${isUser ? 'bg-primary text-primary-foreground' : 'bg-muted text-foreground'}`}>
        {!isUser && (
          <div className="flex items-center gap-1 mb-1">
            <span className="text-[11px] font-semibold text-foreground/80">{displayName}</span>
            {msg.status === 'failed' && <XCircle className="size-3 text-red-500" />}
            <TokenBadge tokenIn={msg.tokenIn ?? 0} tokenOut={msg.tokenOut ?? 0} />
            <DurationBadge ms={msg.durationMs ?? 0} />
          </div>
        )}
        {isUser ? (
          <div className="whitespace-pre-wrap break-words">{msg.contentRef ?? ''}</div>
        ) : (
          <div className="min-w-0 overflow-hidden [&>div>*:first-child]:!mt-0">
            <MarkdownRenderer content={msg.contentRef ?? ''} groupJid={groupJid} variant="chat" />
          </div>
        )}
      </div>
      {isUser && (
        <div className="size-7 rounded-full bg-primary flex items-center justify-center text-[10px] font-medium text-primary-foreground shrink-0 mt-0.5">
          Me
        </div>
      )}
    </div>
  );
}

/** Full-capability streaming bubble for a seat that is currently executing. */
function StreamingBubble({
  seatId,
  activity,
  groupJid,
  onToggleThinking,
  onToggleTool,
}: {
  seatId: number;
  activity: SeatActivity;
  groupJid: string;
  onToggleThinking: (seatId: number) => void;
  onToggleTool: (seatId: number, toolIdx: number) => void;
}) {
  const statusIcon = () => {
    switch (activity.status) {
      case 'thinking': return <Brain className="size-3 text-amber-500 animate-pulse" />;
      case 'tool_exec': return <Wrench className="size-3 text-blue-500 animate-pulse" />;
      case 'failed': return <XCircle className="size-3 text-red-500" />;
      default: return activity.text ? null : <Loader2 className="size-3 animate-spin text-muted-foreground" />;
    }
  };

  return (
    <div className="flex gap-2 px-4 py-2 justify-start">
      <AgentAvatar label={activity.name || `Agent #${seatId}`} />
      <div className="max-w-[75%] rounded-lg px-3.5 py-2 text-sm bg-muted text-foreground">
        <div className="flex items-center gap-1.5 mb-1">
          <span className="text-[11px] font-semibold text-foreground/80">
            {activity.name || `Agent #${seatId}`}
          </span>
          {statusIcon()}
          <TokenBadge tokenIn={activity.tokenIn} tokenOut={activity.tokenOut} />
        </div>

        {/* Thinking block */}
        {activity.thinking && (
          <ThinkingBlock
            thinking={activity.thinking}
            open={activity.thinkingOpen}
            onToggle={() => onToggleThinking(seatId)}
          />
        )}

        {/* Tool call cards */}
        {activity.toolCalls.map((tc, idx) => (
          <ToolCallCard
            key={tc.id || idx}
            tc={tc}
            onToggle={() => onToggleTool(seatId, idx)}
          />
        ))}

        {/* Streaming / completed text */}
        {activity.text ? (
          <div className="mt-1.5 min-w-0 overflow-hidden [&>div>*:first-child]:!mt-0">
            <MarkdownRenderer content={activity.text} groupJid={groupJid} variant="chat" streaming />
          </div>
        ) : !activity.thinking && activity.toolCalls.length === 0 ? (
          <span className="inline-flex items-center gap-1.5 text-xs text-muted-foreground">
            <Loader2 className="size-3 animate-spin" />正在准备…
          </span>
        ) : null}
      </div>
    </div>
  );
}

export function GroupChatArea({ groupJid }: { groupJid: string }) {
  const messages = useAgentGroupStore(s => s.messages);
  const messagesLoading = useAgentGroupStore(s => s.messagesLoading);
  const hasMore = useAgentGroupStore(s => s.hasMoreMessages);
  const sendMessage = useAgentGroupStore(s => s.sendMessage);
  const fetchMessages = useAgentGroupStore(s => s.fetchMessages);
  const appendMessage = useAgentGroupStore(s => s.appendMessage);
  const scrollRef = useRef<HTMLDivElement>(null);
  const [input, setInput] = useState('');
  const [sending, setSending] = useState(false);
  const [sendError, setSendError] = useState<string | null>(null);
  const [seats, setSeats] = useState<Record<number, SeatActivity>>({});

  const ensureSeat = useCallback((seatId: number, name?: string): SeatActivity => {
    const defaults: SeatActivity = {
      name: name ?? `Agent #${seatId}`,
      text: '',
      thinking: '',
      thinkingOpen: false,
      toolCalls: [],
      status: 'idle' as const,
      tokenIn: 0,
      tokenOut: 0,
      startedAt: Date.now(),
    };
    setSeats(prev => {
      if (prev[seatId]) return prev;
      return { ...prev, [seatId]: defaults };
    });
    return defaults;
  }, []);

  const updateSeat = useCallback((seatId: number, patch: Partial<SeatActivity>) => {
    setSeats(prev => {
      const cur = prev[seatId];
      if (!cur) return prev;
      return { ...prev, [seatId]: { ...cur, ...patch } };
    });
  }, []);

  useEffect(() => {
    void fetchMessages(groupJid);

    const unsub = wsManager.on('stream_event', (data: any) => {
      if (data?.chatJid !== groupJid) return;
      const event = data.event;
      if (!event) return;

      // ── group_message_delta: streaming reply text ────────────
      if (event.eventType === 'group_message_delta') {
        const seatId = event.groupMessage?.senderSeatId;
        const chunk = event.groupMessage?.content;
        if (!seatId || !chunk) return;
        const seatName: string | undefined = (event.groupMessage as any)?.seatName;
        ensureSeat(seatId, seatName);
        setSeats(prev => {
          const cur = prev[seatId];
          if (!cur) return prev;
          return { ...prev, [seatId]: { ...cur, text: cur.text + chunk, status: 'done' } };
        });
        return;
      }

      // ── group_thinking_delta: streaming reasoning ────────────
      if (event.eventType === 'group_thinking_delta') {
        const seatId = event.groupMessage?.senderSeatId;
        const chunk = event.groupMessage?.content;
        if (!seatId || !chunk) return;
        ensureSeat(seatId, (event.groupMessage as any)?.seatName);
        setSeats(prev => {
          const cur = prev[seatId];
          if (!cur) return prev;
          return {
            ...prev,
            [seatId]: {
              ...cur,
              thinking: cur.thinking + chunk,
              status: 'thinking',
              thinkingOpen: cur.thinkingOpen || cur.thinking.length < 200,
            },
          };
        });
        return;
      }

      // ── group_tool_call: a tool was invoked ──────────────────
      if (event.eventType === 'group_tool_call') {
        const seatId = event.groupMessage?.senderSeatId;
        if (!seatId) return;
        const tc = event.groupMessage?.toolCall;
        ensureSeat(seatId, (event.groupMessage as any)?.seatName);
        setSeats(prev => {
          const cur = prev[seatId];
          if (!cur) return prev;
          return {
            ...prev,
            [seatId]: {
              ...cur,
              status: 'tool_exec',
              toolCalls: [...cur.toolCalls, {
                id: tc?.id ?? crypto.randomUUID(),
                name: tc?.name ?? (event.groupMessage?.content ?? 'tool'),
                input: tc?.input ? JSON.stringify(tc.input, null, 2) : '',
                output: '',
                status: 'running' as const,
                open: true,
              }],
            },
          };
        });
        return;
      }

      // ── group_tool_result: a tool returned ───────────────────
      if (event.eventType === 'group_tool_result') {
        const seatId = event.groupMessage?.senderSeatId;
        if (!seatId) return;
        const tc = event.groupMessage?.toolCall;
        setSeats(prev => {
          const cur = prev[seatId];
          if (!cur) return prev;
          const updated = [...cur.toolCalls];
          const lastIdx = updated.length - 1;
          if (lastIdx >= 0 && tc?.id && updated[lastIdx].id === tc.id) {
            updated[lastIdx] = {
              ...updated[lastIdx],
              output: typeof tc.output === 'string' ? tc.output : JSON.stringify(tc.output ?? '', null, 2),
              status: 'done',
            };
          } else if (lastIdx >= 0) {
            updated[lastIdx] = {
              ...updated[lastIdx],
              output: event.groupMessage?.content ?? '',
              status: 'done',
            };
          }
          return { ...prev, [seatId]: { ...cur, toolCalls: updated } };
        });
        return;
      }

      // ── group_seat_status: execution state change ────────────
      if (event.eventType === 'group_seat_status') {
        const seatId = event.groupMessage?.senderSeatId;
        if (!seatId) return;
        ensureSeat(seatId, (event.groupMessage as any)?.seatName);
        const newStatus = event.groupMessage?.status;
        if (newStatus === 'completed' || newStatus === 'failed' || newStatus === 'interrupted') {
          updateSeat(seatId, {
            status: newStatus === 'failed' ? 'failed' : 'done',
            tokenIn: event.groupMessage?.tokenIn ?? 0,
            tokenOut: event.groupMessage?.tokenOut ?? 0,
          });
        }
        return;
      }

      // ── group_token_usage: token counters ────────────────────
      if (event.eventType === 'group_token_usage') {
        const seatId = event.groupMessage?.senderSeatId;
        if (!seatId) return;
        updateSeat(seatId, {
          tokenIn: event.groupMessage?.tokenIn ?? 0,
          tokenOut: event.groupMessage?.tokenOut ?? 0,
        });
        return;
      }

      // ── group_message_created: persisted row ─────────────────
      if (event.eventType === 'group_message_created') {
        const gm = event.groupMessage;
        if (!gm) return;
        appendMessage({
          ...gm,
          contentRef: gm.content,
          mentions: [],
          parentMsgId: null,
          tokenIn: gm.tokenIn ?? 0,
          tokenOut: gm.tokenOut ?? 0,
          durationMs: gm.durationMs ?? 0,
        } as GroupMessage);
        setSeats(prev => {
          if (!gm.senderSeatId || !prev[gm.senderSeatId]) return prev;
          const next = { ...prev };
          delete next[gm.senderSeatId!];
          return next;
        });
        return;
      }

      // ── graph_node_start: a seat takes the floor ─────────────
      const seatId = seatIdFromNodeId(event.graphEvent?.nodeId);
      if (seatId === null) return;
      if (event.eventType === 'graph_node_start') {
        const title: string | undefined = (event.graphEvent as any)?.title;
        ensureSeat(seatId, title);
        updateSeat(seatId, { status: 'thinking', text: '', thinking: '', toolCalls: [] });
      } else if (event.eventType === 'graph_node_end' || event.eventType === 'graph_node_status') {
        if (event.graphEvent?.status === 'completed' || event.graphEvent?.status === 'failed') {
          updateSeat(seatId, {
            status: event.graphEvent.status === 'failed' ? 'failed' : 'done',
          });
        }
      }
    });
    return () => { unsub(); };
  }, [groupJid]); // eslint-disable-line react-hooks/exhaustive-deps

  useEffect(() => {
    scrollRef.current?.scrollTo({ top: scrollRef.current.scrollHeight, behavior: 'smooth' });
  }, [messages.length, seats]);

  const handleSend = async () => {
    const text = input.trim();
    if (!text || sending) return;
    setSending(true);
    setSendError(null);
    setInput('');
    const mounts = useChatMountsStore.getState().getMounts(groupJid);
    const selectedMounts: SelectedMounts | undefined =
      mounts.skillIds.length || mounts.mcpIds.length || mounts.kbIds.length
        ? {
            skills: mounts.skillIds.length ? mounts.skillIds : undefined,
            mcpServers: mounts.mcpIds.length ? mounts.mcpIds : undefined,
            kbIds: mounts.kbIds.length ? mounts.kbIds : undefined,
          }
        : undefined;
    const msg = await sendMessage(groupJid, { text, selectedMounts });
    if (!msg) setSendError('消息发送失败');
    else if (msg.runError) setSendError(`运行未启动：${msg.runError}`);
    setSending(false);
  };

  const handleKeyDown = (e: React.KeyboardEvent) => {
    if (e.key === 'Enter' && !e.shiftKey) { e.preventDefault(); void handleSend(); }
  };

  const activeSeats = Object.entries(seats);

  return (
    <div className="flex flex-col h-full">
      {/* messages */}
      <div ref={scrollRef} className="flex-1 overflow-y-auto py-2">
        {messagesLoading && messages.length === 0 && (
          <div className="flex items-center justify-center py-8">
            <Loader2 className="size-4 animate-spin text-muted-foreground" />
          </div>
        )}
        {hasMore && (
          <button
            onClick={() => fetchMessages(groupJid, String(messages[0]?.id))}
            className="w-full text-center py-2 text-xs text-muted-foreground hover:text-foreground"
          >
            加载更多
          </button>
        )}
        {messages.map(m => (
          <MessageBubble key={m.id} msg={m} groupJid={groupJid} />
        ))}
        {activeSeats.map(([seatIdStr, activity]) => (
          <StreamingBubble
            key={`seat-${seatIdStr}`}
            seatId={Number(seatIdStr)}
            activity={activity}
            groupJid={groupJid}
            onToggleThinking={(sid) => {
              setSeats(prev => {
                const cur = prev[sid];
                if (!cur) return prev;
                return { ...prev, [sid]: { ...cur, thinkingOpen: !cur.thinkingOpen } };
              });
            }}
            onToggleTool={(sid, idx) => {
              setSeats(prev => {
                const cur = prev[sid];
                if (!cur) return prev;
                const updated = [...cur.toolCalls];
                if (updated[idx]) updated[idx] = { ...updated[idx], open: !updated[idx].open };
                return { ...prev, [sid]: { ...cur, toolCalls: updated } };
              });
            }}
          />
        ))}
        {!messagesLoading && messages.length === 0 && activeSeats.length === 0 && (
          <div className="flex flex-col items-center justify-center h-full text-muted-foreground">
            <p className="text-sm">暂无消息</p>
            <p className="text-xs mt-1">发送第一条消息开始群聊</p>
          </div>
        )}
      </div>

      {/* input */}
      <div className="border-t border-border p-3 shrink-0">
        <ChatToolbar
          groupJid={groupJid}
          onPickQuickSkill={(skillId, prompt) => {
            useChatMountsStore.getState().setSkills(groupJid, [skillId]);
            setInput(prompt);
          }}
        />
        {sendError && (
          <p className="text-[11px] text-red-500 mb-1">{sendError}</p>
        )}
        <div className="flex items-end gap-2">
          <textarea
            value={input}
            onChange={e => setInput(e.target.value)}
            onKeyDown={handleKeyDown}
            placeholder="输入消息... (Enter 发送)"
            rows={2}
            className="flex-1 resize-none rounded-md border border-border bg-background px-3 py-2 text-sm placeholder:text-muted-foreground focus:outline-none focus:ring-1 focus:ring-primary"
          />
          <button
            onClick={() => void handleSend()}
            disabled={!input.trim() || sending}
            className="size-9 rounded-md bg-primary text-primary-foreground flex items-center justify-center disabled:opacity-50 shrink-0"
          >
            <Send className="size-4" />
          </button>
        </div>
      </div>
    </div>
  );
}