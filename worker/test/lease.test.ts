import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
  createSchedulerLease,
  RedisLease,
  type LeaseStore,
} from "../src/lease.js";

interface StoredLease {
  owner: string;
  expiresAt: number;
}

type RenewBehavior = "normal" | "false" | "reject" | "stall";

class FakeLeaseStore implements LeaseStore {
  readonly leases = new Map<string, StoredLease>();
  readonly evalCalls: Array<{ script: string; args: string[] }> = [];
  failNextRelease = false;
  renewBehavior: RenewBehavior = "normal";
  renewCalls = 0;
  activeRenewals = 0;
  maximumActiveRenewals = 0;
  releaseCalls = 0;
  blockReleaseBehindStalledRenewal = false;
  private finishStalledRenewal: (() => void) | undefined;
  private stalledRenewal: Promise<void> | undefined;

  async set(
    key: string,
    value: string,
    expiry: "PX",
    ttlMs: number,
    mode: "NX",
  ): Promise<"OK" | null> {
    expect(expiry).toBe("PX");
    expect(mode).toBe("NX");
    this.expire(key);
    if (this.leases.has(key)) {
      return null;
    }
    this.leases.set(key, { owner: value, expiresAt: Date.now() + ttlMs });
    return "OK";
  }

  async eval(
    script: string,
    numberOfKeys: number,
    ...args: string[]
  ): Promise<number> {
    expect(numberOfKeys).toBe(1);
    this.evalCalls.push({ script, args });

    if (script.includes("PEXPIRE")) {
      this.renewCalls += 1;
      this.activeRenewals += 1;
      this.maximumActiveRenewals = Math.max(
        this.maximumActiveRenewals,
        this.activeRenewals,
      );
      try {
        if (this.renewBehavior === "false") {
          return 0;
        }
        if (this.renewBehavior === "reject") {
          throw new Error("Redis unavailable during renewal");
        }
        if (this.renewBehavior === "stall") {
          this.stalledRenewal ??= new Promise<void>((resolve) => {
            this.finishStalledRenewal = resolve;
          });
          await this.stalledRenewal;
        }
      } finally {
        this.activeRenewals -= 1;
      }
    }

    if (script.includes("DEL")) {
      this.releaseCalls += 1;
      if (
        this.blockReleaseBehindStalledRenewal &&
        this.activeRenewals > 0 &&
        this.stalledRenewal
      ) {
        await this.stalledRenewal;
      }
    }

    const [key, owner, ttlMs] = args;
    this.expire(key);
    const current = this.leases.get(key);
    if (current?.owner !== owner) {
      return 0;
    }

    if (script.includes("PEXPIRE")) {
      current.expiresAt = Date.now() + Number(ttlMs);
      return 1;
    }
    if (script.includes("DEL")) {
      if (this.failNextRelease) {
        this.failNextRelease = false;
        throw new Error("Redis unavailable");
      }
      this.leases.delete(key);
      return 1;
    }
    throw new Error("Unexpected Lua script");
  }

  ownerOf(key: string): string | undefined {
    this.expire(key);
    return this.leases.get(key)?.owner;
  }

  resolveStalledRenewal(): void {
    this.finishStalledRenewal?.();
  }

  private expire(key: string): void {
    const current = this.leases.get(key);
    if (current && current.expiresAt <= Date.now()) {
      this.leases.delete(key);
    }
  }
}

