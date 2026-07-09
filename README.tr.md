**Languages**: [English](README.md) · [简体中文](README.zh-CN.md) · [Español](README.es.md) · [हिन्दी](README.hi.md) · [العربية](README.ar.md) · [বাংলা](README.bn.md) · [Português](README.pt.md) · [Русский](README.ru.md) · [日本語](README.ja.md) · [Deutsch](README.de.md) · [Français](README.fr.md) · [Bahasa Indonesia](README.id.md) · [اردو](README.ur.md) · [मराठी](README.mr.md) · [తెలుగు](README.te.md) · [Türkçe](README.tr.md) · [தமிழ்](README.ta.md) · [한국어](README.ko.md) · [Tiếng Việt](README.vi.md) · [Italiano](README.it.md) · [Polski](README.pl.md) · [Українська](README.uk.md) · [Nederlands](README.nl.md) · [ไทย](README.th.md) · [ગુજરાતી](README.gu.md) · [Bahasa Melayu](README.ms.md) · [ಕನ್ನಡ](README.kn.md) · [فارسی](README.fa.md) · [Svenska](README.sv.md) · [Čeština](README.cs.md)

<p align="center">
  <img src="web/public/icons/logo-1024.png" alt="DeepThink Logo" width="400" />
</p>

<h1 align="center">DeepThink</h1>

<p align="center">
  Self-hosted çok kullanıcılı yerel AI Agent Loop Engineering sistemi (masaüstü + tarayıcı + mobil) / Powered By AI Genius Institute
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


## DeepThink Nedir

DeepThink, kurumsal düzeyde özerk Agent kendi-evrilen süper-zeka platformu; Harness Engineering'den Loop Engineering paradigmasına geçişin öncüsü; kurumsal müşteriler için yeni nesil AI Altyapısıdır (AI Infra). DeepThink platformu çok-Agent işbirliği çerçevesini merkeze alır; AI Coding, Self-Evolving, Full-Stack Observability, Bug Auto-Fix Loop ve Human-Agent Symbiosis'i harmanlayarak sürekli öğrenen, kendini geliştiren ve nihayetinde süper-zekaya dönüşen kurumsal bir AI sistemi inşa eder:

- **AI Özerk Ar-Ge Platformu** — Agent'lar yazılım geliştirme yaşam döngüsünün tamamını bağımsız olarak tamamlar; rutin kodlama görevlerinde insan mühendislere ihtiyaç duymaz
- **Kendi-Evrilen Agent Motoru** — Agent'lar hatalardan sürekli öğrenir, kod tabanından bilgi emer ve kullanıcı geri bildirimlerinden evrilir
- **Programcı-Agent İşbirliği Merkezi** — Her programcının birden çok paralel oturum içeren kişisel bir "Geliştirme Projesi" vardır; merkezi zamanlayıcı eşzamanlılık çakışmalarını önler
- **Kurumsal SaaS Platformu** — Çok-kiracılı izolasyon, katmanlı izinler, esnek faturalama ve kurumsal entegrasyonlar (Feishu/DingTalk/WeCom/LDAP)
- **Süper-zeka Kuluçka Makinesi** — Sürekli evrim yoluyla, tek bir Agent nihayetinde eksiksiz bir yazılım ekibinin kapsamlı yeteneklerine erişir

> "Her kuruluş, asla durmayan, sürekli evrilen bir AI süper Ar-Ge ekibine sahip olsun — araç kullanıcısından, kod yaratıcısına, nihayetinde kendini çoğaltan bir süper-zekaya büyüyerek. AGI'ye giden yolda birlikte yürüyelim."

### Ana özellikler

- **Yerel Claude Code motoru** — Claude Agent SDK tabanlı, iç runtime tam Claude Code CLI, tüm yetenekleri miras alır
- **Çok kullanıcılı izolasyon** — kullanıcı başına workspace, kullanıcı başına IM kanalları, RBAC yetki sistemi, davet kodu kaydı, denetim günlüğü
- **Altı kanal yönlendirme** — Feishu WebSocket, Telegram Bot API, QQ Bot API v2, DingTalk Stream, WeChat iLink, web arayüzü
- **Çok-sağlayıcı yük dengeleme** — birden fazla Claude API sağlayıcısı, üç strateji (round-robin / weighted / failover) otomatik sağlık kontrolü ile
- **Faturalama ve kullanım istatistikleri** — tam faturalama sistemi (abonelik, cüzdan, kullanım kodları), model başına token takibi grafiklerle
- **Mobil PWA** — mobil için optimize, tek tıkla ana ekrana kurulum, hem iOS hem Android desteği

