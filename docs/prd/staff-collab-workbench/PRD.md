# PRD: 企业数字员工多人协作工作台

## 1. 概述

在 DeepThink 中构建企业数字员工协作工作台，包含数字员工管理、团队协作（任务状态机+黑板）、企业工作台 UI 三大核心模块。参考 StaffDeck 项目设计，复用 DeepThink 已有的 agent_definitions/graph/skills/KB/MCP 基础设施。

## 2. 功能点

### F1: 数字员工管理（Digital Employees）

**描述**：用户可创建、编辑、查看、删除数字员工。每个数字员工是一个"人格化的 Agent"，拥有：
- 基本信息：姓名、头像(emoji)、角色（如"前端开发""数据分析师""技术文档工程师"）、部门
- 人设提示词（persona_prompt）：定义员工的行为方式
- 绑定模型：选择已配置的模型
- 绑定技能：从已有 skills 中选择
- 绑定知识库：从已有 KB 中选择
- 绑定工具/MCP：从已有 MCP servers 中选择
- 状态：active / inactive

**数据模型**：`staff_employees` 表，关联 `agent_definitions`（复用已有 systemPrompt/engine/model/maxTurns + agent_mounts 绑定机制）。员工表存储员工元数据（角色/部门/头像/状态），通过 agent_definition_id 关联技术配置。

### F2: 团队协作（Team Collaboration）

**描述**：用户可组建团队，团队包含多个数字员工成员，支持任务分配与状态流转。

**F2.1 团队管理**
- 创建团队：名称、描述、owner
- 添加/移除成员：从数字员工中选择，设置角色（leader/member）
- 查看/编辑/删除团队

**F2.2 任务状态机**
- 任务字段：标题、描述、分配给(assignee)、状态、优先级、依赖任务
- 状态流转：pending → in_progress → review → done（或 rework → in_progress 循环）
- 创建任务时指定 assignee，assignee 可更新状态
- 任务事件审计日志（状态变更记录）

**F2.3 团队黑板（Blackboard）**
- 团队级共享知识黑板，成员可写入/归档条目
- 条目：内容、标签、来源员工、来源任务
- 支持置顶(pinned)

### F3: 企业工作台 UI

**F3.1 数字员工管理页**（/staff-employees）
- 员工卡片列表（头像+姓名+角色+状态）
- 创建/编辑表单（姓名/角色/部门/人设/模型/技能/KB/工具绑定）
- 删除确认

**F3.2 团队列表页**（/staff-teams）
- 团队卡片列表（名称+成员数+任务统计）
- 创建团队表单

**F3.3 团队详情页**（/staff-teams/:id）
- 三个 Tab：成员 / 任务 / 黑板
- 成员 Tab：成员列表+添加/移除+角色设置
- 任务 Tab：任务列表+创建+状态流转+任务事件时间线
- 黑板 Tab：黑板条目列表+写入+归档+置顶

## 3. 验收标准（AC）

### AC-F1: 数字员工管理
- **AC-F1.1** GET /api/staff/employees 返回当前用户可见的员工列表
- **AC-F1.2** POST /api/staff/employees 创建员工，必填 name+role，返回完整员工对象（含 id）
- **AC-F1.3** GET /api/staff/employees/:id 返回单个员工详情（含绑定的 model/skills/KB/tools）
- **AC-F1.4** PUT /api/staff/employees/:id 更新员工字段（name/role/department/persona/model/skills/KB/tools/status）
- **AC-F1.5** DELETE /api/staff/employees/:id 删除员工（软删除，status=inactive）
- **AC-F1.6** 前端 /staff-employees 页面渲染员工卡片列表，可创建/编辑/删除
- **AC-F1.7** 创建员工时同步创建底层 agent_definition（systemPrompt=persona_prompt），绑定 skills/KB/tools 到 agent_mounts