describe("RedisLease", () => {
  beforeEach(() => {
    vi.useFakeTimers();
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  it("acquires, contends, renews, and releases only for its owner", async () => {
    const store = new FakeLeaseStore();
    const leaseA = new RedisLease(store, "watchdog", "owner-a", 300);
    const leaseB = new RedisLease(store, "watchdog", "owner-b", 300);

    expect(await leaseA.acquire()).toBe(true);
    expect(await leaseB.acquire()).toBe(false);
    expect(await leaseA.renew()).toBe(true);
    expect(await leaseB.release()).toBe(false);
    expect(await leaseA.release()).toBe(true);

    expect(store.evalCalls.some(({ script }) => script.includes("PEXPIRE"))).toBe(
      true,
    );
    expect(store.evalCalls.some(({ script }) => script.includes("DEL"))).toBe(
      true,
    );
  });

  it("preserves ownership when acquire is repeated on the current owner", async () => {
    const store = new FakeLeaseStore();
    const lease = new RedisLease(store, "watchdog", "owner-a", 300);

    expect(await lease.acquire()).toBe(true);
    const winningToken = store.ownerOf("systemvitals:lease:watchdog");
    expect(await lease.acquire()).toBe(false);

    expect(store.ownerOf("systemvitals:lease:watchdog")).toBe(winningToken);
    expect(await lease.renew()).toBe(true);
    expect(await lease.release()).toBe(true);
  });

  it("preserves the winning token across concurrent acquire calls", async () => {
    const store = new FakeLeaseStore();
    const lease = new RedisLease(store, "watchdog", "owner-a", 300);

    const outcomes = await Promise.all([lease.acquire(), lease.acquire()]);

    expect(outcomes.filter(Boolean)).toHaveLength(1);
    expect(await lease.renew()).toBe(true);
    expect(await lease.release()).toBe(true);
  });

  it("allows a successor after expiry and prevents the old owner deleting it", async () => {
    const store = new FakeLeaseStore();
    const leaseA = new RedisLease(store, "probe-scheduler", "owner-a", 300);
    const leaseB = new RedisLease(store, "probe-scheduler", "owner-b", 300);

    expect(await leaseA.acquire()).toBe(true);
    await vi.advanceTimersByTimeAsync(301);
    expect(await leaseB.acquire()).toBe(true);
    const successorToken = store.ownerOf(
      "systemvitals:lease:probe-scheduler",
    );

    expect(await leaseA.release()).toBe(false);
    expect(store.ownerOf("systemvitals:lease:probe-scheduler")).toBe(
      successorToken,
    );
  });

  it("uses a UUID-bearing token and namespaced key in the scheduler helper", async () => {
    const store = new FakeLeaseStore();
    const lease = createSchedulerLease(store, "watchdog", 300);

    expect(await lease.acquire()).toBe(true);

    const token = store.ownerOf("systemvitals:lease:watchdog");
    expect(token).toMatch(
      /[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i,
    );
  });

  it("never overlaps competing loops or concurrent runs on one instance", async () => {
    const store = new FakeLeaseStore();
    const leaseA = new RedisLease(store, "watchdog", "owner-a", 300);
    const leaseB = new RedisLease(store, "watchdog", "owner-b", 300);
    let activeCallbacks = 0;
    let maximumActiveCallbacks = 0;
    let finishA: (() => void) | undefined;

    const protectedCallback = async (): Promise<void> => {
      activeCallbacks += 1;
      maximumActiveCallbacks = Math.max(maximumActiveCallbacks, activeCallbacks);
      await new Promise<void>((resolve) => {
        finishA = resolve;
      });
      activeCallbacks -= 1;
    };

    const firstRun = leaseA.run(protectedCallback);
    await vi.advanceTimersByTimeAsync(0);

    expect(await leaseA.run(async () => {})).toBe("contended");
    expect(await leaseB.run(async () => {})).toBe("contended");

    await vi.advanceTimersByTimeAsync(1_000);
    expect(await leaseB.run(async () => {})).toBe("contended");

    finishA?.();
    expect(await firstRun).toBe("ran");
    expect(await leaseB.run(async () => {})).toBe("ran");
    expect(maximumActiveCallbacks).toBe(1);
  });

  it("does not release a successor when the old callback fails after expiry", async () => {
    const store = new FakeLeaseStore();
    const leaseA = new RedisLease(store, "watchdog", "owner-a", 300);
    const leaseB = new RedisLease(store, "watchdog", "owner-b", 300);
    let rejectA: ((error: Error) => void) | undefined;

    const runA = leaseA.run(
      () =>
        new Promise<void>((_resolve, reject) => {
          rejectA = reject;
        }),
      { renew: false },
    );
    await vi.advanceTimersByTimeAsync(301);
    expect(await leaseB.acquire()).toBe(true);
    const successorToken = store.ownerOf("systemvitals:lease:watchdog");

    rejectA?.(new Error("callback failed"));
    await expect(runA).rejects.toThrow("callback failed");
    expect(store.ownerOf("systemvitals:lease:watchdog")).toBe(successorToken);
  });

  it("uses a unique token when same-owner lease instances hand off after expiry", async () => {
    const store = new FakeLeaseStore();
    const leaseA = new RedisLease(store, "watchdog", "same-owner", 300);
    const leaseB = new RedisLease(store, "watchdog", "same-owner", 300);

    expect(await leaseA.acquire()).toBe(true);
    const tokenA = store.ownerOf("systemvitals:lease:watchdog");
    await vi.advanceTimersByTimeAsync(301);
    expect(await leaseB.acquire()).toBe(true);
    const tokenB = store.ownerOf("systemvitals:lease:watchdog");

    expect(tokenB).not.toBe(tokenA);
    expect(await leaseA.release()).toBe(false);
    expect(store.ownerOf("systemvitals:lease:watchdog")).toBe(tokenB);
  });

  it("uses a fresh token for every acquisition by one lease instance", async () => {
    const store = new FakeLeaseStore();
    const lease = new RedisLease(store, "watchdog", "owner-a", 300);

    expect(await lease.acquire()).toBe(true);
    const firstToken = store.ownerOf("systemvitals:lease:watchdog");
    expect(await lease.release()).toBe(true);
    expect(await lease.acquire()).toBe(true);

    expect(store.ownerOf("systemvitals:lease:watchdog")).not.toBe(firstToken);
  });

  it("aborts and fences staged work when renewal reports ownership loss", async () => {
    const store = new FakeLeaseStore();
    store.renewBehavior = "false";
    const lease = new RedisLease(store, "watchdog", "owner-a", 300);
    const stages: string[] = [];
    let continueCallback: (() => void) | undefined;
    let observedSignal: AbortSignal | undefined;

    const run = lease.run(async (signal) => {
      observedSignal = signal;
      signal.throwIfAborted();
      stages.push("read");
      await new Promise<void>((resolve) => {
        continueCallback = resolve;
      });
      signal.throwIfAborted();
      stages.push("enqueue");
    });
    await vi.advanceTimersByTimeAsync(100);
    const wasAborted = observedSignal?.aborted;
    continueCallback?.();

    await expect(run).rejects.toThrow("Lease ownership lost");
    expect(wasAborted).toBe(true);
    expect(stages).toEqual(["read"]);
  });

  it("stops renewal immediately and aborts the callback when its scheduler stops", async () => {
    const store = new FakeLeaseStore();
    const lease = new RedisLease(store, "watchdog", "owner-a", 300);
    const schedulerAbort = new AbortController();
    const stopReason = new Error("scheduler stopped");
    let finishCallback!: () => void;
    let observedSignal: AbortSignal | undefined;

    const run = lease.run(
      async (signal) => {
        observedSignal = signal;
        await new Promise<void>((resolve) => {
          finishCallback = resolve;
        });
      },
      { signal: schedulerAbort.signal },
    );

    await vi.advanceTimersByTimeAsync(100);
    expect(store.renewCalls).toBe(1);
    schedulerAbort.abort(stopReason);
    const wasAborted = observedSignal?.aborted;
    await vi.advanceTimersByTimeAsync(500);
    const renewCallsAfterStop = store.renewCalls;
    finishCallback();
    const result = await run.then(
      () => undefined,
      (error: unknown) => error,
    );

    expect(wasAborted).toBe(true);
    expect(renewCallsAfterStop).toBe(1);
    expect(result).toBe(stopReason);
  });

  it("aborts and does not report ran when renewal rejects", async () => {
    const store = new FakeLeaseStore();
    store.renewBehavior = "reject";
    const lease = new RedisLease(store, "watchdog", "owner-a", 300);
    let continueCallback: (() => void) | undefined;
    let observedSignal: AbortSignal | undefined;

    const run = lease.run(async (signal) => {
      observedSignal = signal;
      await new Promise<void>((resolve) => {
        continueCallback = resolve;
      });
    });
    await vi.advanceTimersByTimeAsync(100);
    const wasAborted = observedSignal?.aborted;
    continueCallback?.();

    await expect(run).rejects.toThrow("Lease ownership lost");
    expect(wasAborted).toBe(true);
  });

  it("serializes renewals and fences work when a renewal stalls", async () => {
    const store = new FakeLeaseStore();
    store.renewBehavior = "stall";
    const leaseA = new RedisLease(store, "watchdog", "same-owner", 300);
    const leaseB = new RedisLease(store, "watchdog", "same-owner", 300);
    let continueCallback: (() => void) | undefined;
    let observedSignal: AbortSignal | undefined;

    const runA = leaseA.run(async (signal) => {
      observedSignal = signal;
      await new Promise<void>((resolve) => {
        continueCallback = resolve;
      });
    });

    await vi.advanceTimersByTimeAsync(250);
    const wasAborted = observedSignal?.aborted;
    await vi.advanceTimersByTimeAsync(51);
    expect(await leaseB.acquire()).toBe(true);
    const successorToken = store.ownerOf("systemvitals:lease:watchdog");

    store.resolveStalledRenewal();
    continueCallback?.();
    await expect(runA).rejects.toThrow("Lease ownership lost");

    expect(wasAborted).toBe(true);
    expect(store.renewCalls).toBe(1);
    expect(store.maximumActiveRenewals).toBe(1);
    expect(store.ownerOf("systemvitals:lease:watchdog")).toBe(successorToken);
  });

  it("bounds renewal shutdown without queuing release behind a stalled eval", async () => {
    const store = new FakeLeaseStore();
    store.renewBehavior = "stall";
    store.blockReleaseBehindStalledRenewal = true;
    const lease = new RedisLease(store, "watchdog", "owner-a", 300);
    let finishCallback: (() => void) | undefined;
    let runSettled = false;

    const outcome = lease.run(
      () =>
        new Promise<void>((resolve) => {
          finishCallback = resolve;
        }),
    ).then(
      (value) => {
        runSettled = true;
        return { value, error: undefined };
      },
      (error: unknown) => {
        runSettled = true;
        return { value: undefined, error };
      },
    );

    await vi.advanceTimersByTimeAsync(150);
    expect(store.activeRenewals).toBe(1);
    finishCallback?.();
    await vi.advanceTimersByTimeAsync(50);
    const settledByRenewalDeadline = runSettled;
    const releaseCallsAtDeadline = store.releaseCalls;

    store.resolveStalledRenewal();
    await vi.advanceTimersByTimeAsync(0);
    const result = await outcome;

    expect(settledByRenewalDeadline).toBe(true);
    expect(releaseCallsAtDeadline).toBe(0);
    expect(result.error).toMatchObject({
      name: "LeaseOwnershipLostError",
    });
  });

  it("preserves callback failure first when release also fails", async () => {
    const store = new FakeLeaseStore();
    const lease = new RedisLease(store, "watchdog", "owner-a", 300);
    const callbackError = new Error("callback failed");
    store.failNextRelease = true;

    const error = await lease.run(async () => {
      throw callbackError;
    }).then(
      () => undefined,
      (caught: unknown) => caught,
    );

    expect(error).toBeInstanceOf(AggregateError);
    expect((error as AggregateError).errors[0]).toBe(callbackError);
    expect((error as AggregateError).errors[1]).toMatchObject({
      message: "Redis unavailable",
    });
  });

  it.each([0, -1, 1.5, Number.MAX_SAFE_INTEGER + 1, Infinity, NaN])(
    "rejects a TTL that is not a positive safe integer: %s",
    (ttlMs) => {
      const store = new FakeLeaseStore();

      expect(
        () => new RedisLease(store, "watchdog", "owner-a", ttlMs),
      ).toThrow("Lease TTL must be a positive safe integer");
    },
  );

  it("allows a later run after Redis errors while releasing", async () => {
    const store = new FakeLeaseStore();
    const lease = new RedisLease(store, "watchdog", "owner-a", 300);
    store.failNextRelease = true;

    await expect(lease.run(async () => {})).rejects.toThrow("Redis unavailable");
    await vi.advanceTimersByTimeAsync(301);

    expect(await lease.run(async () => {})).toBe("ran");
  });
});

describe("scheduler lease configuration", () => {
  const originalTtl = process.env.SCHEDULER_LEASE_TTL_MS;

  afterEach(() => {
    if (originalTtl === undefined) {
      delete process.env.SCHEDULER_LEASE_TTL_MS;
    } else {
      process.env.SCHEDULER_LEASE_TTL_MS = originalTtl;
    }
    vi.resetModules();
  });

  it("defaults to at least three times the longest scheduler interval", async () => {
    delete process.env.SCHEDULER_LEASE_TTL_MS;
    vi.resetModules();

    const { config } = await import("../src/config.js");

    expect(config.schedulerLeaseTtlMs).toBeGreaterThanOrEqual(
      3 * Math.max(config.watchdogIntervalMs, config.probeSchedulerIntervalMs),
    );
  });

  it.each([
    "0",
    "-1",
    "1.5",
    String(Number.MAX_SAFE_INTEGER + 1),
    "NaN",
    "Infinity",
    "100ms",
  ])(
    "rejects a TTL that is not a positive safe integer: %s",
    async (value) => {
      process.env.SCHEDULER_LEASE_TTL_MS = value;
      vi.resetModules();

      await expect(import("../src/config.js")).rejects.toThrow(
        "SCHEDULER_LEASE_TTL_MS must be a positive safe integer",
      );
    },
  );
});
