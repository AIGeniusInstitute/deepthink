**Languages**: [English](README.md) · [简体中文](README.zh-CN.md) · [Español](README.es.md) · [हिन्दी](README.hi.md) · [العربية](README.ar.md) · [বাংলা](README.bn.md) · [Português](README.pt.md) · [Русский](README.ru.md) · [日本語](README.ja.md) · [Deutsch](README.de.md) · [Français](README.fr.md) · [Bahasa Indonesia](README.id.md) · [اردو](README.ur.md) · [मराठी](README.mr.md) · [తెలుగు](README.te.md) · [Türkçe](README.tr.md) · [தமிழ்](README.ta.md) · [한국어](README.ko.md) · [Tiếng Việt](README.vi.md) · [Italiano](README.it.md) · [Polski](README.pl.md) · [Українська](README.uk.md) · [Nederlands](README.nl.md) · [ไทย](README.th.md) · [ગુજરાતી](README.gu.md) · [Bahasa Melayu](README.ms.md) · [ಕನ್ನಡ](README.kn.md) · [فارسی](README.fa.md) · [Svenska](README.sv.md) · [Čeština](README.cs.md)

<p align="center">
  <img src="web/public/icons/logo-1024.png" alt="DeepThink Logo" width="400" />
</p>

<h1 align="center">DeepThink</h1>

<p align="center">
  Samohostovaný více-uživatelský lokální AI Agent Loop Engineering systém (desktop + prohlížeč + mobil) / Powered By AI Genius Institute
</p>

<p align="center">
  <a href="LICENSE"><img src="https://img.shields.io/badge/License-MIT-teal.svg?style=for-the-badge" alt="License" /></a>
  <a href="https://nodejs.org"><img src="https://img.shields.io/badge/Node.js-%3E%3D20-339933?style=for-the-badge&logo=nodedotjs&logoColor=white" alt="Node.js" /></a>
  <img src="https://img.shields.io/badge/TypeScript-5.9-3178C6?style=for-the-badge&logo=typescript&logoColor=white" alt="TypeScript" />
  <a href="https://github.com/AIGeniusInstitute/deep-think/stargazers"><img src="https://img.shields.io/github/stars/AIGeniusInstitute/deep-think?style=for-the-badge&color=f5a623" alt="GitHub Stars" /></a>
</p>

---

<p align="center">
  <video src="static/deep-think-intro.mp4" poster="static/deep-think-start-logo.png" controls width="800"></video>
</p>


## Co je DeepThink

DeepThink je samohostovaný více-uživatelský AI Agent systém postavený na [Claude Agent SDK](https://github.com/anthropics/claude-agent-sdk-typescript). Balí kompletní Claude Code runtime jako službu dostupnou z Feishu, Telegramu, QQ, DingTalku, WeChatu a webového rozhraní. Podporuje čtení a zápis souborů, ovládání terminálu, automatizaci prohlížeče, vícekolovou dedukci a ekosystém MCP nástrojů.

Designový princip: **nepřepisovat schopnosti Agenta, ale přímo znovuvyužít Claude Code**. Pod pokličkou běží plný Claude Code CLI runtime, nikoliv API obal nebo řetězení promptů. Vylepšení Claude Code (nové nástroje, silnější dedukce, další MCP podpora) se automaticky a bez adaptérů promítnou do DeepThink.

### Klíčové vlastnosti

- **Nativní Claude Code jádro** — postaveno na Claude Agent SDK, interní runtime je plný Claude Code CLI, dědí všechny schopnosti
- **Izolace více uživatelů** — uživatelské workspaces, per-user IM kanály, RBAC oprávnění, registrace přes pozvánkové kódy, audit log
- **Šestikanálové směrování** — Feishu WebSocket, Telegram Bot API, QQ Bot API v2, DingTalk Stream, WeChat iLink, webové rozhraní
- **Load balancing napříč providery** — více Claude API providerů, tři strategie (round-robin / weighted / failover) s automatickým health checkem
- **Billing a statistiky využití** — kompletní billing (subscription, wallet, redemption kódy), sledování tokenů dle modelu s grafy
- **Mobilní PWA** — optimalizováno pro mobil, instalace na domovskou obrazovku jedním klikem, iOS i Android

## Rychlý start

### Předpoklady

**Povinné**: [Node.js](https://nodejs.org) >= 20, [Docker](https://www.docker.com/) (pro kontejnerový režim; pro admin host režim není nutný), Claude API klíč (oficiální Anthropic nebo kompatibilní relay služba).

**Volitelné**: přihlašovací údaje Feishu Enterprise aplikace, Telegram Bot Token, QQ Bot údaje, DingTalk údaje, WeChat iLink token — jen když potřebujete IM napojení.

> Claude Code CLI není nutné instalovat ručně — projektová závislost na Claude Agent SDK obsahuje kompletní CLI runtime, který se při prvním `make start` automaticky nainstaluje.

### Instalace a spuštění

```bash
# 1. Klonovat repozitář
git clone https://github.com/AIGeniusInstitute/deep-think.git
cd deepthink

# 2. Spuštění jedním příkazem (při prvním spuštění instalace závislostí + kompilace)
make start
```

Otevřete http://localhost:9898 a následujte setup průvodce: vytvořte administrátora (žádný výchozí účet), nastavte Claude API a případně IM kanály. Vše se konfiguruje z webového rozhraní, žádné konfigurační soubory. API klíče se ukládají šifrované pomocí AES-256-GCM.

### Aktivace kontejnerového režimu

Admin uživatel standardně používá host režim (Docker nepotřebný). Kontejnerový režim je nutný pro member uživatele (po registraci se aktivuje automaticky):

```bash
./container/build.sh
```

Po registraci nového uživatele se automaticky vytvoří jeho hlavní workspace v kontejneru (`home-{userId}`), bez další konfigurace.

## Přehled architektury

DeepThink se skládá ze tří nezávislých Node.js projektů:

- **Backend** (Node.js 22 + TypeScript 5.9 + Hono): směrovač zpráv (2s polling + deduplikace), konkurenční fronta (až 20 kontejnerů + 5 host procesů), plánovač úloh (cron / interval / once), WebSocket server pro real-time streaming a terminál, bcrypt + HMAC Cookie auth, RBAC, AES-256-GCM šifrovaná konfigurace. Data v SQLite (WAL režim, schema v1→v33).
- **Frontend** (`web/`): React 19 SPA + Vite 6 + Zustand 5 + Tailwind CSS 4 + shadcn/ui, react-markdown, mermaid, recharts, xterm.js, mobilní PWA.
- **Agent Runner** (`container/agent-runner/`): provozní engine běžící v Docker kontejneru nebo jako host proces. Volá `query()` z Claude Agent SDK, emituje 14 typů StreamEvent a přes souborový IPC s atomickým zápisem poskytuje 12 MCP nástrojů rodičovskému procesu.

Šest IM kanálů vstupuje do směrovače, probíhá deduplikací, zařazuje se do fronty, přes ProviderPool se vybere API klíč a spustí se kontejner nebo host proces. Streamovací události se posílají přes WebSocket webovým klientům nebo přes IM API zpět do kanálů.

## Úplná dokumentace

Kompletní průvodce najdete zde:

- [Anglická plná verze](README.md)
- [简体中文 plná verze](README.zh-CN.md)

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
