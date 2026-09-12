# 2026-09-12 · kind 节点所有镜像拉取失败 (ImagePullBackOff)

## 1. 用户现象
在 `desktop` kind 集群的 `deepthink` namespace apply 中间件 manifest（postgres/redis/minio/elasticsearch/milvus/clickhouse）后，全部 pod 长时间停在 `ImagePullBackOff` / `ErrImagePull`，无一 Running。早已在跑的 deepthink app pod 看似正常（93m Running），让人误以为集群可用。

## 2. 问题描述
新创建的工作负载无法获得容器镜像。kubelet 报：
```
failed to pull image "docker.io/minio/minio:latest": failed to resolve reference "docker.io/minio/minio:latest":
read /etc/containerd/certs.d/_default/hosts.toml: is a directory
```
所有走 containerd 拉取路径的镜像都命中同一错误。deepthink app 不受影响是因为它的镜像早在 9月4日通过 `kind load docker-image` 离线注入节点，`imagePullPolicy: IfNotPresent` 命中本地缓存、根本没走拉取路径。

## 3. 根因
两层叠加，任一层都足以让在线拉取失败：

**层 1 — containerd 镜像仓库配置损坏（文件/目录混淆）**
- 节点 containerd `config_path = "/etc/containerd/certs.d"`，对每个 registry 读取 `<registry>/hosts.toml`，`_default` 是兜底。
- 节点内 `/etc/containerd/certs.d/_default/hosts.toml` 是一个**目录**而非文件。containerd 期望它是文件 → `read ... is a directory` → 引用解析失败。
- 该路径是只读 bind mount，源是宿主机 `/etc/kind/hosts.toml`——而**宿主机 `/etc/kind/hosts.toml` 本身是个空目录**（被误当文件挂载）。`docker inspect desktop-worker` 显示：
  ```
  /etc/kind/hosts.toml -> /etc/containerd/certs.d/_default/hosts.toml  (ro)
  ```
- 宿主机端 `file /etc/kind/hosts.toml` → `directory`；`ls` → 空。即：曾有人把一个目录路径 bind 进了 containerd 期望是文件的位置。

**层 2 — kind 节点无公网出网**
- `docker exec desktop-worker curl --max-time 15 https://registry-1.docker.io/v2/` → `Connection timed out (28)`。
- kind 节点在 docker bridge 网络上，没有到公网 registry 的 NAT/路由。即便修好层 1，在线拉取仍超时。

**结论**：本集群从设计上就**不依赖在线拉取**，靠 `kind load docker-image` 离线注入（`/tmp/kindload-*.log` 一堆历史日志为证：pgvector/redis/minio/mc/litestream/deepthink-server 都 side-load 过）。层 1 的坏 mount 是既存残留，被离线注入路径绕开，平时不暴露。

## 4. 复现路径
1. 在 `desktop` 集群 apply 任一引用公网镜像的 manifest，例如：
   `kubectl apply -f deploy/k8s/redis.yaml`
2. `kubectl get pods -n deepthink -w` → redis pod 30s 内进入 `ImagePullBackOff`。
3. `kubectl describe pod redis-... | tail -20` → 见 `read /etc/containerd/certs.d/_default/hosts.toml: is a directory`。

## 5. 诊断方法
```bash
# 集群名是 desktop，kind 只在 default docker context 下能看到
export DOCKER_CONTEXT=default
kind get clusters                      # 应输出 desktop

# 节点内看坏掉的 hosts.toml
docker --context default exec desktop-worker sh -c \
  'ls -la /etc/containerd/certs.d/_default/; findmnt /etc/containerd/certs.d/_default/hosts.toml'

# 宿主机看挂载源（应为目录）
ls -la /etc/kind/ ; file /etc/kind/hosts.toml

# 看是谁把它挂进去的（mount 来源）
docker --context default inspect desktop-worker \
  --format '{{range .Mounts}}{{.Source}} -> {{.Destination}}{{"\n"}}{{end}}' | grep hosts.toml

# 验证节点无公网出网
docker --context default exec desktop-worker \
  curl -sS -o /dev/null -w "%{http_code}\n" --max-time 15 https://registry-1.docker.io/v2/
# 期望: 000 + 超时

# 确认本集群既定注入方式
ls /tmp/kindload-*.log
```

## 6. 修复方案
**不修层 1 的坏 mount（Surgical Changes：既有残留、与本次任务无关，且离线注入路径天然绕开它）。改走集群既定的离线注入路径——宿主机有公网，kind 节点没有。**

```bash
# 宿主机拉镜像（default context 有出网）
docker --context default pull redis:7-alpine
# …其余镜像同理

# 注入 desktop 集群（kind 只认 default context）
DOCKER_CONTEXT=default kind load docker-image redis:7-alpine --name desktop
```

pod `imagePullPolicy: IfNotPresent` 命中本地缓存 → 不走拉取路径 → 不碰坏 hosts.toml → 正常启动。

如未来要让本集群支持在线拉取（独立改进项，非本次任务范围），需两步都修：
1. 宿主机 `rm -rf /etc/kind/hosts.toml && install /dev/null /etc/kind/hosts.toml`（把空目录改成空文件）+ 重建 kind 集群让 mount 生效；或在 kind 配置里去掉这个 `extraMounts`。
2. 给 kind 节点配公网出网（host networking / 代理 / 国内 registry mirror）。

选型理由：离线注入是本集群历史既定、零网络依赖、最稳；改 mount 重建集群会丢 deepthink app 运行态，得不偿失。

## 7. 处理卡住的状态
已 apply 但卡在 ImagePullBackOff 的 pod 无需手动删，`kind load` 完成后 kubelet 会在下一次 backoff 重试时命中本地镜像自动恢复。若想立即重试：
```bash
kubectl delete pod -n deepthink -l app.kubernetes.io/name=redis     # 重建即拉
# 或推所有卡住的
kubectl delete pod -n deepthink $(kubectl get pods -n deepthink -o name | tr '/' ' ' | awk '{print $2}')
```

## 8. 经验沉淀 / 预防
- **kind 集群名未必叫 kind**：本机叫 `desktop`，且只在 `default` docker context 下可见。操作 kind 前先 `DOCKER_CONTEXT=default kind get clusters`。
- **新集群"能用"是假象**：deepthink app Running 只是旧镜像缓存命中。给集群加新组件前，先 `docker exec <node> curl <registry>` 验出网，或直接 `kind load` 一张测试镜像确认注入路径。
- **`/etc/kind/hosts.toml` 必须是文件**：若再有人配置 registry mirror，别 `mkdir -p` 这个路径，要 `cat > /etc/kind/hosts.toml`。
- **巡检脚本**：可在部署前跑
  ```bash
  docker --context default exec desktop-worker sh -c \
    'test -f /etc/containerd/certs.d/_default/hosts.toml && echo OK || echo "hosts.toml-not-a-file"'
  ```
  返回非 OK 则离线注入，别指望在线拉。
- **告警建议**：任何 `ImagePullBackOff` 且事件里含 `hosts.toml: is a directory`，立即归因为容器运行时配置损坏，不要去查 manifest。
```
