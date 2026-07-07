**Languages**: [English](README.md) · [简体中文](README.zh-CN.md) · [Español](README.es.md) · [हिन्दी](README.hi.md) · [العربية](README.ar.md) · [বাংলা](README.bn.md) · [Português](README.pt.md) · [Русский](README.ru.md) · [日本語](README.ja.md) · [Deutsch](README.de.md) · [Français](README.fr.md) · [Bahasa Indonesia](README.id.md) · [اردو](README.ur.md) · [मराठी](README.mr.md) · [తెలుగు](README.te.md) · [Türkçe](README.tr.md) · [தமிழ்](README.ta.md) · [한국어](README.ko.md) · [Tiếng Việt](README.vi.md) · [Italiano](README.it.md) · [Polski](README.pl.md) · [Українська](README.uk.md) · [Nederlands](README.nl.md) · [ไทย](README.th.md) · [ગుજરાતી](README.gu.md) · [Bahasa Melayu](README.ms.md) · [ಕನ್ನಡ](README.kn.md) · [فارسی](README.fa.md) · [Svenska](README.sv.md) · [Čeština](README.cs.md)

<p align="center">
  <img src="web/public/icons/logo-1024.png" alt="DeepThink Logo" width="400" />
</p>

<h1 align="center">DeepThink</h1>

<p align="center">
  స్వీయ-హోస్టెడ్ బహు-వినియోగదారు స్థానిక AI Agent Loop Engineering వ్యవస్థ (డెస్క్‌టాప్ + బ్రౌజర్ + మొబైల్) / Powered By AI Genius Institute
</p>

<p align="center">
  <a href="LICENSE"><img src="https://img.shields.io/badge/License-MIT-teal.svg?style=for-the-badge" alt="License" /></a>
  <a href="https://nodejs.org"><img src="https://img.shields.io/badge/Node.js-%3E%3D20-339933?style=for-the-badge&logo=nodedotjs&logoColor=white" alt="Node.js" /></a>
  <img src="https://img.shields.io/badge/TypeScript-5.9-3178C6?style=for-the-badge&logo=typescript&logoColor=white" alt="TypeScript" />
  <a href="https://github.com/AIGeniusInstitute/deep-think/stargazers"><img src="https://img.shields.io/github/stars/AIGeniusInstitute/deep-think?style=for-the-badge&color=f5a623" alt="GitHub Stars" /></a>
</p>

---

## DeepThink అంటే ఏమిటి

