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
  <a href="https://github.com/AIGeniusInstitute/deep-think/stargazers"><img src="https://img.shields.io/github/stars/AIGeniusInstitute/deep-think?style=for-the-badge&color=f5a623" alt="GitHub Stars" /></a>
</p>

---

<p align="center">
  <video src="static/deep-think-intro.mp4" poster="static/deep-think-start-logo.png" controls width="800"></video>
</p>


## O que é o DeepThink?

DeepThink é um sistema de AI Agent self-hosted e multiusuário construído sobre o [Claude Agent SDK](https://github.com/anthropics/claude-agent-sdk-typescript). Ele envolve o runtime completo do Claude Code em um serviço acessível via Feishu, Telegram, QQ, DingTalk, WeChat e interface Web, com suporte a leitura/escrita de arquivos, operações de terminal, automação de navegador, raciocínio multi-turno e o ecossistema de ferramentas MCP.

Princípio de design central: **não re-implementar a capacidade do Agent, reusar diretamente o Claude Code**. O que é invocado por baixo é o runtime completo do CLI do Claude Code, não um wrapper de API ou cadeia de prompts. Cada upgrade do Claude Code — novas ferramentas, raciocínio mais forte, mais suporte MCP — beneficia o DeepThink sem necessidade de adaptação.

### Principais recursos

- **Nativamente alimentado por Claude Code** — baseado no Claude Agent SDK, o runtime subjacente é o CLI completo do Claude Code, herdando todas as suas capacidades
- **Isolamento multiusuário** — workspace por usuário, canais IM por usuário, sistema de permissões RBAC, registro por código de convite, logs de auditoria
- **Roteamento unificado de seis canais** — Feishu WebSocket, Telegram Bot API, QQ Bot API v2, DingTalk Stream, WeChat iLink, interface Web
- **Balanceamento de carga multiprovedor** — múltiplos provedores de Claude API, três estratégias (round-robin / weighted / failover) com verificação de saúde automática
- **Billing e estatísticas de uso** — sistema completo de billing (planos de assinatura, carteira, códigos de resgate), rastreamento de tokens por modelo com gráficos
- **PWA móvel** — profundamente otimizado para mobile, instalação com um clique na área de trabalho, iOS e Android adaptados

## Início rápido

### Pré-requisitos

**Obrigatório**: [Node.js](https://nodejs.org) >= 20, [Docker](https://www.docker.com/) (para modo contêiner; admin em modo host não precisa), e uma chave de API Claude (Anthropic oficial ou serviço de relay compatível).

**Opcional**: credenciais de app empresarial Feishu, Telegram Bot Token, credenciais QQ Bot, credenciais DingTalk, token WeChat iLink — apenas se desejar integrações IM.

> Não é necessário instalar o Claude Code CLI manualmente — a dependência do Claude Agent SDK do projeto já inclui o runtime completo do CLI, instalado automaticamente ao executar `make start` pela primeira vez.

### Instalação e início

```bash
# 1. Clonar o repositório
git clone https://github.com/AIGeniusInstitute/deep-think.git
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

O DeepThink é composto por três projetos Node.js independentes:

- **Backend** (Node.js 22 + TypeScript 5.9 + Hono): serviço principal com roteador de mensagens (polling de 2s + dedupe), fila de concorrência (até 20 contêineres + 5 processos host), escalonador de tarefas (cron / interval / once), servidor WebSocket para streaming em tempo real e terminal, autenticação bcrypt + HMAC Cookie, RBAC e gerenciamento de configuração criptografada com AES-256-GCM. Dados em SQLite (modo WAL, esquema v1→v33).
- **Frontend** (`web/`): SPA React 19 + Vite 6 + Zustand 5 + Tailwind CSS 4 + shadcn/ui, com react-markdown, mermaid, recharts, xterm.js e PWA móvel.
- **Agent Runner** (`container/agent-runner/`): motor de execução que roda dentro de um contêiner Docker ou como processo host; invoca o `query()` do Claude Agent SDK, emite 14 tipos de StreamEvent e fornece 12 ferramentas MCP ao processo principal via canais IPC baseados em arquivos com escrita atômica.

Os seis canais IM (Feishu, Telegram, QQ, DingTalk, WeChat, Web) entram no roteador, são deduplicados e roteados para a fila, que pelo ProviderPool seleciona a chave de API e inicia o contêiner ou processo host. Eventos de streaming são transmitidos via WebSocket ao cliente Web ou respondidos via APIs IM a cada canal.

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
