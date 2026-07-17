**Languages**: [English](README.md) · [简体中文](README.zh-CN.md) · [Español](README.es.md) · [हिन्दी](README.hi.md) · [العربية](README.ar.md) · [বাংলা](README.bn.md) · [Português](README.pt.md) · [Русский](README.ru.md) · [日本語](README.ja.md) · [Deutsch](README.de.md) · [Français](README.fr.md) · [Bahasa Indonesia](README.id.md) · [اردو](README.ur.md) · [मराठी](README.mr.md) · [తెలుగు](README.te.md) · [Türkçe](README.tr.md) · [தமிழ்](README.ta.md) · [한국어](README.ko.md) · [Tiếng Việt](README.vi.md) · [Italiano](README.it.md) · [Polski](README.pl.md) · [Українська](README.uk.md) · [Nederlands](README.nl.md) · [ไทย](README.th.md) · [ગુજરાતી](README.gu.md) · [Bahasa Melayu](README.ms.md) · [ಕನ್ನಡ](README.kn.md) · [فارسی](README.fa.md) · [Svenska](README.sv.md) · [Čeština](README.cs.md)

<p align="center">
  <img src="web/public/icons/logo-1024.png" alt="DeepThink Logo" width="400" />
</p>

<h1 align="center">DeepThink</h1>

<p align="center">
  Sistema self-hosted multi-utente di AI Agent Loop Engineering locale (desktop + browser + mobile) / Powered By AI Genius Institute
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


## Cos'è DeepThink

DeepThink, una piattaforma di auto-evoluzione della superintelligenza Agent autonoma di livello enterprise, pioniera nella transizione dal paradigma Harness Engineering al Loop Engineering, è la nuova generazione di Infrastruttura AI (AI Infra) per clienti enterprise. La piattaforma DeepThink si centra su un framework di collaborazione multi-Agent, fondendo AI Coding, Self-Evolving, Full-Stack Observability, Bug Auto-Fix Loop e Human-Agent Symbiosis per costruire un sistema AI di livello enterprise che apprende continuamente, si auto-migliora e infine cresce fino a diventare una superintelligenza:

- **Piattaforma R&D Autonoma AI** — Gli Agent completano indipendentemente l'intero ciclo di vita dello sviluppo software, senza bisogno di ingegneri umani per le attività di codifica routinaria
- **Motore Agent Auto-Evolvente** — Gli Agent apprendono continuamente dagli errori, assorbono conoscenza dalla codebase e si evolvono dal feedback degli utenti
- **Hub di Collaborazione Programmatore-Agent** — Ogni programmatore possiede un "Progetto di Sviluppo" personale con multiple sessioni parallele, e uno scheduler centrale previene conflitti di concorrenza
- **Piattaforma SaaS Enterprise** — Isolamento multi-tenant, permessi a livelli, fatturazione elastica e integrazioni enterprise (Feishu/DingTalk/WeCom/LDAP)
- **Incubatore di Superintelligenza** — Attraverso evoluzione continua, un singolo Agent infine acquisisce le capacità comprehensive di un team software completo

> "Che ogni enterprise possegga un team R&D super AI che non si ferma mai e si evolve continuamente — da utente di strumenti, a creatore di codice, crescendo infine in una superintelligenza auto-replicante. Camminiamo insieme sulla via verso l'AGI."

### Caratteristiche principali

- **Motore Claude Code nativo** — basato su Claude Agent SDK, con il runtime CLI completo di Claude Code sottostante, eredita tutte le sue capacità
- **Harness & Loop Engineering** — manifest di harness versionati (system prompt / subagents / tools / skills) con snapshot / diff / eval / promote / rollback, più loop di task autonomi a lungo termine con revisione per-iterazione e re-injection dei fallimenti
- **Agent-as-a-Service (PaaS)** — definizioni di Agent DB-backed: creazione, versionamento, mount, condivisione e installazione tra tenant, con quote per utente, revisione admin e marketplace di template pubblicabili
- **Isolamento multi-utente** — workspace per utente, canali IM per utente, sistema di permessi RBAC, registrazione con codice invito, log di audit
- **Routing unificato su otto canali** — Feishu, Telegram, QQ, DingTalk, WeChat, Discord, WhatsApp e interfaccia web, tutti instradati in modo uniforme
- **Multi-Engine e Multi-Provider** — motori pluggabili di code-agent (Claude Code / AtomCode / Codex / OpenCode) e più provider Claude API con tre strategie di load balancing (round-robin / weighted / failover), health detection automatico
- **Esecuzione di codice sandboxed** — sandbox indurita Docker + seccomp + cgroups per esecuzione di codice Python / Node / shell e automazione browser Chromium CDP
- **Billing e statistiche di utilizzo** — billing completo (abbonamento, wallet, codici di riscossione), tracciamento dei token per modello con grafici
- **PWA mobile** — ottimizzata per mobile, installazione sulla schermata home con un clic, sia iOS che Android
- **Internazionalizzata** — 29 lingue UI con endonimi nativi e supporto RTL; l'Agent risponde nella lingua scelta dall'utente

