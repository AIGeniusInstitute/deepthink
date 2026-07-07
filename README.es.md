**Languages**: [English](README.md) · [简体中文](README.zh-CN.md) · [Español](README.es.md) · [हिन्दी](README.hi.md) · [العربية](README.ar.md) · [বাংলা](README.bn.md) · [Português](README.pt.md) · [Русский](README.ru.md) · [日本語](README.ja.md) · [Deutsch](README.de.md) · [Français](README.fr.md) · [Bahasa Indonesia](README.id.md) · [اردو](README.ur.md) · [मराठी](README.mr.md) · [తెలుగు](README.te.md) · [Türkçe](README.tr.md) · [தமிழ்](README.ta.md) · [한국어](README.ko.md) · [Tiếng Việt](README.vi.md) · [Italiano](README.it.md) · [Polski](README.pl.md) · [Українська](README.uk.md) · [Nederlands](README.nl.md) · [ไทย](README.th.md) · [ગુજરાતી](README.gu.md) · [Bahasa Melayu](README.ms.md) · [ಕನ್ನಡ](README.kn.md) · [فارسی](README.fa.md) · [Svenska](README.sv.md) · [Čeština](README.cs.md)

<p align="center">
  <img src="web/public/icons/logo-1024.png" alt="DeepThink Logo" width="400" />
</p>

<h1 align="center">DeepThink</h1>

<p align="center">
  Sistema de ingeniería de bucles de AI Agent local, autoalojado y multiusuario (escritorio + navegador + móvil) / Impulsado por AI Genius Institute
</p>

<p align="center">
  <a href="LICENSE"><img src="https://img.shields.io/badge/License-MIT-teal.svg?style=for-the-badge" alt="License" /></a>
  <a href="https://nodejs.org"><img src="https://img.shields.io/badge/Node.js-%3E%3D20-339933?style=for-the-badge&logo=nodedotjs&logoColor=white" alt="Node.js" /></a>
  <img src="https://img.shields.io/badge/TypeScript-5.9-3178C6?style=for-the-badge&logo=typescript&logoColor=white" alt="TypeScript" />
  <a href="https://github.com/AIGeniusInstitute/deep-think/stargazers"><img src="https://img.shields.io/github/stars/AIGeniusInstitute/deep-think?style=for-the-badge&color=f5a623" alt="GitHub Stars" /></a>
</p>

---

## ¿Qué es DeepThink?

