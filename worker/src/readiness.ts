import { randomUUID } from "node:crypto";
import { rename, unlink, writeFile } from "node:fs/promises";
import { basename, dirname, join } from "node:path";

export const DEFAULT_WORKER_READINESS_HEARTBEAT_INTERVAL_MS = 5_000;
export const WORKER_READINESS_PROBE_TIMEOUT_MS = 1_000;

export interface ReadyWorker {
  start(): void;
  waitUntilReady(): Promise<unknown>;
  checkReady?(): Promise<unknown>;
}

export class ReadinessMarker {
  private heartbeatTimer: NodeJS.Timeout | undefined;
  private heartbeatRefresh: Promise<void> | undefined;
  private draining = false;

  constructor(
    readonly path = process.env.WORKER_READINESS_PATH ||
      "/tmp/systemvitals-worker-ready",
    readonly heartbeatIntervalMs = DEFAULT_WORKER_READINESS_HEARTBEAT_INTERVAL_MS,
  ) {}

  async markReady(): Promise<void> {
    const temporaryPath = join(
      dirname(this.path),
      `.${basename(this.path)}.${randomUUID()}.tmp`,
    );

    try {
      await writeFile(temporaryPath, "ready\n", {
        encoding: "utf8",
        flag: "wx",
      });
      await rename(temporaryPath, this.path);
    } catch (error) {
      await unlinkIfPresent(temporaryPath);
      throw error;
    }
  }

  async markNotReady(): Promise<void> {
    this.draining = true;
    this.stopHeartbeat();

    let refreshError: unknown;
    if (this.heartbeatRefresh) {
      try {
        await this.heartbeatRefresh;
      } catch (error) {
        refreshError = error;
      }
    }

    try {
      await unlinkIfPresent(this.path);
    } catch (unlinkError) {
      if (refreshError) {
        throw new AggregateError(
          [refreshError, unlinkError],
          "Readiness heartbeat drain and marker removal failed",
        );
      }
      throw unlinkError;
    }

    if (refreshError) {
      throw refreshError;
    }
  }

  startHeartbeat(
    checkReadiness: () => Promise<unknown>,
    intervalMs = this.heartbeatIntervalMs,
  ): void {
    if (!Number.isSafeInteger(intervalMs) || intervalMs <= 0) {
      throw new Error(
        "Readiness heartbeat interval must be a positive safe integer",
      );
    }
    if (this.heartbeatTimer) {
      return;
    }

    this.draining = false;
    this.heartbeatTimer = setInterval(() => {
      if (this.heartbeatRefresh) {
        return;
      }

      const refresh = this.refreshIfHealthy(checkReadiness);
      this.heartbeatRefresh = refresh;
      void refresh
        .catch(() => undefined)
        .finally(() => {
          if (this.heartbeatRefresh === refresh) {
            this.heartbeatRefresh = undefined;
          }
        });
    }, intervalMs);
    this.heartbeatTimer.unref();
  }

  private async refreshIfHealthy(
    checkReadiness: () => Promise<unknown>,
  ): Promise<void> {
    try {
      await withTimeout(checkReadiness, WORKER_READINESS_PROBE_TIMEOUT_MS);
      if (this.draining) {
        return;
      }
      await this.markReady();
    } catch {
      await unlinkIfPresent(this.path);
    }
  }

  private stopHeartbeat(): void {
    if (this.heartbeatTimer) {
      clearInterval(this.heartbeatTimer);
      this.heartbeatTimer = undefined;
    }
  }
}

export interface WorkerReadinessOptions {
  marker: ReadinessMarker;
  checkPrisma(): Promise<unknown>;
  checkRedis(): Promise<unknown>;
  workers: ReadyWorker[];
  signal?: AbortSignal;
  checkHeartbeat?(): Promise<void>;
  onStartupFailure?(): Promise<void>;
}

export async function establishWorkerReadiness(
  options: WorkerReadinessOptions,
): Promise<void> {
  const {
    marker,
    checkPrisma,
    checkRedis,
    workers,
    signal,
    checkHeartbeat,
    onStartupFailure,
  } = options;

  try {
    await marker.markNotReady();
    signal?.throwIfAborted();
    await checkPrisma();
    signal?.throwIfAborted();
    await checkRedis();
    signal?.throwIfAborted();
    for (const worker of workers) {
      signal?.throwIfAborted();
      worker.start();
    }
    signal?.throwIfAborted();
    await Promise.all(
      workers.map((worker) => {
        signal?.throwIfAborted();
        return worker.waitUntilReady();
      }),
    );
    signal?.throwIfAborted();
    await marker.markReady();
    signal?.throwIfAborted();
    marker.startHeartbeat(
      checkHeartbeat ??
        (async () => {
          await checkPrisma();
          await checkRedis();
          await Promise.all(
            workers.map((worker) =>
              worker.checkReady ? worker.checkReady() : worker.waitUntilReady(),
            ),
          );
        }),
    );
  } catch (error) {
    try {
      if (onStartupFailure) {
        await onStartupFailure();
      } else {
        await marker.markNotReady();
      }
    } catch (cleanupError) {
      throw new AggregateError(
        [error, cleanupError],
        "Worker startup and cleanup failed",
      );
    }
    throw error;
  }
}

async function withTimeout(
  operation: () => Promise<unknown>,
  timeoutMs: number,
): Promise<void> {
  let timer: NodeJS.Timeout | undefined;
  try {
    await Promise.race([
      Promise.resolve().then(operation),
      new Promise<never>((_, reject) => {
        timer = setTimeout(
          () => reject(new Error("Worker readiness probe timed out")),
          timeoutMs,
        );
      }),
    ]);
  } finally {
    if (timer) clearTimeout(timer);
  }
}

async function unlinkIfPresent(path: string): Promise<void> {
  try {
    await unlink(path);
  } catch (error) {
    if (!isMissingFileError(error)) {
      throw error;
    }
  }
}

function isMissingFileError(error: unknown): error is NodeJS.ErrnoException {
  return error instanceof Error && "code" in error && error.code === "ENOENT";
}
