import type { PrismaClient } from "@systemvitals/database";
import { CheckStatus } from "@systemvitals/database";
import type { AlertJob } from "./watchdog.js";
import type { ProbeResult } from "./prober.js";
import { snapshotSelectedChannelIds } from "./notification-routing.js";

type EnqueueAlert = (job: AlertJob) => Promise<unknown>;

type ProbeFn = (check: {
  type: string;
  target: string | null | undefined;
  method?: string | null;
  expectedStatus?: number | null;
  timeoutMs?: number | null;
}) => Promise<ProbeResult>;

export async function handleProbe(
  prisma: PrismaClient,
  enqueueAlert: EnqueueAlert,
  probeFn: ProbeFn,
  data: { checkId: string },
): Promise<void> {
  const { checkId } = data;

  // Load the check
  const check = await prisma.check.findUnique({
    where: { id: checkId },
  });

  // Skip if missing or PAUSED
  if (check == null || check.status === CheckStatus.PAUSED) {
    return;
  }

  // The job was enqueued for an HTTP/TCP check, but `type` is now mutable —
  // between enqueue and this run the check may have been converted (e.g. to
  // HEARTBEAT). `probeFn` has no prober for a non-active type and would
  // otherwise degrade to `{ up: false, error: "Unsupported probe type" }`,
  // which this handler would commit as a real DOWN: a spurious event, a
  // status flip, and a down alert to every channel. Bail out before probing.
  if (check.type !== "HTTP" && check.type !== "TCP") {
    return;
  }

  // Run the probe
  const r = await probeFn(check);

  const newStatus: CheckStatus = r.up ? CheckStatus.UP : CheckStatus.DOWN;
  const now = new Date();

  // Lock and re-read after the probe so mutable check state and notification
  // routing are committed as one transition-time snapshot.
  const alert = await prisma.$transaction(async (tx) => {
    await tx.$queryRaw`
      SELECT id
      FROM checks
      WHERE id = ${checkId}
      FOR UPDATE
    `;
    const current = await tx.check.findUnique({
      where: { id: checkId },
    });

    if (
      current == null ||
      current.status === CheckStatus.PAUSED ||
      (current.type !== "HTTP" && current.type !== "TCP")
    ) {
      return undefined;
    }

    await tx.checkEvent.create({
      data: {
        checkId,
        status: newStatus,
        responseTimeMs: r.responseTimeMs,
        statusCode: r.statusCode ?? null,
        error: r.error ?? null,
      },
    });

    await tx.check.update({
      where: { id: checkId },
      data: {
        status: newStatus,
        lastEventAt: now,
      },
    });

    let kind: AlertJob["kind"] | undefined;
    if (!r.up && current.status !== CheckStatus.DOWN) {
      kind = "down";
    } else if (r.up && current.status === CheckStatus.DOWN) {
      kind = "recovery";
    }

    if (kind === undefined) {
      return undefined;
    }

    const channelIds = await snapshotSelectedChannelIds(tx, current);
    return { checkId, kind, channelIds } satisfies AlertJob;
  });

  if (alert !== undefined) {
    await enqueueAlert(alert);
  }
}
