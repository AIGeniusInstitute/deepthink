**Languages**: [English](README.md) · [简体中文](README.zh-CN.md) · [Español](README.es.md) · [हिन्दी](README.hi.md) · [العربية](README.ar.md) · [বাংলা](README.bn.md) · [Português](README.pt.md) · [Русский](README.ru.md) · [日本語](README.ja.md) · [Deutsch](README.de.md) · [Français](README.fr.md) · [Bahasa Indonesia](README.id.md) · [اردو](README.ur.md) · [मराठी](README.mr.md) · [తెలుగు](README.te.md) · [Türkçe](README.tr.md) · [தமிழ்](README.ta.md) · [한국어](README.ko.md) · [Tiếng Việt](README.vi.md) · [Italiano](README.it.md) · [Polski](README.pl.md) · [Українська](README.uk.md) · [Nederlands](README.nl.md) · [ไทย](README.th.md) · [ગુજરાતી](README.gu.md) · [Bahasa Melayu](README.ms.md) · [ಕನ್ನಡ](README.kn.md) · [فارسی](README.fa.md) · [Svenska](README.sv.md) · [Čeština](README.cs.md)

<p align="center">
  <img src="web/public/icons/logo-1024.png" alt="DeepThink Logo" width="400" />
</p>

<h1 align="center">DeepThink</h1>

<p align="center">
  स्व-होस्ट किया गया मल्टी-यूज़र स्थानीय AI Agent Loop Engineering सिस्टम (डेस्कटॉप + ब्राउज़र + मोबाइल) / AI Genius Institute द्वारा संचालित
</p>

<p align="center">
  <a href="LICENSE"><img src="https://img.shields.io/badge/License-MIT-teal.svg?style=for-the-badge" alt="License" /></a>
  <a href="https://nodejs.org"><img src="https://img.shields.io/badge/Node.js-%3E%3D20-339933?style=for-the-badge&logo=nodedotjs&logoColor=white" alt="Node.js" /></a>
  <img src="https://img.shields.io/badge/TypeScript-5.9-3178C6?style=for-the-badge&logo=typescript&logoColor=white" alt="TypeScript" />
  <a href="https://github.com/AIGeniusInstitute/deep-think/stargazers"><img src="https://img.shields.io/github/stars/AIGeniusInstitute/deep-think?style=for-the-badge&color=f5a623" alt="GitHub Stars" /></a>
</p>

---

## DeepThink क्या है?

