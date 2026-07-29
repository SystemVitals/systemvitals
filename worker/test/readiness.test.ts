import {
  access,
  mkdtemp,
  readFile,
  readdir,
  rm,
  writeFile,
} from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import { establishWorkerReadiness, ReadinessMarker } from "../src/readiness.js";

function deferred(): {
  promise: Promise<void>;
  resolve: () => void;
  reject: (error: Error) => void;
} {
  let resolve!: () => void;
  let reject!: (error: Error) => void;
  const promise = new Promise<void>((resolvePromise, rejectPromise) => {
    resolve = resolvePromise;
    reject = rejectPromise;
  });
  return { promise, resolve, reject };
}

async function expectMissing(path: string): Promise<void> {
  await expect(access(path)).rejects.toMatchObject({ code: "ENOENT" });
}

describe("worker readiness", () => {
  const temporaryDirectories: string[] = [];

  afterEach(async () => {
    vi.useRealTimers();
    await Promise.all(
      temporaryDirectories
        .splice(0)
        .map((path) => rm(path, { recursive: true, force: true })),
    );
  });

  async function testMarker(): Promise<{
    directory: string;
    marker: ReadinessMarker;
    path: string;
  }> {
    const directory = await mkdtemp(join(tmpdir(), "systemvitals-readiness-"));
    temporaryDirectories.push(directory);
    const path = join(directory, "worker-ready");
    return {
      directory,
      marker: new ReadinessMarker(path),
      path,
    };
  }

  it("keeps the overridden marker absent until Prisma, Redis, and every worker are ready", async () => {
    const { marker, path } = await testMarker();
    const prismaReady = deferred();
    const redisReady = deferred();
    const workerOneReady = deferred();
    const workerTwoReady = deferred();
    const workerOne = {
      start: vi.fn(),
      waitUntilReady: vi.fn(() => workerOneReady.promise),
    };
    const workerTwo = {
      start: vi.fn(),
      waitUntilReady: vi.fn(() => workerTwoReady.promise),
    };

    const startup = establishWorkerReadiness({
      marker,
      checkPrisma: () => prismaReady.promise,
      checkRedis: () => redisReady.promise,
      workers: [workerOne, workerTwo],
    });

    await expectMissing(path);
    prismaReady.resolve();
    await Promise.resolve();
    await expectMissing(path);
    redisReady.resolve();
    await Promise.resolve();
    await expectMissing(path);
    expect(workerOne.start).toHaveBeenCalledOnce();
    expect(workerTwo.start).toHaveBeenCalledOnce();
    workerOneReady.resolve();
    await Promise.resolve();
    await expectMissing(path);
    workerTwoReady.resolve();

    await startup;

    await expect(readFile(path, "utf8")).resolves.toBe("ready\n");
    expect(workerOne.waitUntilReady).toHaveBeenCalledOnce();
    expect(workerTwo.waitUntilReady).toHaveBeenCalledOnce();
    expect(workerOne.start.mock.invocationCallOrder[0]).toBeLessThan(
      workerOne.waitUntilReady.mock.invocationCallOrder[0]!,
    );
    expect(workerTwo.start.mock.invocationCallOrder[0]).toBeLessThan(
      workerTwo.waitUntilReady.mock.invocationCallOrder[0]!,
    );
  });

  it("finishes dependency checks before starting consumers and publishing readiness", async () => {
    const { marker } = await testMarker();
    const order: string[] = [];
    vi.spyOn(marker, "markReady").mockImplementation(async () => {
      order.push("marker");
    });
    const workers = ["one", "two"].map((name) => ({
      start: vi.fn(() => {
        order.push(`start-${name}`);
      }),
      waitUntilReady: vi.fn(async () => {
        order.push(`ready-${name}`);
      }),
    }));

    await establishWorkerReadiness({
      marker,
      checkPrisma: async () => {
        order.push("prisma");
      },
      checkRedis: async () => {
        order.push("redis");
      },
      workers,
    });

    expect(order).toEqual([
      "prisma",
      "redis",
      "start-one",
      "start-two",
      "ready-one",
      "ready-two",
      "marker",
    ]);
  });

  it("rechecks PostgreSQL, Redis, and every consumer before refreshing the heartbeat", async () => {
    vi.useFakeTimers();
    const { marker } = await testMarker();
    const checkPrisma = vi.fn().mockResolvedValue(undefined);
    const checkRedis = vi.fn().mockResolvedValue(undefined);
    const workers = [
      {
        start: vi.fn(),
        waitUntilReady: vi.fn().mockResolvedValue(undefined),
        checkReady: vi.fn().mockResolvedValue(undefined),
      },
      {
        start: vi.fn(),
        waitUntilReady: vi.fn().mockResolvedValue(undefined),
        checkReady: vi.fn().mockResolvedValue(undefined),
      },
    ];

    await establishWorkerReadiness({
      marker,
      checkPrisma,
      checkRedis,
      workers,
    });
    checkPrisma.mockClear();
    checkRedis.mockClear();
    for (const worker of workers) {
      worker.waitUntilReady.mockClear();
      worker.checkReady.mockClear();
    }

    await vi.advanceTimersByTimeAsync(marker.heartbeatIntervalMs);

    expect(checkPrisma).toHaveBeenCalledOnce();
    expect(checkRedis).toHaveBeenCalledOnce();
    expect(workers[0]!.checkReady).toHaveBeenCalledOnce();
    expect(workers[1]!.checkReady).toHaveBeenCalledOnce();
    expect(workers[0]!.waitUntilReady).not.toHaveBeenCalled();
    expect(workers[1]!.waitUntilReady).not.toHaveBeenCalled();
    await marker.markNotReady();
  });

  it("runs startup cleanup when a consumer fails after earlier workers started", async () => {
    const { marker, path } = await testMarker();
    const closeStarted = vi.fn().mockResolvedValue(undefined);
    const closeNotStarted = vi.fn().mockResolvedValue(undefined);
    const onStartupFailure = vi.fn(async () => {
      await Promise.all([closeStarted(), closeNotStarted()]);
    });
    const startupError = new Error("second worker failed to start");

    await expect(
      establishWorkerReadiness({
        marker,
        checkPrisma: async () => {},
        checkRedis: async () => {},
        workers: [
          {
            start: vi.fn(),
            waitUntilReady: vi.fn().mockResolvedValue(undefined),
          },
          {
            start: vi.fn(() => {
              throw startupError;
            }),
            waitUntilReady: vi.fn().mockResolvedValue(undefined),
          },
        ],
        onStartupFailure,
      }),
    ).rejects.toBe(startupError);

    expect(onStartupFailure).toHaveBeenCalledOnce();
    expect(closeStarted).toHaveBeenCalledOnce();
    expect(closeNotStarted).toHaveBeenCalledOnce();
    await expectMissing(path);
  });

  it("reports startup cleanup failure alongside the startup error", async () => {
    const marker = {
      markNotReady: vi.fn().mockResolvedValue(undefined),
      markReady: vi.fn(),
    } as unknown as ReadinessMarker;
    const cleanupError = new Error("worker close failed");
    const onStartupFailure = vi.fn().mockRejectedValue(cleanupError);

    const error = await establishWorkerReadiness({
      marker,
      checkPrisma: async () => {},
      checkRedis: async () => {
        throw new Error("Redis unavailable");
      },
      workers: [],
      onStartupFailure,
    }).then(
      () => undefined,
      (caught: unknown) => caught,
    );

    expect(error).toBeInstanceOf(AggregateError);
    expect((error as AggregateError).errors).toContain(cleanupError);
    expect(onStartupFailure).toHaveBeenCalledOnce();
  });

  it("runs startup cleanup when the initial marker removal fails", async () => {
    const markerError = new Error("marker removal failed");
    const marker = {
      markNotReady: vi.fn().mockRejectedValue(markerError),
      markReady: vi.fn(),
    } as unknown as ReadinessMarker;
    const onStartupFailure = vi.fn().mockResolvedValue(undefined);

    await expect(
      establishWorkerReadiness({
        marker,
        checkPrisma: vi.fn(),
        checkRedis: vi.fn(),
        workers: [],
        onStartupFailure,
      }),
    ).rejects.toBe(markerError);

    expect(onStartupFailure).toHaveBeenCalledOnce();
  });

  it("removes a stale marker during startup and after a startup failure", async () => {
    const { marker, path } = await testMarker();
    await writeFile(path, "stale\n");

    await expect(
      establishWorkerReadiness({
        marker,
        checkPrisma: async () => {},
        checkRedis: async () => {
          throw new Error("Redis unavailable");
        },
        workers: [],
      }),
    ).rejects.toThrow("Redis unavailable");

    await expectMissing(path);
  });

  it("does not publish readiness when shutdown is requested during startup", async () => {
    const { marker, path } = await testMarker();
    const controller = new AbortController();

    await expect(
      establishWorkerReadiness({
        marker,
        checkPrisma: async () => {},
        checkRedis: async () => {},
        workers: [
          {
            start: () => {},
            waitUntilReady: async () => {
              controller.abort(new Error("shutdown requested"));
            },
          },
        ],
        signal: controller.signal,
      }),
    ).rejects.toThrow("shutdown requested");

    await expectMissing(path);
  });

  it("removes readiness if shutdown races atomic marker publication", async () => {
    const { marker, path } = await testMarker();
    const controller = new AbortController();
    const markReady = marker.markReady.bind(marker);
    vi.spyOn(marker, "markReady").mockImplementation(async () => {
      await markReady();
      controller.abort(new Error("shutdown raced readiness publication"));
    });

    await expect(
      establishWorkerReadiness({
        marker,
        checkPrisma: async () => {},
        checkRedis: async () => {},
        workers: [],
        signal: controller.signal,
      }),
    ).rejects.toThrow("shutdown raced readiness publication");

    await expectMissing(path);
  });

  it("creates and removes the marker atomically without leaving temporary files", async () => {
    const { directory, marker, path } = await testMarker();

    await marker.markReady();
    expect(await readdir(directory)).toEqual(["worker-ready"]);
    await marker.markNotReady();

    await expectMissing(path);
    expect(await readdir(directory)).toEqual([]);
    await expect(marker.markNotReady()).resolves.toBeUndefined();
  });

  it("refreshes readiness on a fixed heartbeat until it is stopped and removed", async () => {
    vi.useFakeTimers();
    const { marker } = await testMarker();
    const checkReadiness = vi.fn().mockResolvedValue(undefined);
    const markReady = vi
      .spyOn(marker, "markReady")
      .mockResolvedValue(undefined);

    marker.startHeartbeat(checkReadiness, 1_000);

    await vi.advanceTimersByTimeAsync(3_000);
    expect(checkReadiness).toHaveBeenCalledTimes(3);
    expect(markReady).toHaveBeenCalledTimes(3);

    await marker.markNotReady();
    await vi.advanceTimersByTimeAsync(5_000);
    expect(markReady).toHaveBeenCalledTimes(3);
  });

  it("does not overlap heartbeat writes and drains the active refresh before removal", async () => {
    vi.useFakeTimers();
    const { marker } = await testMarker();
    const refresh = deferred();
    const markReady = vi
      .spyOn(marker, "markReady")
      .mockImplementation(() => refresh.promise);

    marker.startHeartbeat(async () => {}, 100);
    await vi.advanceTimersByTimeAsync(500);
    expect(markReady).toHaveBeenCalledOnce();

    let removalFinished = false;
    const removal = marker.markNotReady().then(() => {
      removalFinished = true;
    });
    await Promise.resolve();
    expect(removalFinished).toBe(false);

    refresh.resolve();
    await removal;
    expect(removalFinished).toBe(true);

    await vi.advanceTimersByTimeAsync(5_000);
    expect(markReady).toHaveBeenCalledOnce();
  });

  it("removes readiness after dependency loss and recreates it after recovery", async () => {
    vi.useFakeTimers();
    const { marker, path } = await testMarker();
    await marker.markReady();
    const checkReadiness = vi
      .fn()
      .mockRejectedValueOnce(new Error("Redis unavailable"))
      .mockResolvedValue(undefined);
    const markReady = vi.spyOn(marker, "markReady");

    marker.startHeartbeat(checkReadiness, 1_000);
    await vi.advanceTimersByTimeAsync(1_000);
    await vi.waitFor(() => expectMissing(path));

    await Promise.resolve();
    await Promise.resolve();
    await vi.advanceTimersByTimeAsync(1_000);
    expect(checkReadiness).toHaveBeenCalledTimes(2);
    await markReady.mock.results[0]?.value;
    await expect(readFile(path, "utf8")).resolves.toBe("ready\n");
    await marker.markNotReady();
  });

  it("does not recreate readiness when shutdown drains an active probe", async () => {
    vi.useFakeTimers();
    const { marker, path } = await testMarker();
    await marker.markReady();
    const check = deferred();
    const checkReadiness = vi.fn(() => check.promise);
    const markReady = vi.spyOn(marker, "markReady");

    marker.startHeartbeat(checkReadiness, 1_000);
    await vi.advanceTimersByTimeAsync(1_000);
    const removal = marker.markNotReady();
    check.resolve();
    await removal;

    await expectMissing(path);
    expect(markReady).not.toHaveBeenCalled();
    await vi.advanceTimersByTimeAsync(10_000);
    expect(checkReadiness).toHaveBeenCalledOnce();
  });

  it("coalesces a blocked dependency probe and removes readiness on timeout", async () => {
    vi.useFakeTimers();
    const { marker, path } = await testMarker();
    await marker.markReady();
    const blocked = deferred();
    const checkReadiness = vi.fn(() => blocked.promise);

    marker.startHeartbeat(checkReadiness, 100);
    await vi.advanceTimersByTimeAsync(500);
    expect(checkReadiness).toHaveBeenCalledOnce();
    await expect(readFile(path, "utf8")).resolves.toBe("ready\n");

    await vi.advanceTimersByTimeAsync(1_000);
    await expectMissing(path);
    await Promise.resolve();
    await Promise.resolve();
    await vi.advanceTimersByTimeAsync(100);
    expect(checkReadiness).toHaveBeenCalledTimes(2);

    const removal = marker.markNotReady();
    blocked.resolve();
    await removal;
    await vi.advanceTimersByTimeAsync(5_000);
    await expectMissing(path);
    expect(checkReadiness).toHaveBeenCalledTimes(2);
  });
});

