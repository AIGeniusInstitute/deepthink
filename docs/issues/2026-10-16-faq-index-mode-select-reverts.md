# FAQ 索引方式下拉改完自己弹回旧值，服务端其实已经改了

- 日期：2026-10-16
- 分支：`worktree-feat-kb-full-replica`
- 影响范围：`web/src/stores/knowledge-bases.ts` `updateFaqConfig`
- 状态：已修复

## 1. 用户现象

在 FAQ 库的「FAQ 条目」面板里，把「索引方式」从 `问题+答案` 改成 `仅问题`，
再改「相似问题索引」为 `每条单独成向量`。截图存档时看到的是：

```
索引方式：[问题+答案 ▾]      相似问题索引：[合并为一条向量 ▾]
```

**下拉回到旧值了**，让人以为根本没改成功。但此时如果直接用接口查知识库配置，
返回的却是 `faq_config.index_mode = question_only`、`question_index_mode = separate`
—— 服务端明明存对了。

更迷惑的是：**检索行为是"新配置"的**。把相似问原文丢进「试检索」，命中该条目且得分
`1.000`（精确匹配）—— 说明库里已经有"仅问题"形式的向量了，索引方式确实是新的。

于是出现"设置界面说 A、检索行为是 B"的分裂：用户没法判断到底存的哪个，
也没法判断该不该点「重建索引」。

## 2. 问题描述

面板上的两个 `<select>` 是**受控组件**，`value` 直接读 store 里的知识库对象：

```tsx
<select
  data-testid="kb-faq-index-mode"
  value={kb.faqConfig.index_mode}          // ← 读 store
  onChange={(e) => updateFaqConfig(kb.id, { index_mode: e.target.value })}
/>
```

而 `updateFaqConfig` 只把 PATCH 的响应丢弃、没有回写 store：

```ts
updateFaqConfig: async (kbId, patch) => {
  const res = await api<{ knowledge_base: KnowledgeBase }>(
    'PATCH', `/api/paas/knowledge-bases/${kbId}/faq-config`, patch,
  );
  await get().fetchList();     // ← 重新拉列表，但 list 里那条仍是旧的 faq_config
  return res.knowledge_base;   // ← 返回值没人接，等于改了也没告诉界面
},
```

一次编辑的时序：

1. 用户选 `question_only` → React 触发 `onChange` → 发 PATCH；
2. 服务端存好，返回新的 `knowledge_base`（含 `faq_config.index_mode = 'question_only'`）；
3. `updateFaqConfig` **把响应丢掉**，只顺手 `fetchList()`；
4. store 里那条 KB 仍是 `question_answer`（`fetchList` 若先于 PATCH 落库返回、
   或列表接口本身不吐全量 `faq_config`，就更是旧的）；
5. 受控 `<select>` 的 `value` 仍等于 `question_answer` → React 把 DOM 拉回旧选项。

**用户看到的是第 5 步，服务端停在的是第 2 步。** 这个"弹回"不是浏览器默认行为被覆盖，
而是受控组件的正常表现 —— 值的唯一来源（store）没变。

另外，**panel 里任何一次重渲染都会放大这个现象**：验收脚本里改完索引方式紧接着就要
新建条目、刷条目列表，列表一刷新 panel 重渲染，下拉立刻回弹到旧值 —— 所以截图里
拍到的一定是旧值。这也是为什么它是被 UI 验收截图抓出来的，而不是被接口测试。

## 3. 根因

**更新接口没有把服务端返回的真值回写到本地状态。** 服务端是对的，接口是对的，
单测（直接打 HTTP）也全绿 —— 缺的是"把响应写回 store"这一步。

依据：

- `web/src/stores/knowledge-bases.ts` `updateFaqConfig`（丢弃响应）；
- `web/src/components/knowledge-base/KbFaqPanel.tsx`（两个 `<select>` 的 `value={kb.faqConfig.*}`）。

对照：同文件里其它写操作（`updateKb` 等）都是写回 `list` 的，只有这个 PATCH 漏了。

## 4. 复现路径

1. 建一个 FAQ 型知识库，进「FAQ 条目」页签。
2. 把「索引方式」改成 `仅问题`，把「相似问题索引」改成 `每条单独成向量`。
3. 在页面上任意操作一下触发重渲染（例如新建一条 FAQ 条目、或切到「检索测试台」再切回来）。
4. 观察两个下拉：**都回到了 `问题+答案` / `合并为一条向量`**。
5. 对照服务端真值：

   ```bash
   curl -s -b <cookie> http://localhost:9911/api/paas/knowledge-bases/<kbId> \
     | python3 -c "import sys,json; print(json.load(sys.stdin)['knowledge_base']['faq_config'])"
   # → {'index_mode': 'question_only', 'question_index_mode': 'separate', ...}
   ```

   界面与真值不一致 = 复现。

## 5. 诊断方法

