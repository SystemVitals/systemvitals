import { randomUUID } from "node:crypto";

const LEASE_KEY_PREFIX = "systemvitals:lease:";

const RENEW_IF_OWNER_SCRIPT = `
if redis.call("GET", KEYS[1]) == ARGV[1] then
  return redis.call("PEXPIRE", KEYS[1], ARGV[2])
end
return 0
`;

const RELEASE_IF_OWNER_SCRIPT = `
if redis.call("GET", KEYS[1]) == ARGV[1] then
  return redis.call("DEL", KEYS[1])
end
return 0
`;

export interface LeaseStore {
  set(
    key: string,
    value: string,
    expiry: "PX",
    ttlMs: number,
    mode: "NX",
  ): Promise<"OK" | null>;
  eval(
    script: string,
    numberOfKeys: number,
    ...args: string[]
  ): Promise<unknown>;
}

export type LeaseRunOutcome = "ran" | "contended";

export interface LeaseRunOptions {
  renew?: boolean;
  signal?: AbortSignal;
}

export class LeaseOwnershipLostError extends Error {
  constructor(key: string, cause?: unknown) {
    super(
      `Lease ownership lost for ${key}`,
      cause === undefined ? undefined : { cause },
    );
    this.name = "LeaseOwnershipLostError";
  }
}

interface RenewalStopResult {
  ownershipError: LeaseOwnershipLostError | undefined;
  releaseSafe: boolean;
}

interface RenewalLoop {
  stop(): Promise<RenewalStopResult>;
}

export class RedisLease {
  private readonly key: string;
  private running = false;
  private token: string | undefined;

  constructor(
    private readonly store: LeaseStore,
    key: string,
    private readonly owner: string,
    private readonly ttlMs: number,
  ) {
    if (!Number.isSafeInteger(ttlMs) || ttlMs <= 0) {
      throw new Error("Lease TTL must be a positive safe integer");
    }
    this.key = key.startsWith(LEASE_KEY_PREFIX)
      ? key
      : `${LEASE_KEY_PREFIX}${key}`;
  }

  async acquire(): Promise<boolean> {
    const token = `${this.owner}:${randomUUID()}`;
    const acquired =
      (await this.store.set(
        this.key,
        token,
        "PX",
        this.ttlMs,
        "NX",
      )) === "OK";
    if (acquired) {
      this.token = token;
    }
    return acquired;
  }

  async renew(): Promise<boolean> {
    const token = this.token;
    if (!token) {
      return false;
    }

    const result = await this.store.eval(
      RENEW_IF_OWNER_SCRIPT,
      1,
      this.key,
      token,
      String(this.ttlMs),
    );
    return Number(result) === 1;
  }

  async release(): Promise<boolean> {
    const token = this.token;
    if (!token) {
      return false;
    }

    try {
      const result = await this.store.eval(
        RELEASE_IF_OWNER_SCRIPT,
        1,
        this.key,
        token,
      );
      return Number(result) === 1;
    } finally {
      if (this.token === token) {
        this.token = undefined;
      }
    }
  }

  async run(
    callback: (signal: AbortSignal) => Promise<unknown>,
    options: LeaseRunOptions = {},
  ): Promise<LeaseRunOutcome> {
    options.signal?.throwIfAborted();
    if (this.running) {
      return "contended";
    }
    this.running = true;

    try {
      if (!(await this.acquire())) {
        return "contended";
      }

      const abortController = new AbortController();
      const renewal =
        options.renew === false
          ? undefined
          : this.startRenewalLoop(abortController);
      let renewalStop: Promise<RenewalStopResult> | undefined;
      let cancellationError: unknown;
      const stopRenewal = (): Promise<RenewalStopResult> => {
        renewalStop ??= renewal
          ? renewal.stop()
          : Promise.resolve({
              ownershipError: undefined,
              releaseSafe: true,
            });
        return renewalStop;
      };
      const cancel = (): void => {
        cancellationError =
          options.signal?.reason ?? new Error("Lease run cancelled");
        abortController.abort(cancellationError);
        void stopRenewal();
      };
      options.signal?.addEventListener("abort", cancel, { once: true });
      if (options.signal?.aborted) {
        cancel();
      }
      let callbackError: unknown;
      let callbackFailed = false;

      try {
        abortController.signal.throwIfAborted();
        await callback(abortController.signal);
      } catch (error) {
        callbackFailed = true;
        callbackError = error;
      } finally {
        options.signal?.removeEventListener("abort", cancel);
      }

      const errors: unknown[] = [];
      if (callbackFailed) {
        errors.push(callbackError);
      }
      if (
        cancellationError !== undefined &&
        !errors.includes(cancellationError)
      ) {
        errors.push(cancellationError);
      }

      const renewalResult = await stopRenewal();
      let { ownershipError } = renewalResult;
      let releaseError: unknown;
      if (renewalResult.releaseSafe && !ownershipError) {
        try {
          const released = await this.release();
          if (!released && cancellationError === undefined) {
            ownershipError = new LeaseOwnershipLostError(this.key);
          }
        } catch (error) {
          releaseError = error;
        }
      }

      if (ownershipError && !errors.includes(ownershipError)) {
        errors.push(ownershipError);
      }
      if (releaseError !== undefined) {
        errors.push(releaseError);
      }

      if (errors.length === 1) {
        throw errors[0];
      }
      if (errors.length > 1) {
        throw new AggregateError(
          errors,
          `Lease run failed: ${errorMessage(errors[0])}`,
        );
      }

      return "ran";
    } finally {
      this.running = false;
    }
  }

