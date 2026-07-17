**Languages**: [English](README.md) · [简体中文](README.zh-CN.md) · [Español](README.es.md) · [हिन्दी](README.hi.md) · [العربية](README.ar.md) · [বাংলা](README.bn.md) · [Português](README.pt.md) · [Русский](README.ru.md) · [日本語](README.ja.md) · [Deutsch](README.de.md) · [Français](README.fr.md) · [Bahasa Indonesia](README.id.md) · [اردو](README.ur.md) · [मराठी](README.mr.md) · [తెలుగు](README.te.md) · [Türkçe](README.tr.md) · [தமிழ்](README.ta.md) · [한국어](README.ko.md) · [Tiếng Việt](README.vi.md) · [Italiano](README.it.md) · [Polski](README.pl.md) · [Українська](README.uk.md) · [Nederlands](README.nl.md) · [ไทย](README.th.md) · [ગુજરાતી](README.gu.md) · [Bahasa Melayu](README.ms.md) · [ಕನ್ನಡ](README.kn.md) · [فارسی](README.fa.md) · [Svenska](README.sv.md) · [Čeština](README.cs.md)

<p align="center">
  <img src="web/public/icons/logo-1024.png" alt="DeepThink Logo" width="400" />
</p>

<h1 align="center">DeepThink</h1>

<p align="center">
  Самохостинговая многопользовательская локальная система Loop Engineering AI Agent (десктоп + браузер + мобильные) / На базе AI Genius Institute
</p>

<p align="center">
  <a href="LICENSE"><img src="https://img.shields.io/badge/License-MIT-teal.svg?style=for-the-badge" alt="License" /></a>
  <a href="https://nodejs.org"><img src="https://img.shields.io/badge/Node.js-%3E%3D20-339933?style=for-the-badge&logo=nodedotjs&logoColor=white" alt="Node.js" /></a>
  <img src="https://img.shields.io/badge/TypeScript-5.9-3178C6?style=for-the-badge&logo=typescript&logoColor=white" alt="TypeScript" />
  <a href="https://github.com/AIGeniusInstitute/deepthink/stargazers"><img src="https://img.shields.io/github/stars/AIGeniusInstitute/deep-think?style=for-the-badge&color=f5a623" alt="GitHub Stars" /></a>
</p>

---

<p align="center">
  <img src="static/deep-think-intro.gif" alt="DeepThink Intro" width="800" />
</p>


## Что такое DeepThink?

DeepThink — корпоративная платформа самоэволюции автономного Agent-суперинтеллекта, пионер перехода от парадигмы Harness Engineering к Loop Engineering, новое поколение AI-инфраструктуры (AI Infra) для корпоративных клиентов. Платформа DeepThink построена вокруг фреймворка многого Agent-взаимодействия, объединяя AI Coding, Self-Evolving, Full-Stack Observability, Bug Auto-Fix Loop и Human-Agent Symbiosis для создания корпоративной AI-системы, которая непрерывно учится, самосовершенствуется и в конечном итоге вырастает в суперинтеллект:

- **Платформа автономной AI-разработки** — Agent независимо проходит полный жизненный цикл разработки ПО, исключая участие инженеров-людей в рутинных задачах кодирования
- **Движок самоэволюционирующего Agent** — Agent непрерывно учится на ошибках, поглощает знания из кодовой базы и эволюционирует на основе отзывов пользователей
- **Центр сотрудничества программиста и Agent** — У каждого программиста есть личный "Проект разработки" с несколькими параллельными сессиями, а центральный планировщик предотвращает конфликты параллелизма
- **Корпоративная SaaS-платформа** — Мультитенантная изоляция, иерархические права, эластичный биллинг и корпоративные интеграции (Feishu/DingTalk/WeCom/LDAP)
- **Инкубатор суперинтеллекта** — Посредством непрерывной эволюции единичный Agent в конечном итоге обретает комплексные возможности полноценной программной команды

> "Пусть у каждого предприятия будет никогда не останавливающаяся, непрерывно эволюционирующая AI-суперкоманда R&D — от пользователя инструментов, до создателя кода, в конечном итоге вырастающая в самовоспроизводящийся суперинтеллект. Пройдем этот путь к AGI вместе."

### Ключевые особенности