### AC-F2: 团队协作
- **AC-F2.1** POST /api/staff/teams 创建团队（name+description），返回含 id
- **AC-F2.2** GET /api/staff/teams 返回团队列表（含成员数+任务统计）
- **AC-F2.3** POST /api/staff/teams/:id/members 添加成员（employee_id+role）
- **AC-F2.4** DELETE /api/staff/teams/:id/members/:employeeId 移除成员
- **AC-F2.5** POST /api/staff/teams/:id/tasks 创建任务（title+description+assigneeId+priority），状态初始 pending
- **AC-F2.6** PATCH /api/staff/teams/:id/tasks/:taskId/status 更新任务状态，非法转换返回 400
- **AC-F2.7** GET /api/staff/teams/:id/tasks 返回任务列表（含 assignee+事件历史）
- **AC-F2.8** POST /api/staff/teams/:id/blackboard 写入黑板条目
- **AC-F2.9** GET /api/staff/teams/:id/blackboard 返回黑板条目列表
- **AC-F2.10** PATCH /api/staff/teams/:id/blackboard/:entryId 归档/置顶条目
- **AC-F2.11** 前端 /staff-teams 页面渲染团队列表+创建
- **AC-F2.12** 前端 /staff-teams/:id 页面三 Tab（成员/任务/黑板）完整交互

### AC-F3: 仪表盘
- **AC-F3.1** GET /api/staff/dashboard 返回统计（员工数/团队数/任务分布）
- **AC-F3.2** 前端仪表盘组件展示统计卡片

### AC-T: 测试验收
- **AC-T.1** 测试者 Agent 覆盖全部 AC 自动化验证
- **AC-T.2** 遇 bug 走 issue 修复流程，循环至全通过

## 4. 测试用例

### TC-01: 数字员工 CRUD
1. POST /api/staff/employees {name:"小明",role:"前端开发",department:"技术部",persona:"你是前端开发工程师"} → 200, 返回 id
2. GET /api/staff/employees → 200, 含小明
3. GET /api/staff/employees/:id → 200, persona 正确
4. PUT /api/staff/employees/:id {department:"产品部"} → 200, department 更新
5. DELETE /api/staff/employees/:id → 200, status=inactive

### TC-02: 员工绑定资源
1. 创建员工时指定 skills:["skill-id-1"], model:"gpt-4o" → 200
2. GET 员工详情 → skills/model 正确返回
3. PUT 更新 skills 列表 → 更新生效

### TC-03: 团队 CRUD
1. POST /api/staff/teams {name:"敏捷小组A",description:"..."} → 200, 返回 id
2. GET /api/staff/teams → 200, 含敏捷小组A
3. GET /api/staff/teams/:id → 200, 含成员列表(空)

### TC-04: 团队成员管理
1. POST /teams/:id/members {employeeId:"emp-1",role:"leader"} → 200
2. POST /teams/:id/members {employeeId:"emp-2",role:"member"} → 200
3. GET /teams/:id → 成员数=2
4. DELETE /teams/:id/members/emp-2 → 200, 成员数=1

### TC-05: 任务状态机
1. POST /teams/:id/tasks {title:"接口开发",assigneeId:"emp-1"} → 200, status=pending
2. PATCH /tasks/:taskId/status {status:"in_progress"} → 200
3. PATCH /tasks/:taskId/status {status:"review"} → 200
4. PATCH /tasks/:taskId/status {status:"done"} → 200
5. 非法转换 done→pending → 400

### TC-06: 任务事件审计
1. 创建任务 → 事件 created
2. 状态变更 → 事件 status_changed
3. GET /tasks → 含 events 历史

### TC-07: 黑板
1. POST /teams/:id/blackboard {content:"API 设计文档",tags:["api","design"]} → 200
2. GET /teams/:id/blackboard → 含该条目
3. PATCH /blackboard/:entryId {pinned:true} → 置顶
4. PATCH /blackboard/:entryId {archived:true} → 归档（列表默认不显示）

### TC-08: 仪表盘
1. GET /api/staff/dashboard → 含 employeeCount/teamCount/taskStats

### TC-09: 前端 UI
1. /staff-employees 渲染卡片+创建表单+编辑+删除
2. /staff-teams 渲染列表+创建
3. /staff-teams/:id 三 Tab 交互完整

### TC-10: 导航
1. 侧边栏含"数字员工""协作团队"导航项
2. 点击跳转正确
