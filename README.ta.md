**Languages**: [English](README.md) · [简体中文](README.zh-CN.md) · [Español](README.es.md) · [हिन्दी](README.hi.md) · [العربية](README.ar.md) · [বাংলা](README.bn.md) · [Português](README.pt.md) · [Русский](README.ru.md) · [日本語](README.ja.md) · [Deutsch](README.de.md) · [Français](README.fr.md) · [Bahasa Indonesia](README.id.md) · [اردو](README.ur.md) · [मराठी](README.mr.md) · [తెలుగు](README.te.md) · [Türkçe](README.tr.md) · [தமிழ்](README.ta.md) · [한국어](README.ko.md) · [Tiếng Việt](README.vi.md) · [Italiano](README.it.md) · [Polski](README.pl.md) · [Українська](README.uk.md) · [Nederlands](README.nl.md) · [ไทย](README.th.md) · [ગુજરાતી](README.gu.md) · [Bahasa Melayu](README.ms.md) · [ಕನ್ನಡ](README.kn.md) · [فارسی](README.fa.md) · [Svenska](README.sv.md) · [Čeština](README.cs.md)

<p align="center">
  <img src="web/public/icons/logo-1024.png" alt="DeepThink Logo" width="400" />
</p>

<h1 align="center">DeepThink</h1>

<p align="center">
  சுய-ஹோஸ்ட் செய்யப்பட்ட பல-பயனர் உள்ளூர் AI Agent Loop Engineering சிஸ்டம் (டெஸ்க்டாப் + உலாவி + மொபைல்) / AI Genius Institute மூலம் இயக்கப்படுகிறது
</p>

<p align="center">
  <a href="LICENSE"><img src="https://img.shields.io/badge/License-MIT-teal.svg?style=for-the-badge" alt="License" /></a>
  <a href="https://nodejs.org"><img src="https://img.shields.io/badge/Node.js-%3E%3D20-339933?style=for-the-badge&logo=nodedotjs&logoColor=white" alt="Node.js" /></a>
  <img src="https://img.shields.io/badge/TypeScript-5.9-3178C6?style=for-the-badge&logo=typescript&logoColor=white" alt="TypeScript" />
  <a href="https://github.com/AIGeniusInstitute/deep-think/stargazers"><img src="https://img.shields.io/github/stars/AIGeniusInstitute/deep-think?style=for-the-badge&color=f5a623" alt="GitHub Stars" /></a>
</p>

---

## DeepThink என்றால் என்ன?

