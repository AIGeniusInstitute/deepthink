**Languages**: [English](README.md) · [简体中文](README.zh-CN.md) · [Español](README.es.md) · [हिन्दी](README.hi.md) · [العربية](README.ar.md) · [বাংলা](README.bn.md) · [Português](README.pt.md) · [Русский](README.ru.md) · [日本語](README.ja.md) · [Deutsch](README.de.md) · [Français](README.fr.md) · [Bahasa Indonesia](README.id.md) · [اردو](README.ur.md) · [मराठी](README.mr.md) · [తెలుగు](README.te.md) · [Türkçe](README.tr.md) · [தமிழ்](README.ta.md) · [한국어](README.ko.md) · [Tiếng Việt](README.vi.md) · [Italiano](README.it.md) · [Polski](README.pl.md) · [Українська](README.uk.md) · [Nederlands](README.nl.md) · [ไทย](README.th.md) · [ગુજરાતી](README.gu.md) · [Bahasa Melayu](README.ms.md) · [ಕನ್ನಡ](README.kn.md) · [فارسی](README.fa.md) · [Svenska](README.sv.md) · [Čeština](README.cs.md)

<p align="center">
  <img src="web/public/icons/logo-1024.png" alt="DeepThink Logo" width="400" />
</p>

<h1 align="center">DeepThink</h1>

<p align="center">
  Самохостингова багатокористувацька локальна система AI Agent Loop Engineering (десктоп + браузер + мобільні) / На базі AI Genius Institute
</p>

<p align="center">
  <a href="LICENSE"><img src="https://img.shields.io/badge/License-MIT-teal.svg?style=for-the-badge" alt="License" /></a>
  <a href="https://nodejs.org"><img src="https://img.shields.io/badge/Node.js-%3E%3D20-339933?style=for-the-badge&logo=nodedotjs&logoColor=white" alt="Node.js" /></a>
  <img src="https://img.shields.io/badge/TypeScript-5.9-3178C6?style=for-the-badge&logo=typescript&logoColor=white" alt="TypeScript" />
  <a href="https://github.com/AIGeniusInstitute/deep-think/stargazers"><img src="https://img.shields.io/github/stars/AIGeniusInstitute/deep-think?style=for-the-badge&color=f5a623" alt="GitHub Stars" /></a>
</p>

---

## Що таке DeepThink?

