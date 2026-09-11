import path from 'path';
import fs from 'fs';
import { randomUUID } from 'crypto';
import { DATA_DIR, GROUPS_DIR, MAX_FILE_SIZE } from './config.js';
import { deleteContainerEnvConfig } from './runtime-config.js';
import { logger } from './logger.js';

// --- Storage usage cache (5 minute TTL) ---
const _storageCache = new Map<string, { bytes: number; expires: number }>();
const STORAGE_CACHE_TTL = 5 * 60 * 1000;

function getStorageCacheKey(folder: string, rootOverride?: string): string {
  return getFileRoot(folder, rootOverride);
}

// 类型
export interface FileEntry {
  name: string;
  path: string; // 相对于 data/groups/{folder}/ 的路径
  type: 'file' | 'directory';
  size: number;
  modifiedAt: string;
  isSystem: boolean;
  absolutePath?: string; // Agent 视角的绝对路径（container 模式为 /workspace/group/...，host 模式为宿主机路径）
}

// 常量
// MAX_FILE_SIZE 统一由 config.ts 定义（可通过 MAX_FILE_SIZE_MB 环境变量配置），
// 此处 re-export 保持既有 import 路径不变。
export { MAX_FILE_SIZE };
const SYSTEM_PATHS = ['logs', 'CLAUDE.md', '.claude', 'conversations', '.trash', '.versions'];
// 预先转小写一次，匹配大小写不敏感文件系统（macOS APFS / Windows NTFS）。
const SYSTEM_PATHS_LOWER = SYSTEM_PATHS.map((p) => p.toLowerCase());

// 仅在大小写不敏感的平台启用 lowercased 比较。case-sensitive Linux 上
// 'Logs/' 与 'logs/' 是不同 inode，全局 toLowerCase 会误杀合法文件名。
// macOS / Windows 默认大小写不敏感（APFS / NTFS）→ 使用 lowercased 路径。
// 其它平台保留 strict ===。
const CASE_INSENSITIVE_FS =
  process.platform === 'darwin' || process.platform === 'win32';

/**
 * 获取会话流的文件根目录
 * @param folder 会话流文件夹名（如 main）
 * @param rootOverride 可选的自定义根目录（绝对路径），用于宿主机模式 customCwd
 * @returns 绝对路径
 */
export function getFileRoot(folder: string, rootOverride?: string): string {
  if (rootOverride && path.isAbsolute(rootOverride)) {
    return rootOverride;
  }
  return path.join(GROUPS_DIR, folder);
}

/**
 * 安全路径解析：防止路径遍历攻击
 * @param folder 会话流文件夹名
 * @param relativePath 用户提供的相对路径
 * @param rootOverride 可选的自定义根目录（绝对路径）
 * @returns 验证后的绝对路径
 * @throws 路径越界时抛出异常
 */
export function validateAndResolvePath(
  folder: string,
  relativePath: string,
  rootOverride?: string,
): string {
  const root = getFileRoot(folder, rootOverride);
  const normalized = path.normalize(relativePath);
  const resolved = path.resolve(root, normalized);

  // 使用 path.relative 检查是否在根目录内
  const relative = path.relative(root, resolved);

  if (relative.startsWith('..')) {
    throw new Error('Path traversal detected');
  }

  // 解析符号链接：沿路径向上找到最近的已存在祖先，确保其 realpath 仍在根目录内。
  // 这防止了"父级是 symlink、末级还不存在"的绕过场景。
  const realRoot = fs.existsSync(root) ? fs.realpathSync(root) : root;
  let checkPath = resolved;
  while (checkPath !== root && checkPath !== path.dirname(checkPath)) {
    if (fs.existsSync(checkPath)) {
      const realPath = fs.realpathSync(checkPath);
      if (realPath !== realRoot && !realPath.startsWith(realRoot + path.sep)) {
        throw new Error('Symlink traversal detected');
      }
      break;
    }
    checkPath = path.dirname(checkPath);
  }

  return resolved;
}

/**
 * 判断路径是否为系统路径（禁止删除）
 * @param relativePath 相对路径
 * @returns 是否为系统路径
 *
 * 平台敏感：APFS（macOS 默认）/ NTFS 上 `Logs` 与 `logs` 同 inode，必须
 * 大小写不敏感比较否则攻击者可通过大写绕过。case-sensitive Linux 上
 * 这种攻击不可达，强行 lowercased 反而误杀合法的 'Logs/' 等文件。
 */
