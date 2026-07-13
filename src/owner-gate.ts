/**
 * Pure gate that decides whether a group's messages should be processed
 * based on the owner's user status.
 *
 * A group whose creator (created_by) has been disabled or deleted by admin
 * must stop responding immediately — otherwise the bot keeps firing until
 * the next service restart (loadState only filters non-active users at
 * startup). The disconnect-on-disable path in `routes/admin.ts` handles
 * teardown of live IM connections, but inflight messages and race
 * conditions (restart timing, cache lag) still need a runtime gate.
 *
 * Returns `{ allowed: true }` when:
 * - no owner info available (legacy groups without created_by), or
 * - owner exists and `status === 'active'`.
 *
 * Returns `{ allowed: false, reason: 'inactive_owner', status }` when the
 * owner's status is anything else (`disabled` / `deleted` / unknown).
 */
export type OwnerGateResult =
  | { allowed: true }
  | { allowed: false; reason: 'inactive_owner'; status: string };

export function checkOwnerActive(
  owner: { status: string } | null | undefined,
): OwnerGateResult {
  if (!owner) return { allowed: true };
  if (owner.status === 'active') return { allowed: true };
  return { allowed: false, reason: 'inactive_owner', status: owner.status };
}
