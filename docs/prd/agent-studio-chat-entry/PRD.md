# PRD: Agent Studio 对话入口 + 轮询循环修复

## 背景

DeepThink Agent PaaS 的 Agent Studio 页面（`/agents`）存在两个问题：

1. **创建 Agent 后无法对话**：用户在 Agent Studio 创建完 Agent 后，页面上没有任何"进入对话"或"测试对话"的入口。唯一与"对话"相关的路径是详情面板中的"绑定的群组"——用户必须手动把 Agent 绑定到一个已存在的 group，再自行去 `/chat` 选该 group 发消息。新建的 Agent 默认未绑定任何 group，因此用户找不到对话入口。

2. **浏览器控制台疯狂 JS 接口请求**：用户打开 `/agents` 页面后，浏览器控制台疯狂刷屏 API 请求。根因是 Agent 详情面板中 `VersionHistorySection` / `ShareSection` / `CollaboratorsSection` 三个子组件的 `onLoad` prop 是父组件每次 render 都重新创建的内联箭头函数，导致子组件 `useEffect(() => { onLoad(); }, [agentId, onLoad])` 因依赖变化无限触发，叠加 store 写操作触发父组件 re-render，形成无限调用循环。

## 目标

- 用户在 Agent Studio 创建完 Agent 后，能一键进入与该 Agent 的对话。
- 消除 `/agents` 页面的无限轮询，控制台不再刷屏。

## 非目标

- 不改动 `/chat` 主聊天页的既有 2s 消息轮询机制（那是设计内的行为，与本次 bug 无关）。
- 不改动 Agent 绑定到既有 group 的 `BoundGroupsSection` 流程（保留作为高级绑定能力）。
- 不重构 Agent PaaS 的数据模型。

## 功能需求

### 需求 1：Agent 测试对话入口

**R1.1** Agent 详情面板顶部（Agent 名称旁）新增"测试对话"按钮。

**R1.2** 点击"测试对话"按钮：
- 调用后端 `POST /api/paas/agents/:id/test-chat` 接口。
- 接口为该 Agent 创建（或复用已存在的）确定性测试 group：
  - `jid = web:agent-test-{agentId}`
  - `folder = agent-test-{agentId}`
  - `name = 测试: {agentName}`
  - `agent_def_id = agentId`
  - `is_home = false`
  - `created_by = 当前用户 ID`
  - 执行模式：admin 用 `host`，普通用户用 `container`
- 接口返回 `{ jid, folder, name }`。
- 前端跳转到 `/chat/{folder}`。

**R1.3** 同一个 Agent 重复点击"测试对话"按钮，复用同一个测试 group（不重复创建），保留对话历史。

**R1.4** 不同 Agent 的测试 group 相互独立，互不干扰。

**R1.5** Agent 被删除时，其测试 group 不自动删除（由用户在 `/chat` 侧边栏自行删除，保持 Surgical Changes 原则，不扩大影响范围）。

### 需求 2：消除无限轮询

**R2.1** 移除 `VersionHistorySection` / `ShareSection` / `CollaboratorsSection` 三个子组件通过 props 接收 `onLoad` 回调的模式。

**R2.2** 三个子组件改为直接从 `useAgentsPaasStore` 获取 `listVersions` / `listShares` / `listCollaborators` 方法，在 `useEffect` 中以 `[agentId, storeMethod]` 作为依赖。Zustand store 方法引用稳定，不会触发无限循环。

## 验收标准

- AC1：在 `/agents` 创建一个新 Agent，详情面板出现"测试对话"按钮。
- AC2：点击"测试对话"按钮，浏览器跳转到 `/chat/agent-test-{agentId}`，可发送消息并收到该 Agent（按其 system prompt / model / mounts）的回复。
- AC3：重复点击同一 Agent 的"测试对话"按钮，进入同一个对话（历史消息保留）。
- AC4：打开 `/agents` 页面，选中一个 Agent，浏览器控制台不再有高频 API 请求（Network 面板里 `/api/paas/agents/{id}/versions|shares|collaborators` 每类只请求一次）。
- AC5：切换不同 Agent，三个子组件各自重新加载一次对应数据，不循环。
- AC6：`make typecheck` 通过，`make test` 通过。
