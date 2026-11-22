# 任意书籍 → 2 分钟双语视频生成系统：技术方案

> 版本 v1.0 | 2026-11-22 | 编排层 100% 纯 Python
>
> 关联：[PRD](../prd/book-to-video/PRD.md) | [测试报告](../../test_report/book-to-video/TEST_REPORT.md)

## 1. 架构设计

### 1.1 系统分层

```
┌─────────────────────────────────────────────────────────┐
│                     用户入口                              │
│            python pipeline.py --book book.pdf            │
└────────────────────┬────────────────────────────────────┘
                     │
         ┌───────────▼───────────┐
         │     主编排器           │
         │   pipeline.py         │
         │   断点续跑 + 8 阶段    │
         └───┬───┬───┬───┬───┬──┘
             │   │   │   │   │
    ┌────────┴┐ ┌┴───┴┐ ┌┴───┴────────┐
    │文档解析  │ │LLM │ │TTS 服务层    │
    │parse_book│ │云  │ │tts_server    │
    │pymupdf   │ │端  │ │CosyVoice2    │
    │zipfile   │ │    │ │DashScope降级 │
    └──────────┘ └────┘ └──────────────┘
             │   │   │   │   │
    ┌────────┴┐ ┌┴───┴┐ ┌┴───┴────────┐
    │时间轴    │ │字幕 │ │画面层        │
    │timeline  │ │ASS  │ │visuals       │
    │音频驱动  │ │双语 │ │Pillow+FFmpeg │
    └──────────┘ └─────┘ └──────────────┘
                     │
         ┌───────────▼───────────┐
         │     封装与校验         │
         │   mux.py + ffprobe    │
         │   H.264/AAC MP4       │
         └───────────────────────┘
```

### 1.2 数据流

| 阶段 | 输入 | 输出 | 关键决策 |
|---|---|---|---|
| 1. 解析 | book.pdf/.epub | book.md + figures[] | EPUB→zipfile+BS4，PDF→pymupdf→MinerU VLM |
| 2. 要点 | book.md（≤6000字/块） | digest.json | map-reduce 上云最小化 |
| 3. 脚本 | digest.json | script.json | 强约束 JSON + 3次重试 |
| 4. 时间轴 | script.json + TTS | timeline.json + shot_*.wav | **音频驱动**（非估算）|
| 5. 字幕 | timeline.json | sub.ass | ASS 双 Style，中文20字断屏 |
| 6. 画面 | script.json + figures | silent.mp4 | Pillow 分镜卡 + zoompan |
| 7. 混音 | timeline.json + BGM | mix.wav | adelay + amix + loudnorm |
| 8. 封装 | silent.mp4 + mix.wav + sub.ass | final.mp4 | libass 烧录 + H.264 + faststart |

## 2. 关键技术决策

### 2.1 音频驱动时间轴（而非字数估算）

**问题**：如何保证最终视频正好 120.0 秒？

**方案对比**：

| 方案 | 精度 | 复杂度 | 结论 |
|---|---|---|---|
| 字数估算（4字/秒） | ±20% | 低 | ❌ 克隆音色语速差异大，误差不可接受 |
| **真实合成→ffprobe→atempo** | ±0.5% | 中 | ✅ 以真实音频为基准，atempo 微调对齐 |

**实现**：
1. 每镜先合成真实 wav
2. ffprobe 取实际时长
3. ±10% 内：atempo 微调（不改音调）
4. 超出 ±10%：云端压缩文案重试（最多 2 次）
5. 最终 atempo 精确对齐到 14.0s

### 2.2 TTS 三级降级链路

```
本机 CosyVoice2（零样本克隆）
    ↓ 不可用
DashScope TTS（云端，无克隆）
    ↓ 403/超时
静音占位（字数估算，仅用于管线验证）
```

### 2.3 上云最小化策略

```
全书 70 万字
    ↓ 按语义切块（每块 ≤6000 字）
13 块 × 6000 字 ≈ 78K 字
    ↓ map-reduce → 章节要点（每章 3 个要点）
12 章 × ~200 字 = 2.4K 字
    ↓ 脚本生成
1 次 LLM 调用 × 2.4K 字上下文
    ↓
云端总计 ≈ 80K tokens（含 prompt），不传原文
```

