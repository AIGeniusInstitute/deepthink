# Git 多远程使用说明

本项目同时推送至两个远程仓库，保持双仓库镜像同步。

## 1. 远程仓库配置

| 名称 | 地址 | 用途 |
|------|------|------|
| `origin` (fetch) | `git@gitcode.com:AIGeniusInstitute/deepthink.git` | 默认拉取源（GitCode） |
| `origin` (push)  | `git@gitcode.com:AIGeniusInstitute/deepthink.git` | 默认推送目标之一（GitCode） |
| `origin` (push)  | `git@github.com:AIGeniusInstitute/deepthink.git` | 默认推送目标之二（GitHub） |
| `github`         | `git@github.com:AIGeniusInstitute/deepthink.git` | 独立的 GitHub 远程（fetch + push） |

`origin` 在 fetch 上只指向 GitCode，在 push 上同时指向 GitCode 和 GitHub。这样：

- `git fetch` / `git pull` 默认从 GitCode 拉取（单一拉取源，避免双远程 fetch 歧义）。
- `git push` 一条命令同时推送到 GitCode + GitHub，两个仓库自动保持镜像。

查看当前配置：

```bash
git remote -v
git config --get-all remote.origin.pushurl
```

## 2. 日常推送 / 拉取

```bash
# 同时推送到 GitCode + GitHub（最常用）
git push origin main
# 或者（当前分支上游已设为 origin/main 时）
git push

# 从 GitCode 拉取
git pull
# 或显式
git fetch origin
```

## 3. 只推 / 只拉某一个远程

当某个远程网络异常、或只想同步其中一个时，直接用远程名绕开多 pushurl 的 `origin`：

```bash
# 只推 GitCode
git push gitcode main        # 但 gitcode 不是已注册的 remote 名，用 origin 的 fetch URL 推
# 实际做法：origin 的第一条 pushurl 就是 GitCode，无法单独推其中一条。
# 因此单独推送时请用 gitcode 的 URL：
git push git@gitcode.com:AIGeniusInstitute/deepthink.git main

# 只推 GitHub
git push github main

# 只从 GitHub 拉取
git fetch github
```

> 说明：`origin` 的 pushurl 配置成两条后，`git push origin` 会向两条 URL 都推送，**无法**通过 `origin` 只推其中一个。要单独推 GitCode，用上面显式 URL 的方式，或临时删掉 github 那条 pushurl（见 §5）。

## 4. 验证双仓库一致性

```bash
# 三方 HEAD 应完全一致
echo "本地:        $(git rev-parse main)"
echo "GitCode:     $(git rev-parse origin/main)"
echo "GitHub:      $(git rev-parse github/main)"
```

## 5. 临时调整 push 目标

如果只想暂时推一个远程，可临时增删 pushurl，操作完再恢复：

```bash
# 暂时只推 GitHub：删掉 GitCode 那条 pushurl
git remote set-url --delete --push origin git@gitcode.com:AIGeniusInstitute/deepthink.git

# 恢复双推：加回 GitCode pushurl
git remote set-url --add --push origin git@gitcode.com:AIGeniusInstitute/deepthink.git
```

## 6. 历史背景：GitHub 仓库的强制覆盖

GitHub 仓库 `AIGeniusInstitute/deepthink` 最初并非空仓库，而是包含一段与本项目主线**无共同祖先**的旧历史（约 70 个提交，包含 `init`、`删除目录下的源码`、`git tag v1.0.3` 等残留提交）。

为让 GitHub 镜像当前主线，执行过一次：

```bash
git push github main --force
```

该操作**永久删除**了 GitHub 上原有的那段无关历史，用本地主线替换。本地 reflog 仍保留旧提交记录，但 GitHub 远端不可恢复。此后 GitHub 与本地 / GitCode 保持一致，正常 fast-forward 推送即可，**无需再次 force push**。

## 7. 常见问题

**Q: `git push` 报 "non-fast-forward" 但我确认本地是最新的？**
A: 检查是不是 GitHub 被别人直接改过。先 `git fetch github` 对比 `github/main` 与本地：

```bash
git rev-list --left-right --count main...github/main
# 输出格式：<本地领先 github 的数量> <github 领先本地的数量>
```

若右侧 > 0，说明 GitHub 上有本地没有的提交，需要 merge/rebase 或确认是否要再次 force push（force push 前务必与团队确认）。

**Q: 推送时一个远程成功一个失败怎么办？**
A: Git 会按 pushurl 顺序逐个推送，失败的远程会报错但已成功的不会回滚。针对失败的远程单独补推即可：

```bash
git push github main   # 单独补推 GitHub
```

**Q: 推送很慢？**
A: 双推送意味着每次 push 都要上传到两个仓库。本项目完整历史约 66 MB，首次或大改动后推送耗时较长属正常现象；增量推送通常很快。
