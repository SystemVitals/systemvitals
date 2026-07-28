import type { PrismaClient } from "@systemvitals/database";
import { CheckStatus } from "@systemvitals/database";
import type { AlertJob } from "./watchdog.js";
import type { ProbeResult } from "./prober.js";

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

  const prev = check.status;

  // Run the probe
  const r = await probeFn(check);

  const newStatus: CheckStatus = r.up ? CheckStatus.UP : CheckStatus.DOWN;
  const now = new Date();

  // Write CheckEvent and update check status in a transaction
  await prisma.$transaction(async (tx) => {
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
  });

  // Enqueue alert only on status transition
  if (!r.up && prev !== CheckStatus.DOWN) {
    await enqueueAlert({ checkId, kind: "down" });
  } else if (r.up && prev === CheckStatus.DOWN) {
    await enqueueAlert({ checkId, kind: "recovery" });
  }
}
