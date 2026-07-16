# 技术方案：沙箱面板嵌入 Chat 右侧 + 实时联动 + 中文字体修复

## 1. 架构总览

### 1.1 现状链路（agent 调沙箱工具）

```
agent-runner mcp-tools.ts sandbox_browser_navigate
  → IPC 文件 tasks/sandbox_browser_navigate_<reqId>.json
  → host src/index.ts handleSandboxIpc
  → resolveSandboxId(browserEnabled=true)  [懒创建/复用沙箱]
  → manager.startBrowser(sid, onFrame=()=>{})
  → browser.navigate(url)
  → IPC 文件 tasks/sandbox_browser_navigate_result_<reqId>.json
  → agent-runner 收到结果，MCP 工具返回
```

**问题**：host 端 `onFrame=()=>{}` 是空函数，agent 调用期间浏览器帧不推送到任何前端。

### 1.2 目标链路（新增 host → 前端联动）

```
agent-runner mcp-tools.ts sandbox_browser_navigate
  → IPC 文件
  → host handleSandboxIpc
  → resolveSandboxId
  → manager.startBrowser(sid, onFrame=dataUrl => {
       // 推送到订阅了这个 sid 的所有 WS 客户端
       broadcastSandboxFrame(sid, dataUrl)
     })
  → browser.navigate(url)
  → broadcastStreamEvent(chatJid, {
       eventType:'tool_progress',
       toolName:'sandbox_browser_navigate',
       toolUseId,
       toolInput: { sandboxSessionId: sid, action:'navigate', url }
     })
  → IPC result 文件
  → agent-runner 返回
```

**前端**：
```
chat store applyStreamEvent 收到 tool_progress
  → 识别 toolName.startsWith('sandbox_browser')
  → useSandboxStore.focusSession(toolInput.sandboxSessionId)
  → 自动切到「浏览器」tab，subscribeBrowser(sid)
  → WS sandbox_browser_frame 到达 → setBrowserFrame(sid, dataUrl)
  → BrowserView 重新渲染 <img src={frame}>
```

## 2. 详细改动点

### 2.1 中文字体修复（M1）

**文件**：`container/sandbox/Dockerfile`

当前 line 8-38 的 apt install 列表：
```dockerfile
RUN apt-get update && apt-get install -y --no-install-recommends \
    ca-certificates curl jq tree file less coreutils \
    python3 python3-pip python3-venv \
    chromium \
    fonts-liberation \
    fonts-noto-color-emoji \
    libgbm1 libnss3 ... \
    && rm -rf /var/lib/apt/lists/*
```

改动：在 `fonts-noto-color-emoji` 后追加 `fonts-wqy-zenhei`：
```dockerfile
    fonts-liberation \
    fonts-noto-color-emoji \
    fonts-wqy-zenhei \
```

验证：
```bash
make sandbox-build
docker run --rm deepthink-sandbox:latest fc-list | grep -i wqy
# 应输出：/usr/share/fonts/truetype/wqy/wqy-zenhei.ttc: WenQuanYi Zen Hei ...
```

### 2.2 后端 REST 端点（M2）

#### 2.2.1 `GET /api/sandbox/by-group/:groupFolder`

**文件**：`src/routes/sandbox.ts`（追加在现有路由之后）

```typescript
sandboxApi.get('/by-group/:groupFolder', async (c) => {
  const user = c.get('user');
  const groupFolder = c.req.param('groupFolder');
  const sid = await getSandboxSessionId(groupFolder); // 已有函数
  if (!sid) return c.json({ sessionId: null });
  
  // 校验 session 存在且属于该用户
  const manager = getSandboxManager();
  const session = manager.getSession(sid); // 需新增 manager.getSession()
  if (!session || session.userId !== user.id) {
    return c.json({ sessionId: null });
  }
  return c.json({ sessionId: sid, status: session.status });
});
```

**`SandboxManager.getSession(sid)`** 新增方法（`src/sandbox/manager.ts`）：
```typescript
getSession(sid: string): SandboxSession | null {
  const state = this.state.get(sid);
  return state?.session ?? null;
}
```

