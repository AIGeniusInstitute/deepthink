/**
 * GroupChatArea — chat message list + input for a swarm group.
 */
import { useEffect, useRef, useState } from 'react';
import { Loader2, Send } from 'lucide-react';
import { useAgentGroupStore } from '@/stores/agent-group';
import type { GroupMessage } from '@/api/agent-groups';

function MessageBubble({ msg }: { msg: GroupMessage }) {
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
      {!isUser && (
        <div className="size-6 rounded-full bg-accent flex items-center justify-center text-[10px] font-medium shrink-0 mt-0.5">
          {displayName[0] ?? 'A'}
        </div>
      )}
      <div className={`max-w-[70%] rounded-lg px-3 py-1.5 text-sm ${isUser ? 'bg-primary text-primary-foreground' : 'bg-muted text-foreground'}`}>
        {!isUser && (
          <div className="text-[10px] font-medium text-muted-foreground mb-0.5">{displayName}</div>
        )}
        <div className="whitespace-pre-wrap break-words">{msg.contentRef ?? ''}</div>
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

export function GroupChatArea({ groupJid }: { groupJid: string }) {
  const messages = useAgentGroupStore(s => s.messages);
  const messagesLoading = useAgentGroupStore(s => s.messagesLoading);
  const hasMore = useAgentGroupStore(s => s.hasMoreMessages);
  const sendMessage = useAgentGroupStore(s => s.sendMessage);
  const fetchMessages = useAgentGroupStore(s => s.fetchMessages);
  const scrollRef = useRef<HTMLDivElement>(null);
  const [input, setInput] = useState('');
  const [sending, setSending] = useState(false);

  useEffect(() => {
    void fetchMessages(groupJid);
  }, [groupJid]); // eslint-disable-line react-hooks/exhaustive-deps

  useEffect(() => {
    scrollRef.current?.scrollTo({ top: scrollRef.current.scrollHeight, behavior: 'smooth' });
  }, [messages.length]);

  const handleSend = async () => {
    const text = input.trim();
    if (!text || sending) return;
    setSending(true);
    setInput('');
    await sendMessage(groupJid, { text });
    setSending(false);
  };

  const handleKeyDown = (e: React.KeyboardEvent) => {
    if (e.key === 'Enter' && !e.shiftKey) { e.preventDefault(); void handleSend(); }
  };

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
        {messages.map(m => <MessageBubble key={m.id} msg={m} />)}
        {!messagesLoading && messages.length === 0 && (
          <div className="flex flex-col items-center justify-center h-full text-muted-foreground">
            <p className="text-sm">暂无消息</p>
            <p className="text-xs mt-1">发送第一条消息开始群聊</p>
          </div>
        )}
      </div>

      {/* input */}
      <div className="border-t border-border p-3 shrink-0">
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