import { useEffect, useMemo, useState } from 'react';
import { ChevronDown, Search, Wrench, BookOpen, Sparkles } from 'lucide-react';
import { useSkillsStore } from '../../stores/skills';
import { useMcpServersStore } from '../../stores/mcp-servers';
import { useKnowledgeBasesStore } from '../../stores/knowledge-bases';
import { useChatMountsStore } from '../../stores/chat-mounts';
import { useDisplayMode } from '../../hooks/useDisplayMode';
import { Popover, PopoverContent, PopoverTrigger } from '@/components/ui/popover';
import { Checkbox } from '@/components/ui/checkbox';

interface ChatToolbarProps {
  groupJid: string;
  onPickQuickSkill: (skillId: string, prompt: string) => void;
}

interface MultiSelectProps {
  label: string;
  icon: React.ReactNode;
  items: Array<{ id: string; label: string; description?: string }>;
  selected: string[];
  onToggle: (id: string) => void;
  placeholder: string;
  emptyText: string;
}

function MultiSelectDropdown({
  label,
  icon,
  items,
  selected,
  onToggle,
  placeholder,
  emptyText,
}: MultiSelectProps) {
  const [open, setOpen] = useState(false);
  const [query, setQuery] = useState('');
  const filtered = useMemo(() => {
    const q = query.trim().toLowerCase();
    if (!q) return items;
    return items.filter(
      (it) =>
        it.label.toLowerCase().includes(q) ||
        it.description?.toLowerCase().includes(q),
    );
  }, [items, query]);

  return (
    <Popover open={open} onOpenChange={setOpen}>
      <PopoverTrigger asChild>
        <button
          type="button"
          className={`flex items-center gap-1 px-2 py-1 rounded-full text-xs font-medium transition-colors border cursor-pointer ${
            selected.length > 0
              ? 'bg-primary/10 text-primary border-primary/40'
              : 'bg-surface text-muted-foreground border-border hover:bg-accent'
          }`}
          title={label}
        >
          {icon}
          <span>{label}</span>
          {selected.length > 0 && (
            <span className="ml-0.5 inline-flex items-center justify-center min-w-[16px] h-4 px-1 text-[10px] rounded-full bg-primary text-primary-foreground">
              {selected.length}
            </span>
          )}
          <ChevronDown className="w-3 h-3 opacity-60" />
        </button>
      </PopoverTrigger>
      <PopoverContent
        align="start"
        sideOffset={4}
        className="w-64 p-0 bg-popover border border-border rounded-lg shadow-lg"
      >
        <div className="p-2 border-b border-border">
          <div className="flex items-center gap-1.5 px-2 h-8 rounded-md bg-background border border-border">
            <Search className="w-3.5 h-3.5 text-muted-foreground shrink-0" />
            <input
              className="flex-1 bg-transparent text-xs outline-none placeholder:text-muted-foreground"
              placeholder={placeholder}
              value={query}
              onChange={(e) => setQuery(e.target.value)}
              autoFocus
            />
          </div>
        </div>
        <div className="max-h-56 overflow-y-auto py-1">
          {filtered.length === 0 ? (
            <div className="px-3 py-4 text-center text-xs text-muted-foreground">{emptyText}</div>
          ) : (
            filtered.map((it) => {
              const checked = selected.includes(it.id);
              return (
                <button
                  key={it.id}
                  type="button"
                  onClick={() => onToggle(it.id)}
                  className="w-full flex items-start gap-2 px-2.5 py-1.5 text-left hover:bg-accent/60 transition-colors"
                >
                  <Checkbox checked={checked} className="mt-0.5 shrink-0" />
                  <div className="min-w-0 flex-1">
                    <div className="text-xs font-medium truncate">{it.label}</div>
                    {it.description && (
                      <div className="text-[11px] text-muted-foreground truncate">{it.description}</div>
                    )}
                  </div>
                </button>
              );
            })
          )}
        </div>
      </PopoverContent>
    </Popover>
  );
}

