# 技术方案: Agent Studio 对话入口 + 轮询循环修复

## 一、问题根因分析

### 1.1 无对话入口

`web/src/pages/AgentStudioPage.tsx` 详情面板依次包含：启用切换、System Prompt、model/max_turns、`MountsSection`、`BoundGroupsSection`、`ShareSection`、`CollaboratorsSection`、`VersionHistorySection`。**完全没有"进入对话"按钮**。

DeepTalk 的对话目标只能是 group（`/chat/:groupFolder?`）。Agent（AgentDefinition）通过 `registered_groups.agent_def_id` 字段绑定到 group，`container-runner.ts:resolveAgentOverride`（970-986 行）在启动容器/进程时读取 agent 定义，覆盖默认 system prompt / model / mounts。

当前唯一路径：用户在 `BoundGroupsSection` 手动选一个已有 group 绑定，再去 `/chat` 选该 group。新建 Agent 未绑定，故无入口。

### 1.2 无限轮询根因

```tsx
// AgentStudioPage.tsx:255-263（VersionHistorySection 调用）
<VersionHistorySection
  agent={selected}
  versions={versions[selected.id] ?? []}
  onLoad={() => { void listVersions(selected.id); }}  // ← 内联箭头函数
  ...
/>

// VersionHistorySection 内部
useEffect(() => { onLoad(); }, [agent.id, onLoad]);  // ← onLoad 每次新引用 → 无限触发
```

**循环链路**：
1. `onLoad` 内联箭头函数，父组件每次 render 重新创建 → 引用变化
2. 子组件 `useEffect` 依赖 `onLoad` → 重新触发
3. `listVersions` → `set({ versions: {...} })` → store 状态变化
4. `useAgentsPaasStore()` 解构整个 store → 任何状态变化触发 `AgentStudioPage` re-render
5. 回到第 1 步 → **无限循环**

`ShareSection`（566 行 `useEffect(() => { onLoad(); }, [agentId, onLoad])`）和 `CollaboratorsSection`（642 行同样模式）同理。三个子组件叠加，每秒数十次 API 请求，控制台刷屏。

## 二、修复方案

### 2.1 Bug 2 修复（轮询，前端 only）

**策略**：子组件直接从 store 取方法，不走 props。

`VersionHistorySection` 改为：
```tsx
function VersionHistorySection({ agent, versions, onRestore, onDiff, showAll, onToggleShow }) {
  const listVersions = useAgentsPaasStore((s) => s.listVersions);
  useEffect(() => { void listVersions(agent.id); }, [agent.id, listVersions]);
  // ...
}
```

`listVersions` 是 Zustand store 方法，`create()` 闭包内定义，引用永久稳定，`useEffect` 只在 `agent.id` 变化时触发一次。

`ShareSection` / `CollaboratorsSection` 同理：`listShares` / `listCollaborators` 从 store 取。

**改动范围**：仅 `AgentStudioPage.tsx` 一个文件，删除三个子组件的 `onLoad` prop + 改为 store 直取。

### 2.2 Bug 1 修复（对话入口）

#### 2.2.1 后端新增接口

**文件**：`src/routes/paas-agents.ts`

**路由**：`POST /api/paas/agents/:id/test-chat`

