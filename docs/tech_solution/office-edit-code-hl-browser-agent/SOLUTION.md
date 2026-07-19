# 技术方案：Office 预览/编辑/保存 + 代码高亮 + 浏览器自动化 Agent

> 分支：`feat/office-edit-code-hl-browser-agent`

## 0. 架构总览

```
┌────────────────────────── web (Vite/React 5173) ──────────────────────────┐
│  FilePanel  ──(扩展 dispatch)──> OfficeViewer / CodeEditor(Monaco)         │
│  ArtifactRenderer ─(重构)> CodeRenderer(显式 hljs) / OfficeArtifact         │
│  SandboxPage ─(新增)> BrowserUsePanel(NL 输入+步骤流) + InteractiveBrowserView│
└──────────────────────────────────┬───────────────────────────────────────┘
                                   │ /api + /ws (proxy → 9898)
┌────────────────────────── src (Hono 后端 9898) ───────────────────────────┐
│  routes/files.ts      既有：preview/content/download (+ 新增 binary save)   │
│  routes/sandbox.ts    既有：browser/* (+ 新增 /agent + /interactive)        │
│  sandbox/browser.ts   既有：Playwright-over-CDP 原语                       │
│  sandbox/browser-agent.ts 【新】Agent 循环：截图→LLM→解析→执行→广播         │
│  sdk-query.ts         既有：sdkQuery 【扩展】sdkQueryMessages(支持 image)   │
│  office-converter.ts  既有：LibreOffice→PDF                                │
│  onlyoffice.ts        【新】JWT 配置 + callback 校验（仅 ONLYOFFICE_URL 配置时）│
└────────────────────────────────────────────────────────────────────────────┘
```

## 1. 功能点 F1+F2：Office 预览/编辑/保存

### 1.1 统一渲染入口
- 抽取 ArtifactRenderer 中 docx/xlsx/pptx/pdf 渲染逻辑为可复用组件 `web/src/components/files/office/`：
  - `DocxView.tsx`（mammoth → HTML，DOMPurify 清洗）
  - `XlsxView.tsx`（SheetJS → 多 sheet 表格）
  - `PptxView.tsx`（LibreOffice→PDF iframe / 下载提示）
- FilePanel 的 dispatch（`FilePanel.tsx:898-924`）扩展：`docx→DocxView`、`xlsx→XlsxView`、`pptx→PptxView`。
- 既有 `ArtifactRenderer` 改为复用这些组件（Surgical：保留其 toolbar/全屏能力，只替换内部 renderer）。

### 1.2 编辑模式（双轨）
- **XlsxEditor**（自包含）：
  - 进入编辑模式 → 把 sheet 数据渲染为 `<table contenteditable>`（每 sheet 一个 tab）。
  - 保存：收集所有 sheet 表格 → `XLSX.utils.table_to_sheet` → `XLSX.write({type:'array'})` → 调用新增 `PUT /api/groups/:jid/files/binary/:path`（Content-Type: application/octet-stream）写回 `.xlsx`。
- **DocxEditor**（自包含，有损）：
  - 进入编辑模式 → mammoth HTML 放入 `contenteditable` 容器（保留基础样式）。
  - 保存：取 innerHTML → `html-docx-js` `asBlob(html)` → 二进制保存端点写回 `.docx`。
- **OnlyOffice 集成**（可选增强，`ONLYOFFICE_URL` 配置时启用）：
  - 后端 `src/onlyoffice.ts`：`buildEditorConfig(filePath, groupJid)` 生成 JWT 签名的 config（document url = 后端 `/preview` 或新增 `/raw`，callback url = `/api/office/onlyoffice/callback`）。
  - 前端 `OnlyOfficeEditor.tsx`：`<script src="${ONLYOFFICE_URL}/web-apps/apps/api/documents/api.js">` + `new DocsAPI.DocEditor(...)`。
  - 保存回调：OnlyOffice `callback` → 后端下载新版另存为 `.docx/.xlsx/.pptx` 覆盖原文件。
  - 覆盖 docx/xlsx/pptx 真实 WYSIWYG 编辑。

