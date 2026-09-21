/**
 * AgentGroupChatPage — main chat page for a single Agent Swarm Group.
 * Layout: left GroupChatArea + collapsible right PipelinePanel + TraceDetail drawer.
 */
import { useEffect, useState } from 'react';
import { useParams, useNavigate } from 'react-router-dom';
import { ArrowLeft, Users, Settings, Loader2, AlertCircle, ChevronDown } from 'lucide-react';
import { useAgentGroupStore } from '@/stores/agent-group';
import { GroupChatArea } from '@/components/agent-group/GroupChatArea';
import { PipelinePanel } from '@/components/agent-group/PipelinePanel';
import { TraceDetail } from '@/components/agent-group/TraceDetail';
import type { PipelineNode } from '@/api/agent-groups';

export function AgentGroupChatPage() {
  const { jid } = useParams<{ jid: string }>();
  const navigate = useNavigate();

  const currentGroup = useAgentGroupStore(s => s.currentGroup);
  const seats = useAgentGroupStore(s => s.seats);
  const loading = useAgentGroupStore(s => s.detailLoading);
  const error = useAgentGroupStore(s => s.detailError);
  const fetchGroup = useAgentGroupStore(s => s.fetchGroup);
  const clearCurrent = useAgentGroupStore(s => s.clearCurrent);
  const selectNode = useAgentGroupStore(s => s.selectNode);
  const nodes = useAgentGroupStore(s => s.nodes);

  const [showSettings, setShowSettings] = useState(false);
  const [traceNode, setTraceNode] = useState<PipelineNode | null>(null);
  const [mobilePipelineOpen, setMobilePipelineOpen] = useState(false);
  const [isMobile, setIsMobile] = useState(false);

  useEffect(() => {
    const check = () => setIsMobile(window.innerWidth < 768);
    check();
    window.addEventListener('resize', check);
    return () => window.removeEventListener('resize', check);
  }, []);

  useEffect(() => {
    if (!jid) { navigate('/agent-groups', { replace: true }); return; }
    void fetchGroup(jid);
    return () => clearCurrent();
  }, [jid]); // eslint-disable-line react-hooks/exhaustive-deps

  const handleNodeClick = (nodeId: string) => {
    const found = nodes.find(n => n.id === nodeId);
    if (found) { selectNode(nodeId); setTraceNode(found); }
  };

  if (!jid) return null;
  if (loading) {
    return <div className="flex items-center justify-center h-full"><Loader2 className="size-5 animate-spin text-muted-foreground" /></div>;
  }
  if (error) {
    return (
      <div className="flex flex-col items-center justify-center h-full gap-3">
        <AlertCircle className="size-8 text-red-500" />
        <p className="text-sm text-red-500">{error}</p>
        <div className="flex items-center gap-2">
          <button onClick={() => void fetchGroup(jid)} className="text-xs px-3 py-1.5 rounded-md bg-primary text-primary-foreground">重试</button>
          <button onClick={() => navigate('/agent-groups')} className="text-xs px-3 py-1.5 rounded-md border border-border">返回列表</button>
        </div>
      </div>
    );
  }
  if (!currentGroup) return null;

  return (
    <div className="flex flex-col h-full">
      {/* top bar */}
      <div className="flex items-center justify-between px-4 py-2 border-b border-border shrink-0 bg-background">
        <div className="flex items-center gap-3">
          <button onClick={() => navigate('/agent-groups')} className="size-7 rounded-md flex items-center justify-center hover:bg-muted" title="返回列表">
            <ArrowLeft className="size-4" />
          </button>
          <h1 className="text-sm font-semibold text-foreground truncate">{currentGroup.name}</h1>
        </div>

        <div className="flex items-center gap-2">
          <span className="text-[11px] text-muted-foreground flex items-center gap-1">
            <Users className="size-3" />{seats.length}
          </span>

          <button onClick={() => setShowSettings(v => !v)} className="size-7 rounded-md flex items-center justify-center hover:bg-muted" title="群组设置">
            <Settings className="size-4" />
          </button>

          {isMobile && (
            <button onClick={() => setMobilePipelineOpen(v => !v)} className="flex items-center gap-1 text-[11px] px-2 py-1 rounded-md border border-border hover:bg-muted sm:hidden">
              Pipeline <ChevronDown className={`size-3 transition-transform ${mobilePipelineOpen ? 'rotate-180' : ''}`} />
            </button>
          )}
        </div>
      </div>

      {/* settings dropdown */}
      {showSettings && (
        <>
          <div className="fixed inset-0 z-40" onClick={() => setShowSettings(false)} />
          <div className="absolute right-4 top-12 z-50 w-64 rounded-lg border border-border bg-card shadow-lg p-2">
            <div className="px-3 py-2 border-b border-border">
              <p className="text-sm font-medium">{currentGroup.name}</p>
              <p className="text-[10px] text-muted-foreground">{seats.length} Agent 成员</p>
            </div>
            <div className="py-1">
              {seats.map(s => (
                <div key={s.id} className="flex items-center gap-2 px-3 py-1.5 text-xs">
                  <span className="size-2 rounded-full bg-green-500" />
                  <span className="text-foreground flex-1">{s.rolePrompt || s.agentDefinitionId}</span>
                  <span className="text-muted-foreground text-[10px]">{s.speakPolicy}</span>
                </div>
              ))}
            </div>
          </div>
        </>
      )}

      {/* body */}
      <div className="flex-1 flex min-h-0 relative">
        <div className="flex-1 min-w-0">
          <GroupChatArea groupJid={jid} />
        </div>
        {!isMobile && (
          <div className="shrink-0 relative">
            <PipelinePanel groupJid={jid} onNodeClick={handleNodeClick} />
          </div>
        )}
        {isMobile && mobilePipelineOpen && (
          <>
            <div className="fixed inset-0 bg-black/20 z-40" onClick={() => setMobilePipelineOpen(false)} />
            <div className="fixed bottom-0 left-0 right-0 z-50 max-h-[60vh] bg-background rounded-t-xl border-t border-border overflow-hidden">
              <div className="h-60 sm:h-80"><PipelinePanel groupJid={jid} onNodeClick={handleNodeClick} /></div>
            </div>
          </>
        )}
      </div>

      <TraceDetail node={traceNode} onClose={() => { setTraceNode(null); selectNode(null); }} />
    </div>
  );
}