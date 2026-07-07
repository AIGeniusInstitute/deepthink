**Languages**: [English](README.md) · [简体中文](README.zh-CN.md) · [Español](README.es.md) · [हिन्दी](README.hi.md) · [العربية](README.ar.md) · [বাংলা](README.bn.md) · [Português](README.pt.md) · [Русский](README.ru.md) · [日本語](README.ja.md) · [Deutsch](README.de.md) · [Français](README.fr.md) · [Bahasa Indonesia](README.id.md) · [اردو](README.ur.md) · [मराठी](README.mr.md) · [తెలుగు](README.te.md) · [Türkçe](README.tr.md) · [தமிழ்](README.ta.md) · [한국어](README.ko.md) · [Tiếng Việt](README.vi.md) · [Italiano](README.it.md) · [Polski](README.pl.md) · [Українська](README.uk.md) · [Nederlands](README.nl.md) · [ไทย](README.th.md) · [ગુજરાતી](README.gu.md) · [Bahasa Melayu](README.ms.md) · [ಕನ್ನಡ](README.kn.md) · [فارسی](README.fa.md) · [Svenska](README.sv.md) · [Čeština](README.cs.md)

<p align="center">
  <img src="web/public/icons/logo-1024.png" alt="DeepThink Logo" width="400" />
</p>

<h1 align="center">DeepThink</h1>

<p align="center">
  Hệ thống AI Agent Loop Engineering cục bộ tự lưu trữ, đa người dùng (desktop + trình duyệt + mobile) / Được cung cấp bởi AI Genius Institute
</p>

<p align="center">
  <a href="LICENSE"><img src="https://img.shields.io/badge/License-MIT-teal.svg?style=for-the-badge" alt="License" /></a>
  <a href="https://nodejs.org"><img src="https://img.shields.io/badge/Node.js-%3E%3D20-339933?style=for-the-badge&logo=nodedotjs&logoColor=white" alt="Node.js" /></a>
  <img src="https://img.shields.io/badge/TypeScript-5.9-3178C6?style=for-the-badge&logo=typescript&logoColor=white" alt="TypeScript" />
  <a href="https://github.com/AIGeniusInstitute/deep-think/stargazers"><img src="https://img.shields.io/github/stars/AIGeniusInstitute/deep-think?style=for-the-badge&color=f5a623" alt="GitHub Stars" /></a>
</p>

---

## DeepThink là gì?

