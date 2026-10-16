# 中文关键词检索恒为 0 命中（FTS5 unicode61 + 整句短语匹配）

- 日期：2026-10-16
- 分支：`worktree-feat-knowledge-base`
- 影响版本：`src/db.ts` `initKbChunkFtsSqlite` / `keywordSearchChunks`
- 状态：已修复

## 1. 用户现象

知识库里有中文文档，检索测试台选「关键词」模式搜一个**文档里明明有的词**，结果一条都没有。

英文查询是好的（`ZEBRAFISH_SENTINEL_9X` 能搜到）。用同一个词换成「混合」模式又能搜到——因为混合模式还有向量臂在兜底。所以现象是"关键词这条路对中文完全失效，但整个检索功能看起来还是能用的"。

## 2. 问题描述

分块的关键词检索走 SQLite FTS5 虚拟表 `kb_chunks_fts`。查询词进 `MATCH` 之前只做了一次很粗的规范化，然后**整个查询串被当作一个短语**去匹配：

```ts
const q = `"${query.replace(/"/g, '""')}"`;
db.prepare(`SELECT ... FROM kb_chunks_fts WHERE kb_chunks_fts MATCH ?`).all(q);
```

而 FTS5 建表时用的是 SQLite 默认分词器 `unicode61`。`unicode61` 按 Unicode 类别切词，中日韩表意文字全部属于"字母"类，**一整串没有空格的汉字会被切成一个 token**。

两件事叠加的结果：查询 `沙箱冷启动性能目标是多少` 被当成一个 11 字的 token，要求它在索引里作为**完整的一整段**出现。文档里写的是"冷启动降低到 800 毫秒以内"，这个 token 不存在，命中 0。

更糟的是这个失败是静默的：查不到就是查不到，没有报错、没有降级、日志里也没有痕迹。

## 3. 根因

代码层面，两个独立的原因叠在一起，任修其一都不足以解决：

1. **分词器选错**。`unicode61` 对 CJK 没有意义。SQLite 从 3.34 起提供 `trigram` 分词器，它按 3 字符滑窗建索引，这种切法对 CJK 是有意义的（`沙箱冷`/`箱冷启`/`冷启动`…）。
2. **查询构造方式错**。把整个用户输入引号包起来当短语，等于要求"用户输入必须原样连续出现"。用户在检索框里输入的是一句话，不是文档里的一个片段，这个要求必然落空。

外部依据：

- SQLite FTS5 文档中 `unicode61` 被描述为"适用于 Unicode 6.1 的通用分词"，而 `trigram` 是官方为"支持子串匹配、包括 CJK"提供的分词器（[SQLite FTS5 文档 § Tokenizers](https://www.sqlite.org/fts5.html#tokenizers)）。trigram 要求 MATCH 词项 **≥ 3 字符**，这是它的硬约束，也是本修复必须同时提供降级路径的原因。
- FTS5 中带引号的字符串是 **phrase** 语义，即要求词项按顺序相邻出现（同上文档 § Full-text Query Syntax）。

## 4. 复现路径

```bash
# 建库、上传中文文档（夹具 deepthink-ops.md 里有「权限模型」「冷启动」等词）
# 等 parse_status 变成 ready

echo "--- 修复前：整句 / 裸词 都命中 0 ---"
curl -s -b cookies.txt -X POST http://127.0.0.1:9899/api/paas/knowledge-bases/$KB/search \
  -H 'Content-Type: application/json' \
  -d '{"query":"权限模型","mode":"keyword","debug":true}' | jq '.hits | length, .debug.keyword_candidates'

echo "--- 英文对照：能命中，说明不是整条链路坏了 ---"
curl -s -b cookies.txt -X POST http://127.0.0.1:9899/api/paas/knowledge-bases/$KB/search \
  -H 'Content-Type: application/json' \
  -d '{"query":"ZEBRAFISH_SENTINEL_9X","mode":"keyword","debug":true}' | jq '.hits | length'
```

修复后 `权限模型` 在关键词模式返回 5 条命中。

## 5. 诊断方法

区分"没进索引"和"索引了但查不到"，看 `debug` 里的两路候选数：

```bash
curl -s -b cookies.txt -X POST http://127.0.0.1:9899/api/paas/knowledge-bases/$KB/search \
  -H 'Content-Type: application/json' \
  -d '{"query":"权限模型","mode":"keyword","debug":true}' | jq .debug
```

`keyword_candidates: 0` 说明关键词臂一条都没召回——问题在 FTS 查询本身，不在排序或融合。

直接对索引下探，确认文档确实在里面：

```bash
sqlite3 /tmp/dt-kb-ui/data.db "SELECT count(*) FROM kb_chunks;"
sqlite3 /tmp/dt-kb-ui/data.db "SELECT count(*) FROM kb_chunks_fts WHERE kb_chunks_fts MATCH '权限模型';"
```

第二个查询返回 > 0 而第一个接口返回 0 条，就把范围锁定到"查询构造"而不是"索引内容"。再确认分词器：

```bash
sqlite3 /tmp/dt-kb-ui/data.db \
  "SELECT sql FROM sqlite_master WHERE name='kb_chunks_fts';" | grep -o "tokenize=[^,)]*"
