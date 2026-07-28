import { EventEmitter } from "node:events";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
  createIdempotentShutdown,
  DEFAULT_WORKER_SHUTDOWN_TIMEOUT_MS,
  gracefulShutdown,
  registerShutdownSignals,
} from "../src/shutdown.js";

describe("gracefulShutdown", () => {
  let createdIntervals: NodeJS.Timeout[];

  beforeEach(() => {
    createdIntervals = [];
  });

  afterEach(() => {
    vi.useRealTimers();
    vi.restoreAllMocks();
    for (const id of createdIntervals) {
      clearInterval(id);
    }
  });

  function resources(overrides: Record<string, unknown> = {}) {
    return {
      readiness: { markNotReady: vi.fn().mockResolvedValue(undefined) },
      workers: [],
      queues: [],
      redis: [],
      schedulers: [],
      intervals: [],
      prisma: { $disconnect: vi.fn().mockResolvedValue(undefined) },
      ...overrides,
    };
  }

  it("removes readiness first, then clears timers and drains schedulers before workers", async () => {
    const callOrder: string[] = [];
    const interval = setInterval(() => {}, 100_000);
    createdIntervals.push(interval);
    const originalClearInterval = globalThis.clearInterval;
    vi.spyOn(globalThis, "clearInterval").mockImplementation((timer) => {
      callOrder.push("timer");
      originalClearInterval(timer);
    });

    await gracefulShutdown(
      resources({
        readiness: {
          markNotReady: vi.fn(async () => {
            callOrder.push("readiness");
          }),
        },
        intervals: [interval],
        schedulers: [
          {
            stop: vi.fn(async () => {
              callOrder.push("scheduler");
            }),
          },
        ],
        workers: [
          {
            close: vi.fn(async () => {
              callOrder.push("worker");
            }),
          },
        ],
      }),
      1_000,
    );

    expect(callOrder).toEqual([
      "readiness",
      "timer",
      "scheduler",
      "worker",
    ]);
  });

  it("lets active workers drain before closing queues and Redis, then disconnects Prisma", async () => {
    const callOrder: string[] = [];

    await gracefulShutdown(
      resources({
        workers: [
          {
            close: vi.fn(async () => {
              callOrder.push("worker");
            }),
          },
        ],
        queues: [
          {
            close: vi.fn(async () => {
              callOrder.push("queue");
            }),
          },
        ],
        redis: [
          {
            close: vi.fn(async () => {
              callOrder.push("redis");
            }),
          },
        ],
        prisma: {
          $disconnect: vi.fn(async () => {
            callOrder.push("prisma");
          }),
        },
      }),
      1_000,
    );

    expect(callOrder[0]).toBe("worker");
    expect(callOrder.indexOf("queue")).toBeGreaterThan(
      callOrder.indexOf("worker"),
    );
    expect(callOrder.indexOf("redis")).toBeGreaterThan(
      callOrder.indexOf("worker"),
    );
    expect(callOrder.indexOf("prisma")).toBeGreaterThan(
      callOrder.indexOf("worker"),
    );
  });

  it("continues queue, Redis, and Prisma cleanup after the shutdown deadline", async () => {
    vi.useFakeTimers();
    const never = new Promise<void>(() => {});
    const timedOutWorker = {
      close: vi.fn(() => never),
      disconnect: vi.fn().mockResolvedValue(undefined),
    };
    const queue = {
      close: vi.fn().mockResolvedValue(undefined),
      disconnect: vi.fn().mockResolvedValue(undefined),
    };
    const redis = {
      close: vi.fn().mockResolvedValue(undefined),
      disconnect: vi.fn(),
    };
    const prisma = { $disconnect: vi.fn().mockResolvedValue(undefined) };

    const shutdown = gracefulShutdown(
      resources({
        workers: [timedOutWorker],
        queues: [queue],
        redis: [redis],
        prisma,
      }),
      DEFAULT_WORKER_SHUTDOWN_TIMEOUT_MS,
    );
    const outcome = shutdown.then(
      () => undefined,
      (error: unknown) => error,
    );

    await vi.advanceTimersByTimeAsync(
      DEFAULT_WORKER_SHUTDOWN_TIMEOUT_MS - 1,
    );
    expect(queue.close).not.toHaveBeenCalled();

    await vi.advanceTimersByTimeAsync(1);
    const error = await outcome;

    expect(error).toBeInstanceOf(AggregateError);
    expect((error as Error).message).toContain("shutdown deadline");
    expect(timedOutWorker.disconnect).toHaveBeenCalledOnce();
    expect(queue.close).toHaveBeenCalledOnce();
    expect(queue.disconnect).toHaveBeenCalledOnce();
    expect(redis.close).toHaveBeenCalledOnce();
    expect(redis.disconnect).toHaveBeenCalledOnce();
    expect(prisma.$disconnect).toHaveBeenCalledOnce();
  });

  it("bounds a scheduler that ignores cancellation and continues resource cleanup", async () => {
    vi.useFakeTimers();
    const never = new Promise<void>(() => {});
    const scheduler = { stop: vi.fn(() => never) };
    const queue = { close: vi.fn().mockResolvedValue(undefined) };
    const redis = { close: vi.fn().mockResolvedValue(undefined) };
    const prisma = { $disconnect: vi.fn().mockResolvedValue(undefined) };

    const outcome = gracefulShutdown(
      resources({
        schedulers: [scheduler],
        queues: [queue],
        redis: [redis],
        prisma,
      }),
      100,
    ).then(
      () => undefined,
      (error: unknown) => error,
    );

    await vi.advanceTimersByTimeAsync(99);
    expect(queue.close).not.toHaveBeenCalled();
    await vi.advanceTimersByTimeAsync(1);
    const error = await outcome;

    expect(error).toBeInstanceOf(AggregateError);
    expect((error as Error).message).toContain(
      "scheduler lease drain exceeded the shutdown deadline",
    );
    expect(queue.close).toHaveBeenCalledOnce();
    expect(redis.close).toHaveBeenCalledOnce();
    expect(prisma.$disconnect).toHaveBeenCalledOnce();
  });

  it("bounds a never-settling readiness removal and still attempts every cleanup stage", async () => {
    vi.useFakeTimers();
    const never = new Promise<void>(() => {});
    const interval = setInterval(() => {}, 100_000);
    createdIntervals.push(interval);
    const clearIntervalSpy = vi.spyOn(globalThis, "clearInterval");
    const scheduler = { stop: vi.fn().mockResolvedValue(undefined) };
    const worker = {
      close: vi.fn().mockResolvedValue(undefined),
      disconnect: vi.fn().mockResolvedValue(undefined),
    };
    const queue = {
      close: vi.fn().mockResolvedValue(undefined),
      disconnect: vi.fn().mockResolvedValue(undefined),
    };
    const redis = {
      close: vi.fn().mockResolvedValue(undefined),
      disconnect: vi.fn(),
    };
    const prisma = { $disconnect: vi.fn().mockResolvedValue(undefined) };

    const outcome = gracefulShutdown(
      resources({
        readiness: { markNotReady: vi.fn(() => never) },
        intervals: [interval],
        schedulers: [scheduler],
        workers: [worker],
        queues: [queue],
        redis: [redis],
        prisma,
      }),
      100,
    ).then(
      () => undefined,
      (error: unknown) => error,
    );

    await vi.advanceTimersByTimeAsync(0);
    expect(clearIntervalSpy).toHaveBeenCalledWith(interval);
    expect(scheduler.stop).toHaveBeenCalledOnce();
    expect(worker.close).toHaveBeenCalledOnce();
    expect(queue.close).toHaveBeenCalledOnce();
    expect(redis.close).toHaveBeenCalledOnce();
    expect(prisma.$disconnect).toHaveBeenCalledOnce();

    await vi.advanceTimersByTimeAsync(100);
    const error = await outcome;

    expect(error).toBeInstanceOf(AggregateError);
    expect((error as Error).message).toContain(
      "readiness removal exceeded the shutdown deadline",
    );
    expect(worker.disconnect).not.toHaveBeenCalled();
    expect(queue.disconnect).not.toHaveBeenCalled();
    expect(redis.disconnect).not.toHaveBeenCalled();
  });

  it("continues every cleanup stage when readiness removal fails", async () => {
    const markerError = new Error("marker unlink failed");
    const scheduler = { stop: vi.fn().mockResolvedValue(undefined) };
    const worker = { close: vi.fn().mockResolvedValue(undefined) };
    const queue = { close: vi.fn().mockResolvedValue(undefined) };
    const redis = { close: vi.fn().mockResolvedValue(undefined) };
    const prisma = { $disconnect: vi.fn().mockResolvedValue(undefined) };

    const error = await gracefulShutdown(
      resources({
        readiness: {
          markNotReady: vi.fn().mockRejectedValue(markerError),
        },
        schedulers: [scheduler],
        workers: [worker],
        queues: [queue],
        redis: [redis],
        prisma,
      }),
      1_000,
    ).then(
      () => undefined,
      (caught: unknown) => caught,
    );

    expect(error).toBeInstanceOf(AggregateError);
    expect((error as AggregateError).errors).toContain(markerError);
    expect(scheduler.stop).toHaveBeenCalledOnce();
    expect(worker.close).toHaveBeenCalledOnce();
    expect(queue.close).toHaveBeenCalledOnce();
    expect(redis.close).toHaveBeenCalledOnce();
    expect(prisma.$disconnect).toHaveBeenCalledOnce();
  });

  it("attempts every cleanup after failures and reports them together", async () => {
    const firstWorker = {
      close: vi.fn().mockRejectedValue(new Error("worker close failed")),
      disconnect: vi.fn().mockResolvedValue(undefined),
    };
    const secondWorker = { close: vi.fn().mockResolvedValue(undefined) };
    const queue = {
      close: vi.fn().mockRejectedValue(new Error("queue close failed")),
    };
    const redis = { close: vi.fn().mockResolvedValue(undefined) };
    const prisma = { $disconnect: vi.fn().mockResolvedValue(undefined) };

    const error = await gracefulShutdown(
      resources({
        workers: [firstWorker, secondWorker],
        queues: [queue],
        redis: [redis],
        prisma,
      }),
      1_000,
    ).then(
      () => undefined,
      (caught: unknown) => caught,
    );

    expect(error).toBeInstanceOf(AggregateError);
    expect((error as AggregateError).errors).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ message: "worker close failed" }),
        expect.objectContaining({ message: "queue close failed" }),
      ]),
    );
    expect(firstWorker.disconnect).toHaveBeenCalledOnce();
    expect(secondWorker.close).toHaveBeenCalledOnce();
    expect(redis.close).toHaveBeenCalledOnce();
    expect(prisma.$disconnect).toHaveBeenCalledOnce();
  });

  it("works with no workers, queues, Redis resources, schedulers, or timers", async () => {
    const minimalResources = resources();

    await gracefulShutdown(minimalResources, 1_000);

    expect(minimalResources.readiness.markNotReady).toHaveBeenCalledOnce();
    expect(minimalResources.prisma.$disconnect).toHaveBeenCalledOnce();
  });
});

