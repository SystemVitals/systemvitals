import type { Prisma } from '@systemvitals/database';

const PROJECT_CHECK_STATUS_LOCK_NAMESPACE =
  'systemvitals:project-check-status:v1:' as const;
const PROJECT_CHECK_STATUS_LOCK_HASH_SEED = 5_819_304_772_641_085_239n;

/**
 * Serializes check moves with status-page check-list validation and writes.
 *
 * Callers that already hold broader locks use this global order:
 * creator accounts -> check row -> membership rows -> sorted project
 * coordination locks -> status-page rows. Status-page create/update begin at
 * the project coordination lock and never acquire creator-account or check
 * row locks, so they cannot form the reverse side of a lock cycle.
 */
export async function lockProjectCheckStatusChanges(
  tx: Prisma.TransactionClient,
  projectIds: string[],
): Promise<void> {
  for (const projectId of [...new Set(projectIds)].sort()) {
    const lockKey = `${PROJECT_CHECK_STATUS_LOCK_NAMESPACE}${projectId}`;
    await tx.$queryRaw`
      SELECT CAST(
        pg_advisory_xact_lock(
          hashtextextended(
            ${lockKey},
            ${PROJECT_CHECK_STATUS_LOCK_HASH_SEED}
          )
        ) AS TEXT
      ) AS locked
    `;
  }
}
