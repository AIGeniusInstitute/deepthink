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

<p align="center">
  <video src="static/deep-think-intro.mp4" 
    poster="static/deep-think-start-logo.png" controls width="800"></video>
</p>


## DeepThink چیست

DeepThink، یک پلتفرم خود-تکامل‌یافته ابر-هوش Agent خودمختار در سطح سازمانی، پیشگام گذار از پارادایم Harness Engineering به Loop Engineering، نسل جدیدی از زیرساخت هوش مصنوعی (AI Infra) برای مشتریان سازمانی است. پلتفرم DeepThink بر چارچوب همکاری چند-Agent متمرکز است و AI Coding، Self-Evolving، Full-Stack Observability، Bug Auto-Fix Loop و Human-Agent Symbiosis را ترکیب می‌کند تا یک سیستم هوش مصنوعی سازمانی بسازد که به طور مداوم یاد می‌گیرد، خود را بهبود می‌بخشد و در نهایت به ابر-هوش تبدیل می‌شود:

- **پلتفرم R&D خودمختار با هوش مصنوعی** — Agent به طور مستقل چرخه کامل توسعه نرم‌افزار را تکمیل می‌کند، بدون نیاز به مهندسان انسانی در وظایف برنامه‌نویسی روزمره
- **موتور Agent خود-تکاملی** — Agent به طور مداوم از خطاها یاد می‌گیرد، دانش را از پایگاه کد جذب می‌کند و از بازخورد کاربران تکامل می‌یابد
- **مرکز همکاری برنامه‌نویس-Agent** — هر برنامه‌نویس دارای یک «پروژه توسعه» شخصی است که شامل چندین جلسه موازی است و یک زمان‌بند مرکزی از تعارضات همزمانی جلوگیری می‌کند
- **پلتفرم SaaS سازمانی** — جداسازی چندمستاجری، مجوزهای سلسله‌مراتبی، صورت‌حساب انعطاف‌پذیر و یکپارچگی‌های سازمانی (Feishu/DingTalk/WeCom/LDAP)
- **انکوباتور ابر-هوش** — از طریق تکامل مداوم، در نهایت یک Agent واحد به قابلیت‌های جامع یک تیم نرم‌افزاری کامل دست می‌یابد

> «بگذارید هر سازمان صاحب یک تیم ابر-R&D هوش مصنوعی باشد که هرگز متوقف نمی‌شود و به طور مداوم تکامل می‌یابد — از کاربر ابزار، به خالق کد، و در نهایت رشد یافته به ابر-هوشی که خود را تکثیر می‌کند. بیایید با هم در مسیر رسیدن به AGI گام برداریم.»"

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

به http://localhost:9898 بروید و جادوگر نصب را دنبال کنید: ایجاد ادمین (بدون حساب پیش‌فرض)، پیکربندی Claude API و در صورت نیاز کانال‌های IM. همه‌چیز از رابط وب پیکربندی می‌شود و نیازی به فایل پیکربندی نیست. کلیدهای API با AES-256-GCM رمزنگاری و ذخیره می‌شوند.

### فعال‌سازی حالت container

کاربر ادمین به‌طور پیش‌فرض از حالت host (بدون Docker) استفاده می‌کند. حالت container برای کاربران member پس از ثبت‌نام به‌طور خودکار فعال می‌شود:

```bash
./container/build.sh
```

پس از ثبت‌نام کاربر جدید، workspace اصلی در حالت container (`home-{userId}`) خودکار ساخته می‌شود و نیازی به پیکربندی اضافی نیست.

## مرور معماری


<p align="center">
  <img src="docs/architecture/deepthink-architecture.png" alt="DeepThink System Architecture" width="860" />
</p>


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
