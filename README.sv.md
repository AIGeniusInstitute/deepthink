**Languages**: [English](README.md) · [简体中文](README.zh-CN.md) · [Español](README.es.md) · [हिन्दी](README.hi.md) · [العربية](README.ar.md) · [বাংলা](README.bn.md) · [Português](README.pt.md) · [Русский](README.ru.md) · [日本語](README.ja.md) · [Deutsch](README.de.md) · [Français](README.fr.md) · [Bahasa Indonesia](README.id.md) · [اردو](README.ur.md) · [मराठी](README.mr.md) · [తెలుగు](README.te.md) · [Türkçe](README.tr.md) · [தமிழ்](README.ta.md) · [한국어](README.ko.md) · [Tiếng Việt](README.vi.md) · [Italiano](README.it.md) · [Polski](README.pl.md) · [Українська](README.uk.md) · [Nederlands](README.nl.md) · [ไทย](README.th.md) · [ગુજરાતી](README.gu.md) · [Bahasa Melayu](README.ms.md) · [ಕನ್ನಡ](README.kn.md) · [فارسی](README.fa.md) · [Svenska](README.sv.md) · [Čeština](README.cs.md)

<p align="center">
  <img src="web/public/icons/logo-1024.png" alt="DeepThink Logo" width="400" />
</p>

<h1 align="center">DeepThink</h1>

<p align="center">
  Självhostat flervänligt lokalt AI Agent Loop Engineering-system (skrivbord + webbläsare + mobil) / Drivs av AI Genius Institute
</p>

<p align="center">
  <a href="LICENSE"><img src="https://img.shields.io/badge/License-MIT-teal.svg?style=for-the-badge" alt="License" /></a>
  <a href="https://nodejs.org"><img src="https://img.shields.io/badge/Node.js-%3E%3D20-339933?style=for-the-badge&logo=nodedotjs&logoColor=white" alt="Node.js" /></a>
  <img src="https://img.shields.io/badge/TypeScript-5.9-3178C6?style=for-the-badge&logo=typescript&logoColor=white" alt="TypeScript" />
  <a href="https://github.com/AIGeniusInstitute/deep-think/stargazers"><img src="https://img.shields.io/github/stars/AIGeniusInstitute/deep-think?style=for-the-badge&color=f5a623" alt="GitHub Stars" /></a>
</p>

---

## Vad är DeepThink?

