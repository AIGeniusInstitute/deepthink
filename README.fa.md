**Languages**: [English](README.md) · [简体中文](README.zh-CN.md) · [Español](README.es.md) · [हिन्दी](README.hi.md) · [العربية](README.ar.md) · [বাংলা](README.bn.md) · [Português](README.pt.md) · [Русский](README.ru.md) · [日本語](README.ja.md) · [Deutsch](README.de.md) · [Français](README.fr.md) · [Bahasa Indonesia](README.id.md) · [اردو](README.ur.md) · [मराठी](README.mr.md) · [తెలుగు](README.te.md) · [Türkçe](README.tr.md) · [தமிழ்](README.ta.md) · [한국어](README.ko.md) · [Tiếng Việt](README.vi.md) · [Italiano](README.it.md) · [Polski](README.pl.md) · [Українська](README.uk.md) · [Nederlands](README.nl.md) · [ไทย](README.th.md) · [ગુજરાતી](README.gu.md) · [Bahasa Melayu](README.ms.md) · [ಕನ್ನಡ](README.kn.md) · [فارسی](README.fa.md) · [Svenska](README.sv.md) · [Čeština](README.cs.md)

<p align="center">
  <img src="web/public/icons/logo-1024.png" alt="DeepThink Logo" width="400" />
</p>

<h1 align="center">DeepThink</h1>

<p align="center">
  سیستم خودمیزبانی چندکاربرهٔ محلی AI Agent Loop Engineering (دسکتاپ + مرورگر + موبایل) / Powered By AI Genius Institute
</p>

<p align="center">
  <a href="LICENSE"><img src="https://img.shields.io/badge/License-MIT-teal.svg?style=for-the-badge" alt="License" /></a>
  <a href="https://nodejs.org"><img src="https://img.shields.io/badge/Node.js-%3E%3D20-339933?style=for-the-badge&logo=nodedotjs&logoColor=white" alt="Node.js" /></a>
  <img src="https://img.shields.io/badge/TypeScript-5.9-3178C6?style=for-the-badge&logo=typescript&logoColor=white" alt="TypeScript" />
  <a href="https://github.com/AIGeniusInstitute/deep-think/stargazers"><img src="https://img.shields.io/github/stars/AIGeniusInstitute/deep-think?style=for-the-badge&color=f5a623" alt="GitHub Stars" /></a>
</p>

---

## DeepThink چیست