export function isSystemPath(relativePath: string): boolean {
  const normalized = path.normalize(relativePath);
  const segments = normalized.split(path.sep).filter(Boolean);

  if (segments.length === 0) return false;

  // '.' alone is not a system path (root guard lives in deleteFile)
  if (segments.length === 1 && segments[0] === '.') return false;

  if (CASE_INSENSITIVE_FS) {
    const firstSegmentLower = segments[0].toLowerCase();
    const normalizedLower = normalized.toLowerCase();
    return SYSTEM_PATHS_LOWER.some(
      (sysPath) =>
        firstSegmentLower === sysPath || normalizedLower === sysPath,
    );
  }
  // case-sensitive 平台保持 strict 比较
  const firstSegment = segments[0];
  return SYSTEM_PATHS.some(
    (sysPath) => firstSegment === sysPath || normalized === sysPath,
  );
}

/**
 * 列出目录内容
 * @param folder 会话流文件夹名
 * @param subPath 可选的子路径
 * @param rootOverride 可选的自定义根目录（绝对路径）
 * @returns 文件列表和当前路径
 */
export function listFiles(
  folder: string,
  subPath?: string,
  rootOverride?: string,
): { files: FileEntry[]; currentPath: string } {
  const relativePath = subPath || '';
  const absolutePath = validateAndResolvePath(
    folder,
    relativePath,
    rootOverride,
  );

  // 目录不存在时返回空列表，不自动创建（避免 GET 请求产生写副作用）
  if (!fs.existsSync(absolutePath)) {
    return { files: [], currentPath: relativePath };
  }

  const stat = fs.statSync(absolutePath);
  if (!stat.isDirectory()) {
    throw new Error('Path is not a directory');
  }

  const entries = fs.readdirSync(absolutePath, { withFileTypes: true });
  const files: FileEntry[] = [];

  for (const entry of entries) {
    const name = entry.name;
    const entryPath = path.join(absolutePath, name);
    const entryRelativePath = path.join(relativePath, name);

    let stats: fs.Stats;
    try {
      stats = fs.statSync(entryPath);
    } catch {
      // Broken symlink or unreadable entry — skip rather than failing the whole
      // listing. statSync follows symlinks, so a dangling link throws ENOENT and
      // would otherwise 500 the entire directory (agent-triggerable DoS).
      continue;
    }

    files.push({
      name,
      path: entryRelativePath,
      type: stats.isDirectory() ? 'directory' : 'file',
      size: stats.size,
      modifiedAt: stats.mtime.toISOString(),
      isSystem: isSystemPath(entryRelativePath),
    });
  }

  // 文件夹在前，文件在后，按名称排序
  files.sort((a, b) => {
    if (a.type !== b.type) {
      return a.type === 'directory' ? -1 : 1;
    }
    return a.name.localeCompare(b.name);
  });

  return {
    files,
    currentPath: relativePath,
  };
}

/**
 * 删除文件或目录
 * @param folder 会话流文件夹名
 * @param relativePath 相对路径
 * @param rootOverride 可选的自定义根目录（绝对路径）
 * @throws 系统路径或路径不存在时抛出异常
 */
export function deleteFile(
  folder: string,
  relativePath: string,
  rootOverride?: string,
): void {
  // Reject empty / root-equivalent paths explicitly
  if (!relativePath || relativePath === '.' || relativePath === '/') {
    throw new Error('Cannot delete root directory');
  }

  // 检查是否为系统路径
  if (isSystemPath(relativePath)) {
    throw new Error('Cannot delete system path');
  }

  const absolutePath = validateAndResolvePath(
    folder,
    relativePath,
    rootOverride,
  );
  const root = getFileRoot(folder, rootOverride);

  // Double-check: never delete the group root itself
  if (path.resolve(absolutePath) === path.resolve(root)) {
    throw new Error('Cannot delete root directory');
  }

  if (!fs.existsSync(absolutePath)) {
    throw new Error('File or directory not found');
  }

  // Re-verify realpath right before destructive operation (TOCTOU defense-in-depth)
  const realRoot = fs.realpathSync(root);
  const realPath = fs.realpathSync(absolutePath);
  if (realPath !== realRoot && !realPath.startsWith(realRoot + path.sep)) {
    throw new Error('Symlink traversal detected');
  }
  if (realPath === realRoot) {
    throw new Error('Cannot delete root directory');
  }

  const stats = fs.statSync(absolutePath);
  if (stats.isDirectory()) {
    fs.rmSync(absolutePath, { recursive: true, force: true });
  } else {
    fs.unlinkSync(absolutePath);
  }
}

