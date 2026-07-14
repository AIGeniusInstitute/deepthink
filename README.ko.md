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
  <iframe src="//player.bilibili.com/player.html?bvid=BV1SgNR6QE9c&page=1&high_quality=1&danmaku=0" 
    scrolling="no" border="0" frameborder="no" framespacing="0" 
    allowfullscreen="true" width="800" height="450"
    style="max-width:100%;"></iframe>
</p>


## DeepThink란

DeepThink, 엔터프라이즈급 자율형 Agent 자가진화 슈퍼인텔리전스 플랫폼, Harness Engineering에서 Loop Engineering 패러다임으로의 전환을 선도하는 개척자, 기업 고객을 위한 차세대 AI 인프라(AI Infra)입니다. DeepThink 플랫폼은 멀티-Agent 협업 프레임워크를 중심으로 AI Coding, Self-Evolving, Full-Stack Observability, Bug Auto-Fix Loop, Human-Agent Symbiosis를 융합하여 지속적으로 학습하고 자기 개선하며 궁극적으로 슈퍼인텔리전스로 성장하는 엔터프라이즈급 AI 시스템을 구축합니다:

- **AI 자율 R&D 플랫폼** — Agent가 소프트웨어 개발의 전체 라이프사이클을 독립적으로 완수하며, 루틴한 코딩 작업에 인간 엔지니어의 개입이 불필요합니다
- **자가진화 Agent 엔진** — Agent는 오류로부터 지속적으로 학습하고, 코드베이스에서 지식을 흡수하며, 사용자 피드백으로부터 진화합니다
- **프로그래머-Agent 협업 허브** — 모든 프로그래머는 여러 병렬 세션을 포함하는 개인 "개발 프로젝트"를 소유하며, 중앙 스케줄러가 동시성 충돌을 방지합니다
- **엔터프라이즈 SaaS 플랫폼** — 멀티테넌트 격리, 계층적 권한, 탄력적 과금, 기업 통합(Feishu/DingTalk/WeCom/LDAP)
- **슈퍼인텔리전스 인큐베이터** — 지속적 진화를 통해 단일 Agent는 궁극적으로 완전한 소프트웨어 팀의 종합적 역량을 갖추게 됩니다

> "모든 기업이 결코 멈추지 않고 지속적으로 진화하는 AI 슈퍼 R&D 팀을 소유하기를 — 도구 사용자에서, 코드 창조자로, 궁극적으로 자가 복제하는 슈퍼인텔리전스로 성장하며. AGI를 향한 길에서 함께 걸어갑시다."

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


<p align="center">
  <img src="docs/architecture/deepthink-architecture.png" alt="DeepThink System Architecture" width="860" />
</p>


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
