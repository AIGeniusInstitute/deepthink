**Languages**: [English](README.md) · [简体中文](README.zh-CN.md) · [Español](README.es.md) · [हिन्दी](README.hi.md) · [العربية](README.ar.md) · [বাংলা](README.bn.md) · [Português](README.pt.md) · [Русский](README.ru.md) · [日本語](README.ja.md) · [Deutsch](README.de.md) · [Français](README.fr.md) · [Bahasa Indonesia](README.id.md) · [اردو](README.ur.md) · [मराठी](README.mr.md) · [తెలుగు](README.te.md) · [Türkçe](README.tr.md) · [தமிழ்](README.ta.md) · [한국어](README.ko.md) · [Tiếng Việt](README.vi.md) · [Italiano](README.it.md) · [Polski](README.pl.md) · [Українська](README.uk.md) · [Nederlands](README.nl.md) · [ไทย](README.th.md) · [ગુજરાતી](README.gu.md) · [Bahasa Melayu](README.ms.md) · [ಕನ್ನಡ](README.kn.md) · [فارسی](README.fa.md) · [Svenska](README.sv.md) · [Čeština](README.cs.md)

<p align="center">
  <img src="web/public/icons/logo-1024.png" alt="DeepThink Logo" width="400" />
</p>

<p align="center">
  <a href="static/deep-think-intro.mp4" target="_blank" title="DeepThink Intro Video">
    <img src="static/deep-think-start-logo.png" alt="DeepThink Splash & Intro Video" width="800" />
  </a>
</p>

<h1 align="center">DeepThink</h1>

<p align="center" dir="rtl">
  نظام هندسة حلقات وكيل الذكاء الاصطناعي محلي ذاتي الاستضافة متعدد المستخدمين (سطح المكتب + المتصفح + الجوال) / مدعوم من معهد AI Genius
</p>

<p align="center">
  <a href="LICENSE"><img src="https://img.shields.io/badge/License-MIT-teal.svg?style=for-the-badge" alt="License" /></a>
  <a href="https://nodejs.org"><img src="https://img.shields.io/badge/Node.js-%3E%3D20-339933?style=for-the-badge&logo=nodedotjs&logoColor=white" alt="Node.js" /></a>
  <img src="https://img.shields.io/badge/TypeScript-5.9-3178C6?style=for-the-badge&logo=typescript&logoColor=white" alt="TypeScript" />
  <a href="https://github.com/AIGeniusInstitute/deep-think/stargazers"><img src="https://img.shields.io/github/stars/AIGeniusInstitute/deep-think?style=for-the-badge&color=f5a623" alt="GitHub Stars" /></a>
</p>

---

<div dir="rtl">

## ما هو DeepThink؟

