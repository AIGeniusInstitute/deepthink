**Languages**: [English](README.md) · [简体中文](README.zh-CN.md) · [Español](README.es.md) · [हिन्दी](README.hi.md) · [العربية](README.ar.md) · [বাংলা](README.bn.md) · [Português](README.pt.md) · [Русский](README.ru.md) · [日本語](README.ja.md) · [Deutsch](README.de.md) · [Français](README.fr.md) · [Bahasa Indonesia](README.id.md) · [اردو](README.ur.md) · [मराठी](README.mr.md) · [తెలుగు](README.te.md) · [Türkçe](README.tr.md) · [தமிழ்](README.ta.md) · [한국어](README.ko.md) · [Tiếng Việt](README.vi.md) · [Italiano](README.it.md) · [Polski](README.pl.md) · [Українська](README.uk.md) · [Nederlands](README.nl.md) · [ไทย](README.th.md) · [ગુજરાતી](README.gu.md) · [Bahasa Melayu](README.ms.md) · [ಕನ್ನಡ](README.kn.md) · [فارسی](README.fa.md) · [Svenska](README.sv.md) · [Čeština](README.cs.md)

<p align="center">
  <img src="web/public/icons/logo-1024.png" alt="DeepThink Logo" width="400" />
</p>

<h1 align="center">DeepThink</h1>

<p align="center">
  ระบบ AI Agent Loop Engineering แบบโลคอลหลายผู้ใ้ใช้ที่โฮสต์เอง (เดสก์ท็อป + เบราว์เซอร์ + มือถือ) / ขับเคลื่อนโดย AI Genius Institute
</p>

<p align="center">
  <a href="LICENSE"><img src="https://img.shields.io/badge/License-MIT-teal.svg?style=for-the-badge" alt="License" /></a>
  <a href="https://nodejs.org"><img src="https://img.shields.io/badge/Node.js-%3E%3D20-339933?style=for-the-badge&logo=nodedotjs&logoColor=white" alt="Node.js" /></a>
  <img src="https://img.shields.io/badge/TypeScript-5.9-3178C6?style=for-the-badge&logo=typescript&logoColor=white" alt="TypeScript" />
  <a href="https://github.com/AIGeniusInstitute/deep-think/stargazers"><img src="https://img.shields.io/github/stars/AIGeniusInstitute/deep-think?style=for-the-badge&color=f5a623" alt="GitHub Stars" /></a>
</p>

---

## DeepThink คืออะไร?

