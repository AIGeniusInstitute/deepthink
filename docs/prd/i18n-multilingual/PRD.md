# DeepThink 国际化（i18n）多语言支持

> 需求 ID: i18n-multilingual
> 分支: `feat/i18n-multilingual`（基于 main）
> 创建日期: 2026-07-07

## 一、需求背景

DeepThink 当前所有用户可见文案（Web 界面、README、Agent 响应）均为简体中文，对非中文用户不可用。作为面向全球开源的自托管 AI Agent 系统，需要：

1. **Web 界面**支持全球最常用的 30 种语言切换，默认中文
2. **Agent 响应**使用用户选择的语言回复
3. **README** 默认英文，并提供 30 种语言版本入口

## 二、目标（Goal-Driven）

建立端到端 i18n 基础设施，让用户可一键盘切换界面语言，Agent 响应语言随用户偏好联动，README 对国际开发者友好。

### 成功标准（可验证）

1. ✅ `users` 表新增 `language` 字段（TEXT，默认 `zh-CN`），`GET /api/auth/me` 与 `PUT /api/auth/profile` 支持读写
2. ✅ `language` 字段值在白名单 30 种语言代码内（zod 校验）
3. ✅ Agent runner 启动时通过 `ContainerInput.userLanguage` 接收用户语言，并在 `systemPromptAppend` 中注入"使用该语言回复"指令
4. ✅ Web 前端集成 `react-i18next`，提供 30 个语言资源文件，含核心用户路径文案
5. ✅ 设置页新增"语言"区块，下拉切换 30 种语言，切换后立即生效并持久化
6. ✅ 未登录/未设置时，按浏览器语言探测（i18next-browser-languagedetector），fallback 为 `zh-CN`
7. ✅ `README.md` 改为英文（默认），顶部语言切换器链接到 30 种语言版本；`README.zh-CN.md` 保留中文全量；其余 28 种语言 `README.{lang}.md` 提供翻译版（介绍 + 快速开始 + 架构概览 + 链接到完整英文版）
8. ✅ `make typecheck` 通过，`npx vitest run` 不引入新失败
9. ✅ 默认语言（中文）行为与改造前完全等价（向后兼容）

## 三、30 种语言清单

按全球总使用人数 + 互联网影响力排序，覆盖 ISO 639-1 主流语种：

| # | code | 中文 | 自称 |
|---|------|------|------|
| 1 | zh-CN | 简体中文 | 简体中文 |
| 2 | en | 英文 | English |
| 3 | es | 西班牙文 | Español |
| 4 | hi | 印地文 | हिन्दी |
| 5 | ar | 阿拉伯文 | العربية |
| 6 | bn | 孟加拉文 | বাংলা |
| 7 | pt | 葡萄牙文 | Português |
| 8 | ru | 俄文 | Русский |
| 9 | ja | 日文 | 日本語 |
| 10 | de | 德文 | Deutsch |
| 11 | fr | 法文 | Français |
| 12 | id | 印尼文 | Bahasa Indonesia |
| 13 | ur | 乌尔都文 | اردو |
| 14 | mr | 马拉地文 | मराठी |
| 15 | te | 泰卢固文 | తెలుగు |
| 16 | tr | 土耳其文 | Türkçe |
| 17 | ta | 泰米尔文 | தமிழ் |
| 18 | ko | 韩文 | 한국어 |
| 19 | vi | 越南文 | Tiếng Việt |
| 20 | it | 意大利文 | Italiano |
| 21 | pl | 波兰文 | Polski |
| 22 | uk | 乌克兰文 | Українська |
| 23 | nl | 荷兰文 | Nederlands |
| 24 | th | 泰文 | ไทย |
| 25 | gu | 古吉拉特文 | ગુજરાતી |
| 26 | ms | 马来文 | Bahasa Melayu |
| 27 | kn | 卡纳达文 | ಕನ್ನಡ |
| 28 | fa | 波斯文 | فارسی |
| 29 | sv | 瑞典文 | Svenska |
| 30 | cs | 捷克文 | Čeština |

> RTL 语言（ar, ur, fa）需在 `web/src/i18n/config.ts` 标记 RTL，并通过 `<html dir="rtl">` 切换文档方向。

## 四、五大改造项

### 1. 后端：用户语言偏好存储

**新增 `users.language` 列**（TEXT NOT NULL DEFAULT 'zh-CN'）。
- `src/db.ts` `SCHEMA_VERSION` +1，新增 `ensureColumn` 迁移
- `toUserPublic()` (`src/db.ts:3436-3483`) 返回 `language`
- `ProfileUpdateSchema` (`src/schemas.ts:316-345`) 增加可选 `language` 字段，zod enum 校验 30 种 code
- `PUT /api/auth/profile` (`src/routes/auth.ts:565`) 处理 `language` 字段，调用 `updateUserFields()`

### 2. Agent 响应语言注入

**`ContainerInput` 扩展**：新增 `userLanguage?: string` 字段（默认 `zh-CN`）。
- `src/container-runner.ts:201-230` 类型定义
- 启动容器/进程时，从群组 owner 的 `users.language` 读取并注入

**`agent-runner/src/index.ts:1450` 系统提示词注入**：
```
You must respond to the user in {{userLanguage}}. All non-code text in your replies (explanations, summaries, error messages, status updates) must be in {{userLanguage}}. Tool inputs like file paths and commands remain language-neutral.
```
追加到 `promptPieces` 数组末尾，作为新的 `language-directive.md` 文件，或直接 inline 到 `systemPromptAppend` 字符串。

