**Languages**: [English](README.md) · [简体中文](README.zh-CN.md) · [Español](README.es.md) · [हिन्दी](README.hi.md) · [العربية](README.ar.md) · [বাংলা](README.bn.md) · [Português](README.pt.md) · [Русский](README.ru.md) · [日本語](README.ja.md) · [Deutsch](README.de.md) · [Français](README.fr.md) · [Bahasa Indonesia](README.id.md) · [اردو](README.ur.md) · [मराठी](README.mr.md) · [తెలుగు](README.te.md) · [Türkçe](README.tr.md) · [தமிழ்](README.ta.md) · [한국어](README.ko.md) · [Tiếng Việt](README.vi.md) · [Italiano](README.it.md) · [Polski](README.pl.md) · [Українська](README.uk.md) · [Nederlands](README.nl.md) · [ไทย](README.th.md) · [ગુજરાતી](README.gu.md) · [Bahasa Melayu](README.ms.md) · [ಕನ್ನಡ](README.kn.md) · [فارسی](README.fa.md) · [Svenska](README.sv.md) · [Čeština](README.cs.md)

<p align="center">
  <img src="web/public/icons/logo-1024.png" alt="DeepThink Logo" width="400" />
</p>

<h1 align="center">DeepThink</h1>

<p align="center">
  स्व-होस्ट केलेली बहु-वापरकर्ता स्थानिक AI Agent Loop Engineering प्रणाली (डेस्कटॉप + ब्राउझर + मोबाइल) / Powered By AI Genius Institute
</p>

<p align="center">
  <a href="LICENSE"><img src="https://img.shields.io/badge/License-MIT-teal.svg?style=for-the-badge" alt="License" /></a>
  <a href="https://nodejs.org"><img src="https://img.shields.io/badge/Node.js-%3E%3D20-339933?style=for-the-badge&logo=nodedotjs&logoColor=white" alt="Node.js" /></a>
  <img src="https://img.shields.io/badge/TypeScript-5.9-3178C6?style=for-the-badge&logo=typescript&logoColor=white" alt="TypeScript" />
  <a href="https://github.com/AIGeniusInstitute/deep-think/stargazers"><img src="https://img.shields.io/github/stars/AIGeniusInstitute/deep-think?style=for-the-badge&color=f5a623" alt="GitHub Stars" /></a>
</p>

---

## DeepThink म्हणजे काय

