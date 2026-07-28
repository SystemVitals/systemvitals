import type { PrismaClient } from "@systemvitals/database";
import { describe, expect, it, vi } from "vitest";
import {
  findDueProbes,
  probeJobId,
  scheduleDueProbes,
} from "../src/probe-scheduler.js";
import { TrackedScheduler } from "../src/tracked-scheduler.js";
import {
  sweepOverdue,
  watchdogAlertJobId,
} from "../src/watchdog.js";

function fakePrisma(value: unknown): PrismaClient {
  return value as PrismaClient;
}

const overdueHeartbeat = {
  id: "heartbeat-check",
  lastEventAt: new Date(0),
  periodSeconds: 60,
  graceSeconds: 0,
  schedule: null,
  tz: null,
};

describe("TrackedScheduler", () => {
  it("waits for active lease runs and refuses new runs after stop", async () => {
    let finishRun!: () => void;
    const activeRun = new Promise<void>((resolve) => {
      finishRun = resolve;
    });
    const reportError = vi.fn();
    const scheduler = new TrackedScheduler(reportError);
    const firstTask = vi.fn(() => activeRun);
    const lateTask = vi.fn().mockResolvedValue(undefined);
    let stopped = false;

    scheduler.run(firstTask);
    const stopping = scheduler.stop().then(() => {
      stopped = true;
    });
    scheduler.run(lateTask);
    await Promise.resolve();

    expect(firstTask).toHaveBeenCalledOnce();
    expect(lateTask).not.toHaveBeenCalled();
    expect(stopped).toBe(false);

    finishRun();
    await stopping;

    expect(stopped).toBe(true);
    expect(reportError).not.toHaveBeenCalled();
  });

  it("handles scheduler failures without leaving a rejected task unobserved", async () => {
    const error = new Error("scheduler failed");
    const reportError = vi.fn();
    const scheduler = new TrackedScheduler(reportError);

    scheduler.run(async () => {
      throw error;
    });
    await scheduler.stop();

    expect(reportError).toHaveBeenCalledWith(error);
  });

  it("aborts active callbacks and fences side effects when stopped", async () => {
    let finishRead!: () => void;
    const read = new Promise<void>((resolve) => {
      finishRead = resolve;
    });
    let observedSignal: AbortSignal | undefined;
    const sideEffect = vi.fn();
    const reportError = vi.fn();
    const scheduler = new TrackedScheduler(reportError);

    scheduler.run(async (signal) => {
      observedSignal = signal;
      await read;
      signal.throwIfAborted();
      sideEffect();
    });
    await Promise.resolve();

    const stopping = scheduler.stop();
    expect(observedSignal?.aborted).toBe(true);
    finishRead();
    await stopping;

    expect(sideEffect).not.toHaveBeenCalled();
    expect(reportError).not.toHaveBeenCalled();
  });
});

