**Languages**: [English](README.md) · [简体中文](README.zh-CN.md) · [Español](README.es.md) · [हिन्दी](README.hi.md) · [العربية](README.ar.md) · [বাংলা](README.bn.md) · [Português](README.pt.md) · [Русский](README.ru.md) · [日本語](README.ja.md) · [Deutsch](README.de.md) · [Français](README.fr.md) · [Bahasa Indonesia](README.id.md) · [اردو](README.ur.md) · [मराठी](README.mr.md) · [తెలుగు](README.te.md) · [Türkçe](README.tr.md) · [தமிழ்](README.ta.md) · [한국어](README.ko.md) · [Tiếng Việt](README.vi.md) · [Italiano](README.it.md) · [Polski](README.pl.md) · [Українська](README.uk.md) · [Nederlands](README.nl.md) · [ไทย](README.th.md) · [ગુજરાતી](README.gu.md) · [Bahasa Melayu](README.ms.md) · [ಕನ್ನಡ](README.kn.md) · [فارسی](README.fa.md) · [Svenska](README.sv.md) · [Čeština](README.cs.md)

<p align="center">
  <img src="web/public/icons/logo-1024.png" alt="DeepThink Logo" width="400" />
</p>

<h1 align="center">DeepThink</h1>

<p align="center">
  Self-gehostetes Multi-User-Lokal-AI-Agent-Loop-Engineering-System (Desktop + Browser + Mobile) / Powered By AI Genius Institute
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


## Was ist DeepThink?

DeepThink, eine Unternehmens-Plattform zur Selbst-Evolution autonomen Agent-Superintelligenz, Pionier im Übergang vom Harness Engineering- zum Loop Engineering-Paradigma, ist die nächste Generation der AI-Infrastruktur (AI Infra) für Unternehmenskunden. Die DeepThink-Plattform zentriert sich auf ein Multi-Agent-Kollaborations-Framework und verbindet AI Coding, Self-Evolving, Full-Stack Observability, Bug Auto-Fix Loop und Human-Agent Symbiosis, um ein Unternehmens-AI-System zu bauen, das kontinuierlich lernt, sich selbst verbessert und letztlich zur Superintelligenz heranwächst:

- **AI-Autonome R&D-Plattform** — Agent absolvieren unabhängig den gesamten Software-Entwicklungslebenszyklus, ohne menschliche Ingenieure bei routinemäßigen Codierungsaufgaben zu benötigen
- **Self-Evolving-Agent-Engine** — Agent lernen kontinuierlich aus Fehlern, saugen Wissen aus der Codebasis auf und entwickeln sich aus Nutzerfeedback weiter
- **Programmierer-Agent-Kollaborations-Hub** — Jeder Programmierer besitzt ein persönliches „Entwicklungsprojekt" mit mehreren parallelen Sitzungen, und ein zentraler Scheduler verhindert Nebenläufigkeitskonflikte
- **Unternehmens-SaaS-Plattform** — Multi-Tenant-Isolierung, gestaffelte Berechtigungen, elastische Abrechnung und Unternehmens-Integrationen (Feishu/DingTalk/WeCom/LDAP)
- **Superintelligenz-Inkubator** — Durch kontinuierliche Evolution erlangt ein einzelner Agent schließlich die umfassenden Fähigkeiten eines vollständigen Software-Teams

> „Jedes Unternehmen soll ein nie innehaltendes, sich kontinuierlich entwickelndes AI-Super-R&D-Team besitzen — vom Werkzeugnutzer, zum Code-Ersteller, schließlich heranwachsend zu einer selbst-replizierenden Superintelligenz. Lasst uns gemeinsam auf dem Weg zur AGI schreiten."

### Hauptmerkmale

- **Native Claude-Code-Antrieb** — Basierend auf Claude Agent SDK, die zugrunde liegende Runtime ist die vollständige Claude-Code-CLI, erbt alle Fähigkeiten
- **Multi-User-Isolation** — Workspace pro Benutzer, IM-Kanäle pro Benutzer, RBAC-Berechtigungssystem, Einladungscode-Registrierung, Audit-Logs
- **Einheitliches Routing über sechs Kanäle** — Feishu WebSocket, Telegram Bot API, QQ Bot API v2, DingTalk Stream, WeChat iLink, Web-Oberfläche
- **Multi-Provider-Lastverteilung** — mehrere Claude-API-Provider, drei Strategien (round-robin / weighted / failover) mit automatischem Health-Check
- **Billing und Nutzungsstatistiken** — vollständiges Billing-System (Abo-Pläne, Wallet, Einlösecodes), Token-Tracking pro Modell mit Diagrammen
- **Mobile PWA** — tiefgreifend für Mobile optimiert, Ein-Klick-Installation auf dem Desktop, iOS / Android adaptiert

