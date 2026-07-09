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
  <a href="https://github.com/AIGeniusInstitute/deep-think/stargazers"><img src="https://img.shields.io/github/stars/AIGeniusInstitute/deep-think?style=for-the-badge&color=f5a623" alt="GitHub Stars" /></a>
</p>

---

## Qu'est-ce que DeepThink ?

DeepThink est un système d'AI Agent auto-hébergé et multi-utilisateur construit sur le [Claude Agent SDK](https://github.com/anthropics/claude-agent-sdk-typescript). Il enveloppe le runtime complet de Claude Code dans un service accessible via Feishu, Telegram, QQ, DingTalk, WeChat et l'interface Web, avec support de lecture/écriture de fichiers, d'opérations terminal, d'automatisation de navigateur, de raisonnement multi-tours et de l'écosystème d'outils MCP.

Principe de conception central : **ne pas réimplémenter les capacités d'Agent, réutiliser directement Claude Code**. Ce qui est invoqué en dessous est le runtime complet de la CLI Claude Code, pas un wrapper d'API ou une chaîne de prompts. Chaque mise à jour de Claude Code — nouveaux outils, raisonnement plus fort, plus de support MCP — benefiting automatiquement DeepThink sans adaptation.

### Caractéristiques clés

- **Nativement propulsé par Claude Code** — Basé sur Claude Agent SDK, le runtime sous-jacent est la CLI complète de Claude Code, héritant de toutes ses capacités
- **Isolation multi-utilisateur** — Workspace par utilisateur, canaux IM par utilisateur, système de permissions RBAC, inscription par code d'invitation, journaux d'audit
- **Routage unifié sur six canaux** — Feishu WebSocket, Telegram Bot API, QQ Bot API v2, DingTalk Stream, WeChat iLink, interface Web
- **Équilibrage de charge multi-fournisseurs** — plusieurs fournisseurs d'API Claude, trois stratégies (round-robin / weighted / failover) avec health check automatique
- **Facturation et statistiques d'usage** — système complet de facturation (plans d'abonnement, portefeuille, codes de remboursement), suivi des tokens par modèle avec graphiques
- **PWA mobile** — profondément optimisé pour le mobile, installation en un clic sur le bureau, iOS / Android adaptés

## Démarrage rapide

### Prérequis

**Obligatoire** : [Node.js](https://nodejs.org) >= 20, [Docker](https://www.docker.com/) (pour le mode conteneur ; admin en mode hôte n'en a pas besoin), et une clé API Claude (Anthropic officiel ou service de relais compatible).

**Optionnel** : identifiants d'application Feishu entreprise, Telegram Bot Token, identifiants QQ Bot, identifiants DingTalk, jeton WeChat iLink — uniquement si vous souhaitez des intégrations IM.

> Pas besoin d'installer Claude Code CLI manuellement — la dépendance Claude Agent SDK du projet inclut déjà le runtime complet de la CLI, installée automatiquement au premier `make start`.

### Installation et démarrage

```bash
# 1. Cloner le dépôt
git clone https://github.com/AIGeniusInstitute/deep-think.git
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

DeepThink se compose de trois projets Node.js indépendants :

- **Backend** (Node.js 22 + TypeScript 5.9 + Hono) : service principal avec routeur de messages (polling 2s + déduplication), file de concurrence (jusqu'à 20 conteneurs + 5 processus hôte), planificateur de tâches (cron / interval / once), serveur WebSocket pour streaming temps réel et terminal, authentification bcrypt + HMAC Cookie, RBAC et gestion de configuration chiffrée AES-256-GCM. Données dans SQLite (mode WAL, schéma v1→v33).
- **Frontend** (`web/`) : SPA React 19 + Vite 6 + Zustand 5 + Tailwind CSS 4 + shadcn/ui, avec react-markdown, mermaid, recharts, xterm.js et PWA mobile.
- **Agent Runner** (`container/agent-runner/`) : moteur d'exécution qui tourne dans un conteneur Docker ou en processus hôte ; invoque `query()` du Claude Agent SDK, émet 14 types de StreamEvent et fournit 12 outils MCP au processus principal via des canaux IPC basés sur fichiers à écriture atomique.

Les six canaux IM (Feishu, Telegram, QQ, DingTalk, WeChat, Web) entrent dans le routeur, sont dédupliqués et routés vers la file, qui via le ProviderPool sélectionne la clé API et démarre le conteneur ou processus hôte. Les événements de streaming sont diffusés via WebSocket au client Web ou renvoyés via les APIs IM à chaque canal.

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
