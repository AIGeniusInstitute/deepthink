**Languages**: [English](README.md) · [简体中文](README.zh-CN.md) · [Español](README.es.md) · [हिन्दी](README.hi.md) · [العربية](README.ar.md) · [বাংলা](README.bn.md) · [Português](README.pt.md) · [Русский](README.ru.md) · [日本語](README.ja.md) · [Deutsch](README.de.md) · [Français](README.fr.md) · [Bahasa Indonesia](README.id.md) · [اردو](README.ur.md) · [मराठी](README.mr.md) · [తెలుగు](README.te.md) · [Türkçe](README.tr.md) · [தமிழ்](README.ta.md) · [한국어](README.ko.md) · [Tiếng Việt](README.vi.md) · [Italiano](README.it.md) · [Polski](README.pl.md) · [Українська](README.uk.md) · [Nederlands](README.nl.md) · [ไทย](README.th.md) · [ગુજરાતી](README.gu.md) · [Bahasa Melayu](README.ms.md) · [ಕನ್ನಡ](README.kn.md) · [فارسی](README.fa.md) · [Svenska](README.sv.md) · [Čeština](README.cs.md)

<p align="center">
  <img src="web/public/icons/logo-1024.png" alt="DeepThink Logo" width="400" />
</p>

<h1 align="center">DeepThink</h1>

<p align="center">
  ระบบ self-hosted หลายผู้ใช้แบบ local AI Agent Loop Engineering (เดสก์ท็อป + เบราว์เซอร์ + มือถือ) / Powered By AI Genius Institute
</p>

<p align="center">
  <a href="LICENSE"><img src="https://img.shields.io/badge/License-MIT-teal.svg?style=for-the-badge" alt="License" /></a>
  <a href="https://nodejs.org"><img src="https://img.shields.io/badge/Node.js-%3E%3D20-339933?style=for-the-badge&logo=nodedotjs&logoColor=white" alt="Node.js" /></a>
  <img src="https://img.shields.io/badge/TypeScript-5.9-3178C6?style=for-the-badge&logo=typescript&logoColor=white" alt="TypeScript" />
  <a href="https://github.com/AIGeniusInstitute/deepthink/stargazers"><img src="https://img.shields.io/github/stars/AIGeniusInstitute/deep-think?style=for-the-badge&color=f5a623" alt="GitHub Stars" /></a>
</p>

---

<p align="center">
  <img src="static/deep-think-intro.gif" alt="DeepThink Intro" width="800" />
</p>


## DeepThink คืออะไร

DeepThink, แพลตฟอร์มสุดยอดปัญญาประดิษฐ์ Agent อิสระที่พัฒนาตนเองระดับองค์กร, ผู้บุกเบิกการเปลี่ยนผ่านจากพาราไดม์ Harness Engineering สู่ Loop Engineering, เป็นโครงสร้างพื้นฐาน AI (AI Infra) รุ่นใหม่สำหรับลูกค้าองค์กร แพลตฟอร์ม DeepThink ตั้งอยู่บนกรอบการทำงานร่วมกันแบบหลาย-Agent ผสานรวม AI Coding, Self-Evolving, Full-Stack Observability, Bug Auto-Fix Loop และ Human-Agent Symbiosis เพื่อสร้างระบบ AI ระดับองค์กรที่เรียนรู้อย่างต่อเนื่อง ปรับปรุงตนเอง และในที่สุดเติบโตเป็นสุดยอดปัญญาประดิษฐ์:

- **แพลตฟอร์ม R&D อิสระด้วย AI** — Agent ทำงานครบทั้งวงจรชีวิตการพัฒนาซอฟต์แวร์ได้อย่างอิสระ โดยไม่ต้องพึ่งพาวิศวกรมนุษย์ในงานเขียนโค้ดประจำ
- **เอนจิน Agent พัฒนาตนเอง** — Agent เรียนรู้จากข้อผิดพลาดอย่างต่อเนื่อง ดูดซับความรู้จากฐานโค้ด และวิวัฒน์การจากผลตอบรับของผู้ใช้
- **ศูนย์กลางการทำงานร่วมระหว่างโปรแกรมเมอร์และ Agent** — โปรแกรมเมอร์ทุกคนมี "โปรเจกต์การพัฒนา" ส่วนตัวที่มีหลายเซสชันคู่ขนาน ตัวกำหนดเวลากลางป้องกันความขัดแย้งแบบเกิดพร้อมกัน
- **แพลตฟอร์ม SaaS ระดับองค์กร** — การแยก multi-tenant, สิทธิ์แบบหลายระดับ, การเรียกเก็บเงินแบบยืดหยุ่น, และการเชื่อมต่อองค์กร (Feishu/DingTalk/WeCom/LDAP)
- **ตัวฟักไข่สุดยอดปัญญาประดิษฐ์** — ผ่านการวิวัฒน์การอย่างต่อเนื่อง Agent เดียวในที่สุดจะบรรลุความสามารถรอบด้านของทีมซอฟต์แวร์ที่สมบูรณ์