DeepThink — це самохостингова, багатокористувацька система AI Agent, побудована на [Claude Agent SDK](https://github.com/anthropics/claude-code/tree/main/packages/claude-agent-sdk). Вона загортає повний рантайм Claude Code у сервіс, доступний через Feishu, Telegram, QQ, DingTalk, WeChat та веб-інтерфейс, з підтримкою читання/запису файлів, операцій у терміналі, автоматизації браузера, багатораундового міркування та екосистеми інструментів MCP.

Головний принцип дизайну: **не пере-реалізовувати здатності Agent, а напряму пере використовувати Claude Code**. Те, що викликається під капотом, — це повний рантайм Claude Code CLI, а не API-обгортка чи ланцюг промптів. Кожне оновлення Claude Code — нові інструменти, сильніше міркування, більше підтримки MCP — автоматично benefiting DeepThink без будь-якої адаптації.

### Ключові особливості

- **Нативно на базі Claude Code** — Побудовано на Claude Agent SDK, підлеглий рантайм — повний Claude Code CLI, успадковує всі здатності
- **Багатокористувацька ізоляція** — Workspace на користувача, IM-канали на користувача, система дозволів RBAC, реєстрація за кодом запрошення, журнал аудиту
- **Єдина маршрутизація шести каналів** — Feishu WebSocket, Telegram Bot API, QQ Bot API v2, DingTalk Stream, WeChat iLink, веб-інтерфейс
- **Балансування навантаження між провайдерами** — кілька провайдерів Claude API, три стратегії (round-robin / weighted / failover) з автоматичною перевіркою здоров'я
- **Білінг та статистика використання** — повна система білінгу (плани підписки, гаманець, коди поповнення), відстеження токенів по моделях з графіками
- **Мобільний PWA** — глибоко оптимізований для мобільних, установка одним кліком на робочий стіл, iOS / Android адаптовані

## Швидкий старт

### Передумови

**Обов'язково**: [Node.js](https://nodejs.org) >= 20, [Docker](https://www.docker.com/) (для режиму контейнера; адміністратору в режимі хоста не потрібен), та ключ Claude API (офіційний Anthropic або сумісний ретрансляційний сервіс).

**Опціонально**: облікові дані корпоративного застосунку Feishu, Telegram Bot Token, облікові дані QQ Bot, облікові дані DingTalk, токен WeChat iLink — лише якщо бажаєте IM-інтеграцій.

> Claude Code CLI не потрібно встановлювати вручну — залежність проєкту Claude Agent SDK вже містить повний рантайм CLI, автоматично встановлюється при першому `make start`.

### Установка та запуск

```bash
# 1. Клонувати репозиторій
git clone https://github.com/AIGeniusInstitute/deep-think.git
cd deepthink

# 2. Запуск однією командою (перший раз встановлює залежності та компілює)
make start
```

Відкрийте http://localhost:3000 і дотримуйтесь майстра налаштування: створіть адміністратора (облікового запису за замовчуванням немає), налаштуйте Claude API та, за бажанням, IM-канали. Уся конфігурація виконується через веб-інтерфейс, без конфігураційних файлів. Ключі API зберігаються зашифрованими через AES-256-GCM.

### Увімкнути режим контейнера

Адміністратор за замовчуванням використовує режим хоста (Docker не потрібен). Якщо потрібен режим контейнера (користувачі member використовують його автоматично після реєстрації):

```bash
./container/build.sh
```

Після реєстрації кожен новий користувач автоматично отримує головний workspace у режимі контейнера (`home-{userId}`), без додаткової конфігурації.

## Огляд архітектури

DeepThink складається з трьох незалежних проєктів Node.js:

- **Бекенд** (Node.js 22 + TypeScript 5.9 + Hono): основний сервіс з маршрутизатором повідомлень (опитування 2с + дедуплікація), чергою конкурентності (до 20 контейнерів + 5 хост-процесів), планувальником завдань (cron / interval / once), WebSocket-сервером для потокової передачі та термінала, автентифікацією bcrypt + HMAC Cookie, RBAC та управлінням конфігурацією з шифруванням AES-256-GCM. Дані в SQLite (режим WAL, схема v1→v33).
- **Фронтенд** (`web/`): React 19 SPA + Vite 6 + Zustand 5 + Tailwind CSS 4 + shadcn/ui, з react-markdown, mermaid, recharts, xterm.js та мобільним PWA.
- **Agent Runner** (`container/agent-runner/`): рушій виконання, що працює всередині Docker-контейнера або як хост-процес; викликає `query()` з Claude Agent SDK, емітує 14 типів StreamEvent та надає 12 інструментів MCP головному процесу через файлові IPC-канали з атомарним записом.

Шість IM-каналів (Feishu, Telegram, QQ, DingTalk, WeChat, Web) надходять у маршрутизатор, дедуплікуються та спрямовуються до черги, яка через ProviderPool обирає ключ API та запускає контейнер або хост-процес. Потокові події транслюються через WebSocket веб-клієнту або надсилаються через IM-API до кожного каналу.

## Повна документація

Повний посібник дивіться тут:

- [Повна англійська версія](README.md)
- [Повна версія 简体中文](README.zh-CN.md)

---

**Languages**: [English](README.md) · [简体中文](README.zh-CN.md) · [Español](README.es.md) · [हिन्दी](README.hi.md) · [العربية](README.ar.md) · [বাংলা](README.bn.md) · [Português](README.pt.md) · [Русский](README.ru.md) · [日本語](README.ja.md) · [Deutsch](README.de.md) · [Français](README.fr.md) · [Bahasa Indonesia](README.id.md) · [اردو](README.ur.md) · [मराठी](README.mr.md) · [తెలుగు](README.te.md) · [Türkçe](README.tr.md) · [தமிழ்](README.ta.md) · [한국어](README.ko.md) · [Tiếng Việt](README.vi.md) · [Italiano](README.it.md) · [Polski](README.pl.md) · [Українська](README.uk.md) · [Nederlands](README.nl.md) · [ไทย](README.th.md) · [ગુજરાતી](README.gu.md) · [Bahasa Melayu](README.ms.md) · [ಕನ್ನಡ](README.kn.md) · [فارسی](README.fa.md) · [Svenska](README.sv.md) · [Čeština](README.cs.md)
