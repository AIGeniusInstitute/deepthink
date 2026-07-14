**Languages**: [English](README.md) · [简体中文](README.zh-CN.md) · [Español](README.es.md) · [हिन्दी](README.hi.md) · [العربية](README.ar.md) · [বাংলা](README.bn.md) · [Português](README.pt.md) · [Русский](README.ru.md) · [日本語](README.ja.md) · [Deutsch](README.de.md) · [Français](README.fr.md) · [Bahasa Indonesia](README.id.md) · [اردو](README.ur.md) · [मराठी](README.mr.md) · [తెలుగు](README.te.md) · [Türkçe](README.tr.md) · [தமிழ்](README.ta.md) · [한국어](README.ko.md) · [Tiếng Việt](README.vi.md) · [Italiano](README.it.md) · [Polski](README.pl.md) · [Українська](README.uk.md) · [Nederlands](README.nl.md) · [ไทย](README.th.md) · [ગુજરાતી](README.gu.md) · [Bahasa Melayu](README.ms.md) · [ಕನ್ನಡ](README.kn.md) · [فارسی](README.fa.md) · [Svenska](README.sv.md) · [Čeština](README.cs.md)

<p align="center">
  <img src="web/public/icons/logo-1024.png" alt="DeepThink Logo" width="400" />
</p>

<h1 align="center">DeepThink</h1>

<p align="center">
  Самохостована багатокористувацька локальна система AI Agent Loop Engineering (десктоп + браузер + мобільний) / Powered By AI Genius Institute
</p>

<p align="center">
  <a href="LICENSE"><img src="https://img.shields.io/badge/License-MIT-teal.svg?style=for-the-badge" alt="License" /></a>
  <a href="https://nodejs.org"><img src="https://img.shields.io/badge/Node.js-%3E%3D20-339933?style=for-the-badge&logo=nodedotjs&logoColor=white" alt="Node.js" /></a>
  <img src="https://img.shields.io/badge/TypeScript-5.9-3178C6?style=for-the-badge&logo=typescript&logoColor=white" alt="TypeScript" />
  <a href="https://github.com/AIGeniusInstitute/deep-think/stargazers"><img src="https://img.shields.io/github/stars/AIGeniusInstitute/deep-think?style=for-the-badge&color=f5a623" alt="GitHub Stars" /></a>
</p>

---

<p align="center">
  <video src="static/deep-think-intro.mp4" 
    poster="static/deep-think-start-logo.png" controls width="800"></video>
</p>


## Що таке DeepThink

DeepThink — корпоративна платформа самоеволюції автономного Agent-суперінтелекту, піонер переходу від парадигми Harness Engineering до Loop Engineering, нове покоління AI-інфраструктури (AI Infra) для корпоративних клієнтів. Платформа DeepThink побудована навколо фреймворку багато-Agent-взаємодії, поєднуючи AI Coding, Self-Evolving, Full-Stack Observability, Bug Auto-Fix Loop та Human-Agent Symbiosis для створення корпоративної AI-системи, що безперервно навчається, самовдосконалюється і зрештою виростає до суперінтелекту:

- **Платформа автономної AI-розробки** — Agent самостійно проходить повний життєвий цикл розробки ПЗ, усуваючи потребу в людях-інженерах для рутинних завдань кодування
- **Движок самоеволюційного Agent** — Agent безперервно вчиться на помилках, поглинає знання з кодової бази та еволюціонує на основі відгуків користувачів
- **Центр співпраці програміста та Agent** — Кожен програміст має особистий «Проєкт розробки» з кількома паралельними сесіями, а центральний планувальник запобігає конфліктам паралелізму
- **Корпоративна SaaS-платформа** — Мультитенантна ізоляція, ієрархічні права, еластичний білінг та корпоративні інтеграції (Feishu/DingTalk/WeCom/LDAP)
- **Інкубатор суперінтелекту** — Через безперервну еволюцію єдиний Agent зрештою здобуває комплексні можливості повноцінної програмної команди

> «Хай кожне підприємство матиме команду AI-супер-R&D, що ніколи не зупиняється й безперервно еволюціонує — від користувача інструментів, до творця коду, зрештою виростаючи в само-репродукційний суперінтелект. Проймо цим шляхом до AGI разом.»

### Ключові можливості

- **Рідний двигун Claude Code** — на основі Claude Agent SDK, внутрішній runtime — повний Claude Code CLI, успадковує всі можливості
- **Багатокористувацька ізоляція** — workspace на користувача, IM-канали на користувача, система прав RBAC, реєстрація за кодом запрошення, журнал аудиту
- **Шістьканальна маршрутизація** — Feishu WebSocket, Telegram Bot API, QQ Bot API v2, DingTalk Stream, WeChat iLink, веб-інтерфейс
- **Багатопровайдерний балансування навантаження** — кілька Claude API-провайдерів, три стратегії (round-robin / weighted / failover) з автоматичним health-check
- **Білінг і статистика використання** — повний білінг (підписка, гаманець, коди погашення), трекінг токенів на модель з графіками
- **Мобільна PWA** — оптимізована під мобільні, встановлення на головний екран одним кліком, підтримка iOS та Android