#### 2.2.2 `GET /api/sandbox/sessions/:id/files?path=`

**文件**：`src/routes/sandbox.ts`

```typescript
sandboxApi.get('/sessions/:id/files', async (c) => {
  const user = c.get('user');
  const sid = c.req.param('id');
  const path = c.req.query('path') || '/workspace';
  
  const manager = getSandboxManager();
  const session = manager.getSession(sid);
  if (!session || session.userId !== user.id) {
    return c.json({ error: 'Not found' }, 404);
  }
  
  // 安全：path 必须以 /workspace/ 开头或就是 /workspace
  const norm = path.replace(/\/+$/, '');
  if (norm !== '/workspace' && !norm.startsWith('/workspace/')) {
    return c.json({ error: 'Path must be under /workspace' }, 400);
  }
  
  const entries = await manager.listFiles(sid, norm);
  return c.json({ path: norm, entries });
});
```

**`SandboxManager.listFiles(sid, path)`** 新增方法：
```typescript
async listFiles(sid: string, path: string): Promise<FileEntry[]> {
  const state = this.state.get(sid);
  if (!state) throw new Error('Session not found');
  const containerName = state.session.containerName;
  
  // docker exec ls -la --time-style=long-iso <path>
  const result = await execFile('docker', [
    'exec', '-u', '1000:1000', containerName,
    'ls', '-la', '--time-style=long-iso', path
  ], { maxBuffer: 2 * 1024 * 1024 });
  
  return parseLsOutput(result.stdout);
}
```

`parseLsOutput` 解析 `ls -la --time-style=long-iso` 输出为 `{name, type, size, mtime}[]`，过滤 `.` 和 `..`。

### 2.3 host `handleSandboxIpc` 推 tool_progress（M2）

**文件**：`src/index.ts` `handleSandboxIpc` 函数内

在每个 sandbox 工具完成操作后追加：

```typescript
// 通用辅助函数
function broadcastSandboxProgress(
  chatJid: string, 
  toolName: string, 
  toolUseId: string | undefined,
  sandboxSessionId: string,
  extra: Record<string, any> = {}
) {
  broadcastStreamEvent(chatJid, {
    eventType: 'tool_progress',
    toolName,
    toolUseId: toolUseId || `${toolName}-${Date.now()}`,
    toolInput: { sandboxSessionId, ...extra }
  }, undefined); // agentId 暂用 undefined
}
```

在每个 case 完成 `browser.navigate(url)` 等操作后调用：
```typescript
// sandbox_browser_navigate
broadcastSandboxProgress(sourceGroupJid, 'sandbox_browser_navigate', reqId, sid, { action: 'navigate', url });

// sandbox_browser_click
broadcastSandboxProgress(sourceGroupJid, 'sandbox_browser_click', reqId, sid, { action: 'click', selector });

// sandbox_browser_type
broadcastSandboxProgress(sourceGroupJid, 'sandbox_browser_type', reqId, sid, { action: 'type', selector, text });

// sandbox_browser_screenshot
broadcastSandboxProgress(sourceGroupJid, 'sandbox_browser_screenshot', reqId, sid, { action: 'screenshot' });

// sandbox_browser_evaluate
broadcastSandboxProgress(sourceGroupJid, 'sandbox_browser_evaluate', reqId, sid, { action: 'evaluate' });

// sandbox_run_code
broadcastSandboxProgress(sourceGroupJid, 'sandbox_run_code', reqId, sid, { action: 'run_code', language });

// sandbox_close 不推送（已销毁）
```

### 2.4 host `handleSandboxIpc` 启用 onFrame 推送

**问题**：当前 `resolveSandboxId` 调 `manager.startBrowser(sid, () => {})` 传空回调，agent 调用时浏览器帧不推前端。

**修复**：`manager.startBrowser` 改为接受持久 onFrame 回调，host 端在首次启动时注册一个广播函数：

