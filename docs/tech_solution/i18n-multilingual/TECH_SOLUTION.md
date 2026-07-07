# 技术方案 — DeepThink 国际化（i18n）多语言支持

> 对应 PRD: `docs/prd/i18n-multilingual/PRD.md`
> 分支: `feat/i18n-multilingual`

## 一、总体策略

按 PRD 五大改造项分批实施，**Surgical Changes** 原则：新基础设施 + 新增字段，最小化对既有逻辑的侵入。改造分四批：

- **批次 A（后端存储）**：DB schema + API + zod 校验
- **批次 B（Agent 响应）**：ContainerInput 扩展 + systemPromptAppend 注入
- **批次 C（Web i18n）**：react-i18next 集成 + 30 语言文件 + 语言切换器 UI + 核心路径文案提取
- **批次 D（README 多语言）**：英文版 + 30 语言入口

每批独立可验证，批次 A/B/C 完成后即可端到端测试，批次 D 与代码无关可并行。

## 二、批次 A：后端用户语言偏好存储

### A1. DB Schema 升级

**文件**：`src/db.ts`

- `SCHEMA_VERSION` 当前值（查 `:857-881`）+1
- `CREATE TABLE users` 语句增加 `language TEXT NOT NULL DEFAULT 'zh-CN'`（放在 `ai_avatar_url` 之后）
- `ensureColumn` 迁移分支新增 `language` 字段：
  ```ts
  ensureColumn(db, 'users', 'language', `TEXT NOT NULL DEFAULT 'zh-CN'`);
  ```
- `toUserPublic()`（`:3436-3483`）返回对象新增 `language: user.language ?? 'zh-CN'`

### A2. API 与 zod 校验

**文件 1**：`src/schemas.ts:316-345` `ProfileUpdateSchema`

```ts
const LANGUAGE_CODES = ['zh-CN', 'en', 'es', 'hi', 'ar', 'bn', 'pt', 'ru', 'ja', 'de', 'fr', 'id', 'ur', 'mr', 'te', 'tr', 'ta', 'ko', 'vi', 'it', 'pl', 'uk', 'nl', 'th', 'gu', 'ms', 'kn', 'fa', 'sv', 'cs'] as const;
export type LanguageCode = typeof LANGUAGE_CODES[number];

export const ProfileUpdateSchema = z.object({
  // ... existing fields
  language: z.enum(LANGUAGE_CODES).optional(),
});
```

**文件 2**：`src/routes/auth.ts:565` `PUT /profile`

- 在 `validatedBody` 解构出 `language`
- 在 `:605-619` 的字段写入循环中新增：
  ```ts
  if (language !== undefined) updates.language = language;
  ```
- `updateUserFields()` (`src/db.ts:3760-3845`) 已是通用 column → value 写入，新增字段无需特殊处理

**文件 3**：`src/routes/auth.ts:540` `GET /me` 与 `:86-89` 返回 shape

- `toUserPublic()` 已包含 `language`，无需额外修改

**文件 4**：新增 `src/i18n-languages.ts`（共享常量）

```ts
export const SUPPORTED_LANGUAGES = [
  { code: 'zh-CN', name: '简体中文', native: '简体中文', rtl: false },
  { code: 'en', name: 'English', native: 'English', rtl: false },
  // ... 30 项
] as const;
export const LANGUAGE_CODES = SUPPORTED_LANGUAGES.map(l => l.code) as readonly string[];
export const DEFAULT_LANGUAGE = 'zh-CN';
export function isRtlLanguage(code: string): boolean {
  return SUPPORTED_LANGUAGES.find(l => l.code === code)?.rtl ?? false;
}
```

> schemas.ts 与前端共享此常量：前端 `web/src/i18n/languages.ts` 是 mirror，构建时手动同步（避免引入 monorepo 工具）。

### A3. 测试

- `tests/units/user-language.test.ts` 新增：注册用户默认 `language='zh-CN'`，`PUT /profile { language: 'en' }` 后 `GET /me` 返回 `en`，`PUT /profile { language: 'invalid' }` 返回 400。

## 三、批次 B：Agent 响应语言注入

### B1. ContainerInput 扩展