**逻辑**：
```ts
paasAgentsRoute.post('/:id/test-chat', (c) => {
  const user = c.get('user');
  const agentId = c.req.param('id');
  const def = getAgentDefinition(agentId, user.id);  // 校验 ownership + 存在
  if (!def) return c.json({ error: 'Agent not found' }, 404);
  if (!def.enabled) return c.json({ error: 'Agent is disabled' }, 400);

  const jid = `web:agent-test-${agentId}`;
  const folder = `agent-test-${agentId}`;
  const name = `测试: ${def.name}`;

  // 查找或创建
  const existing = getRegisteredGroup(jid);
  if (existing) {
    // 已存在：确保 agent_def_id 绑定正确（用户可能改过 agent 后重新进入）
    if (existing.agentDefId !== agentId) {
      setRegisteredGroup(jid, { ...existing, agentDefId: agentId, name });
    }
    // 更新内存缓存
    const deps = getWebDeps();
    if (deps) deps.getRegisteredGroups()[jid] = getRegisteredGroup(jid)!;
    return c.json({ jid, folder: existing.folder, name });
  }

  // 不存在：创建
  const isAdmin = user.role === 'admin';
  const now = new Date().toISOString();
  const group: RegisteredGroup = {
    name,
    folder,
    added_at: now,
    executionMode: isAdmin ? 'host' : 'container',
    created_by: user.id,
    agentDefId: agentId,
  };
  setRegisteredGroup(jid, group);
  ensureChatExists(jid);
  updateChatName(jid, name);
  addGroupMember(folder, user.id, 'owner', user.id);

  // 创建工作目录
  const groupDir = path.join(GROUPS_DIR, folder);
  fs.mkdirSync(groupDir, { recursive: true });

  // 更新内存缓存
  const deps = getWebDeps();
  if (deps) deps.getRegisteredGroups()[jid] = group;

  return c.json({ jid, folder, name });
});
```

**复用现有函数**：
- `getAgentDefinition(id, userId)`：校验 ownership
- `getRegisteredGroup(jid)` / `setRegisteredGroup(jid, group)`：db 读写
- `ensureChatExists(jid)` / `updateChatName(jid, name)`：chat 记录
- `addGroupMember(folder, userId, role, addedBy)`：成员关系
- `getWebDeps()`：拿内存缓存引用

**路径**：`GROUPS_DIR`（`src/config.ts:33`）= `data/groups/`

#### 2.2.2 前端 store 新增方法

**文件**：`web/src/stores/agents-paas.ts`

```ts
testChat: async (agentId) => {
  try {
    const res = await api.post<{ jid: string; folder: string; name: string }>(
      `/api/paas/agents/${agentId}/test-chat`
    );
    return res;
  } catch {
    return null;
  }
},
```

#### 2.2.3 前端详情面板新增按钮

**文件**：`web/src/pages/AgentStudioPage.tsx`

在详情面板顶部（Agent 名称 + 启用切换按钮那一行）新增"测试对话"按钮：
```tsx
import { useNavigate } from 'react-router-dom';
// ...
const navigate = useNavigate();
const testChat = useAgentsPaasStore((s) => s.testChat);
// ...
<Button
  size="sm"
  onClick={async () => {
    const res = await testChat(selected.id);
    if (res) navigate(`/chat/${res.folder}`);
    else toast.error('启动对话失败');
  }}
>
  <MessageSquare className="size-4 mr-1" /> 测试对话
</Button>
```

## 三、改动文件清单

| 文件 | 改动 |
|------|------|
| `src/routes/paas-agents.ts` | 新增 `POST /:id/test-chat` 接口 |
| `web/src/stores/agents-paas.ts` | 新增 `testChat` 方法 + 接口类型 |
| `web/src/pages/AgentStudioPage.tsx` | 详情面板加"测试对话"按钮；三个子组件（VersionHistorySection / ShareSection / CollaboratorsSection）移除 `onLoad` prop，改为从 store 直取方法 |

**不改动**：`container-runner.ts`（已有 `resolveAgentOverride` 逻辑直接复用）、`groups.ts`（不碰既有 group CRUD）、`/chat` 路由（folder 作为对话目标已支持）。

## 四、测试策略

- **typecheck**：`make typecheck` 三端类型检查通过。
- **vitest**：`make test` 既有约束测试不回归。
- **后端 curl**：创建 Agent → 调 test-chat 接口 → 验证返回 folder + db 中 registered_groups 记录 + 工作目录存在。
- **前端 UI**：`make dev` 启动，`/agents` 页面：创建 Agent → 点击"测试对话" → 跳转到 `/chat/agent-test-{id}` → 发消息验证回复；Network 面板观察 versions/shares/collaborators 每类只请求一次。
- **已知限制**：浏览器 E2E（cloudcli-browser）不可用，前端验证用 typecheck + 构建 + 代码 review + 后端 curl + 手动浏览器走查（用户自测）替代。