describe("createIdempotentShutdown", () => {
  it("shares one cleanup promise across repeated signals", async () => {
    const cleanup = vi.fn().mockResolvedValue(undefined);
    const shutdown = createIdempotentShutdown(cleanup);

    const first = shutdown();
    const second = shutdown();

    expect(first).toBe(second);
    await Promise.all([first, second]);
    expect(cleanup).toHaveBeenCalledOnce();
  });
});

describe("registerShutdownSignals", () => {
  it("routes repeated and mixed termination signals through one shutdown promise", async () => {
    const signalSource = new EventEmitter();
    let finishCleanup!: () => void;
    const cleanup = vi.fn(
      () =>
        new Promise<void>((resolve) => {
          finishCleanup = resolve;
        }),
    );
    const shutdown = createIdempotentShutdown(cleanup);
    const receivedSignals: string[] = [];
    const unregister = registerShutdownSignals(
      (signal) => {
        receivedSignals.push(signal);
        void shutdown();
      },
      signalSource,
    );

    signalSource.emit("SIGTERM");
    signalSource.emit("SIGTERM");
    signalSource.emit("SIGINT");
    signalSource.emit("SIGHUP");
    await Promise.resolve();

    expect(receivedSignals).toEqual([
      "SIGTERM",
      "SIGTERM",
      "SIGINT",
      "SIGHUP",
    ]);
    expect(cleanup).toHaveBeenCalledOnce();
    expect(signalSource.listenerCount("SIGTERM")).toBe(1);
    expect(signalSource.listenerCount("SIGINT")).toBe(1);
    expect(signalSource.listenerCount("SIGHUP")).toBe(1);

    finishCleanup();
    await shutdown();
    unregister();

    expect(signalSource.listenerCount("SIGTERM")).toBe(0);
    expect(signalSource.listenerCount("SIGINT")).toBe(0);
    expect(signalSource.listenerCount("SIGHUP")).toBe(0);
  });
});

describe("worker shutdown configuration", () => {
  const originalTimeout = process.env.WORKER_SHUTDOWN_TIMEOUT_MS;

  afterEach(() => {
    if (originalTimeout === undefined) {
      delete process.env.WORKER_SHUTDOWN_TIMEOUT_MS;
    } else {
      process.env.WORKER_SHUTDOWN_TIMEOUT_MS = originalTimeout;
    }
    vi.resetModules();
  });

  it("defaults to a 45 second shutdown deadline", async () => {
    delete process.env.WORKER_SHUTDOWN_TIMEOUT_MS;
    vi.resetModules();

    const { config } = await import("../src/config.js");

    expect(config.workerShutdownTimeoutMs).toBe(
      DEFAULT_WORKER_SHUTDOWN_TIMEOUT_MS,
    );
  });

  it.each(["0", "-1", "1.5", "NaN", "Infinity"])(
    "rejects an invalid shutdown deadline: %s",
    async (value) => {
      process.env.WORKER_SHUTDOWN_TIMEOUT_MS = value;
      vi.resetModules();

      await expect(import("../src/config.js")).rejects.toThrow(
        "WORKER_SHUTDOWN_TIMEOUT_MS must be a positive safe integer",
      );
    },
  );
});