### 3. Web 前端 i18n 基础设施

**依赖**：`i18next`, `react-i18next`, `i18next-browser-languagedetector`（添加到 `web/package.json`）

**目录结构**：
```
web/src/i18n/
  config.ts                          # i18next 初始化（detectors + fallback）
  languages.ts                       # 30 种语言的元数据（code/name/native/RTL）
  locales/
    zh-CN/common.json               # 完整 key 集合
    en/common.json
    ... (共 30 个)
```

**Key 命名约定**：`section.subsection.key`，例如 `login.submitButton`、`settings.language.title`、`chat.inputPlaceholder`、`common.cancel`、`common.confirm`、`errors.networkFailure`。

**核心覆盖范围**（首批提取）：
- 登录/注册/设置向导（`LoginPage.tsx`, `RegisterPage.tsx`, `SetupPage.tsx`, `SetupProvidersPage.tsx`, `SetupChannelsPage.tsx`）
- 设置页（`SettingsPage.tsx`, `SettingsNav.tsx`, `ProfileSection.tsx`, `AppearanceSection.tsx`, 新增 `LanguageSection.tsx`）
- 聊天主界面（`ChatPage.tsx`, `ChatView.tsx`, `MessageInput.tsx`, `UnifiedSidebar.tsx`, `MessageBubble.tsx`）
- 通用 UI 原语（`Button`, `Modal`, `Toast` 中的硬编码文案）
- 错误提示与状态文案（`errors.*`, `status.*`）

**未提取的字符串**：保持中文，后续增量迁移。i18n 基础设施就位后无破坏性。

### 4. 语言切换器 UI

**新文件**：`web/src/components/settings/LanguageSection.tsx`
- 下拉选择 30 种语言，使用 `languages.ts` 的元数据渲染
- 切换后立即调用 `i18n.changeLanguage(code)`
- 同时通过 `PUT /api/auth/profile` 持久化到后端
- 显示语言 code + 自称 + 中文名（便于识别）

**`SettingsNav.tsx`** 新增 `{ key: 'language', label: t('settings.language.title'), icon: <Globe />, group: 'system' }`，放在 `appearance` 之后。

### 5. README 多语言版本

**改动**：
- 现有 `README.md` → 重命名为 `README.zh-CN.md`（保留中文全量）
- 新 `README.md` = 英文全量翻译（默认对外版本）
- 新增 28 个 `README.{lang}.md`：每个文件包含
  - 顶部语言切换器（链接到所有 30 个版本）
  - 项目简介翻译（约 200 字）
  - 快速开始翻译（约 300 字）
  - 核心架构概览翻译（约 200 字）
  - 链接到 `README.md`（完整英文版）和 `README.zh-CN.md`（完整中文版）
- `README.md` 顶部新增语言切换器表格

## 五、向后兼容性

- 默认 `language='zh-CN'`：所有现有用户行为不变
- 现有 API 不破坏（新增字段为可选）
- 现有 Web 用户首次加载时，浏览器探测器若返回 zh-CN，行为与现状等价
- Agent 在用户未设置语言时，注入 `zh-CN`，行为与现状等价

## 六、不做的事（Out of scope）

- ❌ 不提取 `web/src/components/ui/*.tsx` shadcn 原语中所有 aria-label（首批只覆盖核心用户路径）
- ❌ 不翻译 `container/agent-runner/prompts/*.md` 提示词模板本身（仅注入响应语言指令）
- ❌ 不做邮件 / IM 推送文案的多语言（IM 渠道消息体由 Agent 生成，已随 Agent 语言联动）
- ❌ 不为每种语言单独维护一份完整 README（仅英文与中文为全量，其余为摘要版）
- ❌ 不引入服务端渲染（SSR）i18n（保持纯客户端 i18n）

## 七、风险评估

| 风险 | 等级 | 缓解措施 |
|------|------|---------|
| i18next 依赖体积（~50KB gzipped） | 低 | 仅在 web bundle，按需加载语言文件 |
| 30 个语言文件的翻译质量 | 中 | 首批由 LLM 生成，后续社区 PR 校正；保留中文/英文为权威版本 |
| RTL 语言（ar/ur/fa）布局异常 | 中 | 切换 `dir="rtl"`，测试 ar 语言下的设置页与聊天页 |
| Agent 响应语言不稳定（偶发英文） | 低 | 提示词指令为"must"，且用户可重复纠正；不影响功能 |
| 30 种语言 code 在 zod enum 内拼写错误 | 低 | 用 TypeScript `as const` 推导，单测覆盖 |

## 八、验收清单

- [ ] DB schema 升级成功（重置 init 后 `users.language` 字段存在）
- [ ] `GET /api/auth/me` 返回 `language` 字段
- [ ] `PUT /api/auth/profile { language: 'en' }` 持久化成功，无效 code 返回 400
- [ ] Agent runner 日志可见注入的 `userLanguage` 指令
- [ ] 切换语言后，Web 界面登录页/设置页/聊天页文案立即切换
- [ ] 阿拉伯语切换后 `<html dir="rtl">` 生效
- [ ] `README.md` 为英文，`README.zh-CN.md` 为中文，其余 28 个文件存在且非空
- [ ] `make typecheck` 通过
- [ ] `npx vitest run` 通过率 ≥ main 基线
