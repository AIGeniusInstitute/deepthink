**Languages**: [English](README.md) · [简体中文](README.zh-CN.md) · [Español](README.es.md) · [हिन्दी](README.hi.md) · [العربية](README.ar.md) · [বাংলা](README.bn.md) · [Português](README.pt.md) · [Русский](README.ru.md) · [日本語](README.ja.md) · [Deutsch](README.de.md) · [Français](README.fr.md) · [Bahasa Indonesia](README.id.md) · [اردو](README.ur.md) · [मराठी](README.mr.md) · [తెలుగు](README.te.md) · [Türkçe](README.tr.md) · [தமிழ்](README.ta.md) · [한국어](README.ko.md) · [Tiếng Việt](README.vi.md) · [Italiano](README.it.md) · [Polski](README.pl.md) · [Українська](README.uk.md) · [Nederlands](README.nl.md) · [ไทย](README.th.md) · [ગુજરાતી](README.gu.md) · [Bahasa Melayu](README.ms.md) · [ಕನ್ನಡ](README.kn.md) · [فارسی](README.fa.md) · [Svenska](README.sv.md) · [Čeština](README.cs.md)

<p align="center">
  <img src="web/public/icons/logo-1024.png" alt="DeepThink Logo" width="400" />
</p>

<h1 align="center">DeepThink</h1>

<p align="center">
  Kendi kendine barındırılan çok kullanıcılı yerel AI Agent Loop Engineering sistemi (masaüstü + tarayıcı + mobil) / AI Genius Institute tarafından geliştirilmiştir
</p>

<p align="center">
  <a href="LICENSE"><img src="https://img.shields.io/badge/License-MIT-teal.svg?style=for-the-badge" alt="License" /></a>
  <a href="https://nodejs.org"><img src="https://img.shields.io/badge/Node.js-%3E%3D20-339933?style=for-the-badge&logo=nodedotjs&logoColor=white" alt="Node.js" /></a>
  <img src="https://img.shields.io/badge/TypeScript-5.9-3178C6?style=for-the-badge&logo=typescript&logoColor=white" alt="TypeScript" />
  <a href="https://github.com/AIGeniusInstitute/deep-think/stargazers"><img src="https://img.shields.io/github/stars/AIGeniusInstitute/deep-think?style=for-the-badge&color=f5a623" alt="GitHub Stars" /></a>
</p>

---

## DeepThink nedir?