describe("probe scheduler lease fencing", () => {
  it("checks ownership before and after the due-check database query", async () => {
    const beforeQuery = new AbortController();
    beforeQuery.abort(new Error("lease lost before query"));
    const findMany = vi.fn().mockResolvedValue([]);
    const prisma = fakePrisma({ check: { findMany } });

    await expect(
      findDueProbes(prisma, new Date(), beforeQuery.signal),
    ).rejects.toThrow("lease lost before query");
    expect(findMany).not.toHaveBeenCalled();

    const afterQuery = new AbortController();
    findMany.mockImplementationOnce(async () => {
      afterQuery.abort(new Error("lease lost after query"));
      return [];
    });

    await expect(
      findDueProbes(prisma, new Date(), afterQuery.signal),
    ).rejects.toThrow("lease lost after query");
  });

  it("deduplicates adjacent polling windows by due occurrence and permits a future occurrence", async () => {
    const initialState = {
      id: "check-a",
      createdAt: new Date(0),
      lastEventAt: null,
      intervalSeconds: 60,
    };
    const prisma = fakePrisma({
      check: {
        findMany: vi
          .fn()
          .mockResolvedValueOnce([initialState])
          .mockResolvedValueOnce([initialState])
          .mockResolvedValueOnce([
            {
              ...initialState,
              lastEventAt: new Date(70_000),
            },
          ]),
      },
    });
    const enqueue = vi.fn().mockResolvedValue(undefined);
    const signal = new AbortController().signal;

    await scheduleDueProbes(prisma, enqueue, new Date(60_001), signal);
    await scheduleDueProbes(prisma, enqueue, new Date(75_001), signal);
    await scheduleDueProbes(prisma, enqueue, new Date(130_001), signal);

    const jobIds = enqueue.mock.calls.map(
      ([, options]) => options.jobId as string,
    );
    expect(jobIds).toEqual([
      probeJobId("check-a", "0"),
      probeJobId("check-a", "0"),
      probeJobId("check-a", "130000"),
    ]);
  });

  it("deduplicates active and retrying probes but requeues the same occurrence after terminal failure", async () => {
    const dueCheck = {
      id: "check-a",
      createdAt: new Date(0),
      lastEventAt: null,
      intervalSeconds: 60,
    };
    const prisma = fakePrisma({
      check: {
        findMany: vi.fn().mockResolvedValue([dueCheck]),
      },
    });
    const jobs = new Map<
      string,
      { state: "active" | "retrying"; removeOnFail?: boolean }
    >();
    const createdJobIds: string[] = [];
    const enqueue = vi.fn(
      async (
        _job: { checkId: string },
        options: { jobId: string; removeOnFail?: boolean },
      ) => {
        const existing = jobs.get(options.jobId);
        if (existing) {
          return existing;
        }
        const created = {
          state: "active" as const,
          removeOnFail: options.removeOnFail,
        };
        jobs.set(options.jobId, created);
        createdJobIds.push(options.jobId);
        return created;
      },
    );
    const signal = new AbortController().signal;
    const jobId = probeJobId("check-a", "0");

    await scheduleDueProbes(prisma, enqueue, new Date(60_001), signal);
    await scheduleDueProbes(prisma, enqueue, new Date(75_001), signal);
    jobs.set(jobId, { ...jobs.get(jobId)!, state: "retrying" });
    await scheduleDueProbes(prisma, enqueue, new Date(90_001), signal);

    expect(createdJobIds).toEqual([jobId]);

    const failed = jobs.get(jobId);
    if (failed?.removeOnFail === true) {
      jobs.delete(jobId);
    }
    await scheduleDueProbes(prisma, enqueue, new Date(105_001), signal);

    expect(createdJobIds).toEqual([jobId, jobId]);
  });

  it("checks ownership before every probe enqueue", async () => {
    const controller = new AbortController();
    const prisma = fakePrisma({
      check: {
        findMany: vi.fn().mockResolvedValue([
          {
            id: "check-a",
            createdAt: new Date(0),
            lastEventAt: null,
            intervalSeconds: 60,
          },
          {
            id: "check-b",
            createdAt: new Date(0),
            lastEventAt: null,
            intervalSeconds: 60,
          },
        ]),
      },
    });
    const enqueue = vi.fn(async () => {
      controller.abort(new Error("lease lost between enqueues"));
    });

    await expect(
      scheduleDueProbes(
        prisma,
        enqueue,
        new Date(60_001),
        controller.signal,
      ),
    ).rejects.toThrow("lease lost between enqueues");

    expect(enqueue).toHaveBeenCalledOnce();
    expect(enqueue).toHaveBeenCalledWith(
      { checkId: "check-a" },
      {
        jobId: probeJobId("check-a", "0"),
        removeOnFail: true,
      },
    );
  });
});

describe("watchdog lease fencing", () => {
  it("does not start writes when ownership is lost after the candidate query", async () => {
    const controller = new AbortController();
    const transaction = vi.fn();
    const prisma = fakePrisma({
      check: {
        findMany: vi.fn(async () => {
          controller.abort(new Error("lease lost after watchdog query"));
          return [overdueHeartbeat];
        }),
      },
      $transaction: transaction,
    });

    await expect(
      sweepOverdue(
        prisma,
        vi.fn(),
        new Date(120_000),
        controller.signal,
      ),
    ).rejects.toThrow("lease lost after watchdog query");
    expect(transaction).not.toHaveBeenCalled();
  });

  it("checks ownership after a write query so its transaction rolls back before the next side effect", async () => {
    const controller = new AbortController();
    const createEvent = vi.fn();
    const prisma = fakePrisma({
      check: { findMany: vi.fn().mockResolvedValue([overdueHeartbeat]) },
      $transaction: async (
        callback: (transaction: unknown) => Promise<unknown>,
      ) =>
        callback({
          check: {
            updateMany: vi.fn(async () => {
              controller.abort(new Error("lease lost during watchdog write"));
              return { count: 1 };
            }),
          },
          checkEvent: { create: createEvent },
        }),
    });

    await expect(
      sweepOverdue(
        prisma,
        vi.fn(),
        new Date(120_000),
        controller.signal,
      ),
    ).rejects.toThrow("lease lost during watchdog write");
    expect(createEvent).not.toHaveBeenCalled();
  });

  it("enqueues the committed DOWN event even when ownership is lost after commit", async () => {
    const controller = new AbortController();
    const enqueue = vi.fn().mockResolvedValue(undefined);
    const prisma = fakePrisma({
      check: { findMany: vi.fn().mockResolvedValue([overdueHeartbeat]) },
      $transaction: vi.fn(async (callback) => {
        const result = await callback({
          check: {
            updateMany: vi.fn().mockResolvedValue({ count: 1 }),
          },
          checkEvent: {
            create: vi.fn().mockResolvedValue({ id: "down-event-1" }),
          },
        });
        controller.abort(new Error("lease lost after watchdog commit"));
        return result;
      }),
    });

    await expect(
      sweepOverdue(prisma, enqueue, new Date(120_000), controller.signal),
    ).resolves.toBe(1);
    expect(enqueue).toHaveBeenCalledWith(
      { checkId: "heartbeat-check", kind: "down" },
      {
        jobId: watchdogAlertJobId(
          "heartbeat-check",
          "down-event-1",
        ),
      },
    );
  });
});
