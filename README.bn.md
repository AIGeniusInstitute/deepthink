**Languages**: [English](README.md) · [简体中文](README.zh-CN.md) · [Español](README.es.md) · [হিন্দী](README.hi.md) · [العربية](README.ar.md) · [বাংলা](README.bn.md) · [Português](README.pt.md) · [Русский](README.ru.md) · [日本語](README.ja.md) · [Deutsch](README.de.md) · [Français](README.fr.md) · [Bahasa Indonesia](README.id.md) · [اردو](README.ur.md) · [মরাঠী](README.mr.md) · [తెలుగు](README.te.md) · [Türkçe](README.tr.md) · [தமிழ்](README.ta.md) · [한국어](README.ko.md) · [Tiếng Việt](README.vi.md) · [Italiano](README.it.md) · [Polski](README.pl.md) · [Українська](README.uk.md) · [Nederlands](README.nl.md) · [ไทย](README.th.md) · [ગુજરાતી](README.gu.md) · [Bahasa Melayu](README.ms.md) · [ಕನ್ನಡ](README.kn.md) · [فارسی](README.fa.md) · [Svenska](README.sv.md) · [Čeština](README.cs.md)

<p align="center">
  <img src="web/public/icons/logo-1024.png" alt="DeepThink Logo" width="400" />
</p>

<h1 align="center">DeepThink</h1>

<p align="center">
  স্ব-হোস্টেড মাল্টি-ইউজার স্থানীয় AI Agent Loop Engineering সিস্টেম (ডেস্কটপ + ব্রাউজার + মোবাইল) / AI Genius Institute দ্বারা চালিত
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


## DeepThink কী?

