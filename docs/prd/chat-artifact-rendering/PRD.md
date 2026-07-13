# PRD: 主对话面板原生渲染多种产物类型

> 需求编号: `chat-artifact-rendering`
> 分支: `feat/chat-artifact-rendering`
> 创建日期: 2026-07-08
> 负责人: ai-coder

## 1. 需求背景

### 1.1 现状

DeepThink 主对话面板（`MessageBubble` + `MarkdownRenderer`）当前对 AI 产物的展示能力有限：

- **代码块**：通过 `rehype-highlight` 渲染语法高亮（已支持常见语言）
- **Mermaid 图表**：通过 `MermaidDiagram` 组件渲染（已支持）
- **图片**：通过 markdown `![]()` 语法或消息附件展示，支持点击放大
- **文件链接**：markdown 链接 `[xxx.pdf](xxx.pdf)` 跳转到 `/api/groups/:jid/files/download/:path`，**强制下载**（`Content-Disposition: attachment`），不预览
- **HTML/SVG**：`/preview` 端点将 HTML/SVG 标记为不安全（`UNSAFE_PREVIEW_EXTENSIONS`），强制 `attachment` 下载；代码块中的 HTML/SVG 仅以源码形式展示

### 1.2 痛点

用户在对话中常见的产物类型（SVG 矢量图、HTML 交互 Demo、PDF 报告、Office 文档、源代码、多媒体）无法在对话面板内「原地」查看，必须切到文件面板或下载到本地，打断阅读流。

### 1.3 目标

将主对话面板升级为「产物原生渲染面板」：AI 在对话中输出的任意产物（无论是代码块内联、markdown 文件链接、还是消息附件），都能根据类型在原位渲染为可视化视图，并提供一致的「下载 / 全屏 / 复制源码」操作。

## 2. 名词定义

| 术语 | 含义 |
|------|------|
| **产物（Artifact）** | AI 在对话中生成的可视化/可下载对象，包括但不限于 SVG/HTML/PDF/Office 文档/源代码/多媒体 |
| **内联渲染（Inline Render）** | 在消息气泡内原位渲染产物，无需跳转文件面板或下载 |
| **沙箱（Sandbox）** | 对 HTML/SVG 等可执行内容使用 `iframe[sandbox]` 隔离，防止访问父页面 DOM 与 Cookie |
| **预览端点** | 后端 `/api/groups/:jid/files/preview/:path`，返回内联响应（`Content-Disposition: inline`） |

## 3. 需求清单

### 3.1 必须支持（P0）

| 编号 | 类型 | 扩展名 | 渲染方式 |
|------|------|--------|----------|
| R1 | SVG | `.svg` | `<img src="data:image/svg+xml;base64,...">` 或 sandbox iframe |
| R2 | HTML | `.html` / `.htm` | sandbox iframe + `srcdoc` + 严格 CSP |
| R3 | PDF | `.pdf` | `<iframe src="/preview/xxx.pdf">` 浏览器原生 PDF Viewer |
| R4 | DOCX | `.docx` | `mammoth.js` 转 HTML 后渲染 |
| R5 | XLSX | `.xlsx` / `.xls` | `xlsx` (SheetJS) 解析 → HTML 表格 + 工作表 Tab |
| R6 | PPTX | `.pptx` | 服务端 LibreOffice 转图片/PDF 预览首屏 + 完整下载 |
| R7 | 源代码 | `.java .c .cpp .h .py .go .rs .js .ts .jsx .tsx .css .html .xml .sh .yaml .yml .toml .json .md .sql .php .rb .kt .swift .scala .lua .r .perl .dart .vue .svelte` 等 | `highlight.js` 语法高亮 + 行号 + 复制 |
| R8 | 图片 | `.png .jpg .jpeg .gif .webp .bmp .svg .ico` | `<img>` + 点击放大（已有，需统一） |
| R9 | 视频 | `.mp4 .webm .mov .mkv` | `<video controls>` + Range 请求支持 |
| R10 | 音频 | `.mp3 .wav .ogg .aac .m4a .flac` | `<audio controls>` |

### 3.2 补充支持（P1）

| 编号 | 类型 | 渲染方式 |
|------|------|----------|
| R11 | CSV | 解析为 HTML 表格（限制行数，超过则提示下载） |
| R12 | Markdown 文件 | 渲染为富文本（嵌套 `MarkdownRenderer`） |
| R13 | JSON | 树形折叠查看器（基于 `react-json-view` 或自研） |
| R14 | 纯文本/Log | `<pre>` + 等宽字体 |

