/**
 * 任务工具函数
 */

/**
 * 解析任务的所有者 ID
 * 优先级：task.created_by > sourceGroup.created_by > targetGroup.created_by
 */
export function resolveTaskOwner(
  task: { created_by?: string | null },
  sourceGroup?: { created_by?: string | null },
  targetGroup?: { created_by?: string | null },
): string | undefined {
  return (
    task.created_by ||
    sourceGroup?.created_by ||
    targetGroup?.created_by ||
    undefined
  );
}
