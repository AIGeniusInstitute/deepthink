**Languages**: [English](README.md) · [简体中文](README.zh-CN.md) · [Español](README.es.md) · [हिन्दी](README.hi.md) · [العربية](README.ar.md) · [বাংলা](README.bn.md) · [Português](README.pt.md) · [Русский](README.ru.md) · [日本語](README.ja.md) · [Deutsch](README.de.md) · [Français](README.fr.md) · [Bahasa Indonesia](README.id.md) · [اردو](README.ur.md) · [मराठी](README.mr.md) · [తెలుగు](README.te.md) · [Türkçe](README.tr.md) · [தமிழ்](README.ta.md) · [한국어](README.ko.md) · [Tiếng Việt](README.vi.md) · [Italiano](README.it.md) · [Polski](README.pl.md) · [Українська](README.uk.md) · [Nederlands](README.nl.md) · [ไทย](README.th.md) · [ગુજરાતી](README.gu.md) · [Bahasa Melayu](README.ms.md) · [ಕನ್ನಡ](README.kn.md) · [فارسی](README.fa.md) · [Svenska](README.sv.md) · [Čeština](README.cs.md)

<p align="center">
  <img src="web/public/icons/logo-1024.png" alt="DeepThink Logo" width="400" />
</p>

<h1 align="center">DeepThink</h1>

<p align="center">
  Sistem self-hosted berbilang pengguna untuk AI Agent Loop Engineering tempatan (desktop + pelayar + mudah alih) / Powered By AI Genius Institute
</p>

<p align="center">
  <a href="LICENSE"><img src="https://img.shields.io/badge/License-MIT-teal.svg?style=for-the-badge" alt="License" /></a>
  <a href="https://nodejs.org"><img src="https://img.shields.io/badge/Node.js-%3E%3D20-339933?style=for-the-badge&logo=nodedotjs&logoColor=white" alt="Node.js" /></a>
  <img src="https://img.shields.io/badge/TypeScript-5.9-3178C6?style=for-the-badge&logo=typescript&logoColor=white" alt="TypeScript" />
  <a href="https://github.com/AIGeniusInstitute/deep-think/stargazers"><img src="https://img.shields.io/github/stars/AIGeniusInstitute/deep-think?style=for-the-badge&color=f5a623" alt="GitHub Stars" /></a>
</p>

---

## Apa itu DeepThink

DeepThink ialah sistem AI Agent berbilang pengguna yang dihoskan sendiri, dibina di atas [Claude Agent SDK](https://github.com/anthropics/claude-agent-sdk-typescript). Ia membalut runtime Claude Code penuh sebagai perkhidmatan yang boleh diakses dari Feishu, Telegram, QQ, DingTalk, WeChat dan antara muka web. Menyokong baca/tulis fail, kawalan terminal, automasi pelayar, penaakulan berbilang pusingan dan ekosistem alat MCP.

Prinsip reka bentuk: **jangan laksanakan semula keupayaan Agent, sebaliknya gunakan semula Claude Code secara langsung**. Di belakang tabir berjalan runtime Claude Code CLI penuh, bukan pembungkus API atau rantai prompt. Peningkatan Claude Code (alat baharu, penaakulan lebih kuat, sokongan MCP lebih meluas) dipantulkan ke DeepThink secara automatik tanpa penyesuai.

### Ciri utama

- **Enjin Claude Code natif** — berasaskan Claude Agent SDK, runtime dalaman ialah CLI Claude Code penuh, mewarisi semua keupayaan
- **Pencilan berbilang pengguna** — workspace setiap pengguna, saluran IM setiap pengguna, sistem kebenaran RBAC, pendaftaran kod jemputan, log audit
- **Penghalaan enam saluran** — Feishu WebSocket, Telegram Bot API, QQ Bot API v2, DingTalk Stream, WeChat iLink, antara muka web
- **Imbangan beban berbilang penyedia** — berbilang penyedia Claude API, tiga strategi (round-robin / weighted / failover) dengan pemeriksaan kesihatan automatik
- **Pengebilan dan statistik penggunaan** — pengebilan penuh (langganan, dompet, kod penebusan), penjejakan token setiap model dengan carta
- **PWA mudah alih** — dioptimumkan untuk mudah alih, pemasangan ke skrin rumah dengan satu klik, sokongan iOS dan Android

## Mula Cepat

### Prasyarat

**Wajib**: [Node.js](https://nodejs.org) >= 20, [Docker](https://www.docker.com/) (untuk mod container; tidak diperlukan untuk mod host admin), kunci Claude API (Anthropic rasmi atau perkhidmatan relay serasi).

**Pilihan**: kredensial aplikasi perusahaan Feishu, Telegram Bot Token, kredensial QQ Bot, kredensial DingTalk, token WeChat iLink — hanya jika integrasi IM diperlukan.

> Tidak perlu memasang Claude Code CLI secara manual — kebergantungan Claude Agent SDK projek merangkumi runtime CLI penuh, dipasang automatik pada `make start` pertama.

### Pemasangan dan pelancaran

```bash
# 1. Klon repositori
git clone https://github.com/AIGeniusInstitute/deep-think.git
cd deepthink

# 2. Pelancaran satu arahan (pemasangan pertama kebergantungan + kompilasi)
make start
```

Buka http://localhost:9898 dan ikuti wizard pemasangan: cipta pentadbir (tiada akaun lalai), konfigurasi Claude API dan saluran IM jika perlu. Semuanya dikonfigurasi dari antara muka web, tiada fail konfigurasi. Kunci API disulitkan dengan AES-256-GCM.

### Pengaktifan mod container

Pengguna admin secara lalai menggunakan mod host (tanpa Docker). Mod container diperlukan untuk pengguna member (diaktifkan automatik selepas pendaftaran):

```bash
./container/build.sh
```

Selepas pendaftaran pengguna baharu, workspace utama mod container (`home-{userId}`) dicipta secara automatik, tanpa konfigurasi tambahan.

## Gambaran keseluruhan senibina

DeepThink terdiri daripada tiga projek Node.js bebas:

- **Backend** (Node.js 22 + TypeScript 5.9 + Hono): penghala mesej (polling 2s + nyahpendua), baris gilir serentak (maksimum 20 container + 5 proses host), penjadual tugas (cron / interval / once), pelayan WebSocket untuk penstriman masa nyata dan terminal, pengesahan bcrypt + HMAC Cookie, RBAC, pengurusan konfigurasi tersulit AES-256-GCM. Data dalam SQLite (mod WAL, schema v1→v33).
- **Frontend** (`web/`): React 19 SPA + Vite 6 + Zustand 5 + Tailwind CSS 4 + shadcn/ui, react-markdown, mermaid, recharts, xterm.js, PWA mudah alih.
- **Agent Runner** (`container/agent-runner/`): enjin pelaksanaan dalam container Docker atau sebagai proses host. Memanggil `query()` Claude Agent SDK, memancarkan 14 jenis StreamEvent dan menyediakan 12 alat MCP kepada proses induk melalui IPC berasaskan fail dengan tulisan atomik.

Enam saluran IM memasuki penghala, dinyahpendua dan dibaris gilir, ProviderPool memilih kunci API dan melancarkan container atau proses host. Acara penstriman dipancarkan ke klien web melalui WebSocket atau kembali ke saluran melalui API IM.

## Dokumentasi penuh

Panduan penuh tersedia di sini:

- [Versi penuh Bahasa Inggeris](README.md)
- [Versi penuh 简体中文](README.zh-CN.md)

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