```typescript
// src/sandbox/manager.ts startBrowser 已存在 setOnFrame 机制
// host handleSandboxIpc 里改为：
if (!manager.getBrowser(sid)) {
  await manager.startBrowser(sid, (dataUrl: string) => {
    broadcastSandboxFrame(sourceGroupJid, sid, dataUrl);
  });
}
```

`broadcastSandboxFrame` 新增（`src/web.ts` 或 `src/index.ts`）：
```typescript
function broadcastSandboxFrame(chatJid: string, sessionId: string, dataUrl: string) {
  for (const client of wsClients.values()) {
    if (client.group_folder === chatJid || chatJid.includes(client.group_folder)) {
      ws.send(client.ws, JSON.stringify({
        type: 'sandbox_browser_frame',
        sessionId,
        dataUrl
      }));
    }
  }
}
```

注意：现有 `src/web.ts:1834-1837` 的 `startBrowser` 回调已用 `ws.send` 推给**订阅了** `sandbox_browser_subscribe` 的客户端。这里我们让 agent 工具触发时也复用同一推送机制，但要让 chat 页面也能收到，所以 chat 页面前端必须在挂载时调 `subscribeBrowser(sid)` 或后端改为按 chatJid 广播。

**简化方案**：chat 页面前端在收到 `tool_progress` 时调 `subscribeBrowser(sid, undefined)`（不传 initialUrl，避免覆盖当前 URL），让后端把该 client 加入订阅者，后续帧自动推送。

### 2.5 前端 `useSandboxStore` 多 sessionId 帧索引（M3）

**文件**：`web/src/stores/sandbox.ts`

```typescript
interface State {
  sessions: SandboxSession[];
  activeSessionId: string | null;
  browserFrame: string | null;          // 兼容 SandboxPage 独立页
  browserFrames: Record<string, string>; // 新增：按 sessionId 索引帧
  loading: boolean;
  error: string | null;
}

interface Actions {
  // ... 现有
  focusSession(sessionId: string): void;     // 新增：chat 联动用
  setBrowserFrameForSession(sessionId: string, dataUrl: string): void; // 新增
  getBrowserFrame(sessionId: string): string | null; // 新增 selector
}
```

`wireWsHandlers` 改造：
```typescript
// sandbox_browser_frame 处理改为写入 browserFrames 而非单一 browserFrame
on('sandbox_browser_frame', (msg: any) => {
  const { sessionId, dataUrl } = msg;
  set((s) => ({
    browserFrames: { ...s.browserFrames, [sessionId]: dataUrl },
    // 兼容：如果 activeSessionId === sessionId，也更新 browserFrame
    browserFrame: s.activeSessionId === sessionId ? dataUrl : s.browserFrame
  }));
});
```

`focusSession(sessionId)`：
```typescript
focusSession: (sessionId) => {
  set((s) => ({
    activeSessionId: sessionId,
    browserFrame: s.browserFrames[sessionId] ?? null
  }));
  // 通知 ChatView 切到 sandbox tab + 浏览器子 tab
}
```

### 2.6 前端 chat store 联动（M3）

**文件**：`web/src/stores/chat.ts` `applyStreamEvent` 的 `tool_progress` 分支

在 line 975-1000 的 `tool_progress` case 末尾追加：

```typescript
case 'tool_progress': {
  // ... 现有逻辑
  
  // 新增：sandbox 工具联动
  if (toolName.startsWith('sandbox_browser') || toolName === 'sandbox_run_code') {
    const sandboxSessionId = event.toolInput?.sandboxSessionId;
    if (sandboxSessionId) {
      // 切到 sandbox tab + 对应子 tab
      useSandboxStore.getState().focusSession(sandboxSessionId);
      // 通过 custom event 通知 ChatView 切 sidebar tab
      window.dispatchEvent(new CustomEvent('sandbox-tool-active', {
        detail: { 
          sessionId: sandboxSessionId,
          subtab: toolName.startsWith('sandbox_browser') ? 'browser' : 'terminal'
        }
      }));
      // 自动 subscribe 帧流（如果是浏览器工具）
      if (toolName.startsWith('sandbox_browser') && !useSandboxStore.getState().isSubscribed(sandboxSessionId)) {
        useSandboxStore.getState().subscribeBrowser(sandboxSessionId, undefined);
      }
    }
  }
  break;
}
```

