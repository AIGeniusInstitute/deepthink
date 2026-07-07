# 技术方案 — DeepThink 主对话框 UI 极简优化

> 对应 PRD: `docs/prd/ui-minimalist-optimization/PRD.md`
> 分支: `feat/ui-optimization-minimalist`

## 一、总体策略

按 PRD 五大改造项逐项实施，**Surgical Changes** 原则：只动必要的文件，不顺手重构。所有改动均为纯 UI 层或纯文本层，不涉及 API、DB、SDK。

改造分三批：
- **批次 A（UI 减法）**：顶部极简 + 菜单改名 + splash 优化 — 全是删元素或替文本，最小风险
- **批次 B（执行过程透出）**：StreamingDisplay 调整默认值，子 Agent 状态展示增强
- **批次 C（HTML 产物闭环）**：FilePanel 新增 html 预览 + Agent 提示词新增章节

## 二、批次 A：UI 减法

### A1. 顶部 Header 极简化

**文件**：`web/src/components/chat/ChatView.tsx`

**改动点**（行 555-640 Header 区）：

1. 删除行 569 的 `<span>{isWaiting ? '正在思考...' : group.is_home ? '主 Agent' : 'Agent'}</span>`，替换为：
   ```tsx
   {isWaiting && (
     <span className="inline-flex items-center gap-1">
       <span className="w-1 h-1 rounded-full bg-foreground/60 animate-pulse" />
       思考中
     </span>
   )}
   ```
   —— 仅在 thinking 时显示状态，否则完全隐藏状态文本
2. 删除行 570-578 的协作人数块（`group.is_shared && ...`）
3. 删除行 579-586 的 execution mode 胶囊
4. 删除行 587-599 的 IM 渠道状态绿点块

**保留**：群名 h2（行 567）、主题切换、显示模式切换、面板开关、移动端按钮

**群名视觉强化**：行 567 的 h2 className 调整为 `font-semibold text-foreground text-[16px] tracking-tight`，让群名更突出

### A2. 菜单文本替换

**文件 1**：`web/src/components/settings/SettingsNav.tsx:31`
```tsx
// before
{ key: 'claude', label: 'Claude 提供商', icon: <ShieldCheck className="w-4 h-4" />, group: 'system' },
// after
{ key: 'claude', label: '模型服务商', icon: <ShieldCheck className="w-4 h-4" />, group: 'system' },
```

**文件 2**：`web/src/pages/SettingsPage.tsx:107`
```tsx
claude: '模型服务商',
```

**验证**：`grep -rn "Claude 提供商" web/src/` 应返回 0 行

### A3. Desktop Splash 重写

**文件**：`desktop/src/splash.ts`

完整重写 `html` 字符串（行 23-46），保持函数签名不变。

设计要点：
- 窗口尺寸：480×320 → 520×360（行 7-8）
- 背景：保持 `#E8EEF2`
- 主标题 `DeepThink`：56px → 64px，字间距 -1.5px，渐入动画（@keyframes slideUp + fadeIn）
- 副标题：从 "本地 AI Agent · 思考的深度" 改为 "Loop Engineering · 本地优先 · 思考的深度"
- 状态文本："正在启动…" → "正在唤醒思考…"（中文）+ "Initializing…" 副标
- **动画 1**：字符渐入 — logo 文字 opacity 0→1 + translateY(8px→0)，duration 0.6s，cubic-bezier ease-out
- **动画 2**：底部进度条 — 1px 高度，from 0% to 100% width，duration 1.8s ease-in-out
- **动画 3**：微光呼吸 — logo 下方一层 box-shadow: 0 0 30px rgba(31,41,55,.15)，opacity 呼吸 2s infinite
- **去掉**：原 pulse 圆点
- 不引入彩色，仅青黛黑 `#1F2937` + 灰阶

## 三、批次 B：执行过程透出

### B1. 工具调用卡默认展开

**文件**：`web/src/components/chat/ToolActivityCard.tsx`

**当前行为**：行 44- ToolActivityCard 接收 tool 信息，渲染工具名+耗时，参数 parseToolParam 仅在展开时显示

**改动**：让 `param` 信息默认展示在卡体内（不再需要点击展开），保持卡片紧凑但参数可见

具体：
- 在行 51 后，将 `param` 直接渲染在 header 下方一行，className: `text-xs text-muted-foreground font-mono truncate mt-0.5`
- 显示格式：`{label}: {value}`，value 截断到 60 字符

### B2. 子 Agent 卡片状态增强

**文件**：`web/src/components/chat/StreamingDisplay.tsx` TaskAgentBlock 部分

**当前**：TaskAgentBlock 展示子 Agent 名 + running/error 状态色

