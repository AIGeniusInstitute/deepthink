# 隔离跑 dev（独立端口 + 独立数据目录）

## 为什么需要

DeepThink agent 的 shell 会**继承生产实例的环境变量**：
- `WEB_PORT`（桌面 app `/opt/DeepThink` 通常设了一个固定端口，如 49281）
- `DEEPTHINK_DATA_DIR`（指向生产 `messages.db` 所在目录）

直接 `make dev` 会继承这两个变量 → 后端尝试绑定生产端口（`EADDRINUSE`）+ 共享生产 SQLite（污染/锁竞争）。本方法用独立端口 + 独立数据目录跑 dev，与生产实例完全并存。

## 用法

```bash
# 默认：后端 :9898，数据目录 /tmp/deepthink-dev-9898
make dev-isolated

# 自定义端口 + 数据目录
make dev-isolated ISOLATED_PORT=9899 ISOLATED_DATA_DIR=/tmp/dt-9899
```

启动后：
- 后端 API：`http://127.0.0.1:<ISOLATED_PORT>`
- Web UI（vite）：`http://127.0.0.1:5173`（vite 代理到后端 `<ISOLATED_PORT>`）
- 首次访问走 Setup 流程注册首个 admin（独立数据目录是空库）
- 数据隔离：所有消息/任务/图运行都在 `/tmp/deepthink-dev-<port>/` 下，不碰生产

## 前置

- `node_modules` + `web/node_modules` + `container/agent-runner/node_modules` 已安装（`make install`）
- Docker 镜像已构建（`make dev` 首次会建；隔离 dev 跳过镜像构建，若未建过先跑一次 `make dev` 或 `make _ensure-docker-image _ensure-sandbox-image`）

## 在 DeepThink agent 会话里跑

agent 会话里 `make dev-isolated` 不会终结会话（不动生产进程），后台跑即可：

```bash
make dev-isolated > /tmp/dt-dev.log 2>&1 &
```

## 关键变量

| 变量 | 作用 | 默认 |
|------|------|------|
| `ISOLATED_PORT` | 后端监听端口 | 9898 |
| `ISOLATED_DATA_DIR` | 独立数据目录 | `/tmp/deepthink-dev-<port>` |
| `WEB_PORT` | 后端实际读取的端口（代码 `config.ts`） | = `ISOLATED_PORT` |
| `VITE_API_PROXY_TARGET` / `VITE_WS_PROXY_TARGET` | vite 代理目标 | `127.0.0.1:<port>` |

## 验证新代码上线

```bash
# 路由存在（401=需登录，说明已挂载）
curl -s -o /dev/null -w "%{http_code}\n" http://127.0.0.1:9898/api/graph/definitions
# Web UI 打开 http://127.0.0.1:5173 → Setup 注册 admin → /graphs 页
```
