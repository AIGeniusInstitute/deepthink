# Howto: 新增 MCP 工具

> 从 CLAUDE.md §11 拆分而来。

## 步骤

1. 在 `container/agent-runner/src/mcp-tools.ts` 的 `createMcpTools()` 中添加 `tool()` 定义
2. 主进程 `src/index.ts` 的 IPC 处理器增加对应 type 分支
3. 重建容器镜像：`./container/build.sh`
