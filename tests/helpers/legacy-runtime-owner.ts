/**
 * Legacy resolver kept ONLY as a test fixture.
 *
 * Production code uses `resolvePerMessageRuntimeOwner` from
 * `src/runtime-owner.ts` — that helper additionally admin-gates the sender
 * (active + role=admin) so non-admin senders on `web:main + isHome`
 * correctly fall back to `created_by` like the cold-start path. Pre-fix
 * divergence (#24 round-16 P2-1) made the same `/foo` command behave
 * differently when the runner was active vs idle.
 *
 * This helper exists so the routing-bugs test suite can keep exercising
 * the legacy precedence rule directly, without leaking a deprecated public
 * API back into src/ where it could be re-imported by mistake (PR#487
 * review #9, codex follow-up).
 */
export function resolvePluginRuntimeOwner(args: {
  groupJid: string;
  isHome?: boolean | null;
  createdBy?: string | null;
  senderUserId?: string | null;
}): string | null {
  const hashIdx = args.groupJid.indexOf('#');
  const baseJid = hashIdx >= 0 ? args.groupJid.slice(0, hashIdx) : args.groupJid;
  const isAdminSharedHome = baseJid === 'web:main' && args.isHome === true;
  const owner = isAdminSharedHome
    ? (args.senderUserId ?? args.createdBy ?? null)
    : (args.createdBy ?? args.senderUserId ?? null);
  return owner || null;
}
