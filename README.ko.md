**Languages**: [English](README.md) · [简体中文](README.zh-CN.md) · [Español](README.es.md) · [हिन्दी](README.hi.md) · [العربية](README.ar.md) · [বাংলা](README.bn.md) · [Português](README.pt.md) · [Русский](README.ru.md) · [日本語](README.ja.md) · [Deutsch](README.de.md) · [Français](README.fr.md) · [Bahasa Indonesia](README.id.md) · [اردو](README.ur.md) · [मराठी](README.mr.md) · [తెలుగు](README.te.md) · [Türkçe](README.tr.md) · [தமிழ்](README.ta.md) · [한국어](README.ko.md) · [Tiếng Việt](README.vi.md) · [Italiano](README.it.md) · [Polski](README.pl.md) · [Українська](README.uk.md) · [Nederlands](README.nl.md) · [ไทย](README.th.md) · [ગુજરાતી](README.gu.md) · [Bahasa Melayu](README.ms.md) · [ಕನ್ನಡ](README.kn.md) · [فارسی](README.fa.md) · [Svenska](README.sv.md) · [Čeština](README.cs.md)

<p align="center">
  <img src="web/public/icons/logo-1024.png" alt="DeepThink Logo" width="400" />
</p>

<h1 align="center">DeepThink</h1>

<p align="center">
  셀프 호스팅 다중 사용자 로컬 AI Agent Loop Engineering 시스템 (데스크톱 + 브라우저 + 모바일) / Powered By AI Genius Institute
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


## DeepThink란

DeepThink는 [Claude Agent SDK](https://github.com/anthropics/claude-agent-sdk-typescript) 위에 구축된 셀프 호스팅 다중 사용자 AI Agent 시스템입니다. 완전한 Claude Code 런타임을 Feishu, Telegram, QQ, DingTalk, WeChat, 웹 인터페이스에서 접근 가능한 서비스로 포장합니다. 파일 읽기/쓰기, 터미널 제어, 브라우저 자동화, 다중 라운드 추론, MCP 도구 생태계를 지원합니다.

설계 원칙: **Agent의 능력을 재구현하지 않고 Claude Code를 직접 재사용한다**. 후면에서는 API 래퍼나 프롬프트 체인이 아닌 완전한 Claude Code CLI 런타임이 실행됩니다. Claude Code의 업그레이드(새로운 도구, 더 강력한 추론, 더 많은 MCP 지원)는 어댑터 없이 자동으로 DeepThink에 반영됩니다.

### 주요 특징

- **네이티브 Claude Code 엔진** — Claude Agent SDK 기반, 내부 런타임은 완전한 Claude Code CLI, 모든 능력 계승
- **다중 사용자 격리** — 사용자별 워크스페이스, 사용자별 IM 채널, RBAC 권한 체계, 초대 코드 가입, 감사 로그
- **6채널 라우팅** — Feishu WebSocket, Telegram Bot API, QQ Bot API v2, DingTalk Stream, WeChat iLink, 웹 인터페이스
- **다중 프로바이더 로드밸런싱** — 다수의 Claude API 프로바이더, 3가지 전략(round-robin / weighted / failover)과 자동 헬스체크
- **결제 및 사용 통계** — 완전한 결제 시스템(구독, 지갑, 상환 코드), 모델별 토큰 추적과 차트 시각화
- **모바일 PWA** — 모바일 특화, 원클릭 홈 화면 설치, iOS/Android 모두 지원

## 빠른 시작

### 사전 조건

**필수**: [Node.js](https://nodejs.org) >= 20, [Docker](https://www.docker.com/)(컨테이너 모드용. admin 호스트 모드만 사용하면 불필요), Claude API 키(Anthropic 공식 또는 호환 릴레이 서비스).

**선택**: Feishu 엔터프라이즈 앱 자격증명, Telegram Bot Token, QQ Bot 자격증명, DingTalk 자격증명, WeChat iLink 토큰 — IM 연동이 필요한 경우만.

> Claude Code CLI를 수동으로 설치할 필요가 없습니다 — 프로젝트의 Claude Agent SDK 의존성에 완전한 CLI 런타임이 포함되어 있으며, 첫 `make start` 실행 시 자동 설치됩니다.

### 설치 및 실행

```bash
# 1. 리포지토리 클론
git clone https://github.com/AIGeniusInstitute/deep-think.git
cd deepthink

# 2. 원커맨드 실행(첫 실행 시 의존성 설치 + 컴파일)
make start
```

http://localhost:9898 에 접속해 셋업 마법사를 따르세요: 관리자 생성(기본 계정 없음), Claude API 설정, 필요 시 IM 채널 설정. 모든 설정은 웹 인터페이스에서 처리하며 별도의 설정 파일은 필요 없습니다. API 키는 AES-256-GCM으로 암호화되어 저장됩니다.

### 컨테이너 모드 활성화

admin 사용자는 기본적으로 호스트 모드(Docker 불필요)를 사용합니다. 컨테이너 모드는 member 사용자에게 필요하며 가입 후 자동 활성화됩니다:

```bash
./container/build.sh
```

신규 사용자 가입 후 컨테이너 모드의 메인 워크스페이스(`home-{userId}`)가 자동 생성되며, 추가 설정은 필요 없습니다.

## 아키텍처 개요

DeepThink는 세 개의 독립적인 Node.js 프로젝트로 구성됩니다:

- **백엔드**(Node.js 22 + TypeScript 5.9 + Hono): 메시지 라우터(2초 폴링 + 중복 제거), 동시성 큐(최대 20 컨테이너 + 5 호스트 프로세스), 작업 스케줄러(cron / interval / once), 실시간 스트리밍과 터미널용 WebSocket 서버, bcrypt + HMAC Cookie 인증, RBAC, AES-256-GCM 암호화 설정 관리. 데이터는 SQLite(WAL 모드, 스키마 v1→v33).
- **프론트엔드**(`web/`): React 19 SPA + Vite 6 + Zustand 5 + Tailwind CSS 4 + shadcn/ui, react-markdown, mermaid, recharts, xterm.js, 모바일 PWA 포함.
- **Agent Runner**(`container/agent-runner/`): Docker 컨테이너 또는 호스트 프로세스로 동작하는 실행 엔진. Claude Agent SDK의 `query()`를 호출하고, 14종의 StreamEvent를 내보내며, 원자적 쓰기 파일 IPC를 통해 12개의 MCP 도구를 부모 프로세스에 제공합니다.

여섯 IM 채널은 라우터로 진입해 중복 제거 후 큐로 분배되고, ProviderPool을 통해 API 키를 선택해 컨테이너 또는 호스트 프로세스를 기동합니다. 스트리밍 이벤트는 WebSocket으로 웹 클라이언트에, 또는 IM API로 각 채널에 되돌려집니다.

## 전체 문서

전체 가이드는 아래를 참고하세요:

- [영어 전체 버전](README.md)
- [简体中文 전체 버전](README.zh-CN.md)

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
