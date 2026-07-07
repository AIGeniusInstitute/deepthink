import fs from 'fs';
import path from 'path';

import type { ClaudeContextAudit } from './stream-event.types.js';
import type { RegisteredGroup } from './types.js';

export interface ClaudeContextPlanArgs {
  executionMode: 'host' | 'container';
  group: RegisteredGroup;
  ownerHomeFolder?: string;
  externalClaudeDir: string;
  projectRoot: string;
  dataDir: string;
  groupSessionsDir?: string;
  mountUserSkills?: boolean;
  // host 模式下 DeepThink 记忆层是否启用（即 !disableMemoryLayerForAdminHost）。
  // true 且 admin 原生 ~/.claude/CLAUDE.md 存在时，两套全局记忆并存，触发 audit 告警。
  deepthinkMemoryActive?: boolean;
}

export interface ClaudeContextPlan {
  executionMode: 'host' | 'container';
  isAdminOwned: boolean;
  externalClaudeDir: string;
  claudeMdSource?: string;
  rulesSourceDir?: string;
  externalSkillsDir?: string;
  builtinSkillsDir: string;
  projectSkillsDir: string;
  userSkillsDir?: string;
  audit: ClaudeContextAudit;
}

export interface HostClaudeContextSyncResult {
  claudeMdStatus: ClaudeContextAudit['claudeMd']['status'];
  warnings: string[];
}

const ADMIN_HOME_FOLDER = 'main';

function exists(p: string | undefined): p is string {
  return !!p && fs.existsSync(p);
}

// 检测链接/文件本身是否已存在（不跟随 symlink），用于多来源合并时的同名冲突检测。
function lexists(p: string): boolean {
  try {
    fs.lstatSync(p);
    return true;
  } catch {
    return false;
  }
}

function countChildDirs(dir: string | undefined): number {
  if (!exists(dir)) return 0;
  try {
    return fs.readdirSync(dir, { withFileTypes: true })
      .filter((entry) => entry.isDirectory() || entry.isSymbolicLink())
      .length;
  } catch {
    return 0;
  }
}

function countRuleFiles(dir: string | undefined): number {
  if (!exists(dir)) return 0;
  try {
    return fs.readdirSync(dir, { withFileTypes: true })
      .filter((entry) => entry.isFile() || entry.isDirectory() || entry.isSymbolicLink())
      .length;
  } catch {
    return 0;
  }
}

function fileTokenEstimate(filePath: string | undefined): number | undefined {
  if (!exists(filePath)) return undefined;
  try {
    const bytes = fs.statSync(filePath).size;
    return Math.ceil(bytes / 4);
  } catch {
    return undefined;
  }
}

function removePath(p: string): void {
  try {
    fs.rmSync(p, { recursive: true, force: true });
  } catch {
    /* best effort */
  }
}

function linkEntries(
  sourceDir: string | undefined,
  targetDir: string,
  include: (entry: fs.Dirent) => boolean,
  onConflict?: (name: string) => void,
): void {
  if (!exists(sourceDir)) return;
  for (const entry of fs.readdirSync(sourceDir, { withFileTypes: true })) {
    if (!include(entry)) continue;
    const linkPath = path.join(targetDir, entry.name);
    // 多来源合并进同一目录时，后序来源同名会覆盖前序；记录冲突供 audit 告警。
    if (onConflict && lexists(linkPath)) onConflict(entry.name);
    removePath(linkPath);
    try {
      fs.symlinkSync(path.join(sourceDir, entry.name), linkPath);
    } catch {
      /* best effort */
    }
  }
}