DeepThink என்பது [Claude Agent SDK](https://github.com/anthropics/claude-code/tree/main/packages/claude-agent-sdk) மீது கட்டப்பட்ட சுய-ஹோஸ்ட் செய்யப்பட்ட, பல-பயனர் AI Agent சிஸ்டம் ஆகும். இது முழு Claude Code இயக்க நேரத்தை Feishu, Telegram, QQ, DingTalk, WeChat மற்றும் Web இடைமுகத்திலிருந்து அணுகக்கூடிய சேவையாக மடக்குகிறது, கோப்பு படித்தல்/எழுதுதல், டெர்மினல் செயல்பாடுகள், உலாவி தானியக்கம், பல-சுற்று நியாயப்படுத்தல் மற்றும் MCP கருவி சூழலமைப்புக்கான ஆதரவுடன்.

முக்கிய வடிவமைப்புக் கொள்கை: **Agent திறன்களை மீண்டும் செயல்படுத்த வேண்டாம், Claude Code-ஐ நேரடியாக மீண்டும் பயன்படுத்தவும்**. கீழே அழைக்கப்படுவது முழு Claude Code CLI இயக்க நேரம், API ரேப்பர் அல்லது ப்ராம்ப்ட் செயின் அல்ல. Claude Code-ன் ஒவ்வொரு மேம்பாடும் — புதிய கருவிகள், வலுவான நியாயப்படுத்தல், அதிக MCP ஆதரவு — DeepThink-க்கு எந்த தழுவலும் இல்லாமல் தானாகவே பயனளிக்கிறது.

### முக்கிய அம்சங்கள்

- **நேடிவ் Claude Code இயக்கப்படுகிறது** — Claude Agent SDK அடிப்படையில், அடிப்படை இயக்க நேரம் முழு Claude Code CLI, அதன் அனைத்து திறன்களையும் மரபுரிமையாகப் பெறுகிறது
- **பல-பயனர் தனிமைப்படுத்தல்** — ஒரு பயனருக்கு ஒரு பணியிடம், ஒரு பயனருக்கு ஒரு IM சேனல்கள், RBAC அனுமதி அமைப்பு, அழைப்புக் குறியீடு பதிவு, தணிக்கை பதிவுகள்
- **ஆறு சேனல்களின் ஒருங்கிணைந்த ரூட்டிங்** — Feishu WebSocket, Telegram Bot API, QQ Bot API v2, DingTalk Stream, WeChat iLink, Web இடைமுகம்
- **பல-வழங்குநர் சுமை சமநிலை** — பல Claude API வழங்குநர்கள், மூன்று உத்திகள் (round-robin / weighted / failover) தானியங்கி சுகாதாரச் சோதனையுடன்
- **பில்லிங் மற்றும் பயன்பாட்டு புள்ளிவிவரங்கள்** — முழு பில்லிங் சிஸ்டம் (சந்தா திட்டங்கள், பணப்பை இருப்பு, மீட்டக் குறியீடுகள்), மாதிரி ஒன்றுக்கு டோக்கன் கண்காணிப்பு மற்றும் வரைபடக் காட்சிப்படுத்தல்
- **மொபைல் PWA** — மொபைலுக்காக ஆழமாக உகந்ததாக்கப்பட்டது, டெஸ்க்டாப்பில் ஒரு-கிளிக் நிறுவல், iOS / Android இரண்டும் மாற்றியமைக்கப்பட்டவை

## விரைவு தொடக்கம்

### முன்நிபந்தனைகள்

**கட்டாயம்**: [Node.js](https://nodejs.org) >= 20, [Docker](https://www.docker.com/) (கொள்கலன் பயன்முறைக்கு; admin ஹோஸ்ட் பயன்முறையில் தேவையில்லை), மற்றும் ஒரு Claude API விசை (அதிகாரப்பூர்வ Anthropic அல்லது இணக்கமான ரிலே சேவை).

**விருப்பத்தேர்வு**: Feishu நிறுவன செயலி சான்றுகள், Telegram Bot Token, QQ Bot சான்றுகள், DingTalk சான்றுகள், WeChat iLink டோக்கன் — நீங்கள் IM ஒருங்கிணைப்புகளை விரும்பினால் மட்டுமே.

> Claude Code CLI-ஐ கைமுறையாக நிறுவ தேவையில்லை — திட்டத்தின் Claude Agent SDK சார்புக்குறிப்பு ஏற்கனவே முழு CLI இயக்க நேரத்தை உள்ளடக்கியது, `make start` முதல் இயக்கத்தில் தானாகவே நிறுவப்படும்.

### நிறுவல் மற்றும் தொடக்கம்

```bash
# 1. களஞ்சியத்தை க்ளோன் செய்
git clone https://github.com/AIGeniusInstitute/deep-think.git
cd deepthink

# 2. ஒரே-கட்டளை தொடக்கம் (முதல் முறை சார்புகளை நிறுவி தொகுக்கும்)
make start
```

http://localhost:3000-ஐ பார்வையிடவும் மற்றும் அமைவு வழிகாட்டியைப் பின்பற்றவும்: நிர்வாகியை உருவாக்கவும் (இயல்புக் கணக்கு இல்லை), Claude API-ஐ உள்ளமைக்கவும், மற்றும் விருப்பமாக IM சேனல்களை உள்ளமைக்கவும். அனைத்து உள்ளமைவும் Web இடைமுகத்திலிருந்து செய்யப்படுகிறது, எந்த உள்ளமைவு கோப்புகளும் இல்லாமல். API விசைகள் AES-256-GCM உடன் மறையாக்கப்பட்டு சேமிக்கப்படுகின்றன.

### கொள்கலன் பயன்முறையை இயக்கு

admin பயனர் இயல்பாக ஹோஸ்ட் பயன்முறையைப் பயன்படுத்துகிறார் (Docker தேவையில்லை). உங்களுக்கு கொள்கலன் பயன்முறை தேவைப்பட்டால் (member பயனர்கள் பதிவுக்குப் பிறகு தானாகவே பயன்படுத்துகிறார்கள்):

```bash
./container/build.sh
```

பதிவுக்குப் பிறகு, ஒவ்வொரு புதிய பயனருக்கும் தானாகவே கொள்கலன் பயன்முறையில் முதன்மை பணியிடம் (`home-{userId}`) கிடைக்கிறது, கூடுதல் உள்ளமைவு இல்லாமல்.

## கட்டமைப்பு கண்ணோட்டம்

DeepThink மூன்று சுயாதீன Node.js திட்டங்களால் ஆனது:

- **பின்னணி** (Node.js 22 + TypeScript 5.9 + Hono): செய்தி ரூட்டர் (2s போலிங் + dedup), ஒருங்கிணைப்பு வரிசை (அதிகபட்சம் 20 கொள்கலன்கள் + 5 ஹோஸ்ட் செயல்முறைகள்), பணி திட்டமிடுபவர் (cron / interval / once), நிகழ்நேர ஸ்ட்ரீமிங் மற்றும் டெர்மினலுக்கான WebSocket சர்வர், bcrypt + HMAC Cookie அங்கீகாரம், RBAC, மற்றும் AES-256-GCM மறையாக்கப்பட்ட உள்ளமைவு மேலாண்மை கொண்ட முதன்மை சேவை. தரவு SQLite-இல் (WAL பயன்முறை, ஸ்கீமா v1→v33).
- **முன்னணி** (`web/`): React 19 SPA + Vite 6 + Zustand 5 + Tailwind CSS 4 + shadcn/ui, react-markdown, mermaid, recharts, xterm.js மற்றும் மொபைல் PWA உடன்.
- **Agent Runner** (`container/agent-runner/`): ஒரு Docker கொள்கலனுக்குள் அல்லது ஹோஸ்ட் செயல்முறையாக இயங்கும் செயலாக்க இயந்திரம்; Claude Agent SDK-இன் `query()`-ஐ அழைக்கிறது, 14 வகை StreamEvent-களை உமிழ்கிறது, மற்றும் அணு எழுத்துடன் கோப்பு அடிப்படையிலான IPC சேனல்கள் வழியாக 12 MCP கருவிகளை முதன்மை செயல்முறைக்கு வழங்குகிறது.

ஆறு IM சேனல்கள் (Feishu, Telegram, QQ, DingTalk, WeChat, Web) ரூட்டருக்குள் நுழைகின்றன, deduplicate செய்யப்பட்டு வரிசைக்கு ரூட் செய்யப்படுகின்றன, அது ProviderPool வழியாக API விசையைத் தேர்ந்தெடுத்து கொள்கலன் அல்லது ஹோஸ்ட் செயல்முறையைத் தொடங்குகிறது. ஸ்ட்ரீமிங் நிகழ்வுகள் WebSocket வழியாக Web கிளையனுக்கு அல்லது IM API-கள் வழியாக ஒவ்வொரு சேனலுக்கும் திருப்பி அனுப்பப்படுகின்றன.

## முழு ஆவணப்படுத்தல்

முழு வழிகாட்டிக்காக, காண்க:

- [ஆங்கில முழு பதிப்பு](README.md)
- [简体中文 முழு பதிப்பு](README.zh-CN.md)

---

**Languages**: [English](README.md) · [简体中文](README.zh-CN.md) · [Español](README.es.md) · [हिन्दी](README.hi.md) · [العربية](README.ar.md) · [বাংলা](README.bn.md) · [Português](README.pt.md) · [Русский](README.ru.md) · [日本語](README.ja.md) · [Deutsch](README.de.md) · [Français](README.fr.md) · [Bahasa Indonesia](README.id.md) · [اردو](README.ur.md) · [मराठी](README.mr.md) · [తెలుగు](README.te.md) · [Türkçe](README.tr.md) · [தமிழ்](README.ta.md) · [한국어](README.ko.md) · [Tiếng Việt](README.vi.md) · [Italiano](README.it.md) · [Polski](README.pl.md) · [Українська](README.uk.md) · [Nederlands](README.nl.md) · [ไทย](README.th.md) · [ગુજરાતી](README.gu.md) · [Bahasa Melayu](README.ms.md) · [ಕನ್ನಡ](README.kn.md) · [فارسی](README.fa.md) · [Svenska](README.sv.md) · [Čeština](README.cs.md)