### 1.3 后端新增端点
- `PUT /api/groups/:jid/files/binary/:path`：接收二进制 body，写回 `data/groups/{folder}/...`（复用 `validateAndResolvePath` 防穿越）。`routes/files.ts` 新增 handler。
- `GET /api/office/onlyoffice/status`：返回 `{ enabled, url }`（`ONLYOFFICE_URL` env）。
- `POST /api/office/onlyoffice/config`：返回某文件的 JWT editor config。
- `POST /api/office/onlyoffice/callback`：OnlyOffice 保存回调（仅占位 + 下载保存逻辑，env 未配置时 503）。

## 2. 功能点 F3：代码语法高亮

### 2.1 FilePanel 代码编辑器 → Monaco
- 新增 `web/src/components/files/CodeEditor.tsx`：`@monaco-editor/react` 的 `Editor`，`language` 按扩展名映射（≥100 种，复用 Monaco 内置 + 必要时 `monaco.languages` 注册）。
- 替换 `FilePanel.tsx` dispatch 中代码类扩展名（`.js/.ts/.py/.go/...`）由 `TextEditor` → `CodeEditor`。
- 保存：Ctrl/Cmd+S / 保存按钮 → 既有 `PUT .../files/content/:path`（文本）。
- 主题：跟随 `document.documentElement.classList` 的 dark class 切换 `vs-dark` / `light`。

### 2.2 修复 CodeRenderer 产物高亮
- `web/src/components/chat/artifacts/CodeRenderer.tsx`：`const hljs = await import('highlight.js')` 显式导入，替代 `(window as any).hljs`。

### 2.3 语言映射表
- `web/src/components/files/language-map.ts`：`{extension → monaco language id}`，覆盖 100+ 常见语言；未知扩展名回退 `plaintext`。

## 3. 功能点 F4+F5：Browser Use Agent + 交互视图

### 3.1 后端：视觉 LLM 变体
- `src/sdk-query.ts` 新增 `sdkQueryMessages(messages, opts)`：
  - 接收 Anthropic 消息格式 `{role, content: ContentBlock[]}`，content block 含 `{type:'text'}` 与 `{type:'image', source:{type:'base64', media_type:'image/png', data}}`。
  - 复用 `getClaudeProviderConfig` + `buildClaudeEnvLines`，调 `query({messages, options:{...}})`，`maxTurns:1, allowedTools:[]`。
  - 返回文本结果（用于解析 JSON 动作）。

### 3.2 后端：Browser Agent 循环
- 新增 `src/sandbox/browser-agent.ts`：
  ```
  async runBrowserAgent(sessionId, goal, onStep): 
    for step in 1..MAX_STEPS:
      png = browser.screenshot(sessionId)
      msg = [system+actionSchema, user: [text(goal+lastResult), image(png)]]
      resp = await sdkQueryMessages(msg)
      action = parseJSON(resp)   // {type, ...params}
      result = await browser.executeAction(sessionId, action)
      onStep({step, screenshot:png, action, thought, result})
      if action.type in [done, failed]: break
  ```
- 动作集 → 映射到既有 `BrowserController` 方法：navigate/click(x,y)/type(text)/scroll(dx,dy)/evaluate(js)/screenshot/done/failed。
- prompt schema：要求 LLM 返回严格 JSON `{"thought":"...","action":{"type":"...",...},"done":bool}`。

### 3.3 后端：路由 + WebSocket 广播
- `routes/sandbox.ts` 新增：
  - `POST /sessions/:id/browser/agent`：body `{goal, maxSteps?}` → 启动 `runBrowserAgent`（异步），返回 `{runId}`。
  - `POST /sessions/:id/browser/agent/stop`：中止当前 run（AbortController）。
- WebSocket：复用既有 `sandbox_browser_subscribe`；新增事件 `sandbox_browser_agent_step`（{runId, step, action, thought, result, screenshot}）、`sandbox_browser_agent_done`（{runId, status, summary}）。在 `web.ts` WS dispatcher 增加这两个 case 的广播。

### 3.4 前端：交互式 BrowserView
- 改造 `web/src/components/sandbox/BrowserView.tsx`：
  - 在 `<img>` 上加 `onClick` → 计算 相对比例 → `POST .../browser/click {x,y}`（既有 click 端点支持坐标；若端点用 selector，则扩展为坐标点击）。
  - 顶部 URL 栏（受控输入）+ 回车 → `POST .../browser/navigate`。
  - 工具按钮：刷新（evaluate `location.reload()`）/ 截图 / 返回（evaluate `history.back()`）。
  - 帧仍走既有 `sandbox_browser_frame` WS。