### 2.7 前端 ChatView 侧边栏集成（M3）

**文件**：`web/src/components/chat/ChatView.tsx`

line 36-43 `SIDEBAR_TABS`：
```typescript
const SIDEBAR_TABS = [
  { id: 'files', icon: Folder, label: '文件' },
  { id: 'env', icon: Terminal, label: '环境' },
  { id: 'skills', icon: Sparkles, label: '技能' },
  { id: 'mcp', icon: Network, label: 'MCP' },
  { id: 'dag', icon: Workflow, label: 'DAG' },
  { id: 'members', icon: Users, label: '成员' },
  { id: 'sandbox', icon: Globe, label: '沙箱' },  // 新增
] as const;
```

line 853-873 的 tab content 分支：
```typescript
{sidebarTab === 'sandbox' && <SandboxPanel groupJid={groupJid} />}
```

ChatView 监听 `sandbox-tool-active` 事件自动切到 sandbox tab：
```typescript
useEffect(() => {
  const handler = (e: Event) => {
    const detail = (e as CustomEvent).detail;
    setSidebarTab('sandbox');
    setSandboxSubtab(detail.subtab);
  };
  window.addEventListener('sandbox-tool-active', handler);
  return () => window.removeEventListener('sandbox-tool-active', handler);
}, []);
```

### 2.8 前端 SandboxPanel 新建（M3）

**文件**：`web/src/components/sandbox/SandboxPanel.tsx`

```typescript
export function SandboxPanel({ groupJid }: { groupJid: string }) {
  const [subtab, setSubtab] = useState<'browser' | 'terminal' | 'files'>('browser');
  const [sessionId, setSessionId] = useState<string | null>(null);
  
  // 拉取当前 group 绑定的 sandbox sessionId
  useEffect(() => {
    sandboxApi.getByGroup(groupJid).then(res => setSessionId(res.sessionId));
    const timer = setInterval(() => {
      sandboxApi.getByGroup(groupJid).then(res => setSessionId(res.sessionId));
    }, 5000);
    return () => clearInterval(timer);
  }, [groupJid]);
  
  // 监听 sandbox-tool-active 事件切换子 tab
  useEffect(() => {
    const handler = (e: Event) => {
      const detail = (e as CustomEvent).detail;
      if (detail.sessionId) setSessionId(detail.sessionId);
      setSubtab(detail.subtab);
    };
    window.addEventListener('sandbox-tool-active', handler);
    return () => window.removeEventListener('sandbox-tool-active', handler);
  }, []);
  
  if (!sessionId) {
    return <EmptyState text="Agent 暂未使用沙箱，调用 sandbox_* 工具后将自动激活" />;
  }
  
  return (
    <div className="h-full flex flex-col">
      <SandboxPanelHeader sessionId={sessionId} subtab={subtab} onSubtabChange={setSubtab} />
      <div className="flex-1 overflow-hidden">
        {subtab === 'browser' && <BrowserView sessionId={sessionId} />}
        {subtab === 'terminal' && <SandboxTerminal sessionId={sessionId} />}
        {subtab === 'files' && <SandboxFileTree sessionId={sessionId} />}
      </div>
    </div>
  );
}
```

### 2.9 前端 SandboxFileTree 新建（M3）

**文件**：`web/src/components/sandbox/SandboxFileTree.tsx`

