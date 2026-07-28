import type { PrismaClient } from "@systemvitals/database";
import { CheckType, CheckStatus } from "@systemvitals/database";

export type ProbeJob = {
  checkId: string;
};

export type EnqueueProbe = (
  job: ProbeJob,
  options: { jobId: string; removeOnFail: true },
) => Promise<unknown>;

/**
 * Find active HTTP/TCP checks that are due for a probe.
 *
 * Due predicate (evaluated in JS after DB fetch):
 *   type IN (HTTP, TCP)
 *   AND status != PAUSED
 *   AND intervalSeconds IS NOT NULL
 *   AND (lastEventAt IS NULL OR lastEventAt + intervalSeconds*1000ms < now)
 *
 * Heartbeat checks are excluded by the type filter.
 * PAUSED checks are excluded by the status filter.
 *
 * Returns the stable due occurrence for each due check.
 */
export async function findDueProbes(
  prisma: PrismaClient,
  now: Date,
  signal?: AbortSignal,
): Promise<{ id: string; dueKey: string }[]> {
  signal?.throwIfAborted();

  // Fetch candidate checks: HTTP or TCP, not PAUSED, with a defined interval
  const candidates = await prisma.check.findMany({
    where: {
      type: { in: [CheckType.HTTP, CheckType.TCP] },
      status: { not: CheckStatus.PAUSED },
      intervalSeconds: { not: null },
    },
    select: {
      id: true,
      createdAt: true,
      lastEventAt: true,
      intervalSeconds: true,
    },
  });
  signal?.throwIfAborted();

  // Filter due checks in JS to avoid DB-dialect interval syntax
  return candidates.flatMap((check) => {
    const dueAt =
      check.lastEventAt === null
        ? check.createdAt.getTime()
        : check.lastEventAt.getTime() +
          check.intervalSeconds! * 1000;
    if (dueAt >= now.getTime()) {
      return [];
    }
    return [{ id: check.id, dueKey: String(dueAt) }];
  });
}

export function probeJobId(checkId: string, dueKey: string): string {
  return `probe-${checkId}-${dueKey}`;
}

export async function scheduleDueProbes(
  prisma: PrismaClient,
  enqueue: EnqueueProbe,
  now: Date,
  signal: AbortSignal,
): Promise<number> {
  signal.throwIfAborted();
  const dueChecks = await findDueProbes(prisma, now, signal);
  signal.throwIfAborted();

  let enqueued = 0;
  for (const { id, dueKey } of dueChecks) {
    signal.throwIfAborted();
    await enqueue(
      { checkId: id },
      {
        jobId: probeJobId(id, dueKey),
        removeOnFail: true,
      },
    );
    enqueued += 1;
  }
  return enqueued;
}
