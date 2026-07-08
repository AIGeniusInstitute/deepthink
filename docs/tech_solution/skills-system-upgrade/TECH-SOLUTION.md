# DeepThink 技能体系升级 — 技术方案

## 1. 架构总览

```
┌──────────────────────────────────────────────────────────────────┐
│  Web SkillsPage                                                  │
│  ┌──────────────┐ ┌──────────────┐ ┌──────────────────────────┐ │
│  │ SkillList    │ │ SkillDetail  │ │ CreateSkillDialog        │ │
│  │  + Create    │ │  - View      │ │ UploadSkillDialog        │ │
│  │  + Upload    │ │  - Edit      │ │ OptimizeSkillDialog      │ │
│  │  + Install   │ │  - Debug     │ │                          │ │
│  └──────────────┘ └──────────────┘ └──────────────────────────┘ │
└────────────────────────────┬─────────────────────────────────────┘
                             │ HTTP API
┌────────────────────────────▼─────────────────────────────────────┐
│  src/routes/skills.ts (Hono)                                     │
│  ┌─────────────────────────────────────────────────────────────┐ │
│  │ Existing:  GET /  GET /search  GET /:id  PATCH /:id          │ │
│  │            DELETE /:id  POST /install  POST /:id/reinstall   │ │
│  └─────────────────────────────────────────────────────────────┘ │
│  ┌─────────────────────────────────────────────────────────────┐ │
│  │ NEW:  POST /create         (AI 生成)                         │ │
│  │       PUT  /:id/content    (在线编辑)                        │ │
│  │       POST /:id/optimize   (AI 优化预览)                     │ │
│  │       POST /:id/optimize/apply  (应用优化)                   │ │
│  │       POST /upload         (zip 上传)                        │ │
│  │       POST /:id/debug      (在线调试)                        │ │
│  └─────────────────────────────────────────────────────────────┘ │
└────────────────────────────┬─────────────────────────────────────┘
                             │
        ┌────────────────────┼─────────────────────┐
        │                    │                     │
        ▼                    ▼                     ▼
┌──────────────┐    ┌──────────────────┐   ┌──────────────────┐
│ data/skills/ │    │ src/sdk-query.ts │   │ /usr/bin/unzip   │
│ <userId>/    │    │ (Claude SDK)     │   │ (系统命令)        │
│   <skillId>/ │    │  - generateSkill │   │  - extractZip    │
│     SKILL.md │    │  - optimizeSkill │   │                  │
│     .bak.*   │    │  - debugSkill    │   │                  │
└──────────────┘    └──────────────────┘   └──────────────────┘
```

## 2. 关键模块改动

### 2.1 `src/skill-utils.ts`（新增工具函数）

新增：
- `slugifySkillName(input: string): string` — 从自然语言生成合法 skillId
- `validateSkillContent(content: string): { valid: boolean; error?: string; frontmatter?: Record<string,string> }` — 校验 SKILL.md 内容合法性
- `writeSkillContent(userId: string, skillId: string, content: string): void` — 原子写入（先写 .tmp 再 rename）
- `backupSkillContent(userId: string, skillId: string): string | null` — 备份当前内容到 `SKILL.md.bak.<ts>`
- `getSkillContentPath(userId: string, skillId: string): string` — 返回 `SKILL.md` 或 `SKILL.md.disabled` 实际路径

### 2.2 `src/skill-ai.ts`（新文件）

封装 AI 生成/优化/调试的 prompt 构造 + SDK 调用：

```typescript
// 生成新技能
export async function generateSkillContent(
  descriptionPrompt: string,
  suggestedName?: string,
): Promise<{ content: string; skillId: string } | { error: string }>;

// 优化现有技能
export async function optimizeSkillContent(
  currentContent: string,
  feedback?: string,
): Promise<{ content: string } | { error: string }>;

// 调试技能
export async function debugSkill(
  skillContent: string,
  testInput: string,
): Promise<{ output: string; usage?: object; durationMs: number } | { error: string }>;
```

内部使用 `sdkQuery`（来自 `src/sdk-query.ts`），prompt 模板内置：

