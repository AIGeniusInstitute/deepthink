**Languages**: [English](README.md) · [简体中文](README.zh-CN.md) · [Español](README.es.md) · [हिन्दी](README.hi.md) · [العربية](README.ar.md) · [বাংলা](README.bn.md) · [Português](README.pt.md) · [Русский](README.ru.md) · [日本語](README.ja.md) · [Deutsch](README.de.md) · [Français](README.fr.md) · [Bahasa Indonesia](README.id.md) · [اردو](README.ur.md) · [मराठी](README.mr.md) · [తెలుగు](README.te.md) · [Türkçe](README.tr.md) · [தமிழ்](README.ta.md) · [한국어](README.ko.md) · [Tiếng Việt](README.vi.md) · [Italiano](README.it.md) · [Polski](README.pl.md) · [Українська](README.uk.md) · [Nederlands](README.nl.md) · [ไทย](README.th.md) · [ગુજરાતી](README.gu.md) · [Bahasa Melayu](README.ms.md) · [ಕನ್ನಡ](README.kn.md) · [فارسی](README.fa.md) · [Svenska](README.sv.md) · [Čeština](README.cs.md)

<p align="center">
  <img src="web/public/icons/logo-1024.png" alt="DeepThink Logo" width="400" />
</p>

<h1 align="center">DeepThink</h1>

<p align="center">
  Självhostat flervänligt lokalt AI Agent Loop Engineering-system (desktop + webbläsare + mobil) / Powered By AI Genius Institute
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


## Vad är DeepThink

DeepThink, en företagsklassad plattform för själv-evolverande superintelligens för autonoma Agent, pionjär inom övergången från Harness Engineering- till Loop Engineering-paradigmet, är den nya generationens AI-infrastruktur (AI Infra) för företagskunder. DeepThink-plattformen centreras kring ett ramverk för multi-Agent-samarbete och smälter samman AI Coding, Self-Evolving, Full-Stack Observability, Bug Auto-Fix Loop och Human-Agent Symbiosis för att bygga ett företagsklassat AI-system som kontinuerligt lär sig, förbättrar sig självt och slutligen växer till en superintelligens:

- **AI-Autonom R&D-Plattform** — Agent slutför självständigt hela programvaruutvecklingslivscykeln, utan behov av mänskliga ingenjörer för rutinmässiga kodningsuppgifter
- **Själv-Evolverande Agent-Motor** — Agent lär sig kontinuerligt av fel, absorberar kunskap från kodbasen och utvecklas från användaråterkoppling
- **Programmerare-Agent-Samarbetshubb** — Varje programmerare äger ett personligt ”Utvecklingsprojekt” med flera parallella sessioner, och en central schemaläggare förhindrar samtidighetskonflikter
- **Företags-SaaS-Plattform** — Multi-tenant-isolering, nivåindelade rättigheter, elastisk fakturering och företagsintegrationer (Feishu/DingTalk/WeCom/LDAP)
- **Superintelligens-Inkubator** — Genom kontinuerlig evolution uppnår en enskild Agent till slut de omfattande förmågorna hos ett komplett programvaruteam

> ”Låt varje företag äga ett AI-super-R&D-team som aldrig stannar och ständigt utvecklas — från verktygsanvändare, till kodskapare, slutligen växande till en själv-reproducerande superintelligens. Låt oss gå tillsammans på vägen mot AGI.”

### Nyckelfunktioner

- **Inbyggd Claude Code-motor** — Bygger på Claude Agent SDK med hela Claude Code CLI-runtimen under, ärver alla dess förmågor
- **Harness & Loop Engineering** — Versionerade harness-manifest (system-prompt / subagenter / verktyg / skills) med snapshot / diff / eval / promote / rollback, plus långkörande autonoma uppgiftsloopar med per-iteration-granskning och återinjektion av fel
- **Agent-as-a-Service (PaaS)** — Skapa, versionera, montera, dela och installera databasbaserade Agent-definitioner över tenants, med per-user-kvoter, admin-granskning och en publicerbar mallmarknadsplats
- **Flervän isolering** — Workspace per användare, IM-kanaler per användare, RBAC-rättighetssystem, inbjudningskod-registrering, revisionslogg
- **Åtta-kanals enhetlig routing** — Feishu, Telegram, QQ, DingTalk, WeChat, Discord, WhatsApp och webbgränssnittet — alla enhetligt dirigerade
- **Multi-motor & multi-provider** — Pluggbara kod-agent-motorer (Claude Code / AtomCode / Codex / OpenCode) och flera Claude API-leverantörer med tre lastbalanseringsstrategier (round-robin / weighted / failover), automatisk hälsokontroll
- **Sandbox-kodexekvering** — Docker + seccomp + cgroups härdad sandbox för Python / Node / shell-kod och Chromium CDP-browserautomatisering
- **Fakturering och användningsstatistik** — Komplett faktureringssystem (prenumeration, plånbok, inlösenkoder), token-spårning per modell med diagramvisualiseringar
- **Mobil PWA** — Djupt optimerad för mobil, installation på hemskärm med ett klick, både iOS och Android
- **Internationaliserat** — 29 UI-språk med inhemska endonymer och RTL-stöd; Agent svarar på användarens valda språk

