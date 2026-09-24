/**
 * GroupChatArea — chat message list + input for a swarm group.
 *
 * Seats run as background graph nodes, so their replies arrive twice: as
 * `group_message_delta` while the seat is still writing, and as
 * `group_message_created` once the seat has settled and the row is persisted.
 * Both ride the same `stream_event` WebSocket channel the normal chat uses.
 */
import { useEffect, useRef, useState } from 'react';
import { Loader2, Send } from 'lucide-react';
import { useAgentGroupStore } from '@/stores/agent-group';
import { useChatMountsStore } from '@/stores/chat-mounts';
import { wsManager } from '@/api/ws';
import { ChatToolbar } from '@/components/chat/ChatToolbar';
import { MarkdownRenderer } from '@/components/chat/MarkdownRenderer';
import type { GroupMessage, SelectedMounts } from '@/api/agent-groups';

/** A seat that is currently running: its label plus the reply so far. */
interface SeatActivity {
  name: string;
  text: string;
}

/** Recover the seat id from a swarm node id (`seat-<id>`), or null. */
function seatIdFromNodeId(nodeId: unknown): number | null {
  const m = /^seat-(\d+)$/.exec(typeof nodeId === 'string' ? nodeId : '');
  return m ? Number(m[1]) : null;
}

function AgentAvatar({ label }: { label: string }) {
  return (
    <div className="size-6 rounded-full bg-accent flex items-center justify-center text-[10px] font-medium shrink-0 mt-0.5">
      {label[0] ?? 'A'}
    </div>
  );
}

function MessageBubble({ msg, groupJid }: { msg: GroupMessage; groupJid?: string }) {
  const isUser = msg.senderType === 'user';
  const isSystem = msg.senderType === 'system';
  const mentionList: string[] = Array.isArray(msg.mentions) ? msg.mentions : [];

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
    <div className={`flex gap-2 px-4 py-1.5 ${isUser ? 'justify-end' : 'justify-start'}`}>
      {!isUser && <AgentAvatar label={displayName} />}
      <div className={`max-w-[70%] rounded-lg px-3 py-1.5 text-sm ${isUser ? 'bg-primary text-primary-foreground' : 'bg-muted text-foreground'}`}>
        {!isUser && (
          <div className="text-[10px] font-medium text-muted-foreground mb-0.5">{displayName}</div>
        )}
        {isUser ? (
          <div className="whitespace-pre-wrap break-words">{msg.contentRef ?? ''}</div>
        ) : (
          // Seats answer in Markdown (lists, bold, code) — render it the same way
          // the main chat renders an agent reply.
          <div className="min-w-0 overflow-hidden [&>div>*:first-child]:!mt-0">
            <MarkdownRenderer content={msg.contentRef ?? ''} groupJid={groupJid} variant="chat" />
          </div>
        )}
        {mentionList.length > 0 && (
          <div className="flex gap-1 mt-1 flex-wrap">
            {mentionList.map((m, i) => (
              <span key={i} className="text-[10px] bg-accent rounded px-1">@{typeof m === 'string' ? m : '?'}</span>
            ))}
          </div>
        )}
      </div>
      {isUser && (
        <div className="size-6 rounded-full bg-primary flex items-center justify-center text-[10px] font-medium text-primary-foreground shrink-0 mt-0.5">
          Me
        </div>
      )}
    </div>
  );
}

/** A seat that is still working: streamed text so far, or a thinking placeholder. */
function StreamingBubble({ seatId, activity, groupJid }: { seatId: number; activity: SeatActivity; groupJid: string }) {
  return (
    <div className="flex gap-2 px-4 py-1.5 justify-start">
      <AgentAvatar label={`Agent #${seatId}`} />
      <div className="max-w-[70%] rounded-lg px-3 py-1.5 text-sm bg-muted text-foreground">
        <div className="text-[10px] font-medium text-muted-foreground mb-0.5">
          Agent #{seatId}
          {activity.name ? ` · ${activity.name}` : ''}
        </div>
        {activity.text ? (
          <div className="min-w-0 overflow-hidden [&>div>*:first-child]:!mt-0">
            <MarkdownRenderer content={activity.text} groupJid={groupJid} variant="chat" streaming />
          </div>
        ) : (
          <span className="inline-flex items-center gap-1.5 text-xs text-muted-foreground">
            <Loader2 className="size-3 animate-spin" />正在思考…
          </span>
        )}
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

  useEffect(() => {
    void fetchMessages(groupJid);
    // Seat replies stream in over the shared stream_event channel: deltas while
    // a seat writes, then the persisted row (with a real id) when it settles.
    const unsub = wsManager.on('stream_event', (data: any) => {
      if (data?.chatJid !== groupJid) return;
      const event = data.event;
      if (!event) return;

      if (event.eventType === 'group_message_delta') {
        const seatId = event.groupMessage?.senderSeatId;
        const chunk = event.groupMessage?.content;
        if (!seatId || !chunk) return;
        setSeats(prev => ({
          ...prev,
          [seatId]: { name: prev[seatId]?.name ?? '', text: (prev[seatId]?.text ?? '') + chunk },
        }));
        return;
      }

      if (event.eventType === 'group_message_created') {
        const gm = event.groupMessage;
        if (!gm) return;
        // The row's text field is `contentRef` (see GET /messages); the event
        // carries the same text as `content`.
        appendMessage({
          ...gm,
          contentRef: gm.content,
          mentions: [],
          parentMsgId: null,
        } as GroupMessage);
        setSeats(prev => {
          if (!gm.senderSeatId || !prev[gm.senderSeatId]) return prev;
          const next = { ...prev };
          delete next[gm.senderSeatId];
          return next;
        });
        return;
      }

      // Node lifecycle: show which seat holds the floor, and drop the activity
      // of a seat that settled without producing a reply (e.g. empty output).
      const seatId = seatIdFromNodeId(event.graphEvent?.nodeId);
      if (seatId === null) return;
      if (event.eventType === 'graph_node_start') {
        setSeats(prev => ({
          ...prev,
          [seatId]: { name: event.graphEvent?.title ?? prev[seatId]?.name ?? '', text: '' },
        }));
      } else if (event.eventType === 'graph_node_end' || event.eventType === 'graph_node_status') {
        if (event.graphEvent?.status !== 'running') {
          setSeats(prev => {
            if (!prev[seatId]) return prev;
            const next = { ...prev };
            delete next[seatId];
            return next;
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
    // Skills / MCP servers / KBs selected in the toolbar ride along with the
    // message and are mounted on every seat of the run it starts.
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
        {messages.map(m => <MessageBubble key={m.id} msg={m} groupJid={groupJid} />)}
        {activeSeats.map(([seatId, activity]) => (
          <StreamingBubble key={`seat-${seatId}`} seatId={Number(seatId)} activity={activity} groupJid={groupJid} />
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
            // Same behavior as the main chat: selecting a quick skill mounts it
            // for this conversation and prefills the input with its prompt.
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
