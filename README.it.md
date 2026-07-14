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
  <a href="https://github.com/AIGeniusInstitute/deep-think/stargazers"><img src="https://img.shields.io/github/stars/AIGeniusInstitute/deep-think?style=for-the-badge&color=f5a623" alt="GitHub Stars" /></a>
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

- **Motore Claude Code nativo** — basato su Claude Agent SDK, runtime interno è la CLI completa di Claude Code, eredita tutte le capacità
- **Isolamento multi-utente** — workspace per utente, canali IM per utente, sistema di permessi RBAC, registrazione con codice invito, log di audit
- **Routing su sei canali** — Feishu WebSocket, Telegram Bot API, QQ Bot API v2, DingTalk Stream, WeChat iLink, interfaccia web
- **Bilanciamento del carico multi-provider** — più provider Claude API, tre strategie (round-robin / weighted / failover) con health check automatico
- **Billing e statistiche di utilizzo** — billing completo (abbonamento, wallet, codici di riscossione), tracciamento dei token per modello con grafici
- **PWA mobile** — ottimizzata per mobile, installazione sulla schermata home con un clic, sia iOS che Android

## Avvio rapido

### Prerequisiti

**Obbligatori**: [Node.js](https://nodejs.org) >= 20, [Docker](https://www.docker.com/) (per la modalità container; non necessario per la modalità host dell'admin), chiave Claude API (Anthropic ufficiale o servizio relay compatibile).

**Opzionali**: credenziali dell'app enterprise Feishu, Telegram Bot Token, credenziali QQ Bot, credenziali DingTalk, token WeChat iLink — solo se serve l'integrazione IM.

> Non è necessario installare manualmente la CLI di Claude Code — la dipendenza del progetto da Claude Agent SDK include il runtime CLI completo, installato automaticamente al primo `make start`.

### Installazione e avvio

```bash
# 1. Clona il repository
git clone https://github.com/AIGeniusInstitute/deep-think.git
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


DeepThink è composto da tre progetti Node.js indipendenti:

- **Backend** (Node.js 22 + TypeScript 5.9 + Hono): router dei messaggi (polling 2s + deduplicazione), coda concorrente (massimo 20 container + 5 processi host), pianificatore di task (cron / interval / once), server WebSocket per streaming in tempo reale e terminale, autenticazione bcrypt + HMAC Cookie, RBAC, gestione configurazione crittografata AES-256-GCM. Dati in SQLite (modalità WAL, schema v1→v33).
- **Frontend** (`web/`): React 19 SPA + Vite 6 + Zustand 5 + Tailwind CSS 4 + shadcn/ui, react-markdown, mermaid, recharts, xterm.js, PWA mobile.
- **Agent Runner** (`container/agent-runner/`): motore di esecuzione in container Docker o come processo host. Chiama `query()` di Claude Agent SDK, emette 14 tipi di StreamEvent e offre 12 strumenti MCP al processo padre tramite IPC su file con scritture atomiche.

I sei canali IM entrano nel router, vengono deduplicati e accodati, il ProviderPool seleziona la chiave API e avvia il container o il processo host. Gli eventi di streaming tornano ai client web via WebSocket o ai canali via IM API.

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
