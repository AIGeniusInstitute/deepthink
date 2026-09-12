# DeepThink K8s 全量部署 — 需求 PRD

**日期**: 2026-09-13
**版本**: v1.0
**状态**: 已交付

## 1. 需求概述

将 DeepThink AI Agent OS 从本地单进程 SQLite 架构完整部署到 K8s 集群 `kind-desktop`，引入 PostgreSQL + Redis + MinIO 作为核心中间件，实现数据持久化全量上云、跨 Pod 水平扩展、分布式 Agent 执行。

## 2. 背景

DeepThink 现有架构基于 SQLite + 本地文件系统，存在以下瓶颈：

| 瓶颈 | 影响 | K8s 方案 |
|------|------|----------|
| SQLite 单写者 | 无法水平扩展 | PostgreSQL (pgvector) |
| 进程内广播 | 仅单 Pod WebSocket | Redis Pub/Sub |
| 本地文件存储 | Pod 漂移丢数据 | MinIO S3 对象存储 |
| Agent 进程绑定 | 无法分布式执行 | Redis IPC Agent Runner |
| 内存锁 | 跨 Pod 竞态 | Redis 分布式锁 |

## 3. 目标集群

- **集群名**: kind-desktop (以前叫 desktop)
- **K8s 版本**: v1.32.2
- **节点**: desktop-control-plane + desktop-worker (2 节点)
- **镜像注入**: `kind load docker-image`（节点无公网出网）
- **已有基础设施**: ingress-nginx v1.11.2, local-path-storage

## 4. 功能需求

### FR1: 核心服务部署
- FR1.1: deepthink Web Server (2 replicas, Deployment)
- FR1.2: agent-runner 分布式模式 (2 replicas, Deployment, HPA 2-20)
- FR1.3: PostgreSQL 16 + pgvector (StatefulSet, 50Gi PVC)
- FR1.4: Redis 7 (Deployment, 5Gi PVC)
- FR1.5: MinIO (StatefulSet, 50Gi PVC)

### FR2: 可选基础设施
- FR2.1: Elasticsearch 8.11 (全文搜索)
- FR2.2: Milvus 2.4 (向量数据库, 需 etcd)
- FR2.3: ClickHouse 24.3 (OLAP 分析)
- FR2.4: etcd 3.5 (Milvus 元数据)

### FR3: 数据持久化
- FR3.1: 会话消息全部落 PostgreSQL
- FR3.2: Redis 跨 Pod pub/sub 广播
- FR3.3: MinIO 对象存储 (deepthink/deepthink-litestream/milvus buckets)
- FR3.4: 所有有状态服务绑定 PVC

### FR4: 网络暴露
- FR4.1: Ingress NodePort 30080/30081 对外
- FR4.2: Kustomize kind overlay (PVC RWO, ingress 去 host)

## 5. 非功能需求

- NFR1: 健康检查 /health + /ready (就绪探针)
- NFR2: PostgreSQL BIGINT 字符串兼容 (node-postgres)
- NFR3: 优雅停机 (SIGTERM 120s)
- NFR4: 镜像离线注入 (无公网出网环境)

## 6. 成功标准

| 指标 | 目标 | 实际 |
|------|------|------|
| Pod 健康率 | 100% | 100% (14/14) |
| 登录可用 | must_change_password=false | ✅ |
| API 可达 | /health 200 | ✅ |
| PG 数据持久化 | 28+ 表 | ✅ |
| Redis 总线 | Pub/Sub 频道活跃 | ✅ |
| MinIO buckets | 3 buckets 创建 | ✅ |
| Agent Runner | 分布式模式 | ✅ |