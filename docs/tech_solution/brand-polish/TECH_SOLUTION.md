# 技术方案 — DeepThink 品牌与体验打磨 (brand-polish)

> 关联 PRD：`docs/prd/brand-polish/PRD.md`
> 分支：`feature/brand-polish`

## 1. 总体策略

四个需求按"文档 → 模板 → 前端配置 → 前端组件 + 后端权限"顺序实施，互不依赖，可并行编码。所有改动遵循 Surgical Changes 原则：只改必要行，不重构周边代码。

## 2. 模块改动详述

### 2.1 品牌宣推文档（需求1）

**新增** `docs/prd/brand-polish/BRAND-INTRO.md`

- 内容：产品定位、五大能力、六端接入、Loop Engineering、数据本地化、产品调性、适用人群、上手步骤
- 不提及底层 SDK / 模型供应商 / 第三方依赖名
- 与 README.md 互补：README 面向开发者（含技术栈、架构），BRAND-INTRO 面向最终用户/合作伙伴

### 2.2 品牌心智模板（需求2）

**修改** `config/global-claude-md.template.md`

当前首段（line 3）：
```
你是 DeepThink，一个自托管的个人 AI Agent。你具备对话交流、文件操作、命令执行、网页浏览、定时任务调度等能力。
```

改为：
```markdown
你是 DeepThink —— 一款自托管的本地 AI Agent 工作站。你能为用户做这些事：

- **对话交流**：自然语言沟通，回答问题、讨论方案、解释概念
- **文件操作**：读写用户电脑上的文件、整理目录、生成文档
- **命令执行**：在终端运行命令、跑测试、操作 git
- **浏览器自动化**：打开网页、点击、填表、截图、抓取内容
- **定时任务**：设置提醒、定期执行脚本、cron 任务
- **Loop Engineering**：从需求 → PRD → 技术方案 → 编码 → 测试 → 提交，闭环交付

## 品牌口径（必须遵守）

被用户问及「你是谁 / 你能干什么 / 你用什么模型 / 你底层用什么实现 / 你是不是基于某某」时，**只回答 DeepThink 的产品功能**，不透露任何底层技术细节：

- ❌ 不说"Claude Agent SDK"、"Claude Code"、"Anthropic"、"基于某某开源项目"
- ❌ 不说模型供应商名称、SDK 名称、CLI 名称
- ❌ 不说"借鉴了 OpenClaw / Cowork"等第三方项目
- ✅ 只说"我是 DeepThink，我能做……"
- ✅ 用产品能力描述自己（对话、文件、命令、浏览器、定时任务、Loop Engineering）
- ✅ 模型相关问题可答："DeepThink 使用先进的大语言模型驱动，模型供应商随版本迭代调整"
```

**为何这样改**：
- 首段从 1 句话扩为能力清单，让 Agent 在被问"能干什么"时有结构化答案
- 新增"品牌口径"段落作为强制行为约束，使用 ❌/✅ 对比让模型易遵循
- 不删除原有"用户信息/偏好/定时任务规则/内部思考"段落（Surgical Changes）

**存量用户处理**：开发环境 `data/groups/` 为空，无存量用户 CLAUDE.md 需要迁移。生产部署时由 `src/index.ts:2695-2723` 的 `ensureUserGlobalClaudeMd` 自动为新用户补齐模板，存量用户保持不动（PRD 风险 R1）。

### 2.3 默认主题色（需求3）

**修改** `web/src/hooks/useTheme.ts`

| 行 | 当前 | 改为 |
|---|---|---|
| 29 | `if (typeof window === 'undefined') return 'orange';` | `return 'neutral';` |
| 32 | `return 'orange';` | `return 'neutral';` |
| 85 | `() => 'orange' as ColorScheme` | `() => 'neutral' as ColorScheme` |
| 109 | `if (s === 'orange') window.localStorage.removeItem(SCHEME_KEY);` | `if (s === 'neutral') window.localStorage.removeItem(SCHEME_KEY);` |

