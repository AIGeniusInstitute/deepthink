// Per-workspace last-active sub-conversation memory.
// When the user re-enters a workspace via sidebar/URL without `?agent=`,
// ChatView consults this map to auto-restore the previous tab.
// Entries are cleared by `selectTab(null)` (explicit return to main).

const STORAGE_KEY = 'deepthink-workspace-last-agent';

function safeStorage(): Storage | null {
  try {
    return typeof localStorage === 'undefined' ? null : localStorage;
  } catch {
    return null;
  }
}

function readMap(): Record<string, string> {
  const ls = safeStorage();
  if (!ls) return {};
  try {
    const raw = ls.getItem(STORAGE_KEY);
    if (!raw) return {};
    const parsed = JSON.parse(raw);
    return parsed && typeof parsed === 'object' && !Array.isArray(parsed) ? parsed : {};
  } catch {
    return {};
  }
}

function writeMap(map: Record<string, string>): void {
  const ls = safeStorage();
  if (!ls) return;
  try {
    if (Object.keys(map).length === 0) {
      ls.removeItem(STORAGE_KEY);
    } else {
      ls.setItem(STORAGE_KEY, JSON.stringify(map));
    }
  } catch {
    /* quota exceeded — ignore */
  }
}

export function getWorkspaceLastAgent(jid: string): string | null {
  return readMap()[jid] || null;
}

export function setWorkspaceLastAgent(jid: string, agentId: string | null): void {
  const map = readMap();
  if (agentId) {
    map[jid] = agentId;
  } else {
    delete map[jid];
  }
  writeMap(map);
}
