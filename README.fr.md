**Languages**: [English](README.md) · [简体中文](README.zh-CN.md) · [Español](README.es.md) · [हिन्दी](README.hi.md) · [العربية](README.ar.md) · [বাংলা](README.bn.md) · [Português](README.pt.md) · [Русский](README.ru.md) · [日本語](README.ja.md) · [Deutsch](README.de.md) · [Français](README.fr.md) · [Bahasa Indonesia](README.id.md) · [اردو](README.ur.md) · [मराठी](README.mr.md) · [తెలుగు](README.te.md) · [Türkçe](README.tr.md) · [தமிழ்](README.ta.md) · [한국어](README.ko.md) · [Tiếng Việt](README.vi.md) · [Italiano](README.it.md) · [Polski](README.pl.md) · [Українська](README.uk.md) · [Nederlands](README.nl.md) · [ไทย](README.th.md) · [ગુજરાતી](README.gu.md) · [Bahasa Melayu](README.ms.md) · [ಕನ್ನಡ](README.kn.md) · [فارسی](README.fa.md) · [Svenska](README.sv.md) · [Čeština](README.cs.md)

<p align="center">
  <img src="web/public/icons/logo-1024.png" alt="DeepThink Logo" width="400" />
</p>

<h1 align="center">DeepThink</h1>

<p align="center">
  Système auto-hébergé multi-utilisateur d'ingénierie de boucles d'AI Agent local (bureau + navigateur + mobile) / Propulsé par AI Genius Institute
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


## Qu'est-ce que DeepThink ?

DeepThink, une plateforme d'auto-évolution de superintelligence Agent autonome de niveau entreprise, pionnière dans la transition du paradigme Harness Engineering vers Loop Engineering, est la nouvelle génération d'Infrastructure IA (AI Infra) pour les clients entreprise. La plateforme DeepThink s'articule autour d'un framework de collaboration multi-Agent, fusionnant AI Coding, Self-Evolving, Full-Stack Observability, Bug Auto-Fix Loop et Human-Agent Symbiosis pour bâtir un système d'IA d'entreprise qui apprend continuellement, s'auto-améliore et, in fine, se développe pour devenir une superintelligence :

- **Plateforme de R&D Autonome par IA** — Les Agent accomplissent indépendamment le cycle de vie complet de développement logiciel, sans nécessiter d'ingénieurs humains pour les tâches de codage routinières
- **Moteur Agent Auto-Évolutif** — Les Agent apprennent continuellement des erreurs, absorbent le savoir de la base de code et évoluent à partir des retours utilisateurs
- **Hub de Collaboration Programmateur-Agent** — Chaque programmateur possède un « Projet de Développement » personnel contenant plusieurs sessions parallèles, et un planificateur central empêche les conflits de concurrence
- **Plateforme SaaS d'Entreprise** — Isolation multi-tenant, permissions hiérarchisées, facturation élastique et intégrations d'entreprise (Feishu/DingTalk/WeCom/LDAP)
- **Incubateur de Superintelligence** — Par l'évolution continue, un Agent unique finit par acquérir les capacités globales d'une équipe logicielle complète

> « Que chaque entreprise possède une super-équipe de R&D IA qui ne s'arrête jamais et évolue continuellement — de l'utilisateur d'outils, au créateur de code, pour finalement devenir une superintelligence auto-répliquante. Marchons ensemble sur la voie de l'AGI. »

### Caractéristiques clés

- **Nativement propulsé par Claude Code** — Basé sur Claude Agent SDK, le runtime sous-jacent est la CLI complète de Claude Code, héritant de toutes ses capacités
- **Harness & Loop Engineering** — Manifests d'harness versionnés (prompt système / subagents / outils / skills) avec snapshot / diff / eval / promote / rollback, plus des boucles de tâches autonomes longues avec revue par itération et réinjection des échecs
- **Agent-as-a-Service (PaaS)** — Création, versionnement, montage, partage et installation de définitions d'Agent stockées en base à travers les tenants, avec quotas par utilisateur, revue admin et un marketplace de templates publiable
- **Isolation multi-utilisateur** — Workspace par utilisateur, canaux IM par utilisateur, système de permissions RBAC, inscription par code d'invitation et journaux d'audit
- **Routage unifié sur huit canaux** — Feishu, Telegram, QQ, DingTalk, WeChat, Discord, WhatsApp et l'interface Web — tous routés uniformément
- **Multi-moteur et multi-fournisseurs** — Moteurs de code-agent pluguables (Claude Code / AtomCode / Codex / OpenCode) et plusieurs fournisseurs d'API Claude avec trois stratégies d'équilibrage (round-robin / weighted / failover) et détection de santé automatique
- **Exécution de code sandboxée** — Sandbox Docker + seccomp + cgroups durci pour l'exécution de code Python / Node / shell et l'automatisation de navigateur Chromium CDP
- **Facturation et statistiques d'usage** — système complet de facturation (plans d'abonnement, portefeuille, codes de remboursement), suivi des tokens par modèle et graphiques de visualisation
- **PWA mobile** — profondément optimisé pour le mobile, installation en un clic sur le bureau, iOS / Android adaptés
- **Internationalisé** — 29 langues d'interface avec endonymes natifs et support RTL ; l'Agent répond dans la langue choisie par l'utilisateur

