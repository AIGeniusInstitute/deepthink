# PPTX 产物预览报错 `LibreOffice produced no output file`

- **日期**：2026-07-23
- **类型**：线上功能 Bug / 基础设施层
- **影响面**：聊天产物文件列表中所有 Office 演示文稿（`.pptx` / `.odp`）及表格（`.xlsx` / `.ods`）无法预览，点击报 500。`.docx` / `.txt` 预览正常。
- **状态**：已修复并验证

## 1. 用户现象

在 DeepThink Agent 的产物文件列表中点击 `.pptx` 产物，PDF 预览加载失败，浏览器控制台看到：

```
GET http://localhost:9999/api/groups/web:main/files/convert/ZG9jcy9pbnRlcnZpZXcvQUnnn6Xor4blt6XnqIvmlrnlkJFf5rex5bqm6Z2i6K-V6aKY5bqTX-mZiOWFieWJkS5wcHR4 500 (Internal Server Error)
```

响应体：

```json
{"error":"LibreOffice produced no output file"}
```

## 2. 问题描述

DeepThink 对 Office 文档走「服务端 LibreOffice headless 转 PDF 后内联预览」的链路：

- 前端 `GET /api/groups/:jid/files/convert/:base64urlPath`
- 路由 `src/routes/files.ts` 解码路径、鉴权后调用 `convertToPdf()`（`src/office-converter.ts`）
- `convertToPdf()` 以 `soffice --headless --convert-to pdf --outdir <tmp> <file>` 生成 PDF

本次 `soffice` 进程 **退出码为 0**，但 `--outdir` 目录里没有生成 `.pdf`，于是代码抛出 `LibreOffice produced no output file`，路由以 500 返回该消息。

关键点：LibreOffice 退出码 0，所以 `execFile` 不 reject，代码无法感知失败原因——LibreOffice 真正的报错 `Error: source file could not be loaded` 被丢弃了。

## 3. 根因

**基础设施层：服务器上的 LibreOffice 安装缺失 Impress / Draw / Calc 模块。**

`libreoffice-impress`、`libreoffice-draw`、`libreoffice-calc` 三个包处于 `rc` 状态（已卸载、仅剩配置文件），其核心库 `libsdlo.so`（Impress/Draw 共用，sd = StarDraw）和 `libsclo.so`（Calc）随之消失。`libreoffice-writer` 完好（`libswlo.so` 存在）。

证据链（命令输出摘录）：

```
$ dpkg -s libreoffice-impress | grep Status
Status: deinstall ok config-files          # 已卸载

$ dpkg -l | grep -i libreoffice | awk '{print $1,$2}'
rc libreoffice-calc
rc libreoffice-draw
rc libreoffice-impress                     # rc = removed, config-files
ii libreoffice-writer                       # writer 仍在

$ ls /usr/lib/libreoffice/program/libsdlo.so
ls: cannot access ...: No file or directory # Impress 核心库缺失
$ ls /usr/lib/libreoffice/program/libswlo.so   # writer 核心库在
... OK
```

逐格式复现，确认是「Impress 模块整体不可用」，而非文件损坏或 OOXML 过滤器问题：

| 源文件 | 走的模块 | 转换结果 |
|---|---|---|
| `t.txt` → pdf | writer | ✅ 成功（`writer_pdf_Export`） |
| `min-hand.docx`（手构最小 OOXML）→ pdf | writer OOXML 导入 | ✅ 成功 |
| `min.odp`（手构最小 ODF 演示）→ pdf | **impress** | ❌ `source file could not be loaded` |
| 任意 `.pptx` → pdf | **impress OOXML 导入** | ❌ `source file could not be loaded` |

即便用 `python-pptx` 生成的最小合法 pptx 也失败，证明与具体文件无关——LibreOffice 根本无法实例化 `com.sun.star.presentation.PresentationDocument`。

> 外部依据：`soffice` 对应的演示文稿服务依赖 `libsdlo.so`（Debian/Ubuntu 中由 `libreoffice-impress` / `libreoffice-draw` 提供）。该库缺失时，任何 Presentation 类型文档加载都会在导入阶段失败并打印 `Error: source file could not be loaded`，退出码仍为 0。

## 4. 复现路径

