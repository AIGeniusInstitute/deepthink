# PRD：Office 文件在线预览/编辑/保存 + 代码语法高亮 + 沙箱浏览器自动化 Agent

> 分支：`feat/office-edit-code-hl-browser-agent`
> 创建日期：2026-07-20
> 负责人：DeepThink Agent

## 1. 背景

DeepThink Agent 在对话中会产出三类产物文件：
1. Office 文档（`.docx` / `.pptx` / `.xlsx`）
2. 源代码文件（`.js` `.ts` `.py` `.go` `.rs` …… 等常见 100+ 种语言）
3. 沙箱内通过浏览器自动化完成的任务（当前 `/sandbox` 页面浏览器为只读帧流，无自然语言 Agent、无交互）

当前状态（基于代码探查）：
- **FilePanel**（工作区文件浏览覆盖层）对 `docx/pptx/xlsx` **没有任何预览**，点击进入 `GenericTextPreview` 对二进制失败；代码文件用纯 `<Textarea>` 编辑，**无语法高亮**。
- **ArtifactRenderer**（对话产物渲染）已有 docx(mammoth 只读)/xlsx(SheetJS 只读)/pptx(LibreOffice→PDF 只读)/code(hljs 高亮，但依赖脆弱的 `window.hljs` 全局)，**全部只读，无编辑保存**。
- **沙箱后端**已具备完整 Playwright-over-CDP 浏览器原语（navigate/click/type/screenshot/evaluate/restart）+ WebSocket 实时帧推送；**前端 `BrowserView` 只显示 `<img>` 帧，无交互、无 URL 栏、无点击转发、无自然语言 Agent**。

## 2. 目标

| 编号 | 功能点 | 目标 |
|---|---|---|
| F1 | Office 预览 | FilePanel 点击 docx/pptx/xlsx 能正确预览（复用/统一 ArtifactRenderer 渲染逻辑） |
| F2 | Office 编辑+保存 | docx/xlsx 支持在线编辑并保存回原文件；pptx 在 OnlyOffice 可用时支持 WYSIWYG 编辑保存，否则提供预览+下载 |
| F3 | 代码语法高亮 | 源代码文件支持 100+ 种语言语法彩色渲染；FilePanel 代码编辑器升级为带行号、高亮、可编辑保存的富编辑器 |
| F4 | 浏览器自动化 Agent | `/sandbox` 页面内开发 Browser Use Agent：自然语言下达任务 → Agent 自动驱动浏览器执行；界面上实时看到浏览器执行过程 |
| F5 | 浏览器交互视图 | BrowserView 支持点击转发、URL 栏、滚动、刷新，实时显示当前页面 |

## 3. 验收标准

### F1 Office 预览
- F1.1 FilePanel 点击 `.docx` → 渲染为可读 HTML（mammoth 转换），不再显示二进制乱码。
- F1.2 FilePanel 点击 `.xlsx` → 渲染为多 sheet 表格，单元格内容可见。
- F1.3 FilePanel 点击 `.pptx` → LibreOffice 可用时渲染为 PDF iframe 预览；不可用时显示下载链接与提示。
- F1.4 上述预览均带"下载"按钮。

### F2 Office 编辑+保存
- F2.1 `.xlsx`：进入编辑模式后单元格可直接修改内容；切换 sheet 可编辑；保存按钮将修改写回 `.xlsx` 文件（SheetJS `XLSX.write`），重新预览内容一致。
- F2.2 `.docx`：进入编辑模式后可对渲染的富文本进行修改（contenteditable）；保存按钮将内容导出回 `.docx`（html-docx-js），重新预览可见修改。
- F2.3 `.pptx`：当后端配置 `ONLYOFFICE_URL` 且 OnlyOffice 服务可达时，提供 OnlyOffice WYSIWYG 编辑器，保存回原文件（JWT + callback 回调链路）；不可用时仅预览+下载，并在 UI 明确提示"pptx 编辑需要 OnlyOffice"。
- F2.4 保存使用既有 `PUT /api/groups/:jid/files/content/:path` 或新增二进制保存端点；保存后文件 mtime 更新。
- F2.5 编辑器有"取消"按钮放弃修改。

### F3 代码语法高亮
- F3.1 FilePanel 打开 `.js/.ts/.py/.go/.rs/.java/.c/.cpp/.rb/.php/.sh/.sql/.json/.yaml/.html/.css/...` 等代码文件，显示带行号、语法彩色高亮的编辑器。
- F3.2 支持语言数 ≥ 100（由 Monaco 内置或 highlight.js 提供）。
- F3.3 编辑器支持编辑并 Ctrl/Cmd+S 保存（既有保存端点）。
- F3.4 修复 `CodeRenderer` 依赖 `window.hljs` 全局的脆弱实现，改为显式 `import hljs from 'highlight.js'`。
- F3.5 代码产物（ArtifactRenderer 的 CodeRenderer）彩色渲染正常，深色/浅色主题可见。

