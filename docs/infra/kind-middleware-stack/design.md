# kind 中间件基建栈 — 设计说明

## 背景 / 范围
在本机 `desktop` kind 集群（control-plane + worker，k8s v1.33.1，local-path 存储）上搭建 6 件中间件：PostgreSQL、Redis、Elasticsearch、MinIO、Milvus、ClickHouse。

仓库 `deploy/local/docker-compose.yml` 顶部注释明说：DeepThink 平台用 pgvector + pg_trgm 替代 Milvus/ES，`src/` 无任何 ES/Milvus/ClickHouse 引用。本次搭建为**通用基建预留**，非 app 当前依赖——用户已确认。

## 设计取舍
- **裸 manifest，对齐 `deploy/k8s/` 既有风格**：StatefulSet + `volumeClaimTemplates` + ClusterIP Service + `app.kubernetes.io/name`/`component` 标签 + 复用 `deepthink-secret`/`deepthink-config`。不引入 helm。
- **PG/Redis/MinIO 复用现有 manifest**（postgres.yaml/redis.yaml/minio.yaml），不改其资源配额。
- **ES/Milvus/ClickHouse 新增 3 个 manifest**，最小占用 preset（单副本、小堆/低 requests）。
- **Milvus 复用现有 MinIO** 作对象存储 + 新增一个 etcd pod；rocksmq 内嵌，不引 pulsar/kafka。
- **凭据**：patch 现有 `deepthink-secret` 补 PG/S3/ClickHouse 凭据（openssl 随机口令，不入 git）；ES/Milvus/Redis 在 kind 内不开认证。
- **镜像供给**：kind 节点无公网出网 + containerd hosts.toml 配置损坏，**走集群既定的 `kind load docker-image` 离线注入**，`imagePullPolicy: IfNotPresent` 命中本地缓存绕开拉取路径。详见 `docs/issues/2026-09-12-kind-node-image-pull-broken.md`。
- **只 apply 6 件 + 依赖**，不拉 ingress/hpa/agent-runner（用户未要求）。

## 组件清单
| 组件 | 镜像 | DNS:port | PVC | req cpu/mem | 状态 |
|---|---|---|---|---|---|
| PostgreSQL | pgvector/pgvector:pg16 | postgres:5432 | pg-data 50Gi | 500m/1Gi | 既有 manifest |
| Redis | redis:7-alpine | redis:6379 | redis-data 5Gi | 100m/256Mi | 既有 manifest |
| MinIO | minio/minio:latest | minio:9000,9001 | minio-data 50Gi | 250m/512Mi | 既有 manifest |
| Elasticsearch | elasticsearch:8.11.3 | elasticsearch:9200 | es-data 5Gi | 500m/1Gi | 新增 |
| etcd | quay.io/coreos/etcd:v3.5.5 | etcd:2379 | etcd-data 3Gi | 100m/256Mi | 新增（Milvus 依赖） |
| Milvus | milvusdb/milvus:v2.4.6 | milvus:19530,9091 | — | 500m/1Gi | 新增 |
| ClickHouse | clickhouse/clickhouse-server:24.3 | clickhouse:8123 | ch-data 5Gi | 250m/512Mi | 新增 |

requests 合计 ≈ 2.2 cpu / ~4.4Gi。宿主机 15Gi/可用 ~4.3Gi + 12Gi swap，运行期实际占用顶 swap，用户已知情接受最小占用风险。

## 文件变更
- 新增 `deploy/k8s/elasticsearch.yaml`、`deploy/k8s/milvus.yaml`、`deploy/k8s/clickhouse.yaml`
- 改 `deploy/k8s/kustomization.yaml`（resources 追加三件）
- 改 `deploy/k8s/configmap.yaml`（追加 ES/MILVUS/CH 的 DNS，供 envFrom）
- 改 `deploy/k8s/secret.yaml.example`（追加 CLICKHOUSE_* 模板）

## 验证标准
6 件 pod 全 Running+ready；逐件连通性取证：
- PG `pg_isready` + `psql \l`
- Redis `redis-cli ping` → PONG
- MinIO `curl /minio/health/ready` + `mc ls` 验 milvus bucket
- ES `curl /_cluster/health` → yellow/green
- Milvus `curl /healthz` → OK
- ClickHouse `clickhouse-client SELECT version()`

详见 `test_report.md`。