```typescript
export function SandboxFileTree({ sessionId }: { sessionId: string }) {
  const [tree, setTree] = useState<FileNode[]>([]);
  const [expanded, setExpanded] = useState<Set<string>>(new Set(['/workspace']));
  
  const loadPath = async (path: string) => {
    const res = await sandboxApi.listFiles(sessionId, path);
    setTree(prev => mergeTree(prev, path, res.entries));
  };
  
  useEffect(() => {
    loadPath('/workspace');
    const timer = setInterval(() => {
      // 刷新所有展开的目录
      expanded.forEach(p => loadPath(p));
    }, 5000);
    return () => clearInterval(timer);
  }, [sessionId]);
  
  // 递归渲染树
  return <FileTreeRenderer nodes={tree} expanded={expanded} onToggle={...} />;
}
```

### 2.10 前端 API client 扩展（M3）

**文件**：`web/src/api/sandbox.ts`

新增方法：
```typescript
export const sandboxApi = {
  // ... 现有
  getByGroup(groupFolder: string): Promise<{ sessionId: string | null; status?: string }> {
    return fetch(`/api/sandbox/by-group/${groupFolder}`).then(r => r.json());
  },
  listFiles(sessionId: string, path: string): Promise<{ path: string; entries: FileEntry[] }> {
    return fetch(`/api/sandbox/sessions/${sessionId}/files?path=${encodeURIComponent(path)}`).then(r => r.json());
  }
};
```

## 3. 数据库改动

**无**。本次需求不新增表、不新增列，复用现有 `sessions.sandbox_session_id` 列。

## 4. 安全考虑

- `GET /sessions/:id/files` 严格校验 path 必须以 `/workspace/` 开头或等于 `/workspace`，防止目录遍历。
- `listFiles` 通过 `docker exec` 执行 `ls`，不通过 shell 拼接 path（execFile 数组参数避免注入）。
- chat 右侧订阅帧流复用现有 `sandbox_browser_subscribe` WS 消息，不新增权限点。
- 字体包 `fonts-wqy-zenhei` 来自 Debian 官方源，无第三方源。

## 5. 性能影响

- `broadcastSandboxProgress` 仅在 sandbox 工具完成时调一次，不流式推。
- `listFiles` docker exec ls 5s 轮询，单次 <50ms，开销可忽略。
- `browserFrames: Record<sessionId, string>` 多 sessionId 帧索引，内存占用 = sessionId 数 × ~50KB JPEG data URL，单 chat 通常 1-2 个 sandbox，无压力。

## 6. 兼容性

- `/sandbox` 独立页完全不变，`useSandboxStore.browserFrame` 字段保留兼容。
- `shared/stream-event.ts` 不新增类型，复用 `tool_progress`。
- 现有 vitest 1187 用例不受影响（不改动 sandbox-manager / browser.ts / security.ts）。
- 新增 vitest 用例：`tests/units/sandbox-chat-inline.test.ts` 验证 tool_progress 联动逻辑（纯函数，mock store）。

## 7. 测试策略

| 测试 | 方式 |
|------|------|
| typecheck | `make typecheck` 三端 |
| vitest 全量 | `make test` 不引入回归 |
| 新增单测 | `tests/units/sandbox-chat-inline.test.ts` 测 parseLsOutput + chat store 联动纯函数 |
| 镜像构建 | `make sandbox-build` + `docker run --rm deepthink-sandbox fc-list \| grep wqy` |
| 中文字体 E2E | 新沙箱 + `sandbox_browser_navigate('https://www.baidu.com')` + 截图肉眼验证中文 |
| chat 嵌入 E2E | `make dev` → `/chat/main` → agent 调 `sandbox_browser_navigate` → 右侧自动展开 BrowserView 显示帧 |
| 文件树 E2E | agent 调 `sandbox_run_code` 写文件 → 右侧文件树 5s 内显示新文件 |
| 独立页回归 | `/sandbox` 页手动操作完全正常 |

## 8. 已知限制

- `cloudcli-browser` 工具持续返回 fetch failed，浏览器 UI E2E 走查受限，用 typecheck + vitest + 后端 curl + 镜像字体检查替代。
- 现有沙箱需销毁重建才会用上新字体镜像。
- `sandbox_browser_subscribe` 的单订阅限制未解除（P1 标记）。