**文件**：`src/container-runner.ts:201-230`

```ts
export interface ContainerInput {
  // ... existing
  userLanguage?: string;  // 新增，默认 'zh-CN'
}
```

**构造 ContainerInput 的位置**（在 `src/index.ts` 启动容器/进程处，参考 `loadState` 与 `runContainerAgent`）：

- 查询群组 owner 的 `users.language`，注入到 `ContainerInput.userLanguage`
- 群组 owner 通过 `registered_groups.owner_user_id` 或类似字段获取（查 `src/db.ts` `registered_groups` 表）

### B2. Agent Runner 注入

**文件**：`container/agent-runner/src/index.ts:1450`

当前 `systemPromptAppend` 由 `promptPieces` 拼接而成。新增最后一段：

```ts
const userLanguage = input.userLanguage || 'zh-CN';
if (userLanguage !== 'zh-CN' || true) {  // 始终注入，确保显式
  promptPieces.push(`## Response Language Directive

The user's preferred response language is **${userLanguage}**. You MUST respond to the user in ${userLanguage} for all non-code text: explanations, summaries, status updates, error messages, and conversational replies. Tool inputs (file paths, commands, code) remain language-neutral. If the user explicitly requests another language in a message, follow their immediate request for that message only.`);
}
```

> 即便 `userLanguage === 'zh-CN'` 也注入，确保 Agent 显式知道用户语言，行为更稳定。

### B3. 环境变量传递路径

宿主机模式（admin home）：`ContainerInput` 直接传 JSON 到 stdin。
容器模式：环境变量注入到 `data/env/{folder}/env`，但 `userLanguage` 是 per-message 上下文，不应作为环境变量。改为通过 stdin JSON 直接传递（已支持）。

### B4. 测试

- 在 `tests/units/agent-language-injection.test.ts` 验证：`ContainerInput.userLanguage='en'` 时，`systemPromptAppend` 包含 "Response Language Directive" + "en"。
- 不直接调用 agent-runner（需要 SDK），而是抽出 `buildLanguageDirective(userLanguage)` 纯函数到 `container/agent-runner/src/i18n-directive.ts`，单测该函数。

## 四、批次 C：Web i18n 基础设施

### C1. 依赖与目录

**文件**：`web/package.json`

新增依赖：
```json
"i18next": "^23.7.0",
"react-i18next": "^13.5.0",
"i18next-browser-languagedetector": "^7.1.0"
```

**目录**：
```
web/src/i18n/
  config.ts
  languages.ts          # 镜像 src/i18n-languages.ts
  LanguageSection.tsx   # 设置页语言切换组件
  locales/{code}/common.json
```

### C2. i18next 初始化

**文件**：`web/src/i18n/config.ts`

```ts
import i18n from 'i18next';
import { initReactI18next } from 'react-i18next';
import LanguageDetector from 'i18next-browser-languagedetector';

import zhCN from './locales/zh-CN/common.json';
import en from './locales/en/common.json';
// ... 28 个 import

import { DEFAULT_LANGUAGE } from './languages';

i18n
  .use(LanguageDetector)
  .use(initReactI18next)
  .init({
    resources: {
      'zh-CN': { common: zhCN },
      en: { common: en },
      // ...
    },
    fallbackLng: DEFAULT_LANGUAGE,
    ns: ['common'],
    defaultNS: 'common',
    interpolation: { escapeValue: false },
    detection: {
      order: ['localStorage', 'navigator', 'htmlTag'],
      lookupLocalStorage: 'dt_lang',
      caches: ['localStorage'],
    },
  });