**生成 prompt 示例**：
```
You are an expert at writing Claude Code skills. Generate a complete SKILL.md file based on the user's description.

Format requirements:
- Start with YAML frontmatter (--- delimiters)
- Required fields: name, description
- Optional fields: user-invocable, allowed-tools, argument-hint
- Followed by Markdown body with instructions

User description: {description_prompt}
Suggested name (can override): {suggested_name}

Output ONLY the SKILL.md content, no explanation.
```

**优化 prompt 示例**：
```
You are an expert at improving Claude Code skills. Optimize the following SKILL.md content.

Focus on:
- Clearer description and instructions
- Better tool usage hints
- More specific argument hints
- Concise, actionable body

User feedback (optional): {feedback}

Current content:
---
{current_content}
---

Output ONLY the optimized SKILL.md content, no explanation. Preserve the YAML frontmatter structure.
```

**调试 prompt 示例**：
```
You are Claude with access to the following skill. Process the user's input according to the skill's instructions.

Skill SKILL.md:
---
{skill_content}
---

User input: {test_input}

Respond as if you were executing this skill.
```

### 2.3 `src/routes/skills.ts`（新增路由）

#### POST `/create`
```typescript
{
  body: { description_prompt: string, name?: string }
  → 调用 generateSkillContent(description_prompt, name)
  → 校验返回内容
  → slugify / 处理同名冲突（自动加 -2、-3）
  → mkdir data/skills/<userId>/<skillId>/
  → write SKILL.md
  → 更新 manifest（sourceType: 'generated'）
  → 返回 { skill_id, skill: SkillInfo }
}
```

#### PUT `/:id/content`
```typescript
{
  body: { content: string }
  → validateSkillId(id)
  → validateSkillContent(content)
  → 检查是否 user 级（project/external 拒绝）
  → writeSkillContent(userId, id, content) — 原子写入
  → 返回 { success: true }
}
```

#### POST `/:id/optimize`
```typescript
{
  body: { feedback?: string }
  → 读取当前 SKILL.md 内容
  → 调用 optimizeSkillContent(content, feedback)
  → 返回 { optimized_content, original_content } — 不写入
}
```

#### POST `/:id/optimize/apply`
```typescript
{
  body: { content: string }  // 来自 optimize 预览的内容
  → validateSkillContent(content)
  → backupSkillContent(userId, id)  → 写入 SKILL.md.bak.<ts>
  → writeSkillContent(userId, id, content)
  → 更新 manifest（sourceType: 'optimized'）
  → 返回 { success: true, backup_path }
}
```

#### POST `/upload`
```typescript
{
  multipart form: { file: File }
  → 校验是 zip（filename ends with .zip, MIME application/zip）
  → 大小 ≤ 10MB
  → 保存到 os.tmpdir() 临时文件
  → execFile('unzip', ['-l', tmpPath]) 列出文件
    → 校验无 ../、无绝对路径、无符号链接
    → 文件数 ≤ 100
  → execFile('unzip', ['-o', tmpPath, '-d', extractDir])
  → 检查顶层：若有 SKILL.md → skillId = slugify(zip filename)
             若有单目录 + 内含 SKILL.md → skillId = 该目录名
  → parseFrontmatter(SKILL.md) → 校验 name 非空
  → 同名冲突检查 → 返回 409 让用户改名（第一版不做覆盖）
  → mv 到 data/skills/<userId>/<skillId>/
  → 更新 manifest（sourceType: 'uploaded'）
  → 返回 { skill_id, skill }
}
```

#### POST `/:id/debug`
```typescript
{
  body: { test_input: string }
  → 读取当前 SKILL.md 内容
  → 调用 debugSkill(content, test_input)
  → 返回 { output, usage, duration_ms }
}
```

### 2.4 `container/agent-runner/src/mcp-tools.ts`（新增 `create_skill` 工具）

```typescript
tool({
  name: 'create_skill',
  description: 'Create a new skill for the user from a natural language description.',
  schema: {
    description_prompt: z.string().min(10),
    name: z.string().optional(),
  },
  // IPC: { type: 'create_skill', descriptionPrompt, name, requestId, ... }
  // 主进程 src/index.ts 的 IPC handler 调用 generateSkillContent + writeSkillContent
  // 返回结果 { skillId, content }
})
```

