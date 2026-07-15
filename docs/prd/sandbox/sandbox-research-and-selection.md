# Sandbox 模块技术调研与选型结论

> 版本：v1.0 · 日期：2026-07-16
> 关联文档：
> - 实现细节见 [`sandbox-technical-solution.md`](./sandbox-technical-solution.md)
> - 隔离方案深度对比见 [`sandbox-isolation-comparison.md`](./sandbox-isolation-comparison.md)
> 本文回答两个核心问题：**①这些技术都开源免费吗？②Docker 方案和 Firecracker 方案落地各自有什么环境/外部依赖？**

---

## 1. 开源免费情况调研

### 结论先行
**全部技术栈开源免费**，唯一需警惕的是 Docker Desktop 的企业商用条款。生产部署在 Linux 服务器上用 `docker-ce` 或 `containerd`，零授权费。

### 许可证清单

| 技术 | 许可证 | 费用 | 注意点 |
|------|--------|------|--------|
| Docker Engine (Moby) | Apache 2.0 | 免费 | 容器运行时本体，Linux 装 `docker-ce` 包，完全免费 |
| Docker Desktop | 自定义 EULA | **有条件免费** | ⚠️ 企业（**员工 >250 人 或 年收入 >$10M**）商用需付费订阅（~$24/人/月） |
| containerd / nerdctl | Apache 2.0 | 免费 | Docker 的底层，完全免费，无企业限制 |
| Podman | Apache 2.0 | 免费 | Red Hat 出品，**无任何企业限制**，可替代 Docker CLI |
| seccomp / cgroups v2 | Linux 内核 (GPL) | 免费 | 内核自带 |
| Firecracker | Apache 2.0 | 免费 | AWS 主导，自托管完全免费 |
| KVM | Linux 内核 (GPL) | 免费 | 硬件虚拟化，内核自带 |
| gVisor (runsc) | Apache 2.0 | 免费 | Google 出品 |
| 运行时镜像 (Python/Node/numpy) | 各自开源协议 | 免费 | PSF / Node.js / BSD 等 |

### 关键判断

- **本地开发**：小团队用 Docker Desktop 不触发收费线（macOS/Windows）。
- **生产部署**：装在 Linux 服务器上的 `docker-ce` 或 `containerd` **零授权费**，无企业规模限制。
- **企业超线规避**：若公司规模超 Docker Desktop 收费线，生产用 `containerd`/`Podman` 即可，永久免费。
- **Firecracker**：自托管完全免费，只在云上选实例时要付裸金属/嵌套虚拟化实例的钱（那是基础设施成本，不是软件授权）。

---

## 2. 环境依赖对比（落地分水岭）

### 2.1 方案 A：Docker + seccomp + cgroups —— 依赖极轻

| 依赖项 | 要求 | 备注 |
|--------|------|------|
| 操作系统 | Linux（x86_64 / ARM64） | seccomp + cgroups v2 是 Linux 内核特性 |
| 内核版本 | ≥ 4.18（cgroups v2 稳定建议 ≥ 5.4） | 查 `grep cgroup /proc/filesystems` |
| 硬件 | **无特殊要求** | 普通 VPS 即可，**不需要虚拟化扩展** |
| 软件 | `docker-ce` 或 `containerd` | `apt install docker.io` 一行装好 |
| 特殊硬件 | ❌ 不需要 | 最大优势 |

- **本地开发**：macOS / Windows 上用 Docker Desktop 可跑（内部起 Linux VM），功能基本等价。
- **生产部署**：任意普通 Linux 服务器（2C4G 起步），云上最便宜的共享型实例即可。

### 2.2 方案 B：Firecracker —— 依赖重，关键卡在 KVM

| 依赖项 | 要求 | 备注 |
|--------|------|------|
| 操作系统 | Linux（x86_64 / aarch64） | ❌ **macOS / Windows 无法本地跑**（无 KVM） |
| 内核版本 | ≥ 4.14（建议 ≥ 5.10） | |
| **`/dev/kvm`** | **必须有** | 🔴 最关键依赖，见 §2.3 |
| Firecracker 二进制 | 1 个可执行文件 | 官方 release 下载，静态编译，无依赖库 |
| Jailer（可选） | 同上 | chroot + cgroups 隔离 VMM 进程 |
| rootfs | 自制 ext4 镜像 | `debootstrap` 或 `docker export` 生成 |
| Guest 内核镜像 | 精简内核 | AWS 提供或自编译 |
| 网络组件 | tap 设备 + 网桥 | 即使默认禁网，基础设施也要配 |

### 2.3 `/dev/kvm` 可得性矩阵（Firecracker 落地最大门槛）

| 运行环境 | 有 KVM | 能跑 Firecracker |
|----------|--------|------------------|
| 物理服务器 / 自建机房 | ✅ | ✅ 直接可用 |
| AWS EC2 普通实例 | ❌ | ❌ 无 |
| AWS EC2 `.metal` 裸金属实例 | ✅ | ✅ 可用（贵） |
| GCP VM | ✅ | ✅ 需启用 nested virtualization flag |
| Azure Dv3/Ev3 系列 | ✅ | ✅ 支持嵌套虚拟化 |
| 阿里云 / 腾讯云 普通 ECS | ❌ | ❌ 需选裸金属实例 |
| macOS 本地 | ❌ | ❌ 无 KVM |
| Docker Desktop 内的容器 | ❌ | ❌ 不能在容器里套 Firecracker |
| 普通 K8s Pod（非特权） | ❌ | ❌ 需特权 Pod + 节点暴露 `/dev/kvm` |

