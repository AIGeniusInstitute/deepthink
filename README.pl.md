**Languages**: [English](README.md) · [简体中文](README.zh-CN.md) · [Español](README.es.md) · [हिन्दी](README.hi.md) · [العربية](README.ar.md) · [বাংলা](README.bn.md) · [Português](README.pt.md) · [Русский](README.ru.md) · [日本語](README.ja.md) · [Deutsch](README.de.md) · [Français](README.fr.md) · [Bahasa Indonesia](README.id.md) · [اردو](README.ur.md) · [मराठी](README.mr.md) · [తెలుగు](README.te.md) · [Türkçe](README.tr.md) · [தமிழ்](README.ta.md) · [한국어](README.ko.md) · [Tiếng Việt](README.vi.md) · [Italiano](README.it.md) · [Polski](README.pl.md) · [Українська](README.uk.md) · [Nederlands](README.nl.md) · [ไทย](README.th.md) · [ગુજરાતી](README.gu.md) · [Bahasa Melayu](README.ms.md) · [ಕನ್ನಡ](README.kn.md) · [فارسی](README.fa.md) · [Svenska](README.sv.md) · [Čeština](README.cs.md)

<p align="center">
  <img src="web/public/icons/logo-1024.png" alt="DeepThink Logo" width="400" />
</p>

<h1 align="center">DeepThink</h1>

<p align="center">
  Samohostowany wieloużytkownikowy lokalny system AI Agent Loop Engineering (desktop + przeglądarka + mobilne) / Powered By AI Genius Institute
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


## Czym jest DeepThink

DeepThink, platforma samoewolucji superinteligencji Agent autonomicznej klasy enterprise, pionier w przejściu od paradygmatu Harness Engineering do Loop Engineering, to nowe pokolenie Infrastruktury AI (AI Infra) dla klientów enterprise. Platforma DeepThink skupia się na frameworku współpracy wielo-Agentowej, łącząc AI Coding, Self-Evolving, Full-Stack Observability, Bug Auto-Fix Loop oraz Human-Agent Symbiosis, aby zbudować system AI klasy enterprise, który stale się uczy, samodzielnie się poprawia i ostatecznie wzrasta do rangi superinteligencji:

- **Platforma Autonomicznego R&D AI** — Agent-y samodzielnie przechodzą pełny cykl życia tworzenia oprogramowania, eliminując potrzebę inżynierów ludzkich przy rutynowych zadaniach kodowania
- **Silnik Agent Samoewolucyjny** — Agent-y stale uczą się na błędach, absorbują wiedzę z bazy kodu i ewoluują na podstawie opinii użytkowników
- **Centrum Współpracy Programista-Agent** — Każdy programista posiada osobisty „Projekt Rozwoju" zawierający wiele równoległych sesji, a centralny scheduler zapobiega konfliktom współbieżności
- **Platforma SaaS Enterprise** — Izolacja multi-tenant, uprawnienia hierarchiczne, elastyczne fakturowanie i integracje enterprise (Feishu/DingTalk/WeCom/LDAP)
- **Inkubator Superinteligencji** — Poprzez ciągłą ewolucję, pojedynczy Agent ostatecznie uzyskuje wyczerpujące zdolności pełnego zespołu programistycznego

> „Niech każde przedsiębiorstwo posiada zespół R&D super AI, który nigdy nie ustaje i stale się rozwija — od użytkownika narzędzi, do twórcy kodu, ostatecznie wzrastając do samo-replikującej się superinteligencji. Kroczmy razem na drodze do AGI."

### Główne cechy

