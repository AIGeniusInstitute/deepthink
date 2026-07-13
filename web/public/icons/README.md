# PWA Icons

## 自动生成

PNG 图标通过 `npm run generate-icons` 从 SVG 源文件自动生成。构建时会自动运行此脚本。

## 图标规格

- `icon-192.svg` → `icon-192.png`: 192x192px, 用于 Android 设备
- `icon-512.svg` → `icon-512.png`: 512x512px, 用于高分辨率设备和启动画面

## 自定义图标

如需更新图标：

1. 编辑 `icon-192.svg` 和 `icon-512.svg`
2. 运行 `npm run generate-icons` 重新生成 PNG
3. 或使用设计工具（Figma、Sketch）创建专业图标，直接替换 PNG 文件
