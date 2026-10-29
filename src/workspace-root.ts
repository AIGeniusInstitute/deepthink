/**
 * Workspace Root —— 工作区根目录的唯一真相源。
 *
 * 规则：`group.customCwd || data/groups/{folder}`。
 * 此前这条规则在 routes/files.ts、routes/workspace-config.ts、
 * plugin-expander-context.ts、container-runner.ts、file-manager.ts 五处重复实现，
 * 且 script-runner.ts 完全不认 customCwd（定时脚本任务 cwd 落错目录）。
 * 所有「工作区根在哪」的判断都应从这里出。
 *
 * 安全：custom_cwd 的校验（创建/修改时）与二次校验（运行时，防 DB 注入
 * 与白名单收紧）也收敛在本文件，POST / PATCH / runHostAgent /
 * runContainerAgent 共用同一套规则。
 */
import fs from 'fs';
import path from 'path';

import { DATA_DIR, GROUPS_DIR } from './config.js';
import {
  findAllowedRoot,
  loadMountAllowlist,
  matchesBlockedPattern,
} from './mount-security.js';
import type { RegisteredGroup } from './types.js';

/**
 * 解析工作区根目录（宿主机视角的绝对路径）。
 * customCwd 优先；未设置时回落平台托管目录 data/groups/{folder}。
 */
export function resolveWorkspaceRoot(
  group: Pick<RegisteredGroup, 'folder' | 'customCwd'>,
): string {
  return group.customCwd || path.join(GROUPS_DIR, group.folder);
}

export type CustomCwdValidation =
  | { ok: true; realPath: string }
  | { ok: false; error: string; status: 400 | 403 };

/**
 * 创建 / 修改工作区时对 custom_cwd 的完整校验：
 * 绝对路径 → 存在且为目录 → realpathSync（防 symlink/TOCTOU）→
 * 白名单 allowedRoots + 敏感路径 blockedPatterns → 拒绝 DATA_DIR 内部路径。
 */
export function validateCustomCwd(customCwd: string): CustomCwdValidation {
  if (!path.isAbsolute(customCwd)) {
    return {
      ok: false,
      error: 'custom_cwd must be an absolute path',
      status: 400,
    };
  }

  let realPath: string;
  try {
    const stat = fs.statSync(customCwd);
    if (!stat.isDirectory()) {
      return {
        ok: false,
        error: 'custom_cwd must be an existing directory',
        status: 400,
      };
    }
    realPath = fs.realpathSync(customCwd);
  } catch {
    return {
      ok: false,
      error: 'custom_cwd directory does not exist',
      status: 400,
    };
  }

  // 拒绝 DeepThink 数据目录内部：那里是平台托管的 groups/{folder}、sessions、
  // ipc 等运行时数据，指向内部会造成工作区互相覆盖 / 被平台清理逻辑误删。
  let realDataDir: string | null = null;
  try {
    realDataDir = fs.realpathSync(DATA_DIR);
  } catch {
    realDataDir = DATA_DIR;
  }
  const dataRelative = path.relative(realDataDir, realPath);
  if (
    dataRelative === '' ||
    (!dataRelative.startsWith('..') && !path.isAbsolute(dataRelative))
  ) {
    return {
      ok: false,
      error: 'custom_cwd must not be inside the DeepThink data directory',
      status: 400,
    };
  }

  const allowlist = loadMountAllowlist();
  if (
    allowlist &&
    allowlist.allowedRoots &&
    allowlist.allowedRoots.length > 0
  ) {
    const allowedRoot = findAllowedRoot(realPath, allowlist.allowedRoots);
    if (!allowedRoot) {
      const allowedPaths = allowlist.allowedRoots
        .map((r) => r.path)
        .join(', ');
      return {
        ok: false,
        error: `custom_cwd must be under an allowed root. Allowed roots: ${allowedPaths}. Check config/mount-allowlist.json`,
        status: 403,
      };
    }

    const blockedMatch = matchesBlockedPattern(
      realPath,
      allowlist.blockedPatterns,
    );
    if (blockedMatch) {
      return {
        ok: false,
        error: `custom_cwd matches blocked pattern "${blockedMatch}"`,
        status: 403,
      };
    }
  }

  return { ok: true, realPath };
}

/**
 * 运行时二次校验（defense-in-depth）：web 路由在创建/修改时已校验过，
 * 但白名单可能事后收紧、路径也可能经 DB 直接注入，所以 Agent 启动前再验一遍。
 * 只针对 customCwd（默认平台目录不在白名单约束范围内）。
 */
export function checkCustomCwdAllowedAtRuntime(realPath: string): {
  ok: true;
} | { ok: false; error: string } {
  const allowlist = loadMountAllowlist();
  if (
    !allowlist ||
    !allowlist.allowedRoots ||
    allowlist.allowedRoots.length === 0
  ) {
    // 无白名单配置时与创建校验语义一致：不额外限制
    return { ok: true };
  }

  const allowedRoot = findAllowedRoot(realPath, allowlist.allowedRoots);
  if (!allowedRoot) {
    return {
      ok: false,
      error: `工作目录 ${realPath} 不在允许的根目录下，请检查 mount-allowlist.json`,
    };
  }

  const blockedMatch = matchesBlockedPattern(
    realPath,
    allowlist.blockedPatterns,
  );
  if (blockedMatch) {
    return {
      ok: false,
      error: `工作目录 ${realPath} 命中敏感路径黑名单 "${blockedMatch}"`,
    };
  }

  return { ok: true };
}
