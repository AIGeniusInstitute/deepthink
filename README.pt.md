**Languages**: [English](README.md) · [简体中文](README.zh-CN.md) · [Español](README.es.md) · [हिन्दी](README.hi.md) · [العربية](README.ar.md) · [বাংলা](README.bn.md) · [Português](README.pt.md) · [Русский](README.ru.md) · [日本語](README.ja.md) · [Deutsch](README.de.md) · [Français](README.fr.md) · [Bahasa Indonesia](README.id.md) · [اردو](README.ur.md) · [मराठी](README.mr.md) · [తెలుగు](README.te.md) · [Türkçe](README.tr.md) · [தமிழ்](README.ta.md) · [한국어](README.ko.md) · [Tiếng Việt](README.vi.md) · [Italiano](README.it.md) · [Polski](README.pl.md) · [Українська](README.uk.md) · [Nederlands](README.nl.md) · [ไทย](README.th.md) · [ગુજરાતી](README.gu.md) · [Bahasa Melayu](README.ms.md) · [ಕನ್ನಡ](README.kn.md) · [فارسی](README.fa.md) · [Svenska](README.sv.md) · [Čeština](README.cs.md)

<p align="center">
  <img src="web/public/icons/logo-1024.png" alt="DeepThink Logo" width="400" />
</p>

<h1 align="center">DeepThink</h1>

<p align="center">
  Sistema self-hosted multiusuário de engenharia de loops de AI Agent local (desktop + navegador + mobile) / Powered By AI Genius Institute
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


## O que é o DeepThink?

DeepThink, uma plataforma de auto-evolução de superinteligência Agent autônoma de nível corporativo, pioneira na transição do paradigma Harness Engineering para o Loop Engineering, é a nova geração de Infraestrutura de IA (AI Infra) para clientes corporativos. A plataforma DeepThink centra-se em um framework de colaboração multi-Agent, fundindo AI Coding, Self-Evolving, Full-Stack Observability, Bug Auto-Fix Loop e Human-Agent Symbiosis para construir um sistema de IA corporativo que aprende continuamente, auto-aprimora-se e, em última análise, cresce até se tornar uma superinteligência:

- **Plataforma de P&D Autônoma com IA** — Os Agent completam de forma independente o ciclo de vida completo de desenvolvimento de software, sem a necessidade de engenheiros humanos em tarefas de codificação rotineiras
- **Motor de Agent Auto-Evolutivo** — Os Agent aprendem continuamente com os erros, absorvem conhecimento da base de código e evoluem a partir do feedback dos usuários
- **Centro de Colaboração Programador-Agent** — Cada programador possui um "Projeto de Desenvolvimento" pessoal com múltiplas sessões paralelas, e um agendador central evita conflitos de concorrência
- **Plataforma SaaS Corporativa** — Isolamento multi-tenant, permissões em níveis, faturamento elástico e integrações corporativas (Feishu/DingTalk/WeCom/LDAP)
- **Incubadora de Superinteligência** — Através da evolução contínua, um único Agent acaba atingindo as capacidades abrangentes de uma equipe de software completa

> "Que cada empresa possua uma equipe de P&D super de IA que nunca para e evolui continuamente — de usuário de ferramentas, a criador de código, crescendo por fim em uma superinteligência auto-replicante. Caminhemos juntos no caminho rumo à AGI."

### Principais recursos

- **Nativamente alimentado por Claude Code** — construído sobre o Claude Agent SDK, com o runtime completo do CLI do Claude Code por baixo, herdando todas as suas capacidades
- **Harness & Loop Engineering** — manifestos de harness versionados (system prompt / subagents / tools / skills) com snapshot / diff / eval / promote / rollback, além de loops de tarefas autônomos de longa duração com revisão por iteração e re-injeção de falhas
- **Agent-as-a-Service (PaaS)** — crie, versione, monte, compartilhe e instale definições de Agent com suporte a DB entre tenants, com cotas por usuário, revisão de admin e um marketplace de templates publicáveis
- **Isolamento multiusuário** — workspaces por usuário, canais IM por usuário, sistema de permissões RBAC, registro por código de convite, logs de auditoria
- **Roteamento unificado de oito canais** — Feishu, Telegram, QQ, DingTalk, WeChat, Discord, WhatsApp e interface Web — todos roteados uniformemente
- **Multi-engine e multiprovedor** — motores de code-agent pluggáveis (Claude Code / AtomCode / Codex / OpenCode) e múltiplos provedores de Claude API com três estratégias de balanceamento (round-robin / weighted / failover) e verificação de saúde automática
- **Execução de código em sandbox** — sandbox endurecido com Docker + seccomp + cgroups para execução de código Python / Node / shell e automação de navegador Chromium CDP
- **Billing e estatísticas de uso** — sistema completo de billing (planos de assinatura, carteira, códigos de resgate), rastreamento de tokens por modelo com gráficos
- **PWA móvel** — profundamente otimizado para mobile, instalação com um clique na área de trabalho, iOS e Android adaptados
- **Internacionalizado** — 29 idiomas de UI com endônimos nativos e suporte a RTL; o Agent responde no idioma escolhido pelo usuário

