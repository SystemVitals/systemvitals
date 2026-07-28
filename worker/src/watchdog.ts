import type { PrismaClient } from "@systemvitals/database";
import { CheckStatus } from "@systemvitals/database";
import { isCronOverdue } from "./cron.js";
import { snapshotSelectedChannelIds } from "./notification-routing.js";

export type AlertJob = {
  checkId: string;
  kind: "down" | "recovery";
  channelIds?: string[];
};

export type EnqueueAlert = (
  job: AlertJob,
  options?: { jobId: string },
) => Promise<unknown>;

export function watchdogAlertJobId(
  checkId: string,
  eventId: string,
): string {
  return `alert-down-${checkId}-${eventId}`;
}

/**
 * Sweep all UP/GRACE checks whose heartbeat window has expired.
 *
 * Overdue predicate (evaluated in JS):
 *   status IN ('UP', 'GRACE')
 *   AND lastEventAt IS NOT NULL
 *   AND lastEventAt + (periodSeconds + graceSeconds) * 1000ms < now
 *
 * For each overdue check, in a transaction:
 *   - Sets status to DOWN
 *   - Creates a DOWN CheckEvent with error="missed heartbeat"
 * After commit, enqueues one deterministic alert for that event.
 *
 * Returns the number of checks marked DOWN.
 */
export async function sweepOverdue(
  prisma: PrismaClient,
  enqueueAlert: EnqueueAlert,
  now: Date,
  signal?: AbortSignal,
): Promise<number> {
  signal?.throwIfAborted();

  // Fetch candidate checks: UP or GRACE with a known lastEventAt
  // GRACE is a reserved status (no producer yet — grace period is folded into the overdue window); kept in the predicate for a future soft-grace phase.
  const candidates = await prisma.check.findMany({
    where: {
      status: { in: [CheckStatus.UP, CheckStatus.GRACE] },
      lastEventAt: { not: null },
      OR: [{ periodSeconds: { not: null } }, { schedule: { not: null } }],
    },
    select: {
      id: true,
      lastEventAt: true,
      periodSeconds: true,
      graceSeconds: true,
      schedule: true,
      tz: true,
    },
  });
  signal?.throwIfAborted();

  // Filter overdue in JS to avoid DB-dialect interval syntax
  const overdue = candidates.filter((check) => {
    const grace = check.graceSeconds ?? 0;
    if (check.schedule) {
      try {
        return isCronOverdue(check.lastEventAt!, check.schedule, check.tz ?? "UTC", grace, now);
      } catch {
        return false; // malformed schedule: never crash the sweep
      }
    }
    if (check.periodSeconds == null) return false;
    return check.lastEventAt!.getTime() + (check.periodSeconds + grace) * 1000 < now.getTime();
  });

  let count = 0;

  for (const check of overdue) {
    signal?.throwIfAborted();

    // Locking serializes this transition and routing snapshot with check
    // notification toggles. Between the candidate read and this write, the
    // check may also have been converted away from HEARTBEAT or resolved by a
    // real ping, so retain the conditional update guard after the locked
    // re-read.
    const transition = await prisma.$transaction(async (tx) => {
      signal?.throwIfAborted();
      await tx.$queryRaw`
        SELECT id
        FROM checks
        WHERE id = ${check.id}
        FOR UPDATE
      `;
      signal?.throwIfAborted();
      const current = await tx.check.findUnique({
        where: { id: check.id },
        select: { id: true, projectId: true },
      });
      signal?.throwIfAborted();

      if (current == null) {
        return undefined;
      }

      const result = await tx.check.updateMany({
        where: {
          id: check.id,
          status: { in: [CheckStatus.UP, CheckStatus.GRACE] },
          OR: [{ periodSeconds: { not: null } }, { schedule: { not: null } }],
        },
        data: { status: CheckStatus.DOWN },
      });
      signal?.throwIfAborted();

      if (result.count === 0) {
        return undefined;
      }

      // Write a DOWN CheckEvent
      signal?.throwIfAborted();
      const event = await tx.checkEvent.create({
        data: {
          checkId: check.id,
          status: CheckStatus.DOWN,
          error: "missed heartbeat",
        },
        select: { id: true },
      });
      signal?.throwIfAborted();

      const channelIds = await snapshotSelectedChannelIds(tx, current);
      signal?.throwIfAborted();

      return { eventId: event.id, channelIds };
    });

    if (!transition) {
      continue;
    }

    // Once the DOWN transition and event commit, always attempt its
    // corresponding idempotent alert. Lease cancellation may fence future
    // checks, but must not strand this committed transition.
    await enqueueAlert(
      {
        checkId: check.id,
        kind: "down",
        channelIds: transition.channelIds,
      },
      { jobId: watchdogAlertJobId(check.id, transition.eventId) },
    );

    count++;
  }

  return count;
}
