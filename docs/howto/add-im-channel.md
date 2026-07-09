# Howto: 新增 IM 集成渠道

> 从 CLAUDE.md §11 拆分而来。

## 步骤

1. 在 `src/` 目录下创建新的连接工厂模块（参考 `feishu.ts`、`telegram.ts`、`qq.ts` 的接口模式）
2. **在 `src/channel-prefixes.ts` 的 `CHANNEL_PREFIXES` 中添加新渠道的 prefix 条目**（否则 `sendMessage()` 路由会将其识别为非 IM 通道，回复无法送达）
3. 在 `src/im-manager.ts` 中添加 `connectUser{Channel}()` / `disconnectUser{Channel}()` 方法
4. 在 `src/routes/config.ts` 中添加 `/api/config/user-im/{channel}` 路由（GET/PUT）
5. 在 `src/index.ts` 的 `loadState()` 和 `connectUserIMChannels()` 中加载新渠道
6. 前端 `SetupChannelsPage` 和设置页添加新渠道的配置表单
7. 在 `tests/channel-prefixes.test.ts` 的 `ALL_IM_CHANNELS` 数组中添加新渠道名

## 相关文档

- WhatsApp 通道实现细节：`docs/channels/whatsapp.md`
- IM 连接池架构：CLAUDE.md §3.7