export function buildClaudeContextPlan(args: ClaudeContextPlanArgs): ClaudeContextPlan {
  const ownerId = args.group.created_by;
  const isAdminOwned =
    args.ownerHomeFolder === ADMIN_HOME_FOLDER ||
    (!!args.group.is_home && args.group.folder === ADMIN_HOME_FOLDER);
  const claudeMdSource = isAdminOwned ? path.join(args.externalClaudeDir, 'CLAUDE.md') : undefined;
  const rulesSourceDir = isAdminOwned ? path.join(args.externalClaudeDir, 'rules') : undefined;
  const externalSkillsDir = isAdminOwned ? path.join(args.externalClaudeDir, 'skills') : undefined;
  const builtinSkillsDir =
    args.executionMode === 'container'
      ? '/opt/builtin-skills'
      : path.join(args.dataDir, 'builtin-skills');
  const projectSkillsDir = path.join(args.projectRoot, 'container', 'skills');
  const userSkillsDir =
    args.mountUserSkills !== false && ownerId
      ? path.join(args.dataDir, 'skills', ownerId)
      : undefined;

  const hostClaudeRuntime = args.groupSessionsDir
    ? path.join(args.groupSessionsDir, 'CLAUDE.md')
    : undefined;
  const hostRulesRuntime = args.groupSessionsDir
    ? path.join(args.groupSessionsDir, 'rules')
    : undefined;
  const hostSkillsRuntime = args.groupSessionsDir
    ? path.join(args.groupSessionsDir, 'skills')
    : undefined;

  const warnings: string[] = [];
  if (isAdminOwned && !exists(claudeMdSource)) warnings.push('CLAUDE.md missing');
  if (isAdminOwned && !exists(rulesSourceDir)) warnings.push('rules missing');
  if (isAdminOwned && !exists(externalSkillsDir)) warnings.push('external skills missing');
  // 记忆层未禁用 + 原生 ~/.claude/CLAUDE.md 存在 → 两套全局记忆并存，提醒 admin。
  if (isAdminOwned && args.deepthinkMemoryActive && exists(claudeMdSource)) {
    warnings.push(
      '两套全局记忆同时生效：~/.claude/CLAUDE.md（原生 Playbook）+ DeepThink 记忆层；如需纯原生体验可开启 disableMemoryLayerForAdminHost',
    );
  }

  const audit: ClaudeContextAudit = {
    executionMode: args.executionMode,
    externalClaudeDir: isAdminOwned ? args.externalClaudeDir : undefined,
    claudeMd: {
      sourcePath: claudeMdSource,
      runtimePath: args.executionMode === 'container' ? '/workspace/CLAUDE.md' : hostClaudeRuntime,
      status: exists(claudeMdSource)
        ? args.executionMode === 'container'
          ? 'mounted'
          : 'linked'
        : isAdminOwned
          ? 'missing'
          : 'unavailable',
      tokens: fileTokenEstimate(claudeMdSource),
    },
    rules: {
      sourcePath: rulesSourceDir,
      runtimePath: args.executionMode === 'container' ? '/workspace/.claude/rules' : hostRulesRuntime,
      status: exists(rulesSourceDir)
        ? args.executionMode === 'container'
          ? 'mounted'
          : 'linked'
        : isAdminOwned
          ? 'missing'
          : 'unavailable',
      fileCount: countRuleFiles(rulesSourceDir),
    },
    skills: {
      sources: [
        {
          name: 'builtin',
          sourcePath: builtinSkillsDir,
          runtimePath: args.executionMode === 'container'
            ? '/home/node/.claude/skills'
            : hostSkillsRuntime,
          count: countChildDirs(args.executionMode === 'container' ? undefined : builtinSkillsDir),
        },
        ...(externalSkillsDir ? [{
          name: 'external' as const,
          sourcePath: externalSkillsDir,
          runtimePath: args.executionMode === 'container'
            ? '/workspace/external-skills'
            : hostSkillsRuntime,
          count: countChildDirs(externalSkillsDir),
        }] : []),
        {
          name: 'project',
          sourcePath: projectSkillsDir,
          runtimePath: args.executionMode === 'container'
            ? '/workspace/project-skills'
            : hostSkillsRuntime,
          count: countChildDirs(projectSkillsDir),
        },
        ...(userSkillsDir ? [{
          name: 'user' as const,
          sourcePath: userSkillsDir,
          runtimePath: args.executionMode === 'container'
            ? '/workspace/user-skills'
            : hostSkillsRuntime,
          count: countChildDirs(userSkillsDir),
        }] : []),
      ],
    },
    deepthinkPrompt: { totalBytes: 0, files: [] },
    warnings,
  };

  return {
    executionMode: args.executionMode,
    isAdminOwned,
    externalClaudeDir: args.externalClaudeDir,
    claudeMdSource,
    rulesSourceDir,
    externalSkillsDir,
    builtinSkillsDir,
    projectSkillsDir,
    userSkillsDir,
    audit,
  };
}

