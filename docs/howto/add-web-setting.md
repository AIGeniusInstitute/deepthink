# Howto: 新增 Web 设置项

> 从 CLAUDE.md §11 拆分而来。需要给系统增加新的 Web 可配置项时参考。

## 步骤

1. 在对应的 `src/routes/*.ts` 文件中添加鉴权 API
2. 持久化写入 `data/config/*.json`（参考 `runtime-config.ts` 的加密模式）
3. 前端 `SettingsPage` 增加表单

## 相关

- 环境变量迁移为 Web 可配置：见 `migrate-env-to-web.md`