## Snabbstart

### Förutsättningar

**Obligatoriskt**: [Node.js](https://nodejs.org) >= 20, [Docker](https://www.docker.com/) (för containerläge; inte nödvändigt för admin host-läge), Claude API-nyckel (officiell Anthropic eller kompatibel relay-tjänst).

**Valfritt**: Feishu enterprise-app-referenser, Telegram Bot Token, QQ Bot-referenser, DingTalk-referenser, WeChat iLink-token, Discord Bot Token, WhatsApp (QR-skanning vid första start) — endast om IM-integration behövs.

> Claude Code CLI behöver inte installeras manuellt — projektets Claude Agent SDK-beroende innehåller hela CLI-runtime, installeras automatiskt vid första `make start`.

### Installation och start

```bash
# 1. Klona repositoriet
git clone https://github.com/AIGeniusInstitute/deepthink.git
cd deepthink

# 2. Start med ett kommando (första gången installerar beroenden + kompilerar)
make start
```

Öppna http://localhost:9898 och följ setup-guiden: skapa en administratör (inget standardkonto), konfigurera Claude API och vid behov IM-kanaler. Allt konfigureras från webbgränssnittet, inga konfigurationsfiler. API-nycklar krypteras med AES-256-GCM.

### Aktivera containerläge

Admin-användare använder som standard host-läge (utan Docker). Containerläge behövs för member-användare (aktiveras automatiskt efter registrering):

```bash
./container/build.sh
```

Efter registrering av ny användare skapas main-workspace i containerläge (`home-{userId}`) automatiskt, utan extra konfiguration.

## Arkitekturöversikt


<p align="center">
  <img src="docs/architecture/deepthink-architecture.png" alt="DeepThink System Architecture" width="860" />
</p>


DeepThink består av fyra oberoende Node.js-projekt:

- **Backend** (Node.js 22 + TypeScript 5.9 + Hono): huvudtjänsten med en meddelanderouter (2s polling + deduplicering), samtidighetskö (max 20 containrar + 5 host-processer), task-scheduler (cron / interval / once), WebSocket-server för realtidsstreaming och terminal, bcrypt + HMAC Cookie-autentisering, RBAC och AES-256-GCM-krypterad konfigurationshantering. SQLite-persistens (WAL-läge, schema v1→v51). Innehåller även Harness / Loop Engineering-, Agent-as-a-Service (PaaS)-, Sandbox- och Claude Code Plugins-lager.
- **Frontend** (`web/`): en React 19 + Vite 6 + Zustand 5 + Tailwind CSS 4 SPA, med react-markdown, mermaid, recharts, xterm.js och en mobil PWA.
- **Agent Runner** (`container/agent-runner/`): exekveringsmotorn som körs i en Docker-container eller som host-process; anropar Claude Agent SDK:s `query()`, emitterar 30+ typer av StreamEvent via stdout och exponerar 27 MCP-verktyg för huvudprocessen via filbaserade IPC-kanaler med atomiska skrivningar.
- **Desktop** (`desktop/`): ett Electron-skal som paketerar en fristående app för macOS / Windows / Linux.

De åtta IM-kanalerna (Feishu, Telegram, QQ, DingTalk, WeChat, Discord, WhatsApp, Web) kommer in via routern, dedupliceras och dirigeras till kön, som väljer API-nyckel / motor via provider-poolen och startar en container, host-process eller sandbox. Streaming-händelser sänds via WebSocket till webbklienter eller besvaras via IM-API:er till respektive kanal.

## Fullständig dokumentation

Den fullständiga guiden finns här:

- [Fullständig engelsk version](README.md)
- [Fullständig 简体中文-version](README.zh-CN.md)

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