export function syncHostClaudeContext(
  plan: ClaudeContextPlan,
  groupSessionsDir: string,
): HostClaudeContextSyncResult {
  const warnings = [...plan.audit.warnings];
  const skillsDir = path.join(groupSessionsDir, 'skills');
  fs.mkdirSync(skillsDir, { recursive: true });
  for (const entry of fs.readdirSync(skillsDir, { withFileTypes: true })) {
    if (entry.isSymbolicLink() || entry.isDirectory()) {
      removePath(path.join(skillsDir, entry.name));
    }
  }
  const includeSkill = (entry: fs.Dirent) => entry.isDirectory() || entry.isSymbolicLink();
  // skill 四来源（builtin→external→project→user）合并进同一目录，后序覆盖前序。
  // 收集同名冲突并写入 warnings，避免静默覆盖（前端 AgentContextPanel 会展示）。
  const skillConflicts = new Set<string>();
  const onSkillConflict = (name: string) => skillConflicts.add(name);
  linkEntries(plan.builtinSkillsDir, skillsDir, includeSkill, onSkillConflict);
  linkEntries(plan.externalSkillsDir, skillsDir, includeSkill, onSkillConflict);
  linkEntries(plan.projectSkillsDir, skillsDir, includeSkill, onSkillConflict);
  linkEntries(plan.userSkillsDir, skillsDir, includeSkill, onSkillConflict);
  for (const name of skillConflicts) {
    warnings.push(`skill name conflict: ${name}（后序来源覆盖前序）`);
  }

  const rulesDir = path.join(groupSessionsDir, 'rules');
  fs.mkdirSync(rulesDir, { recursive: true });
  for (const entry of fs.readdirSync(rulesDir, { withFileTypes: true })) {
    if (entry.isSymbolicLink() || entry.isFile() || entry.isDirectory()) {
      removePath(path.join(rulesDir, entry.name));
    }
  }
  linkEntries(
    plan.rulesSourceDir,
    rulesDir,
    (entry) => entry.isFile() || entry.isDirectory() || entry.isSymbolicLink(),
  );

  let claudeMdStatus = plan.audit.claudeMd.status;
  const sessionClaudeMd = path.join(groupSessionsDir, 'CLAUDE.md');
  if (!plan.claudeMdSource || !fs.existsSync(plan.claudeMdSource)) {
    return { claudeMdStatus, warnings };
  }

  try {
    const st = fs.lstatSync(sessionClaudeMd);
    if (st.isSymbolicLink()) {
      const currentTarget = fs.readlinkSync(sessionClaudeMd);
      if (currentTarget !== plan.claudeMdSource) {
        fs.unlinkSync(sessionClaudeMd);
        fs.symlinkSync(plan.claudeMdSource, sessionClaudeMd);
      }
      claudeMdStatus = 'linked';
    } else {
      claudeMdStatus = 'shadowed';
      warnings.push('CLAUDE.md shadowed by session file');
    }
  } catch {
    try {
      fs.symlinkSync(plan.claudeMdSource, sessionClaudeMd);
      claudeMdStatus = 'linked';
    } catch {
      warnings.push('failed to link CLAUDE.md');
    }
  }

  return { claudeMdStatus, warnings };
}