## Швидкий старт

### Передумови

**Обов'язково**: [Node.js](https://nodejs.org) >= 20, [Docker](https://www.docker.com/) (для режиму container; не потрібен для admin host-режиму), Claude API-ключ (офіційний Anthropic або сумісний relay-сервіс).

**Опціонально**: облікові дані Feishu enterprise-додатку, Telegram Bot Token, облікові дані QQ Bot, облікові дані DingTalk, токен WeChat iLink — лише якщо потрібна IM-інтеграція.

> Claude Code CLI не потрібно встановлювати вручну — залежність проєкту від Claude Agent SDK містить повний CLI runtime, автоматично встановлюється при першому `make start`.

### Встановлення і запуск

```bash
# 1. Клонувати репозиторій
git clone https://github.com/AIGeniusInstitute/deep-think.git
cd deepthink

# 2. Запуск однією командою (перший раз встановлює залежності + компілює)
make start
```

Відкрийте http://localhost:9898 і дотримуйтесь майстра налаштування: створіть адміністратора (без дефолтного акаунта), налаштуйте Claude API та, за потреби, IM-канали. Усе налаштовується з веб-інтерфейсу, без конфігураційних файлів. API-ключі шифруються AES-256-GCM.

### Активація режиму container

Користувач admin за замовчуванням використовує host-режим (без Docker). Режим container потрібен для користувачів member (активується автоматично після реєстрації):

```bash
./container/build.sh
```

Після реєстрації нового користувача головний workspace у режимі container (`home-{userId}`) створюється автоматично, без додаткової конфігурації.

## Огляд архітектури


<p align="center">
  <img src="docs/architecture/deepthink-architecture.png" alt="DeepThink System Architecture" width="860" />
</p>


DeepThink складається з трьох незалежних Node.js-проєктів:

- **Backend** (Node.js 22 + TypeScript 5.9 + Hono): маршрутизатор повідомлень (2s polling + дедуплікація), конкурентна черга (максимум 20 контейнерів + 5 host-процесів), планувальник задач (cron / interval / once), WebSocket-сервер для реального часу і термінала, автентифікація bcrypt + HMAC Cookie, RBAC, AES-256-GCM-шифрована конфігурація. Дані в SQLite (WAL-режим, схема v1→v33).
- **Frontend** (`web/`): React 19 SPA + Vite 6 + Zustand 5 + Tailwind CSS 4 + shadcn/ui, react-markdown, mermaid, recharts, xterm.js, мобільна PWA.
- **Agent Runner** (`container/agent-runner/`): виконавчий рушій у Docker-контейнері або як host-процес. Викликає `query()` з Claude Agent SDK, емітує 14 типів StreamEvent і надає 12 MCP-інструментів батьківському процесу через файловий IPC з атомарними записами.

Шість IM-каналів входять у маршрутизатор, дедуплікуються і ставляться в чергу, ProviderPool обирає API-ключ і запускає контейнер або host-процес. Streaming-події повертаються до веб-клієнтів через WebSocket або до каналів через IM API.

## Повна документація

Повний посібник доступний тут:

- [Повна англійська версія](README.md)
- [Повна 简体中文 версія](README.zh-CN.md)

---

**Languages**: [English](README.md) · [简体中文](README.zh-CN.md) · [Español](README.es.md) · [हिन्दी](README.hi.md) · [العربية](README.ar.md) · [বাংলা](README.bn.md) · [Português](README.pt.md) · [Русский](README.ru.md) · [日本語](README.ja.md) · [Deutsch](README.de.md) · [Français](README.fr.md) · [Bahasa Indonesia](README.id.md) · [اردو](README.ur.md) · [मराठी](README.mr.md) · [తెలుగు](README.te.md) · [Türkçe](README.tr.md) · [தமிழ்](README.ta.md) · [한국어](README.ko.md) · [Tiếng Việt](README.vi.md) · [Italiano](README.it.md) · [Polski](README.pl.md) · [Українська](README.uk.md) · [Nederlands](README.nl.md) · [ไทย](README.th.md) · [ગુજરાતી](README.gu.md) · [Bahasa Melayu](README.ms.md) · [ಕನ್ನಡ](README.kn.md) · [فارسی](README.fa.md) · [Svenska](README.sv.md) · [Čeština](README.cs.md)


## About Author

- [AI光剑的博客](https://blog.csdn.net/universsky2015)

- [Github](https://jason-chen-2017.github.io/Jason-Chen-2017/)

- [光剑图书馆: 全球免费开放的电子图书馆 World Free eBook](https://universsky.github.io/)


---

## 捐赠

> Donate to AI Genius Institute:


| 微信                                                    | 支付宝                                                  |
| ------------------------------------------------------- | ------------------------------------------------------- |
| <img src="static/wechat.jpeg" width="300" height="350"> | <img src="static/alipay.jpeg" width="300" height="350"> |