DeepThink, [Claude Agent SDK](https://github.com/anthropics/claude-code/tree/main/packages/claude-agent-sdk) üzerine inşa edilmiş, kendi kendine barındırılan çok kullanıcılı bir AI Agent sistemidir. Tam Claude Code çalışma zamanını Feishu, Telegram, QQ, DingTalk, WeChat ve Web arayüzünden erişilebilen bir hizmete sarar; dosya okuma/yazma, terminal işlemleri, tarayıcı otomasyonu, çok turlu akıl yürütme ve MCP araç ekosistemi desteğiyle.

Temel tasarım ilkesi: **Agent yeteneklerini yeniden uygulamayın, Claude Code'u doğrudan yeniden kullanın**. Arka planda çağrılan şey tam Claude Code CLI çalışma zamanıdır, bir API sarmalayıcısı veya istem zinciri değil. Claude Code'un her yükseltmesi — yeni araçlar, daha güçlü akıl yürütme, daha fazla MCP desteği — DeepThink'e uyarlama olmadan otomatik olarak yarar sağlar.

### Temel özellikler

- **Doğal Claude Code güdümlü** — Claude Agent SDK tabanlı, alt çalışma zamanı tam Claude Code CLI, tüm yeteneklerini miras alır
- **Çok kullanıcılı izolasyon** — Kullanıcı başına çalışma alanı, kullanıcı başına IM kanalları, RBAC izin sistemi, davet kodu kaydı, denetim günlükleri
- **Altı kanalın birleştirilmiş yönlendirilmesi** — Feishu WebSocket, Telegram Bot API, QQ Bot API v2, DingTalk Stream, WeChat iLink, Web arayüzü
- **Çok sağlayıcılı yük dengeleme** — birden fazla Claude API sağlayıcısı, üç strateji (round-robin / weighted / failover) otomatik sağlık kontrolüyle
- **Faturalandırma ve kullanım istatistikleri** — tam faturalandırma sistemi (abonelik planları, cüzdan bakiyesi, kullanım kodları), model başına token takibi ve grafik görselleştirme
- **Mobil PWA** — mobil için derin optimize, masaüstüne tek tıkla kurulum, iOS / Android uyumlu

## Hızlı başlangıç

### Önkoşullar

**Zorunlu**: [Node.js](https://nodejs.org) >= 20, [Docker](https://www.docker.com/) (konteyner modu için; admin yalnızca host modunda gerekmez), ve bir Claude API anahtarı (resmi Anthropic veya uyumlu aktarma hizmeti).

**İsteğe bağlı**: Feishu kurumsal uygulama kimlik bilgileri, Telegram Bot Token, QQ Bot kimlik bilgileri, DingTalk kimlik bilgileri, WeChat iLink token — yalnızca IM entegrasyonları istiyorsanız.

> Claude Code CLI'ı manuel olarak kurmanıza gerek yok — projenin Claude Agent SDK bağımlılığı tam CLI çalışma zamanını içerir, `make start` ilk çalıştırmada otomatik kurulur.

### Kurulum ve başlatma

```bash
# 1. Depoyu klonla
git clone https://github.com/AIGeniusInstitute/deep-think.git
cd deepthink

# 2. Tek komutla başlat (ilk seferde bağımlılıkları yükler ve derler)
make start
```

http://localhost:3000 adresini ziyaret edin ve kurulum sihirbazını izleyin: yönetici oluşturun (varsayılan hesap yok), Claude API'yi yapılandırın ve isteğe bağlı olarak IM kanallarını yapılandırın. Tüm yapılandırma Web arayüzünden yapılır, hiçbir yapılandırma dosyası gerektirmez. API anahtarları AES-256-GCM ile şifrelenmiş olarak saklanır.

### Konteyner modunu etkinleştir

Admin kullanıcısı varsayılan olarak host modunu kullanır (Docker gerekmez). Konteyner moduna ihtiyacınız varsa (member kullanıcılar kayıttan sonra otomatik kullanır):

```bash
./container/build.sh
```

Kayıttan sonra, her yeni kullanıcı otomatik olarak konteyner modunda bir ana çalışma alanı (`home-{userId}`) alır, ek yapılandırma olmadan.

## Mimari genel bakış

DeepThink üç bağımsız Node.js projesinden oluşur:

- **Arka uç** (Node.js 22 + TypeScript 5.9 + Hono): Mesaj yönlendirici (2s yoklama + dedup), eşzamanlılık kuyruğu (en fazla 20 konteyner + 5 host süreci), görev zamanlayıcı (cron / interval / once), gerçek zamanlı akış ve terminal için WebSocket sunucusu, bcrypt + HMAC Cookie kimlik doğrulama, RBAC ve AES-256-GCM şifreli yapılandırma yönetimi ile ana hizmet. Veriler SQLite'ta (WAL modu, şema v1→v33).
- **Ön uç** (`web/`): React 19 SPA + Vite 6 + Zustand 5 + Tailwind CSS 4 + shadcn/ui, react-markdown, mermaid, recharts, xterm.js ve mobil PWA ile.
- **Agent Runner** (`container/agent-runner/`): Bir Docker konteynerinde veya host süreci olarak çalışan yürütme motoru; Claude Agent SDK'nın `query()`sini çağırır, 14 StreamEvent türü yayar ve atomik yazma ile dosya tabanlı IPC kanalları üzerinden 12 MCP aracını ana sürece sağlar.

Altı IM kanalı (Feishu, Telegram, QQ, DingTalk, WeChat, Web) yönlendiriciye girer, deduplanir ve kuyruğa yönlendirilir; kuyruk ProviderPool üzerinden API anahtarını seçer ve konteyner veya host sürecini başlatır. Akış olayları WebSocket ile Web istemcisine veya IM API'leriyle her kanala geri gönderilir.

## Tam dokümantasyon

Tam rehber için bkz.:

- [Tam İngilizce sürüm](README.md)
- [简体中文 tam sürüm](README.zh-CN.md)

---

**Languages**: [English](README.md) · [简体中文](README.zh-CN.md) · [Español](README.es.md) · [हिन्दी](README.hi.md) · [العربية](README.ar.md) · [বাংলা](README.bn.md) · [Português](README.pt.md) · [Русский](README.ru.md) · [日本語](README.ja.md) · [Deutsch](README.de.md) · [Français](README.fr.md) · [Bahasa Indonesia](README.id.md) · [اردو](README.ur.md) · [मराठी](README.mr.md) · [తెలుగు](README.te.md) · [Türkçe](README.tr.md) · [தமிழ்](README.ta.md) · [한국어](README.ko.md) · [Tiếng Việt](README.vi.md) · [Italiano](README.it.md) · [Polski](README.pl.md) · [Українська](README.uk.md) · [Nederlands](README.nl.md) · [ไทย](README.th.md) · [ગુજરાતી](README.gu.md) · [Bahasa Melayu](README.ms.md) · [ಕನ್ನಡ](README.kn.md) · [فارسی](README.fa.md) · [Svenska](README.sv.md) · [Čeština](README.cs.md)
