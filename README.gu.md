**Languages**: [English](README.md) · [简体中文](README.zh-CN.md) · [Español](README.es.md) · [हिन्दी](README.hi.md) · [العربية](README.ar.md) · [বাংলা](README.bn.md) · [Português](README.pt.md) · [Русский](README.ru.md) · [日本語](README.ja.md) · [Deutsch](README.de.md) · [Français](README.fr.md) · [Bahasa Indonesia](README.id.md) · [اردو](README.ur.md) · [मराठी](README.mr.md) · [తెలుగు](README.te.md) · [Türkçe](README.tr.md) · [தமிழ்](README.ta.md) · [한국어](README.ko.md) · [Tiếng Việt](README.vi.md) · [Italiano](README.it.md) · [Polski](README.pl.md) · [Українська](README.uk.md) · [Nederlands](README.nl.md) · [ไทย](README.th.md) · [ગુજરાતી](README.gu.md) · [Bahasa Melayu](README.ms.md) · [ಕನ್ನಡ](README.kn.md) · [فارسی](README.fa.md) · [Svenska](README.sv.md) · [Čeština](README.cs.md)

<p align="center">
  <img src="web/public/icons/logo-1024.png" alt="DeepThink Logo" width="400" />
</p>

<h1 align="center">DeepThink</h1>

<p align="center">
  સ્વ-હોસ્ટેડ મલ્ટિ-યુઝર સ્થાનિક AI Agent Loop Engineering સિસ્ટમ (ડેસ્કટોપ + બ્રાઉઝર + મોબાઇલ) / Powered By AI Genius Institute
</p>

<p align="center">
  <a href="LICENSE"><img src="https://img.shields.io/badge/License-MIT-teal.svg?style=for-the-badge" alt="License" /></a>
  <a href="https://nodejs.org"><img src="https://img.shields.io/badge/Node.js-%3E%3D20-339933?style=for-the-badge&logo=nodedotjs&logoColor=white" alt="Node.js" /></a>
  <img src="https://img.shields.io/badge/TypeScript-5.9-3178C6?style=for-the-badge&logo=typescript&logoColor=white" alt="TypeScript" />
  <a href="https://github.com/AIGeniusInstitute/deep-think/stargazers"><img src="https://img.shields.io/github/stars/AIGeniusInstitute/deep-think?style=for-the-badge&color=f5a623" alt="GitHub Stars" /></a>
</p>

---

## DeepThink એટલે શું