DeepThink एक स्व-होस्टेड, मल्टी-यूज़र AI Agent सिस्टम है जो [Claude Agent SDK](https://github.com/anthropics/claude-code/tree/main/packages/claude-agent-sdk) पर निर्मित है। यह पूरे Claude Code रनटाइम को Feishu, Telegram, QQ, DingTalk, WeChat और Web इंटरफ़ेस से सुलभ सेवा में लपेटता है, फ़ाइल पढ़ने/लिखने, टर्मिनल ऑपरेशन, ब्राउज़र ऑटोमेशन, मल्टी-राउंड रीज़निंग और MCP टूल इकोसिस्टम का समर्थन करता है।

मुख्य डिज़ाइन सिद्धांत: **Agent क्षमता को फिर से लागू न करें, Claude Code को सीधे पुनः उपयोग करें**। नीचे जो इनवोक होता है वह पूर्ण Claude Code CLI रनटाइम है, न कि API रैपर या प्रॉम्प्ट चेन। Claude Code का प्रत्येक अपग्रेड — नए टूल, मजबूत रीज़निंग, अधिक MCP समर्थन — DeepThink को बिना किसी अनुकूलन के स्वतः लाभान्वित करता है।

### प्रमुख विशेषताएँ

- **नेटिव Claude Code संचालित** — Claude Agent SDK पर आधारित, अंतर्निहित रनटाइम पूर्ण Claude Code CLI है, सभी क्षमताओं का विरासत में पाता है
- **मल्टी-यूज़र आइसोलेशन** — प्रति-यूज़र वर्कस्पेस, प्रति-यूज़र IM चैनल, RBAC अनुमति प्रणाली, आमंत्रण कोड पंजीकरण, ऑडिट लॉग
- **छह चैनलों का एकीकृत रूटिंग** — Feishu WebSocket लंबी कनेक्शन, Telegram Bot API, QQ Bot API v2, DingTalk Stream प्रोटोकॉल, WeChat iLink Bot API, Web इंटरफ़ेस
- **मल्टी-प्रोवाइडर लोड बैलेंसिंग** — कई Claude API प्रोवाइडर, तीन रणनीतियाँ (round-robin / weighted / failover), स्वचालित हेल्थ चेक और रिकवरी
- **बिलिंग और उपयोग आँकड़े** — पूर्ण बिलिंग सिस्टम (सब्सक्रिप्शन योजना, वॉलेट बैलेंस, रिडीम कोड), प्रति-मॉडल टोकन उपयोग ट्रैकिंग और चार्ट विज़ुअलाइज़ेशन
- **मोबाइल PWA** — मोबाइल के लिए गहराई से अनुकूलित, डेस्कटॉप पर एक-क्लिक इंस्टॉल, iOS / Android दोनों अनुकूलित

## त्वरित शुरुआत

### पूर्वापेक्षाएँ

**अनिवार्य**: [Node.js](https://nodejs.org) >= 20, [Docker](https://www.docker.com/) (कंटेनर मोड के लिए; admin केवल होस्ट मोड में इसकी आवश्यकता नहीं), और Claude API कुंजी (Anthropic आधिकारिक या संगत रिले सेवा)।

**वैकल्पिक**: Feishu एंटरप्राइज़ ऐप क्रेडेंशियल, Telegram Bot Token, QQ Bot क्रेडेंशियल, DingTalk Bot क्रेडेंशियल, WeChat iLink Bot Token — केवल यदि आप IM एकीकरण चाहते हैं।

> Claude Code CLI को मैन्युअल रूप से इंस्टॉल करने की आवश्यकता नहीं है — प्रोजेक्ट की Claude Agent SDK निर्भरता में पूर्ण CLI रनटाइम पहले से शामिल है, `make start` पहली बार चलाने पर स्वचालित रूप से इंस्टॉल हो जाता है।

### इंस्टॉल और प्रारंभ

```bash
# 1. रिपॉजिटरी क्लोन करें
git clone https://github.com/AIGeniusInstitute/deep-think.git
cd deepthink

# 2. एक-कमांड शुरुआत (पहली बार निर्भरता इंस्टॉल + संकलन)
make start
```

http://localhost:9898 पर जाएँ और सेटअप विज़ार्ड का पालन करें: व्यवस्थापक बनाएँ (कोई डिफ़ॉल्ट खाता नहीं), Claude API कॉन्फ़िगर करें, और वैकल्पिक रूप से IM चैनल कॉन्फ़िगर करें। सभी कॉन्फ़िगरेशन Web इंटरफ़ेस से किया जाता है, बिना किसी कॉन्फ़िग फ़ाइल के। API कुंजी AES-256-GCM के साथ एन्क्रिप्टेड रूप से संग्रहीत होती है।

### कंटेनर मोड सक्षम करें

admin यूज़र डिफ़ॉल्ट रूप से होस्ट मोड का उपयोग करता है (Docker की आवश्यकता नहीं)। यदि आपको कंटेनर मोड चाहिए (member यूज़र पंजीकरण के बाद स्वचालित रूप से उपयोग करते हैं):

```bash
./container/build.sh
```

नया यूज़र पंजीकरण के बाद स्वचालित रूप से कंटेनर मोड का मुख्य वर्कस्पेस (`home-{userId}`) बनता है, बिना अतिरिक्त कॉन्फ़िगरेशन के।

## आर्किटेक्चर अवलोकन

DeepThink तीन स्वतंत्र Node.js प्रोजेक्ट्स से बना है:

- **बैकएंड** (Node.js 22 + TypeScript 5.9 + Hono): मुख्य सेवा जिसमें मैसेज राउटर (2s पोलिंग + डिडुपे), कॉन्करेंसी क्यू (अधिकतम 20 कंटेनर + 5 होस्ट प्रक्रियाएँ), टास्क शेड्यूलर (cron / interval / once), रियल-टाइम स्ट्रीमिंग और टर्मिनल के लिए WebSocket सर्वर, bcrypt + HMAC Cookie प्रमाणीकरण, RBAC, और AES-256-GCM एन्क्रिप्टेड कॉन्फ़िग प्रबंधन शामिल हैं। SQLite (WAL मोड, स्कीमा v1→v33) में डेटा रहता है।
- **फ्रंटएंड** (`web/`): React 19 SPA + Vite 6 + Zustand 5 + Tailwind CSS 4 + shadcn/ui, react-markdown, mermaid, recharts, xterm.js और मोबाइल PWA के साथ।
- **Agent Runner** (`container/agent-runner/`): निष्पादन इंजन जो Docker कंटेनर या होस्ट प्रक्रिया के रूप में चलता है; Claude Agent SDK के `query()` को इनवोक करता है, 14 प्रकार के StreamEvent उत्सर्जित करता है, और परमाणु लेखन वाले फ़ाइल-आधारित IPC चैनलों के माध्यम से 12 MCP टूल्स प्रदान करता है।

छह IM चैनल (Feishu, Telegram, QQ, DingTalk, WeChat, Web) राउटर में प्रवेश करते हैं, डिडुप्लिकेट और रूट होते हैं क्यू में, जो ProviderPool के माध्यम से API कुंजी चुनती है और कंटेनर या होस्ट प्रक्रिया शुरू करती है। स्ट्रीमिंग इवेंट्स WebSocket द्वारा Web क्लाइंट को या IM API के माध्यम से प्रत्येक चैनल पर वापस भेजे जाते हैं।

## पूर्ण दस्तावेज़ीकरण

पूर्ण मार्गदर्शिका के लिए, देखें:

- [अंग्रेज़ी पूर्ण संस्करण](README.md)
- [简体中文 पूर्ण संस्करण](README.zh-CN.md)

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