DeepThink یک سیستم خودمیزبانی چندکاربرهٔ AI Agent است که بر روی [Claude Agent SDK](https://github.com/anthropics/claude-code/tree/main/packages/claude-agent-sdk) ساخته شده است. runtime کامل Claude Code را به‌عنوان سرویسی در دسترس از Feishu، Telegram، QQ، DingTalk، WeChat و رابط وب بسته‌بندی می‌کند. از خواندن/نوشتن فایل، کنترل ترمینال، خودکارسازی مرورگر، استنتاج چندمرحله‌ای و اکوسیستم ابزارهای MCP پشتیبانی می‌کند.

اصل طراحی: **قابلیت‌های Agent را بازنویسی نکنیم، بلکه Claude Code را مستقیماً استفاده مجدد کنیم**. زیر پوشش، runtime کامل Claude Code CLI اجرا می‌شود، نه یک API wrapper یا زنجیرهٔ prompt. ارتقاءهای Claude Code (ابزارهای جدید، استدلال قوی‌تر، پشتیبانی گسترده‌تر MCP) به‌طور خودکار و بدون آداپتور در DeepThink بازتاب می‌یابند.

### ویژگی‌های کلیدی

- **موتور بومی Claude Code** — بر پایهٔ Claude Agent SDK، runtime داخلی همان Claude Code CLI کامل است و تمام توانایی‌ها را به ارث می‌برد
- **جداسازی چندکاربره** — workspace هر کاربر، کانال IM هر کاربر، سیستم دسترسی RBAC، ثبت‌نام با کد دعوت، لاگ ممیزی
- **مسیریابی شش‌کاناله** — Feishu WebSocket، Telegram Bot API، QQ Bot API v2، DingTalk Stream، WeChat iLink، رابط وب
- **موازنه بار چندprovider** — چند providerهای Claude API، سه راهبرد (round-robin / weighted / failover) با بررسی سلامت خودکار
- **صورتحساب و آمار استفاده** — سیستم صورتحساب کامل (اشتراک، کیف پول، کدهای بازخرید)، ردیابی توکن به تفکیک مدل با نمودار
- **PWA موبایل** — بهینه برای موبایل، نصب روی صفحهٔ اصلی با یک کلیک، پشتیبانی iOS و Android

## شروع سریع

### پیش‌نیازها

**الزومی**: [Node.js](https://nodejs.org) >= 20، [Docker](https://www.docker.com/) (برای حالت container؛ برای حالت host ادمین لازم نیست)، کلید Claude API (Anthropic رسمی یا سرویس relay سازگار).

**اختیاری**: اعتبارنامه‌های Feishu Enterprise App، Telegram Bot Token، اعتبارنامه‌های QQ Bot، اعتبارنامه‌های DingTalk، توکن WeChat iLink — تنها در صورت نیاز به اتصال IM.

> نیازی به نصب دستی Claude Code CLI نیست — وابستگی پروژه به Claude Agent SDK شامل runtime کامل CLI است و در اولین `make start` به‌طور خودکار نصب می‌شود.

### نصب و راه‌اندازی

```bash
# 1. کلون مخزن
git clone https://github.com/AIGeniusInstitute/deep-think.git
cd deepthink

# 2. راه‌اندازی با یک دستور (در اولین اجرا نصب وابستگی‌ها + کامپایل)
make start
```

به http://localhost:3000 بروید و جادوگر نصب را دنبال کنید: ایجاد ادمین (بدون حساب پیش‌فرض)، پیکربندی Claude API و در صورت نیاز کانال‌های IM. همه‌چیز از رابط وب پیکربندی می‌شود و نیازی به فایل پیکربندی نیست. کلیدهای API با AES-256-GCM رمزنگاری و ذخیره می‌شوند.

### فعال‌سازی حالت container

کاربر ادمین به‌طور پیش‌فرض از حالت host (بدون Docker) استفاده می‌کند. حالت container برای کاربران member پس از ثبت‌نام به‌طور خودکار فعال می‌شود:

```bash
./container/build.sh
```

پس از ثبت‌نام کاربر جدید، workspace اصلی در حالت container (`home-{userId}`) خودکار ساخته می‌شود و نیازی به پیکربندی اضافی نیست.

## مرور معماری

DeepThink از سه پروژهٔ مستقل Node.js تشکیل شده است:

- **Backend** (Node.js 22 + TypeScript 5.9 + Hono): مسیریاب پیام (polling 2s + حذف تکرار)، صف همزمان (تا 20 container + 5 فرآیند host)، زمان‌بند وظایف (cron / interval / once)، سرور WebSocket برای streaming بلادرنگ و ترمینال، احراز هویت bcrypt + HMAC Cookie، RBAC، مدیریت پیکربندی رمزنگاری‌شده AES-256-GCM. داده‌ها در SQLite (حالت WAL، schema v1→v33).
- **Frontend** (`web/`): React 19 SPA + Vite 6 + Zustand 5 + Tailwind CSS 4 + shadcn/ui، react-markdown، mermaid، recharts، xterm.js، PWA موبایل.
- **Agent Runner** (`container/agent-runner/`): موتور اجرایی در Docker container یا فرآیند host. تابع `query()` از Claude Agent SDK را فراخوانی می‌کند، 14 نوع StreamEvent را emit می‌کند و از طریق IPC فایلی با نوشتن اتمیک، 12 ابزار MCP را به فرآیند والد ارائه می‌دهد.

شش کانال IM وارد مسیریاب می‌شوند، پس از حذف تکرار در صف قرار می‌گیرند، از طریق ProviderPool کلید API انتخاب می‌شود و container یا فرآیند host راه‌اندازی می‌گردد. رویدادهای streaming با WebSocket به کلاینت‌های وب و از طریق IM API به کانال‌ها بازمی‌گردند.

## مستندات کامل

راهنمای کامل را اینجا ببینید:

- [نسخهٔ کامل انگلیسی](README.md)
- [نسخهٔ کامل 简体中文](README.zh-CN.md)

---

**Languages**: [English](README.md) · [简体中文](README.zh-CN.md) · [Español](README.es.md) · [हिन्दी](README.hi.md) · [العربية](README.ar.md) · [বাংলা](README.bn.md) · [Português](README.pt.md) · [Русский](README.ru.md) · [日本語](README.ja.md) · [Deutsch](README.de.md) · [Français](README.fr.md) · [Bahasa Indonesia](README.id.md) · [اردو](README.ur.md) · [मराठी](README.mr.md) · [తెలుగు](README.te.md) · [Türkçe](README.tr.md) · [தமிழ்](README.ta.md) · [한국어](README.ko.md) · [Tiếng Việt](README.vi.md) · [Italiano](README.it.md) · [Polski](README.pl.md) · [Українська](README.uk.md) · [Nederlands](README.nl.md) · [ไทย](README.th.md) · [ગુજરાતી](README.gu.md) · [Bahasa Melayu](README.ms.md) · [ಕನ್ನಡ](README.kn.md) · [فارسی](README.fa.md) · [Svenska](README.sv.md) · [Čeština](README.cs.md)