1. 在缺失 Impress 模块的环境下，确保 DeepThink 服务运行（默认 9999 端口，`DATA_DIR=~/.deepthink-9999`）。
2. 在某 group 目录下放一个 `.pptx`，例如：
   `~/.deepthink-9999/groups/main/docs/interview/AI知识工程方向_深度面试题库_陈光剑.pptx`
3. base64url 编码相对路径：
   ```bash
   python3 -c "import base64;print(base64.urlsafe_b64encode('docs/interview/AI知识工程方向_深度面试题库_陈光剑.pptx'.encode()).decode())"
   # ZG9jcy9pbnRlcnZpZXcvQUnnn6Xor4blt6XnqIvmlrnlkJFf5rex5bqm6Z2i6K-V6aKY5bqTX-mZiOWFieWJkS5wcHR4
   ```
4. 前端点击该 pptx 产物 → 预览请求命中 `/api/groups/web:main/files/convert/<enc>` → 500。
5. 服务端等价命令直接复现（无需走 HTTP）：
   ```bash
   soffice --headless --nologo --nofirststartwizard --norestore \
     -env:UserInstallation=file:///tmp/lo-prof \
     --convert-to pdf --outdir /tmp/out \
     ~/.deepthink-9999/groups/main/docs/interview/AI知识工程方向_深度面试题库_陈光剑.pptx
   # 输出：Error: source file could not be loaded   (退出码 0，/tmp/out 为空)
   ```

## 5. 诊断方法

```bash
# (1) 各 LibreOffice 模块包状态——若 impress/calc/draw 不是 ii 即为根因
dpkg -l | grep -i libreoffice | awk '{print $1,$2}'

# (2) 关键库是否存在
for L in libsdlo.so libsclo.so libswlo.so; do
  test -e /usr/lib/libreoffice/program/$L && echo "OK $L" || echo "MISSING $L"
done

# (3) 最小复现（先用 odp/pptx 定位是否 impress 整体挂掉，再用 docx/txt 对照）
echo hello > /tmp/t.txt
soffice --headless -env:UserInstallation=file:///tmp/lo-prof \
  --convert-to pdf --outdir /tmp/out /tmp/t.txt
# writer 正常 → 说明 core 没问题，问题在 impress 模块

# (4) 看 LibreOffice 真实报错（必须捕获 stdout/stderr，退出码不可靠）
soffice --headless -env:UserInstallation=file:///tmp/lo-prof \
  --convert-to pdf --outdir /tmp/out <某个pptx> 2>&1
# 出现 "Error: source file could not be loaded" 即导入阶段失败
```

服务端日志：DeepThink 端 500 时 `logger.error({ err }, 'Failed to convert file for ...')`，但修复前 err.message 只有 `LibreOffice produced no output file`，不含 LibreOffice 真实报错——这正是本次代码改进要解决的（见第 6 节）。

## 6. 修复方案

两层修复：**基础设施层（根因）** + **代码层（诊断能力）**。

### 6.1 基础设施层（根因修复）

重装缺失的 LibreOffice 模块：

```bash
sudo apt-get install -y libreoffice-impress libreoffice-draw libreoffice-calc
```

执行后验证：

```
Status: install ok installed          # libreoffice-impress 恢复
libsdlo.so OK                         # 核心库回归
```

清理之前损坏状态下残留的 LibreOffice profile（避免脏状态影响首次转换）：

```bash
rm -rf ~/.deepthink-9999/cache/office-preview/profile
rm -rf ~/.deepthink-9999/cache/office-preview/tmp-*
```

> 注：无需重启 DeepThink 服务。`convertToPdf` 每次通过 `execFile` 拉起全新 `soffice` 进程，不存在常驻 LO 进程；库装好即可生效。

### 6.2 代码层（诊断能力，`src/office-converter.ts`）

根因排查之所以费时，核心原因是：LibreOffice 退出码 0 + 代码丢弃 stdout/stderr，导致真正的报错 `Error: source file could not be loaded` 被吞成一句无法定位的 `LibreOffice produced no output file`。

**选型理由**：不新增任何「检测 Impress 模块缺失」的特判逻辑（脆弱、易过拟合）。改动只做一件事——把 LibreOffice 的真实输出带出来：非零退出捕获 `.stderr`；退出 0 但无输出文件时把 `stderr`/`stdout` 写进日志并并入错误消息透传。Surgical，零行为变更（成功路径完全不变）。

