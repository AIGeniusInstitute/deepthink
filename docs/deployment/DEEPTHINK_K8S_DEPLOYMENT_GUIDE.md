# DeepThink K8s 一键部署指南

> **版本**: 2.1 · **最后更新**: 2026-09-13
> **适用集群**: K8s 1.24+（含 kind / minikube / ACK / TKE / EKS / GKE / 自建）

---

## 目录

1. [系统架构概览](#1-系统架构概览)
2. [前置条件](#2-前置条件)
3. [快速开始：一键部署](#3-快速开始一键部署)
4. [手动部署步骤](#4-手动部署步骤)
5. [配置参考](#5-配置参考)
6. [部署验证](#6-部署验证)
7. [基础设施组件说明](#7-基础设施组件说明)
8. [扩缩容与高可用](#8-扩缩容与高可用)
9. [备份与恢复](#9-备份与恢复)
10. [故障排查](#10-故障排查)
11. [升级与回滚](#11-升级与回滚)
12. [卸载](#12-卸载)
13. [附录：常用命令速查](#13-附录常用命令速查)

---

## 1. 系统架构概览

DeepThink 在 K8s 中以**多副本分布式模式**运行，核心拓扑如下：

```
                           ┌──────────────────────────┐
                           │   Ingress Controller      │
                           │   (nginx-ingress)         │
                           │   deepthink.example.com   │
                           └──────────┬───────────────┘
                                      │
                           ┌──────────▼───────────────┐
                           │   Service: deepthink      │
                           │   ClusterIP :9898         │
                           │   sessionAffinity: ClientIP│
                           └──────────┬───────────────┘
                                      │
              ┌───────────────────────┼───────────────────────┐
              │                       │                       │
    ┌─────────▼─────────┐   ┌────────▼────────┐   ┌─────────▼─────────┐
    │ web-server (Pod 1)│   │ web-server (Pod 2)│   │ web-server (Pod N)│
    │ Container: 9898   │   │ Container: 9898   │   │ Container: 9898   │
    │ HPA: 2~10 replicas│   │                   │   │                   │
    └────────┬──────────┘   └────────┬──────────┘   └────────┬──────────┘
             │                       │                       │
             └───────────────────────┼───────────────────────┘
                                     │
        ┌────────────────────────────┼────────────────────────────┐
        │                            │                            │
  ┌─────▼─────┐  ┌──────────┐  ┌────▼─────┐  ┌──────────┐  ┌────▼─────┐
  │ PostgreSQL │  │  Redis   │  │  MinIO   │  │  Backup  │  │  Agent   │
  │ pgvector  │  │  7-alpine│  │  Object  │  │  CronJob │  │  Runner  │
  │ :5432     │  │  :6379   │  │  Store   │  │  03:00   │  │  x2~20   │
  └───────────┘  └──────────┘  └──────────┘  └──────────┘  └──────────┘
        │
  ┌─────▼─────┐  ┌──────────┐  ┌──────────┐
  │ClickHouse │  │  Milvus  │  │Elasticsearch│
  │(analytics)│  │(向量库)  │  │(可选)      │
  └───────────┘  └──────────┘  └──────────┘
```

### 核心服务

| 组件 | 角色 | 副本数 | 存储 | 必需 |
|------|------|--------|------|------|
| **web-server** | HTTP/WS 服务 + 前端静态资源 | 2~10 | 共享 PVC (RWX) | ✅ |
| **agent-runner** | Claude Code 执行引擎 | 2~20 | 共享 PVC (RWX) | ✅ |
| **PostgreSQL** | 主数据库 (含 pgvector) | 1 | 50Gi PVC | ✅ |
| **Redis** | 跨 Pod 广播 / 分布式锁 / IPC | 1 | 5Gi PVC | ✅ |
| **MinIO** | S3 对象存储 (trace I/O) | 1 | 50Gi PVC | 可选 |
| **ClickHouse** | 分析型查询 | 1 | ephemeral | 可选 |
| **Milvus** | 向量数据库 | 1 | ephemeral | 可选 |
| **Elasticsearch** | 全文检索 | 1 | ephemeral | 可选 |

### 关键设计决策

- **多副本**：web-server 和 agent-runner 水平扩展，PostgreSQL 处理并发写入，Redis 提供跨 Pod 事件广播
- **共享存储**：所有 Pod 共享同一个 PVC（`deepthink-data`），确保 session transcript、workspace 文件、skills 跨 Pod 可访问
- **Agent IPC**：agent-runner 通过 Redis 队列接收任务（`BLPOP`），不依赖文件系统信号
- **WebSocket 广播**：通过 Redis Pub/Sub 将 WS 事件广播到所有 web-server Pod

---

## 2. 前置条件

### 2.1 基础设施要求

| 资源 | 最低要求 | 推荐配置 |
|------|---------|---------|
| K8s 版本 | 1.24+ | 1.28+ |
| 集群节点 | 2 核 8GB × 2 节点 | 4 核 16GB × 3 节点 |
| 可用存储 | 200Gi | 500Gi |
| Ingress Controller | nginx-ingress | nginx-ingress |
| StorageClass | 至少 1 个默认 SC | 1 个 RWO (SSD) + 1 个 RWX (NFS/CephFS) |
| 容器运行时 | containerd / CRI-O | containerd |

### 2.2 客户端工具

```bash
# 必需
kubectl        # ≥ 1.24（需配置好集群访问）
docker         # 用于构建镜像（如使用私有仓库）
openssl        # 生成随机密钥

# 可选
helm           # 用于安装 nginx-ingress
```

### 2.3 验证集群就绪

```bash
# 1. 检查 kubectl 连接
kubectl cluster-info

# 2. 检查默认 StorageClass
kubectl get storageclass

# 3. 检查 Ingress Controller
kubectl get pods -A | grep ingress

# 4. 检查可用资源
kubectl top nodes
```

### 2.4 安装 nginx-ingress（如未安装）

```bash
# 方式 A: Helm (推荐)
helm repo add ingress-nginx https://kubernetes.github.io/ingress-nginx
helm upgrade --install ingress-nginx ingress-nginx/ingress-nginx \
  --namespace ingress-nginx --create-namespace \
  --set controller.service.type=LoadBalancer

# 方式 B: kubectl apply
kubectl apply -f https://raw.githubusercontent.com/kubernetes/ingress-nginx/main/deploy/static/provider/cloud/deploy.yaml
```

### 2.5 准备模型 API Key

DeepThink 需要 **Anthropic-compatible API Key**（支持 DashScope / 通义千问 / 或其他 Anthropic 格式的模型服务商）：

```
ANTHROPIC_API_KEY=sk-ant-...       # Anthropic 官方
# 或
ANTHROPIC_API_KEY=sk-xxx...        # DashScope / 其他兼容服务商
```

> **⚠️ 安全提醒**：API Key 属于高度敏感信息，禁止明文写入配置文件或提交 Git。

---

## 3. 快速开始：一键部署

### 3.1 构建 Docker 镜像

```bash
cd ~/deepthink

# 使用 4 阶段 Dockerfile 构建（后端 + 前端 + agent-runner → 生产镜像）
docker build -t deepthink-server:latest -f deploy/docker/Dockerfile.server .

# 验证镜像
docker images deepthink-server:latest
```

**推送到私有仓库**（远程集群需要）：
```bash
docker tag deepthink-server:latest <registry>/deepthink-server:latest
docker push <registry>/deepthink-server:latest
```

**kind 本地集群**（无需推送）：
```bash
kind load docker-image deepthink-server:latest --name <cluster-name>
```

### 3.2 执行一键部署脚本

```bash
# 最简部署（交互式填写 API Key）
./deploy/k8s/deploy.sh --apikey "sk-ant-your-api-key"

# 指定域名和镜像
./deploy/k8s/deploy.sh \
  --domain deepthink.your-company.com \
  --image registry.cn-hangzhou.aliyuncs.com/ai/deepthink-server:latest \
  --apikey "sk-ant-your-api-key" \
  --pg-password "YourStrongPgPassword"

# 复用已创建的 Secret（适合 CI/CD 或二次部署）
./deploy/k8s/deploy.sh \
  --secret-file /path/to/existing-secret.yaml \
  --domain deepthink.example.com
```

### 3.3 脚本参数说明

| 参数 | 说明 | 默认值 |
|------|------|--------|
| `--domain` | Ingress 域名 | `deepthink.example.com` |
| `--image` | 服务镜像地址 | `deepthink-server:latest` |
| `--registry` | 镜像仓库前缀（简化 `--image`） | — |
| `--apikey` | ANTHROPIC_API_KEY（**首次必填**） | — |
| `--pg-password` | PostgreSQL 密码（不填则随机生成） | 随机 32 位 hex |
| `--secret-file` | 复用既有 Secret YAML 文件 | — |
| `--namespace` | 部署命名空间 | `deepthink` |
| `--no-wait` | 不等待 Pod 就绪 | — |
| `--no-admin` | 跳过 admin 初始化 | — |

### 3.4 脚本执行流程

```
[1/4] 处理 Secret → 生成随机密钥 + API Key
[2/4] 配置 Ingress 域名 + 镜像地址
[3/4] kubectl apply -k → 部署全部资源
[4/4] 等待 Pod 就绪 → 初始化 admin 账号 (admin/88888888)
```

---

## 4. 手动部署步骤

如果不使用一键脚本，手动部署 5 步完成：

### 4.1 创建 Secret

```bash
# 生成随机密钥
SESSION_SECRET=$(openssl rand -hex 32)
PG_PASSWORD=$(openssl rand -hex 16)

# 复制模板
cp deploy/k8s/secret.yaml.example deploy/k8s/deepthink-secret.yaml

# 编辑填入真实值
sed -i "s/CHANGE_ME_TO_RANDOM_64_HEX_CHARS/$SESSION_SECRET/" deploy/k8s/deepthink-secret.yaml
sed -i "s/CHANGE_ME_STRONG_PASSWORD/$PG_PASSWORD/" deploy/k8s/deepthink-secret.yaml
sed -i "s|sk-ant-CHANGE_ME|sk-ant-your-real-api-key|" deploy/k8s/deepthink-secret.yaml
# 同步更新 DATABASE_URL
sed -i "s|CHANGE_ME_STRONG_PASSWORD|$PG_PASSWORD|g" deploy/k8s/deepthink-secret.yaml

kubectl apply -f deploy/k8s/deepthink-secret.yaml
```

### 4.2 配置 Ingress 域名和镜像

```bash
# 修改 Ingress 域名
sed -i 's/deepthink.example.com/your-domain.com/' deploy/k8s/ingress.yaml

# 修改容器镜像（如使用私有仓库）
sed -i 's|deepthink-server:latest|registry.example.com/deepthink-server:v2.1|' deploy/k8s/deployment.yaml
sed -i 's|deepthink-server:latest|registry.example.com/deepthink-server:v2.1|' deploy/k8s/agent-runner.yaml
```

### 4.3 设置 PVC 访问模式

```bash
# 编辑 deploy/k8s/pvc.yaml
# 多副本部署（默认）：使用 ReadWriteMany (RWX)
#   accessModes: ["ReadWriteMany"]
# 单副本模式：改为 ReadWriteOnce (RWO)
#   accessModes: ["ReadWriteOnce"]

# 如集群有 NFS/CephFS RWX StorageClass：
sed -i 's|# storageClassName: nfs-client|storageClassName: nfs-client|' deploy/k8s/pvc.yaml
```

### 4.4 部署

```bash
# 推荐的 Kustomize 方式
kubectl apply -k deploy/k8s/

# 或逐个文件 apply
kubectl apply -f deploy/k8s/namespace.yaml
kubectl apply -f deploy/k8s/configmap.yaml
kubectl apply -f deploy/k8s/pvc.yaml
kubectl apply -f deploy/k8s/redis.yaml
kubectl apply -f deploy/k8s/postgres.yaml
kubectl apply -f deploy/k8s/minio.yaml          # 可选
kubectl apply -f deploy/k8s/elasticsearch.yaml   # 可选
kubectl apply -f deploy/k8s/milvus.yaml          # 可选
kubectl apply -f deploy/k8s/clickhouse.yaml      # 可选
kubectl apply -f deploy/k8s/deployment.yaml
kubectl apply -f deploy/k8s/agent-runner.yaml
kubectl apply -f deploy/k8s/service.yaml
kubectl apply -f deploy/k8s/ingress.yaml
kubectl apply -f deploy/k8s/hpa.yaml
kubectl apply -f deploy/k8s/backup-cronjob.yaml
```

### 4.5 等待就绪

```bash
# 等待 web-server
kubectl -n deepthink rollout status deployment/deepthink --timeout=300s

# 等待 agent-runner
kubectl -n deepthink rollout status deployment/agent-runner --timeout=300s

# 查看全部 Pod
kubectl -n deepthink get pods -w
```

**预期输出**：
```
NAME                              READY   STATUS    RESTARTS   AGE
agent-runner-79bc544b45-xxxxx     1/1     Running   0          2m
agent-runner-79bc544b45-yyyyy     1/1     Running   0          2m
clickhouse-0                      1/1     Running   0          2m
deepthink-69c84cfcb-xxxxx         1/1     Running   0          2m
deepthink-69c84cfcb-yyyyy         1/1     Running   0          2m
elasticsearch-0                   1/1     Running   0          2m
etcd-0                            1/1     Running   0          2m
milvus-0                          1/1     Running   0          2m
minio-0                           1/1     Running   0          2m
postgres-0                        1/1     Running   0          2m
redis-6c6bfb7bc9-xxxxx            1/1     Running   0          2m
```

---

## 5. 配置参考

### 5.1 ConfigMap 环境变量

| 变量 | 说明 | 默认值 |
|------|------|--------|
| `DEEPTHINK_DATA_DIR` | 持久数据目录 | `/data` |
| `WEB_PORT` | HTTP 服务端口 | `9898` |
| `TZ` | 时区 | `Asia/Shanghai` |
| `NODE_ENV` | 运行模式 | `production` |
| `LOG_LEVEL` | 日志级别 | `info` |
| `TRUST_PROXY` | 信任反向代理头 | `true` |
| `MAX_FILE_SIZE_MB` | 上传文件上限 | `50` |
| `REDIS_URL` | Redis 连接地址 | `redis://redis:6379` |
| `OBJECT_STORE_PROVIDER` | 对象存储后端 (`fs`/`s3`) | `fs` |
| `S3_BUCKET` | S3桶名 | `deepthink` |
| `S3_ENDPOINT` | S3 地址 | `http://minio:9000` |
| `S3_REGION` | S3 区域 | `us-east-1` |
| `S3_FORCE_PATH_STYLE` | S3 Path-Style 访问 | `true` |

### 5.2 Secret 敏感配置

| Key | 说明 | 生成方式 |
|-----|------|---------|
| `WEB_SESSION_SECRET` | Cookie 签名密钥 | `openssl rand -hex 32` |
| `ANTHROPIC_API_KEY` | Claude 模型 API Key | 从服务商获取 |
| `PG_USER` | PostgreSQL 用户名 | `deepthink` |
| `PG_PASSWORD` | PostgreSQL 密码 | `openssl rand -hex 16` |
| `DATABASE_URL` | 完整 PG 连接串 | `postgresql://deepthink:PASS@postgres:5432/deepthink` |
| `S3_ACCESS_KEY_ID` | MinIO Access Key | `deepthink` |
| `S3_SECRET_ACCESS_KEY` | MinIO Secret Key | 自定义 |
| `CLICKHOUSE_USER` | ClickHouse 用户名 | `deepthink` |
| `CLICKHOUSE_PASSWORD` | ClickHouse 密码 | 自定义 |

### 5.3 资源配额

```yaml
# web-server
resources:
  requests: { cpu: "500m", memory: "1Gi" }
  limits:   { cpu: "4000m", memory: "4Gi" }

# agent-runner
resources:
  requests: { cpu: "500m", memory: "1Gi" }
  limits:   { cpu: "2000m", memory: "4Gi" }

# PostgreSQL
resources:
  requests: { cpu: "500m", memory: "1Gi" }
  limits:   { cpu: "2000m", memory: "4Gi" }
```

### 5.4 PVC 存储

| PVC | 大小 | 访问模式 | 用途 |
|-----|------|---------|------|
| `deepthink-data` | 100Gi | RWX | workspace + session transcripts + DB |
| `pg-data` | 50Gi | RWO | PostgreSQL 数据 |
| `redis-data` | 5Gi | RWO | Redis 持久化 (AOF) |
| `minio-data` | 50Gi | RWO | S3 对象存储 |

### 5.5 健康检查与优雅停机

```
web-server:
  startupProbe:   /health  (最长 300s, 覆盖 PG 冷启动建表)
  livenessProbe:  /health  (每 30s)
  readinessProbe: /ready   (每 10s)
  terminationGracePeriodSeconds: 120

agent-runner:
  terminationGracePeriodSeconds: 120 (等待正在执行的 task 完成)
```

---

## 6. 部署验证

### 6.1 健康检查

```bash
# 方式 1: 端口转发
kubectl -n deepthink port-forward svc/deepthink 8080:9898

# 健康端点
curl http://localhost:8080/health   # → {"status":"ok","timestamp":...}
curl http://localhost:8080/ready    # → {"status":"ready"}
curl http://localhost:8080/         # → 返回 DeepThink SPA 首页 HTML

# 方式 2: 在 Pod 内验证
kubectl -n deepthink exec deploy/deepthink -- curl -sf localhost:9898/health
```

### 6.2 登录验证

```bash
# 通过 Ingress 域名访问（DNS 需已配置）
open https://deepthink.your-domain.com/login

# 或端口转发后浏览器访问
open http://localhost:8080/login

# 默认管理员账号
# 用户名: admin
# 密码:   88888888
# ⚠️ 首次登录后务必立即修改密码
```

### 6.3 端到端聊天测试

```bash
# 创建端口转发
kubectl -n deepthink port-forward svc/deepthink 8080:9898 &

# 登录获取 session cookie
curl -X POST http://localhost:8080/api/auth/login \
  -H "Content-Type: application/json" \
  -d '{"username":"admin","password":"88888888"}' \
  -c /tmp/cookies.txt -v

# 发送消息给 Agent（通过 API 测试流式输出）
# 注：完整聊天流程通过 Web UI 浏览器验证更可靠
```

### 6.4 多 Pod 验证

```bash
# 确认所有 web-server Pod 健康
kubectl -n deepthink get pods -l app.kubernetes.io/name=deepthink
for pod in $(kubectl -n deepthink get pods -l app.kubernetes.io/name=deepthink -o name); do
  echo -n "$pod: "
  kubectl -n deepthink exec $pod -- curl -sf localhost:9898/health
done

# 确认 agent-runner Pod 注册到 Redis
kubectl -n deepthink exec deploy/redis -- redis-cli SMEMBERS deepthink:agent-runners:pool

# 确认 Redis Pub/Sub 跨 Pod 广播
kubectl -n deepthink exec deploy/redis -- redis-cli PUBLISH deepthink:ws:broadcast '{"type":"test"}'
```

### 6.5 自动化验收测试

```bash
# 运行全量 E2E 测试（需 playwright-core + chromium）
NODE_PATH=/tmp/node_modules node scripts/full-e2e-test.mjs
# 覆盖: 登录 / 流式聊天 / 新建会话 / 全部 20 个核心模块页面
```

---

## 7. 基础设施组件说明

### 7.1 PostgreSQL（必需）

- **镜像**：`pgvector/pgvector:pg16`（自带 pgvector 向量扩展）
- **数据库**：`deepthink`，用户 `deepthink`（从 Secret 注入）
- **数据持久化**：50Gi PVC (`pg-data`)
- **自动迁移**：web-server 启动时自动执行 schema migration（幂等，70+ 表）
- **高可用**：当前单实例；生产环境可升级为 Patroni/CloudNativePG 主从

### 7.2 Redis（必需）

- **镜像**：`redis:7-alpine`
- **持久化**：AOF（`--appendonly yes`），最大内存 256MB，LRU 淘汰
- **用途**：
  - `deepthink:ws:broadcast` — WS 消息跨 Pod 广播
  - `deepthink:agent-tasks` — agent-runner 任务队列
  - `deepthink:agent-runners:pool` — agent-runner 注册表
  - `deepthink:im-leader` — IM 连接分布式锁
  - `deepthink:user-active:*` — 用户并发计数器

### 7.3 MinIO（可选）

- **镜像**：`minio/minio:latest`
- **端口**：9000 (S3 API) / 9001 (Web Console)
- **用途**：当 `OBJECT_STORE_PROVIDER=s3` 时，trace I/O 大文件卸载到 MinIO
- **自动初始化**：`minio-make-bucket` Job 启动时创建 `deepthink` bucket

### 7.4 ClickHouse / Milvus / Elasticsearch（可选）

预留基础设施，当前未被应用层消费，无此三组件不影响核心功能。

---

## 8. 扩缩容与高可用

### 8.1 自动扩缩容 (HPA)

web-server 和 agent-runner 均已配置 HPA：

```bash
# 查看 HPA 状态
kubectl -n deepthink get hpa

# 查看当前副本数
kubectl -n deepthink get deploy

# 调整 HPA 参数
kubectl -n deepthink edit hpa deepthink
kubectl -n deepthink edit hpa agent-runner
```

**HPA 策略**：
- web-server：基于 CPU 70% + Memory 80%，2~10 副本
- agent-runner：基于 CPU 70%，2~20 副本
- 扩容稳定窗口：60s，缩容稳定窗口：300s

### 8.2 手动扩缩容

```bash
# web-server
kubectl -n deepthink scale deployment/deepthink --replicas=5

# agent-runner
kubectl -n deepthink scale deployment/agent-runner --replicas=8
```

### 8.3 垂直扩容（资源调整）

```bash
# 增加 web-server 资源限制
kubectl -n deepthink patch deploy deepthink -p '{
  "spec":{"template":{"spec":{"containers":[{
    "name":"deepthink",
    "resources":{"limits":{"cpu":"8000m","memory":"8Gi"}}
  }]}}}}'
```

### 8.4 高可用说明

| 维度 | 现状 | 推荐升级路径 |
|------|------|-------------|
| web-server | 多副本 + HPA | — |
| agent-runner | 多副本 + HPA | — |
| PostgreSQL | 单实例 | CloudNativePG / Patroni 主从 |
| Redis | 单实例 | Redis Sentinel / Cluster |
| PVC | 依赖 RWX SC | CephFS / NFS / EFS |

---

## 9. 备份与恢复

### 9.1 自动备份

每日凌晨 03:00 自动执行（CronJob），保留最近 7 份：

```bash
# 查看备份任务状态
kubectl -n deepthink get cronjob,jobs

# 查看最近备份
kubectl -n deepthink get jobs --sort-by=.status.completionTime | tail -5

# 查看备份文件
kubectl -n deepthink exec deploy/deepthink -- ls -lh /data/backups/
```

**备份策略**：
- PG 模式：`pg_dump | gzip` → `/data/backups/pg-YYYYMMDD-HHMMSS.sql.gz`
- SQLite 模式：`cp messages.db` → `/data/backups/messages-YYYYMMDD-HHMMSS.db`

### 9.2 手动备份

```bash
# PG 模式
kubectl -n deepthink exec statefulset/postgres -- \
  pg_dump -U deepthink deepthink | gzip > /tmp/deepthink-backup-$(date +%Y%m%d).sql.gz

# 从 PVC 复制
kubectl -n deepthink cp deploy/deepthink:/data/backups/ ./local-backups/
```

### 9.3 灾难恢复

```bash
# 1. 停止所有 web-server
kubectl -n deepthink scale deployment/deepthink --replicas=0

# 2. 恢复 PG 数据库
kubectl -n deepthink exec -i statefulset/postgres -- \
  psql -U deepthink deepthink < /path/to/backup.sql

# 3. 重新启动
kubectl -n deepthink scale deployment/deepthink --replicas=2

# 4. 验证
kubectl -n deepthink rollout status deployment/deepthink
curl http://localhost:8080/health  # 端口转发后
```

---

## 10. 故障排查

### 10.1 常见问题

| 现象 | 可能原因 | 诊断命令 | 解决方案 |
|------|---------|---------|---------|
| Pod CrashLoopBackOff | Secret 缺失或错误 | `kubectl -n deepthink logs deploy/deepthink --tail=50` | 检查 `ANTHROPIC_API_KEY` 格式 |
| PVC Pending | 无默认 StorageClass | `kubectl describe pvc -n deepthink` | 设置默认 SC 或指定 `storageClassName` |
| Ingress 404/502 | 域名不匹配或 Service 未就绪 | `kubectl describe ingress -n deepthink` | 确认 host 正确 + Pod Ready |
| WebSocket 频繁断开 | Ingress proxy timeout 太短 | — | 已预配置 `proxy-read-timeout: 3600` |
| PG 启动超时 | 冷启动建表慢 | `kubectl logs deploy/deepthink --tail=100` | startupProbe 已设 300s，等待即可 |
| Agent 无响应 | agent-runner 未就绪 | `kubectl logs deploy/agent-runner --tail=50` | 检查 Redis 连接 + `AGENT_RUNNER_MODE` |
| 消息重复 | 同 Pod 收到自己的 Redis 广播 | `kubectl logs deploy/deepthink | grep _originPod` | v2.1+ 已内置 `_originPod` 去重，检查版本 |

### 10.2 诊断命令速查

```bash
# Pod 状态全览
kubectl -n deepthink get pods -o wide

# 实时日志
kubectl -n deepthink logs -f -l app.kubernetes.io/name=deepthink --tail=100
kubectl -n deepthink logs -f -l app=agent-runner --tail=100

# 最近的 K8s 事件
kubectl -n deepthink get events --sort-by='.lastTimestamp' | tail -20

# 进入容器排查
kubectl -n deepthink exec -it deploy/deepthink -- sh

# 资源使用
kubectl -n deepthink top pods
kubectl -n deepthink top nodes

# 查看 Secret 是否正确
kubectl -n deepthink get secret deepthink-secret -o jsonpath='{.data.ANTHROPIC_API_KEY}' | base64 -d | head -c 20

# 检查 Redis
kubectl -n deepthink exec deploy/redis -- redis-cli PING
kubectl -n deepthink exec deploy/redis -- redis-cli INFO stats

# 检查 PG
kubectl -n deepthink exec statefulset/postgres -- pg_isready -U deepthink
kubectl -n deepthink exec statefulset/postgres -- psql -U deepthink -c "SELECT count(*) FROM information_schema.tables WHERE table_schema='public';"
```

### 10.3 Pod 无法启动的排查流程

```
1. kubectl describe pod <pod-name> -n deepthink
   → 查看 Events 区域，了解调度/拉取镜像/启动失败原因

2. kubectl logs <pod-name> -n deepthink --previous
   → 查看上一次崩溃的日志

3. kubectl logs <pod-name> -n deepthink
   → 查看当前运行日志

4. kubectl -n deepthink get events --field-selector involvedObject.name=<pod-name>
   → 查看相关 K8s 事件
```

---

## 11. 升级与回滚

### 11.1 滚动升级

```bash
# 1. 构建新镜像
docker build -t deepthink-server:v2.2 -f deploy/docker/Dockerfile.server .
docker push <registry>/deepthink-server:v2.2

# 2. 更新 web-server 镜像（RollingUpdate，maxUnavailable: 0）
kubectl -n deepthink set image deployment/deepthink \
  deepthink=<registry>/deepthink-server:v2.2

# 3. 更新 agent-runner 镜像
kubectl -n deepthink set image deployment/agent-runner \
  agent-runner=<registry>/deepthink-server:v2.2

# 4. 监控滚动更新
kubectl -n deepthink rollout status deployment/deepthink
kubectl -n deepthink rollout status deployment/agent-runner
```

### 11.2 回滚

```bash
# 查看历史版本
kubectl -n deepthink rollout history deployment/deepthink

# 回滚到上一版本
kubectl -n deepthink rollout undo deployment/deepthink
kubectl -n deepthink rollout undo deployment/agent-runner

# 回滚到指定版本
kubectl -n deepthink rollout undo deployment/deepthink --to-revision=3
```

### 11.3 零停机升级要点

- web-server 策略 `maxSurge: 1, maxUnavailable: 0` 确保升级期间始终有 Pod 服务
- agent-runner `terminationGracePeriodSeconds: 120` 让正在执行的 task 自然完成
- 建议先升级 agent-runner，再升级 web-server

---

## 12. 卸载

### 12.1 清理全部资源

```bash
# 删除 namespace 及其中全部资源
kubectl delete namespace deepthink

# 删除 PVC（namespace 删除后 PVC 可能残留）
kubectl delete pvc --all -n deepthink 2>/dev/null
```

### 12.2 仅删除工作负载（保留数据）

```bash
kubectl -n deepthink scale deployment/deepthink --replicas=0
kubectl -n deepthink scale deployment/agent-runner --replicas=0
```

---

## 13. 附录：常用命令速查

```bash
# ═══ Pod 管理 ═══
kubectl -n deepthink get pods -w                              # 实时查看 Pod 状态
kubectl -n deepthink describe pod <pod-name>                  # Pod 详细信息
kubectl -n deepthink delete pod <pod-name>                    # 删除 Pod（Deployment 会自动重建）

# ═══ 日志 ═══
kubectl -n deepthink logs -f deploy/deepthink --tail=200      # web-server 实时日志
kubectl -n deepthink logs -f deploy/agent-runner --tail=200   # agent-runner 实时日志
kubectl -n deepthink logs deploy/deepthink --previous         # 查看上一次崩溃日志

# ═══ 扩缩容 ═══
kubectl -n deepthink scale deploy/deepthink --replicas=1      # 缩容到 1
kubectl -n deepthink scale deploy/agent-runner --replicas=4   # 扩容到 4
kubectl -n deepthink get hpa                                  # 查看 HPA 状态

# ═══ 端口转发 ═══
kubectl -n deepthink port-forward svc/deepthink 8080:9898     # 本地访问 Web UI
kubectl -n deepthink port-forward svc/minio 9001:9001         # 本地访问 MinIO Console

# ═══ 进入容器 ═══
kubectl -n deepthink exec -it deploy/deepthink -- sh          # web-server shell
kubectl -n deepthink exec -it deploy/agent-runner -- sh       # agent-runner shell
kubectl -n deepthink exec -it deploy/redis -- redis-cli       # Redis CLI

# ═══ 基础设施 ═══
kubectl -n deepthink exec statefulset/postgres -- psql -U deepthink  # PG 控制台
kubectl -n deepthink exec deploy/redis -- redis-cli INFO            # Redis 状态
kubectl -n deepthink exec deploy/redis -- redis-cli LLEN deepthink:agent-tasks  # 任务队列长度

# ═══ 备份 ═══
kubectl -n deepthink create job --from=cronjob/deepthink-backup manual-backup-$(date +%s)  # 手动触发备份
kubectl -n deepthink exec deploy/deepthink -- ls -lh /data/backups/   # 查看备份文件

# ═══ 集群信息 ═══
kubectl -n deepthink get all                                    # 全部资源概览
kubectl -n deepthink get pvc,pv                                 # 存储状态
kubectl -n deepthink get events --sort-by='.lastTimestamp'      # 最近事件
```

---

> **文档维护**：部署配置变更时请同步更新本文档。
> **问题反馈**：提交 Issue 到 `git@gitcode.com:AIGeniusInstitute/deepthink.git`
> **生产部署咨询**：联系 DeepThink 团队获取定制化部署方案。