# Issue: 运行轨迹卡片消失 + 执行概览 + PDF 导出

**日期**: 2026-09-17
**分支**: `fix/trace-summary-pdf`
**状态**: 已修复并部署到 K8s

---

## 1. 用户现象

1. Agent 对话完成后，流式输出期间的"运行轨迹"卡片被清掉，刷新页面后也不展示
2. 缺少执行概览摘要信息（token 消耗、运行时长、执行步数等）
3. 仅支持复制 Markdown，不支持导出 PDF

## 2. 问题描述

### 问题 1: 运行轨迹消失

在 `StreamingDisplay` 中（流式输出期间），所有非 debug 级别的 trace events 都能正常展示。但流式结束后，`MessageBubble` 中的 trace 渲染逻辑只处理了部分 event kind：

- `tool` → ✅
- `skill` → ✅
- `task` → ✅
- `hook` → ✅
- `context` → ✅
- `memory` → ✅
- `permission` → ✅
- `status` → ❌ 返回 `null`，被过滤
- 任何未知 kind → ❌ 返回 `null`，被过滤

简单文本查询（无工具调用）只产生 `status` 和 `usage` 事件，导致 traceEvents 数组虽然非空但全部被 `return null` 过滤，最终不渲染任何内容。

### 问题 2: 缺少执行概览

用户希望在 Agent 回复底部看到：对话 token 消耗、运行时长、执行步数、工具调用次数、技能调用次数、知识库检索次数等摘要信息。

### 问题 3: 不支持 PDF 导出

仅支持复制 Markdown 和导出长图，没有 PDF 导出功能。

## 3. 根因

### 问题 1

文件: `web/src/components/chat/MessageBubble.tsx`，trace label 映射 (原行 382-397)：

```typescript
const label = e.kind === 'tool' ? ... :
              e.kind === 'skill' ? ... :
              // ... 其他 kind ...
              : null;  // <-- status 和其他未知 kind 全部返回 null
if (!label) return null;  // <-- 被过滤掉
```

`status` kind 是 `traceKind()` 函数的默认返回值（`chat.ts:865 return 'status'`），包含大量事件类型（如 status 更新、turn_end、notification 等）。

### 问题 2 & 3

功能缺失，需新增实现。

## 4. 复现路径

1. 登录 DeepThink → 打开任意对话
2. 发送一条简单文本消息（如"你好"）
3. 观察流式输出期间有"运行轨迹"展示
4. 流式结束后，"运行轨迹"卡片消失
5. 刷新页面，"运行轨迹"仍然不显示

## 5. 诊断方法

```bash
# 1. 检查 agent-runner 产生的事件类型
kubectl logs -n deepthink deployment/agent-runner --tail=50 | grep eventType

# 2. 验证 traceCache 是否正确保存
# 打开浏览器 DevTools → Application → Session Storage → hc_trace_cache

# 3. 检查 traceEvents 数组内容
# 在浏览器控制台执行：
# const store = useChatStore.getState();
# console.log(store.traceCache);
```

## 6. 修复方案

### 修复 1: Trace 渲染补全

在 `MessageBubble.tsx` trace label 映射中：

1. 添加 `status` kind 处理: `📌 {title}`
2. `context` kind 改为显示 title 而非固定文本
3. 添加 `debug` kind 显式过滤（调试事件不展示）
4. 添加 fallback: `📎 {title}` 兜底未知 kind

```diff
-  : e.kind === 'context' ? '📊 上下文' : ...
-  : null;
+  : e.kind === 'context' ? `📚 ${e.title.slice(0, 30)}` : ...
+  : e.kind === 'debug' ? null
+  : e.kind === 'status' ? `📌 ${e.title.slice(0, 30)}`
+  : `📎 ${e.title.slice(0, 30)}`;
```

### 修复 2: 新增 ExecutionSummary 组件

从 `traceEvents` 和 `token_usage` 提取统计信息：

- Token 消耗: 从 `token_usage` JSON 解析
- 运行时长: 从 `token_usage.durationMs`
- 执行步数: `traceEvents.length`
- 工具/技能/知识库等: 按 kind 分类计数

渲染在消息内容和 action toolbar 之间。

### 修复 3: PDF 导出

使用浏览器原生 `window.print()` + 隐藏 iframe 方案：

1. 将消息内容转换为简单 HTML（基础 Markdown→HTML）
2. 创建 Blob URL → 加载到隐藏 iframe
3. 触发 `iframe.contentWindow.print()`
4. 自动清理 iframe 和 Blob URL

## 7. 经验沉淀 / 预防

1. **Trace kind 枚举应集中管理**: `traceKind()` 的返回值应在某处有完整个文档，避免渲染端遗漏
2. **渲染端应使用 fallback 而非 null**: 新增未知 kind 时不应静默消失，应至少展示一个通用标签
3. **前后端事件类型应对齐**: 新增 StreamEvent 类型时应同时更新前端渲染逻辑