```diff
   try {
-    await execFileP(
-      bin,
-      [
-        '--headless',
-        '--nologo',
-        '--nofirststartwizard',
-        '--norestore',
-        '-env:UserInstallation=file://' + path.join(CACHE_DIR, 'profile'),
-        '--convert-to', 'pdf',
-        '--outdir', tmpOutDir,
-        sourcePath,
-      ],
-      { timeout: CONVERT_TIMEOUT_MS, maxBuffer: MAX_BUFFER },
-    );
-
+    let stdout = '';
+    let stderr = '';
+    try {
+      ({ stdout, stderr } = await execFileP(
+        bin,
+        [
+          '--headless',
+          '--nologo',
+          '--nofirststartwizard',
+          '--norestore',
+          '-env:UserInstallation=file://' + path.join(CACHE_DIR, 'profile'),
+          '--convert-to', 'pdf',
+          '--outdir', tmpOutDir,
+          sourcePath,
+        ],
+        { timeout: CONVERT_TIMEOUT_MS, maxBuffer: MAX_BUFFER },
+      ));
+    } catch (err) {
+      const detail = (err as { stderr?: string }).stderr || String(err);
+      logger.error({ err, detail }, 'LibreOffice pdf conversion failed (non-zero exit)');
+      throw new Error(`LibreOffice conversion failed: ${detail.slice(0, 500)}`);
+    }
+
     const baseName = path.basename(sourcePath, path.extname(sourcePath));
     const generated = path.join(tmpOutDir, `${baseName}.pdf`);
     if (!fs.existsSync(generated)) {
-      throw new Error('LibreOffice produced no output file');
+      const detail = (stderr || stdout || '').trim();
+      logger.error({ detail, sourcePath }, 'LibreOffice produced no output file');
+      throw new Error(
+        detail
+          ? `LibreOffice produced no output file (${detail.slice(0, 500)})`
+          : 'LibreOffice produced no output file',
+      );
     }
     fs.renameSync(generated, cachePath);
     return cachePath;
   } finally {
     fs.rmSync(tmpOutDir, { recursive: true, force: true });
   }
 }
```

`convertHtmlToOffice()` 同一模式的 `produced no output file` 分支做同样处理（diff 略，见 commit）。

## 7. 处理卡住的状态（如适用）

本次无 stuck 的 Agent 运行态需救活。但有两类「脏状态」值得清理：

- **LibreOffice profile 脏**：损坏期间 profile 可能积累异常状态。处理：`rm -rf <office-preview>/profile`（代码会自动重建）。
- **失败请求的缓存**：无影响——`convertToPdf` 只在成功路径写缓存（`<sha>.pdf`），失败不残留。验证 `cache/office-preview/` 下无 `.pdf` 即可确认。

## 8. 经验沉淀 / 预防

1. **LibreOffice 退出码不可信**：headless `--convert-to` 即使加载失败也常返回 0。任何封装 LibreOffice 的代码都必须捕获 stdout/stderr 并据此判定成败，不能只看退出码或产物是否存在。
2. **环境漂移监控**：DeepThink 预览依赖系统 `libreoffice-*` 包。建议：
   - 巡检脚本（可纳入健康检查）：
     ```bash
     #!/bin/bash
     # /usr/local/bin/deepthink-lo-health.sh
     for p in libreoffice-core libreoffice-writer libreoffice-impress libreoffice-calc; do
       dpkg -s "$p" 2>/dev/null | grep -q "^Status: install ok installed" \
         || echo "WARN: $p not installed correctly"
     done
     test -e /usr/lib/libreoffice/program/libsdlo.so || echo "CRIT: libsdlo.so missing (impress)"
     test -e /usr/lib/libreoffice/program/libsclo.so || echo "CRIT: libsclo.so missing (calc)"
     ```
   - 已有端点 `GET /api/groups/:jid/files/libreoffice-status` 只判断 `soffice --version` 可执行——**不足以发现模块缺失**（`soffice --version` 在 impress 卸载后仍正常）。建议后续增强该端点：对 impress/calc 做一次最小转换探活，缺失模块时返回 `module_missing` 降级提示（独立 issue 跟进，不在本次范围内）。
3. **apt 卸载需谨慎**：`libreoffice-impress` / `libreoffice-draw` / `libreoffice-calc` 同时被卸载多半来自某次 `apt autoremove` 或手动 `apt remove`。建议生产环境对这些包 `apt-mark manual`，防止被 autoremove 误清。
```