DeepThink là hệ thống AI Agent tự lưu trữ, đa người dùng được xây dựng trên [Claude Agent SDK](https://github.com/anthropics/claude-code/tree/main/packages/claude-agent-sdk). Nó bao bọc toàn bộ runtime của Claude Code thành một dịch vụ truy cập được qua Feishu, Telegram, QQ, DingTalk, WeChat và giao diện Web, hỗ trợ đọc/ghi file, thao tác terminal, tự động hóa trình duyệt, suy luận đa vòng và hệ sinh thái công cụ MCP.

Nguyên tắc thiết kế cốt lõi: **không tái triển khai năng lực Agent, tái sử dụng trực tiếp Claude Code**. Điều được gọi bên dưới là toàn bộ runtime CLI của Claude Code, không phải API wrapper hay chuỗi prompt. Mỗi lần nâng cấp Claude Code — công cụ mới, suy luận mạnh hơn, hỗ trợ MCP nhiều hơn — đều tự động mang lại lợi ích cho DeepThink mà không cần thích nghi.

### Tính năng chính

- **Khởi động bởi Claude Code gốc** — Dựa trên Claude Agent SDK, runtime bên dưới là toàn bộ CLI Claude Code, kế thừa mọi năng lực
- **Cô lập đa người dùng** — Workspace theo người dùng, kênh IM theo người dùng, hệ thống phân quyền RBAC, đăng ký bằng mã mời, nhật ký kiểm toán
- **Định tuyến thống nhất sáu kênh** — Feishu WebSocket, Telegram Bot API, QQ Bot API v2, DingTalk Stream, WeChat iLink, giao diện Web
- **Cân bằng tải đa nhà cung cấp** — nhiều nhà cung cấp Claude API, ba chiến lược (round-robin / weighted / failover) với kiểm tra sức khỏe tự động
- **Thanh toán và thống kê sử dụng** — hệ thống thanh toán đầy đủ (gói đăng ký, số dư ví, mã đổi), theo dõi token theo model với biểu đồ
- **PWA di động** — tối ưu sâu cho di động, cài đặt một chạm lên màn hình chính, iOS / Android đều tương thích

## Khởi động nhanh

### Yêu cầu trước

**Bắt buộc**: [Node.js](https://nodejs.org) >= 20, [Docker](https://www.docker.com/) (cho chế độ container; admin ở chế độ host không cần), và một khóa Claude API (Anthropic chính thức hoặc dịch vụ relay tương thích).

**Tùy chọn**: thông tin ứng dụng doanh nghiệp Feishu, Telegram Bot Token, thông tin QQ Bot, thông tin DingTalk, token WeChat iLink — chỉ khi bạn muốn tích hợp IM.

> Không cần cài Claude Code CLI thủ công — dependency Claude Agent SDK của dự án đã bao gồm toàn bộ runtime CLI, tự động cài khi chạy `make start` lần đầu.

### Cài đặt và bắt đầu

```bash
# 1. Clone repository
git clone https://github.com/AIGeniusInstitute/deep-think.git
cd deepthink

# 2. Khởi động một lệnh (lần đầu cài dependency + biên dịch)
make start
```

Truy cập http://localhost:3000 và làm theo hướng dẫn thiết lập: tạo administrator (không có tài khoản mặc định), cấu hình Claude API, và tùy chọn cấu hình các kênh IM. Mọi cấu hình thực hiện qua giao diện Web, không cần file cấu hình. Các khóa API được lưu mã hóa AES-256-GCM.

### Bật chế độ container

Người dùng admin mặc định dùng chế độ host (không cần Docker). Nếu cần chế độ container (người dùng member tự dùng sau khi đăng ký):

```bash
./container/build.sh
```

Sau khi đăng ký, mỗi người dùng mới tự động có workspace chính ở chế độ container (`home-{userId}`), không cần cấu hình thêm.

## Tổng quan kiến trúc

DeepThink gồm ba dự án Node.js độc lập:

- **Backend** (Node.js 22 + TypeScript 5.9 + Hono): dịch vụ chính với bộ định tuyến tin nhắn (polling 2s + khử trùng), hàng đợi đồng thời (tối đa 20 container + 5 quy trình host), bộ lập lịch tác vụ (cron / interval / once), máy chủ WebSocket cho streaming thời gian thực và terminal, xác thực bcrypt + HMAC Cookie, RBAC, và quản lý cấu hình mã hóa AES-256-GCM. Dữ liệu trong SQLite (chế độ WAL, schema v1→v33).
- **Frontend** (`web/`): SPA React 19 + Vite 6 + Zustand 5 + Tailwind CSS 4 + shadcn/ui, với react-markdown, mermaid, recharts, xterm.js và PWA di động.
- **Agent Runner** (`container/agent-runner/`): động cơ thực thi chạy trong Docker container hoặc như quy trình host; gọi `query()` của Claude Agent SDK, phát 14 loại StreamEvent, và cung cấp 12 công cụ MCP cho quy trình chính qua các kênh IPC dựa trên file với ghi nguyên tử.

Sáu kênh IM (Feishu, Telegram, QQ, DingTalk, WeChat, Web) đi vào router, khử trùng và định tuyến tới hàng đợi, chọn khóa API qua ProviderPool và khởi động container hoặc quy trình host. Các sự kiện streaming được phát qua WebSocket tới client Web hoặc trả lời qua các API IM về từng kênh.

## Tài liệu đầy đủ

Để có hướng dẫn đầy đủ, xem:

- [Phiên bản tiếng Anh đầy đủ](README.md)
- [Phiên bản 简体中文 đầy đủ](README.zh-CN.md)

---

**Languages**: [English](README.md) · [简体中文](README.zh-CN.md) · [Español](README.es.md) · [हिन्दी](README.hi.md) · [العربية](README.ar.md) · [বাংলা](README.bn.md) · [Português](README.pt.md) · [Русский](README.ru.md) · [日本語](README.ja.md) · [Deutsch](README.de.md) · [Français](README.fr.md) · [Bahasa Indonesia](README.id.md) · [اردو](README.ur.md) · [मराठी](README.mr.md) · [తెలుగు](README.te.md) · [Türkçe](README.tr.md) · [தமிழ்](README.ta.md) · [한국어](README.ko.md) · [Tiếng Việt](README.vi.md) · [Italiano](README.it.md) · [Polski](README.pl.md) · [Українська](README.uk.md) · [Nederlands](README.nl.md) · [ไทย](README.th.md) · [ગુજરાતી](README.gu.md) · [Bahasa Melayu](README.ms.md) · [ಕನ್ನಡ](README.kn.md) · [فارسی](README.fa.md) · [Svenska](README.sv.md) · [Čeština](README.cs.md)