**对称性说明**：原代码的语义是"默认值不写 localStorage，非默认值才落盘"。改默认值为 `neutral` 后，对称地把"不写 localStorage"的条件从 `s === 'orange'` 改为 `s === 'neutral'`，保持语义一致——选 neutral 等于恢复默认，选 orange/default 才落盘。

**CSS 不动**：`web/src/styles/globals.css:217-245` 的 `theme-neutral` 块已存在（`--background: #ffffff`、`--primary: #52525b`），无需新增。

**存量用户**：已落盘 `deepthink-color-scheme=orange` 的老用户保持 orange，本次只改"未设置过"的全新用户的默认。这是合理的——不强行覆盖用户已表达的选择。

### 2.4 报错信息删除（需求4）

#### 2.4.1 前端 — 保留 messageId

**修改** `web/src/components/chat/MessageList.tsx:120-126`

当前：
```ts
if (msg.sender === '__system__') {
  if (msg.content.startsWith('context_overflow:')) {
    items.push({ type: 'message', content: msg });
  } else {
    const resolved = resolveSystemMessage(msg.content);
    items.push({ type: resolved.style, content: resolved.text });  // ← 丢失 messageId
  }
}
```

改为：
```ts
if (msg.sender === '__system__') {
  // 所有系统消息都走 MessageBubble 渲染，统一挂上 MessageContextMenu（含删除入口）
  items.push({ type: 'message', content: msg });
}
```

**为什么直接全部走 MessageBubble**：
- `MessageBubble` 已有 `__system__` + `context_overflow:` 的特殊渲染分支（`:205-228`），把所有 system 消息都引到 MessageBubble 后，需要扩展这个分支让它处理 `agent_error:` / `agent_max_retries:` / `system_error:` / `context_reset:` 等
- 或者更简洁：保留 `resolveSystemMessage` 做文本提取，把 resolved 的文本塞回 msg 副本传给 MessageBubble

选择**方案 B（更简洁）**：在 MessageList 里把 resolved 文本写回 message 副本的 content，type 统一为 `'message'`，让 MessageBubble 用一个统一的"系统消息"分支渲染。

#### 2.4.2 前端 — MessageBubble 系统消息分支

**修改** `web/src/components/chat/MessageBubble.tsx`

当前 `:205-228` 只处理 `context_overflow:`。改为：处理所有 `sender === '__system__'` 的消息，统一渲染为红色 banner（保留现有视觉风格），并挂上 `<MessageContextMenu>`。

伪代码：
```tsx
// 在 context_overflow 分支位置扩展为通用 system message 分支
if (message.sender === '__system__') {
  // 提取展示文本：去掉 'type:' 前缀
  const displayMsg = message.content.replace(/^[a-z_]+:\s*/, '');
  // 根据 prefix 判断严重程度
  const isError = /^(agent_error|agent_max_retries|system_error|context_overflow):/.test(message.content);
  return (
    <div className="mb-6">
      {showTime && <div className="...">...时间 + 系统消息标签...</div>}
      <div className={`... ${isError ? 'red' : 'gray'} banner ...`}>
        ...displayMsg...
      </div>
      {/* 挂上 context menu — 关键新增 */}
      <MessageContextMenu
        content={message.content}
        position={contextMenu!}  // 仅在 contextMenu 非空时渲染
        onClose={() => setContextMenu(null)}
        chatJid={message.chat_jid}
        messageId={message.id}
      />
    </div>
  );
}
```

实际上更稳妥的写法：在 banner 外层包一个带 `onContextMenu`/menu button 的容器，与普通消息一致地调用 `setContextMenu`。参照现有 `:360-368` 的 `<MessageContextMenu>` 挂载方式。

#### 2.4.3 后端 — 删除权限放开

**修改** `src/routes/groups.ts:1421-1427`

当前：
```ts
if (authUser.role !== 'admin') {
  if (msg.is_from_me === 1 || (msg.sender && msg.sender !== authUser.id)) {
    return c.json({ error: 'Permission denied' }, 403);
  }
}
```

