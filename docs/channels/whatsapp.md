# WhatsApp 通道（基于 Baileys）

> 本文档从 `CLAUDE.md` §8.13 拆分而来。修改 / 新增 WhatsApp 相关代码时请同步更新。
>
> 顶层 `CLAUDE.md` 只在 §2.1 后端模块表里保留 `src/whatsapp.ts` 一行入口；详细架构按需 Read 本文档。

为响应海外用户使用 WhatsApp 的需求，集成 `@whiskeysockets/baileys`（社区维护的 WhatsApp Web 协议逆向库，Meta 官方未授权）。

## 登录与连接

- `useMultiFileAuthState` 把 noise 密钥 / Signal pre-keys 等持久化到 `data/config/user-im/{userId}/whatsapp-auth/{accountId}/`，重启后无需重新扫码
- `connection.update` 事件把 `qr`/`open`/`close` 三种状态转换成 `WhatsAppConnectionState` `{ status, qr, qrDataUrl, error, meJid, meName }`，QR 串通过 `qrcode` render 为 PNG data URL
- 状态走 `onConnectionUpdate` 回调 → `broadcastWhatsAppStatus(userId, state)` → `whatsapp_status` WS 事件推到前端 `WhatsAppChannelCard`
- 自动重连：非 `loggedOut` 断线延迟 3s 重连；`loggedOut` 不重连（避免 QR 风暴），由用户在前端手动重新启用
- `getUserWhatsAppState(userId)` 缓存最近一次 state，前端刷新页面后通过 `GET /api/config/user-im/whatsapp` 拿回当前 QR

## 消息接收（`messages.upsert` event）

- 跳过 `type !== 'notify'`（history sync 不重跑）、`fromMe`、`status@broadcast` / `@newsletter`
- `ignoreMessagesBefore` 过滤断线重连后的堆积消息
- `extractMessageText` 支持 `conversation` / `extendedTextMessage` / `ephemeralMessage` 嵌套 / `viewOnceMessage` 嵌套，以及 `image/video/document` 的 caption 字段
- 媒体消息（image/video/audio/document）走 `tryHandleMediaMessage`：`downloadMediaMessage(msg, 'buffer', ...)` 取二进制 → `saveDownloadedFile(folder, 'whatsapp', name, buf)` 保存到 `data/groups/{folder}/downloads/whatsapp/{YYYY-MM-DD}/`，content 文本格式 `[图片: downloads/whatsapp/.../wa_image_xxx.jpg]\n可选 caption`
- 小图片（≤5MB）同时输出 base64 `attachments` 字段供 Vision API 消费
- 群组（`@g.us`）vs DM（`@s.whatsapp.net`）jid 识别，`participant` 作为群组消息 senderId
- `sock.groupMetadata(jid)` 异步获取真实群名（首次遇到时，缓存到 `groupNameCache` 防止重复请求）

## 群聊门控

与 feishu / discord 一致：

- `isSenderAllowedInGroup(chatJid, senderImId)` 发言者白名单，false 则丢弃
- `shouldProcessGroupMessage(chatJid, senderImId)` 配合 `isMentioningBot(content, sock.user.id)`：bot 未被 @ 且该 hook 返回 false 则丢弃（require_mention 模式）
- `isGroupOwnerMessage(chatJid, senderImId)`：bot 被 @ 但发送者非 owner 时丢弃（owner_mentioned 模式）
- mention 检测：从 `extendedTextMessage.contextInfo.mentionedJid` / `imageMessage.contextInfo.mentionedJid` 等取 jid 列表，与 `jidNormalizedUser(sock.user.id)` 比对（去除 device 后缀）

## 消息发送

- `sendMessage` 走 `markdownToPlainText` + `splitTextChunks(4096)`（与 dingtalk/wechat/qq 一致），分片消息追加 `(i/N)` 标记
- 局部图片附件：`sendMessage` 第三参 `localImagePaths` 循环 `readFile` → `guessMimeType` 推断 → `sock.sendMessage({ image, mimetype })`
- `sendImage`：`sock.sendMessage({ image: Buffer, mimetype, caption, fileName })`
- `sendFile`：`fs.readFile` filePath → `sock.sendMessage({ document: Buffer, mimetype: guessMimeType(name), fileName })`
- `sendTyping`：`sock.sendPresenceUpdate('composing'|'paused', jid)`

## 群组事件（`group-participants.update`）

- `action='add'` 且 participants 包含 bot self jid → `onBotAddedToGroup(chatJid, chatName)`，bot 名取自 `sock.groupMetadata().subject`
- `action='remove'` 且 participants 包含 bot self jid → `onBotRemovedFromGroup(chatJid)`

## 风险提示

Baileys 是社区逆向工程的 WhatsApp Web 协议库，Meta 在 2025-2026 收紧识别（握手时序、加密时序），封号率显著上升。同 OpenClaw / Wechaty puppet 等同类逆向方案共享相同风险。商用场景应使用 Meta 官方 Cloud API（需要 Facebook Business 验证、按模板消息计费）。
