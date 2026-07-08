# 技术方案: 主对话面板原生渲染多种产物类型

> 对应 PRD: `docs/prd/chat-artifact-rendering/PRD.md`
> 分支: `feat/chat-artifact-rendering`

## 1. 总体架构

```
┌──────────────────────────────────────────────────────────┐
│                  MessageBubble (AI 消息)                  │
│  ┌────────────────────────────────────────────────────┐  │
│  │            MarkdownRenderer                         │  │
│  │  ┌─────────────┐  ┌─────────────┐  ┌────────────┐  │  │
│  │  │ CodeBlock   │  │ Image/Link  │  │   ...      │  │  │
│  │  │ (svg/html/  │  │ (*.pdf/     │  │            │  │  │
│  │  │  csv/json)  │  │  *.docx/    │  │            │  │  │
│  │  │             │  │  *.xlsx/..) │  │            │  │  │
│  │  └──────┬──────┘  └──────┬──────┘  └────────────┘  │  │
│  └─────────┼─────────────────┼─────────────────────────┘  │
│            │                 │                            │
│            ▼                 ▼                            │
│  ┌──────────────────────────────────────────────────────┐ │
│  │             ArtifactRenderer (新增)                  │ │
│  │  按扩展名/MIME 分发到具体渲染器                      │ │
│  └──┬──────┬──────┬──────┬──────┬──────┬──────┬────────┘ │
│     ▼      ▼      ▼      ▼      ▼      ▼      ▼          │
│   Svg   Html    Pdf   Docx  Xlsx  Pptx  Code/Media/...    │
│ Renderer                                              │   │
└──────────────────────────────────────────────────────────┘
                          │
                          ▼ (PPTX 转换路径)
┌──────────────────────────────────────────────────────────┐
│  后端 /api/groups/:jid/files/convert/:path               │
│  - LibreOffice headless 转换 pptx → pdf                 │
│  - 结果缓存到 data/cache/office-preview/{sha256}.pdf    │
└──────────────────────────────────────────────────────────┘
```

## 2. 关键设计决策

### 2.1 三种触发入口统一收口到 ArtifactRenderer

| 入口 | 识别方式 | 转换 |
|------|----------|------|
| 代码块 | `language-xxx` className | `language-svg/html` → 内联内容渲染 |
| Markdown 图片/链接 | URL 路径扩展名 | 非图片扩展名 → 通过 `/preview` 加载 |
| 消息附件（本次不动） | - | - |

**为什么统一收口**：避免在 `MarkdownRenderer`、`MessageBubble` 各处重复实现识别逻辑。所有产物渲染走同一个 `ArtifactRenderer`，统一工具栏与折叠行为。

### 2.2 渲染策略矩阵

| 类型 | 渲染方式 | 数据来源 | 库 |
|------|----------|----------|-----|
| SVG | `<img src="data:image/svg+xml;base64,..."">` 或 sandbox iframe | 代码块原文 / `/preview` | 无 |
| HTML | `<iframe sandbox srcdoc="...">` | 代码块原文 / `/preview` | `dompurify`（清洗） |
| PDF | `<iframe src="/preview/xxx.pdf">` | `/preview` | 浏览器原生 |
| DOCX | fetch ArrayBuffer → `mammoth.convertToHtml()` → dangerouslySetInnerHTML（已清洗） | `/preview` | `mammoth`（懒加载） |
| XLSX | fetch ArrayBuffer → `XLSX.read()` → 渲染 sheet tab + `<table>` | `/preview` | `xlsx`（懒加载） |
| PPTX | 调用 `/convert` 获取 PDF → 走 PDF 渲染 | `/convert` | LibreOffice（服务端） |
| 源代码 | `<pre><code class="language-xxx">` + `highlight.js` | 代码块原文 / `/preview` | `highlight.js`（已有） |
| 图片 | `<img>` + lightbox | `/preview` | 无 |
| 视频 | `<video controls>` | `/preview` | 无 |
| 音频 | `<audio controls>` | `/preview` | 无 |
| CSV | fetch text → 解析 → `<table>` | `/preview` | 无（自研简易解析） |
| JSON | fetch text → `JSON.parse` → 树形 | `/preview` | 无（自研简易树形） |
| Markdown | fetch text → 嵌套 `MarkdownRenderer` | `/preview` | 无 |