DeepThink ही [Claude Agent SDK](https://github.com/anthropics/claude-code/tree/main/packages/claude-agent-sdk) वर बनवलेली स्व-होस्ट बहु-वापरकर्ता AI Agent प्रणाली आहे. ती संपूर्ण Claude Code runtime ला Feishu, Telegram, QQ, DingTalk, WeChat आणि वेब इंटरफेसवरून प्रवेश करता येण्याजोगी सेवा म्हणून गुंडाळते. फाइल वाचन/लेखन, टर्मिनल नियंत्रण, ब्राउझर ऑटोमेशन, मल्टी-राउंड रीजनिंग आणि MCP साधन परिसंस्थेला आधार देते.

डिझाइन तत्त्व: **Agent च्या क्षमता पुन्हा लागू करू नका, तर Claude Code चा थेट पुनर्वापर करा**. पाठीमागे संपूर्ण Claude Code CLI runtime चालते, API wrapper किंवा प्रॉम्प्ट चेन नाही. Claude Code च्या अपग्रेड्स (नवीन साधने, अधिक मजबूत रीजनिंग, अधिक MCP आधार) अडॅप्टरशिवाय आपोआप DeepThink मध्ये प्रतिबिंबित होतात.

### प्रमुख वैशिष्ट्ये

- **नेटिव्ह Claude Code इंजिन** — Claude Agent SDK आधारित, आंतरिक runtime संपूर्ण Claude Code CLI, सर्व क्षमता वारसात मिळतात
- **बहु-वापरकर्ता विलगीकरण** — प्रति वापरकर्ता workspace, प्रति वापरकर्ता IM चॅनेल, RBAC परवानगी प्रणाली, आमंत्रण कोड नोंदणी, ऑडिट लॉग
- **सहा-चॅनेल राउटिंग** — Feishu WebSocket, Telegram Bot API, QQ Bot API v2, DingTalk Stream, WeChat iLink, वेब इंटरफेस
- **मल्टी-प्रोव्हायडर लोड बॅलन्सिंग** — अनेक Claude API प्रोव्हायडर, तीन धोरणे (round-robin / weighted / failover) स्वयंचलित हेल्थ तपासणीसह
- **बिलिंग आणि वापर आकडेवारी** — संपूर्ण बिलिंग (सबस्क्रिप्शन, वॉलेट, रिडिम्पशन कोड), मॉडेलनिहाय टोकन ट्रॅकिंग चार्टसह
- **मोबाइल PWA** — मोबाइलसाठी अनुकूलित, एक क्लिकमध्ये होम स्क्रीनवर स्थापना, iOS आणि Android दोन्हीसाठी आधार

## जलद सुरुवात

### पूर्व-आवश्यकता

**आवश्यक**: [Node.js](https://nodejs.org) >= 20, [Docker](https://www.docker.com/) (कंटेनर मोडसाठी; admin च्या host मोडसाठी आवश्यक नाही), Claude API की (अधिकृत Anthropic किंवा सुसंगत रिले सेवा).

**ऐच्छिक**: Feishu एंटरप्राइझ अॅप क्रेडेन्शियल्स, Telegram Bot Token, QQ Bot क्रेडेन्शियल्स, DingTalk क्रेडेन्शियल्स, WeChat iLink टोकन — फक्त IM एकात्मकरण आवश्यक असल्यास.

> Claude Code CLI मॅन्युअली स्थापित करण्याची गरज नाही — प्रकल्पाची Claude Agent SDK अवलंबन संपूर्ण CLI runtime समाविष्ट करते, पहिल्या `make start` वर आपोआप स्थापित होते.

### स्थापना आणि सुरुवात

```bash
# 1. रिपॉजिटरी क्लोन करा
git clone https://github.com/AIGeniusInstitute/deep-think.git
cd deepthink

# 2. एका कमांडने सुरुवात (पहिल्यांदा अवलंबन स्थापना + कंपाईल)
make start
```

http://localhost:3000 उघडा आणि सेटअप विझार्ड फॉलो करा: admin तयार करा (कोणताही डिफॉल्ट खाते नाही), Claude API सेट करा आणि आवश्यकतेनुसार IM चॅनेल सेट करा. सर्व संरचना वेब इंटरफेसवरून होते, संरचना फाइल नाही. API की AES-256-GCM ने एन्क्रिप्ट होतात.

### कंटेनर मोड सक्रिय करा

admin वापरकर्ता डिफॉल्टनुसार host मोड (Docker विना) वापरतो. member वापरकर्त्यांसाठी कंटेनर मोड नोंदणीनंतर आपोआप सक्रिय होतो:

```bash
./container/build.sh
```

नवीन वापरकर्ता नोंदणीनंतर, कंटेनर मोडचे मुख्य workspace (`home-{userId}`) आपोआप तयार होते, अतिरिक्त संरचना विना.

## आर्किटेक्चर अवलोकन

DeepThink तीन स्वतंत्र Node.js प्रकल्पांचे बनले आहे:

- **बॅकएंड** (Node.js 22 + TypeScript 5.9 + Hono): संदेश राउटर (2s polling + डुप्लिकेट काढणे), समवर्ती रांग (कमाल 20 कंटेनर + 5 host प्रक्रिया), कार्य शेड्यूलर (cron / interval / once), रिअल-टाइम स्ट्रीमिंग आणि टर्मिनलसाठी WebSocket सर्व्हर, bcrypt + HMAC Cookie प्रमाणीकरण, RBAC, AES-256-GCM एन्क्रिप्टेड संरचना. डेटा SQLite (WAL मोड, schema v1→v33).
- **फ्रंटएंड** (`web/`): React 19 SPA + Vite 6 + Zustand 5 + Tailwind CSS 4 + shadcn/ui, react-markdown, mermaid, recharts, xterm.js, मोबाइल PWA.
- **Agent Runner** (`container/agent-runner/`): Docker कंटेनर किंवा host प्रक्रिया म्हणून चालणारे अंमलबत्तावज इंजिन. Claude Agent SDK च्या `query()` ला कॉल करते, 14 प्रकारचे StreamEvent उत्सर्जित करते आणि अणू-लेखन फाइल IPC मार्गे 12 MCP साधने पालक प्रक्रियेला पुरवते.

सहा IM चॅनेल राउटरमध्ये प्रवेश करतात, डुप्लिकेट काढून रांगेत टाकले जातात, ProviderPool मार्गे API की निवडली जाते आणि कंटेनर किंवा host प्रक्रिया सुरू होते. स्ट्रीमिंग इव्हेंट्स WebSocket ने वेब क्लायंट्सना आणि IM API ने चॅनेल्सना परत जातात.

## संपूर्ण दस्तऐवज

संपूर्ण मार्गदर्शक येथे पहा:

- [इंग्रजी संपूर्ण आवृत्ती](README.md)
- [简体中文 संपूर्ण आवृत्ती](README.zh-CN.md)

---

**Languages**: [English](README.md) · [简体中文](README.zh-CN.md) · [Español](README.es.md) · [हिन्दी](README.hi.md) · [العربية](README.ar.md) · [বাংলা](README.bn.md) · [Português](README.pt.md) · [Русский](README.ru.md) · [日本語](README.ja.md) · [Deutsch](README.de.md) · [Français](README.fr.md) · [Bahasa Indonesia](README.id.md) · [اردو](README.ur.md) · [मराठी](README.mr.md) · [తెలుగు](README.te.md) · [Türkçe](README.tr.md) · [தமிழ்](README.ta.md) · [한국어](README.ko.md) · [Tiếng Việt](README.vi.md) · [Italiano](README.it.md) · [Polski](README.pl.md) · [Українська](README.uk.md) · [Nederlands](README.nl.md) · [ไทย](README.th.md) · [ગુજરાતી](README.gu.md) · [Bahasa Melayu](README.ms.md) · [ಕನ್ನಡ](README.kn.md) · [فارسی](README.fa.md) · [Svenska](README.sv.md) · [Čeština](README.cs.md)
