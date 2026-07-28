export const ACCOUNT_USER_LOCK_NAMESPACE =
  'systemvitals:account-lock:v1:' as const;
export const ACCOUNT_USER_LOCK_HASH_SEED = 7_431_924_617_552_913_487n;

export function accountUserLockKey(userId: string): string {
  return `${ACCOUNT_USER_LOCK_NAMESPACE}${userId}`;
}

export function sortedUniqueUserIds(userIds: string[]): string[] {
  return [...new Set(userIds)].sort();
}
