# Howto: 将环境变量迁移为 Web 可配置

> 从 CLAUDE.md §11 拆分而来。需要把原本靠环境变量控制的开关迁移到 Web 设置页时参考。

## 模式

参考 `runtime-config.ts` 中的 `SystemSettings` 模式：file → env → default 三级 fallback。

## 步骤

1. 在 `runtime-config.ts` 的 `SystemSettings` 接口添加字段
2. 在 `getSystemSettings()` 中实现 file → env → default 三级 fallback
3. 在 `saveSystemSettings()` 中添加范围校验
4. 在 `schemas.ts` 的 `SystemSettingsSchema` 添加 zod 校验
5. 前端 `SystemSettingsSection.tsx` 的 `fields` 数组添加表单项
