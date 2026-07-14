**Languages**: [English](README.md) · [简体中文](README.zh-CN.md) · [Español](README.es.md) · [हिन्दी](README.hi.md) · [العربية](README.ar.md) · [বাংলা](README.bn.md) · [Português](README.pt.md) · [Русский](README.ru.md) · [日本語](README.ja.md) · [Deutsch](README.de.md) · [Français](README.fr.md) · [Bahasa Indonesia](README.id.md) · [اردو](README.ur.md) · [मराठी](README.mr.md) · [తెలుగు](README.te.md) · [Türkçe](README.tr.md) · [தமிழ்](README.ta.md) · [한국어](README.ko.md) · [Tiếng Việt](README.vi.md) · [Italiano](README.it.md) · [Polski](README.pl.md) · [Українська](README.uk.md) · [Nederlands](README.nl.md) · [ไทย](README.th.md) · [ગુજરાતી](README.gu.md) · [Bahasa Melayu](README.ms.md) · [ಕನ್ನಡ](README.kn.md) · [فارسی](README.fa.md) · [Svenska](README.sv.md) · [Čeština](README.cs.md)

<p align="center">
  <img src="web/public/icons/logo-1024.png" alt="DeepThink Logo" width="400" />
</p>

<h1 align="center">DeepThink</h1>

<p align="center">
  Hệ thống self-hosted đa người dùng AI Agent Loop Engineering nội bộ (desktop + trình duyệt + di động) / Powered By AI Genius Institute
</p>

<p align="center">
  <a href="LICENSE"><img src="https://img.shields.io/badge/License-MIT-teal.svg?style=for-the-badge" alt="License" /></a>
  <a href="https://nodejs.org"><img src="https://img.shields.io/badge/Node.js-%3E%3D20-339933?style=for-the-badge&logo=nodedotjs&logoColor=white" alt="Node.js" /></a>
  <img src="https://img.shields.io/badge/TypeScript-5.9-3178C6?style=for-the-badge&logo=typescript&logoColor=white" alt="TypeScript" />
  <a href="https://github.com/AIGeniusInstitute/deep-think/stargazers"><img src="https://img.shields.io/github/stars/AIGeniusInstitute/deep-think?style=for-the-badge&color=f5a623" alt="GitHub Stars" /></a>
</p>

---

<p align="center">
  <video src="static/deep-think-intro.mp4" 
    poster="static/deep-think-start-logo.png" controls width="800"></video>
</p>


## DeepThink là gì

DeepThink, nền tảng siêu trí tuệ tự tiến hóa Agent tự chủ cấp doanh nghiệp, nhà tiên phong trong chuyển dịch từ mô hình Harness Engineering sang Loop Engineering, là thế hệ mới của Hạ tầng AI (AI Infra) dành cho khách hàng doanh nghiệp. Nền tảng DeepThink lấy khung cộng tác đa-Agent làm trung tâm, kết hợp AI Coding, Self-Evolving, Full-Stack Observability, Bug Auto-Fix Loop và Human-Agent Symbiosis để xây dựng một hệ thống AI cấp doanh nghiệp liên tục học hỏi, tự cải thiện và cuối cùng phát triển thành siêu trí tuệ:

- **Nền tảng R&D tự chủ bằng AI** — Agent độc lập hoàn thành toàn bộ vòng đời phát triển phần mềm, không cần kỹ sư con người trong các tác vụ mã hóa thường lệ
- **Động cơ Agent tự tiến hóa** — Agent liên tục học từ lỗi, hấp thụ tri thức từ cơ sở mã, và tiến hóa từ phản hồi người dùng
- **Trung tâm cộng tác Lập trình viên-Agent** — Mỗi lập trình viên sở hữu một "Dự án Phát triển" cá nhân chứa nhiều phiên song song, bộ lập lịch trung tâm ngăn xung đột đồng thời
- **Nền tảng SaaS doanh nghiệp** — Cô lập multi-tenant, quyền hạn theo tầng, thanh toán linh hoạt, tích hợp doanh nghiệp (Feishu/DingTalk/WeCom/LDAP)
- **Ấp ủ siêu trí tuệ** — Thông qua tiến hóa liên tục, một Agent duy nhất cuối cùng đạt được năng lực toàn diện của một đội phần mềm hoàn chỉnh

> "Mong mỗi doanh nghiệp sở hữu một đội R&D siêu AI không bao giờ dừng lại và liên tục tiến hóa — từ người dùng công cụ, sang người kiến tạo mã, cuối cùng phát triển thành siêu trí tuệ tự tái tạo. Hãy cùng bước trên con đường tiến tới AGI."

