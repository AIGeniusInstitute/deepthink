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
  <a href="https://github.com/AIGeniusInstitute/deep-think/stargazers"><img src="https://img.shields.io/github/stars/AIGeniusInstitute/deep-think?style=for-the-badge&color=f5a623" alt="GitHub Stars" /></a>
</p>

---

## Что такое DeepThink?

DeepThink — это самохостинговая многопользовательская система AI Agent, построенная на [Claude Agent SDK](https://github.com/anthropics/claude-code/tree/main/packages/claude-agent-sdk). Она оборачивает полный рантайм Claude Code в сервис, доступный через Feishu, Telegram, QQ, DingTalk, WeChat и веб-интерфейс, с поддержкой чтения/записи файлов, операций в терминале, автоматизации браузера, многоуровневого рассуждения и экосистемы инструментов MCP.

Главный принцип дизайна: **не пере-реализовывать способности Agent, а напрямую переиспользовать Claude Code**. Под капотом вызывается полный рантайм Claude Code CLI, а не API-обёртка или цепочка промптов. Каждое обновление Claude Code — новые инструменты, более сильное рассуждение, больше поддержки MCP — автоматически benefiting DeepThink без какой-либо адаптации.

### Ключевые особенности

- **На базе Claude Code** — построен на Claude Agent SDK, подлежащий рантайм — полный Claude Code CLI, наследует все его способности
- **Многопользовательская изоляция** — рабочее пространство на пользователя, IM-каналы на пользователя, система разрешений RBAC, регистрация по пригласительному коду, журнал аудита
- **Единая маршрутизация шести каналов** — Feishu WebSocket, Telegram Bot API, QQ Bot API v2, DingTalk Stream, WeChat iLink, веб-интерфейс
- **Балансировка нагрузки между провайдерами** — несколько провайдеров Claude API, три стратегии (round-robin / weighted / failover) с автоматической проверкой здоровья
- **Биллинг и статистика использования** — полная система биллинга (планы подписки, кошелёк, коды пополнения), отслеживание токенов по моделям с графиками
- **Мобильный PWA** — глубоко оптимизирован для мобильных, установка одним кликом на рабочий стол, iOS / Android адаптированы

## Быстрый старт

### Предварительные требования

**Обязательно**: [Node.js](https://nodejs.org) >= 20, [Docker](https://www.docker.com/) (для режима контейнера; администратору только в режиме хоста не нужен), и ключ Claude API (официальный Anthropic или совместимый ретрансляционный сервис).

**Опционально**: учётные данные корпоративного приложения Feishu, Telegram Bot Token, учётные данные QQ Bot, учётные данные DingTalk, токен WeChat iLink — только если нужны IM-интеграции.

> Claude Code CLI устанавливать вручную не нужно — зависимость проекта Claude Agent SDK уже включает полный рантайм CLI, автоматически устанавливается при первом запуске `make start`.

### Установка и запуск

```bash
# 1. Клонировать репозиторий
git clone https://github.com/AIGeniusInstitute/deep-think.git
cd deepthink

# 2. Запуск одной командой (первый раз устанавливает зависимости и компилирует)
make start
```

Откройте http://localhost:3000 и следуйте мастеру настройки: создайте администратора (учётной записи по умолчанию нет), настройте Claude API и при желании — IM-каналы. Вся конфигурация выполняется через веб-интерфейс, без конфигурационных файлов. Ключи API хранятся зашифрованными через AES-256-GCM.

### Включить режим контейнера

Администратор по умолчанию использует режим хоста (Docker не нужен). Если нужен режим контейнера (пользователи member используют его автоматически после регистрации):

```bash
./container/build.sh
```

После регистрации каждый новый пользователь автоматически получает главное рабочее пространство в режиме контейнера (`home-{userId}`), без дополнительной настройки.

## Обзор архитектуры

DeepThink состоит из трёх независимых проектов Node.js:

- **Бэкенд** (Node.js 22 + TypeScript 5.9 + Hono): основной сервис с маршрутизатором сообщений (опрос 2с + дедупликация), очередью конкурентности (до 20 контейнеров + 5 хост-процессов), планировщиком задач (cron / interval / once), WebSocket-сервером для потоковой передачи и терминала, аутентификацией bcrypt + HMAC Cookie, RBAC и управлением конфигурацией с шифрованием AES-256-GCM. Данные в SQLite (режим WAL, схема v1→v33).
- **Фронтенд** (`web/`): React 19 SPA + Vite 6 + Zustand 5 + Tailwind CSS 4 + shadcn/ui, с react-markdown, mermaid, recharts, xterm.js и мобильным PWA.
- **Agent Runner** (`container/agent-runner/`): движок выполнения, работающий внутри Docker-контейнера или как хост-процесс; вызывает `query()` из Claude Agent SDK, эмиттит 14 типов StreamEvent и предоставляет 12 инструментов MCP главному процессу через файловые IPC-каналы с атомарной записью.

Шесть IM-каналов (Feishu, Telegram, QQ, DingTalk, WeChat, Web) поступают в маршрутизатор, дедуплицируются и направляются в очередь, которая через ProviderPool выбирает ключ API и запускает контейнер или хост-процесс. Потоковые события транслируются через WebSocket веб-клиенту или отправляются через IM-API обратно в каждый канал.

## Полная документация

Полное руководство смотрите здесь:

- [Полная английская версия](README.md)
- [Полная версия на 简体中文](README.zh-CN.md)

---

**Languages**: [English](README.md) · [简体中文](README.zh-CN.md) · [Español](README.es.md) · [हिन्दी](README.hi.md) · [العربية](README.ar.md) · [বাংলা](README.bn.md) · [Português](README.pt.md) · [Русский](README.ru.md) · [日本語](README.ja.md) · [Deutsch](README.de.md) · [Français](README.fr.md) · [Bahasa Indonesia](README.id.md) · [اردو](README.ur.md) · [मराठी](README.mr.md) · [తెలుగు](README.te.md) · [Türkçe](README.tr.md) · [தமிழ்](README.ta.md) · [한국어](README.ko.md) · [Tiếng Việt](README.vi.md) · [Italiano](README.it.md) · [Polski](README.pl.md) · [Українська](README.uk.md) · [Nederlands](README.nl.md) · [ไทย](README.th.md) · [ગુજરાતી](README.gu.md) · [Bahasa Melayu](README.ms.md) · [ಕನ್ನಡ](README.kn.md) · [فارسی](README.fa.md) · [Svenska](README.sv.md) · [Čeština](README.cs.md)