### 2.4 ASS vs SRT 字幕

| 特性 | ASS | SRT |
|---|---|---|
| 字体/颜色/描边 | ✅ 完全控制 | ❌ 依赖播放器 |
| 多语言分层 | ✅ ZH + EN 双 Style | ❌ 混排 |
| 半透明底框 | ✅ BackColour Alpha | ❌ |
| 逐句断屏 | ✅ 精确定时 | ✅ 定时 |
| 兼容性 | libass（FFmpeg 内置） | 所有播放器 |

选择 ASS 做烧录，同时可选生成 SRT 做独立字幕轨。

### 2.5 断点续跑设计

每个阶段的中间产物都落盘为 JSON/文件，二次运行自动跳过：

```
workspace/
├── cache/
│   ├── digest.json      ← 阶段 2 缓存
│   └── script.json      ← 阶段 3 缓存
├── book/book.md         ← 阶段 1 缓存
├── audio/shot_*.wav     ← 阶段 4 缓存
└── timeline.json        ← 阶段 4 输出
```

## 3. 模块详解

### 3.1 parse_book.py

**多后端文档解析**，按优先级自动选择：

1. EPUB：zipfile 解包 + BeautifulSoup（无外部依赖）
2. PDF 文本层：pymupdf（快速，无 GPU）
3. PDF 扫描件：MinerU VLM 后端（需 GPU，可选安装）
4. 章节切块：3 层策略（Markdown 标题 → Chapter 标记 → 长度硬切）

### 3.2 cloud_llm.py

**OpenAI 兼容协议的云端 LLM 客户端**，`base_url` 指向 DashScope 兼容端点。
- 优先使用 `response_format=json_object`（厂商支持时）
- 不支持时退化到提示词约束 + 正则提取
- tenacity 指数退避重试（3 次）
- `_extract_json()` 兼容 markdown 代码块包裹

### 3.3 tts_server.py

**FastAPI 常驻进程**，3 引擎架构：

```
Engine 抽象层
├── CosyVoiceEngine    → 零样本克隆，self.model.inference_zero_shot()
├── GPTSoVITSEngine    → 骨架（需按官方 API 适配）
└── DashScopeTTSEngine  → 云端降级
```

端点：
- `POST /voice/register` — 上传 3-15s 参考音频 + 转写文本 → voice_id
- `POST /tts` — 文本 → 24kHz WAV
- `GET /health` — 引擎状态 + 已注册音色列表
- `DELETE /voice/{id}` — 删除音色

### 3.4 visuals.py

**Pillow 分镜卡 + FFmpeg zoompan 动效**：

1. `render_card()`：Pillow 绘制 1080×1920 分镜卡
   - 底图（模糊书封） + 半透明遮罩
   - accent 色条 + 中文标题（84px 粗体）+ 英文副标题（金色）
   - 要点列表（accent 圆点）+ 页码
2. `animate_zoompan()`：FFmpeg zoompan 做 Ken Burns 缓慢推拉
3. `build_video_track()`：片头（3s）+ 8 镜 × 14s + 片尾（5s）→ concat

### 3.5 audio.py + mux.py

**混音**：adelay 排版 + BGM 10% 音量循环 + amix + loudnorm -16 LUFS
**封装**：libass 烧录 + H.264 CRF 19 + AAC 192k + faststart

## 4. 环境依赖

| 组件 | 版本 | 用途 | 可选 |
|---|---|---|---|
| Python | 3.10+ | 编排 | 否 |
| FFmpeg | 4.4+ | 视频/音频处理 | 否 |
| pymupdf | latest | PDF 文本提取 | 是（可仅 EPUB） |
| openai SDK | latest | 云端 LLM | 否 |
| Pillow | latest | 分镜卡渲染 | 否 |
| CosyVoice2 | 0.5B | 声音克隆 | 是 |
| MinerU | 2.5+ | 扫描件 OCR | 是 |
| PyTorch | 2.x + CUDA | TTS 推理 | 是（TTS 需要） |

## 5. 安全与合规

- 云端只上传章节摘录（每块 ≤6000 字符，总共 <100K tokens）
- 本地 TTS 只监听 127.0.0.1
- 片尾含「本视频由 AI 辅助生成 / 语音为 AI 合成」标识
- API Key 存 .env 不进仓库