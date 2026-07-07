**Languages**: [English](README.md) · [简体中文](README.zh-CN.md) · [Español](README.es.md) · [हिन्दी](README.hi.md) · [العربية](README.ar.md) · [বাংলা](README.bn.md) · [Português](README.pt.md) · [Русский](README.ru.md) · [日本語](README.ja.md) · [Deutsch](README.de.md) · [Français](README.fr.md) · [Bahasa Indonesia](README.id.md) · [اردو](README.ur.md) · [मराठी](README.mr.md) · [తెలుగు](README.te.md) · [Türkçe](README.tr.md) · [தமிழ்](README.ta.md) · [한국어](README.ko.md) · [Tiếng Việt](README.vi.md) · [Italiano](README.it.md) · [Polski](README.pl.md) · [Українська](README.uk.md) · [Nederlands](README.nl.md) · [ไทย](README.th.md) · [ગુજરાતી](README.gu.md) · [Bahasa Melayu](README.ms.md) · [ಕನ್ನಡ](README.kn.md) · [فارسی](README.fa.md) · [Svenska](README.sv.md) · [Čeština](README.cs.md)

<p align="center">
  <img src="web/public/icons/logo-1024.png" alt="DeepThink Logo" width="400" />
</p>

<h1 align="center">DeepThink</h1>

<p align="center">
  స్వీయ-హోస్టెడ్ మల్టీ-యూజర్ లోకల్ AI Agent Loop Engineering సిస్టమ్ (డెస్క్‌టాప్ + బ్రౌజర్ + మొబైల్) / AI Genius Institute ద్వారా నడిపించబడుతుంది
</p>

<p align="center">
  <a href="LICENSE"><img src="https://img.shields.io/badge/License-MIT-teal.svg?style=for-the-badge" alt="License" /></a>
  <a href="https://nodejs.org"><img src="https://img.shields.io/badge/Node.js-%3E%3D20-339933?style=for-the-badge&logo=nodedotjs&logoColor=white" alt="Node.js" /></a>
  <img src="https://img.shields.io/badge/TypeScript-5.9-3178C6?style=for-the-badge&logo=typescript&logoColor=white" alt="TypeScript" />
  <a href="https://github.com/AIGeniusInstitute/deep-think/stargazers"><img src="https://img.shields.io/github/stars/AIGeniusInstitute/deep-think?style=for-the-badge&color=f5a623" alt="GitHub Stars" /></a>
</p>

---

## DeepThink అంటే ఏమిటి?