- 后端 `click` 端点扩展支持 `{x?, y?, selector?}`：`BrowserController` 增加 `page.mouse.click(x,y)` 分支。

### 3.5 前端：Browser Use Agent 面板
- 新增 `web/src/components/sandbox/BrowserUsePanel.tsx`：
  - NL 任务输入框 + 提交 + 停止按钮。
  - 步骤列表（实时）：每步显示 step#、thought、action、result、当前截图缩略图。
  - 订阅 WS `sandbox_browser_agent_step/done`。
  - 完成后显示总结。
- 嵌入 `SandboxPage.tsx` 右侧 BrowserView 上方。

## 4. 文件改动清单

### 后端（src/）
| 文件 | 改动 |
|---|---|
| `src/sdk-query.ts` | 新增 `sdkQueryMessages`（图像支持） |
| `src/sandbox/browser-agent.ts` | 【新】Agent 循环 |
| `src/sandbox/browser.ts` | `click` 支持坐标；新增 `executeAction` 分发 |
| `src/routes/sandbox.ts` | 新增 `/agent`、`/agent/stop` 路由 |
| `src/web.ts` | WS dispatcher 增 `sandbox_browser_agent_*` 广播 |
| `src/routes/files.ts` | 新增 `PUT /:jid/files/binary/:path` |
| `src/onlyoffice.ts` | 【新】JWT 配置 + callback（条件启用） |
| `src/routes/office.ts` | 【新】`/api/office/onlyoffice/*` 路由 |

### 前端（web/src/）
| 文件 | 改动 |
|---|---|
| `web/src/components/files/office/{DocxView,XlsxView,PptxView}.tsx` | 【新】复用渲染 |
| `web/src/components/files/office/{XlsxEditor,DocxEditor,OnlyOfficeEditor}.tsx` | 【新】编辑器 |
| `web/src/components/files/CodeEditor.tsx` | 【新】Monaco 编辑器 |
| `web/src/components/files/language-map.ts` | 【新】扩展名→语言映射 |
| `web/src/components/chat/FilePanel.tsx` | dispatch 扩展（office + code→CodeEditor） |
| `web/src/components/chat/artifacts/CodeRenderer.tsx` | 显式 import hljs |
| `web/src/components/sandbox/BrowserView.tsx` | 交互化（点击/URL栏/工具栏） |
| `web/src/components/sandbox/BrowserUsePanel.tsx` | 【新】NL Agent 面板 |
| `web/src/pages/SandboxPage.tsx` | 嵌入 BrowserUsePanel |
| `web/src/api/sandbox.ts` | 新增 `runAgent/stopAgent` API |
| `web/src/stores/sandbox.ts` | WS 处理 `sandbox_browser_agent_*` |
| `web/package.json` | + `@monaco-editor/react`、`monaco-editor`、`html-docx-js` |

## 5. 验证计划
1. `make typecheck` 全量类型检查通过。
2. 前端 `npm run build` 通过。
3. 手工验证（在 5173）：每个 TC 用例。
4. 后端单测：`sdkQueryMessages` 图像消息构造；`browser-agent` 动作解析（mock LLM 返回）。
5. 端到端：Browser Use Agent 跑一个真实任务（"打开 example.com 截图"），观察步骤流。

## 6. 风险与对策
| 风险 | 对策 |
|---|---|
| OnlyOffice 未部署，pptx 编辑无法验证 | 双轨设计；pptx 在无 OnlyOffice 时明确提示，不在测试报告中宣称已实现编辑 |
| 视觉 LLM 不支持图像/不可用 | `sdkQueryMessages` 失败时 Agent 步骤标记 failed 并停止，UI 显示原因 |
| Monaco 包体大、构建慢 | 用 `@monaco-editor/react` 按需加载（CDN 或 vite 自托管），不阻塞首屏 |
| html-docx-js 导出有损 | 文档中明确"简单文档可用，复杂排版有损"，PRD 已声明 |
| click 坐标点击误触 | 提供"交互模式"开关，默认只读帧，开启后才允许点击 |