### 2.3 安全沙箱策略

**HTML/iframe 沙箱属性**：
```
sandbox="allow-scripts allow-popups allow-forms"
```
**不**给 `allow-same-origin`：iframe 内的页面被视为不同源，无法访问父页面 Cookie/localStorage/DOM。

**iframe `srcdoc` CSP**：
```
default-src 'none';
script-src 'unsafe-inline' 'unsafe-eval' data:;
style-src 'unsafe-inline' data:;
img-src data: blob: https:;
font-src data:;
connect-src 'none';
```

**SVG 渲染**：默认用 `<img>`（不执行脚本、不加载外部资源）。当代码块含 `<script>` 或外部引用时降级为 sandbox iframe。

**DOMPurify**：在 srcdoc 前过一次 `DOMPurify.sanitize(html, { FORBID_TAGS: ['script'] })` 作为双保险（实际允许脚本执行，但过滤恶意标签如 `<object>`/`<embed>`/`<base>`）。

### 2.4 性能策略

| 场景 | 策略 |
|------|------|
| 大文件 | 文件大小 > 5MB 时显示「点击加载」按钮，不自动加载 |
| 产物高度 | 默认 `max-height: 600px`，超出折叠，点击展开 |
| 代码块行数 | > 200 行时虚拟滚动（沿用 react-virtual） |
| 第三方库 | `mammoth`/`xlsx` 通过 `lazy()` + `Suspense` 加载 |
| PDF/视频 | `/preview` 已支持 Range，前端 `<iframe>`/`<video>` 自动利用 |
| PPTX 转换 | 服务端缓存到 `data/cache/office-preview/{sha256}.pdf`，避免重复转换 |

## 3. 文件改动清单

### 3.1 前端（web/）

#### 新增

| 文件 | 职责 |
|------|------|
| `web/src/components/chat/artifacts/ArtifactRenderer.tsx` | 统一入口：按扩展名/MIME 分发 |
| `web/src/components/chat/artifacts/SvgRenderer.tsx` | SVG 渲染（img 优先，sandbox 降级） |
| `web/src/components/chat/artifacts/HtmlRenderer.tsx` | HTML sandbox iframe 渲染 |
| `web/src/components/chat/artifacts/PdfRenderer.tsx` | PDF iframe 渲染 |
| `web/src/components/chat/artifacts/DocxRenderer.tsx` | DOCX 渲染（mammoth） |
| `web/src/components/chat/artifacts/XlsxRenderer.tsx` | XLSX 渲染（SheetJS） |
| `web/src/components/chat/artifacts/PptxRenderer.tsx` | PPTX 渲染（调 /convert） |
| `web/src/components/chat/artifacts/CodeRenderer.tsx` | 源代码高亮渲染（代码块复用） |
| `web/src/components/chat/artifacts/MediaRenderer.tsx` | 视频/音频渲染 |
| `web/src/components/chat/artifacts/CsvRenderer.tsx` | CSV 表格渲染 |
| `web/src/components/chat/artifacts/JsonTreeRenderer.tsx` | JSON 树形渲染 |
| `web/src/components/chat/artifacts/MarkdownFileRenderer.tsx` | Markdown 文件嵌套渲染 |
| `web/src/components/chat/artifacts/ArtifactToolbar.tsx` | 统一工具栏（下载/复制/全屏/展开） |
| `web/src/components/chat/artifacts/types.ts` | 类型定义 + 扩展名映射 |
| `web/src/components/chat/artifacts/useArtifactUrl.ts` | Hook：构造 `/preview` URL + 鉴权 |

#### 修改

| 文件 | 改动 |
|------|------|
| `web/src/components/chat/MarkdownRenderer.tsx` | CodeBlock 对 `svg/html` 走 `ArtifactRenderer`；`img`/`a` 对非图片扩展名走 `ArtifactRenderer` |
| `web/src/components/chat/MessageBubble.tsx` | 不改动（产物入口都在 MarkdownRenderer 内） |
| `web/package.json` | 新增 `mammoth`、`xlsx` 依赖 |