/**
 * 创建目录
 * @param folder 会话流文件夹名
 * @param parentPath 父目录相对路径
 * @param name 新目录名称
 * @param rootOverride 可选的自定义根目录（绝对路径）
 * @throws 目录已存在时抛出异常
 */
export function createDirectory(
  folder: string,
  parentPath: string,
  name: string,
  rootOverride?: string,
): void {
  const targetPath = path.join(parentPath, name);

  // 禁止在系统路径下创建目录
  if (isSystemPath(targetPath)) {
    throw new Error('Cannot create directory in system path');
  }

  const absolutePath = validateAndResolvePath(folder, targetPath, rootOverride);

  if (fs.existsSync(absolutePath)) {
    throw new Error('Directory already exists');
  }

  fs.mkdirSync(absolutePath, { recursive: true });
  // chmod 0o777 确保容器（node/1000）与宿主机用户均可读写
  // 与 container-runner.ts 的 mkdirForContainer() 行为一致
  try {
    fs.chmodSync(absolutePath, 0o777);
  } catch {
    /* 忽略只读文件系统 */
  }
}

/**
 * 递归计算目录总大小（字节），带 5 分钟缓存
 */
export function getGroupStorageUsage(
  folder: string,
  rootOverride?: string,
): number {
  const cacheKey = getStorageCacheKey(folder, rootOverride);
  const cached = _storageCache.get(cacheKey);
  if (cached && cached.expires > Date.now()) {
    return cached.bytes;
  }

  const root = getFileRoot(folder, rootOverride);
  if (!fs.existsSync(root)) return 0;

  let totalBytes = 0;
  try {
    totalBytes = calculateDirSize(root);
  } catch (err) {
    logger.warn({ err, folder }, 'Failed to calculate storage usage');
  }

  _storageCache.set(cacheKey, {
    bytes: totalBytes,
    expires: Date.now() + STORAGE_CACHE_TTL,
  });
  return totalBytes;
}

export function invalidateGroupStorageUsage(
  folder: string,
  rootOverride?: string,
): void {
  _storageCache.delete(getStorageCacheKey(folder, rootOverride));
}

const MAX_DIR_DEPTH = 20;

function calculateDirSize(dirPath: string, depth = 0): number {
  if (depth > MAX_DIR_DEPTH) return 0;
  let total = 0;
  let entries;
  try {
    entries = fs.readdirSync(dirPath, { withFileTypes: true });
  } catch {
    return 0;
  }
  for (const entry of entries) {
    const fullPath = path.join(dirPath, entry.name);
    if (entry.isSymbolicLink()) continue; // skip symlinks to avoid loops
    if (entry.isDirectory()) {
      total += calculateDirSize(fullPath, depth + 1);
    } else if (entry.isFile()) {
      try {
        total += fs.statSync(fullPath).size;
      } catch {
        /* skip unreadable files */
      }
    }
  }
  return total;
}

/** Remove all runtime artifacts for a group folder (workspace, sessions, ipc, env, memory). */
export function removeFlowArtifacts(folder: string): void {
  fs.rmSync(path.join(GROUPS_DIR, folder), { recursive: true, force: true });
  fs.rmSync(path.join(DATA_DIR, 'sessions', folder), { recursive: true, force: true });
  fs.rmSync(path.join(DATA_DIR, 'ipc', folder), { recursive: true, force: true });
  fs.rmSync(path.join(DATA_DIR, 'env', folder), { recursive: true, force: true });
  fs.rmSync(path.join(DATA_DIR, 'memory', folder), { recursive: true, force: true });
  deleteContainerEnvConfig(folder);
}

// ---------------------------------------------------------------------------
// AgentNet Disk — 移动/重命名/搜索/回收站/版本（MVP，增量补齐）
// 纯 fs 操作；DB 元数据（file_trash/file_versions）由 routes 层编排。
// ---------------------------------------------------------------------------

/**
 * 移动文件/文件夹到另一目录。
 * @throws 目标是源子目录（循环）、重名、路径越界
 */