DeepThink అనేది [Claude Agent SDK](https://github.com/anthropics/claude-code/tree/main/packages/claude-agent-sdk) పై నిర్మించిన స్వీయ-హోస్టెడ్ బహు-వినియోగదారు AI Agent వ్యవస్థ. ఇది మొత్తం Claude Code runtime ను Feishu, Telegram, QQ, DingTalk, WeChat మరియు వెబ్ ఇంటర్‌ఫేస్ నుండి చేరుకోగలిగే సేవగా కవర్ చేస్తుంది. ఫైల్ చదవడం/రాయడం, టెర్మినల్ నియంత్రణ, బ్రౌజర్ ఆటోమేషన్, బహు-రౌండ్ రీజనింగ్ మరియు MCP టూల్ ఎకోసిస్టమ్‌కు మద్దతు ఇస్తుంది.

డిజైన్ సూత్రం: **Agent యొక్క సామర్థ్యాలను తిరిగి-అమలు చేయవద్దు, బదులుగా Claude Code ను నేరుగా తిరిగి-ఉపయోగించు**. వెనుకవైపు మొత్తం Claude Code CLI runtime నడుస్తుంది, API wrapper లేదా ప్రాంప్ట్ చైన్ కాదు. Claude Code యొక్క అప్‌గ్రేడ్‌లు (కొత్త పరికరాలు, బలమైన రీజనింగ్, మరిన్ని MCP మద్దతు) అడాప్టర్ లేకుండా స్వయంచాలకంగా DeepThink కి ప్రతిబింబిస్తాయి.

### ముఖ్య లక్షణాలు

- **నేటివ్ Claude Code ఇంజిన్** — Claude Agent SDK ఆధారంగా, అంతర్గత runtime మొత్తం Claude Code CLI, అన్ని సామర్థ్యాలను వారసత్వంగా పొందుతుంది
- **బహు-వినియోగదారు వేర్పాటు** — వినియోగదారుకు workspace, వినియోగదారుకు IM ఛానెల్, RBAC అనుమతి వ్యవస్థ, ఆహ్వాన కోడ్ నమోదు, ఆడిట్ లాగ్
- **ఆరు-ఛానెల్ రూటింగ్** — Feishu WebSocket, Telegram Bot API, QQ Bot API v2, DingTalk Stream, WeChat iLink, వెబ్ ఇంటర్‌ఫేస్
- **బహు-ప్రొవైడర్ లోడ్ బ్యాలెన్సింగ్** — బహుళ Claude API ప్రొవైడర్‌లు, మూడు వ్యూహాలు (round-robin / weighted / failover) స్వయంచాలక ఆరోగ్య తనిఖీతో
- **బిల్లింగ్ మరియు వినియోగ గణాంకాలు** — పూర్తి బిల్లింగ్ (సబ్‌స్క్రిప్షన్, వాలెట్, రిడంప్షన్ కోడ్‌లు), నమూనా వారీ టోకెన్ ట్రాకింగ్ చార్ట్‌లతో
- **మొబైల్ PWA** — మొబైల్‌కు అనుకూలం, ఒక క్లిక్‌లో హోమ్ స్క్రీన్‌కు ఇన్‌స్టాలేషన్, iOS మరియు Android రెండింటికీ మద్దతు

## త్వరిత ప్రారంభం

### ముందస్తు అవసరాలు

**తప్పనిసరి**: [Node.js](https://nodejs.org) >= 20, [Docker](https://www.docker.com/) (కంటైనర్ మోడ్ కోసం; admin హోస్ట్ మోడ్ కోసం అవసరం లేదు), Claude API కీ (అధికారిక Anthropic లేదా సరిపోయే relay సేవ).

**ఐచ్ఛిక**: Feishu ఎంటర్‌ప్రైజ్ యాప్ ఆధారాలు, Telegram Bot Token, QQ Bot ఆధారాలు, DingTalk ఆధారాలు, WeChat iLink టోకెన్ — IM సమన్వయం అవసరమైనప్పుడు మాత్రమే.

> Claude Code CLI ను మాన్యువల్‌గా ఇన్‌స్టాల్ చేయవలసిన అవసరం లేదు — ప్రాజెక్ట్ యొక్క Claude Agent SDK డిపెండెన్సీ మొత్తం CLI runtime ను కలిగి ఉంటుంది, మొదటి `make start` వద్ద స్వయంచాలకంగా ఇన్‌స్టాల్ అవుతుంది.

### ఇన్‌స్టాలేషన్ మరియు ప్రారంభం

```bash
# 1. రిపోజిటరీ క్లోన్ చేయండి
git clone https://github.com/AIGeniusInstitute/deep-think.git
cd deepthink

# 2. ఒక కమాండ్‌తో ప్రారంభం (మొదటిసారి డిపెండెన్సీలు ఇన్‌స్టాల్ + కంపైల్)
make start
```

http://localhost:3000 తెరిచి సెటప్ విజార్డ్‌ను అనుసరించండి: admin సృష్టించండి (డిఫాల్ట్ ఖాతా లేదు), Claude API కాన్ఫిగర్ చేయండి, అవసరమైతే IM ఛానెళ్లను సెట్ చేయండి. ప్రతిదీ వెబ్ ఇంటర్‌ఫేస్ నుండి కాన్ఫిగర్ చేయబడుతుంది, కాన్ఫిగరేషన్ ఫైళ్లు అవసరం లేదు. API కీలు AES-256-GCM తో ఎన్‌క్రిప్ట్ చేయబడతాయి.

### కంటైనర్ మోడ్ యాక్టివేట్ చేయండి

admin వినియోగదారు డిఫాల్ట్‌గా హోస్ట్ మోడ్ (Docker లేకుండా) వాడుతారు. member వినియోగదారులకు కంటైనర్ మోడ్ నమోదు తర్వాత స్వయంచాలకంగా యాక్టివేట్ అవుతుంది:

```bash
./container/build.sh
```

కొత్త వినియోగదారు నమోదు తర్వాత, కంటైనర్ మోడ్ యొక్క ప్రధాన workspace (`home-{userId}`) స్వయంచాలకంగా సృష్టించబడుతుంది, అదనపు కాన్ఫిగరేషన్ లేకుండా.

## ఆర్కిటెక్చర్ అవలోకనం

DeepThink మూడు స్వతంత్ర Node.js ప్రాజెక్ట్‌లతో నిర్మించబడింది:

- **Backend** (Node.js 22 + TypeScript 5.9 + Hono): సందేశ రూటర్ (2s polling + నకిలీ తొలగింపు), ఏకకాల క్యూ (గరిష్టం 20 కంటైనర్‌లు + 5 హోస్ట్ ప్రాసెస్‌లు), టాస్క్ షెడ్యూలర్ (cron / interval / once), రియల్-టైమ్ స్ట్రీమింగ్ మరియు టెర్మినల్ కోసం WebSocket సర్వర్, bcrypt + HMAC Cookie ప్రామాణీకరణ, RBAC, AES-256-GCM ఎన్‌క్రిప్టెడ్ కాన్ఫిగరేషన్. డేటా SQLite (WAL మోడ్, schema v1→v33).
- **Frontend** (`web/`): React 19 SPA + Vite 6 + Zustand 5 + Tailwind CSS 4 + shadcn/ui, react-markdown, mermaid, recharts, xterm.js, మొబైల్ PWA.
- **Agent Runner** (`container/agent-runner/`): Docker కంటైనర్ లేదా హోస్ట్ ప్రాసెస్‌గా నడిచే ఎగ్జిక్యూషన్ ఇంజిన్. Claude Agent SDK యొక్క `query()` ను పిలుస్తుంది, 14 రకాల StreamEvent ను ఎమిట్ చేస్తుంది మరియు పరమాణు వ్రాత ఫైల్ IPC ద్వారా 12 MCP టూల్‌లను పేరెంట్ ప్రాసెస్‌కు అందిస్తుంది.

ఆరు IM ఛానెళ్లు రూటర్‌లోకి ప్రవేశిస్తాయి, నకిలీ తొలగించబడి క్యూలో ఉంచబడతాయి, ProviderPool ద్వారా API కీ ఎంచుకోబడి కంటైనర్ లేదా హోస్ట్ ప్రాసెస్ ప్రారంభించబడుతుంది. స్ట్రీమింగ్ ఈవెంట్‌లు WebSocket ద్వారా వెబ్ క్లయింట్‌లకు మరియు IM API ద్వారా ఛానెళ్లకు తిరిగి వెళ్తాయి.

## పూర్తి డాక్యుమెంటేషన్

పూర్తి గైడ్ ఇక్కడ అందుబాటులో ఉంది:

- [ఇంగ్లీష్ పూర్తి వెర్షన్](README.md)
- [简体中文 పూర్తి వెర్షన్](README.zh-CN.md)

---

**Languages**: [English](README.md) · [简体中文](README.zh-CN.md) · [Español](README.es.md) · [हिन्दी](README.hi.md) · [العربية](README.ar.md) · [বাংলা](README.bn.md) · [Português](README.pt.md) · [Русский](README.ru.md) · [日本語](README.ja.md) · [Deutsch](README.de.md) · [Français](README.fr.md) · [Bahasa Indonesia](README.id.md) · [اردو](README.ur.md) · [मराठी](README.mr.md) · [తెలుగు](README.te.md) · [Türkçe](README.tr.md) · [தமிழ்](README.ta.md) · [한국어](README.ko.md) · [Tiếng Việt](README.vi.md) · [Italiano](README.it.md) · [Polski](README.pl.md) · [Українська](README.uk.md) · [Nederlands](README.nl.md) · [ไทย](README.th.md) · [ગુજરાતી](README.gu.md) · [Bahasa Melayu](README.ms.md) · [ಕನ್ನಡ](README.kn.md) · [فارسی](README.fa.md) · [Svenska](README.sv.md) · [Čeština](README.cs.md)