### 3.2 后端（src/）

#### 修改

| 文件 | 改动 |
|------|------|
| `src/routes/files.ts` | 1) `UNSAFE_PREVIEW_EXTENSIONS` 移除 `html`/`svg`（改为安全 inline + 严格 CSP）<br>2) 新增 `/convert/:path` 端点：调用 LibreOffice 转换 PPTX → PDF，缓存到 `data/cache/office-preview/`<br>3) `MIME_MAP` 补充 `htm`、`md`、`markdown` 等 |

#### 新增

| 文件 | 职责 |
|------|------|
| `src/office-converter.ts` | 封装 LibreOffice headless 调用：`soffice --headless --convert-to pdf --outdir ...`，支持超时、缓存 |

### 3.3 容器

| 文件 | 改动 |
|------|------|
| `container/Dockerfile` | 安装 `libreoffice-core` + `libreoffice-impress`（仅 PPTX 转换所需组件，~150MB） |

> **降级策略**：若 Dockerfile 改动受阻，PPTX 渲染降级为「仅显示下载按钮」，不影响其他类型。

## 4. 核心数据结构

### 4.1 ArtifactKind 枚举

```typescript
// web/src/components/chat/artifacts/types.ts
export type ArtifactKind =
  | 'svg'        // SVG 矢量图
  | 'html'       // HTML 交互页
  | 'pdf'        // PDF 文档
  | 'docx'       // Word 文档
  | 'xlsx'       // Excel 表格
  | 'pptx'       // PPT 幻灯片
  | 'code'       // 源代码
  | 'image'      // 图片
  | 'video'      // 视频
  | 'audio'      // 音频
  | 'csv'        // CSV 表格
  | 'json'       // JSON 数据
  | 'markdown'   // Markdown 文件
  | 'text'       // 纯文本
  | 'mermaid'    // Mermaid 图（已有，复用）
  | 'unknown';   // 未知类型，降级为下载链接

export interface ArtifactSource {
  /** 内联内容（代码块路径） */
  inlineContent?: string;
  /** 文件相对路径（markdown 链接/图片路径） */
  filePath?: string;
  /** 文件名（用于下载按钮） */
  fileName?: string;
  /** 工作区 JID（构造 /preview URL） */
  groupJid?: string;
  /** 代码语言（code 路径用） */
  language?: string;
}
```

### 4.2 扩展名 → Kind 映射

```typescript
export const EXTENSION_TO_KIND: Record<string, ArtifactKind> = {
  svg: 'svg',
  html: 'html', htm: 'html',
  pdf: 'pdf',
  docx: 'docx',
  xlsx: 'xlsx', xls: 'xlsx',
  pptx: 'pptx',
  png: 'image', jpg: 'image', jpeg: 'image', gif: 'image',
  webp: 'image', bmp: 'image', ico: 'image',
  mp4: 'video', webm: 'video', mov: 'video', mkv: 'video',
  mp3: 'audio', wav: 'audio', ogg: 'audio', aac: 'audio', m4a: 'audio', flac: 'audio',
  csv: 'csv',
  json: 'json',
  md: 'markdown', markdown: 'markdown',
  // 代码
  java: 'code', c: 'code', cpp: 'code', h: 'code',
  py: 'code', go: 'code', rs: 'code',
  js: 'code', ts: 'code', jsx: 'code', tsx: 'code',
  css: 'code', xml: 'code',
  sh: 'code', bash: 'code', zsh: 'code',
  yaml: 'code', yml: 'code', toml: 'code',
  sql: 'code', php: 'code', rb: 'code',
  kt: 'code', swift: 'code', scala: 'code',
  lua: 'code', r: 'code',
  dart: 'code', vue: 'code', svelte: 'code',
  txt: 'text', log: 'text',
};

export const LANGUAGE_LABEL: Record<string, string> = {
  python: 'Python', py: 'Python',
  go: 'Go',
  rust: 'Rust', rs: 'Rust',
  java: 'Java',
  c: 'C', cpp: 'C++', 'c++': 'C++',
  javascript: 'JavaScript', js: 'JavaScript',
  typescript: 'TypeScript', ts: 'TypeScript',
  // ...
};
```