DeepThink คือระบบ AI Agent ที่โฮสต์เองและรองรับหลายผู้ใช้ สร้างบน [Claude Agent SDK](https://github.com/anthropics/claude-code/tree/main/packages/claude-agent-sdk) มันห่อหุ้ม runtime ของ Claude Code ทั้งหมดไว้ในบริการที่เข้าถึงได้ผ่าน Feishu, Telegram, QQ, DingTalk, WeChat และอินเทอร์เฟซ Web พร้อมรองรับการอ่าน/เขียนไฟล์, การทำงานของเทอร์มินัล, การทำอัตโนมัติของเบราว์เซอร์, การให้เหตุผลแบบหลายรอบ และระบบนิเวศเครื่องมือ MCP

หลักการออกแบบหลัก: **อย่า reimplement ความสามารถของ Agent, ใช้ Claude Code ซ้ำโดยตรง**. สิ่งที่ถูกเรียกข้างใต้คือ runtime CLI ของ Claude Code แบบเต็ม ไม่ใช่ API wrapper หรือ prompt chain. การอัปเกรดทุกครั้งของ Claude Code — เครื่องมือใหม่, การให้เหตุผลที่แข็งแกร่งขึ้น, การสนับสนุน MCP มากขึ้น — มีประโยชน์ต่อ DeepThink อัตโนมัติโดยไม่ต้องปรับ

### คุณสมบัติเด่น

- **ขับเคลื่อนโดย Claude Code แบบเดิม** — สร้างบน Claude Agent SDK, runtime ด้านล่างคือ CLI ของ Claude Code แบบเต็ม, สืบทอดความสามารถทั้งหมด
- **การแยกผู้ใช้หลายคน** — Workspace ต่อผู้ใช้, ช่อง IM ต่อผู้ใช้, ระบบสิทธิ์ RBAC, การลงทะเบียนด้วยรหัสเชิญ, บันทึกการตรวจสอบ
- **การกำหนดเส้นทางรวม 6 ช่อง** — Feishu WebSocket, Telegram Bot API, QQ Bot API v2, DingTalk Stream, WeChat iLink, อินเทอร์เฟซ Web
- **การกระจายภาระหลายผู้ให้บริการ** — ผู้ให้บริการ Claude API หลายราย, สามกลยุทธ์ (round-robin / weighted / failover) พร้อมตรวจสอบสุขภาพอัตโนมัติ
- **การเรียกเก็บเงินและสถิติการใช้งาน** — ระบบเรียกเก็บเงินครบถ้วน (แผนสมัครสมาชิก, กระเป๋าเงิน, รหัสแลก), การติดตามโทเค็นต่อโมเดลพร้อมแผนภูมิ
- **PWA มือถือ** — ปรับให้เหมาะกับมือถืออย่างลึกซึ้ง, ติดตั้งคลิกเดียวบนเดสก์ท็อป, ปรับ iOS / Android แล้ว

## เริ่มต้นอย่างรวดเร็ว

### ข้อกำหนดเบื้องต้น

**บังคับ**: [Node.js](https://nodejs.org) >= 20, [Docker](https://www.docker.com/) (สำหรับโหมดคอนเทนเนอร์; admin ในโหมด host ไม่ต้องการ), และคีย์ Claude API (Anthropic ทางการหรือบริการ relay ที่เข้ากันได้).

**ทางเลือก**: ข้อมูลยืนยันตัวตนแอปองค์กร Feishu, Telegram Bot Token, ข้อมูลยืนยัน QQ Bot, ข้อมูลยืนยัน DingTalk, โทเค็น WeChat iLink — เฉพาะถ้าคุณต้องการการผสานรวม IM.

> ไม่ต้องติดตั้ง Claude Code CLI ด้วยตนเอง — การพึ่งพา Claude Agent SDK ของโปรเจกต์มี runtime CLI แบบเต็มอยู่แล้ว, ติดตั้งอัตโนมัติเมื่อรัน `make start` ครั้งแรก.

### ติดตั้งและเริ่มต้น

```bash
# 1. โคลนที่เก็บ
git clone https://github.com/AIGeniusInstitute/deep-think.git
cd deepthink

# 2. เริ่มด้วยคำสั่งเดียว (ติดตั้ง dependency และคอมไพล์ครั้งแรก)
make start
```

เยี่ยมชม http://localhost:3000 และปฏิบัติตามวิซาร์ดการตั้งค่า: สร้างผู้ดูแลระบบ (ไม่มีบัญชีเริ่มต้น), กำหนดค่า Claude API และทางเลือกกำหนดค่าช่อง IM. การกำหนดค่าทั้งหมดทำจากอินเทอร์เฟซ Web, โดยไม่มีไฟล์ config. คีย์ API ถูกเก็บไว้แบบเข้ารหัสด้วย AES-256-GCM.

### เปิดใช้งานโหมดคอนเทนเนอร์

ผู้ใช้ admin ใช้โหมด host เป็นค่าเริ่มต้น (ไม่ต้องการ Docker). หากคุณต้องการโหมดคอนเทนเนอร์ (ผู้ใช้ member ใช้อัตโนมัติหลังลงทะเบียน):

```bash
./container/build.sh
```

หลังลงทะเบียน ผู้ใช้ใหม่แต่ละคนได้ workspace หลักในโหมดคอนเทนเนอร์อัตโนมัติ (`home-{userId}`), โดยไม่ต้องกำหนดค่าเพิ่ม.

## ภาพรวมสถาปัตยกรรม

DeepThink ประกอบด้วยโปรเจกต์ Node.js อิสระสามตัว:

- **แบ็กเอนด์** (Node.js 22 + TypeScript 5.9 + Hono): บริการหลักพร้อมเราเตอร์ข้อความ (polling 2s + dedup), คิว concurrency (สูงสุด 20 คอนเทนเนอร์ + 5 โปรเซส host), ตัวกำหนดเวลางาน (cron / interval / once), เซิร์ฟเวอร์ WebSocket สำหรับ streaming แบบเรียลไทม์และเทอร์มินัล, การยืนยันตัวตน bcrypt + HMAC Cookie, RBAC และการจัดการ config ที่เข้ารหัสด้วย AES-256-GCM. ข้อมูลใน SQLite (โหมด WAL, schema v1→v33).
- **ฟรอนต์เอนด์** (`web/`): SPA React 19 + Vite 6 + Zustand 5 + Tailwind CSS 4 + shadcn/ui, กับ react-markdown, mermaid, recharts, xterm.js และ PWA มือถือ.
- **Agent Runner** (`container/agent-runner/`): เอนจินปฏิบัติการที่ทำงานในคอนเทนเนอร์ Docker หรือเป็นโปรเซส host; เรียก `query()` ของ Claude Agent SDK, ปล่อย 14 ประเภท StreamEvent และจัดหาเครื่องมือ MCP 12 ตัวให้โปรเซสหลักผ่านช่อง IPC ที่อิงจากไฟล์ด้วยการเขียนอะตอมมิก.

ช่อง IM หกตัว (Feishu, Telegram, QQ, DingTalk, WeChat, Web) เข้าสู่เราเตอร์, ถูก deduplicate และกำหนดเส้นทางไปยังคิว, ที่เลือกคีย์ API ผ่าน ProviderPool และเริ่มคอนเทนเนอร์หรือโปรเซส host. อีเวนต์ streaming ถูกส่งผ่าน WebSocket ไปยังไคลเอนต์ Web หรือตอบกลับผ่าน IM API ไปยังแต่ละช่อง.

## เอกสารฉบับเต็ม

สำหรับคู่มือฉบับเต็ม, ดู:

- [ฉบับเต็มภาษาอังกฤษ](README.md)
- [ฉบับเต็ม 简体中文](README.zh-CN.md)

---

**Languages**: [English](README.md) · [简体中文](README.zh-CN.md) · [Español](README.es.md) · [हिन्दी](README.hi.md) · [العربية](README.ar.md) · [বাংলা](README.bn.md) · [Português](README.pt.md) · [Русский](README.ru.md) · [日本語](README.ja.md) · [Deutsch](README.de.md) · [Français](README.fr.md) · [Bahasa Indonesia](README.id.md) · [اردو](README.ur.md) · [मराठी](README.mr.md) · [తెలుగు](README.te.md) · [Türkçe](README.tr.md) · [தமிழ்](README.ta.md) · [한국어](README.ko.md) · [Tiếng Việt](README.vi.md) · [Italiano](README.it.md) · [Polski](README.pl.md) · [Українська](README.uk.md) · [Nederlands](README.nl.md) · [ไทย](README.th.md) · [ગુજરાતી](README.gu.md) · [Bahasa Melayu](README.ms.md) · [ಕನ್ನಡ](README.kn.md) · [فارسی](README.fa.md) · [Svenska](README.sv.md) · [Čeština](README.cs.md)