  private startRenewalLoop(abortController: AbortController): RenewalLoop {
    const renewalIntervalMs = Math.max(1, Math.floor(this.ttlMs / 3));
    let renewalTimer: NodeJS.Timeout | undefined;
    let deadlineTimer: NodeJS.Timeout | undefined;
    let activeRenewal: Promise<void> | undefined;
    let finishActiveRenewal: (() => void) | undefined;
    let ownershipError: LeaseOwnershipLostError | undefined;
    let stopRequested = false;
    let renewalTimedOut = false;

    const clearRenewalTimer = (): void => {
      if (renewalTimer) {
        clearTimeout(renewalTimer);
        renewalTimer = undefined;
      }
    };

    const clearDeadlineTimer = (): void => {
      if (deadlineTimer) {
        clearTimeout(deadlineTimer);
        deadlineTimer = undefined;
      }
    };

    const loseOwnership = (cause?: unknown): void => {
      if (ownershipError) {
        return;
      }
      ownershipError = new LeaseOwnershipLostError(this.key, cause);
      clearRenewalTimer();
      abortController.abort(ownershipError);
    };

    const completeActiveRenewal = (): void => {
      const finish = finishActiveRenewal;
      finishActiveRenewal = undefined;
      activeRenewal = undefined;
      finish?.();
    };

    const scheduleRenewal = (): void => {
      if (stopRequested || ownershipError) {
        return;
      }
      renewalTimer = setTimeout(() => {
        renewalTimer = undefined;
        if (stopRequested) {
          return;
        }

        let settled = false;
        activeRenewal = new Promise<void>((resolve) => {
          finishActiveRenewal = resolve;
        });
        deadlineTimer = setTimeout(() => {
          deadlineTimer = undefined;
          if (settled) {
            return;
          }
          settled = true;
          renewalTimedOut = true;
          loseOwnership(new Error("Lease renewal timed out"));
          completeActiveRenewal();
        }, renewalIntervalMs);
        deadlineTimer.unref();

        void this.renew().then(
          (renewed) => {
            if (settled) {
              return;
            }
            settled = true;
            clearDeadlineTimer();
            if (!renewed) {
              loseOwnership();
            }
            completeActiveRenewal();
            if (renewed) {
              scheduleRenewal();
            }
          },
          (error: unknown) => {
            if (settled) {
              return;
            }
            settled = true;
            clearDeadlineTimer();
            loseOwnership(error);
            completeActiveRenewal();
          },
        );
      }, renewalIntervalMs);
      renewalTimer.unref();
    };

    scheduleRenewal();

    return {
      stop: async () => {
        stopRequested = true;
        clearRenewalTimer();
        const pendingRenewal = activeRenewal;
        if (pendingRenewal) {
          await pendingRenewal;
        } else {
          clearDeadlineTimer();
        }
        return {
          ownershipError,
          releaseSafe: !renewalTimedOut,
        };
      },
    };
  }
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

export function createSchedulerLease(
  store: LeaseStore,
  name: string,
  ttlMs: number,
): RedisLease {
  return new RedisLease(store, name, `scheduler:${name}`, ttlMs);
}