export function moveFile(
  folder: string,
  sourceRel: string,
  targetDirRel: string,
  rootOverride?: string,
): string {
  if (!sourceRel || sourceRel === '.' || sourceRel === '/') {
    throw new Error('Cannot move root directory');
  }
  if (isSystemPath(sourceRel) || isSystemPath(targetDirRel)) {
    throw new Error('Cannot move system path');
  }
  const srcAbs = validateAndResolvePath(folder, sourceRel, rootOverride);
  const targetDirAbs = validateAndResolvePath(folder, targetDirRel || '.', rootOverride);
  if (!fs.existsSync(srcAbs)) throw new Error('Source not found');
  if (!fs.existsSync(targetDirAbs)) {
    fs.mkdirSync(targetDirAbs, { recursive: true });
    try { fs.chmodSync(targetDirAbs, 0o777); } catch { /* read-only fs */ }
  } else if (!fs.statSync(targetDirAbs).isDirectory()) {
    throw new Error('Target is not a directory');
  }
  // 防：把父目录移进自己的子目录（循环）
  const srcResolved = path.resolve(srcAbs);
  const targetResolved = path.resolve(targetDirAbs);
  const rel = path.relative(srcResolved, targetResolved);
  if (rel === '' || !rel.startsWith('..')) {
    throw new Error('Cannot move into own subdirectory');
  }
  const name = path.basename(srcAbs);
  const destAbs = path.join(targetResolved, name);
  if (fs.existsSync(destAbs)) {
    throw new Error('File with same name already exists in target directory');
  }
  fs.renameSync(srcAbs, destAbs);
  const root = getFileRoot(folder, rootOverride);
  return path.relative(root, destAbs);
}

/**
 * 重命名文件/文件夹（同目录改名）。
 * @throws 同目录重名、路径越界、系统路径
 */
export function renameFile(
  folder: string,
  relPath: string,
  newName: string,
  rootOverride?: string,
): string {
  if (!relPath || relPath === '.' || relPath === '/') {
    throw new Error('Cannot rename root directory');
  }
  if (isSystemPath(relPath)) {
    throw new Error('Cannot rename system path');
  }
  if (!newName || !newName.trim() || /[\\/:]/.test(newName)) {
    throw new Error('Invalid new name');
  }
  const srcAbs = validateAndResolvePath(folder, relPath, rootOverride);
  if (!fs.existsSync(srcAbs)) throw new Error('File or directory not found');
  const destAbs = path.join(path.dirname(srcAbs), newName);
  if (path.resolve(destAbs) === path.resolve(srcAbs)) {
    // 同名无变化
    return relPath;
  }
  if (fs.existsSync(destAbs)) {
    throw new Error('File with same name already exists');
  }
  fs.renameSync(srcAbs, destAbs);
  const root = getFileRoot(folder, rootOverride);
  return path.relative(root, destAbs);
}

/**
 * 递归按文件名搜索（在当前工作区内）。返回 FileEntry[]。
 * 跳过系统路径（logs/.claude/.trash/.versions 等）。
 */
export function searchFiles(
  folder: string,
  query: string,
  rootOverride?: string,
  maxResults = 200,
): FileEntry[] {
  const root = getFileRoot(folder, rootOverride);
  if (!fs.existsSync(root) || !query) return [];
  const q = query.toLowerCase();
  const results: FileEntry[] = [];
  const walk = (dir: string, depth: number) => {
    if (depth > MAX_DIR_DEPTH || results.length >= maxResults) return;
    let entries: fs.Dirent[];
    try { entries = fs.readdirSync(dir, { withFileTypes: true }); } catch { return; }
    for (const entry of entries) {
      if (results.length >= maxResults) return;
      if (entry.isSymbolicLink()) continue;
      const full = path.join(dir, entry.name);
      const rel = path.relative(root, full);
      if (isSystemPath(rel)) continue;
      if (entry.name.toLowerCase().includes(q)) {
        try {
          const st = fs.statSync(full);
          results.push({
            name: entry.name,
            path: rel,
            type: st.isDirectory() ? 'directory' : 'file',
            size: st.size,
            modifiedAt: st.mtime.toISOString(),
            isSystem: false,
          });
        } catch { /* skip unreadable */ }
      }
      if (entry.isDirectory()) walk(full, depth + 1);
    }
  };
  walk(root, 0);
  results.sort((a, b) => a.name.localeCompare(b.name));
  return results;
}

