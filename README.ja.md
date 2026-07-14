**Languages**: [English](README.md) · [简体中文](README.zh-CN.md) · [Español](README.es.md) · [हिन्दी](README.hi.md) · [العربية](README.ar.md) · [বাংলা](README.bn.md) · [Português](README.pt.md) · [Русский](README.ru.md) · [日本語](README.ja.md) · [Deutsch](README.de.md) · [Français](README.fr.md) · [Bahasa Indonesia](README.id.md) · [اردو](README.ur.md) · [मराठी](README.mr.md) · [తెలుగు](README.te.md) · [Türkçe](README.tr.md) · [தமிழ்](README.ta.md) · [한국어](README.ko.md) · [Tiếng Việt](README.vi.md) · [Italiano](README.it.md) · [Polski](README.pl.md) · [Українська](README.uk.md) · [Nederlands](README.nl.md) · [ไทย](README.th.md) · [ગુજરાતી](README.gu.md) · [Bahasa Melayu](README.ms.md) · [ಕನ್ನಡ](README.kn.md) · [فارسی](README.fa.md) · [Svenska](README.sv.md) · [Čeština](README.cs.md)

<p align="center">
  <img src="web/public/icons/logo-1024.png" alt="DeepThink Logo" width="400" />
</p>

<h1 align="center">DeepThink</h1>

<p align="center">
  セルフホストのマルチユーザー・ローカル AI Agent Loop Engineering システム（デスクトップ＋ブラウザ＋モバイル） / Powered By AI Genius Institute
</p>

<p align="center">
  <a href="LICENSE"><img src="https://img.shields.io/badge/License-MIT-teal.svg?style=for-the-badge" alt="License" /></a>
  <a href="https://nodejs.org"><img src="https://img.shields.io/badge/Node.js-%3E%3D20-339933?style=for-the-badge&logo=nodedotjs&logoColor=white" alt="Node.js" /></a>
  <img src="https://img.shields.io/badge/TypeScript-5.9-3178C6?style=for-the-badge&logo=typescript&logoColor=white" alt="TypeScript" />
  <a href="https://github.com/AIGeniusInstitute/deep-think/stargazers"><img src="https://img.shields.io/github/stars/AIGeniusInstitute/deep-think?style=for-the-badge&color=f5a623" alt="GitHub Stars" /></a>
</p>

---

<p align="center">
  <img src="static/deep-think-intro.gif" alt="DeepThink Intro" width="800" />
</p>


## DeepThink とは

DeepThink、エンタープライズグレードの自律型 Agent 自己進化スーパーインテリジェンスプラットフォーム。Harness Engineering から Loop Engineering パラダイムへの移行の先駆者であり、エンタープライズ顧客向けの次世代 AI インフラストラクチャ（AI Infra）です。DeepThink プラットフォームはマルチ Agent コラボレーションフレームワークを中核とし、AI Coding、Self-Evolving、Full-Stack Observability、Bug Auto-Fix Loop、Human-Agent Symbiosis を融合して、継続的に学習し自己改善し、最終的にスーパーインテリジェンスへと成長するエンタープライズグレードの AI システムを構築します：

- **AI 自律型 R&D プラットフォーム** — Agent がソフトウェア開発の全ライフサイクルを独立して完遂し、ルーチンなコーディング作業に人間エンジニアを必要としません
- **自己進化型 Agent エンジン** — Agent はエラーから継続的に学び、コードベースから知識を吸収し、ユーザーフィードバックから進化します
- **プログラマー-Agent コラボレーションハブ** — 各プログラマーは複数の並列セッションを含む個人「開発プロジェクト」を持ち、中央スケジューラが並行処理の競合を防ぎます
- **エンタープライズ SaaS プラットフォーム** — マルチテナント分離、階層型権限、弾力的な課金、エンタープライズ連携（Feishu/DingTalk/WeCom/LDAP）
- **スーパーインテリジェンスインキュベータ** — 継続的な進化を通じて、単一の Agent は最終的に完全なソフトウェアチームの総合的な能力を獲得します

> 「すべての企業が、決して止まることなく継続的に進化する AI スーパー R&D チームを持てるように — ツールの利用者から、コードの創造者へ、最終的には自己増殖するスーパーインテリジェンスへと成長する。AGI への道を共に歩んでいきましょう。」

### 主な特徴