DeepThink är ett självhostat, flervänligt AI Agent-system byggt ovanpå [Claude Agent SDK](https://github.com/anthropics/claude-code/tree/main/packages/claude-agent-sdk). Det omsluter hela Claude Code-runtime i en tjänst som är åtkomlig via Feishu, Telegram, QQ, DingTalk, WeChat och webbgränssnittet, med stöd för filläsning/skrivning, terminaloperationer, webbläsarautomation, flervalsresonemang och MCP-verktygsekosystem.

Central designprincip: **omimplementera inte Agent-kapacitet, återanvänd Claude Code direkt**. Det som anropas under huven är hela Claude Code CLI-runtime, inte ett API-omslag eller prompt-kedja. Varje uppgradering av Claude Code — nya verktyg, starkare resonemang, mer MCP-stöd — gynnar DeepThink automatiskt utan anpassning.

### Nyckelfunktioner

- **Drivs inbyggt av Claude Code** — Baserat på Claude Agent SDK, underliggande runtime är hela Claude Code CLI, ärver alla dess kapaciteter
- **Flervänlig isolering** — Workspace per användare, IM-kanaler per användare, RBAC-behörighetssystem, inbjudningskodregistrering, revisionsloggar
- **Enhetlig routing över sex kanaler** — Feishu WebSocket, Telegram Bot API, QQ Bot API v2, DingTalk Stream, WeChat iLink, webbgränssnitt
- **Lastbalansering mellan flera leverantörer** — flera Claude API-leverantörer, tre strategier (round-robin / weighted / failover) med automatisk hälsokontroll
- **Fakturering och användningsstatistik** — komplett faktureringssystem (prenumerationsplaner, plånbokssaldo, inlösenkoder), token-spårning per modell med diagram
- **Mobil PWA** — djupt optimerad för mobil, enkelklicksinstallation på skrivbordet, iOS / Android anpassade

## Snabbstart

### Förutsättningar

**Obligatoriskt**: [Node.js](https://nodejs.org) >= 20, [Docker](https://www.docker.com/) (för containerläge; admin i värdläge behöver det inte), och en Claude API-nyckel (officiell Anthropic eller kompatibel relay-tjänst).

**Valfritt**: Feishu-företagsapp-autentiseringsuppgifter, Telegram Bot Token, QQ Bot-autentiseringsuppgifter, DingTalk-autentiseringsuppgifter, WeChat iLink-token — endast om du vill ha IM-integrationer.

> Claude Code CLI behöver inte installeras manuellt — projektets Claude Agent SDK-beroende inkluderar redan hela CLI-runtime, installeras automatiskt vid första `make start`.

### Installation och start

```bash
# 1. Klona repositoriet
git clone https://github.com/AIGeniusInstitute/deep-think.git
cd deepthink

# 2. Start med ett kommando (installerar beroenden och kompilerar första gången)
make start
```

Besök http://localhost:3000 och följ inställningsguiden: skapa en administratör (inget standardkonto), konfigurera Claude API och alternativt IM-kanaler. All konfiguration görs från webbgränssnittet, utan konfigurationsfiler. API-nycklar lagras krypterade med AES-256-GCM.

### Aktivera containerläge

Admin-användaren använder som standard värdläge (ingen Docker). Om du behöver containerläge (member-användare använder det automatiskt efter registrering):

```bash
./container/build.sh
```

Efter registrering får varje ny användare automatiskt ett huvudsakligt workspace i containerläge (`home-{userId}`), utan ytterligare konfiguration.

## Arkitekturöversikt

DeepThink består av tre oberoende Node.js-projekt:

- **Backend** (Node.js 22 + TypeScript 5.9 + Hono): huvudtjänst med meddelanderouter (2s-polling + dedup), samtidighetskö (upp till 20 containrar + 5 värdprocesser), uppgiftsschemaläggare (cron / interval / once), WebSocket-server för realtidsströmning och terminal, bcrypt + HMAC Cookie-autentisering, RBAC och AES-256-GCM-krypterad konfigurationshantering. Data i SQLite (WAL-läge, schema v1→v33).
- **Frontend** (`web/`): React 19 SPA + Vite 6 + Zustand 5 + Tailwind CSS 4 + shadcn/ui, med react-markdown, mermaid, recharts, xterm.js och mobil PWA.
- **Agent Runner** (`container/agent-runner/`): exekveringsmotor som körs inuti en Docker-container eller som värdprocess; anropar `query()` från Claude Agent SDK, sänder ut 14 StreamEvent-typer och tillhandahåller 12 MCP-verktyg till huvudprocessen via filbaserade IPC-kanaler med atomisk skrivning.

De sex IM-kanalerna (Feishu, Telegram, QQ, DingTalk, WeChat, Web) går in i routern, dedupliceras och dirigeras till kön, som via ProviderPool väljer API-nyckel och startar containern eller värdprocessen. Strömmande händelser sänds via WebSocket till webbklienten eller skickas tillbaka via IM-API:er till varje kanal.

## Fullständig dokumentation

För den fullständiga guiden, se:

- [Fullständig engelsk version](README.md)
- [Fullständig 简体中文-version](README.zh-CN.md)

---

**Languages**: [English](README.md) · [简体中文](README.zh-CN.md) · [Español](README.es.md) · [हिन्दी](README.hi.md) · [العربية](README.ar.md) · [বাংলা](README.bn.md) · [Português](README.pt.md) · [Русский](README.ru.md) · [日本語](README.ja.md) · [Deutsch](README.de.md) · [Français](README.fr.md) · [Bahasa Indonesia](README.id.md) · [اردو](README.ur.md) · [मराठी](README.mr.md) · [తెలుగు](README.te.md) · [Türkçe](README.tr.md) · [தமிழ்](README.ta.md) · [한국어](README.ko.md) · [Tiếng Việt](README.vi.md) · [Italiano](README.it.md) · [Polski](README.pl.md) · [Українська](README.uk.md) · [Nederlands](README.nl.md) · [ไทย](README.th.md) · [ગુજરાતી](README.gu.md) · [Bahasa Melayu](README.ms.md) · [ಕನ್ನಡ](README.kn.md) · [فارسی](README.fa.md) · [Svenska](README.sv.md) · [Čeština](README.cs.md)