## 5. 关键流程

### 5.1 代码块路径

```typescript
// MarkdownRenderer.tsx CodeBlock 改造
function CodeBlock({ className, children }) {
  const match = /language-(\w+)/.exec(className || '');
  const lang = match?.[1];
  const codeString = extractText(children).replace(/\n$/, '');

  // Mermaid 已有
  if (lang === 'mermaid') return <MermaidDiagram code={codeString} />;

  // 新增：SVG / HTML 内联渲染
  if (lang === 'svg') {
    return <ArtifactRenderer kind="svg" source={{ inlineContent: codeString, fileName: 'artifact.svg' }} />;
  }
  if (lang === 'html' || lang === 'htm') {
    return <ArtifactRenderer kind="html" source={{ inlineContent: codeString, fileName: 'artifact.html' }} />;
  }

  // 普通代码块（保留原有逻辑）
  return <PreCodeBlock className={className}>{children}</PreCodeBlock>;
}
```

### 5.2 Markdown 图片/链接路径

```typescript
// MarkdownRenderer.tsx img/a 改造
img: ({ src, alt }) => {
  const ext = getExt(src);
  const kind = EXTENSION_TO_KIND[ext];
  // 普通图片沿用 MarkdownImage
  if (kind === 'image' || !kind) return <MarkdownImage src={resolveImageSrc(src, groupJid)} alt={alt} />;
  // 非图片产物走 ArtifactRenderer
  return (
    <ArtifactRenderer
      kind={kind}
      source={{ filePath: src, fileName: alt || pathBase(src), groupJid }}
    />
  );
},
a: ({ href, children }) => {
  const ext = getExt(href);
  const kind = ext ? EXTENSION_TO_KIND[ext] : undefined;
  if (kind && !['text'].includes(kind)) {
    return <ArtifactRenderer kind={kind} source={{ filePath: href, fileName: extractText(children), groupJid }} />;
  }
  return <a href={href} target="_blank">{children}</a>;
}
```

### 5.3 ArtifactRenderer 主入口

```typescript
export function ArtifactRenderer({ kind, source }: { kind: ArtifactKind; source: ArtifactSource }) {
  const [expanded, setExpanded] = useState(false);
  const containerRef = useRef<HTMLDivElement>(null);

  // 懒加载具体渲染器
  const Renderer = useMemo(() => {
    switch (kind) {
      case 'svg': return SvgRenderer;
      case 'html': return HtmlRenderer;
      case 'pdf': return PdfRenderer;
      case 'docx': return lazyDocx();
      case 'xlsx': return lazyXlsx();
      case 'pptx': return lazyPptx();
      case 'code': return CodeRenderer;
      case 'image': return ImageRenderer;
      case 'video': return VideoRenderer;
      case 'audio': return AudioRenderer;
      case 'csv': return CsvRenderer;
      case 'json': return JsonTreeRenderer;
      case 'markdown': return MarkdownFileRenderer;
      case 'text': return TextRenderer;
      default: return UnknownRenderer;
    }
  }, [kind]);

  return (
    <div ref={containerRef} className="artifact-card my-4 rounded-lg border border-border overflow-hidden">
      <ArtifactToolbar kind={kind} source={source} expanded={expanded} onToggleExpand={() => setExpanded(e => !e)} />
      <div className={clsx('artifact-body', !expanded && 'max-h-[600px] overflow-auto')}>
        <Suspense fallback={<ArtifactLoading />}>
          <Renderer source={source} />
        </Suspense>
      </div>
    </div>
  );
}
```

### 5.4 后端 /convert 端点

