**Languages**: [English](README.md) · [简体中文](README.zh-CN.md) · [Español](README.es.md) · [हिन्दी](README.hi.md) · [العربية](README.ar.md) · [বাংলা](README.bn.md) · [Português](README.pt.md) · [Русский](README.ru.md) · [日本語](README.ja.md) · [Deutsch](README.de.md) · [Français](README.fr.md) · [Bahasa Indonesia](README.id.md) · [اردو](README.ur.md) · [मराठी](README.mr.md) · [తెలుగు](README.te.md) · [Türkçe](README.tr.md) · [தமிழ்](README.ta.md) · [한국어](README.ko.md) · [Tiếng Việt](README.vi.md) · [Italiano](README.it.md) · [Polski](README.pl.md) · [Українська](README.uk.md) · [Nederlands](README.nl.md) · [ไทย](README.th.md) · [ગુજરાતી](README.gu.md) · [Bahasa Melayu](README.ms.md) · [ಕನ್ನಡ](README.kn.md) · [فارسی](README.fa.md) · [Svenska](README.sv.md) · [Čeština](README.cs.md)

<p align="center">
  <img src="web/public/icons/logo-1024.png" alt="DeepThink Logo" width="400" />
</p>

<h1 align="center">DeepThink</h1>

<p align="center">
  Sistem self-hosted multi-pengguna untuk AI Agent Loop Engineering lokal (desktop + browser + mobile) / Didukung oleh AI Genius Institute
</p>

<p align="center">
  <a href="LICENSE"><img src="https://img.shields.io/badge/License-MIT-teal.svg?style=for-the-badge" alt="License" /></a>
  <a href="https://nodejs.org"><img src="https://img.shields.io/badge/Node.js-%3E%3D20-339933?style=for-the-badge&logo=nodedotjs&logoColor=white" alt="Node.js" /></a>
  <img src="https://img.shields.io/badge/TypeScript-5.9-3178C6?style=for-the-badge&logo=typescript&logoColor=white" alt="TypeScript" />
  <a href="https://github.com/AIGeniusInstitute/deep-think/stargazers"><img src="https://img.shields.io/github/stars/AIGeniusInstitute/deep-think?style=for-the-badge&color=f5a623" alt="GitHub Stars" /></a>
</p>

---

## Apa itu DeepThink?

DeepThink adalah sistem AI Agent self-hosted dan multi-pengguna yang dibangun di atas [Claude Agent SDK](https://github.com/anthropics/claude-agent-sdk-typescript). Ia membungkus runtime Claude Code lengkap menjadi layanan yang dapat diakses melalui Feishu, Telegram, QQ, DingTalk, WeChat, dan antarmuka Web, dengan dukungan untuk membaca/menulis file, operasi terminal, otomatisasi browser, penalaran multi-ronde, dan ekosistem alat MCP.

Prinsip desain inti: **jangan mengimplementasikan ulang kapabilitas Agent, gunakan ulang Claude Code secara langsung**. Yang dipanggil di bawah adalah runtime CLI Claude Code lengkap, bukan wrapper API atau rantai prompt. Setiap upgrade Claude Code — alat baru, penalaran lebih kuat, lebih banyak dukungan MCP — secara otomatis menguntungkan DeepThink tanpa adaptasi.

### Fitur utama

- **Ditenagai Claude Code native** — Berbasis Claude Agent SDK, runtime di bawahnya adalah CLI Claude Code lengkap, mewarisi semua kapabilitasnya
- **Isolasi multi-pengguna** — Workspace per pengguna, kanal IM per pengguna, sistem izin RBAC, pendaftaran kode undangan, log audit
- **Routing terpadu enam kanal** — Feishu WebSocket, Telegram Bot API, QQ Bot API v2, DingTalk Stream, WeChat iLink, antarmuka Web
- **Load balancing multi-provider** — beberapa provider Claude API, tiga strategi (round-robin / weighted / failover) dengan health check otomatis
- **Billing dan statistik penggunaan** — sistem billing lengkap (paket langganan, dompet, kode penukaran), pelacakan token per model dengan grafik
- **PWA mobile** — dioptimalkan mendalam untuk mobile, instalasi satu klik ke desktop, iOS / Android disesuaikan

## Mulai cepat

### Persyaratan

**Wajib**: [Node.js](https://nodejs.org) >= 20, [Docker](https://www.docker.com/) (untuk mode kontainer; admin di mode host tidak membutuhkannya), dan kunci Claude API (Anthropic resmi atau layanan relay yang kompatibel).

**Opsional**: kredensial aplikasi enterprise Feishu, Telegram Bot Token, kredensial QQ Bot, kredensial DingTalk, token WeChat iLink — hanya jika Anda menginginkan integrasi IM.

> Claude Code CLI tidak perlu dipasang manual — dependensi Claude Agent SDK proyek sudah menyertakan runtime CLI lengkap, otomatis dipasang saat pertama kali menjalankan `make start`.

### Instalasi dan mulai

```bash
# 1. Klon repositori
git clone https://github.com/AIGeniusInstitute/deep-think.git
cd deepthink

# 2. Mulai satu perintah (memasang dependensi dan mengompilasi pertama kali)
make start
```

Kunjungi http://localhost:9898 dan ikuti panduan pengaturan: buat administrator (tidak ada akun default), konfigurasikan Claude API, dan opsional konfigurasikan kanal IM. Semua konfigurasi dilakukan dari antarmuka Web, tanpa file konfigurasi. Kunci API disimpan terenkripsi dengan AES-256-GCM.

### Mengaktifkan mode kontainer

Pengguna admin secara default menggunakan mode host (tanpa Docker). Jika Anda memerlukan mode kontainer (pengguna member menggunakannya otomatis setelah pendaftaran):

```bash
./container/build.sh
```

Setelah pendaftaran, setiap pengguna baru otomatis mendapatkan workspace utama di mode kontainer (`home-{userId}`), tanpa konfigurasi tambahan.

## Gambaran arsitektur

DeepThink terdiri dari tiga proyek Node.js independen:

- **Backend** (Node.js 22 + TypeScript 5.9 + Hono): layanan utama dengan router pesan (polling 2s + dedup), antrean konkurensi (hingga 20 kontainer + 5 proses host), penjadwal tugas (cron / interval / once), server WebSocket untuk streaming real-time dan terminal, autentikasi bcrypt + HMAC Cookie, RBAC, dan manajemen konfigurasi terenkripsi AES-256-GCM. Data di SQLite (mode WAL, skema v1→v33).
- **Frontend** (`web/`): SPA React 19 + Vite 6 + Zustand 5 + Tailwind CSS 4 + shadcn/ui, dengan react-markdown, mermaid, recharts, xterm.js, dan PWA mobile.
- **Agent Runner** (`container/agent-runner/`): mesin eksekusi yang berjalan di dalam kontainer Docker atau sebagai proses host; memanggil `query()` dari Claude Agent SDK, memancarkan 14 jenis StreamEvent, dan menyediakan 12 alat MCP ke proses utama melalui kanal IPC berbasis file dengan penulisan atomik.

Enam kanal IM (Feishu, Telegram, QQ, DingTalk, WeChat, Web) masuk ke router, dideduplikasi dan dirutekan ke antrean, yang melalui ProviderPool memilih kunci API dan memulai kontainer atau proses host. Event streaming disiarkan melalui WebSocket ke klien Web atau dikirim balik melalui API IM ke setiap kanal.

## Dokumentasi lengkap

Untuk panduan lengkap, lihat:

- [Versi lengkap bahasa Inggris](README.md)
- [Versi lengkap 简体中文](README.zh-CN.md)

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