/**
 * 将文件/文件夹移入回收站目录 .trash/{trashId}/，返回 trashId 与原 FileEntry 快照。
 * 不写 DB（由路由层 INSERT file_trash）。
 */
export function moveToTrash(
  folder: string,
  relPath: string,
  rootOverride?: string,
): { trashId: string; originalPath: string; name: string; isFolder: boolean; sizeBytes: number; entryJson: string } {
  if (!relPath || relPath === '.' || relPath === '/') {
    throw new Error('Cannot delete root directory');
  }
  if (isSystemPath(relPath)) {
    throw new Error('Cannot delete system path');
  }
  const abs = validateAndResolvePath(folder, relPath, rootOverride);
  const root = getFileRoot(folder, rootOverride);
  if (path.resolve(abs) === path.resolve(root)) {
    throw new Error('Cannot delete root directory');
  }
  if (!fs.existsSync(abs)) throw new Error('File or directory not found');

  // TOCTOU defense-in-depth
  const realRoot = fs.realpathSync(root);
  const realPath = fs.realpathSync(abs);
  if (realPath !== realRoot && !realPath.startsWith(realRoot + path.sep)) {
    throw new Error('Symlink traversal detected');
  }
  if (realPath === realRoot) throw new Error('Cannot delete root directory');

  const trashId = randomUUID();
  const trashRoot = path.join(root, '.trash');
  const trashDir = path.join(trashRoot, trashId);
  fs.mkdirSync(trashDir, { recursive: true });
  try { fs.chmodSync(trashDir, 0o777); } catch { /* read-only fs */ }

  const stats = fs.statSync(abs);
  const sizeBytes = stats.isDirectory() ? calculateDirSize(abs) : stats.size;
  const entryJson = JSON.stringify({
    name: path.basename(relPath),
    path: relPath,
    type: stats.isDirectory() ? 'directory' : 'file',
    size: sizeBytes,
    modifiedAt: stats.mtime.toISOString(),
    isSystem: false,
  });

  const dest = path.join(trashDir, path.basename(abs));
  fs.renameSync(abs, dest);
  return {
    trashId,
    originalPath: relPath,
    name: path.basename(relPath),
    isFolder: stats.isDirectory(),
    sizeBytes,
    entryJson,
  };
}

/**
 * 从回收站恢复文件/文件夹到原路径。路径冲突时加 _restored 后缀。
 * 返回最终恢复路径。不删 DB（由路由层）。
 */
export function restoreFromTrash(
  folder: string,
  trashId: string,
  originalPath: string,
  rootOverride?: string,
): { restoredPath: string; name: string } {
  const root = getFileRoot(folder, rootOverride);
  const trashDir = path.join(root, '.trash', trashId);
  if (!fs.existsSync(trashDir)) throw new Error('Trash entry not found');
  // trashDir 内只有一个根条目
  const entries = fs.readdirSync(trashDir, { withFileTypes: true });
  if (entries.length === 0) throw new Error('Trash entry empty');
  const item = entries[0];
  const srcAbs = path.join(trashDir, item.name);

  let targetRel = originalPath;
  let targetAbs = validateAndResolvePath(folder, targetRel, rootOverride);
  // 路径冲突加后缀
  if (fs.existsSync(targetAbs)) {
    const ext = path.extname(originalPath);
    const base = path.join(path.dirname(originalPath), path.basename(originalPath, ext));
    let suffix = 1;
    do {
      targetRel = `${base}_restored${suffix > 1 ? suffix : ''}${ext}`;
      targetAbs = validateAndResolvePath(folder, targetRel, rootOverride);
      suffix++;
    } while (fs.existsSync(targetAbs));
  }
  fs.mkdirSync(path.dirname(targetAbs), { recursive: true });
  try { fs.chmodSync(path.dirname(targetAbs), 0o777); } catch { /* read-only fs */ }
  fs.renameSync(srcAbs, targetAbs);
  // 清理空 trashDir
  try { fs.rmSync(trashDir, { recursive: true, force: true }); } catch { /* ignore */ }
  return { restoredPath: targetRel, name: path.basename(targetRel) };
}

/**
 * 彻底删除回收站条目（物理 rm .trash/{trashId}/）。不删 DB。
 */
