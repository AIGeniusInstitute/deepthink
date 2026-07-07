import crypto from 'crypto';

const IPC_SEND_DEDUP_TTL_MS = 10 * 60_000;
const IPC_SEND_DEDUP_MAX = 500;

export interface IpcSendDedupDeps {
  getRetryCount(jid: string): number;
  getJidsByFolder(folder: string): string[];
  now?: () => number;
}

export function createIpcSendDeduplicator(deps: IpcSendDedupDeps): {
  isRetryDuplicate(sourceGroup: string, chatJid: string, text: string): boolean;
} {
  const recentSends = new Map<string, number>(); // key -> expireAt
  const now = deps.now ?? Date.now;

  return {
    isRetryDuplicate(
      sourceGroup: string,
      chatJid: string,
      text: string,
    ): boolean {
      const key = `${sourceGroup}|${chatJid}|${crypto
        .createHash('md5')
        .update(text)
        .digest('hex')}`;
      const currentTime = now();
      const exp = recentSends.get(key);
      // retryCount lives on the original chatJid used at enqueue time. For IM
      // jids such as feishu:oc_xxx, folder-only guesses miss the active retry.
      let inRetry =
        deps.getRetryCount(`web:${sourceGroup}`) > 0 ||
        deps.getRetryCount(sourceGroup) > 0;
      if (!inRetry) {
        for (const jid of deps.getJidsByFolder(sourceGroup)) {
          if (deps.getRetryCount(jid) > 0) {
            inRetry = true;
            break;
          }
        }
      }
      const isDup = !!(exp && exp > currentTime) && inRetry;
      recentSends.set(key, currentTime + IPC_SEND_DEDUP_TTL_MS);
      for (const k of recentSends.keys()) {
        if (recentSends.size <= IPC_SEND_DEDUP_MAX) break;
        recentSends.delete(k);
      }
      return isDup;
    },
  };
}