### 2.4 Firecracker 额外需自制的东西（Docker 方案没有）

1. **rootfs 镜像**：Firecracker 不认 Dockerfile，手工做 ext4：
   ```bash
   debootstrap --variant=minbase bookworm rootfs/
   mke2fs -d rootfs -t ext4 rootfs.ext4 1G
   ```
2. **Guest 内核**：AWS microVM kernel 或自裁一个
3. **网络栈**：即使禁网也需建 tap 设备（`ip tuntap add fc_tap0`），未来联网接网桥
4. **snapshot 管理**：冷启动快靠 snapshot，但快照文件生命周期、内存占用需自管

---

## 3. 落地成本对比总表

| 维度 | Docker 方案 | Firecracker 方案 |
|------|------------|------------------|
| 许可证 | 免费（注意 Desktop 企业线） | 完全免费 |
| 硬件要求 | 无特殊要求 | **必须 KVM** |
| 本地 macOS 开发 | ✅ 可跑 | ❌ 跑不了 |
| 最便宜的云实例 | 任意共享型 VPS | GCP 嵌套虚拟化 / AWS 裸金属（贵） |
| 从零到能跑 | 1 人天 | 1–2 周 |
| 需自制的东西 | 无（Dockerfile 即可） | rootfs + Guest 内核 + 网络栈 |
| 额外依赖 | 仅 docker/containerd | KVM + tap + 自制镜像 |

---

## 4. 选型结论

### 4.1 最终选型：P0 用 Docker + seccomp + cgroups，Firecracker 留作 P2 升级目标

**理由（结合从 0 起步 + macOS 本地 + 业务未验证三重约束）**：

1. **环境约束决定**：当前 macOS 本地**无法跑 Firecracker**（无 KVM），本地开发只能走 Docker。这是环境硬约束，不是偏好。
2. **Simplicity First**：业务价值未验证前，Firecracker 的 rootfs/网络/snapshot 运维负担是纯负债。
3. **成本可控**：Docker 方案任意便宜 VPS 即可投产，Firecracker 需采购裸金属/嵌套虚拟化实例，成本高一个量级。
4. **升级路径已留好**：P0 方案已把「隔离后端」抽象成接口，未来切 Firecracker 时上层调度与协议不变。

### 4.2 分阶段落地路线

| 阶段 | 方案 | 触发条件 | 部署环境 |
|------|------|---------|---------|
| **P0** | Docker + seccomp + cgroups + warm pool | 立即 | macOS 本地开发 + 普通 Linux VPS 生产 |
| **P1** | 加配额 + 审计 + Prometheus | P0 稳定后 | 同 P0 |
| **P2** | 切 gVisor（`--runtime=runsc`）或 Firecracker | 威胁升级 / 合规要求 | gVisor 同 P0 环境；Firecracker 需 GCP 嵌套虚拟化或 AWS 裸金属 |
| **P3** | Firecracker snapshot restore | 高频短任务、冷启动成瓶颈 | 同 P2 的 Firecracker 环境 |

### 4.3 触发升级到 Firecracker 的硬指标（出现任一即启动 P2）

- [ ] 代码来源从「内部」扩展到「外部用户任意提交」
- [ ] 出现安全审计要求硬件级隔离（金融/医疗/等保）
- [ ] 冷启动 p95 超过交互容忍阈值（如 > 1s）
- [ ] 单租户密度下 Docker 实例内存开销成瓶颈

### 4.4 生产部署实例选型指引（未来上 Firecracker 时）

| 云厂商 | 推荐实例 | 说明 |
|--------|---------|------|
| **GCP** | N1/N2 + nested virtualization flag | 性价比最优，启用嵌套虚拟化即可跑 Firecracker |
| **AWS** | `.metal` 裸金属实例 | 贵，但原生支持 KVM |
| **Azure** | Dv3/Ev3 系列 | 支持嵌套虚拟化 |
| **自建/物理机** | 任意 x86_64 服务器 | 成本最低，直接有 KVM |

### 4.5 一句话结论

> **从 0 落地，用 Docker + seccomp + cgroups + warm pool 跑通 P0——零授权费、本地能开发、便宜 VPS 能投产。Firecracker 不是 P0 该碰的：macOS 跑不了、云上要裸金属、运维要 1–2 周，那是威胁模型升级 + 合规要求触发后的 P2 升级目标。**

---

## 5. 产物索引

| 文档 | 内容 |
|------|------|
| [`sandbox-technical-solution.md`](./sandbox-technical-solution.md) | P0 可落地实现（Dockerfile + seccomp + 代码骨架 + 测试） |
| [`sandbox-isolation-comparison.md`](./sandbox-isolation-comparison.md) | Firecracker vs Docker 深度对比（隔离原理/攻击面/性能/决策矩阵） |
| **本文** | 开源调研 + 环境依赖 + 选型结论 |
