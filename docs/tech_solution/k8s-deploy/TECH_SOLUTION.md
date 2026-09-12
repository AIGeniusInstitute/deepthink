# DeepThink K8s 全量部署 — 技术方案

**日期**: 2026-09-13
**版本**: v1.0

## 1. 架构概览

```
┌─────────────────────────────────────────────────────────┐
│                     NodePort 30080/30081                │
│                   ingress-nginx (v1.11.2)               │
├─────────────────────────────────────────────────────────┤
│  ┌──────────────┐  ┌──────────────┐                    │
│  │ deepthink x2 │  │agent-runnerx2│                    │
│  │  (Web+API)   │  │(分布式 IPC)  │                    │
│  └──┬───┬───┬───┘  └──────┬───────┘                    │
│     │   │   │              │                            │
│     ▼   ▼   ▼              ▼                            │
│  ┌──────┐ ┌──────┐ ┌──────────┐                        │
│  │PostgreSQL│ │Redis │ │ MinIO   │                        │
│  │ pgvector │ │  7   │ │  (S3)   │                        │
│  └──────────┘ └──────┘ └──────────┘                        │
│                                                         │
│  可选: ES │ Milvus+etcd │ ClickHouse                    │
└─────────────────────────────────────────────────────────┘
```

## 2. 部署策略

### 2.1 镜像交付
kind 节点无公网出网，所有镜像走离线注入：
```bash
docker pull <image>
kind load docker-image <image> --name desktop
```
镜像 `imagePullPolicy: IfNotPresent`，命中本地缓存。

### 2.2 Kustomize 分层
```
deploy/k8s/            ← base (RWX PVC, host ingress)
deploy/k8s-kind/       ← kind overlay (RWO PVC, no host)
```

kind overlay 关键 patch：
- PVC accessModes: `ReadWriteMany → ReadWriteOnce`
- Ingress: 移除 `host: deepthink.example.com`，改为 catch-all

### 2.3 已知限制与决策

**containerd hosts.toml 损坏**：`/etc/containerd/certs.d/_default/hosts.toml` 是目录非文件 → 在线拉取不可用。**决策**: 不修（Surgical Changes），走既定离线注入路径。

## 3. PostgreSQL 集成

### 3.1 同步驱动架构
```
主线程                     Worker 线程
   │                           │
   │── querySync(sql, params)─→│
   │   (SAB + Atomics.wait)    │── pg.Pool.query()
   │                           │
   │←── Atomics.notify ────────│
   │   (结果写入 SAB)           │
```

### 3.2 BIGINT 兼容性
node-postgres 将 BIGINT 返回为字符串。关键修复：
```typescript
// Before (BUG):
must_change_password: !!row.must_change_password,  // !!"0" === true!
// After (FIX):
must_change_password: !!(Number(row.must_change_password)),
```

### 3.3 SQL 翻译器
SQLite → PG 核心翻译规则：
- `? → $1, $2, ...`
- `datetime('now') → NOW()`
- `INSERT OR REPLACE → INSERT ... ON CONFLICT DO UPDATE`
- `BLOB → BYTEA`
- `INTEGER PRIMARY KEY → BIGSERIAL`

## 4. Redis 消息总线

### 4.1 Pub/Sub 频道
| 频道 | 用途 |
|------|------|
| `deepthink:ws:broadcast` | 跨 Pod WebSocket 广播 |
| `deepthink:user-active-pub` | 用户活跃状态同步 |
| `deepthink:ipc:{folder}` | Agent IPC 消息 |
| `deepthink:agent-tasks` | Agent Runner 任务队列 |

### 4.2 Agent Runner IPC
分布式模式流程：
```
deepthink Pod → LPUSH deepthink:agent-tasks → BLPOP agent-runner Pod
agent-runner → 执行 → LPUSH deepthink:ipc-out:{folder}:messages → deepthink Pod
```

### 4.3 分布式锁
- Leader 选举: `SET NX PX` 互斥锁 + TTL 故障转移
- 共享计数器: CAS 原语 `acquireOwnership/releaseOwnership`

## 5. MinIO 对象存储

### 5.1 Bucket 规划
| Bucket | 用途 |
|--------|------|
| `deepthink/` | 工作区文件、产物 |
| `deepthink-litestream/` | SQLite WAL 备份 |
| `milvus/` | Milvus 向量数据 |

### 5.2 初始化
Init Job `minio-make-bucket` 使用 `minio/mc` 镜像自动创建 bucket。

## 6. Ingress 配置

```yaml
# kind overlay: 移除 host 要求
spec:
  rules:
  - http:
      paths:
      - path: /
        pathType: Prefix
        backend:
          service:
            name: deepthink
            port:
              number: 3000
```

## 7. 存储配置

| PVC | 大小 | 访问模式 | 存储类 |
|-----|------|----------|--------|
| deepthink-data | 100Gi | RWO | standard |
| pg-data | 50Gi | RWO | standard |
| minio-data | 50Gi | RWO | standard |
| redis-data | 5Gi | RWO | standard |
| es-data | 5Gi | RWO | standard |
| clickhouse-data | 5Gi | RWO | standard |
| etcd-data | 3Gi | RWO | standard |