> "ขอให้ทุกองค์กรมีทีม R&D ซูเปอร์ AI ที่ไม่หยุดนิ่งและวิวัฒน์การอย่างต่อเนื่อง — จากผู้ใช้เครื่องมือ, สู่ผู้สร้างโค้ด, ในที่สุดเติบโตเป็นสุดยอดปัญญาประดิษฐ์ที่สร้างซ้ำตัวเองได้ ให้เราเดินไปด้วยกันบนเส้นทางสู่ AGI"

### คุณสมบัติเด่น

- **เอนจิน Claude Code แบบ native** — สร้างบน Claude Agent SDK, runtime ภายในคือ Claude Code CLI แบบเต็ม สืบทอดความสามารถทังหมด
- **Harness & Loop Engineering** — harness manifests แบบมีเวอร์ชัน (system prompt / subagents / tools / skills) พร้อม snapshot / diff / eval / promote / rollback และลูปงานอิสระระยะยาวที่มีการ review ต่อรอบและ re-inject ความล้มเหลว
- **Agent-as-a-Service (PaaS)** — สร้าง, กำหนดเวอร์ชัน, mount, แชร์ และติดตั้งนิยาม Agent ที่เก็บใน DB ข้าม tenant พร้อมโควตาต่อผู้ใช้, การตรวจสอบของ admin และตลาดแม่แบบที่เผยแพร่ได้
- **การแยกผู้ใช้หลายคน** — workspace ต่อผู้ใช้, ช่อง IM ต่อผู้ใช้, ระบบสิทธิ์ RBAC, การลงทะเบียนด้วยรหัสเชิญ และ audit log
- **routing แปดช่องแบบรวม** — Feishu, Telegram, QQ, DingTalk, WeChat, Discord, WhatsApp และอินเทอร์เฟซเว็บ — ทังหมด route แบบเหมือนกัน
- **หลายเอนจินและหลาย provider** — เอนจิน code-agent แบบปลั๊กอิน (Claude Code / AtomCode / Codex / OpenCode) และผู้ใหบริการ Claude API หลายรายพร้อมสามกลยุทธ์ load balancing (round-robin / weighted / failover) และ health check อัตโนมัติ
- **การรันโค้ดในแซนด์บอ็กซ์** — แซนด์บอ็กซ์ที่ hardening ด้วย Docker + seccomp + cgroups สำหรับรันโค้ด Python / Node / shell และอัตโนมัติเบราว์เซอร์ด้วย Chromium CDP
- **billing และสถิติการใช้งาน** — ระบบ billing ครบ (สมัครรับสมาชิก, กระเป๋าเงิน, รหัสแลกรางวัล), ติดตาม token ต่อโมเดลพร้อมกราฟ
- **PWA มือถือ** — ปรับให้เหมาะกับมือถืออย่างลึกซึ้ง, ติดตั้งหน้าจอหลักคลิกเดียว, รองรับ iOS / Android
- **หลายภาษา** — 29 ภาษาสำหรับ UI พร้อม endonym ดั้งเดิมและรองรับ RTL; Agent ตอบกลับในภาษาที่ผู้ใช้เลือก

## เริ่มต้นอย่างรวดเร็ว

### ข้อกำหนดเบื้องต้น