**决策**：使用新工具 `create_skill` 而非扩展 `install_skill`，避免破坏原有 npm package 语义。

### 2.5 `src/index.ts`（新增 IPC handler）

在 IPC 处理器中新增 case：
```typescript
case 'create_skill': {
  // 校验 requestId、result filename
  // 解析 user from group
  // 调用 generateSkillContent(descriptionPrompt, name)
  // 处理同名冲突
  // writeSkillContent
  // 更新 manifest
  // 写 result JSON
}
```

### 2.6 前端

#### `web/src/stores/skills.ts` 新增 actions

```typescript
createSkill: (descriptionPrompt: string, name?: string) => Promise<Skill>;
saveSkillContent: (id: string, content: string) => Promise<void>;
optimizeSkill: (id: string, feedback?: string) => Promise<{ optimized_content: string; original_content: string }>;
applyOptimizedSkill: (id: string, content: string) => Promise<void>;
uploadSkillZip: (file: File) => Promise<Skill>;
debugSkill: (id: string, testInput: string) => Promise<{ output: string; usage?: object; duration_ms: number }>;
```

#### `web/src/components/skills/`（新增组件）

- `CreateSkillDialog.tsx` — 描述 textarea + 名称 input + 生成按钮
- `UploadSkillDialog.tsx` — 文件选择 + 上传按钮
- `SkillEditor.tsx` — textarea 编辑器（等宽字体）+ 保存/取消按钮
- `SkillDebugger.tsx` — 测试输入 textarea + 执行按钮 + 输出区
- `OptimizeSkillDialog.tsx` — 反馈 textarea + diff 预览（逐行对比）+ 应用/放弃

#### `web/src/components/skills/SkillDetail.tsx`（改造）

- 顶部 Tab 切换：详情 / 编辑 / 调试
- 详情 Tab：保持现状 + 新增"AI 优化"按钮
- 编辑 Tab：嵌入 `SkillEditor`
- 调试 Tab：嵌入 `SkillDebugger`

#### `web/src/pages/SkillsPage.tsx`（改造）

- Header 新增按钮："创建技能"、"上传 ZIP"（保留原有"安装技能"）

## 3. 关键算法

### 3.1 同名冲突处理

```typescript
function resolveSkillIdConflict(userDir: string, baseId: string): string {
  if (!fs.existsSync(path.join(userDir, baseId))) return baseId;
  for (let i = 2; i < 100; i++) {
    const candidate = `${baseId}-${i}`;
    if (!fs.existsSync(path.join(userDir, candidate))) return candidate;
  }
  throw new Error('Too many skills with similar name');
}
```

### 3.2 zip 路径遍历防护

```typescript
function validateZipEntries(entries: string[]): { safe: boolean; reason?: string } {
  for (const entry of entries) {
    if (entry.startsWith('/')) return { safe: false, reason: `Absolute path: ${entry}` };
    if (entry.includes('../')) return { safe: false, reason: `Path traversal: ${entry}` };
    if (entry.includes('\0')) return { safe: false, reason: `Null byte: ${entry}` };
  }
  return { safe: true };
}
```

### 3.3 SKILL.md 内容校验

```typescript
function validateSkillContent(content: string): { valid: boolean; error?: string } {
  if (!content.startsWith('---')) return { valid: false, error: 'Missing YAML frontmatter start' };
  const endIndex = content.indexOf('---', 3);
  if (endIndex === -1) return { valid: false, error: 'Missing YAML frontmatter end' };
  const frontmatter = parseFrontmatter(content);
  if (!frontmatter.name) return { valid: false, error: 'Missing required field: name' };
  if (!frontmatter.description) return { valid: false, error: 'Missing required field: description' };
  if (!validateSkillId(frontmatter.name)) return { valid: false, error: 'Invalid skill name in frontmatter' };
  return { valid: true };
}
```

### 3.4 diff 算法（前端）

用简单的 LCS 算法逐行对比，生成 `{ type: 'added' | 'removed' | 'unchanged', line: string }` 数组。第一版不引入 diff 库，手写 30 行 LCS。

## 4. 数据流

### 4.1 AI 生成技能流

