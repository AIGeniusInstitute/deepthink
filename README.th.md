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
  <a href="https://github.com/AIGeniusInstitute/deep-think/stargazers"><img src="https://img.shields.io/github/stars/AIGeniusInstitute/deep-think?style=for-the-badge&color=f5a623" alt="GitHub Stars" /></a>
</p>

---

## DeepThink คืออะไร

DeepThink คือระบบ AI Agent หลายผู้ใช้แบบ self-hosted ที่สร้างบน [Claude Agent SDK](https://github.com/anthropics/claude-agent-sdk-typescript) ห่อหุ้ม Claude Code runtime แบบเต็มเป็นบริการที่เข้าถึงได้จาก Feishu, Telegram, QQ, DingTalk, WeChat และอินเทอร์เฟซเว็บ รองรับการอ่าน/เขียนไฟล์, ควบคุมเทอร์มินัล, อัตโนมัติเบราว์เซอร์, การให้เหตุผลแบบหลายรอบ และระบบนิเวศเครื่องมือ MCP

หลักการออกแบบ: **อย่า re-implement ความสามารถของ Agent ใหม่ แต่ใช้ Claude Code โดยตรง**. เบื้องหลังรัน Claude Code CLI runtime แบบเต็ม ไม่ใช่ API wrapper หรือ prompt chain การอัปเกรดของ Claude Code (เครื่องมือใหม่, การให้เหตุผลที่แข็งแกร่งขึ้น, การสนับสนุน MCP ที่มากขึ้น) สะท้อนไปยัง DeepThink อัตโนมัติโดยไม่ต้องมี adapter

### คุณสมบัติเด่น

- **เอนจิน Claude Code แบบ native** — บน Claude Agent SDK, runtime ภายในคือ Claude Code CLI แบบเต็ม สืบทอดความสามารถทั้งหมด
- **การแยกผู้ใช้หลายคน** — workspace ต่อผู้ใช้, ช่อง IM ต่อผู้ใช้, ระบบสิทธิ์ RBAC, การลงทะเบียนด้วยรหัสเชิญ, audit log
- **routing หกช่อง** — Feishu WebSocket, Telegram Bot API, QQ Bot API v2, DingTalk Stream, WeChat iLink, อินเทอร์เฟซเว็บ
- **load balancing หลาย provider** — ผู้ให้บริการ Claude API หลายราย, สามกลยุทธ์ (round-robin / weighted / failover) พร้อม health check อัตโนมัติ
- **billing และสถิติการใช้งาน** — ระบบ billing ครบ (สมัครรับสมาชิก, กระเป๋าเงิน, รหัสแลกรางวัล), ติดตาม token ต่อโมเดลพร้อมกราฟ
- **PWA มือถือ** — ปรับให้เหมาะกับมือถือ, ติดตั้งหน้าจอหลักคลิกเดียว, รองรับทั้ง iOS และ Android

## เริ่มต้นอย่างรวดเร็ว

### ข้อกำหนดเบื้องต้น

**จำเป็น**: [Node.js](https://nodejs.org) >= 20, [Docker](https://www.docker.com/) (สำหรับโหมด container; ไม่จำเป็นสำหรับโหมด host ของ admin), คีย์ Claude API (Anthropic ทางการหรือบริการ relay ที่เข้ากันได้)

**ไม่บังคับ**: ข้อมูลประจำตัวแอป enterprise Feishu, Telegram Bot Token, ข้อมูลประจำตัว QQ Bot, ข้อมูลประจำตัว DingTalk, โทเค็น WeChat iLink — เฉพาะเมื่อต้องการเชื่อมต่อ IM

> ไม่ต้องติดตั้ง Claude Code CLI ด้วยตนเอง — การขึ้นต่อของโปรเจก Claude Agent SDK มี CLI runtime แบบเต็ม และติดตั้งอัตโนมัติที่ `make start` ครั้งแรก

### ติดตั้งและเริ่มต้น

```bash
# 1. clone repository
git clone https://github.com/AIGeniusInstitute/deep-think.git
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

DeepThink ประกอบด้วยสามโปรเจก Node.js อิสระ:

- **Backend** (Node.js 22 + TypeScript 5.9 + Hono): message router (polling 2s + ตัดซ้ำ), concurrent queue (สูงสุด 20 container + 5 โปรเซส host), task scheduler (cron / interval / once), เซิร์ฟเวอร์ WebSocket สำหรับ streaming เรียลไทม์และเทอร์มินัล, การยืนยันตัว bcrypt + HMAC Cookie, RBAC, config เข้ารหัส AES-256-GCM. ข้อมูลใน SQLite (โหมด WAL, schema v1→v33)
- **Frontend** (`web/`): React 19 SPA + Vite 6 + Zustand 5 + Tailwind CSS 4 + shadcn/ui, react-markdown, mermaid, recharts, xterm.js, PWA มือถือ
- **Agent Runner** (`container/agent-runner/`): engine ปฏิบัติการใน Docker container หรือเป็นโปรเซส host. เรียก `query()` ของ Claude Agent SDK, emit 14 ประเภท StreamEvent และมอบเครื่องมือ MCP 12 ตัวให้โปรเซสแม่ผ่าน file IPC แบบเขียน atomic

ช่อง IM หกช่องเข้าสู่ router, ถูกตัดซ้ำและจัดคิว, ProviderPool เลือกคีย์ API และเริ่ม container หรือโปรเซส host. สตรีมมิ่ง event ส่งไปยัง web clients ผ่าน WebSocket หรือกลับไปยังช่องผ่าน IM API

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
