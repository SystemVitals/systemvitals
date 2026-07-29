import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";

interface RuntimeResource {
  name: string;
  on: ReturnType<typeof vi.fn>;
  close: ReturnType<typeof vi.fn>;
  disconnect: ReturnType<typeof vi.fn>;
  add?: ReturnType<typeof vi.fn>;
  processor?: (job: { id: string; data: Record<string, string> }) => Promise<void>;
}

const runtime = vi.hoisted(() => ({
  action: undefined as (() => Promise<void>) | undefined,
  boot: undefined as Promise<void> | undefined,
  shutdownSignal: undefined as ((signal: "SIGTERM") => void) | undefined,
  shutdownResources: undefined as
    | {
        workers: RuntimeResource[];
        queues: RuntimeResource[];
        schedulers: Array<{ stop(): Promise<void> }>;
        intervals: NodeJS.Timeout[];
      }
    | undefined,
  queues: [] as RuntimeResource[],
  workers: [] as RuntimeResource[],
  intervalCallbacks: [] as Array<{ callback: () => void; delay: number }>,
  sweepOverdue: vi.fn().mockResolvedValue(0),
  scheduleDueProbes: vi.fn().mockResolvedValue(0),
  handleAlert: vi.fn().mockResolvedValue(1),
  handleProbe: vi.fn().mockResolvedValue(undefined),
  handleInvite: vi.fn().mockResolvedValue(true),
  handleEmailVerification: vi.fn().mockResolvedValue(true),
}));

vi.mock("commander", () => {
  const program = {
    name: vi.fn(() => program),
    description: vi.fn(() => program),
    version: vi.fn(() => program),
    action: vi.fn((action: () => Promise<void>) => {
      runtime.action = action;
      return program;
    }),
    parseAsync: vi.fn(() => {
      if (!runtime.action) {
        throw new Error("worker action was not registered");
      }
      runtime.boot = runtime.action();
      return runtime.boot;
    }),
  };
  return { program };
});

vi.mock("bullmq", () => {
  class Queue {
    readonly name: string;
    readonly on = vi.fn();
    readonly add = vi.fn().mockResolvedValue(undefined);
    readonly close = vi.fn().mockResolvedValue(undefined);
    readonly disconnect = vi.fn().mockResolvedValue(undefined);

    constructor(name: string) {
      this.name = name;
      runtime.queues.push(this);
    }
  }

  class Worker {
    readonly name: string;
    readonly processor: (
      job: { id: string; data: Record<string, string> },
    ) => Promise<void>;
    readonly on = vi.fn();
    readonly close = vi.fn().mockResolvedValue(undefined);
    readonly disconnect = vi.fn().mockResolvedValue(undefined);
    readonly run = vi.fn().mockReturnValue(new Promise<void>(() => {}));
    readonly waitUntilReady = vi.fn().mockResolvedValue(undefined);
    readonly isRunning = vi.fn().mockReturnValue(true);

    constructor(
      name: string,
      processor: (
        job: { id: string; data: Record<string, string> },
      ) => Promise<void>,
    ) {
      this.name = name;
      this.processor = processor;
      runtime.workers.push(this);
    }
  }

  return { Queue, Worker };
});

vi.mock("ioredis", () => ({
  Redis: class {
    status = "wait";
    on = vi.fn();
    off = vi.fn();
    disconnect = vi.fn();
    quit = vi.fn().mockResolvedValue(undefined);
    ping = vi.fn().mockResolvedValue("PONG");
    set = vi.fn().mockResolvedValue("OK");
    eval = vi.fn().mockResolvedValue(1);
  },
}));

vi.mock("../src/config.js", () => ({
  config: {
    redisUrl: "redis://test.invalid:6379",
    queueAlert: "alert",
    queueProbe: "probe",
    queueInvite: "invite",
    queueEmailVerification: "email-verification",
    appUrl: "https://systemvitals.example",
    watchdogIntervalMs: 30_000,
    probeSchedulerIntervalMs: 15_000,
    schedulerLeaseTtlMs: 90_000,
    workerShutdownTimeoutMs: 45_000,
    workerReadinessPath: "/tmp/systemvitals-worker-wiring-test",
    workerReadinessHeartbeatIntervalMs: 5_000,
    telegramBotToken: "test-token",
    ssrfAllowPrivate: false,
  },
}));

vi.mock("../src/prisma.js", () => ({
  prisma: {
    $queryRawUnsafe: vi.fn().mockResolvedValue(1),
    $disconnect: vi.fn().mockResolvedValue(undefined),
  },
}));
vi.mock("../src/redis.js", () => ({
  redisConnection: vi.fn(() => ({ host: "test.invalid", port: 6379 })),
}));
vi.mock("../src/watchdog.js", () => ({
  sweepOverdue: runtime.sweepOverdue,
}));
vi.mock("../src/probe-scheduler.js", () => ({
  scheduleDueProbes: runtime.scheduleDueProbes,
}));
vi.mock("../src/alert-handler.js", () => ({
  handleAlert: runtime.handleAlert,
}));
vi.mock("../src/probe-handler.js", () => ({
  handleProbe: runtime.handleProbe,
}));
vi.mock("../src/prober.js", () => ({
  probe: vi.fn().mockResolvedValue({ ok: true }),
}));
vi.mock("../src/invite-handler.js", () => ({
  handleInvite: runtime.handleInvite,
}));
vi.mock("../src/email-verification-handler.js", () => ({
  handleEmailVerification: runtime.handleEmailVerification,
}));
vi.mock("../src/mailer.js", () => ({
  NodemailerMailer: class {},
}));
vi.mock("../src/notifiers.js", () => ({
  httpPost: vi.fn(),
  telegramPost: vi.fn(),
}));