## Hızlı Başlangıç

### Ön koşullar

**Zorunlu**: [Node.js](https://nodejs.org) >= 20, [Docker](https://www.docker.com/) (container modu için; admin host modu için gerekli değil), Claude API anahtarı (resmi Anthropic veya uyumlu relay servisi).

**İsteğe bağlı**: Feishu kurumsal uygulama kimlik bilgileri, Telegram Bot Token, QQ Bot kimlik bilgileri, DingTalk kimlik bilgileri, WeChat iLink token — yalnızca IM entegrasyonu gerekliyse.

> Claude Code CLI'ı manuel olarak kurmanız gerekmez — projenin Claude Agent SDK bağımlılığı tam CLI runtime'ını içerir ve ilk `make start`'ta otomatik kurulur.

### Kurulum ve başlatma

```bash
# 1. Repoyu klonla
git clone https://github.com/AIGeniusInstitute/deep-think.git
cd deepthink

# 2. Tek komutla başlat (ilk seferde bağımlılıkları kurar + derler)
make start
```

http://localhost:9898 adresini açın ve kurulum sihirbazını izleyin: yönetici oluşturun (varsayılan hesap yok), Claude API'yi yapılandırın ve gerekirse IM kanallarını ayarlayın. Her şey web arayüzünden yapılandırılır, yapılandırma dosyası gerekmez. API anahtarları AES-256-GCM ile şifrelenir.

### Container modunu etkinleştirme

Admin kullanıcısı varsayılan olarak host modunu (Docker olmadan) kullanır. Container modu member kullanıcıları için gerekir (kayıttan sonra otomatik etkinleşir):

```bash
./container/build.sh
```

Yeni kullanıcı kaydından sonra, container modunun ana workspace'i (`home-{userId}`) otomatik olarak oluşturulur, ek yapılandırma olmadan.

## Mimariye Genel Bakış


<p align="center">
  <img src="docs/architecture/deepthink-architecture.png" alt="DeepThink System Architecture" width="860" />
</p>


DeepThink üç bağımsız Node.js projesinden oluşur:

- **Backend** (Node.js 22 + TypeScript 5.9 + Hono): mesaj yönlendirici (2s polling + yinelenenleri kaldırma), eşzamanlı kuyruk (en fazla 20 container + 5 host süreci), görev zamanlayıcı (cron / interval / once), gerçek zamanlı akış ve terminal için WebSocket sunucusu, bcrypt + HMAC Cookie kimlik doğrulama, RBAC, AES-256-GCM şifreli yapılandırma. Veriler SQLite (WAL modu, şema v1→v33).
- **Frontend** (`web/`): React 19 SPA + Vite 6 + Zustand 5 + Tailwind CSS 4 + shadcn/ui, react-markdown, mermaid, recharts, xterm.js, mobil PWA.
- **Agent Runner** (`container/agent-runner/`): Docker container'ında veya host süreci olarak çalışan yürütme motoru. Claude Agent SDK'nın `query()` fonksiyonunu çağırır, 14 tür StreamEvent yayar ve atomik yazılı dosya IPC üzerinden 12 MCP aracını üst sürece sağlar.

Altı IM kanalı yönlendiriciye girer, yinelenenlerden arındırılır ve kuyruğa alınır, ProviderPool API anahtarını seçer ve container veya host sürecini başlatır. Akış olayları WebSocket ile web istemcilerine veya IM API ile kanallara geri gönderilir.

## Tam Dokümantasyon

Tam kılavuzu burada bulabilirsiniz:

- [İngilizce tam sürüm](README.md)
- [简体中文 tam sürüm](README.zh-CN.md)

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