DeepThink হলো একটি স্ব-হোস্টেড, মাল্টি-ইউজার AI Agent সিস্টেম যা [Claude Agent SDK](https://github.com/anthropics/claude-agent-sdk-typescript)-এর উপর নির্মিত। এটি সম্পূর্ণ Claude Code রানটাইমকে Feishu, Telegram, QQ, DingTalk, WeChat এবং Web ইন্টারফেস থেকে অ্যাক্সেসযোগ্য পরিষেবায় মোড়ায়, ফাইল পড়া/লেখা, টার্মিনাল অপারেশন, ব্রাউজার অটোমেশন, মাল্টি-রাউন্ড রিজনিং এবং MCP টুল ইকোসিস্টেম সমর্থন সহ।

মূল ডিজাইন নীতি: **Agent ক্ষমতা পুনরায় বাস্তবায়ন করবেন না, Claude Code সরাসরি পুনরায় ব্যবহার করুন**। নিচে যা ইনভোক হয় তা সম্পূর্ণ Claude Code CLI রানটাইম, API র‍্যাপার বা প্রম্পট চেইন নয়। Claude Code-এর প্রতিটি আপগ্রেড — নতুন টুল, শক্তিশালী রিজনিং, আরও MCP সমর্থন — DeepThink-কে কোনো অ্যাডাপ্টেশন ছাড়াই স্বয়ংক্রিয়ভাবে উপকৃত করে।

### মূল বৈশিষ্ট্য

- **স্থানীয়ভাবে Claude Code চালিত** — Claude Agent SDK-র উপর ভিত্তি, অন্তর্নিহিত রানটাইম সম্পূর্ণ Claude Code CLI, সব ক্ষমতা উত্তরাধিকারে পায়
- **মাল্টি-ইউজার আইসোলেশন** — প্রতি-ইউজার ওয়ার্কস্পেস, প্রতি-ইউজার IM চ্যানেল, RBAC অনুমতি ব্যবস্থা, আমন্ত্রণ কোড নিবন্ধন, অডিট লগ
- **ছয় চ্যানেলের একীভূত রাউটিং** — Feishu WebSocket, Telegram Bot API, QQ Bot API v2, DingTalk Stream, WeChat iLink, Web ইন্টারফেস
- **মাল্টি-প্রোভাইডার লোড ব্যালেন্সিং** — একাধিক Claude API প্রোভাইডার, তিনটি কৌশল (round-robin / weighted / failover), স্বয়ংক্রিয় হেলথ চেক
- **বিলিং ও ব্যবহার পরিসংখ্যা** — সম্পূর্ণ বিলিং সিস্টেম (সাবস্ক্রিপশন প্ল্যান, ওয়ালেট ব্যালেন্স, রিডিম কোড), প্রতি-মডেল টোকেন ট্র্যাকিং ও চার্ট ভিজ্যুয়ালাইজেশন
- **মোবাইল PWA** — মোবাইলের জন্য গভীরভাবে অপ্টিমাইজড, ডেস্কটপে এক-ক্লিক ইনস্টল, iOS / Android উভয়ই অভিযোজিত

## দ্রুত শুরু

### পূর্বশর্ত

**বাধ্যতামূলক**: [Node.js](https://nodejs.org) >= 20, [Docker](https://www.docker.com/) (কন্টেইনার মোডের জন্য; admin শুধু হোস্ট মোডে এটি প্রয়োজন করে না), এবং Claude API কী (Anthropic অফিসিয়াল বা সামঞ্জস্যপূর্ণ রিলে পরিষেবা)।

**ঐচ্ছিক**: Feishu এন্টারপ্রাইজ অ্যাপ ক্রেডেনশিয়াল, Telegram Bot Token, QQ Bot ক্রেডেনশিয়াল, DingTalk ক্রেডেনশিয়াল, WeChat iLink টোকেন — শুধু যদি আপনি IM ইন্টিগ্রেশন চান।

> Claude Code CLI ম্যানুয়ালি ইনস্টল করার প্রয়োজন নেই — প্রোজেক্টের Claude Agent SDK নির্ভরতায় সম্পূর্ণ CLI রানটাইম অন্তর্ভুক্ত, `make start` প্রথমবার চালানোর সময় স্বয়ংক্রিয়ভাবে ইনস্টল হয়।

### ইনস্টল ও শুরু

```bash
# 1. রিপোজিটরি ক্লোন করুন
git clone https://github.com/AIGeniusInstitute/deep-think.git
cd deepthink

# 2. এক-কমান্ড শুরু (প্রথমবার নির্ভরতা ইনস্টল + কম্পাইল)
make start
```

http://localhost:9898-এ যান এবং সেটআপ উইজার্ড অনুসরণ করুন: অ্যাডমিন তৈরি করুন (কোনো ডিফল্ট অ্যাকাউন্ট নেই), Claude API কনফিগার করুন, এবং ঐচ্ছিকভাবে IM চ্যানেল কনফিগার করুন। সব কনফিগারেশন Web ইন্টারফেস থেকে করা হয়, কোনো কনফিগ ফাইল ছাড়া। API কী AES-256-GCM দিয়ে এনক্রিপ্টেড সংরক্ষিত।

### কন্টেইনার মোড সক্ষম করুন

admin ব্যবহারকারী ডিফল্টভাবে হোস্ট মোড ব্যবহার করে (Docker প্রয়োজন নেই)। আপনার যদি কন্টেইনার মোড প্রয়োজন হয় (member ব্যবহারকারী নিবন্ধনের পর স্বয়ংক্রিয়ভাবে ব্যবহার করে):

```bash
./container/build.sh
```

নতুন ব্যবহারকারী নিবন্ধনের পর স্বয়ংক্রিয়ভাবে কন্টেইনার মোডের প্রধান ওয়ার্কস্পেস (`home-{userId}`) তৈরি হয়, অতিরিক্ত কনফিগারেশন ছাড়া।

## আর্কিটেকচার ওভারভিউ

DeepThink তিনটি স্বাধীন Node.js প্রোজেক্ট নিয়ে গঠিত:

- **ব্যাকএন্ড** (Node.js 22 + TypeScript 5.9 + Hono): প্রধান পরিষেবা যাতে মেসেজ রাউটার (2s পোলিং + ডিডুপ), কনকারেন্সি কিউ (সর্বোচ্চ 20 কন্টেইনার + 5 হোস্ট প্রসেস), টাস্ক শিডিউলার (cron / interval / once), রিয়েল-টাইম স্ট্রিমিং ও টার্মিনালের জন্য WebSocket সার্ভার, bcrypt + HMAC Cookie অথেন্টিকেশন, RBAC, এবং AES-256-GCM এনক্রিপ্টেড কনফিগ ম্যানেজমেন্ট অন্তর্ভুক্ত। ডেটা SQLite-এ (WAL মোড, স্কিমা v1→v33)।
- **ফ্রন্টএন্ড** (`web/`): React 19 SPA + Vite 6 + Zustand 5 + Tailwind CSS 4 + shadcn/ui, react-markdown, mermaid, recharts, xterm.js এবং মোবাইল PWA সহ।
- **Agent Runner** (`container/agent-runner/`): এক্সিকিউশন ইঞ্জিন যা Docker কন্টেইনার বা হোস্ট প্রসেস হিসেবে চলে; Claude Agent SDK-এর `query()` ইনভোক করে, 14 ধরনের StreamEvent নির্গত করে, এবং অ্যাটমিক রাইটিং সহ ফাইল-ভিত্তিক IPC চ্যানেলের মাধ্যমে 12টি MCP টুল সরবরাহ করে।

ছয়টি IM চ্যানেল (Feishu, Telegram, QQ, DingTalk, WeChat, Web) রাউটারে প্রবেশ করে, ডিডুপ্লিকেট ও কিউতে রাউট হয়, যা ProviderPool-এর মাধ্যমে API কী নির্বাচন করে কন্টেইনার বা হোস্ট প্রসেস শুরু করে। স্ট্রিমিং ইভেন্টগুলি WebSocket দ্বারা Web ক্লায়েন্টে বা IM API-এর মাধ্যমে প্রতিটি চ্যানেলে ফেরত পাঠানো হয়।

## সম্পূর্ণ ডকুমেন্টেশন

সম্পূর্ণ গাইডের জন্য, দেখুন:

- [ইংরেজি সম্পূর্ণ সংস্করণ](README.md)
- [简体中文 সম্পূর্ণ সংস্করণ](README.zh-CN.md)

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
