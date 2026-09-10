# 技术方案: 企业数字员工多人协作工作台

## 1. 架构概览

复用 DeepThink 现有基础设施（agent_definitions + agent_mounts + skills + KB + MCP + Hono 路由 + Zustand + React Router），增量添加数字员工元数据层 + 持久团队协作层 + 工作台 UI。

```
┌─────────────────────────────────────────────┐
│           前端 (React + Zustand)              │
│  /staff-employees  /staff-teams  /staff-teams/:id  │
│  nav-items: 数字员工 / 协作团队               │
└──────────────────┬──────────────────────────┘
                   │ REST API (cookie auth)
┌──────────────────┴──────────────────────────┐
│         后端 (Hono Routes)                     │
│  /api/staff/employees  /api/staff/teams       │
│  /api/staff/dashboard                         │
└──────────────────┬──────────────────────────┘
                   │
┌──────────────────┴──────────────────────────┐
│         数据层 (SQLite db.ts)                  │
│  staff_employees / staff_teams / staff_team_  │
│  members / staff_team_tasks / staff_team_     │
│  blackboard / staff_team_events               │
│  schema_version 61 → 62                        │
└─────────────────────────────────────────────┘
```

## 2. 数据库设计（6 新表，schema v62）

### 2.1 staff_employees
数字员工元数据，关联 agent_definitions 复用技术配置。
```sql
CREATE TABLE IF NOT EXISTS staff_employees (
  id TEXT PRIMARY KEY,
  owner_user_id TEXT NOT NULL,        -- 创建者
  name TEXT NOT NULL,                 -- 员工姓名
  role TEXT NOT NULL DEFAULT '',      -- 角色（前端开发/数据分析师...）
  department TEXT NOT NULL DEFAULT '',-- 部门
  avatar_emoji TEXT NOT NULL DEFAULT '🤖',
  persona_prompt TEXT NOT NULL DEFAULT '', -- 人设提示词
  model TEXT NOT NULL DEFAULT '',     -- 绑定模型名
  skills_json TEXT NOT NULL DEFAULT '[]',  -- 技能ID列表 JSON
  knowledge_bases_json TEXT NOT NULL DEFAULT '[]', -- KB ID列表
  tools_json TEXT NOT NULL DEFAULT '[]',   -- MCP/工具ID列表
  agent_definition_id TEXT,           -- 关联 agent_definitions（可选，复用 mounts）
  status TEXT NOT NULL DEFAULT 'active', -- active/inactive
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_staff_emp_owner ON staff_employees(owner_user_id);
CREATE INDEX IF NOT EXISTS idx_staff_emp_status ON staff_employees(status);
```

### 2.2 staff_teams
```sql
CREATE TABLE IF NOT EXISTS staff_teams (
  id TEXT PRIMARY KEY,
  owner_user_id TEXT NOT NULL,
  name TEXT NOT NULL,
  description TEXT NOT NULL DEFAULT '',
  status TEXT NOT NULL DEFAULT 'active', -- active/archived
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL
);
```

### 2.3 staff_team_members
```sql
CREATE TABLE IF NOT EXISTS staff_team_members (
  team_id TEXT NOT NULL,
  employee_id TEXT NOT NULL,
  role TEXT NOT NULL DEFAULT 'member', -- leader/member
  added_at TEXT NOT NULL,
  added_by TEXT NOT NULL,
  PRIMARY KEY (team_id, employee_id)
);
```

### 2.4 staff_team_tasks
```sql
CREATE TABLE IF NOT EXISTS staff_team_tasks (
  id TEXT PRIMARY KEY,
  team_id TEXT NOT NULL,
  title TEXT NOT NULL,
  description TEXT NOT NULL DEFAULT '',
  assignee_employee_id TEXT,           -- 分配给的员工
  status TEXT NOT NULL DEFAULT 'pending', -- pending/in_progress/review/done/rework
  priority TEXT NOT NULL DEFAULT 'medium', -- low/medium/high
  parent_task_id TEXT,                 -- 依赖的父任务
  created_by TEXT NOT NULL,
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL,
  FOREIGN KEY (team_id) REFERENCES staff_teams(id)
);
CREATE INDEX IF NOT EXISTS idx_staff_task_team ON staff_team_tasks(team_id);
CREATE INDEX IF NOT EXISTS idx_staff_task_status ON staff_team_tasks(status);
```

### 2.5 staff_team_blackboard
```sql
CREATE TABLE IF NOT EXISTS staff_team_blackboard (
  id TEXT PRIMARY KEY,
  team_id TEXT NOT NULL,
  content TEXT NOT NULL,
  tags_json TEXT NOT NULL DEFAULT '[]',
  source_employee_id TEXT,
  source_task_id TEXT,
  pinned INTEGER NOT NULL DEFAULT 0,
  archived INTEGER NOT NULL DEFAULT 0,
  created_at TEXT NOT NULL,
  FOREIGN KEY (team_id) REFERENCES staff_teams(id)
);
CREATE INDEX IF NOT EXISTS idx_staff_bb_team ON staff_team_blackboard(team_id, archived);
```

