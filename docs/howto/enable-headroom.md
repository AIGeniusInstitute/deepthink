# Howto: 启用 Headroom（工具输出/RAG/日志 token 压缩）

> 从 CLAUDE.md §11 拆分而来。

容器镜像默认带 [Headroom](https://github.com/chopratejas/headroom)（Apache-2.0，60-95% token 减少），**默认不启用**，用户自行决定是否打开：

1. 打开 `/mcp-servers` 页面 → Add server
2. 填：name=`headroom`，command=`headroom`，args=`["mcp", "serve"]`，enabled=true
3. 下一次会话起 Claude 获得 `headroom_compress` / `headroom_retrieve` / `headroom_stats` 三个工具

Claude 在读大文件、跑大 log 命令、处理 RAG chunk 时会主动调用。属于 per-user MCP server 范畴（详见 `docs/API.md` 与 `src/routes/mcp-servers.ts`），不走 agent-runner 内置注册。
