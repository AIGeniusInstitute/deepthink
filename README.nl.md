**Languages**: [English](README.md) · [简体中文](README.zh-CN.md) · [Español](README.es.md) · [हिन्दी](README.hi.md) · [العربية](README.ar.md) · [বাংলা](README.bn.md) · [Português](README.pt.md) · [Русский](README.ru.md) · [日本語](README.ja.md) · [Deutsch](README.de.md) · [Français](README.fr.md) · [Bahasa Indonesia](README.id.md) · [اردو](README.ur.md) · [मराठी](README.mr.md) · [తెలుగు](README.te.md) · [Türkçe](README.tr.md) · [தமிழ்](README.ta.md) · [한국어](README.ko.md) · [Tiếng Việt](README.vi.md) · [Italiano](README.it.md) · [Polski](README.pl.md) · [Українська](README.uk.md) · [Nederlands](README.nl.md) · [ไทย](README.th.md) · [ગુજરાતી](README.gu.md) · [Bahasa Melayu](README.ms.md) · [ಕನ್ನಡ](README.kn.md) · [فارسی](README.fa.md) · [Svenska](README.sv.md) · [Čeština](README.cs.md)

<p align="center">
  <img src="web/public/icons/logo-1024.png" alt="DeepThink Logo" width="400" />
</p>

<h1 align="center">DeepThink</h1>

<p align="center">
  Zelfgehost multi-user lokaal AI Agent Loop Engineering systeem (desktop + browser + mobiel) / Powered By AI Genius Institute
</p>

<p align="center">
  <a href="LICENSE"><img src="https://img.shields.io/badge/License-MIT-teal.svg?style=for-the-badge" alt="License" /></a>
  <a href="https://nodejs.org"><img src="https://img.shields.io/badge/Node.js-%3E%3D20-339933?style=for-the-badge&logo=nodedotjs&logoColor=white" alt="Node.js" /></a>
  <img src="https://img.shields.io/badge/TypeScript-5.9-3178C6?style=for-the-badge&logo=typescript&logoColor=white" alt="TypeScript" />
  <a href="https://github.com/AIGeniusInstitute/deep-think/stargazers"><img src="https://img.shields.io/github/stars/AIGeniusInstitute/deep-think?style=for-the-badge&color=f5a623" alt="GitHub Stars" /></a>
</p>

---

## Wat is DeepThink

DeepThink is een zelfgehost multi-user AI Agent-systeem dat bovenop de [Claude Agent SDK](https://github.com/anthropics/claude-agent-sdk-typescript) is gebouwd. Het pakt de volledige Claude Code-runtime in als een service die bereikbaar is via Feishu, Telegram, QQ, DingTalk, WeChat en de webinterface. Het ondersteunt lezen/schrijven van bestanden, terminalbesturing, browserautomatisering, multi-round redenering en het MCP-tool-ecosysteem.

Ontwerpprincipe: **herimplementeer de mogelijkheden van de Agent niet, maar herbruik Claude Code direct**. Onder de motorkap draait de volledige Claude Code CLI-runtime, geen API-wrapper of prompt-keten. Verbeteringen in Claude Code (nieuwe tools, sterkere redenering, meer MCP-ondersteuning) worden automatisch en zonder adapter doorgevoerd in DeepThink.

### Belangrijkste kenmerken

- **Native Claude Code-engine** — gebouwd op Claude Agent SDK, interne runtime is de volledige Claude Code CLI, erft alle mogelijkheden
- **Multi-user isolatie** — per-gebruiker workspace, per-gebruiker IM-kanalen, RBAC-rechtenysteem, uitnodigingscode-registratie, auditlog
- **Zes-kanaal routing** — Feishu WebSocket, Telegram Bot API, QQ Bot API v2, DingTalk Stream, WeChat iLink, webinterface
- **Multi-provider load balancing** — meerdere Claude API-providers, drie strategieën (round-robin / weighted / failover) met automatische health-check
- **Billing en gebruikstatistieken** — volledig billing-systeem (abonnement, wallet, inwisselcodes), per-model token-tracking met grafieken
- **Mobiele PWA** — mobielvriendelijk, installatie op thuisscherm met één klik, zowel iOS als Android

## Snel aan de slag

### Voorwaarden

**Vereist**: [Node.js](https://nodejs.org) >= 20, [Docker](https://www.docker.com/) (voor container-modus; niet nodig voor admin host-modus), Claude API-sleutel (officiële Anthropic of compatibele relay-service).

**Optioneel**: Feishu enterprise-app-referenties, Telegram Bot Token, QQ Bot-referenties, DingTalk-referenties, WeChat iLink-token — alleen als IM-integratie nodig is.

> Claude Code CLI hoeft niet handmatig te worden geïnstalleerd — de projectafhankelijkheid Claude Agent SDK bevat de volledige CLI-runtime en wordt automatisch geïnstalleerd bij de eerste `make start`.

### Installatie en opstarten

```bash
# 1. Repository klonen
git clone https://github.com/AIGeniusInstitute/deep-think.git
cd deepthink

# 2. Opstarten met één commando (eerste keer installeert afhankelijkheden + compileert)
make start
```

Open http://localhost:9898 en volg de setup-wizard: maak een beheerder aan (geen standaardaccount), configureer de Claude API en eventueel IM-kanalen. Alles wordt via de webinterface geconfigureerd, geen configuratiebestanden. API-sleutels worden versleuteld opgeslagen met AES-256-GCM.

### Container-modus activeren

De admin-gebruiker gebruikt standaard de host-modus (zonder Docker). Container-modus is nodig voor member-gebruikers (wordt na registratie automatisch geactiveerd):

```bash
./container/build.sh
```

Na registratie van een nieuwe gebruiker wordt de hoofd-workspace in container-modus (`home-{userId}`) automatisch aangemaakt, zonder extra configuratie.

## Architectuuroverzicht

DeepThink bestaat uit drie onafhankelijke Node.js-projecten:

- **Backend** (Node.js 22 + TypeScript 5.9 + Hono): berichtenrouter (2s polling + ontdubbeling), gelijktijdige wachtrij (maximaal 20 containers + 5 host-processen), taakplanner (cron / interval / once), WebSocket-server voor real-time streaming en terminal, bcrypt + HMAC Cookie-authenticatie, RBAC, AES-256-GCM-versleutelde configuratie. Gegevens in SQLite (WAL-modus, schema v1→v33).
- **Frontend** (`web/`): React 19 SPA + Vite 6 + Zustand 5 + Tailwind CSS 4 + shadcn/ui, react-markdown, mermaid, recharts, xterm.js, mobiele PWA.
- **Agent Runner** (`container/agent-runner/`): uitvoerings-engine in Docker-container of als host-proces. Roept `query()` van Claude Agent SDK aan, emitteert 14 soorten StreamEvent en biedt 12 MCP-tools aan het ouderproces via bestands-IPC met atomische schrijfoperaties.

Zes IM-kanalen komen de router binnen, worden ontdubbeld en in de wachtrij geplaatst, via ProviderPool wordt een API-sleutel gekozen en een container of host-proces gestart. Streaming-events gaan via WebSocket naar web-clients of via IM-API terug naar de kanalen.

## Volledige documentatie

De volledige gids vind je hier:

- [Engelstalige volledige versie](README.md)
- [简体中文 volledige versie](README.zh-CN.md)

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