```bash
# ① 界面显示值 vs 服务端真值（这一步就能定性，不用看代码）
#    UI 用 Playwright 读，服务端用 curl 读：
node -e "…page.getByTestId('kb-faq-index-mode').inputValue()…"
curl -s -b <cookie> http://localhost:9911/api/paas/knowledge-bases/<kbId> | jq .knowledge_base.faq_config

# ② PATCH 的响应里有没有正确答案（有 → 问题在前端，不在后端）
#    在浏览器 Network 面板看 PATCH .../faq-config 的 Response Body

# ③ 谁给 <select> 供值（读源码确认是受控组件）
grep -n "kb-faq-index-mode" -A5 web/src/components/knowledge-base/KbFaqPanel.tsx

# ④ store 有没有回写（找 updateFaqConfig）
grep -n "updateFaqConfig" -A12 web/src/stores/knowledge-bases.ts
```

判据链条：②里响应正确、③ `value` 读 store、④ 没回写 → 根因锁定在 ④。

## 6. 修复方案

```diff
--- a/web/src/stores/knowledge-bases.ts
+++ b/web/src/stores/knowledge-bases.ts
@@ updateFaqConfig
   const res = await api<{ knowledge_base: KnowledgeBase }>(
     'PATCH', `/api/paas/knowledge-bases/${kbId}/faq-config`, patch,
   );
+  // 必须回写 list：FAQ 面板的索引方式下拉是直接读 `kb.faqConfig` 的受控组件，
+  // 不更新 store 的话组件一重渲染（比如刷完条目列表）就会退回旧值 —— 服务端已经
+  // 改好了，界面却显示成没改，用户没法判断到底存的哪个。
+  const kb = res.knowledge_base;
+  if (kb) set((s) => ({ list: s.list.map((k) => (k.id === kbId ? kb : k)) }));
   await get().fetchList();
-  return res.knowledge_base;
+  return kb;
```

选型理由：

- **回写 `list` 而不是给 `<select>` 加本地 state**：受控组件读 store 是对的结构（多端
  同源、刷新后一致）。给 select 单独存一份副本等于把真值分裂成两处，下次从别处改了
  `faq_config` 又要同步一次。修 store 是修在唯一的那处。
- **`if (kb)` 之后再写**：响应体理论上一定有 `knowledge_base`，但真丢了的话
  `s.list.map` 会把该 KB 覆盖成 `undefined`，比不写更糟。
- 保留 `fetchList()`：`faq_config` 之外还有别的字段（如 `updated_at`）可能变了，
  顺手同步。回写在前、`fetchList` 在后，即便列表接口慢一拍，界面也已经是对的。

验证：

- UI 验收脚本 `tests/e2e/kb-p1-ui.mjs` 新增一条断言，在**新建条目、刷完列表之后**
  再读一次两个下拉：

  ```js
  const modeNow = await page.getByTestId('kb-faq-index-mode').inputValue();
  const qModeNow = await page.getByTestId('kb-faq-question-index-mode').inputValue();
  check('索引方式下拉与已保存值一致', modeNow === 'question_only' && qModeNow === 'separate', `${modeNow} / ${qModeNow}`);
  ```

  这一项由 ❌ 转 ✅，截图见
  `docs/test_report/2026-10-16-weknora-full-replica/screenshots/08-kb-faq-index-mode.png`。
- 脚本里同时也改成等 PATCH 响应回来再继续（`waitForResponse`），避免下一步的动作
  跑在设置落库之前 —— 否则测的是竞态，不是功能。

## 7. 处理卡住的状态

不适用。

## 8. 经验沉淀 / 预防

- **写接口"只发不收"是受控组件最容易踩的坑。** 凡是 `value` 读全局状态的表单控件，
  其对应的写操作都必须把响应回写进那个状态，否则界面会静默回弹。这次只有
  `updateFaqConfig` 漏了，同文件的 `updateKb` 是写回的 —— 同类操作写法不一致，本身就是信号。
- **"服务端对了"不等于"用户看到对了"。** 本次接口测试全绿、库里数据正确，坏的是最后一跳。
  这已经是本次 P1 里第二个由 UI 验收（而不是单测）抓到的缺陷（前一个是
  `parent_chunk_id`），说明"接口断言 + 真实 DOM 断言"两层都不可省。
- **截图验收要看"改完之后"的状态，不能只看"改的瞬间"。** 这次是脚本在改完设置、
  又新建条目触发重渲染之后才截图，才拍到了回弹；如果只截 PATCH 的那一刻，看到的会是正确的
  新值，缺陷就漏过去了。UI 验收用例应当在**操作完成后**再断言，而不是紧贴操作。

## 附：与本次 D4（FAQ 条目不索引）的关系

两者在同一块界面上、现象都表现为"改了没用"，但根因完全不同：

| | D4 条目建完不被向量化 | D5 索引方式下拉回弹 |
|---|---|---|
| 层 | 后端（漏调用索引） | 前端（漏回写 store） |
| 服务端状态 | 真的没存向量 | 真的存对了 |
| 判据 | `kb_chunks.embedding IS NULL` | PATCH 响应正确但 DOM 值未更新 |

排查时先看服务端真值，能一步区分这两类。