### 3.3 统一交互

所有产物卡片提供统一的工具栏：

- **下载**（原图/原文件）
- **在新窗口打开**（仅 HTML/SVG/PDF 等可独立打开的类型）
- **全屏查看**（图片/表格/PPT 等）
- **复制源码**（可展示源码的类型）
- **折叠/展开**（大尺寸产物默认折叠到 600px 高，点击展开）

## 4. 输入入口（三种触发路径）

### 4.1 代码块路径

AI 在 markdown 中输出代码块时，根据语言标签触发渲染：

````
```svg
<svg>...</svg>
```

```html
<!DOCTYPE html>...
```
````

支持语言标签：`svg`、`html`、`pdf`(base64)、`json`、`csv`、`mermaid`（已有）。

### 4.2 Markdown 链接/图片路径

AI 输出 markdown 链接或图片引用工作区文件时，根据扩展名触发渲染：

```markdown
![架构图](diagrams/arch.svg)
[查看报告](reports/2026-q2.pdf)
[下载数据表](data/sales.xlsx)
```

### 4.3 消息附件路径

消息附件 `attachments` 字段已支持 `type: 'image'`。新增 `type: 'file'` 类型，携带 `path`（相对工作区路径）和 `name`，由前端根据扩展名选择渲染器。

> **范围界定**：本次需求**不**改造后端附件协议（保持现有 `attachments` JSON 结构）。文件类产物通过「代码块」或「markdown 链接」入口呈现，由前端在渲染时识别扩展名并拦截为内联预览。

## 5. 非功能需求

### 5.1 安全

- HTML/SVG 必须在 `iframe[sandbox="allow-scripts"]`（**不**给 `allow-same-origin`）中渲染，无法访问父页面 Cookie、localStorage、DOM
- 服务端 `/preview` 对 HTML/SVG 仍返回 `Content-Type: text/html` / `image/svg+xml`，但 `Content-Disposition: inline` + `Content-Security-Policy: default-src 'none'; script-src 'unsafe-inline'; style-src 'unsafe-inline'`
- DOCX/XLSX/PPTX 解析在前端完成，**不**执行任何脚本
- PDF 使用浏览器原生沙箱
- 所有从用户内容生成的 iframe `srcdoc` 必须经过 `DOMPurify` 清洗（HTML 类）

### 5.2 性能

- 大文件（>5MB）懒加载：先显示「点击加载」按钮
- 产物卡片默认最大高度 600px，超出则折叠
- PDF/视频使用流式 Range 请求，不一次性读入内存
- LibreOffice 转换结果缓存（避免每次重复转换）

### 5.3 可访问性

- 所有产物卡片提供 `aria-label`
- 键盘可聚焦「下载」「全屏」按钮
- 颜色对比度满足 WCAG AA

### 5.4 国际化

- 工具栏按钮 tooltip 支持 i18n（zh-CN / en）

## 6. 用户场景

### 场景 1：AI 生成 SVG 架构图

```
用户: 帮我画一个微服务架构图
AI: 这是架构图：
    ```svg
    <svg>...</svg>
    ```
```

**期望**：对话面板原位渲染 SVG 矢量图，可点击放大、下载、复制源码。

### 场景 2：AI 生成 HTML 交互 Demo

```
用户: 写一个可拖拽的卡片排序 demo
AI: ```html
    <!DOCTYPE html>...
    ```
```

**期望**：在 sandbox iframe 中渲染 HTML，JavaScript 可执行但无法访问父页面。

### 场景 3：AI 引用工作区 PDF 报告

```
用户: 看一下上周的周报
AI: 这是周报 [2026-w27.pdf](reports/2026-w27.pdf)
```

**期望**：在对话面板内嵌入 PDF Viewer，可直接翻页阅读。

### 场景 4：AI 生成 XLSX 数据表

```
用户: 把销售数据整理成 Excel
AI: 已生成 [sales.xlsx](data/sales.xlsx)
```

**期望**：在对话面板内渲染表格 + 工作表 Tab，可切换 sheet、下载原文件。

### 场景 5：AI 输出多种源码

```
用户: 给我一个 Python + Go 的并发示例
AI: Python:
    ```python
    ...
    ```
    Go:
    ```go
    ...
    ```
```

**期望**：两段代码均带语法高亮、行号、复制按钮。

## 7. 验收标准

### 7.1 功能验收