```typescript
// src/routes/files.ts 新增
fileRoutes.get('/:jid/files/convert/:path', authMiddleware, async (c) => {
  const jid = c.req.param('jid');
  const encodedPath = c.req.param('path');
  const targetFormat = c.req.query('format') || 'pdf';

  const group = getRegisteredGroup(jid);
  if (!group) return c.json({ error: 'Group not found' }, 404);

  const authUser = c.get('user') as AuthUser;
  if (!canAccessGroup({ id: authUser.id, role: authUser.role }, group)) {
    return c.json({ error: 'Group not found' }, 404);
  }

  try {
    const relativePath = Buffer.from(encodedPath, 'base64url').toString('utf-8');
    const absolutePath = validateAndResolvePath(group.folder, relativePath, getFileRootOverride(group));
    if (!fs.existsSync(absolutePath)) return c.json({ error: 'File not found' }, 404);

    const ext = path.extname(absolutePath).slice(1).toLowerCase();
    if (!['pptx', 'docx', 'xlsx', 'odp', 'ods', 'odt'].includes(ext)) {
      return c.json({ error: 'Unsupported source format for conversion' }, 400);
    }

    const cacheKey = sha256(absolutePath + stats.mtimeMs);
    const cachePath = path.join(CACHE_DIR, `${cacheKey}.${targetFormat}`);
    if (!fs.existsSync(cachePath)) {
      await convertWithLibreOffice(absolutePath, cachePath, targetFormat);
    }

    const stream = Readable.toWeb(fs.createReadStream(cachePath));
    return new Response(stream, {
      headers: {
        'Content-Type': `application/${targetFormat}`,
        'Content-Disposition': `inline; filename="${encodeURIComponent(path.basename(cachePath))}"`,
        'Content-Security-Policy': "default-src 'none'; sandbox",
        'X-Content-Type-Options': 'nosniff',
      },
    });
  } catch (error) {
    logger.error({ err: error }, `Failed to convert file for ${jid}`);
    return c.json({ error: 'Conversion failed' }, 500);
  }
});
```

### 5.5 LibreOffice 转换器

```typescript
// src/office-converter.ts
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import path from 'node:path';
import fs from 'node:fs';
import crypto from 'node:crypto';

const execFileP = promisify(execFile);
const CONVERT_TIMEOUT_MS = 60_000;
const CACHE_DIR = path.join(process.cwd(), 'data/cache/office-preview');

export async function convertToPdf(sourcePath: string): Promise<string> {
  const stat = fs.statSync(sourcePath);
  const hash = crypto.createHash('sha256')
    .update(`${sourcePath}:${stat.mtimeMs}:${stat.size}`)
    .digest('hex');
  const cachePath = path.join(CACHE_DIR, `${hash}.pdf`);
  if (fs.existsSync(cachePath)) return cachePath;

  fs.mkdirSync(CACHE_DIR, { recursive: true });
  const outDir = path.join(CACHE_DIR, `tmp-${hash}`);
  fs.mkdirSync(outDir, { recursive: true });

  // 检测可执行文件名：soffice / libreoffice
  const bin = await detectLibreOfficeBin();

  await execFileP(bin, [
    '--headless',
    '--nologo',
    '--nofirststartwizard',
    '--norestore',
    '--convert-to', 'pdf',
    '--outdir', outDir,
    sourcePath,
  ], { timeout: CONVERT_TIMEOUT_MS, maxBuffer: 10 * 1024 * 1024 });

  const generated = path.join(outDir, path.basename(sourcePath, path.extname(sourcePath)) + '.pdf');
  if (!fs.existsSync(generated)) throw new Error('LibreOffice conversion produced no output');
  fs.renameSync(generated, cachePath);
  fs.rmSync(outDir, { recursive: true, force: true });
  return cachePath;
}

async function detectLibreOfficeBin(): Promise<string> {
  for (const c of ['soffice', 'libreoffice', '/Applications/LibreOffice.app/Contents/MacOS/soffice']) {
    try {
      await execFileP(c, ['--version'], { timeout: 5000 });
      return c;
    } catch {}
  }
  throw new Error('LibreOffice not installed');
}
```

## 6. 错误与降级

| 场景 | 降级策略 |
|------|----------|
| mammoth/xlsx 加载失败 | 显示「渲染库加载失败，请下载原文件」 + 下载按钮 |
| LibreOffice 未安装 | PPTX 显示「服务端未配置 LibreOffice，仅支持下载」+ 下载按钮 |
| 文件不存在（404） | 显示「文件未找到」 |
| 文件过大 | 显示「文件 X MB，点击加载」 |
| HTML 解析失败 | 显示原始代码 + 提示「HTML 解析失败」 |
| PDF Viewer 不可用 | 显示「点击下载查看」 |