DeepThink అనేది [Claude Agent SDK](https://github.com/anthropics/claude-code/tree/main/packages/claude-agent-sdk)పై నిర్మించిన స్వీయ-హోస్టెడ్, మల్టీ-యూజర్ AI Agent సిస్టమ్. ఇది మొత్తం Claude Code రన్‌టైమ్‌ను Feishu, Telegram, QQ, DingTalk, WeChat మరియు Web ఇంటర్‌ఫేస్ ద్వారా యాక్సెస్ చేయగల సేవలో వస్త్రీకరిస్తుంది, ఫైల్ రీడింగ్/రైటింగ్, టెర్మినల్ ఆపరేషన్లు, బ్రౌజర్ ఆటోమేషన్, మల్టీ-రౌండ్ రీజనింగ్ మరియు MCP టూల్ ఎకోసిస్టమ్‌కు మద్దతుతో.

ప్రధాన డిజైన్ సూత్రం: **Agent సామర్థ్యాన్ని మళ్లీ అమలు చేయవద్దు, Claude Codeను నేరుగా మళ్లీ ఉపయోగించుకోండి**. లోపల ఇన్‌వోక్ అయ్యేది మొత్తం Claude Code CLI రన్‌టైమ్, API ర్యాపర్ లేదా ప్రాంప్ట్ చైన్ కాదు. Claude Code యొక్క ప్రతి అప్‌గ్రేడ్ — కొత్త టూల్స్, బలమైన రీజనింగ్, మరిన్ని MCP మద్దతు — DeepThinkకు ఎలాంటి అనుకూలత లేకుండా ఆటోమేటిక్‌గా లాభం చేకూరుస్తుంది.

### ముఖ్య లక్షణాలు

- **నేటివ్‌గా Claude Code డ్రైవన్** — Claude Agent SDKపై ఆధారపడి, అంతర్లీన రన్‌టైమ్ మొత్తం Claude Code CLI, దాని అన్ని సామర్థ్యాలను వారసత్వంగా పొందుతుంది
- **మల్టీ-యూజర్ ఐసోలేషన్** — ప్రతి-యూజర్ వర్క్‌స్పేస్, ప్రతి-యూజర్ IM ఛానెల్స్, RBAC అనుమతి వ్యవస్థ, ఆహ్వాన కోడ్ రిజిస్ట్రేషన్, ఆడిట్ లాగ్‌లు
- **ఆరు ఛానెల్స్ యొక్క ఏకీకృత రూటింగ్** — Feishu WebSocket, Telegram Bot API, QQ Bot API v2, DingTalk Stream, WeChat iLink, Web ఇంటర్‌ఫేస్
- **మల్టీ-ప్రొవైడర్ లోడ్ బ్యాలెన్సింగ్** — బహుళ Claude API ప్రొవైడర్‌లు, మూడు వ్యూహాలు (round-robin / weighted / failover) ఆటోమేటిక్ హెల్త్ చెక్‌తో
- **బిల్లింగ్ మరియు వినియోగ గణాంకాలు** — పూర్తి బిల్లింగ్ సిస్టమ్ (సబ్‌స్క్రిప్షన్ ప్లాన్‌లు, వాలెట్ బ్యాలెన్స్, రిడీమ్ కోడ్‌లు), ప్రతి-మోడల్ టోకెన్ ట్రాకింగ్ మరియు చార్ట్ విజువలైజేషన్
- **మొబైల్ PWA** — మొబైల్ కోసం లోతుగా ఆప్టిమైజ్ చేయబడింది, డెస్క్‌టాప్‌పై వన్-క్లిక్ ఇన్‌స్టాల్, iOS / Android రెండూ అనుకూలంగా

## శీఘ్ర ప్రారంభం

### ముందస్తు అవసరాలు

**తప్పనిసరి**: [Node.js](https://nodejs.org) >= 20, [Docker](https://www.docker.com/) (కంటైనర్ మోడ్ కోసం; admin హోస్ట్ మోడ్‌లో దీని అవసరం లేదు), మరియు Claude API కీ (అధికారిక Anthropic లేదా సరిపోలే రిలే సేవ).

**ఐచ్ఛిక**: Feishu ఎంటర్‌ప్రైజ్ యాప్ క్రెడెన్షియల్స్, Telegram Bot Token, QQ Bot క్రెడెన్షియల్స్, DingTalk క్రెడెన్షియల్స్, WeChat iLink టోకెన్ — మీకు IM ఇంటిగ్రేషన్లు కావాలనుకుంటే మాత్రమే.

> Claude Code CLIని మాన్యువల్‌గా ఇన్‌స్టాల్ చేయాల్సిన అవసరం లేదు — ప్రాజెక్ట్ యొక్క Claude Agent SDK డిపెండెన్సీ ఇప్పటికే మొత్తం CLI రన్‌టైమ్‌ను కలిగి ఉంది, `make start` మొదటిసారి రన్ చేసినప్పుడు ఆటోమేటిక్‌గా ఇన్‌స్టాల్ అవుతుంది.

### ఇన్‌స్టాల్ మరియు ప్రారంభం

```bash
# 1. రెపోజిటరీ క్లోన్ చేయండి
git clone https://github.com/AIGeniusInstitute/deep-think.git
cd deepthink

# 2. వన్-కమాండ్ స్టార్ట్ (మొదటిసారి డిపెండెన్సీలను ఇన్‌స్టాల్ + కంపైల్ చేస్తుంది)
make start
```

http://localhost:3000 సందర్శించండి మరియు సెటప్ విజార్డ్‌ను అనుసరించండి: adminను సృష్టించండి (డిఫాల్ట్ ఖాతా లేదు), Claude API కాన్ఫిగర్ చేయండి మరియు ఐచ్ఛికంగా IM ఛానెల్స్ కాన్ఫిగర్ చేయండి. అన్ని కాన్ఫిగరేషన్‌లు Web ఇంటర్‌ఫేస్ నుండి జరుగుతాయి, కాన్ఫిగ్ ఫైళ్లు లేకుండా. API కీలు AES-256-GCMతో ఎన్‌క్రిప్ట్ చేయబడి నిల్వ చేయబడతాయి.

### కంటైనర్ మోడ్ ఎనేబుల్ చేయండి

admin యూజర్ డిఫాల్ట్‌గా హోస్ట్ మోడ్‌ను ఉపయోగిస్తారు (Docker అవసరం లేదు). మీకు కంటైనర్ మోడ్ కావాలంటే (member యూజర్లు రిజిస్ట్రేషన్ తర్వాత ఆటోమేటిక్‌గా ఉపయోగిస్తారు):

```bash
./container/build.sh
```

రిజిస్ట్రేషన్ తర్వాత, ప్రతి కొత్త యూజర్‌కు ఆటోమేటిక్‌గా కంటైనర్ మోడ్‌లో ప్రధాన వర్క్‌స్పేస్ (`home-{userId}`) లభిస్తుంది, అదనపు కాన్ఫిగరేషన్ లేకుండా.

## ఆర్కిటెక్చర్ ఓవర్‌వ్యూ

DeepThink మూడు స్వతంత్ర Node.js ప్రాజెక్ట్‌లతో కూడి ఉంది:

- **బ్యాకెండ్** (Node.js 22 + TypeScript 5.9 + Hono): మెసేజ్ రూటర్ (2s పోలింగ్ + డిడ్యుప్), కాన్కరెన్సీ క్యూ (గరిష్టంగా 20 కంటైనర్లు + 5 హోస్ట్ ప్రాసెస్‌లు), టాస్క్ షెడ్యూలర్ (cron / interval / once), రియల్-టైమ్ స్ట్రీమింగ్ మరియు టెర్మినల్ కోసం WebSocket సర్వర్, bcrypt + HMAC Cookie ప్రామాణీకరణ, RBAC, మరియు AES-256-GCM ఎన్‌క్రిప్టెడ్ కాన్ఫిగ్ మేనేజ్‌మెంట్‌తో కూడిన ప్రధాన సేవ. డేటా SQLiteలో (WAL మోడ్, స్కీమా v1→v33).
- **ఫ్రంటెండ్** (`web/`): React 19 SPA + Vite 6 + Zustand 5 + Tailwind CSS 4 + shadcn/ui, react-markdown, mermaid, recharts, xterm.js మరియు మొబైల్ PWAతో.
- **Agent Runner** (`container/agent-runner/`): Docker కంటైనర్ లోపల లేదా హోస్ట్ ప్రాసెస్‌గా నడిచే ఎగ్జిక్యూషన్ ఇంజిన్; Claude Agent SDK యొక్క `query()`ను ఇన్‌వోక్ చేస్తుంది, 14 రకాల StreamEventలను ఎమిట్ చేస్తుంది, మరియు అటామిక్ రైటింగ్‌తో ఫైల్-ఆధారిత IPC ఛానెల్స్ ద్వారా 12 MCP టూల్స్‌ను ప్రధాన ప్రాసెస్‌కు అందిస్తుంది.

ఆరు IM ఛానెల్స్ (Feishu, Telegram, QQ, DingTalk, WeChat, Web) రూటర్‌లోకి ప్రవేశిస్తాయి, డిడ్యుప్లికేట్ చేయబడి క్యూకు రూట్ చేయబడతాయి, అది ProviderPool ద్వారా API కీని ఎంచుకుని కంటైనర్ లేదా హోస్ట్ ప్రాసెస్‌ను ప్రారంభిస్తుంది. స్ట్రీమింగ్ ఈవెంట్‌లు WebSocket ద్వారా Web క్లయింట్‌కు లేదా IM API ద్వారా ప్రతి ఛానెల్‌కు తిరిగి పంపబడతాయి.

## పూర్తి డాక్యుమెంటేషన్

పూర్తి గైడ్ కోసం, చూడండి:

- [ఇంగ్లీష్ పూర్తి వెర్షన్](README.md)
- [简体中文 పూర్తి వెర్షన్](README.zh-CN.md)

---

**Languages**: [English](README.md) · [简体中文](README.zh-CN.md) · [Español](README.es.md) · [हिन्दी](README.hi.md) · [العربية](README.ar.md) · [বাংলা](README.bn.md) · [Português](README.pt.md) · [Русский](README.ru.md) · [日本語](README.ja.md) · [Deutsch](README.de.md) · [Français](README.fr.md) · [Bahasa Indonesia](README.id.md) · [اردو](README.ur.md) · [मराठी](README.mr.md) · [తెలుగు](README.te.md) · [Türkçe](README.tr.md) · [தமிழ்](README.ta.md) · [한국어](README.ko.md) · [Tiếng Việt](README.vi.md) · [Italiano](README.it.md) · [Polski](README.pl.md) · [Українська](README.uk.md) · [Nederlands](README.nl.md) · [ไทย](README.th.md) · [ગુજરાતી](README.gu.md) · [Bahasa Melayu](README.ms.md) · [ಕನ್ನಡ](README.kn.md) · [فارسی](README.fa.md) · [Svenska](README.sv.md) · [Čeština](README.cs.md)