## Avvio rapido

### Prerequisiti

**Obbligatori**: [Node.js](https://nodejs.org) >= 20, [Docker](https://www.docker.com/) (per la modalità container; non necessario per la modalità host dell'admin), chiave Claude API (Anthropic ufficiale o servizio relay compatibile).

**Opzionali**: credenziali dell'app enterprise Feishu, Telegram Bot Token, credenziali QQ Bot, credenziali DingTalk, token WeChat iLink, Discord Bot Token, WhatsApp (scansione QR al primo avvio) — solo se serve l'integrazione IM.

> Non è necessario installare manualmente la CLI di Claude Code — la dipendenza del progetto da Claude Agent SDK include il runtime CLI completo, installato automaticamente al primo `make start`.

### Installazione e avvio

```bash
# 1. Clona il repository
git clone https://github.com/AIGeniusInstitute/deepthink.git
cd deepthink

# 2. Avvio con un solo comando (alla prima esecuzione installa dipendenze + compila)
make start
```

Apri http://localhost:9898 e segui la procedura guidata: crea un amministratore (nessun account predefinito), configura la Claude API e, se necessario, i canali IM. Tutto si configura dall'interfaccia web, niente file di configurazione. Le chiavi API sono crittografate con AES-256-GCM.

### Attivazione della modalità container

L'utente admin usa in modalità predefinita la modalità host (senza Docker). La modalità container è necessaria per gli utenti member (si attiva automaticamente dopo la registrazione):

```bash
./container/build.sh
```

Dopo la registrazione di un nuovo utente, il workspace principale in modalità container (`home-{userId}`) viene creato automaticamente, senza configurazione aggiuntiva.

## Panoramica dell'architettura


<p align="center">
  <img src="docs/architecture/deepthink-architecture.png" alt="DeepThink System Architecture" width="860" />
</p>


DeepThink è composto da quattro progetti Node.js indipendenti:

- **Backend** (Node.js 22 + TypeScript 5.9 + Hono): router dei messaggi (polling 2s + deduplicazione), coda concorrente (massimo 20 container + 5 processi host), pianificatore di task (cron / interval / once), server WebSocket per streaming in tempo reale e terminale, autenticazione bcrypt + HMAC Cookie, RBAC, gestione configurazione crittografata AES-256-GCM. Persistenza in SQLite (modalità WAL, schema v1→v51). Include anche i layer Harness / Loop Engineering, Agent-as-a-Service (PaaS), Sandbox e Claude Code Plugins.
- **Frontend** (`web/`): React 19 + Vite 6 + Zustand 5 + Tailwind CSS 4 SPA, con react-markdown, mermaid, recharts, xterm.js, PWA mobile.
- **Agent Runner** (`container/agent-runner/`): motore di esecuzione in container Docker o come processo host; chiama `query()` di Claude Agent SDK, emette oltre 30 tipi di StreamEvent via stdout e offre 27 strumenti MCP al processo padre su canali IPC basati su file con scritture atomiche.
- **Desktop** (`desktop/`): shell Electron che packages un'app standalone per macOS / Windows / Linux.

Gli otto canali IM (Feishu, Telegram, QQ, DingTalk, WeChat, Discord, WhatsApp, Web) entrano nel router, vengono deduplicati e instradati alla coda, che seleziona una chiave API / engine tramite il provider pool e avvia un container, un processo host o un sandbox. Gli eventi di streaming sono trasmessi via WebSocket ai client web o risposti via IM API a ciascun canale.

## Documentazione completa

La guida completa è disponibile qui:

- [Versione completa in inglese](README.md)
- [Versione completa 简体中文](README.zh-CN.md)

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