export default i18n;
```

**入口**：`web/src/main.tsx` 顶部 `import './i18n/config';`（在 React render 之前）。

### C3. 语言元数据与 RTL

**文件**：`web/src/i18n/languages.ts`

镜像后端 `src/i18n-languages.ts`，导出 `SUPPORTED_LANGUAGES`、`LANGUAGE_CODES`、`DEFAULT_LANGUAGE`、`isRtlLanguage()`。

**RTL 处理**：在 `LanguageSection.tsx` 切换语言时：

```ts
document.documentElement.dir = isRtlLanguage(code) ? 'rtl' : 'ltr';
document.documentElement.lang = code;
```

### C4. 语言切换器 UI

**文件**：`web/src/components/settings/LanguageSection.tsx`

- 渲染下拉，使用 `SUPPORTED_LANGUAGES`（code + 自称 + 中文名）
- onChange:
  1. `i18n.changeLanguage(code)`
  2. `document.documentElement.dir` 与 `lang` 更新
  3. `api.put('/api/auth/profile', { language: code })` 持久化
  4. 更新 auth store 的 `user.language`

**文件**：`web/src/components/settings/SettingsNav.tsx:33`

```ts
{ key: 'language', label: t('settings.language.title'), icon: <Globe className="w-4 h-4" />, group: 'system' },
```

**文件**：`web/src/pages/SettingsPage.tsx:107`

- 增加 `language: t('settings.language.title')` 到 section titles map
- 在 render switch 中增加 `case 'language': return <LanguageSection />;`

### C5. 核心文案提取（首批 key 命名空间）

`web/src/i18n/locales/zh-CN/common.json` 主结构：

```json
{
  "common": {
    "cancel": "取消",
    "confirm": "确认",
    "save": "保存",
    "delete": "删除",
    "edit": "编辑",
    "close": "关闭",
    "loading": "加载中...",
    "retry": "重试",
    "back": "返回",
    "next": "下一步",
    "previous": "上一步"
  },
  "login": {
    "title": "登录",
    "username": "用户名",
    "password": "密码",
    "submit": "登录",
    "register": "注册",
    "errors": { "invalid": "用户名或密码错误", "locked": "账户已锁定" }
  },
  "settings": {
    "language": {
      "title": "语言",
      "description": "选择界面与 Agent 回复语言",
      "selectPlaceholder": "选择语言"
    },
    "appearance": { "title": "全局外观" },
    "profile": { "title": "个人资料" }
    // ... 其他 section 标题
  },
  "chat": {
    "inputPlaceholder": "输入消息，Enter 发送",
    "thinking": "思考中",
    "clearMessages": "清除对话"
  },
  "errors": {
    "networkFailure": "网络请求失败",
    "unknown": "未知错误"
  }
}
```

> 首批约 50-80 个 key。其余字符串保持中文硬编码，后续增量提取。

### C6. 高优先级文件改造清单

按用户路径优先级，改造以下 .tsx 使用 `t()`：

| 文件 | 改造范围 |
|------|---------|
| `web/src/pages/LoginPage.tsx` | 全部文案 |
| `web/src/pages/RegisterPage.tsx` | 全部文案 |
| `web/src/pages/SetupPage.tsx` | 全部文案 |
| `web/src/pages/SettingsPage.tsx` | section 标题、tab 切换 |
| `web/src/components/settings/SettingsNav.tsx` | section labels |
| `web/src/components/settings/LanguageSection.tsx` | 新文件 |
| `web/src/components/chat/MessageInput.tsx` | placeholder、按钮 |
| `web/src/components/chat/ChatView.tsx` | header 文案（思考中、群名后缀） |
| `web/src/components/sidebar/UnifiedSidebar.tsx` | 菜单项 |

> 不改造：`web/src/components/ui/*.tsx`（shadcn 原语，aria-label 后续提取）、`MessageBubble.tsx`（消息内容是 Agent 生成的，不应翻译）。

### C7. Auth store 联动

**文件**：`web/src/stores/auth.ts`

- `User` type 新增 `language: string`
- `updateProfile()` 处理 `language` 字段（已有通用逻辑）
- 应用启动时：`fetchMe()` 拿到 `user.language` → `i18n.changeLanguage(user.language)`，覆盖浏览器探测器

**顺序**：浏览器探测器（localStorage/navigator）→ 应用启动 → `fetchMe()` 返回后用后端持久化值覆盖。

## 五、批次 D：README 多语言

### D1. 现有 README 保留为中文版

```bash
cd ~/deep-think
git mv README.md README.zh-CN.md
```

### D2. 新英文 README.md

新 `README.md` = `README.zh-CN.md` 的英文全量翻译，保持结构一致（7 个 `##` 章节），顶部增加语言切换器表格：

```markdown
**Languages**: [English](README.md) · [简体中文](README.zh-CN.md) · [Español](README.es.md) · [हिन्दी](README.hi.md) · [العربية](README.ar.md) · ... · [+25 more](#languages)
```

### D3. 28 个其他语言版本

每个 `README.{lang}.md` 包含：

```markdown
# DeepThink

> 🌐 介绍 | 快速开始 | 架构 | 完整文档：[English](README.md) | [简体中文](README.zh-CN.md)

[语言切换器表格]

## [Translated: DeepThink 是什么]

[200-300 字翻译：项目定位、Claude Code 驱动、多渠道接入、多用户隔离]

## [Translated: 快速开始]

[翻译：环境要求、make dev 启动、设置向导、首次使用]

## [Translated: 技术架构概览]

[精简翻译：后端模块表、数据流图、容器执行模式]

---

[Translated: 完整文档] [English](README.md) | [简体中文](README.zh-CN.md)
```

每个文件 ~600-800 字翻译。28 个文件总 ~20KB。

### D4. 语言清单索引

在 `README.md` 末尾新增 `## Languages` 章节，列出全部 30 种语言的 code + 自称 + 链接。

## 六、批次 E：测试与验证

### E1. 自动化测试

```bash
make typecheck           # TS 类型检查
npx vitest run           # 单测，新增 2 个测试文件
```

新增测试：
- `tests/units/user-language.test.ts`：DB 字段 + API + zod 校验
- `tests/units/agent-language-injection.test.ts`：`buildLanguageDirective()` 函数

### E2. 手动 UI 测试

1. 启动 `make dev`
2. 登录 → 设置 → 语言 → 切换到 English → 验证界面立即变英文
3. 切换到 العربية → 验证 `<html dir="rtl">` 生效
4. 在聊天页发消息 → 验证 Agent 用英文回复
5. 切换回简体中文 → 验证界面与 Agent 均回到中文
6. 退出登录重新登录 → 验证语言偏好持久化

### E3. README 验证

- `ls README.*.md | wc -l` 应返回 30
- 每个 README 文件 > 200 字符
- `README.md` 顶部语言切换器链接可达

## 七、提交策略

按批次分 commit，最后一次性 PR 合并到 main：

1. `feat: add users.language column and API support (PRD i18n-multilingual)`
2. `feat: inject user language into agent system prompt`
3. `feat: add react-i18next infrastructure and 30 language files`
4. `feat: add language switcher UI in settings`
5. `docs: extract core UI strings to i18n keys (login/setup/chat/settings)`
6. `docs: translate README to English + 30 language versions`
7. `test: add user-language and agent-language-injection tests`
8. `docs: add PRD/tech-solution/test-report for i18n-multilingual`

合并方式：fast-forward 或 squash merge 到 main，最后 push。

## 八、回滚方案

- DB 字段 `language` 新增列，回滚需删除列（SQLite 不支持 DROP COLUMN，需重建表）→ 不回滚 DB
- Web i18n 改动若引发严重问题，回滚前端 commit 即可，后端字段不影响
- README 改动纯文档，可独立回滚

## 九、风险与边界

- **Agent 响应语言不稳定**：Claude 偶发在长对话中漂移回英文。已通过 `must` 指令强化，但不强制每轮重申（避免 prompt 膨胀）。用户可重复纠正。
- **i18next 依赖体积**：~50KB gzipped，可接受。
- **30 个语言文件维护成本**：首批由 LLM 生成，标记 `// AUTO-GENERATED, community-reviewed`，欢迎社区 PR 校正。
- **RTL 布局异常**：ar/ur/fa 三种语言需要测试主要页面的 CSS 反向。Tailwind 已支持 `rtl:` variant，但需逐页验证。

## 十、不做的事

- ❌ 不提取全部 100+ .tsx 文件的字符串（首批仅核心路径）
- ❌ 不翻译 prompt 模板文件（`container/agent-runner/prompts/*.md`）
- ❌ 不引入 SSR i18n
- ❌ 不为每种语言单独维护全量 README
- ❌ 不破坏现有 API（新增字段均为可选，默认值保证向后兼容）