```

输出 `tokenize='trigram'`（修复后）说明分词器已生效。

## 6. 修复方案

两处一起改。

**其一，分词器换成 trigram：**

```diff
+const KB_CHUNK_FTS_TOKENIZER = 'trigram';
+
+// 已存在的表如果还是旧分词器，drop 重建
+const existing = db.prepare(
+  `SELECT sql FROM sqlite_master WHERE type='table' AND name='kb_chunks_fts'`,
+).get() as { sql?: string } | undefined;
+if (existing?.sql && !existing.sql.includes(KB_CHUNK_FTS_TOKENIZER)) {
+  db.exec(`DROP TABLE IF EXISTS kb_chunks_fts;`);
+  // ... 重新 CREATE VIRTUAL TABLE + 三个同步触发器
+}
 db.exec(`
-  CREATE VIRTUAL TABLE IF NOT EXISTS kb_chunks_fts USING fts5(
-    content, heading_path, content='kb_chunks', content_rowid='rowid'
-  );
+  CREATE VIRTUAL TABLE IF NOT EXISTS kb_chunks_fts USING fts5(
+    content, heading_path, content='kb_chunks', content_rowid='rowid',
+    tokenize='${KB_CHUNK_FTS_TOKENIZER}'
+  );
 `);
+db.exec(`INSERT INTO kb_chunks_fts(kb_chunks_fts) VALUES('rebuild');`);
```

**其二，查询改成"拆词项 OR"，并为 < 3 字符准备降级路径：**

```ts
const FTS_TRIGRAM_MIN = 3;
const FTS_MAX_TERMS = 24;

export function buildChunkFtsQuery(query: string): string | null {
  const terms = query
    .split(/[^\p{L}\p{N}_]+/u)          // 按非字母数字切
    .filter((t) => t.length >= FTS_TRIGRAM_MIN)  // trigram 要求 ≥3 字符
    .slice(0, FTS_MAX_TERMS);
  if (terms.length === 0) return null;
  return terms.map((t) => `"${t.replace(/"/g, '""')}"`).join(' OR ');
}
```

`keywordSearchChunks` 的决策链变成：`buildChunkFtsQuery` 返回 `null`（说明查询里没有一个词达到 3 字符）→ 走 LIKE；否则走 FTS `MATCH`，**出错或返回空**也回落到 LIKE。

LIKE 降级用 `instr(c.content, ?) > 0`：

```ts
function likeSearchChunks(kbIds: string[], query: string, limit: number) {
  // instr() 而不是 LIKE：查询里出现 % 或 _ 时不需要转义
  return db.prepare(`
    SELECT ... WHERE c.kb_id IN (...) AND instr(c.content, ?) > 0 LIMIT ?
  `).all(...kbIds, query, limit);
}
```

选型理由：

- **trigram 而不是引入中文分词依赖**：`unicode61` 对 CJK 无效是事实，但要修它就得引入 jieba / ICU 之类的依赖。trigram 是 SQLite 自带分词器、零依赖、对 CJK 的召回行为可预测（就是子串匹配），代价只是索引体积变大、且 MATCH 词项必须 ≥ 3 字符。后者用 LIKE 降级补上，成本远低于新增一个分词器依赖（Simplicity First）。
- **OR 而不是 AND**：关键词臂的职责是"召回"，精确排序交给 RRF 融合和后续排序；用 AND 会让"用户多打一个词"变成"结果全没"，并集才是这一臂该有的语义。
- **重建而非迁移**：`tokenize` 是建表时固定的，无法 ALTER。旧表直接 drop 重建 + `rebuild` 命令，比写一个迁移脚本简单且不会漏。

## 7. 处理卡住的状态

分词器变更需要重建 FTS 表，`initKbChunkFtsSqlite()` 在启动时检测到 `sqlite_master` 里的建表语句不含 `trigram` 就会自动 drop、重建并 `rebuild`。**这是一个启动期自动完成的操作，不需要人工干预**，但要注意：

- 重建期间该表短暂不可用，只影响启动那一刻的查询；
- 索引体积会明显变大（trigram 把每个位置都入了索引），磁盘预算需要相应放宽。

## 8. 经验沉淀 / 预防

- **"能用"掩盖了"一半不能用"**：混合检索有向量臂兜底，所以中文关键词臂全挂这件事在功能演示里看不出来。多路召回的系统里，**每一条路都要单独验证**，不能只验最终结果——最终结果好，可能是因为另一条路在替它扛。
- **静默返空是最贵的失败模式**：FTS 查不到就是查不到，不抛错、不告警。凡是"查不到"属于正常返回的接口，都应该在 debug 里带上"各路过少"的显式计数（本次 `debug.keyword_candidates` 就是这个用途），让"0"变得可见。
- **默认分词器对 CJK 是陷阱**：SQLite FTS5 的默认 `unicode61` 对中文没有分词能力。**新建任何 FTS5 表时，只要内容可能是中文，就必须显式指定 `tokenize`**。建议加一条巡检：`grep -rn "fts5(" src/` 后逐个确认是否有 `tokenize=`。
- **验收必须用目标语言的语料**：此前所有检索测试用的都是英文标记串，中文全链路（分块 → 索引 → 召回 → 引用）从来没有被真正跑过。**测试夹具的语言要和用户的语言一致**，否则测的是一个用户永远不会用的系统。
- **已知边界（不是缺陷，需要文档化）**：关键词臂是**子串/短语**语义。中文整句（如"沙箱冷启动的目标是多少？"）在纯关键词模式下不命中，因为这句话不是文档里的连续子串；混合模式（默认）由向量臂负责这类查询。这一点应写进用户文档，而不是靠用户自己猜。