### 2.6 staff_team_events
任务/成员变更审计日志。
```sql
CREATE TABLE IF NOT EXISTS staff_team_events (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  team_id TEXT NOT NULL,
  task_id TEXT,
  employee_id TEXT,
  event_type TEXT NOT NULL,            -- task_created/status_changed/member_added/member_removed/blackboard_written
  payload_json TEXT NOT NULL DEFAULT '{}',
  actor_user_id TEXT NOT NULL,
  created_at TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_staff_evt_team ON staff_team_events(team_id, created_at DESC);
CREATE INDEX IF NOT EXISTS idx_staff_evt_task ON staff_team_events(task_id, created_at DESC);
```

## 3. 后端路由设计

### 3.1 src/routes/staff-employees.ts
| Method | Path | 描述 |
|--------|------|------|
| GET | / | 列出当前用户员工（owner_user_id = user.id，admin 看全部）|
| POST | / | 创建员工（name+role 必填，persona_prompt 写入；同步创建 agent_definition）|
| GET | /:id | 员工详情 |
| PUT | /:id | 更新员工字段 |
| DELETE | /:id | 软删除（status=inactive）|

### 3.2 src/routes/staff-teams.ts
| Method | Path | 描述 |
|--------|------|------|
| GET | / | 团队列表（含成员数+任务统计）|
| POST | / | 创建团队 |
| GET | /:id | 团队详情（含成员列表）|
| PUT | /:id | 更新团队 |
| DELETE | /:id | 删除团队（级联删成员/任务/黑板）|
| POST | /:id/members | 添加成员 |
| DELETE | /:id/members/:employeeId | 移除成员 |
| GET | /:id/tasks | 任务列表（含 assignee + events）|
| POST | /:id/tasks | 创建任务（初始 pending + 事件）|
| PATCH | /:id/tasks/:taskId/status | 更新状态（校验状态机 + 事件）|
| GET | /:id/blackboard | 黑板列表（默认非归档，?includeArchived=1 全部）|
| POST | /:id/blackboard | 写入条目 + 事件 |
| PATCH | /:id/blackboard/:entryId | 更新条目（pinned/archived）|

### 3.3 src/routes/staff-dashboard.ts
| Method | Path | 描述 |
|--------|------|------|
| GET | / | 统计（employeeCount/teamCount/taskStats by status）|

### 3.4 任务状态机
```
pending → in_progress → review → done
                ↑         ↓
                └─ rework ┘
```
合法转换（TASK_TRANSITIONS）：
- pending → in_progress
- in_progress → review
- review → done
- review → rework
- rework → in_progress
- 非法转换 → 400

## 4. 前端设计

### 4.1 页面
- `web/src/pages/StaffEmployeesPage.tsx` — 员工卡片网格 + 创建/编辑 Modal + 删除确认
- `web/src/pages/StaffTeamsPage.tsx` — 团队卡片网格 + 创建 Modal + 跳转详情
- `web/src/pages/StaffTeamDetailPage.tsx` — 三 Tab（成员/任务/黑板）+ 仪表盘组件

### 4.2 Store
- `web/src/stores/staff.ts` — Zustand store（employees/teams/tasks/blackboard/dashboard + CRUD actions）

### 4.3 导航
修改 `nav-items.ts`，baseNavItems 加：
- { path: '/staff-employees', icon: Users, label: '数字员工' }
- { path: '/staff-teams', icon: Team, label: '协作团队' }

### 4.4 路由
App.tsx 加 lazy 路由 /staff-employees /staff-teams /staff-teams/:id

## 5. 文件清单

| 操作 | 文件 |
|------|------|
| 修改 | src/db.ts — 6 新表 + CRUD 函数 + SCHEMA_VERSION 61→62 |
| 新建 | src/routes/staff-employees.ts |
| 新建 | src/routes/staff-teams.ts |
| 新建 | src/routes/staff-dashboard.ts |
| 修改 | src/web.ts — import + 注册 3 路由 |
| 新建 | web/src/stores/staff.ts |
| 新建 | web/src/pages/StaffEmployeesPage.tsx |
| 新建 | web/src/pages/StaffTeamsPage.tsx |
| 新建 | web/src/pages/StaffTeamDetailPage.tsx |
| 修改 | web/src/App.tsx — 3 lazy 路由 |
| 修改 | web/src/components/layout/nav-items.ts — 2 导航项 |

## 6. 关键决策

1. **复用 agent_definitions**：创建员工时同步创建 agent_definition（systemPrompt=persona_prompt, model），绑定 skills/KB/tools 到 agent_mounts。但 MVP 阶段 staff_employees 表直接存 skills_json/knowledge_bases_json/tools_json，agent_definition_id 可选关联（不强制，避免 over-engineering）。
2. **软删除**：员工删除 = status=inactive（保留数据，可恢复）。团队删除 = 硬删除级联（团队是临时组织，成员/任务/黑板随团队消失）。
3. **任务状态机在应用层校验**：PATCH status 时查当前 status，匹配 TASK_TRANSITIONS，非法→400。不依赖 DB 约束（SQLite CHECK 不支持复杂转换）。
4. **黑板轻量化**：黑板是文本+标签的共享笔记，不做版本/检索（Simplicity First，StaffDeck 的 citation/概念图谱过重）。
5. **审计日志 staff_team_events**：INSERT-only，记录关键事件（task_created/status_changed/member_*/blackboard_written），不修改不删除。
6. **不做竞价**：StaffDeck 的 bidding HP 血条是复杂特性，MVP 不做。任务直接由 leader 分配 assignee。