```
用户填描述 → POST /api/skills/create
  → generateSkillContent(desc, name) [src/skill-ai.ts]
    → sdkQuery(generationPrompt) [src/sdk-query.ts]
    → Claude 返回 SKILL.md 文本
  → validateSkillContent
  → slugify name + resolveConflict
  → mkdir + writeSkillContent
  → 更新 manifest
  → 返回 skill_id
```

### 4.2 调试流

```
用户输入 test_input → POST /api/skills/:id/debug
  → 读取 SKILL.md
  → debugSkill(content, test_input) [src/skill-ai.ts]
    → sdkQuery(debugPrompt) — maxTurns=1, allowedTools=[]
    → 返回 output + usage
  → 返回 { output, usage, duration_ms }
```

### 4.3 优化应用流

```
用户点"优化" → POST /api/skills/:id/optimize
  → 读取当前 SKILL.md
  → optimizeSkillContent(content, feedback)
  → 返回 { optimized_content, original_content }  [不写入]
用户点"应用" → POST /api/skills/:id/optimize/apply
  → validateSkillContent(content)
  → backupSkillContent → 写 SKILL.md.bak.<ts>
  → writeSkillContent (新内容)
  → 更新 manifest
  → 返回 { success, backup_path }
```

## 5. 错误处理

| 错误 | HTTP | 场景 |
|------|------|------|
| `Invalid skill ID` | 400 | 路径参数校验失败 |
| `Skill not found` | 404 | 技能不存在 |
| `Skill is not user-level` | 403 | 编辑 project/external 技能 |
| `Missing required field: name` | 400 | SKILL.md frontmatter 缺字段 |
| `Skill name already exists` | 409 | 上传/创建同名 |
| `Invalid zip: missing SKILL.md` | 400 | zip 内无 SKILL.md |
| `Invalid zip: path traversal detected` | 400 | zip 含 ../ 等 |
| `AI generation failed` | 502 | sdkQuery 返回 null |
| `description_prompt too short` | 400 | <10 字符 |

## 6. 测试策略

### 6.1 约束测试（`tests/units/skill-*.test.ts`）

- `skill-content-validation.test.ts` — validateSkillContent 各种输入
- `skill-zip-validation.test.ts` — validateZipEntries 路径遍历
- `skill-slugify.test.ts` — slugifySkillName 各种输入
- `skill-conflict-resolve.test.ts` — resolveSkillIdConflict

### 6.2 E2E 手动走查

1. Web 登录 → 技能页 → "创建技能" → 填描述 → 生成成功，列表出现
2. 选中技能 → 编辑 Tab → 修改内容 → 保存 → 详情刷新
3. "上传 ZIP" → 选合法 zip → 成功注册
4. 上传含 `../` 的 zip → 报错
5. 选中技能 → 调试 Tab → 输入 test → 执行 → 输出展示
6. 选中技能 → "AI 优化" → 填反馈 → 预览 diff → 应用 → 内容更新，`.bak` 文件存在
7. 在飞书对话中让 Agent 调用 `create_skill` 工具 → 成功创建

## 7. 兼容性

- 不破坏现有 `GET /api/skills`、`PATCH /:id`、`DELETE /:id`、`POST /install`、`POST /:id/reinstall` 行为
- `install_skill` MCP 工具签名不变
- Manifest 兼容（新字段 `sourceType` 可选，老数据无此字段按 `registry` 处理）
- 前端 `Skill` 类型新增可选字段 `sourceType`，不破坏旧数据渲染

## 8. 实施顺序

1. 后端 `src/skill-utils.ts` 新增工具函数 + 测试
2. 后端 `src/skill-ai.ts` AI 封装
3. 后端 `src/routes/skills.ts` 6 个新路由
4. 后端 `src/index.ts` 新增 `create_skill` IPC handler
5. 后端 `container/agent-runner/src/mcp-tools.ts` 新增 `create_skill` 工具
6. 前端 `web/src/stores/skills.ts` 新增 actions
7. 前端 5 个新组件
8. 前端 `SkillDetail.tsx` Tab 改造
9. 前端 `SkillsPage.tsx` 新增按钮
10. typecheck + 手动 E2E
11. 测试报告
12. 合并 main + push