## 7. 测试策略

### 7.1 单元测试

| 测试 | 覆盖点 |
|------|--------|
| `EXTENSION_TO_KIND` 映射完整性 | 所有声明的扩展名都能正确映射 |
| `getExt()` 函数 | URL 带查询参数、hash、相对路径 |
| `detectArtifactKind()` | 内联内容路径的语言标签识别 |
| `useArtifactUrl()` | groupJid 替换 #agent: 后缀、base64url 编码 |

### 7.2 集成测试（手动 E2E）

| 场景 | 步骤 |
|------|------|
| SVG 代码块 | AI 输出 ```svg → 验证矢量图渲染 |
| HTML 代码块 | AI 输出 ```html → 验证 sandbox iframe 渲染 + JS 执行 |
| PDF 链接 | AI 输出 `[x.pdf](x.pdf)` → 验证 PDF Viewer |
| DOCX 链接 | 同上，验证 mammoth 转 HTML |
| XLSX 链接 | 同上，验证多 sheet Tab |
| PPTX 链接 | 同上，验证 LibreOffice 转换 |
| 视频链接 | 验证 `<video controls>` + seek |
| CSV 链接 | 验证表格渲染 |
| JSON 链接 | 验证树形 |
| 安全：HTML sandbox | 验证 iframe 内 `document.cookie === ''` |
| 性能：大文件 | 10MB PDF 加载 |

### 7.3 测试入口

启动 dev 服务器后，访问 `http://localhost:5173`，在主对话面板对 AI 发送：
1. 「画一个 SVG 架构图」
2. 「写一个 HTML 拖拽 demo」
3. 「生成一个 PDF 报告并链接给我」
4. 「读取 sales.xlsx 并链接给我」
5. 「写一个 Python 并发示例」

## 8. 实施顺序（10 步）

1. ✅ 创建分支 `feat/chat-artifact-rendering`
2. ✅ PRD 文档
3. ✅ 技术方案文档
4. ⏳ 后端：`src/office-converter.ts` + `/convert` 端点
5. ⏳ 后端：`src/routes/files.ts` 调整 `UNSAFE_PREVIEW_EXTENSIONS` + CSP
6. ⏳ 前端：`web/src/components/chat/artifacts/types.ts`
7. ⏳ 前端：各 Renderer 组件（Svg/Html/Pdf/Docx/Xlsx/Pptx/Code/Media/Csv/Json/Markdown/Text）
8. ⏳ 前端：`ArtifactRenderer` + `ArtifactToolbar`
9. ⏳ 前端：`MarkdownRenderer` 改造（CodeBlock/img/a 路由）
10. ⏳ 安装依赖 + 构建验证 + 测试报告 + 提交

## 9. 依赖与体积

| 库 | 大小（gzip） | 用途 |
|----|--------------|------|
| `mammoth` | ~150KB | DOCX → HTML |
| `xlsx` (SheetJS) | ~250KB | XLSX 解析 |
| `dompurify`（已有） | 0 | HTML 清洗 |
| `highlight.js`（已有） | 0 | 代码高亮 |

**体积影响**：通过 `lazy()` 动态导入，初始 bundle 不增加，仅在用户首次查看 DOCX/XLSX 时加载。

## 10. 回归风险

| 改动 | 风险 | 缓解 |
|------|------|------|
| `UNSAFE_PREVIEW_EXTENSIONS` 移除 html/svg | 现有 `/preview` 对 html 返回 inline，可能 XSS | 严格 CSP + 仍强制 `X-Content-Type-Options: nosniff` |
| MarkdownRenderer 改造 CodeBlock/img/a | 影响所有现有消息渲染 | 保留原有 fallback，仅在 kind 明确时才走 ArtifactRenderer |
| 第三方库动态导入 | 首次加载延迟 | `Suspense` + 友好 loading |
| LibreOffice 安装 | 容器镜像变大 | 可选，PPTX 降级为仅下载 |