DeepThink es un sistema de AI Agent autoalojado y multiusuario construido sobre el [Claude Agent SDK](https://github.com/anthropics/claude-code/tree/main/packages/claude-agent-sdk). Envuelve el runtime completo de Claude Code en un servicio accesible desde Feishu, Telegram, QQ, DingTalk, WeChat y la interfaz Web, con soporte para lectura/escritura de archivos, operaciones de terminal, automatización de navegador, razonamiento multirround y el ecosistema de herramientas MCP.

Principio de diseño central: **no reimplementar la capacidad de Agent, reutilizar directamente Claude Code**. Lo que se invoca por debajo es el runtime completo del CLI de Claude Code, no un API wrapper ni una cadena de prompts. Cada actualización de Claude Code — nuevas herramientas, razonamiento más fuerte, más soporte MCP — beneficia a DeepThink sin adaptación.

### Características clave

- **Nativamente impulsado por Claude Code** — Basado en Claude Agent SDK, el runtime subyacente es el CLI completo de Claude Code, heredando todas sus capacidades
- **Aislamiento multiusuario** — Workspace por usuario, canales IM por usuario, RBAC, registro por código de invitación, logs de auditoría
- **Enrutamiento unificado de seis canales** — Feishu WebSocket, Telegram Bot API, QQ Bot API v2, DingTalk Stream, WeChat iLink, Web interface
- **Balanceo de carga multiproveedor** — múltiples proveedores de Claude API, tres estrategias (round-robin / weighted / failover) con health check automático
- **Billing y estadísticas de uso** — sistema completo de suscripciones, wallet, códigos de canje, trazabilidad de tokens por modelo con gráficos
- **PWA móvil** — optimizado para móvil, instalación de un clic en el escritorio, iOS y Android adaptados

## Inicio rápido

### Requisitos previos

**Obligatorio**: [Node.js](https://nodejs.org) >= 20, [Docker](https://www.docker.com/) (para modo contenedor; el admin en modo host no lo necesita), y una clave API de Claude (Anthropic oficial o servicio de retransmisión compatible).

**Opcional**: credenciales de Feishu, Telegram Bot Token, credenciales de QQ Bot, credenciales de DingTalk, token de WeChat iLink — solo si quieres integraciones IM.

> No necesitas instalar Claude Code CLI manualmente — el Claude Agent SDK del proyecto ya incluye el runtime completo del CLI, se instala automáticamente al ejecutar `make start` por primera vez.

### Instalación y arranque

```bash
# 1. Clonar el repositorio
git clone https://github.com/AIGeniusInstitute/deep-think.git
cd deepthink

# 2. Inicio con un solo comando (instala dependencias y compila la primera vez)
make start
```

Visita http://localhost:3000 y sigue el asistente de configuración: crea el administrador (sin cuenta por defecto), configura la API de Claude y, opcionalmente, los canales IM. Toda la configuración se hace desde la interfaz Web, sin archivos de configuración. Las claves API se almacenan cifradas con AES-256-GCM.

### Modo contenedor

El usuario admin usa por defecto el modo host (sin Docker), listo para usar. Si necesitas modo contenedor (los usuarios member lo usan automáticamente tras registrarse):

```bash
./container/build.sh
```

Tras el registro, cada nuevo usuario obtiene automáticamente un workspace principal en modo contenedor (`home-{userId}`), sin configuración adicional.

## Visión general de la arquitectura

DeepThink se compone de tres proyectos Node.js independientes:

- **Backend** (Node.js 22 + TypeScript 5.9 + Hono): servicio principal con router de mensajes (polling de 2s + dedupe), cola de concurrencia (hasta 20 contenedores + 5 procesos host), scheduler de tareas (cron / interval / once), servidor WebSocket para streaming en tiempo real y terminal, autenticación con bcrypt + HMAC Cookie, RBAC y gestión de configuración cifrada AES-256-GCM. Persistencia en SQLite (modo WAL, esquema v1→v33).
- **Frontend** (`web/`): SPA React 19 + Vite 6 + Zustand 5 + Tailwind CSS 4 + shadcn/ui, con react-markdown, mermaid, recharts, xterm.js y PWA móvil.
- **Agent Runner** (`container/agent-runner/`): motor de ejecución que corre dentro de un contenedor Docker o como proceso host; invoca el `query()` del Claude Agent SDK, emite 14 tipos de StreamEvent vía stdout, y expone 12 herramientas MCP al proceso principal mediante canales IPC basados en archivos con escritura atómica.

Los seis canales IM (Feishu, Telegram, QQ, DingTalk, WeChat, Web) entran por el router, se desduplican y se enrután a la cola, que a través del ProviderPool selecciona la clave API y arranca el contenedor o proceso host. Los eventos de streaming se emiten por WebSocket al cliente Web o se responden por las APIs IM a cada canal.

## Documentación completa

Para la guía completa, consulta:

- [Versión completa en inglés](README.md)
- [Versión completa en 简体中文](README.zh-CN.md)

---

**Languages**: [English](README.md) · [简体中文](README.zh-CN.md) · [Español](README.es.md) · [हिन्दी](README.hi.md) · [العربية](README.ar.md) · [বাংলা](README.bn.md) · [Português](README.pt.md) · [Русский](README.ru.md) · [日本語](README.ja.md) · [Deutsch](README.de.md) · [Français](README.fr.md) · [Bahasa Indonesia](README.id.md) · [اردو](README.ur.md) · [मराठी](README.mr.md) · [తెలుగు](README.te.md) · [Türkçe](README.tr.md) · [தமிழ்](README.ta.md) · [한국어](README.ko.md) · [Tiếng Việt](README.vi.md) · [Italiano](README.it.md) · [Polski](README.pl.md) · [Українська](README.uk.md) · [Nederlands](README.nl.md) · [ไทย](README.th.md) · [ગુજરાતી](README.gu.md) · [Bahasa Melayu](README.ms.md) · [ಕನ್ನಡ](README.kn.md) · [فارسی](README.fa.md) · [Svenska](README.sv.md) · [Čeština](README.cs.md)