vi.mock("../src/readiness.js", () => ({
  ReadinessMarker: class {
    markNotReady = vi.fn().mockResolvedValue(undefined);
  },
  establishWorkerReadiness: vi.fn().mockResolvedValue(undefined),
}));

vi.mock("../src/lease.js", () => ({
  createSchedulerLease: vi.fn(() => ({
    run: async (
      task: (signal: AbortSignal) => Promise<unknown>,
    ): Promise<unknown> => task(new AbortController().signal),
  })),
}));

vi.mock("../src/tracked-scheduler.js", () => ({
  TrackedScheduler: class {
    run(task: (signal: AbortSignal) => Promise<unknown>): void {
      void task(new AbortController().signal);
    }

    async stop(): Promise<void> {}
  },
}));

vi.mock("../src/shutdown.js", () => ({
  createIdempotentShutdown:
    (shutdown: () => Promise<void>) => shutdown,
  gracefulShutdown: vi.fn(
    async (resources: typeof runtime.shutdownResources) => {
      runtime.shutdownResources = resources;
    },
  ),
  registerShutdownSignals: vi.fn(
    (handler: (signal: "SIGTERM") => void) => {
      runtime.shutdownSignal = handler;
      return vi.fn();
    },
  ),
}));

describe("worker runtime wiring", () => {
  beforeAll(async () => {
    vi.spyOn(globalThis, "setInterval").mockImplementation(
      ((callback: () => void, delay?: number) => {
        runtime.intervalCallbacks.push({
          callback,
          delay: delay ?? 0,
        });
        return {
          unref: vi.fn(),
        } as unknown as NodeJS.Timeout;
      }) as typeof setInterval,
    );

    await import("../cli/worker.js");
    await runtime.boot;
  });

  afterAll(() => {
    vi.restoreAllMocks();
  });

  it("constructs only the active notification and supporting queues", () => {
    expect(runtime.queues.map(({ name }) => name)).toEqual([
      "alert",
      "probe",
      "invite",
      "email-verification",
    ]);
    expect(runtime.workers.map(({ name }) => name)).toEqual([
      "alert",
      "probe",
      "invite",
      "email-verification",
    ]);
  });

  it("keeps active job processors connected to their handlers", async () => {
    for (const name of [
      "alert",
      "probe",
      "invite",
      "email-verification",
    ]) {
      const worker = runtime.workers.find((candidate) => candidate.name === name);
      expect(worker?.processor).toBeTypeOf("function");
      await worker?.processor?.({
        id: `${name}-job`,
        data: {
          checkId: "check-1",
          inviteId: "invite-1",
          channelId: "channel-1",
        },
      });
    }

    expect(runtime.handleAlert).toHaveBeenCalledOnce();
    expect(runtime.handleProbe).toHaveBeenCalledOnce();
    expect(runtime.handleInvite).toHaveBeenCalledOnce();
    expect(runtime.handleEmailVerification).toHaveBeenCalledOnce();
  });

  it("retains watchdog and probe scheduling", async () => {
    expect(runtime.intervalCallbacks.map(({ delay }) => delay).sort()).toEqual([
      15_000,
      30_000,
    ]);

    runtime.intervalCallbacks.find(({ delay }) => delay === 30_000)?.callback();
    runtime.intervalCallbacks.find(({ delay }) => delay === 15_000)?.callback();
    await vi.waitFor(() => {
      expect(runtime.sweepOverdue).toHaveBeenCalledOnce();
      expect(runtime.scheduleDueProbes).toHaveBeenCalledOnce();
    });

    const enqueueAlert = runtime.sweepOverdue.mock.calls[0]?.[1] as
      | ((data: Record<string, string>) => Promise<unknown>)
      | undefined;
    const enqueueProbe = runtime.scheduleDueProbes.mock.calls[0]?.[1] as
      | ((data: Record<string, string>) => Promise<unknown>)
      | undefined;
    await enqueueAlert?.({ checkId: "check-1", kind: "down" });
    await enqueueProbe?.({ checkId: "check-1" });

    expect(
      runtime.queues.find(({ name }) => name === "alert")?.add,
    ).toHaveBeenCalledWith(
      "alert",
      { checkId: "check-1", kind: "down" },
      undefined,
    );
    expect(
      runtime.queues.find(({ name }) => name === "probe")?.add,
    ).toHaveBeenCalledWith(
      "probe",
      { checkId: "check-1" },
      undefined,
    );
  });

  it("registers every active resource for graceful drain", async () => {
    expect(runtime.shutdownSignal).toBeTypeOf("function");
    runtime.shutdownSignal?.("SIGTERM");
    await vi.waitFor(() => {
      expect(runtime.shutdownResources).toBeDefined();
    });

    expect(runtime.shutdownResources?.queues.map(({ name }) => name)).toEqual([
      "alert",
      "probe",
      "invite",
      "email-verification",
    ]);
    expect(runtime.shutdownResources?.workers.map(({ name }) => name)).toEqual([
      "alert",
      "probe",
      "invite",
      "email-verification",
    ]);
    expect(runtime.shutdownResources?.schedulers).toHaveLength(2);
    expect(runtime.shutdownResources?.intervals).toHaveLength(2);
  });
});
