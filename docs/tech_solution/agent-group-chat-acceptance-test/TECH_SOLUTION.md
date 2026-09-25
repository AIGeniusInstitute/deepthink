# Agent Group Chat 验收测试 — 技术方案

## 测试方法

使用 Playwright 自动化浏览器测试，结合 WS 帧监听和 DOM 快照验证。

### 测试工具

- **playwright-core**: 无头 Chrome 浏览器自动化
- **WS 帧监听**: 通过 `page.on('websocket')` 监听 stream_event
- **DOM 快照**: MutationObserver 捕获实时渲染元素
- **截图**: 关键节点全页截图

### 前端部署

本地 9999 实例需要包含以下修复：
1. GroupChatArea.tsx React 状态竞态条件修复（单一原子 setSeats）
2. 确保 WS 流式事件正确渲染

部署步骤：
```bash
cd ~/deepthink
npm run build:web        # 构建前端
# 重启 9999 服务
kill <PID>
nohup env DEEPTHINK_WEB_DIST_DIR=/home/me/deepthink/web/dist DEEPTHINK_DATA_DIR=/home/me/.deepthink-9999 WEB_PORT=9999 node dist/index.js > logs/deepthink-9999.log 2>&1 & disown
```

### 测试脚本位置

测试脚本：`scripts/e2e/agent-group-chat-acceptance.mjs`
测试截图：`downloads/agent-group-chat-acceptance/`
测试报告：`docs/test_report/agent-group-chat-acceptance-test/TEST_REPORT.html`