describe("worker readiness configuration", () => {
  const originalPath = process.env.WORKER_READINESS_PATH;
  const originalInterval = process.env.WORKER_READINESS_HEARTBEAT_INTERVAL_MS;

  afterEach(() => {
    if (originalPath === undefined) {
      delete process.env.WORKER_READINESS_PATH;
    } else {
      process.env.WORKER_READINESS_PATH = originalPath;
    }
    if (originalInterval === undefined) {
      delete process.env.WORKER_READINESS_HEARTBEAT_INTERVAL_MS;
    } else {
      process.env.WORKER_READINESS_HEARTBEAT_INTERVAL_MS = originalInterval;
    }
    vi.resetModules();
  });

  it("configures the marker path and heartbeat interval together", async () => {
    process.env.WORKER_READINESS_PATH = "/tmp/custom-worker-ready";
    process.env.WORKER_READINESS_HEARTBEAT_INTERVAL_MS = "1234";
    vi.resetModules();

    const { config } = await import("../src/config.js");

    expect(config.workerReadinessPath).toBe("/tmp/custom-worker-ready");
    expect(config.workerReadinessHeartbeatIntervalMs).toBe(1_234);
  });

  it("uses the image marker default when the path override is empty", async () => {
    process.env.WORKER_READINESS_PATH = "";
    vi.resetModules();

    const { config } = await import("../src/config.js");

    expect(config.workerReadinessPath).toBe("/tmp/systemvitals-worker-ready");
  });

  it.each(["0", "-1", "1.5", "NaN", "Infinity"])(
    "rejects an invalid readiness heartbeat interval: %s",
    async (value) => {
      process.env.WORKER_READINESS_HEARTBEAT_INTERVAL_MS = value;
      vi.resetModules();

      await expect(import("../src/config.js")).rejects.toThrow(
        "WORKER_READINESS_HEARTBEAT_INTERVAL_MS must be a positive safe integer",
      );
    },
  );
});
