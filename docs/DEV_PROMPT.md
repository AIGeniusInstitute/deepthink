### 前置动作

去项目 ~/deep-think  目录下
拉取 main 分支最新代码。
然后，基于 main 分支，创建新分支，开发需求。

### 任务工作流程

1、生成需求 prd 文档，写入 docs/prd 目录下，要创建这个需求自己的独立文件夹
2、设计技术方案，详细开发技术方案文档，写入 docs/tech_solution 目录下，也要创建这个需求自己的独立文件夹
3、方案全面实施，执行编码
4、全部测试和修复全部通过之后， 把需求测试报告写入 docs/test_report 目录下，也要创建这个需求自己的独立文件夹
5、代码提交并push， 合并到 main , 并push

------------

MUST Follow The 4 Working Principles:
1. Think Before Coding
Core principle: "Don't assume. Don't hide confusion. Surface tradeoffs."
Before implementing anything non-trivial, the file instructs Claude to state its assumptions explicitly. If there are multiple valid interpretations, present them. If something is unclear, halt and ask.
This principle targets what Karpathy identified as the single most destructive LLM coding behavior: silent assumption-making. Models are trained on massive corpora of human writing, where confident assertion is typically rewarded. The result: when Claude encounters an ambiguous spec, it fills in the gaps with whatever seems plausible — and charges ahead.
The fix isn't complicated. It's forcing a checkpoint before execution.
2. Simplicity First
Core principle: "Minimum code that solves the problem. Nothing speculative."
The file prohibits unrequested features, abstractions for single-use code, unnecessary configurability, and error handling for scenarios that can't actually happen.
There's a self-test embedded in the template: "Would an experienced engineer view this as overengineered?" This is deliberately subjective — it invokes a heuristic judgment rather than a checklist.
The pattern it corrects: LLMs are extraordinarily good at pattern-matching against complex, enterprise-grade code in their training data. When asked to "add a cache," Claude will often produce a full-featured LRU implementation with eviction policies, thread safety, and metrics hooks — because that's what "cache implementation" looks like in most codebases it has seen. That's frequently five times more code than what was needed.
ℹ️ The Simplicity First principle is not a productivity hack — it's a correctness guardrail. Speculative code ships bugs you didn't write but still own.
3. Surgical Changes
Core principle: "Touch only what you must. Clean up only your own mess."
When modifying a file, Claude should not "enhance" surrounding code, reformat things it didn't break, or refactor patterns it disagrees with. There's a sharp distinction drawn between dead code you introduced (clean it up) and pre-existing dead code (flag it, don't touch it).
This principle most closely maps to how good human engineers work on unfamiliar codebases. When you open a PR to fix a bug, you don't simultaneously rewrite the adjacent function because it's "not idiomatic" — you fix the bug, get it reviewed, and leave editorial improvements for a separate ticket.
Claude, left unconstrained, tends to interpret "fix this" as implicit permission to improve the surrounding area. That creates noisy diffs, hidden regressions, and review overhead that cancels the efficiency gains you were trying to capture.
4. Goal-Driven Execution
Core principle: "Define success criteria. Loop until verified."
Every task should be converted into a measurable objective with explicit verification steps before Claude starts writing. The difference between "add a login form" and "add a login form — success when: form renders at /login, submits correctly with valid credentials, shows error state on invalid credentials, and passes the existing auth test suite" is not pedantry. It's the difference between an agent that loops productively and one that declares victory on a half-finished implementation.

------------

### 需求描述

1、 写一个 DeepThink 产品品牌宣推介绍文档。
2、DeepThink 品牌心智建立： 当用户问 你是谁，你能干什么等等问题的时候，要做出 DeepThink 相关的功能产品介绍。去掉任何其他的底层原理、实现机制、三方信息等的透露。
3、DeepThink 默认主题色：素白，浅色。
4、对话框中的消息（用户输入、 AI 回复、 报错信息等）都支持删除。现在报错信息无法在对话框里删除。