**จำเป็น**: [Node.js](https://nodejs.org) >= 20, [Docker](https://www.docker.com/) (สำหรับโหมด container; ไม่จำเป็นสำหรับโหมด host ของ admin), คีย์ Claude API (Anthropic ทางการหรือบริการ relay ที่เข้ากันได้)

**ไม่บังคับ**: ข้อมูลประจำตัวแอป enterprise Feishu, Telegram Bot Token, ข้อมูลประจำตัว QQ Bot, ข้อมูลประจำตัว DingTalk, โทเค็น WeChat iLink, Discord Bot Token, WhatsApp (สแกน QR ครั้งแรกที่เปิดใช้งาน) — เฉพาะเมื่อต้องการเชื่อมต่อ IM

> ไม่ต้องติดตั้ง Claude Code CLI ด้วยตนเอง — การขึ้นต่อของโปรเจก Claude Agent SDK มี CLI runtime แบบเต็ม และติดตั้งอัตโนมัติที่ `make start` ครั้งแรก

### ติดตั้งและเริ่มต้น

```bash
# 1. clone repository
git clone https://github.com/AIGeniusInstitute/deepthink.git
cd deepthink

# 2. เริ่มด้วยคำสั่งเดียว (ครั้งแรกติดตั้ง dependencies + compile)
make start
```

เปิด http://localhost:9898 และทำตามวิซาร์ดติดตั้ง: สร้าง admin (ไม่มีบัญชี default), ตั้งค่า Claude API และช่อง IM หากจำเป็น ทุกอย่างตั้งค่าจากอินเทอร์เฟซเว็บ ไม่ต้องมีไฟล์ config คีย์ API เข้ารหัสด้วย AES-256-GCM

### เปิดใช้งานโหมด container

ผู้ใช้ admin ใช้โหมด host (ไม่ต้องมี Docker) เป็น default โหมด container จำเป็นสำหรับผู้ใช้ member (เปิดใช้งานอัตโนมัติหลังลงทะเบียน):

```bash
./container/build.sh
```

หลังลงทะเบียนผู้ใช้ใหม่, workspace หลักของโหมด container (`home-{userId}`) จะถูกสร้างอัตโนมัติ โดยไม่ต้องตั้งค่าเพิ่ม

## ภาพรวมสถาปัตยกรรม


<p align="center">
  <img src="docs/architecture/deepthink-architecture.png" alt="DeepThink System Architecture" width="860" />
</p>


DeepThink ประกอบด้วยสี่โปรเจก Node.js อิสระ:

- **Backend** (Node.js 22 + TypeScript 5.9 + Hono): เซิร์ฟเวอร์หลักที่มี message router (polling 2s + ตัดซ้ำ), concurrent queue (สูงสุด 20 container + 5 โปรเซส host), task scheduler (cron / interval / once), เซิร์ฟเวอร์ WebSocket สำหรับ streaming เรียลไทม์และเทอร์มินัล, การยืนยันตัว bcrypt + HMAC Cookie, RBAC และการจัดการ config เข้ารหัส AES-256-GCM. ข้อมูลใน SQLite (โหมด WAL, schema v1→v51). ยังรวมชั้น Harness / Loop Engineering, Agent-as-a-Service (PaaS), Sandbox และ Claude Code Plugins
- **Frontend** (`web/`): React 19 + Vite 6 + Zustand 5 + Tailwind CSS 4 SPA พร้อม react-markdown, mermaid, recharts, xterm.js และ PWA มือถือ
- **Agent Runner** (`container/agent-runner/`): engine ปฏิบัติการที่รันใน Docker container หรือเป็นโปรเซส host; เรียก `query()` ของ Claude Agent SDK, emit กว่า 30 ประเภท StreamEvent ผ่าน stdout และมอบเครื่องมือ MCP 27 ตัวให้โปรเซสแม่ผ่าน file IPC แบบเขียน atomic
- **Desktop** (`desktop/`): Electron shell ที่บรรจุแอปแบบสแตนด์อะโลนสำหรับ macOS / Windows / Linux

ช่อง IM แปดช่อง (Feishu, Telegram, QQ, DingTalk, WeChat, Discord, WhatsApp, Web) เข้าสู่ router, ถูกตัดซ้ำและ route เข้าคิว ซึ่งเลือกคีย์ API / engine ผ่าน provider pool แล้วเริ่ม container, โปรเซส host หรือแซนด์บอ็กซ์. สตรีมมิ่ง event ส่งไปยัง web clients ผ่าน WebSocket หรือกลับไปยังแต่ละช่องผ่าน IM API

## เอกสารฉบับสมบูรณ์

คู่มือฉบับสมบูรณ์มีที่นี่:

- [ฉบับสมบูรณ์ภาษาอังกฤษ](README.md)
- [ฉบับสมบูรณ์ 简体中文](README.zh-CN.md)

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