- **ネイティブ Claude Code 駆動** — Claude Agent SDK ベース、内部ランタイムは完全な Claude Code CLI、全能力を継承
- **マルチユーザー分離** — ユーザーごとのワークスペース、ユーザーごとの IM チャンネル、RBAC 権限体系、招待コード登録、監査ログ
- **6 チャンネル統合ルーティング** — Feishu WebSocket、Telegram Bot API、QQ Bot API v2、DingTalk Stream、WeChat iLink、Web インターフェース
- **マルチプロバイダロードバランシング** — 複数の Claude API プロバイダ、3 戦略（round-robin / weighted / failover）と自動ヘルスチェック
- **課金と利用統計** — 完全な課金システム（サブスクリプション、ウォレット、引き換えコード）、モデル別トークン追跡とグラフ可視化
- **モバイル PWA** — モバイル特化、ワンクリックでホーム画面にインストール、iOS / Android 両対応

## クイックスタート

### 前提条件

**必須**: [Node.js](https://nodejs.org) >= 20、[Docker](https://www.docker.com/)（コンテナモード用。admin のホストモードのみなら不要）、Claude API キー（Anthropic 公式または互換リレーサービス）。

**オプション**: Feishu エンタープライズアプリクレデンシャル、Telegram Bot Token、QQ Bot クレデンシャル、DingTalk クレデンシャル、WeChat iLink トークン — IM 連携が必要な場合のみ。

> Claude Code CLI を手動でインストールする必要はありません — プロジェクトの Claude Agent SDK 依存に完全な CLI ランタイムが含まれ、`make start` 初回起動時に自動インストールされます。

### インストールと起動

```bash
# 1. リポジトリをクローン
git clone https://github.com/AIGeniusInstitute/deep-think.git
cd deepthink

# 2. ワンコマンド起動（初回は依存インストール + コンパイル）
make start
```

http://localhost:9898 にアクセスし、セットアップウィザードに従ってください：管理者を作成（デフォルトアカウントなし）、Claude API を設定、必要に応じて IM チャンネルを設定。設定は全て Web インターフェースから行い、設定ファイルは不要。API キーは AES-256-GCM で暗号化保存されます。

### コンテナモードの有効化

admin ユーザーはデフォルトでホストモード（Docker 不要）を使います。コンテナモードが必要な場合（member ユーザーは登録後に自動使用）：

```bash
./container/build.sh
```

新規ユーザー登録後、コンテナモードのメインワークスペース（`home-{userId}`）が自動作成され、追加設定は不要です。

## アーキテクチャ概要


<p align="center">
  <img src="docs/architecture/deepthink-architecture.png" alt="DeepThink System Architecture" width="860" />
</p>


DeepThink は 3 つの独立した Node.js プロジェクトで構成されます:

- **バックエンド**（Node.js 22 + TypeScript 5.9 + Hono）: メッセージルーター（2s ポーリング + 重複除去）、並行キュー（最大 20 コンテナ + 5 ホストプロセス）、タスクスケジューラ（cron / interval / once）、リアルタイムストリーミングとターミナル用 WebSocket サーバー、bcrypt + HMAC Cookie 認証、RBAC、AES-256-GCM 暗号化設定管理。データは SQLite（WAL モード、スキーマ v1→v33）。
- **フロントエンド**（`web/`）: React 19 SPA + Vite 6 + Zustand 5 + Tailwind CSS 4 + shadcn/ui、react-markdown、mermaid、recharts、xterm.js、モバイル PWA を同梱。
- **Agent Runner**（`container/agent-runner/`）: Docker コンテナ内またはホストプロセスとして動く実行エンジン。Claude Agent SDK の `query()` を呼び、14 種類の StreamEvent を送出し、アトミック書き込みのファイル IPC を介して 12 個の MCP ツールを親プロセスに提供します。

6 つの IM チャンネル（Feishu、Telegram、QQ、DingTalk、WeChat、Web）はルーターに入り、重複除去されてキューに振り分けられ、ProviderPool 経由で API キーを選択してコンテナまたはホストプロセスを起動します。ストリーミングイベントは WebSocket で Web クライアントへ、または IM API で各チャンネルへ戻されます。

## 完全なドキュメント

完全なガイドは以下を参照してください:

- [英語完全版](README.md)
- [简体中文 完全版](README.zh-CN.md)

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
