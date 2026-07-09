# Howto: 新增 Skills

> 从 CLAUDE.md §11 拆分而来。

## 步骤

1. 项目级：添加到 `container/skills/`（自动挂载到所有容器，通过符号链接发现）
2. 用户级：添加到 `~/.claude/skills/`（自动挂载到所有容器）
3. 无需重建镜像，volume 挂载 + entrypoint.sh 符号链接自动发现