## Início rápido

### Pré-requisitos

**Obrigatório**: [Node.js](https://nodejs.org) >= 20, [Docker](https://www.docker.com/) (para modo contêiner; admin em modo host não precisa), e uma chave de API Claude (Anthropic oficial ou serviço de relay compatível).

**Opcional**: credenciais de app empresarial Feishu, Telegram Bot Token, credenciais QQ Bot, credenciais DingTalk, token WeChat iLink, Discord Bot Token e WhatsApp (escaneamento de QR no primeiro lançamento) — apenas se desejar integrações IM.

> Não é necessário instalar o Claude Code CLI manualmente — a dependência do Claude Agent SDK do projeto já inclui o runtime completo do CLI, instalado automaticamente ao executar `make start` pela primeira vez.

### Instalação e início

```bash
# 1. Clonar o repositório
git clone https://github.com/AIGeniusInstitute/deepthink.git
cd deepthink

# 2. Início com um comando (instala dependências e compila na primeira vez)
make start
```

Acesse http://localhost:9898 e siga o assistente de configuração: crie o administrador (sem conta padrão), configure a Claude API e, opcionalmente, configure os canais IM. Toda configuração é feita pela interface Web, sem arquivos de configuração. As chaves de API são armazenadas criptografadas com AES-256-GCM.

### Habilitar modo contêiner

O usuário admin usa por padrão o modo host (sem Docker). Se precisar do modo contêiner (usuários member o usam automaticamente após registro):

```bash
./container/build.sh
```

Após o registro, cada novo usuário obtém automaticamente um workspace principal em modo contêiner (`home-{userId}`), sem configuração adicional.

## Visão geral da arquitetura


<p align="center">
  <img src="docs/architecture/deepthink-architecture.png" alt="DeepThink System Architecture" width="860" />
</p>


O DeepThink é composto por quatro projetos Node.js independentes:

- **Backend** (Node.js 22 + TypeScript 5.9 + Hono): serviço principal com roteador de mensagens (polling de 2s + dedupe), fila de concorrência (até 20 contêineres + 5 processos host), escalonador de tarefas (cron / interval / once), servidor WebSocket para streaming em tempo real e terminal, autenticação bcrypt + HMAC Cookie, RBAC e gerenciamento de configuração criptografada com AES-256-GCM. Persistência em SQLite (modo WAL, esquema v1→v51). Inclui também as camadas Harness / Loop Engineering, Agent-as-a-Service (PaaS), Sandbox e Claude Code Plugins.
- **Frontend** (`web/`): SPA React 19 + Vite 6 + Zustand 5 + Tailwind CSS 4, com react-markdown, mermaid, recharts, xterm.js e PWA móvel.
- **Agent Runner** (`container/agent-runner/`): motor de execução que roda dentro de um contêiner Docker ou como processo host; invoca o `query()` do Claude Agent SDK, emite mais de 30 tipos de StreamEvent via stdout e fornece 27 ferramentas MCP ao processo principal via canais IPC baseados em arquivos com escrita atômica.
- **Desktop** (`desktop/`): shell Electron que empacota um app standalone para macOS / Windows / Linux.

Os oito canais IM (Feishu, Telegram, QQ, DingTalk, WeChat, Discord, WhatsApp, Web) entram pelo roteador, são deduplicados e roteados para a fila, que pelo provider pool seleciona a chave de API / engine e inicia um contêiner, processo host ou sandbox. Eventos de streaming são transmitidos via WebSocket aos clientes Web ou respondidos via APIs IM a cada canal.

## Documentação completa

Para o guia completo, consulte:

- [Versão completa em inglês](README.md)
- [Versão completa em 简体中文](README.zh-CN.md)

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