DeepThink એ [Claude Agent SDK](https://github.com/anthropics/claude-code/tree/main/packages/claude-agent-sdk) પર બનેલી સ્વ-હોસ્ટેડ મલ્ટિ-યુઝર AI Agent સિસ્ટમ છે. તે સંપૂર્ણ Claude Code runtime ને એક સેવા તરીકે લપેટે છે જે Feishu, Telegram, QQ, DingTalk, WeChat અને વેબ ઇન્ટરફેસ પરથી સુલભ છે. તે ફાઇલ વાંચવા/લખવા, ટર્મિનલ નિયંત્રણ, બ્રાઉઝર ઓટોમેશન, મલ્ટિ-રાઉન્ડ રિઝનિંગ અને MCP ટૂલ ઇકોસિસ્ટમને આધાર આપે છે.

ડિઝાઇન સિદ્ધાંત: **Agent ની ક્ષમતાઓને ફરીથી લાગુ ન કરવી, પરંતુ Claude Code નો સીધો ઉપયોગ કરવો**. પાછળની બાજુ પર સંપૂર્ણ Claude Code CLI runtime ચાલે છે, નહિ કે API wrapper અથવા પ્રોમ્પ્ટ ચેઇન. Claude Code ના અપગ્રેડ (નવા ટૂલ્સ, મજબૂત રિઝનિંગ, વધુ MCP આધાર) આપમેળે અને આડાકાર વિના DeepThink માં પ્રતિબિંબિત થાય છે.

### મુખ્ય લક્ષણો

- **મૂળભૂત Claude Code ઇજન** — Claude Agent SDK આધારિત, આંતરિક runtime સંપૂર્ણ Claude Code CLI છે, બધી ક્ષમતાઓ વારસામાં મળે છે
- **મલ્ટિ-યુઝર અલગતા** — દરેક યુઝરનું workspace, દરેક યુઝરનું IM ચેનલ, RBAC પરવાનગી સિસ્ટમ, આમંત્રણ કોડ રજિસ્ટ્રેશન, ઓડિટ લોગ
- **છ-ચેનલ રાઉટિંગ** — Feishu WebSocket, Telegram Bot API, QQ Bot API v2, DingTalk Stream, WeChat iLink, વેબ ઇન્ટરફેસ
- **મલ્ટિ-પ્રોવાઇડર લોડ બેલેન્સિંગ** — ઘણા Claude API પ્રોવાઇડર, ત્રણ વ્યૂહરચના (round-robin / weighted / failover) સ્વયંસંચાલિત હેલ્થ ચેક સાથે
- **બિલિંગ અને વપરાશ આંકડા** — સંપૂર્ણ બિલિંગ (સબ્સ્ક્રિપ્શન, વોલેટ, રિડેમ્પશન કોડ), મોડેલ મુજબ ટોકન ટ્રેકિંગ ચાર્ટ સાથે
- **મોબાઇલ PWA** — મોબાઇલ માટે અનુકૂળ, એક ક્લિકમાં હોમ સ્ક્રીન પર ઇન્સ્ટોલ, iOS અને Android બંને આધાર

## ઝડપથી શરૂ કરો

### પૂર્વ-શરતો

**ફરજિયાત**: [Node.js](https://nodejs.org) >= 20, [Docker](https://www.docker.com/) (container મોડ માટે; admin ના host મોડ માટે જરૂરી નથી), Claude API કી (અધિકૃત Anthropic અથવા સુસંગત રિલે સેવા).

**વૈકલ્પિક**: Feishu એન્ટરપ્રાઇઝ એપ ઓળખપત્રો, Telegram Bot Token, QQ Bot ઓળખપત્રો, DingTalk ઓળખપત્રો, WeChat iLink ટોકન — ફક્ત IM જોડાણ જોઈતું હોય ત્યારે.

> Claude Code CLI ને જાતે ઇન્સ્ટોલ કરવાની જરૂર નથી — પ્રોજેક્ટની Claude Agent SDK નિર્ભરતા સંપૂર્ણ CLI runtime સમાવે છે અને પ્રથમ `make start` પર આપમેળે ઇન્સ્ટોલ થાય છે.

### ઇન્સ્ટોલ અને શરૂ કરો

```bash
# 1. રિપોઝિટરી ક્લોન કરો
git clone https://github.com/AIGeniusInstitute/deep-think.git
cd deepthink

# 2. એક કમાન્ડથી શરૂ (પ્રથમ વખત નિર્ભરતા ઇન્સ્ટોલ + કમ્પાઇલ)
make start
```

http://localhost:9898 ખોલો અને સેટઅપ વિઝાર્ડ અનુસરો: admin બનાવો (કોઈ ડિફૉલ્ટ એકાઉન્ટ નહિ), Claude API ગોઠવો અને જરૂર પ્રમાણે IM ચેનલ. બધું જ વેબ ઇન્ટરફેસથી ગોઠવાય છે, કોઈ રૂપરેખા ફાઇલ નહિ. API કી AES-256-GCM થી એન્ક્રિપ્ટ થાય છે.

### container મોડ સક્રિય કરો

admin યુઝર મૂળભૂતપણે host મોડ (Docker વિના) વાપરે છે. member યુઝર માટે container મોડ નોંધણી પછી આપમેળે સક્રિય થાય છે:

```bash
./container/build.sh
```

નવા યુઝરની નોંધણી પછી, container મોડનું મુખ્ય workspace (`home-{userId}`) આપમેળે બને છે, વધારાના ગોઠવણ વિના.

## આર્કિટેક્ચર ઝાંખી

DeepThink ત્રણ સ્વતંત્ર Node.js પ્રોજેક્ટમાં ગઠિત છે:

- **Backend** (Node.js 22 + TypeScript 5.9 + Hono): સંદેશ રાઉટર (2s polling + નકલ દૂર), સાથ-સાથે ચાલતી કતાર (મહત્તમ 20 container + 5 host પ્રક્રિયા), કાર્ય સુપરતાકાર (cron / interval / once), real-time streaming અને ટર્મિનલ માટે WebSocket સર્વર, bcrypt + HMAC Cookie ઓળખાણ, RBAC, AES-256-GCM એન્ક્રિપ્ટેડ રૂપરેખા. માહિતી SQLite (WAL મોડ, schema v1→v33).
- **Frontend** (`web/`): React 19 SPA + Vite 6 + Zustand 5 + Tailwind CSS 4 + shadcn/ui, react-markdown, mermaid, recharts, xterm.js, મોબાઇલ PWA.
- **Agent Runner** (`container/agent-runner/`): Docker container અથવા host પ્રક્રિયા તરીકે ચાલતું એક્ઝિક્યુશન એન્જિન. Claude Agent SDK ની `query()` ને બોલાવે છે, 14 પ્રકારના StreamEvent મોકલે છે અને અણુ-લખાણવાળા ફાઇલ IPC મારફતે 12 MCP ટૂલ મૂળ પ્રક્રિયાને આપે છે.

છ IM ચેનલ રાઉટરમાં દાખલ થાય છે, નકલ-દૂરી પછી કતારમાં મૂકાય છે, ProviderPool મારફતે API કી પસંદ થાય છે અને container અથવા host પ્રક્રિયા શરૂ થાય છે. streaming ઘટનાઓ WebSocket થી વેબ ક્લાયન્ટને અને IM API થી ચેનલને પાછી જાય છે.

## સંપૂર્ણ દસ્તાવેજ

સંપૂર્ણ માર્ગદર્શિકા અહીં જુઓ:

- [અંગ્રેજી સંપૂર્ણ આવૃત્તિ](README.md)
- [简体中文 સંપૂર્ણ આવૃત્તિ](README.zh-CN.md)

---

**Languages**: [English](README.md) · [简体中文](README.zh-CN.md) · [Español](README.es.md) · [हिन्दी](README.hi.md) · [العربية](README.ar.md) · [বাংলা](README.bn.md) · [Português](README.pt.md) · [Русский](README.ru.md) · [日本語](README.ja.md) · [Deutsch](README.de.md) · [Français](README.fr.md) · [Bahasa Indonesia](README.id.md) · [اردو](README.ur.md) · [मराठी](README.mr.md) · [తెలుగు](README.te.md) · [Türkçe](README.tr.md) · [தமிழ்](README.ta.md) · [한국어](README.ko.md) · [Tiếng Việt](README.vi.md) · [Italiano](README.it.md) · [Polski](README.pl.md) · [Українська](README.uk.md) · [Nederlands](README.nl.md) · [ไทย](README.th.md) · [ગુજરાતી](README.gu.md) · [Bahasa Melayu](README.ms.md) · [ಕನ್ನಡ](README.kn.md) · [فارسی](README.fa.md) · [Svenska](README.sv.md) · [Čeština](README.cs.md)
