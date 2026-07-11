// 隔离测试：验证 installSkillForUser 修复点 — CLAUDE_CONFIG_DIR 覆盖使 skills 装到 tempHome 而非真实 HOME。
// 本测试不调用 installSkillForUser（其 pkg 验证只接受 npm name / https URL，file:// 被拒；github.com 端到端网络不可达）。
// 改为直接 spawn `npx skills add file://mockRepo`，复刻 installSkillForUser 内部相同的环境变量构造。
import fs from 'fs';
import { spawnSync } from 'child_process';
import os from 'os';
import path from 'path';

const mockRepo = fs.readFileSync('/tmp/mock-skill-repo-path', 'utf-8').trim();
const pkg = `file://${mockRepo}`;

// 真实 happyclaw 主进程的 CLAUDE_CONFIG_DIR（被修复代码必须覆盖它）
const realClaudeConfigDir = process.env.CLAUDE_CONFIG_DIR;
const realSkillsDir = realClaudeConfigDir
  ? path.join(realClaudeConfigDir, 'skills')
  : null;

const beforeReal = realSkillsDir && fs.existsSync(realSkillsDir)
  ? fs.readdirSync(realSkillsDir).sort()
  : [];

console.log('[env] CLAUDE_CONFIG_DIR=', realClaudeConfigDir);
console.log('[before] real ~/.claude/skills/ count:', beforeReal.length);

// 复刻 installSkillForUser() 的临时目录构造
const tempHome = fs.mkdtempSync(path.join(os.tmpdir(), 'skill-install-'));
const tempClaudeDir = path.join(tempHome, '.claude');
const tempSkillsDir = path.join(tempClaudeDir, 'skills');
fs.mkdirSync(tempSkillsDir, { recursive: true });

try {
  // 复刻 installSkillForUser() 的 spawn 调用（src/routes/skills.ts:789-800）
  const result = spawnSync('npx', ['-y', 'skills', 'add', pkg, '--global', '--yes', '-a', 'claude-code'], {
    timeout: 60_000,
    env: {
      ...process.env,
      HOME: tempHome,
      CLAUDE_CONFIG_DIR: tempClaudeDir,
    },
    encoding: 'utf-8',
  });
  console.log('[npx] exit code:', result.status);
  if (result.status !== 0) {
    console.error('[npx] stderr tail:', result.stderr?.split('\n').slice(-20).join('\n'));
  }

  const installedEntries = fs.existsSync(tempSkillsDir)
    ? fs.readdirSync(tempSkillsDir, { withFileTypes: true })
        .filter(e => e.isDirectory() || e.isSymbolicLink())
        .map(e => e.name)
    : [];

  console.log('[tempHome] installed entries:', installedEntries);

  const afterReal = realSkillsDir && fs.existsSync(realSkillsDir)
    ? fs.readdirSync(realSkillsDir).sort()
    : [];

  // === 断言 ===
  let pass = true;
  if (installedEntries.length === 0) {
    console.error('FAIL: tempHome/.claude/skills/ is empty — CLAUDE_CONFIG_DIR override did NOT redirect install');
    pass = false;
  } else {
    console.log('[ok] tempHome received skill installation:', installedEntries);
  }
  if (!installedEntries.includes('memory-merger')) {
    console.error('FAIL: memory-merger not in tempHome'); pass = false;
  } else {
    const skillMd = path.join(tempSkillsDir, 'memory-merger', 'SKILL.md');
    const content = fs.readFileSync(skillMd, 'utf-8');
    if (!content.startsWith('---')) { console.error('FAIL: SKILL.md missing frontmatter'); pass = false; }
    else { console.log('[ok] SKILL.md frontmatter present'); }
  }
  const realDiff = afterReal.filter(x => !beforeReal.includes(x))
    .concat(beforeReal.filter(x => !afterReal.includes(x)));
  if (realDiff.length > 0) {
    console.error('FAIL: real ~/.claude/skills/ changed (pollution):', realDiff); pass = false;
  } else {
    console.log('[ok] real ~/.claude/skills/ unchanged (no pollution)');
  }
  console.log(pass ? '\n=== ALL CHECKS PASSED ===' : '\n=== FAILURES DETECTED ===');
  process.exit(pass ? 0 : 1);
} finally {
  try { fs.rmSync(tempHome, { recursive: true, force: true }); } catch {}
}
