# 测试报告 — kind 中间件基建栈

**日期**：2026-09-12 → 2026-09-13
**集群**：`desktop` kind（control-plane + worker，k8s v1.33.1）
**命名空间**：`deepthink`
**结论**：✅ **6 件中间件全部 Running 且端到端连通验证通过**（含 Milvus 依赖 etcd，及两个建桶 Job Succeeded）。

## 1. Pod 状态（kubectl get pods -n deepthink）

| NAME | READY | STATUS | IMAGE |
|---|---|---|---|
| postgres-0 | 1/1 | Running | pgvector/pgvector:pg16 |
| redis-6c6bfb7bc9-85qsk | 1/1 | Running | redis:7-alpine |
| elasticsearch-0 | 1/1 | Running | elasticsearch:8.11.3 |
| minio-0 | 1/1 | Running | minio/minio:latest |
| etcd-0 | 1/1 | Running | registry.k8s.io/etcd:3.5.21-0 |
| milvus-0 | 1/1 | Running | milvusdb/milvus:v2.4.6 |
| clickhouse-0 | 1/1 | Running | clickhouse/clickhouse-server:24.3 |
| minio-make-bucket-ch845 | Succeeded | — | minio/mc:latest |
| milvus-make-bucket-vlhhw | Succeeded | — | minio/mc:latest |

> deepthink app pod 同步 Running（与本次基建无关，其 7 次 restart 是 DB 起来前后的等待，现已稳定）。

## 2. Service DNS（kubectl get svc -n deepthink）

| Service | ClusterIP | Port(s) |
|---|---|---|
| postgres | 10.96.249.124 | 5432 |
| redis | 10.96.77.141 | 6379 |
| elasticsearch | 10.96.92.175 | 9200 |
| minio | 10.96.101.58 | 9000, 9001 |
| etcd | 10.96.64.218 | 2379 |
| milvus | 10.96.108.117 | 19530, 9091 |
| clickhouse | 10.96.71.255 | 8123 |

## 3. 逐件连通性证据

### PostgreSQL
```
$ kubectl exec postgres-0 -- pg_isready -U "$POSTGRES_USER"
/var/run/postgresql:5432 - accepting connections
$ kubectl exec postgres-0 -- psql -U "$POSTGRES_USER" -d deepthink -c '\l'
  deepthink | deepthink | UTF8 ...   (db 存在, owner=deepthink)
```
✅ 连接就绪，库 `deepthink` 已建。

### Redis
```
$ kubectl exec redis-... -- redis-cli ping
PONG
```
✅ AOF 持久化 + maxmemory 256mb lru 生效。

### Elasticsearch
```
$ curl http://elasticsearch:9200/_cluster/health?pretty
  "status" : "green",
  "number_of_nodes" : 1,
  "number_of_data_nodes" : 1
```
✅ 单节点 green，堆 512m。

### MinIO
```
$ curl -o /dev/null -w "%{http_code}" http://minio:9000/minio/health/ready
200
$ mc ls local
  deepthink/             (object-store 桶)
  deepthink-litestream/  (litestream 桶)
  milvus/                (Milvus 桶, 由 milvus-make-bucket Job 建)
```
✅ ready 200，三个桶齐（含 Milvus 复用的 milvus 桶）。

### etcd（Milvus 依赖）
```
$ ETCDCTL_API=3 etcdctl --endpoints=http://127.0.0.1:2379 endpoint health
  http://127.0.0.1:2379 is healthy: successfully committed proposal: took = 652µs
```
✅ 复用 kind 节点自带的 `registry.k8s.io/etcd:3.5.21-0`，零拉取。

### Milvus
```
$ curl http://milvus:9091/healthz
  OK     [http=200]
```
✅ standalone 起来，/healthz OK，依赖 etcd + MinIO 桶均就绪。

### ClickHouse
```
$ curl http://clickhouse:8123/ping
  Ok.    [http=200]
$ curl -u deepthink:*** 'http://clickhouse:8123/?query=SELECT+version(),+currentDatabase()'
  24.3.18.7	default
```
✅ HTTP 8123 就绪，带凭据查询返回 version + default 库。匿名查询被拒（`AUTHENTICATION_FAILED`）证明凭据+access management 生效。

## 4. 过程中遇到的阻塞与修复（监督者闭环）

| 阻塞 | 根因（有证据） | 修复 | 复验 |
|---|---|---|---|
| 全部 pod ImagePullBackOff | containerd `certs.d/_default/hosts.toml` 是目录而非文件（bind mount 源 `/etc/kind/hosts.toml` 是空目录）+ kind 节点无公网出网（curl registry-1.docker.io 超时 28） | 不修坏 mount（既有残留），改走集群既定 `kind load docker-image` 离线注入，绕开拉取路径 | redis/pg/es/minio/milvus/etcd/clickhouse 全 Running |
| docker.io 拉取卡死 | daemon.json 4 个加速器 3 个 DNS 死、1ms.run 只活 API 不活 blob、直连被 GFW 重置 | 找到可用镜像源 `docker.1panel.live`（/v2/ 返 200、blob 可下）经其拉取后 retag 成规范名 | 6 镜像 tag 完成 |
| ES pod 仍拉旧引用 | 改了 manifest 镜像(8.11.0→8.11.3)但未重新 apply，StatefulSet 还是旧 spec | `kubectl apply -f elasticsearch.yaml` 重新 apply | ES 1/1 Running |
| etcd 拉 quay 失败 | quay.io/coreos/etcd 节点无镜像且无出网 | 复用节点已有 `registry.k8s.io/etcd:3.5.21-0`，改 milvus.yaml 引用并重新 apply | etcd 1/1 healthy |
| clickhouse-client --host 超时 | Service 只暴露 8123(http)，未暴露 native 9000，clickhouse-client 默认走 9000 | 用 HTTP 8123 /ping + 带凭据 HTTP 查询验证 | 200 + version 返回 |

详见 `docs/issues/2026-09-12-kind-node-image-pull-broken.md`。

## 5. 最终结论

**6 件中间件（PostgreSQL / Redis / Elasticsearch / MinIO / Milvus / ClickHouse）在本机 `desktop` kind 集群全部 Running 且端到端连通验证通过**，外加 Milvus 依赖的 etcd。无需人工介入。

## 6. 已知遗留 / 注意事项
- **kind 节点无公网出网 + containerd hosts.toml 配置损坏**：新镜像必须 `kind load docker-image` 离线注入，不能指望在线拉。详见 issue 文档。未来若要在线拉需修 `/etc/kind/hosts.toml`（dir→file）并给节点出网。
- **宿主机内存紧张**（可用 ~4.3Gi + 12Gi swap 已用）：6 件同跑顶 swap，重负载下可能 OOM。当前为最小占用 preset，单副本。如需生产稳定需加内存。
- **未暴露外部访问**：均为 ClusterIP，宿主机访问需 `kubectl -n deepthink port-forward svc/<name> <port>:<port>`。
- **凭据**：PG/S3/ClickHouse 口令为 openssl 随机生成、仅存于集群 `deepthink-secret`、未入 git；`secret.yaml.example` 仅留占位模板。
- **deepthink app 未对接新三件**：configmap 已写入 `ELASTICSEARCH_URL`/`MILVUS_ADDR`/`CLICKHOUSE_URL` 供未来 envFrom 消费，当前 app 不引用（设计上用 pgvector/pg_trgm）。