- **На базе Claude Code** — построен на Claude Agent SDK, подлежащий рантайм — полный Claude Code CLI, наследует все его способности
- **Harness и Loop Engineering** — версионированные harness-манифесты (системный промпт / subagents / инструменты / skills) со snapshot / diff / eval / promote / rollback, плюс долгоживущие автономные циклы задач с проверкой каждой итерации и реинжекцией неудач
- **Agent-as-a-Service (PaaS)** — создание, версия, монтирование, совместное использование и установка хранящихся в БД определений Agent между тенантами, с квотами на пользователя, модерацией администратора и публикуемым маркетплейсом шаблонов
- **Многопользовательская изоляция** — рабочее пространство на пользователя, IM-каналы на пользователя, система разрешений RBAC, регистрация по пригласительному коду, журнал аудита
- **Единая маршрутизация восьми каналов** — Feishu, Telegram, QQ, DingTalk, WeChat, Discord, WhatsApp и веб-интерфейс — все маршрутизируются единообразно
- **Много-движков и много-провайдеров** — подключаемые движки code-agent (Claude Code / AtomCode / Codex / OpenCode) и несколько провайдеров Claude API с тремя стратегиями балансировки (round-robin / weighted / failover), автоматическая проверка здоровья
- **Изолированное выполнение кода** — усиленный sandbox на базе Docker + seccomp + cgroups для выполнения Python / Node / shell-кода и браузерной автоматизации Chromium CDP
- **Биллинг и статистика использования** — полная система биллинга (планы подписки, кошелёк, коды пополнения), отслеживание токенов по моделям с графиками
- **Мобильный PWA** — глубоко оптимизирован для мобильных, установка одним кликом на рабочий стол, iOS / Android адаптированы
- **Интернационализация** — 29 языков интерфейса с нативными эндонимами и поддержкой RTL; Agent отвечает на выбранном пользователем языке

## Быстрый старт

### Предварительные требования

**Обязательно**: [Node.js](https://nodejs.org) >= 20, [Docker](https://www.docker.com/) (для режима контейнера; администратору только в режиме хоста не нужен), и ключ Claude API (официальный Anthropic или совместимый ретрансляционный сервис).

**Опционально**: учётные данные корпоративного приложения Feishu, Telegram Bot Token, учётные данные QQ Bot, учётные данные DingTalk, токен WeChat iLink, Discord Bot Token, WhatsApp (QR-сканирование при первом запуске) — только если нужны IM-интеграции.

> Claude Code CLI устанавливать вручную не нужно — зависимость проекта Claude Agent SDK уже включает полный рантайм CLI, автоматически устанавливается при первом запуске `make start`.

### Установка и запуск

```bash
# 1. Клонировать репозиторий
git clone https://github.com/AIGeniusInstitute/deepthink.git
cd deepthink

# 2. Запуск одной командой (первый раз устанавливает зависимости и компилирует)
make start
```

Откройте http://localhost:9898 и следуйте мастеру настройки: создайте администратора (учётной записи по умолчанию нет), настройте Claude API и при желании — IM-каналы. Вся конфигурация выполняется через веб-интерфейс, без конфигурационных файлов. Ключи API хранятся зашифрованными через AES-256-GCM.

### Включить режим контейнера

Администратор по умолчанию использует режим хоста (Docker не нужен). Если нужен режим контейнера (пользователи member используют его автоматически после регистрации):

```bash
./container/build.sh
```

После регистрации каждый новый пользователь автоматически получает главное рабочее пространство в режиме контейнера (`home-{userId}`), без дополнительной настройки.

## Обзор архитектуры


<p align="center">
  <img src="docs/architecture/deepthink-architecture.png" alt="DeepThink System Architecture" width="860" />
</p>


DeepThink состоит из четырёх независимых проектов Node.js:

- **Бэкенд** (Node.js 22 + TypeScript 5.9 + Hono): основной сервис с маршрутизатором сообщений (опрос 2с + дедупликация), очередью конкурентности (до 20 контейнеров + 5 хост-процессов), планировщиком задач (cron / interval / once), WebSocket-сервером для потоковой передачи и терминала, аутентификацией bcrypt + HMAC Cookie, RBAC и управлением конфигурацией с шифрованием AES-256-GCM. Данные в SQLite (режим WAL, схема v1→v51). Также включает слои Harness / Loop Engineering, Agent-as-a-Service (PaaS), Sandbox и Claude Code Plugins.
- **Фронтенд** (`web/`): React 19 + Vite 6 + Zustand 5 + Tailwind CSS 4 SPA, с react-markdown, mermaid, recharts, xterm.js и мобильным PWA.
- **Agent Runner** (`container/agent-runner/`): движок выполнения, работающий внутри Docker-контейнера или как хост-процесс; вызывает `query()` из Claude Agent SDK, эмиттит 30+ типов StreamEvent через stdout и предоставляет 27 инструментов MCP главному процессу через файловые IPC-каналы с атомарной записью.
- **Десктоп** (`desktop/`): оболочка Electron, упаковывающая автономное приложение для macOS / Windows / Linux.

Восемь IM-каналов (Feishu, Telegram, QQ, DingTalk, WeChat, Discord, WhatsApp, Web) поступают в маршрутизатор, дедуплицируются и направляются в очередь, которая через пул провайдеров выбирает ключ API / движок и запускает контейнер, хост-процесс или sandbox. Потоковые события транслируются через WebSocket веб-клиентам или отправляются через IM-API обратно в каждый канал.

## Полная документация

Полное руководство смотрите здесь:

- [Полная английская версия](README.md)
- [Полная версия на 简体中文](README.zh-CN.md)

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