改为：
```ts
if (authUser.role !== 'admin') {
  // 系统消息（source='system'）任何用户都可删除——它们是产品状态提示，不属于任何人
  const isSystemMessage = msg.source === 'system';
  if (!isSystemMessage) {
    // 普通消息：AI 消息不能删，用户消息只能删自己发的
    if (msg.is_from_me === 1 || (msg.sender && msg.sender !== authUser.id)) {
      return c.json({ error: 'Permission denied' }, 403);
    }
  }
}
```

**为何这样改**：
- 最小侵入：只加一个 `isSystemMessage` 短路，不动 admin 分支
- 不改 `is_from_me` 字段（系统消息仍为 `true`，不影响其他逻辑如 `normalizeHomeJid` 路由）
- 不改 `sender` 字段（仍为 `__system__`，前端识别不变）
- 只放宽 `source='system'` 这一窄条件，普通 AI 回复（`source='agent'` 等）的权限规则保持不变

**`source` 字段确认**：`src/index.ts:1271` 的 `sendSystemMessage` 调用 `storeMessageDirect(..., 'system', ...)`，第四参数 source 为 `'system'`。后端可直接读 `msg.source`。

#### 2.4.4 数据层 — 真删确认

`src/db.ts:4689-4694` 的 `deleteMessage` 是 `DELETE FROM messages`，物理删除。删除后无残留，刷新页面不会回来。本期不改为软删（PRD 风险 R2 不在本期范围）。

## 3. 改动清单

| 文件 | 类型 | 行数变化 |
|---|---|---|
| `docs/prd/brand-polish/BRAND-INTRO.md` | 新增 | +约 80 行 |
| `docs/prd/brand-polish/PRD.md` | 新增 | +约 100 行（已写） |
| `docs/tech_solution/brand-polish/TECH_SOLUTION.md` | 新增 | +本文件 |
| `docs/test_report/brand-polish/TEST_REPORT.md` | 新增 | 待写 |
| `config/global-claude-md.template.md` | 修改 | +约 20 行 |
| `web/src/hooks/useTheme.ts` | 修改 | 4 行替换 |
| `web/src/components/chat/MessageList.tsx` | 修改 | 5 行 → 1 行 |
| `web/src/components/chat/MessageBubble.tsx` | 修改 | 扩展 1 分支 + 挂 menu |
| `src/routes/groups.ts` | 修改 | +5 行 |

## 4. 验证策略

| 验证项 | 命令 / 方式 | 通过标准 |
|---|---|---|
| TypeScript 类型 | `make typecheck` | 0 error |
| 约束测试 | `make test` | 全绿 |
| 默认主题色 | 浏览器无痕窗口打开 web | 背景为 `#ffffff` |
| 报错删除 E2E | 启动 dev，触发 `agent_error`（如关闭容器/超时） | 右键报错信息可见菜单 → 删除 → 消息消失 |
| 非 admin 删除 | 用 member 账号调 `DELETE /api/groups/:jid/messages/:id`（系统消息 id） | 200 success |
| 品牌口径 | 注册新用户，问 Agent "你是谁/用什么模型" | 不出现 "Claude"/"Anthropic"/"SDK" 字样 |

## 5. 回滚策略

所有改动在 `feature/brand-polish` 分支，未合并前可整体 `git checkout main` 回滚。合并后如需回滚，单 commit revert 即可（改动量小、文件少）。

## 6. 不做的事

- 不动 `theme-orange` / `theme-default` 配色 CSS
- 不动 `MessageBubble` 普通消息分支
- 不动 `deleteMessage` 的物理删除语义
- 不动 `sendSystemMessage` 的字段写入
- 不动存量用户 `data/groups/user-global/*/CLAUDE.md`（开发环境无此目录）
- 不动 `desktop/src/backend-supervisor.ts:60` 的 `ASSISTANT_NAME` env（已是 'DeepThink'）