### Tính năng chính

- **Engine Claude Code gốc** — dựa trên Claude Agent SDK, runtime nội bộ là toàn bộ Claude Code CLI, kế thừa mọi năng lực
- **Cách ly đa người dùng** — workspace mỗi người, kênh IM mỗi người, hệ thống quyền RBAC, đăng ký bằng mã mời, nhật ký kiểm toán
- **Định tuyến sáu kênh** — Feishu WebSocket, Telegram Bot API, QQ Bot API v2, DingTalk Stream, WeChat iLink, giao diện web
- **Cân bằng tải đa provider** — nhiều nhà cung cấp Claude API, ba chiến lược (round-robin / weighted / failover) với health check tự động
- **Billing và thống kê sử dụng** — billing đầy đủ (đăng ký, ví, mã đổi thưởng), theo dõi token theo mô hình với biểu đồ
- **PWA di động** — tối ưu cho di động, cài đặt màn hình chính một chạm, hỗ trợ cả iOS và Android

## Bắt đầu nhanh

### Điều kiện trước

**Bắt buộc**: [Node.js](https://nodejs.org) >= 20, [Docker](https://www.docker.com/) (cho chế độ container; không cần cho chế độ host của admin), khóa Claude API (Anthropic chính thức hoặc dịch vụ relay tương thích).

**Tùy chọn**: thông tin xác thực ứng dụng doanh nghiệp Feishu, Telegram Bot Token, thông tin QQ Bot, thông tin DingTalk, token WeChat iLink — chỉ khi cần tích hợp IM.

> Không cần cài Claude Code CLI thủ công — phụ thuộc Claude Agent SDK của dự án đã bao gồm toàn bộ CLI runtime, được cài tự động ở lần `make start` đầu tiên.

### Cài đặt và khởi động

```bash
# 1. Clone repository
git clone https://github.com/AIGeniusInstitute/deep-think.git
cd deepthink

# 2. Khởi động bằng một lệnh (lần đầu cài phụ thuộc + biên dịch)
make start
```

Mở http://localhost:9898 và làm theo hướng dẫn cài đặt: tạo admin (không có tài khoản mặc định), cấu hình Claude API và kênh IM nếu cần. Mọi thứ được cấu hình từ giao diện web, không cần tệp cấu hình. Khóa API được mã hóa bằng AES-256-GCM.

### Kích hoạt chế độ container

Người dùng admin mặc định dùng chế độ host (không cần Docker). Chế độ container cần cho người dùng member (tự động kích hoạt sau khi đăng ký):

```bash
./container/build.sh
```

Sau khi đăng ký người dùng mới, workspace chính ở chế độ container (`home-{userId}`) được tạo tự động, không cần cấu hình thêm.

## Tổng quan kiến trúc


<p align="center">
  <img src="docs/architecture/deepthink-architecture.png" alt="DeepThink System Architecture" width="860" />
</p>


DeepThink gồm ba dự án Node.js độc lập:

- **Backend** (Node.js 22 + TypeScript 5.9 + Hono): bộ định tuyến tin nhắn (polling 2s + khử trùng), hàng đợi đồng thời (tối đa 20 container + 5 quy trình host), bộ lập lịch tác vụ (cron / interval / once), máy chủ WebSocket cho streaming thời gian thực và terminal, xác thực bcrypt + HMAC Cookie, RBAC, cấu hình mã hóa AES-256-GCM. Dữ liệu trong SQLite (chế độ WAL, schema v1→v33).
- **Frontend** (`web/`): React 19 SPA + Vite 6 + Zustand 5 + Tailwind CSS 4 + shadcn/ui, react-markdown, mermaid, recharts, xterm.js, PWA di động.
- **Agent Runner** (`container/agent-runner/`): engine thực thi trong Docker container hoặc dưới dạng quy trình host. Gọi `query()` của Claude Agent SDK, phát 14 loại StreamEvent và cung cấp 12 công cụ MCP cho quy trình cha qua IPC tệp với ghi nguyên tử.

Sáu kênh IM đi vào router, được khử trùng và xếp hàng, ProviderPool chọn khóa API và khởi động container hoặc quy trình host. Sự kiện streaming được gửi đến web clients qua WebSocket hoặc quay lại các kênh qua IM API.

## Tài liệu đầy đủ

Hướng dẫn đầy đủ có tại đây:

- [Phiên bản đầy đủ tiếng Anh](README.md)
- [Phiên bản đầy đủ 简体中文](README.zh-CN.md)

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