- **Natywny silnik Claude Code** — oparty na Claude Agent SDK, wewnętrzny runtime to pełny Claude Code CLI, dziedziczy wszystkie możliwości
- **Izolacja wielu użytkowników** — workspace per użytkownik, kanały IM per użytkownik, system uprawnień RBAC, rejestracja kodem zaproszenia, dziennik audytu
- **Routing sześciu kanałów** — Feishu WebSocket, Telegram Bot API, QQ Bot API v2, DingTalk Stream, WeChat iLink, interfejs web
- **Load balancing wielu providerów** — wielu providerów Claude API, trzy strategie (round-robin / weighted / failover) z automatycznym health-check
- **Billing i statystyki użycia** — pełny billing (subskrypcja, portfel, kody wymiany), śledzenie tokenów per model z wykresami
- **Mobilne PWA** — zoptymalizowane na mobilne, instalacja na ekranie głównym jednym kliknięciem, obsługa iOS i Android

## Szybki start

### Wymagania wstępne

**Wymagane**: [Node.js](https://nodejs.org) >= 20, [Docker](https://www.docker.com/) (dla trybu container; niepotrzebny dla trybu host admina), klucz Claude API (oficjalny Anthropic lub kompatybilna usługa relay).

**Opcjonalne**: dane uwierzytelniające aplikacji enterprise Feishu, Telegram Bot Token, dane QQ Bot, dane DingTalk, token WeChat iLink — tylko gdy potrzebujesz integracji IM.

> Claude Code CLI nie wymaga ręcznej instalacji — zależność projektu od Claude Agent SDK zawiera pełny runtime CLI, instalowany automatycznie przy pierwszym `make start`.

### Instalacja i uruchomienie

```bash
# 1. Sklonuj repozytorium
git clone https://github.com/AIGeniusInstitute/deep-think.git
cd deepthink

# 2. Uruchomienie jednym poleceniem (pierwszy raz instaluje zależności + kompiluje)
make start
```

Otwórz http://localhost:9898 i podążaj za kreatorem konfiguracji: utwórz administratora (brak domyślnego konta), skonfiguruj Claude API i opcjonalnie kanały IM. Wszystko konfiguruje się z interfejsu webowego, bez plików konfiguracyjnych. Klucze API są szyfrowane AES-256-GCM.

### Aktywacja trybu container

Administrator używa domyślnie trybu host (bez Dockera). Tryb container jest wymagany dla użytkowników member (aktywowany automatycznie po rejestracji):

```bash
./container/build.sh
```

Po rejestracji nowego użytkownika główne workspace w trybie container (`home-{userId}`) jest tworzone automatycznie, bez dodatkowej konfiguracji.

## Przegląd architektury


<p align="center">
  <img src="docs/architecture/deepthink-architecture.png" alt="DeepThink System Architecture" width="860" />
</p>


DeepThink składa się z trzech niezależnych projektów Node.js:

- **Backend** (Node.js 22 + TypeScript 5.9 + Hono): router wiadomości (polling 2s + deduplikacja), kolejka współbieżna (maks. 20 kontenerów + 5 procesów hosta), harmonogram zadań (cron / interval / once), serwer WebSocket do streamingu w czasie rzeczywistym i terminala, uwierzytelnianie bcrypt + HMAC Cookie, RBAC, konfiguracja szyfrowana AES-256-GCM. Dane w SQLite (tryb WAL, schema v1→v33).
- **Frontend** (`web/`): React 19 SPA + Vite 6 + Zustand 5 + Tailwind CSS 4 + shadcn/ui, react-markdown, mermaid, recharts, xterm.js, mobilne PWA.
- **Agent Runner** (`container/agent-runner/`): silnik wykonawczy w kontenerze Docker lub jako proces hosta. Wywołuje `query()` z Claude Agent SDK, emituje 14 typów StreamEvent i udostępnia 12 narzędzi MCP procesowi nadrzędnemu przez IPC plikowe z atomowymi zapisami.

Sześć kanałów IM trafia do routera, jest deduplikowane i kolejkowane, ProviderPool wybiera klucz API i uruchamia kontener lub proces hosta. Zdarzenia streamingu wracają do klientów webowych przez WebSocket lub do kanałów przez API IM.

## Pełna dokumentacja

Pełny przewodnik znajdziesz tutaj:

- [Pełna wersja angielska](README.md)
- [Pełna wersja 简体中文](README.zh-CN.md)

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