- [ ] AC1: 代码块 ```` ```svg ```` 在对话面板原位渲染为矢量图
- [ ] AC2: 代码块 ```` ```html ```` 在 sandbox iframe 中渲染，JS 可执行但无法访问父页面 DOM
- [ ] AC3: Markdown 链接 `[xxx.pdf](xxx.pdf)` 在对话面板内嵌入 PDF Viewer
- [ ] AC4: Markdown 链接 `[xxx.docx](xxx.docx)` 渲染为 HTML（保留段落/列表/表格/图片）
- [ ] AC5: Markdown 链接 `[xxx.xlsx](xxx.xlsx)` 渲染为表格 + 工作表 Tab
- [ ] AC6: Markdown 链接 `[xxx.pptx](xxx.pptx)` 渲染首屏缩略图 + 下载按钮
- [ ] AC7: 代码块 ```` ```python / go / rust / java / c / c++ / js / ts / css / html ```` 均有正确语法高亮
- [ ] AC8: Markdown 图片 `![](xxx.mp4)` 或链接 `[xxx.mp4](xxx.mp4)` 渲染为 `<video controls>`
- [ ] AC9: Markdown 链接 `[xxx.csv](xxx.csv)` 渲染为 HTML 表格
- [ ] AC10: Markdown 链接 `[xxx.json](xxx.json)` 渲染为可折叠树形
- [ ] AC11: 所有产物卡片提供「下载 / 复制源码 / 全屏」统一工具栏
- [ ] AC12: 产物默认最大高度 600px，超出折叠，点击可展开

### 7.2 安全验收

- [ ] AC13: HTML 代码块渲染的 iframe `sandbox` 属性不含 `allow-same-origin`
- [ ] AC14: HTML iframe 内 `document.cookie` 返回空、`window.parent.location` 抛跨域异常
- [ ] AC15: SVG 中的 `<script>` 标签在渲染时不执行（通过 sandbox 隔离）
- [ ] AC16: DOCX/XLSX/PPTX 解析不执行任何远程请求（除原文件下载外）

### 7.3 性能验收

- [ ] AC17: 10MB PDF 在对话面板内可正常加载并翻页
- [ ] AC18: 1000 行 XLSX 表格渲染时间 < 2s
- [ ] AC19: 同一消息含 5 个产物时，渲染时间 < 3s

## 8. 范围边界

### 8.1 本次不做

- 后端附件协议改造（`attachments` 字段保持现状）
- Office 文档的在线编辑（仅预览）
- PPTX 完整动画/过渡效果（仅静态预览首屏）
- 视频/音频的字幕、章节编辑
- 移动端独立的产物全屏查看器（沿用现有 lightbox）

### 8.2 不在范围

- 文件面板（`FilePanel`）的双击预览行为改造（已通过 `/preview` 端点支持部分类型）
- 飞书/Telegram 等 IM 端的产物渲染（IM 端只能展示文本/图片）

## 9. 风险与依赖

| 风险 | 影响 | 缓解 |
|------|------|------|
| `mammoth.js`/`xlsx` 体积较大 | 前端 bundle 增加 ~500KB | 懒加载（`lazy()` + `Suspense`），仅在使用时加载 |
| PPTX 浏览器解析无成熟方案 | PPTX 预览体验差 | 服务端 LibreOffice 转换为 PDF/图片，前端复用 PDF 渲染 |
| LibreOffice 在容器中需安装 | 容器镜像变大 | PPTX 预览为 P1 优先级，可降级为「仅下载」 |
| HTML 沙箱绕过 | XSS 风险 | 严格 `sandbox` + CSP + DOMPurify 三重防护 |
| 大文件内存占用 | 浏览器卡顿 | 懒加载 + 流式响应 + 默认折叠 |

## 10. 里程碑

| 阶段 | 交付物 | 状态 |
|------|--------|------|
| M1 PRD | 本文档 | ✅ |
| M2 技术方案 | `docs/tech_solution/chat-artifact-rendering/` | 进行中 |
| M3 编码实施 | 前端 `ArtifactRenderer` + 后端预览端点改造 | 待开始 |
| M4 测试报告 | `docs/test_report/chat-artifact-rendering/` | 待开始 |
| M5 合并 main | PR + push | 待开始 |

## 11. 关联文档

- 技术方案: `docs/tech_solution/chat-artifact-rendering/SOLUTION.md`
- 测试报告: `docs/test_report/chat-artifact-rendering/TEST_REPORT.md`
