# K8s 集群全量部署 — 用户原始意图

**日期**: 2026-09-13
**目标集群**: kind-desktop (K8s v1.32.2, 2 节点: control-plane + worker)

## 用户意图

将 DeepThink 系统完整部署到本机 K8s 集群 `kind-desktop`，走 PostgreSQL + Redis + MinIO 全量生产依赖，确保：

1. **DeepThink 前后端正常运行** — 登录、会话、WebSocket 广播、工作区文件
2. **Agent Runner 分布式模式** — 经 Redis IPC 接收任务、执行对话
3. **持久化全部走云端存储**：
   - PostgreSQL: 会话消息、用户、配置、审计等核心数据
   - Redis: 跨 Pod pub/sub 广播、分布式锁、Agent IPC
   - MinIO: 大文件产物、trace I/O 落盘
4. **Ingress 可访问** — 通过 NodePort + Host 头路由
5. **全量依赖就绪** — 包括可选中间件 (ES/Milvus/ClickHouse)，为未来功能预留

## 环境信息

- 集群访问点: 192.168.1.25 (Kuboard), NodePort 30080/30081
- 节点: 172.19.0.2 (control-plane), 172.19.0.3 (worker)
- 已有基础设施: ingress-nginx (v1.11.2), local-path-storage
- 镜像注入方式: `kind load docker-image` (节点无公网出网)