DeepThink هو نظام وكيل ذكاء اصطناعي ذاتي الاستضافة ومتعدد المستخدمين مبني على [Claude Agent SDK](https://github.com/anthropics/claude-agent-sdk-typescript). يغلّف runtime كامل لـ Claude Code في خدمة يمكن الوصول إليها عبر Feishu و Telegram و QQ و DingTalk و WeChat وواجهة Web، مع دعم قراءة/كتابة الملفات وعمليات الطرفية وأتمتة المتصفح والاستدلال متعدد الجولات ونظام أدوات MCP.

مبدأ التصميم الأساسي: **لا تُعيد تنفيذ قدرات الوكيل، أعِد استخدام Claude Code مباشرة**. ما يُستدعى تحته هو runtime كامل لـ Claude Code CLI، وليس غلاف API أو سلسلة مطالبات. كل ترقية لـ Claude Code — أدوات جديدة، استدلال أقوى، دعم MCP أكثر — تفيد DeepThink تلقائيًا دون أي تكييف.

### الميزات الرئيسية

- **مدفوع بـ Claude Code أصلاً** — مبني على Claude Agent SDK، runtime الأساسي هو Claude Code CLI الكامل، يرث جميع قدراته
- **عزل متعدد المستخدمين** — مساحة عمل لكل مستخدم، قنوات مراسلة فورية لكل مستخدم، نظام صلاحيات RBAC، تسجيل بكود دعوة، سجلات تدقيق
- **توجيه موحد لست قنوات** — Feishu WebSocket، Telegram Bot API، QQ Bot API v2، DingTalk Stream، WeChat iLink، واجهة Web
- **موازنة حمل متعددة المزودين** — عدة مزودي Claude API، ثلاث استراتيجيات (round-robin / weighted / failover) مع فحص صحة تلقائي
- **الفوترة وإحصاءات الاستخدام** — نظام فوترة كامل (اشتراك، محفظة، أكواد استبدال)، تتبع الرموز لكل نموذج مع رسوم بيانية
- **PWA للجوال** — مُحسّن بعمق للجوال، تثبيت بنقرة واحدة على سطح المكتب، iOS و Android مُكيّفان

## البداية السريعة

### المتطلبات الأساسية

**إلزامي**: [Node.js](https://nodejs.org) >= 20، [Docker](https://www.docker.com/) (لوضع الحاوية؛ المسؤول في وضع المضيف لا يحتاجه)، ومفتاح Claude API (Anthropic الرسمي أو خدمة ترحيل متوافقة).

**اختياري**: بيانات اعتماد تطبيق Feishu، Telegram Bot Token، بيانات اعتماد QQ Bot، بيانات اعتماد DingTalk، رمز WeChat iLink — فقط إذا أردت تكاملات المراسلة الفورية.

> لا تحتاج إلى تثبيت Claude Code CLI يدويًا — تبعية Claude Agent SDK في المشروع تتضمن runtime الكامل للـ CLI، ويُثبَّت تلقائيًا عند أول تشغيل لـ `make start`.

### التثبيت والتشغيل

```bash
# 1. استنساخ المستودع
git clone https://github.com/AIGeniusInstitute/deep-think.git
cd deepthink

# 2. بدء بأمر واحد (يثبّت التبعيات ويجمّع أول مرة)
make start
```

زر http://localhost:9898 واتبع معالج الإعداد: أنشئ المسؤول (لا يوجد حساب افتراضي)، هيّئ Claude API، واختياريًا هيّئ قنوات المراسلة. تتم كل التهيئة من واجهة Web دون أي ملفات تهيئة. تُخزَّن مفاتيح API مشفّرة بـ AES-256-GCM.

### تفعيل وضع الحاوية

يستخدم المسؤول افتراضيًا وضع المضيف (بدون Docker). إذا احتجت وضع الحاوية (يستخدمه المستخدمون الأعضاء تلقائيًا بعد التسجيل):

```bash
./container/build.sh
```

بعد التسجيل، يحصل كل مستخدم جديد تلقائيًا على مساحة عمل رئيسية بوضع الحاوية (`home-{userId}`)، دون تهيئة إضافية.

## نظرة عامة على البنية

يتكون DeepThink من ثلاثة مشاريع Node.js مستقلة:

- **الخلفية** (Node.js 22 + TypeScript 5.9 + Hono): الخدمة الرئيسية مع موجّه رسائل (اقتراع 2s + إزالة تكرار)، طابور تزامن (حتى 20 حاوية + 5 عمليات مضيف)، مجدول مهام (cron / interval / once)، خادم WebSocket للبث المباشر والطرفية، مصادقة bcrypt + HMAC Cookie، RBAC، وإدارة تهيئة مشفّرة بـ AES-256-GCM. البيانات في SQLite (وضع WAL، مخطط v1→v33).
- **الواجهة الأمامية** (`web/`): تطبيق صفحة واحدة بـ React 19 + Vite 6 + Zustand 5 + Tailwind CSS 4 + shadcn/ui، مع react-markdown و mermaid و recharts و xterm.js و PWA للجوال.
- **مشغّل الوكيل** (`container/agent-runner/`): محرك التنفيذ الذي يعمل داخل حاوية Docker أو كعملية مضيف؛ يستدعي `query()` من Claude Agent SDK، يبث 14 نوعًا من StreamEvent، ويقدم 12 أداة MCP للعملية الرئيسية عبر قنوات IPC قائمة على الملفات مع كتابة ذرّية.

تدخل القنوات الست (Feishu، Telegram، QQ، DingTalk، WeChat، Web) إلى الموجّه، تُزال تكرارها وتُوجَّه إلى الطابور، الذي يختار مفتاح API عبر ProviderPool ويشغل الحاوية أو عملية المضيف. تُبَثّ أحداث البث عبر WebSocket إلى عميل Web أو تُرد عبر واجهات برمجة تطبيقات المراسلة إلى كل قناة.

## الوثائق الكاملة

للحصول على الدليل الكامل، راجع:

- [النسخة الإنجليزية الكاملة](README.md)
- [النسخة الكاملة بـ 简体中文](README.zh-CN.md)

</div>

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
