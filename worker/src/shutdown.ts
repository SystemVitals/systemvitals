export const DEFAULT_WORKER_SHUTDOWN_TIMEOUT_MS = 45_000;
export const WORKER_SHUTDOWN_SIGNALS = [
  "SIGTERM",
  "SIGINT",
  "SIGHUP",
] as const;

export type WorkerShutdownSignal =
  (typeof WORKER_SHUTDOWN_SIGNALS)[number];

export interface ShutdownSignalSource {
  on(signal: WorkerShutdownSignal, listener: () => void): unknown;
  off(signal: WorkerShutdownSignal, listener: () => void): unknown;
}

export interface ShutdownResources {
  readiness: { markNotReady(): Promise<void> };
  workers: {
    close(): Promise<void>;
    disconnect?(): Promise<void>;
  }[];
  queues: {
    close(): Promise<void>;
    disconnect?(): Promise<void>;
  }[];
  redis: {
    close(): Promise<void>;
    disconnect?(): void;
  }[];
  schedulers: { stop(): Promise<void> }[];
  intervals: NodeJS.Timeout[];
  prisma: { $disconnect(): Promise<void> };
}

export type Shutdown = () => Promise<void>;

export function createIdempotentShutdown(shutdown: Shutdown): Shutdown {
  let shutdownPromise: Promise<void> | undefined;

  return () => {
    shutdownPromise ??= Promise.resolve().then(shutdown);
    return shutdownPromise;
  };
}

export function registerShutdownSignals(
  handler: (signal: WorkerShutdownSignal) => void,
  source: ShutdownSignalSource = process,
): () => void {
  const listeners = WORKER_SHUTDOWN_SIGNALS.map((signal) => {
    const listener = (): void => handler(signal);
    source.on(signal, listener);
    return { signal, listener };
  });

  return () => {
    for (const { signal, listener } of listeners) {
      source.off(signal, listener);
    }
  };
}

/**
 * Removes readiness before stopping producers, drains active scheduler lease
 * runs and BullMQ workers within one deadline, then attempts every remaining
 * connection cleanup even when an earlier stage fails or times out.
 */
export async function gracefulShutdown(
  resources: ShutdownResources,
  timeoutMs = DEFAULT_WORKER_SHUTDOWN_TIMEOUT_MS,
): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  const errors: unknown[] = [];
  let readinessRemovalSettled = false;

  const readinessRemoval = startCleanup(() =>
    resources.readiness.markNotReady()
  ).then(
    () => undefined,
    (error: unknown) => {
      errors.push(error);
    },
  ).finally(() => {
    readinessRemovalSettled = true;
  });

  for (const interval of resources.intervals) {
    try {
      clearInterval(interval);
    } catch (error) {
      errors.push(error);
    }
  }

  await settleUntilDeadline(
    "scheduler lease drain",
    resources.schedulers.map((scheduler) =>
      invokeCleanup(() => scheduler.stop()),
    ),
    deadline,
    errors,
  );

  const workerErrorCount = errors.length;
  const workerDrainTimedOut = await settleUntilDeadline(
    "worker drain",
    resources.workers.map((worker) =>
      invokeCleanup(() => worker.close()),
    ),
    deadline,
    errors,
  );
  const workerDrainFailed = errors.length > workerErrorCount;

  if (workerDrainTimedOut || workerDrainFailed) {
    await settleUntilDeadline(
      "worker disconnect",
      resources.workers.flatMap((worker) =>
        worker.disconnect
          ? [invokeCleanup(() => worker.disconnect!())]
          : [],
      ),
      deadline,
      errors,
    );
  }

  const queueErrorCount = errors.length;
  const queueCloseTimedOut = await settleUntilDeadline(
    "queue close",
    resources.queues.map((queue) => invokeCleanup(() => queue.close())),
    deadline,
    errors,
  );
  if (queueCloseTimedOut || errors.length > queueErrorCount) {
    await settleUntilDeadline(
      "queue disconnect",
      resources.queues.flatMap((queue) =>
        queue.disconnect
          ? [invokeCleanup(() => queue.disconnect!())]
          : [],
      ),
      deadline,
      errors,
    );
  }

  const redisErrorCount = errors.length;
  const redisCloseTimedOut = await settleUntilDeadline(
    "Redis close",
    resources.redis.map((redis) => invokeCleanup(() => redis.close())),
    deadline,
    errors,
  );
  if (redisCloseTimedOut || errors.length > redisErrorCount) {
    await settleUntilDeadline(
      "Redis disconnect",
      resources.redis.flatMap((redis) =>
        redis.disconnect
          ? [
              invokeCleanup(async () => {
                redis.disconnect!();
              }),
            ]
          : [],
      ),
      deadline,
      errors,
    );
  }

  await settleUntilDeadline(
    "Prisma disconnect",
    [invokeCleanup(() => resources.prisma.$disconnect())],
    deadline,
    errors,
  );

  if (!readinessRemovalSettled) {
    await settleUntilDeadline(
      "readiness removal",
      [readinessRemoval],
      deadline,
      errors,
    );
  }

  if (errors.length > 0) {
    throw new AggregateError(
      errors,
      `Worker shutdown failed: ${errors.map(errorMessage).join("; ")}`,
    );
  }
}

function startCleanup(cleanup: () => Promise<void>): Promise<void> {
  try {
    return Promise.resolve(cleanup());
  } catch (error) {
    return Promise.reject(error);
  }
}

function invokeCleanup(cleanup: () => Promise<void>): Promise<void> {
  return Promise.resolve().then(cleanup);
}

async function settleUntilDeadline(
  stage: string,
  operations: Promise<void>[],
  deadline: number,
  errors: unknown[],
): Promise<boolean> {
  if (operations.length === 0) {
    return false;
  }

  const settled = Promise.allSettled(operations);
  const remainingMs = Math.max(0, deadline - Date.now());
  if (remainingMs === 0) {
    errors.push(new Error(`${stage} exceeded the shutdown deadline`));
    void settled.then((results) => collectRejections(results, errors));
    return true;
  }

  let timeout: NodeJS.Timeout | undefined;
  const outcome = await Promise.race([
    settled.then((results) => {
      collectRejections(results, errors);
      return "settled" as const;
    }),
    new Promise<"timed-out">((resolve) => {
      timeout = setTimeout(() => resolve("timed-out"), remainingMs);
      timeout.unref();
    }),
  ]);

  if (timeout) {
    clearTimeout(timeout);
  }
  if (outcome === "timed-out") {
    errors.push(new Error(`${stage} exceeded the shutdown deadline`));
    void settled.then((results) => collectRejections(results, errors));
    return true;
  }
  return false;
}

function collectRejections(
  results: PromiseSettledResult<void>[],
  errors: unknown[],
): void {
  for (const result of results) {
    if (result.status === "rejected") {
      errors.push(result.reason);
    }
  }
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}
