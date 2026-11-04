# DeepThink Android 端上部署手册

> 让 DeepThink **跑在你的手机里**：不需要自建/远程 server URL，对话、文件、记忆、
> 定时任务等平台能力全部端上自治（Agent 推理仍走云端 LLM API——"不连 server" ≠ 离线）。

- 架构：Termux 运行 DeepThink 后端（Node 服务，本机 127.0.0.1）+ DeepThink App（WebView 壳）自动发现并连接本机服务。
- 支持范围：**arm64（aarch64）Android 8+**；约需 **3GB 可用存储**（安装后占用 ~2GB）。
- 已知降级（依赖 Docker，Android 无 Docker）：沙箱代码执行、浏览器自动化、Web 终端。
  其余功能（对话/流式/文件/记忆/Skills/定时任务/IM/多 Agent 编排）完整。

---

## 1. 前置条件

| 项 | 要求 |
|---|---|
| 手机 | arm64（`uname -m` = `aarch64`），Android 8+，推荐 8GB RAM 旗舰机 |
| 存储 | 可用空间 ≥ 3GB |
| 网络 | 安装时需联网（npm 拉依赖 + claude CLI 二进制）；日常使用仅 LLM API 需要联网 |
| Termux | [F-Droid 或 GitHub 版](https://github.com/termux/termux-app#installation)（**不要**用 Google Play 版，已停更） |
| Claude 账号 | Claude 订阅或 API key（与桌面版一致的 provider 配置） |

## 2. 获取运行时 payload

两种方式任选：

**A. 从开发机自建**（仓库内）：

```bash
make build          # 编译后端 + 前端 + agent-runner
make android-payload
# 产物：dist-android/deepthink-android-payload-<version>.tar.gz + .sha256
```

**B. 使用发布产物**：从项目发布页下载同名 `.tar.gz` 与 `.sha256`。

把这两个文件传到手机（`/sdcard/Download/` 或任意 Termux 可访问目录）。
传入 Termux 后可用 `sha256sum -c` 校验完整性。

## 3. Termux 内安装

打开 Termux：

```bash
pkg install -y wget tar        # 基础工具（如缺失）
# 把 payload 放到 ~/（示例：从 /sdcard/Download 复制）
cp /sdcard/Download/deepthink-android-payload-*.tar.gz ~/
mkdir -p ~/deepthink
tar -xzf ~/deepthink-android-payload-*.tar.gz -C ~/deepthink --strip-components=1
bash ~/deepthink/termux/install.sh
```

安装脚本会自动完成：系统依赖（nodejs/clang/make/python/git + glibc 兼容层）→
npm 依赖安装（含 better-sqlite3 设备端编译，首次约 5–15 分钟）→ claude CLI glibc
兼容处理（patchelf）→ 启动脚本与环境生成 → 自检汇总。

> **国内网络**：npm 过慢可先执行
> `npm config set registry https://registry.npmmirror.com` 再重跑 `install.sh`（幂等）。

## 4. 启动服务

```bash
bash ~/deepthink/termux/start.sh     # 启动（默认端口 9898）
bash ~/deepthink/termux/status.sh    # 查看状态 / 健康检查 / 日志尾部
bash ~/deepthink/termux/stop.sh      # 停止
```

`start.sh` 成功后打印 `http://127.0.0.1:9898`。换端口：

```bash
WEB_PORT=9900 bash ~/deepthink/termux/start.sh
```

> **保持后台运行**：锁屏/切后台时 Termux 可能被系统休眠中断。脚本会自动持
> `termux-wake-lock`；建议同时在系统设置里对 Termux **关闭电池优化**，并用
> Termux 通知栏的 "Acquired wake lock" 状态确认常驻。

## 5. 安装 DeepThink App 并使用

1. 安装 `app-release.apk`（开发机构建产物 `android/app/build/outputs/apk/release/`，
   或发布页下载；release 默认以 debug keystore 签名，企业分发可换自有签名，见 §8）。
2. 打开 App —— **无需填写任何 URL**：自动探测本机服务（9898，及 9890–9900 区间）并进入界面。
3. 服务未启动时会显示引导页：按提示在 Termux 运行 `start.sh`，点「重新探测」即可。
4. 本地模式顶部会显示一次性降级提示条（沙箱/浏览器/终端不可用），可关闭。
5. 要连接远程部署的 DeepThink：菜单 → 设置 → 远程模式 → 填服务器地址（兼容旧壳能力）。

## 6. 故障排查

| 症状 | 原因 | 处理 |
|---|---|---|
| `install.sh` 报 "better-sqlite3 编译失败" | clang/make/python 缺失或编译内存不足 | `pkg install clang make python` 后 `cd ~/deepthink && npm rebuild better-sqlite3` |
| 自检显示 "claude CLI (glibc) ⚠️" | patchelf 未执行 / 机型 seccomp 不兼容 | 先 `npm rebuild @anthropic-ai/claude-code` 重跑 install.sh；仍失败且日志含 `Bad system call` → 该机型暂不支持（Android 8/10 部分机型已知问题），见发布页说明 |
| `start.sh` 60s 健康检查不过 | 端口占用 / 首次初始化慢 | `bash ~/deepthink/termux/status.sh` 看日志尾部；换端口 `WEB_PORT=9900 ...` 重试 |
| App 一直"正在探测" | 服务未启动 / 端口不在探测区间 | 先 `status.sh` 确认服务在跑；App 设置里改端口或开区间扫描 |
| 用一会儿后无响应 | Termux 被休眠 | 确认 wake-lock 持有 + 关闭 Termux 电池优化；重开 `start.sh`（数据不丢） |
| npm install 极慢/失败 | 网络 | `npm config set registry https://registry.npmmirror.com` 后重跑 `install.sh` |
| "spawn Unknown system error -8" | claude CLI 是 postinstall 占位 stub | `cd ~/deepthink/agent-runner && npm rebuild @anthropic-ai/claude-code`，重跑 `install.sh` |

## 7. 卸载 / 重装

```bash
bash ~/deepthink/termux/stop.sh
rm -rf ~/deepthink ~/.deepthink        # 连数据一起删（对话/记忆/文件）
# 只升级代码、保留数据：删 ~/deepthink 后重跑第 3 步（install.sh 幂等，不动 ~/.deepthink/data）
```

App 直接系统卸载即可。

## 8. 安全须知

- 全部数据（对话/文件/记忆/API 配置）都在 **Termux 应用私有目录**（`~/.deepthink`），
  不写共享存储、不云同步；App `allowBackup=false`。
- Claude API 凭据存在 `~/.deepthink/data/env`（与桌面版同一机制）。**手机丢失即凭据丢失**：
  建议在 Anthropic Console 配置用量告警与独立 API key，便于随时吊销。
- release APK 默认 debug keystore 签名（方便侧载试用）；企业正式分发请以自有 keystore 重签：
  ```bash
  cd android && ./gradlew :app:assembleRelease \
    -Pandroid.injected.signing.store.file=/path/to/release.jks \
    -Pandroid.injected.signing.store.password=*** \
    -Pandroid.injected.signing.key.alias=*** \
    -Pandroid.injected.signing.key.password=***
  ```
- 本形态为企业侧载/自有渠道分发设计；上架 Google Play 不可行（打包执行代码违反其政策）。

## 9. 目录速查

| 路径（Termux 内） | 内容 |
|---|---|
| `~/deepthink/` | 代码资产（backend / web-dist / agent-runner / config / termux） |
| `~/deepthink/.env.sh` | 运行环境（端口、数据目录等，start.sh 自动加载） |
| `~/.deepthink/data/` | 运行时数据（SQLite / 群组 / IPC / 密钥） |
| `~/.deepthink/logs/backend.log` | 后端日志 |
| `~/.deepthink/backend.pid` | 运行中进程 pid |

## 10. 构建 Android App（开发）

```bash
cd android
JAVA_HOME="<Android Studio JBR 路径>" ./gradlew :app:test            # JVM 单测
JAVA_HOME="<Android Studio JBR 路径>" ./gradlew :app:assembleRelease  # 产出 APK
```

工具链：Gradle 9.8.x（wrapper 已含）+ AGP 9.5.x（Kotlin 支持内置）+ JDK 17+。
源码在 `android/app/src/main/java/com/aigeniusinstitute/deepthink/`：
`MainActivity`（WebView + 发现状态机）、`ServerDiscovery`（探测逻辑）、
`ServerUrl`（URL 规范化）、`SettingsActivity`（本地/远程设置）、`Http`/`Prefs`。