const EMPTY_MOUNTS: { skillIds: string[]; mcpIds: string[]; kbIds: string[] } = {
  skillIds: [],
  mcpIds: [],
  kbIds: [],
};

export function ChatToolbar({ groupJid, onPickQuickSkill }: ChatToolbarProps) {
  const { mode: displayMode } = useDisplayMode();
  const alignCls = displayMode === 'compact' ? 'mx-auto px-4' : 'max-w-4xl mx-auto px-4 lg:pl-[60px]';

  const { skills, loadSkills } = useSkillsStore();
  const { servers, loadServers } = useMcpServersStore();
  const { list: kbList, load: loadKbs } = useKnowledgeBasesStore();
  // Stable EMPTY_MOUNTS reference avoids the zustand "new object every render"
  // pitfall that triggers React "Maximum update depth exceeded" (#185).
  const mounts = useChatMountsStore((s) => s.mounts[groupJid] ?? EMPTY_MOUNTS);
  const toggleSkill = useChatMountsStore((s) => s.toggleSkill);
  const toggleMcp = useChatMountsStore((s) => s.toggleMcp);
  const toggleKb = useChatMountsStore((s) => s.toggleKb);

  useEffect(() => {
    loadSkills();
    loadServers();
    loadKbs();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  // Office quick skills (builtin)
  const quickSkills = useMemo(
    () => skills.filter((s) => s.source === 'builtin' && s.quickLabel),
    [skills],
  );

  // Dropdown items
  const skillItems = useMemo(
    () =>
      skills.map((s) => ({
        id: s.id,
        label: s.name,
        description: s.description,
      })),
    [skills],
  );
  const mcpItems = useMemo(
    () =>
      servers.map((s) => ({
        id: s.id,
        label: s.id,
        description: s.description,
      })),
    [servers],
  );
  const kbItems = useMemo(
    () =>
      kbList.map((k) => ({
        id: k.id,
        label: k.name,
        description: k.description,
      })),
    [kbList],
  );

  return (
    <div className={`${alignCls} pt-1 pb-1.5 space-y-1.5`}>
      {/* Office quick-skill buttons */}
      {quickSkills.length > 0 && (
        <div className="flex items-center gap-1 overflow-x-auto no-scrollbar">
          {quickSkills.map((s) => (
            <button
              key={s.id}
              type="button"
              onClick={() => onPickQuickSkill(s.id, s.quickPrompt ?? s.name)}
              title={s.description || s.name}
              className="flex-shrink-0 flex items-center gap-1 px-2.5 py-1 rounded-full text-xs font-medium transition-colors cursor-pointer border bg-surface text-foreground border-border hover:bg-accent hover:border-primary/40"
            >
              {s.quickEmoji && <span>{s.quickEmoji}</span>}
              <span>{s.quickLabel}</span>
            </button>
          ))}
        </div>
      )}

      {/* Mount dropdowns */}
      <div className="flex items-center gap-1.5 flex-wrap">
        <MultiSelectDropdown
          label="技能"
          icon={<Sparkles className="w-3.5 h-3.5" />}
          items={skillItems}
          selected={mounts.skillIds}
          onToggle={(id) => toggleSkill(groupJid, id)}
          placeholder="搜索技能…"
          emptyText="暂无可用技能"
        />
        <MultiSelectDropdown
          label="MCP 工具"
          icon={<Wrench className="w-3.5 h-3.5" />}
          items={mcpItems}
          selected={mounts.mcpIds}
          onToggle={(id) => toggleMcp(groupJid, id)}
          placeholder="搜索 MCP 工具…"
          emptyText="暂无 MCP 服务器"
        />
        <MultiSelectDropdown
          label="知识库"
          icon={<BookOpen className="w-3.5 h-3.5" />}
          items={kbItems}
          selected={mounts.kbIds}
          onToggle={(id) => toggleKb(groupJid, id)}
          placeholder="搜索知识库…"
          emptyText="暂无知识库"
        />
      </div>
    </div>
  );
}