export function purgeTrashItem(
  folder: string,
  trashId: string,
  rootOverride?: string,
): void {
  const root = getFileRoot(folder, rootOverride);
  const trashDir = path.join(root, '.trash', trashId);
  const realRoot = fs.existsSync(root) ? fs.realpathSync(root) : root;
  if (!fs.existsSync(trashDir)) throw new Error('Trash entry not found');
  const realTrash = fs.realpathSync(trashDir);
  if (realTrash !== path.join(realRoot, '.trash', trashId) && !realTrash.startsWith(path.join(realRoot, '.trash') + path.sep)) {
    throw new Error('Symlink traversal detected');
  }
  fs.rmSync(trashDir, { recursive: true, force: true });
}

// --- 版本历史 ---

/**
 * 为文件保存一个版本快照（将当前磁盘内容复制到 .versions/{base64path}/{n}.bin）。
 * 调用时机：PUT content/binary 写入新内容**之前**，把旧内容存档。
 * 返回快照的 content_ref 相对路径与大小。
 */
export function saveVersionSnapshot(
  folder: string,
  relPath: string,
  rootOverride?: string,
): { contentRef: string; sizeBytes: number; versionNum: number } | null {
  const abs = validateAndResolvePath(folder, relPath, rootOverride);
  if (!fs.existsSync(abs)) return null;
  const st = fs.statSync(abs);
  if (st.isDirectory()) return null;
  const root = getFileRoot(folder, rootOverride);
  const pathKey = Buffer.from(relPath).toString('base64url');
  const versionsDir = path.join(root, '.versions', pathKey);
  fs.mkdirSync(versionsDir, { recursive: true });
  try { fs.chmodSync(versionsDir, 0o777); } catch { /* read-only fs */ }
  // 计算版本号 = 现有版本数 + 1
  const existing = fs.readdirSync(versionsDir).map((f) => parseInt(f, 10)).filter((n) => !isNaN(n));
  const nextNum = existing.length === 0 ? 1 : Math.max(...existing) + 1;
  const refFile = path.join(versionsDir, `${nextNum}.bin`);
  fs.copyFileSync(abs, refFile);
  return {
    contentRef: path.join('.versions', pathKey, `${nextNum}.bin`),
    sizeBytes: st.size,
    versionNum: nextNum,
  };
}

/**
 * 读取指定版本内容（Buffer）。
 */
export function readVersionContent(
  folder: string,
  relPath: string,
  versionNum: number,
  rootOverride?: string,
): Buffer {
  const root = getFileRoot(folder, rootOverride);
  const pathKey = Buffer.from(relPath).toString('base64url');
  const refFile = path.join(root, '.versions', pathKey, `${versionNum}.bin`);
  if (!fs.existsSync(refFile)) throw new Error('Version not found');
  return fs.readFileSync(refFile);
}

/**
 * 删除超过保留数的旧版本快照（物理删 .versions/{path}/{n}.bin）。
 */
export function pruneVersionSnapshots(
  folder: string,
  relPath: string,
  keepVersions: number,
  rootOverride?: string,
): void {
  const root = getFileRoot(folder, rootOverride);
  const pathKey = Buffer.from(relPath).toString('base64url');
  const versionsDir = path.join(root, '.versions', pathKey);
  if (!fs.existsSync(versionsDir)) return;
  const files = fs.readdirSync(versionsDir).map((f) => parseInt(f, 10)).filter((n) => !isNaN(n));
  if (files.length <= keepVersions) return;
  // 删除最小的（最旧的）
  const toDelete = files.sort((a, b) => a - b).slice(0, files.length - keepVersions);
  for (const num of toDelete) {
    try { fs.unlinkSync(path.join(versionsDir, `${num}.bin`)); } catch { /* ignore */ }
  }
}

/**
 * 清空整个回收站（物理 rm .trash/）。不删 DB。
 */
export function emptyTrash(folder: string, rootOverride?: string): void {
  const root = getFileRoot(folder, rootOverride);
  const trashRoot = path.join(root, '.trash');
  if (!fs.existsSync(trashRoot)) return;
  const realRoot = fs.existsSync(root) ? fs.realpathSync(root) : root;
  const realTrash = fs.realpathSync(trashRoot);
  if (realTrash !== path.join(realRoot, '.trash')) {
    throw new Error('Symlink traversal detected');
  }
  fs.rmSync(trashRoot, { recursive: true, force: true });
  fs.mkdirSync(trashRoot, { recursive: true });
}