### F4 Browser Use Agent
- F4.1 `/sandbox` 页面在选中已启用浏览器的会话后，出现"Browser Use Agent"输入区，可输入自然语言任务（如"打开百度搜索 DeepThink 并截图"）。
- F4.2 提交后后端启动 Agent 循环：截图 → 发送给视觉 LLM → 解析下一步动作 → 调用既有浏览器原语执行 → 循环，直到任务完成或达到最大步数。
- F4.3 前端实时显示每一步：当前截图、Agent 思考/动作描述、动作类型、执行结果，无需手动刷新。
- F4.4 Agent 支持的动作集：navigate / click / type / scroll / screenshot / evaluate / done / failed。
- F4.5 可随时"停止"Agent。
- F4.6 Agent 结束后给出总结（完成 / 失败 + 原因）。

### F5 浏览器交互视图
- F5.1 BrowserView 显示实时页面帧（既有 WS 帧流）。
- F5.2 在帧上点击 → 把坐标发到后端 → 执行浏览器 click，页面相应更新。
- F5.3 URL 栏：显示当前 URL，可输入地址回车导航。
- F5.4 提供"刷新""返回""截图"按钮。
- F5.5 帧率/状态指示可见。

## 4. 测试用例（手工 + 自动）

| 用例 | 步骤 | 预期 |
|---|---|---|
| TC-F1.1 docx 预览 | 在 FilePanel 点击一个 .docx 产物 | 显示渲染 HTML，非乱码 |
| TC-F1.2 xlsx 预览 | 点击 .xlsx 产物 | 多 sheet 表格可见 |
| TC-F1.3 pptx 预览 | 点击 .pptx 产物 | PDF iframe 或下载提示 |
| TC-F2.1 xlsx 编辑保存 | 编辑某单元格 → 保存 → 重新打开 | 内容已更新 |
| TC-F2.2 docx 编辑保存 | 修改一段文字 → 保存 → 重新打开 | 修改可见 |
| TC-F3.1 代码高亮 | 打开 .py 文件 | 行号+彩色高亮 |
| TC-F3.2 代码保存 | 编辑后 Ctrl+S | 保存成功，无内容丢失 |
| TC-F4.1 NL 任务 | 输入"打开 example.com 并截图"提交 | Agent 自动导航+截图，步骤实时显示 |
| TC-F4.2 停止 | 运行中点停止 | 循环终止 |
| TC-F5.1 点击转发 | 帧上点击某链接 | 页面跳转，帧更新 |
| TC-F5.2 URL 栏 | 输入地址回车 | 导航成功 |

## 5. 非目标 / 边界
- 不做 Office 文档的版本管理/协作（多人同编）。
- pptx 在无 OnlyOffice 时不承诺编辑（明确提示），仅预览+下载。
- Browser Use Agent 不承诺 100% 任务成功率（依赖视觉 LLM 能力），但循环框架与实时展示必须可用。
- 不重构既有沙箱 Docker/CDP 后端，只在其上加 Agent 循环与交互端点。

## 6. 关键取舍（Think Before Coding）
- **Office 编辑方案**：真实 WYSIWYG 编辑 docx/xlsx/pptx 的标准方案是 OnlyOffice Document Server。但其为独立 Docker 服务（~1GB 镜像），当前环境未部署、无法即时验证。故采取**双轨**：
  - 主路径：OnlyOffice 集成层（JWT 配置 + 前端 iframe + 保存回调），当 `ONLYOFFICE_URL` 可用时启用，覆盖 docx/xlsx/pptx 真实编辑。
  - 降级路径：xlsx 用 SheetJS 可编辑表格 + `XLSX.write` 保存；docx 用 contenteditable + html-docx-js 保存（有损，简单文档可用）；pptx 仅预览。
  - 这样所有"可验证"路径均自包含、无外部重型依赖；OnlyOffice 作为可选增强。
- **代码编辑器**：选 Monaco（VS Code 同款，内置 70+ 语言 + 语法高亮，配合 highlight.js 注册可覆盖 100+）。重量可接受，体验最佳。备选 CodeMirror 6，但 Monaco 集成更省事。
- **Browser Use Agent LLM**：复用 `sdk-query.ts` 的 provider 配置，扩展一个支持图像 content block 的 `sdkQueryMessages` 变体（Claude Agent SDK `query` 支持带图 messages）。