## Schnellstart

### Voraussetzungen

**Erforderlich**: [Node.js](https://nodejs.org) >= 20, [Docker](https://www.docker.com/) (für Container-Modus; admin im Host-Modus braucht es nicht), und ein Claude-API-Schlüssel (offizielles Anthropic oder kompatibler Relay-Service).

**Optional**: Feishu-Unternehmens-App-Credentials, Telegram Bot Token, QQ-Bot-Credentials, DingTalk-Credentials, WeChat-iLink-Token — nur wenn Sie IM-Integrationen wünschen.

> Claude Code CLI muss nicht manuell installiert werden — die Claude-Agent-SDK-Abhängigkeit des Projekts enthält bereits die vollständige CLI-Runtime, die bei der ersten Ausführung von `make start` automatisch installiert wird.

### Installation und Start

```bash
# 1. Repository klonen
git clone https://github.com/AIGeniusInstitute/deep-think.git
cd deepthink

# 2. Ein-Kommando-Start (erstes Mal installiert Abhängigkeiten und kompiliert)
make start
```

Besuchen Sie http://localhost:9898 und folgen Sie dem Setup-Assistenten: Erstellen Sie den Administrator (kein Standard-Konto), konfigurieren Sie die Claude-API und optional die IM-Kanäle. Die gesamte Konfiguration erfolgt über die Web-Oberfläche, ohne Konfigurationsdateien. API-Schlüssel werden AES-256-GCM-verschlüsselt gespeichert.

### Container-Modus aktivieren

Der Admin-Benutzer verwendet standardmäßig den Host-Modus (kein Docker). Wenn Sie den Container-Modus benötigen (Member-Benutzer verwenden ihn nach der Registrierung automatisch):

```bash
./container/build.sh
```

Nach der Registrierung erhält jeder neue Benutzer automatisch einen Haupt-Workspace im Container-Modus (`home-{userId}`), ohne zusätzliche Konfiguration.

## Architektur-Überblick

DeepThink besteht aus drei unabhängigen Node.js-Projekten:

- **Backend** (Node.js 22 + TypeScript 5.9 + Hono): Hauptdienst mit Nachrichten-Router (2s-Polling + Dedup), Concurrency-Queue (bis zu 20 Container + 5 Host-Prozesse), Task-Scheduler (cron / interval / once), WebSocket-Server für Echtzeit-Streaming und Terminal, bcrypt + HMAC-Cookie-Authentifizierung, RBAC und AES-256-GCM-verschlüsselte Konfigurationsverwaltung. Daten in SQLite (WAL-Modus, Schema v1→v33).
- **Frontend** (`web/`): React 19 SPA + Vite 6 + Zustand 5 + Tailwind CSS 4 + shadcn/ui, mit react-markdown, mermaid, recharts, xterm.js und mobiler PWA.
- **Agent Runner** (`container/agent-runner/`): Ausführungs-Engine, die in einem Docker-Container oder als Host-Prozess läuft; ruft `query()` des Claude Agent SDK auf, emittiert 14 StreamEvent-Typen und stellt 12 MCP-Tools dem Hauptprozess über dateibasierte IPC-Kanäle mit atomarem Schreiben zur Verfügung.

Die sechs IM-Kanäle (Feishu, Telegram, QQ, DingTalk, WeChat, Web) treten in den Router ein, werden dedupliziert und zur Queue geroutet, die über den ProviderPool den API-Schlüssel auswählt und den Container oder Host-Prozess startet. Streaming-Events werden per WebSocket an den Web-Client oder über IM-APIs an jeden Kanal zurück gesendet.

## Vollständige Dokumentation

Die vollständige Anleitung finden Sie hier:

- [Vollständige englische Version](README.md)
- [Vollständige Version auf 简体中文](README.zh-CN.md)

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