## Démarrage rapide

### Prérequis

**Obligatoire** : [Node.js](https://nodejs.org) >= 20, [Docker](https://www.docker.com/) (pour le mode conteneur ; admin en mode hôte n'en a pas besoin), et une clé API Claude (Anthropic officiel ou service de relais compatible).

**Optionnel** : identifiants d'application Feishu entreprise, Telegram Bot Token, identifiants QQ Bot, identifiants DingTalk, jeton WeChat iLink, Discord Bot Token, WhatsApp (scan QR au premier lancement) — uniquement si vous souhaitez des intégrations IM.

> Pas besoin d'installer Claude Code CLI manuellement — la dépendance Claude Agent SDK du projet inclut déjà le runtime complet de la CLI, installée automatiquement au premier `make start`.

### Installation et démarrage

```bash
# 1. Cloner le dépôt
git clone https://github.com/AIGeniusInstitute/deepthink.git
cd deepthink

# 2. Démarrage en une commande (installe les dépendances et compile la première fois)
make start
```

Visitez http://localhost:9898 et suivez l'assistant de configuration : créez l'administrateur (aucun compte par défaut), configurez l'API Claude et, optionnellement, les canaux IM. Toute la configuration se fait depuis l'interface Web, sans fichiers de configuration. Les clés API sont stockées chiffrées en AES-256-GCM.

### Activer le mode conteneur

L'utilisateur admin utilise par défaut le mode hôte (pas de Docker). Si vous avez besoin du mode conteneur (les utilisateurs member l'utilisent automatiquement après inscription) :

```bash
./container/build.sh
```

Après inscription, chaque nouvel utilisateur obtient automatiquement un workspace principal en mode conteneur (`home-{userId}`), sans configuration supplémentaire.

## Vue d'ensemble de l'architecture


<p align="center">
  <img src="docs/architecture/deepthink-architecture.png" alt="DeepThink System Architecture" width="860" />
</p>


DeepThink se compose de quatre projets Node.js indépendants :

- **Backend** (Node.js 22 + TypeScript 5.9 + Hono) : service principal avec routeur de messages (polling 2s + déduplication), file de concurrence (jusqu'à 20 conteneurs + 5 processus hôte), planificateur de tâches (cron / interval / once), serveur WebSocket pour streaming temps réel et terminal, authentification bcrypt + HMAC Cookie, RBAC et gestion de configuration chiffrée AES-256-GCM. Persistance SQLite (mode WAL, schéma v1→v51). Il intègre également les couches Harness / Loop Engineering, Agent-as-a-Service (PaaS), Sandbox et Claude Code Plugins.
- **Frontend** (`web/`) : SPA React 19 + Vite 6 + Zustand 5 + Tailwind CSS 4, avec react-markdown, mermaid, recharts, xterm.js et PWA mobile.
- **Agent Runner** (`container/agent-runner/`) : moteur d'exécution qui tourne dans un conteneur Docker ou en processus hôte ; il invoque `query()` du Claude Agent SDK, émet plus de 30 types de StreamEvent via stdout et fournit 27 outils MCP au processus principal via des canaux IPC basés sur fichiers à écriture atomique.
- **Desktop** (`desktop/`) : un shell Electron qui package une application autonome pour macOS / Windows / Linux.

Les huit canaux IM (Feishu, Telegram, QQ, DingTalk, WeChat, Discord, WhatsApp, Web) entrent par le routeur, sont dédupliqués et routés vers la file, qui via le ProviderPool sélectionne la clé API / le moteur et démarre un conteneur, un processus hôte ou un sandbox. Les événements de streaming sont diffusés via WebSocket au client Web ou renvoyés via les APIs IM à chaque canal.

## Documentation complète

Pour le guide complet, consultez :

- [Version complète en anglais](README.md)
- [Version complète en 简体中文](README.zh-CN.md)

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
