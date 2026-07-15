# 测试报告: Agent Studio 对话入口 + 轮询循环修复

## 测试范围

| 模块 | 验证方式 | 结果 |
|------|---------|------|
| 后端 `POST /api/paas/agents/:id/test-chat` | curl + sqlite3 + 文件系统 | ✅ 通过 |
| 前端 store `testChat` 方法 | typecheck | ✅ 通过 |
| 前端"测试对话"按钮 + 路由跳转 | typecheck + 代码 review | ✅ 通过 |
| 前端轮询循环修复 | typecheck + 代码 review | ✅ 通过 |
| 回归约束测试 | vitest (90 文件 / 1180 用例) | ✅ 全部通过 |
| 三端类型检查 | make typecheck | ✅ 通过 |

## 测试详情

### T1: 后端 test-chat 接口（curl + db + 文件系统）

**前置**：重启后端加载新路由（tsx watch 未热重载新路由，手动重启 `npx tsx watch src/index.ts`）。

**T1.1 创建/复用测试 group**

```
POST /api/paas/agents/58f7baac-258d-48de-9790-672257b61a23/test-chat
→ 200 {"jid":"web:agent-test-58f7baac-258d-48de-9790-672257b61a23",
       "folder":"agent-test-58f7baac-258d-48de-9790-672257b61a23",
       "name":"测试: AI Agent 面试题设计和100分答案解析助手"}
```

**T1.2 重复调用复用同一 group**

第二次调用返回相同 `folder`，`reuse same folder? true`，不重复创建。

**T1.3 db 记录验证**

```
registered_groups:
  jid=web:agent-test-58f7baac-...
  folder=agent-test-58f7baac-...
  name=测试: AI Agent 面试题设计和100分答案解析助手
  agent_def_id=58f7baac-258d-48de-9790-672257b61a23  ✓ 绑定正确
  created_by=4a334c6a-5c76-4aeb-8a74-e0eedd6334c3     ✓ 当前用户
  is_home=0                                            ✓ 非主容器
  execution_mode=host                                  ✓ admin 用 host

chats: jid=web:agent-test-58f7baac-... 已创建          ✓

group_members: group_folder=agent-test-58f7baac-... user_id=4a334c6a-... role=owner ✓
```

**T1.4 工作目录验证**

```
data/groups/agent-test-58f7baac-258d-48de-9790-672257b61a23/ 已创建（空目录）
```

**T1.5 边界：不存在的 agent**

```
POST /api/paas/agents/nonexistent-id/test-chat
→ 404 {"error":"Agent not found"}
```

**T1.6 边界：未认证**

无 cookie 调用 → 401 `{"error":"Unauthorized"}`（authMiddleware 生效）。

### T2: 前端"测试对话"按钮（代码 review）

**T2.1 按钮位置**：`AgentStudioPage.tsx` 详情面板顶部，Agent 名称 + 描述右侧，"已启用/已禁用"按钮左侧。flex 布局，`shrink-0` 防止挤压。

**T2.2 点击逻辑**：
```tsx
onClick={async () => {
  const res = await testChat(selected.id);
  if (res) navigate(`/chat/${res.folder}`);
  else toast.error('启动对话失败');
}}
```
调用 store `testChat` → 后端 `POST /test-chat` → 拿到 folder → `useNavigate` 跳转 `/chat/{folder}`。失败弹 toast。

**T2.3 typecheck 通过**，无类型错误。

### T3: 轮询循环修复（代码 review）

**根因**：原 `VersionHistorySection` / `ShareSection` / `CollaboratorsSection` 的 `onLoad` prop 是父组件每次 render 重新创建的内联箭头函数，导致子组件 `useEffect(() => { onLoad(); }, [agentId, onLoad])` 因 `onLoad` 引用变化无限触发 → 疯狂调 API → store 状态变化 → 父组件 re-render → 新 `onLoad` → 循环。

**修复**：三个子组件改为直接从 `useAgentsPaasStore` 获取 store 方法（`listVersions` / `listShares` / `listCollaborators`），`useEffect` 依赖改为 `[agentId, storeMethod]`。Zustand `create()` 闭包内的 store 方法引用永久稳定，`useEffect` 只在 `agentId` 变化（切换 Agent）时触发一次。

**验证**：
- `grep -n "onLoad" web/src/pages/AgentStudioPage.tsx` → 无结果（✓ 完全移除）
- typecheck 通过（✓ 类型正确）
- 代码模式符合 React + Zustand 最佳实践（✓）

### T4: 回归测试

```
make typecheck  → ✓ 三端通过（后端 + 前端 + agent-runner + StreamEvent 同步校验）
make test       → ✓ 90 文件 / 1180 用例全部通过
```

### T5: 已知限制

- **浏览器 UI E2E 不可用**：`cloudcli-browser` MCP 工具持续返回 "fetch failed"（环境问题，与代码无关）。前端"测试对话"按钮的点击 → 跳转 → 发消息流程未能用浏览器走查，改用 typecheck + 代码 review + 后端 curl 替代验证。建议用户自测：`make dev` → `/agents` → 选 Agent → 点"测试对话" → 确认跳转到 `/chat/agent-test-{id}` → 发消息验证回复 + 观察 Network 面板 versions/shares/collaborators 每类只请求一次。

## 结论

两个 bug 均已修复：

1. **对话入口**：Agent 详情面板顶部新增"测试对话"按钮，后端 `POST /api/paas/agents/:id/test-chat` 为 Agent 创建/复用确定性测试 group（`web:agent-test-{agentId}`）并绑定 `agent_def_id`，前端跳转 `/chat/{folder}` 即可对话。curl 验证接口 200、db 记录完整、工作目录已创建、复用逻辑正确、边界（不存在 agent / 未认证）处理正确。

2. **无限轮询**：三个子组件（VersionHistorySection / ShareSection / CollaboratorsSection）从 store 直取方法替代内联 `onLoad` prop，消除 `useEffect` 依赖无限变化，控制台不再刷屏。

typecheck + vitest 全部通过，改动范围控制在 3 个源文件（后端 1 + 前端 2），符合 Surgical Changes 原则。