**改动**：
- running 状态下，如果 taskStates 中有该 agent 的 todos 数据，展示 `已完成/总数` 进度
- 状态胶囊更明显：running=蓝点脉动、completed=绿点、error=红点

### B3. 思考链保持可见

**文件**：`web/src/components/chat/StreamingDisplay.tsx:664`

**当前**：`const [thinkingExpanded, setThinkingExpanded] = useState(true);` — 默认展开

**改动**：保持不变（确认不退化）

## 四、批次 C：HTML 产物闭环

### C1. FilePanel 新增 HTML 预览

**文件**：`web/src/components/chat/FilePanel.tsx`

**改动点**：

1. **PreviewState 类型扩展**（行 180-188）：
   ```tsx
   | { kind: 'html'; file: FileEntry }
   ```

2. **handleItemClick 新增分支**（行 871-895）：
   ```tsx
   } else if (ext === 'html' || ext === 'htm') {
     setPreview({ kind: 'html', file: item });
   }
   ```

3. **新增 HtmlPreview 组件**（参考 PdfPreview 行 604-623）：
   ```tsx
   function HtmlPreview({ groupJid, file, onClose }: {...}) {
     return (
       <MediaOverlay onClose={onClose} fileName={file.name}>
         <iframe
           src={buildPreviewUrl(groupJid, file.path)}
           title={file.name}
           sandbox="allow-scripts allow-same-origin"
           className="w-full h-full max-w-[90vw] max-h-[90vh] rounded-lg bg-white"
           onClick={(e) => e.stopPropagation()}
         />
       </MediaOverlay>
     );
   }
   ```
   
   **安全考虑**：`sandbox` 属性同时启用 `allow-scripts` 和 `allow-same-origin` 会让脚本可访问 same-origin 数据，但 DeepThink 的预览 URL 是 `/api/groups/.../files/preview/...`，与主应用同源。考虑到 Agent 生成的 HTML 是用户自己的产物，可接受此风险。如需更严格，可改为 `sandbox=""` 完全禁用脚本，但会失去动画效果。**PRD 决策**：保持 `allow-scripts allow-same-origin`，让 HTML 产物动画可执行。

4. **渲染分支**（搜索现有 `preview.kind === 'pdf'` 等条件，新增 html 分支）

5. **FileIcon 新增 .html 专属图标**（行 137-156）：
   ```tsx
   if (ext === 'html' || ext === 'htm') return <Globe className="w-4 h-4 text-emerald-500" />;
   ```
   需要在文件顶部 import 中加入 `Globe`

### C2. Agent 全局提示词新增产物交付规范

**文件**：`config/global-claude-md.template.md`

在文件末尾新增章节：

```markdown
## 产物交付规范

当用户请求的研究报告、分析报告、复杂交互产物、可视化内容（如包含图表/动画/交互的产物）时，**默认用 HTML 单文件交付**，而非 markdown：

- **必须**：HTML + 内嵌 CSS + 内嵌 JS，单文件无外链依赖
- **必须**：包含可交互元素（动画、图表、目录跳转、折叠面板等）
- **必须**：使用 SVG 或 CSS 实现图表，不引入 Chart.js / D3 等外部库
- **必须**：文件命名 `{topic}-report.html`，存入工作区 `docs/research/` 或根目录
- **必须**：HTML 在浏览器直接打开可正常展示，无控制台报错
- **可选**：简短结论（200 字以内）继续用 markdown 内嵌在对话中

**例外**：用户明确要求 markdown / 文本格式时，按用户要求。
```

## 五、验证策略

### 单元/集成验证
- `make typecheck` — TypeScript 全量类型检查通过
- `make test` — 现有约束测试不退化
- `grep -rn "Claude 提供商" web/src/` — 返回 0 行

### 手动验证（按 PRD §七）
1. 启动 web dev：`cd web && npm run dev`
2. 进入主聊天界面，目视顶部仅剩群名+思考状态+三按钮
3. 进入设置页，菜单显示"模型服务商"
4. 启动 desktop：`cd desktop && npm run dev`
5. 观察 splash 动画
6. 触发 Agent 任务，观察工具卡参数默认可见
7. 工作区放 .html 文件，点击预览，iframe 内嵌渲染

## 六、回滚策略

所有改动在 `feat/ui-optimization-minimalist` 分支，未合并前不影响 main。如出现问题：
- 单文件回滚：`git checkout main -- <file>`
- 整体回滚：`git checkout main && git branch -D feat/ui-optimization-minimalist`

## 七、提交策略

按三批拆分 commit：
1. `feat: 顶部状态栏极简化与菜单去 Claude 字眼 (A1+A2)`
2. `feat: desktop splash 动画与文本优化 (A3)`
3. `feat: 流式执行过程透出与 HTML 产物预览 (B+C)`

最后合并到 main 并 push。
