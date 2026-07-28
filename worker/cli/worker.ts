import "dotenv/config";
import { program } from "commander";
import { Queue, Worker } from "bullmq";
import type { ConnectionOptions } from "bullmq";
import { Redis as IORedis } from "ioredis";
import { config } from "../src/config.js";
import { prisma } from "../src/prisma.js";
import { sweepOverdue } from "../src/watchdog.js";
import type { AlertJob } from "../src/watchdog.js";
import { redisConnection } from "../src/redis.js";
import { handleAlert } from "../src/alert-handler.js";
import { NodemailerMailer } from "../src/mailer.js";
import { httpPost, telegramPost } from "../src/notifiers.js";
import { scheduleDueProbes } from "../src/probe-scheduler.js";
import type { ProbeJob } from "../src/probe-scheduler.js";
import { handleProbe } from "../src/probe-handler.js";
import { probe } from "../src/prober.js";
import { handleInvite } from "../src/invite-handler.js";
import type { InviteJob } from "../src/invite-handler.js";
import {
  handleEmailVerification,
  type EmailVerificationJob,
} from "../src/email-verification-handler.js";
import {
  createIdempotentShutdown,
  gracefulShutdown,
  registerShutdownSignals,
} from "../src/shutdown.js";
import type {
  ShutdownResources,
  WorkerShutdownSignal,
} from "../src/shutdown.js";
import { establishWorkerReadiness, ReadinessMarker } from "../src/readiness.js";
import type { ReadyWorker } from "../src/readiness.js";
import { createSchedulerLease, type LeaseStore } from "../src/lease.js";
import { TrackedScheduler } from "../src/tracked-scheduler.js";

program
  .name("worker")
  .description("SystemVitals BullMQ monitoring engine")
  .version("1.0.0")
  .action(startWorker);

async function startWorker(): Promise<void> {
  const readiness = new ReadinessMarker(
    config.workerReadinessPath,
    config.workerReadinessHeartbeatIntervalMs,
  );
  const workers: ShutdownResources["workers"] = [];
  const readyWorkers: ReadyWorker[] = [];
  const queues: ShutdownResources["queues"] = [];
  const redisResources: ShutdownResources["redis"] = [];
  const schedulers: ShutdownResources["schedulers"] = [];
  const intervals: NodeJS.Timeout[] = [];
  const startupAbort = new AbortController();
  let terminationRequested = false;

  const shutdownResources: ShutdownResources = {
    readiness,
    workers,
    queues,
    redis: redisResources,
    schedulers,
    intervals,
    prisma,
  };

  let unregisterSignals = (): void => {};
  const shutdown = createIdempotentShutdown(async () => {
    if (!startupAbort.signal.aborted) {
      startupAbort.abort(new Error("Worker shutdown requested"));
    }
    console.log("[worker] Shutting down gracefully...");
    try {
      await gracefulShutdown(shutdownResources, config.workerShutdownTimeoutMs);
    } finally {
      unregisterSignals();
    }
  });

  const requestShutdown = (signal: WorkerShutdownSignal): void => {
    terminationRequested = true;
    if (!startupAbort.signal.aborted) {
      startupAbort.abort(new Error(`${signal} received during worker startup`));
    }
    void shutdown().catch((error: unknown) => {
      console.error("[worker] Graceful shutdown failed:", error);
      process.exitCode = 1;
    });
  };
  unregisterSignals = registerShutdownSignals(requestShutdown);

  try {
    await readiness.markNotReady();
    startupAbort.signal.throwIfAborted();

    const connection: ConnectionOptions = redisConnection(config.redisUrl);
    const controlRedis = new IORedis(config.redisUrl, {
      lazyConnect: true,
      maxRetriesPerRequest: null,
    });
    const onControlRedisError = (error: Error): void => {
      console.error("[worker] scheduler Redis error:", error);
    };
    controlRedis.on("error", onControlRedisError);
    redisResources.push({
      close: async () => {
        if (controlRedis.status === "wait") {
          controlRedis.disconnect();
        } else if (controlRedis.status !== "end") {
          await controlRedis.quit();
        }
        controlRedis.off("error", onControlRedisError);
      },
      disconnect: () => {
        controlRedis.disconnect();
        controlRedis.off("error", onControlRedisError);
      },
    });

    const leaseStore: LeaseStore = {
      set: (key, value, expiry, ttlMs, mode) =>
        controlRedis.set(key, value, expiry, ttlMs, mode),
      eval: (script, numberOfKeys, ...args) =>
        controlRedis.eval(script, numberOfKeys, ...args),
    };
    const watchdogLease = createSchedulerLease(
      leaseStore,
      "watchdog",
      config.schedulerLeaseTtlMs,
    );
    const probeSchedulerLease = createSchedulerLease(
      leaseStore,
      "probe-scheduler",
      config.schedulerLeaseTtlMs,
    );
    const reportSchedulerError = (error: unknown): void => {
      console.error("[worker] scheduler run failed:", error);
    };
    const watchdogScheduler = new TrackedScheduler(reportSchedulerError);
    const probeScheduler = new TrackedScheduler(reportSchedulerError);
    schedulers.push(watchdogScheduler, probeScheduler);

    const mailer = new NodemailerMailer();
    const defaultJobOptions = {
      attempts: 3,
      backoff: { type: "exponential", delay: 5000 },
      removeOnComplete: 100,
      removeOnFail: 500,
    } as const;
    const emailVerificationJobOptions = {
      attempts: 3,
      backoff: { type: "exponential", delay: 5000 },
      removeOnComplete: true,
      removeOnFail: true,
    } as const;

    const alertQueue = new Queue<AlertJob, void, "alert">(config.queueAlert, {
      connection,
      defaultJobOptions,
    });
    observeQueue(alertQueue, "alert");
    queues.push(alertQueue);
    const probeQueue = new Queue<ProbeJob, void, "probe">(config.queueProbe, {
      connection,
      defaultJobOptions,
    });
    observeQueue(probeQueue, "probe");
    queues.push(probeQueue);
    const inviteQueue = new Queue<InviteJob, void, "invite">(
      config.queueInvite,
      { connection, defaultJobOptions },
    );
    observeQueue(inviteQueue, "invite");
    queues.push(inviteQueue);
    const emailVerificationQueue = new Queue<
      EmailVerificationJob,
      void,
      "email-verification"
    >(config.queueEmailVerification, {
      connection,
      defaultJobOptions: emailVerificationJobOptions,
    });
    observeQueue(emailVerificationQueue, "email-verification");
    queues.push(emailVerificationQueue);

    const enqueueAlert = (
      data: AlertJob,
      options?: { jobId: string },
    ): Promise<unknown> => alertQueue.add("alert", data, options);
    const deps = {
      mailer,
      httpPost,
      telegramPost,
      telegramBotToken: config.telegramBotToken,
    };

    const alertWorker = new Worker<AlertJob, void>(
      config.queueAlert,
      async (job) => {
        const sent = await handleAlert(prisma, deps, job.data);
        console.log(
          `[worker] alert job ${job.id}: sent ${sent} notification(s) for check ${job.data.checkId}`,
        );
      },
      { connection, autorun: false },
    );
    observeWorker(alertWorker, "alert");
    workers.push(alertWorker);
    readyWorkers.push(readyWorker(alertWorker, "alert"));

    const probeWorker = new Worker<ProbeJob, void>(
      config.queueProbe,
      async (job) => {
        await handleProbe(
          prisma,
          enqueueAlert,
          (check) => probe(check, config.ssrfAllowPrivate),
          job.data,
        );
        console.log(
          `[worker] probe job ${job.id}: handled check ${job.data.checkId}`,
        );
      },
      { connection, autorun: false },
    );
    observeWorker(probeWorker, "probe");
    workers.push(probeWorker);
    readyWorkers.push(readyWorker(probeWorker, "probe"));

    const inviteWorker = new Worker<InviteJob, void>(
      config.queueInvite,
      async (job) => {
        const sent = await handleInvite(
          prisma,
          { mailer, appUrl: config.appUrl },
          job.data,
        );
        console.log(
          `[worker] invite job ${job.id}: ${sent ? "sent" : "skipped"} invite ${job.data.inviteId}`,
        );
      },
      { connection, autorun: false },
    );
    observeWorker(inviteWorker, "invite");
    workers.push(inviteWorker);
    readyWorkers.push(readyWorker(inviteWorker, "invite"));

    const emailVerificationWorker = new Worker<EmailVerificationJob, void>(
      config.queueEmailVerification,
      async (job) => {
        const sent = await handleEmailVerification(
          prisma,
          { mailer, appUrl: config.appUrl },
          job.data,
        );
        console.log(
          `[worker] email-verification job ${job.id}: ${
            sent ? "sent" : "skipped"
          } channel ${job.data.channelId}`,
        );
      },
      { connection, autorun: false },
    );
    observeWorker(emailVerificationWorker, "email-verification");
    workers.push(emailVerificationWorker);
    readyWorkers.push(
      readyWorker(emailVerificationWorker, "email-verification"),
    );

    await establishWorkerReadiness({
      marker: readiness,
      checkPrisma: () => prisma.$queryRawUnsafe("SELECT 1"),
      checkRedis: async () => {
        await controlRedis.ping();
        startupAbort.signal.throwIfAborted();
        await watchdogLease.run(async (signal) => {
          signal.throwIfAborted();
          startupAbort.signal.throwIfAborted();
        });
        startupAbort.signal.throwIfAborted();
        await probeSchedulerLease.run(async (signal) => {
          signal.throwIfAborted();
          startupAbort.signal.throwIfAborted();
        });
      },
      workers: readyWorkers,
      signal: startupAbort.signal,
      checkHeartbeat: async () => {
        await prisma.$queryRawUnsafe("SELECT 1");
        await controlRedis.ping();
        await Promise.all(
          readyWorkers.map((worker) =>
            worker.checkReady ? worker.checkReady() : worker.waitUntilReady(),
          ),
        );
      },
      onStartupFailure: shutdown,
    });
    startupAbort.signal.throwIfAborted();

    console.log(
      `[worker] Starting watchdog sweep every ${config.watchdogIntervalMs}ms`,
    );
    const watchdogInterval = setInterval(() => {
      watchdogScheduler.run((schedulerSignal) =>
        watchdogLease.run(
          async (leaseSignal) => {
            const signal = AbortSignal.any([schedulerSignal, leaseSignal]);
            signal.throwIfAborted();
            await sweepOverdue(prisma, enqueueAlert, new Date(), signal);
            signal.throwIfAborted();
          },
          { signal: schedulerSignal },
        ),
      );
    }, config.watchdogIntervalMs);
    intervals.push(watchdogInterval);

    console.log(
      `[worker] Starting probe scheduler every ${config.probeSchedulerIntervalMs}ms`,
    );
    const probeSchedulerInterval = setInterval(() => {
      probeScheduler.run((schedulerSignal) =>
        probeSchedulerLease.run(
          async (leaseSignal) => {
            const signal = AbortSignal.any([schedulerSignal, leaseSignal]);
            signal.throwIfAborted();
            const scheduledAt = new Date();
            await scheduleDueProbes(
              prisma,
              (data, options) => probeQueue.add("probe", data, options),
              scheduledAt,
              signal,
            );
            signal.throwIfAborted();
          },
          { signal: schedulerSignal },
        ),
      );
    }, config.probeSchedulerIntervalMs);
    intervals.push(probeSchedulerInterval);
    console.log("[worker] Ready");
  } catch (startupError) {
    let shutdownError: unknown;
    try {
      await shutdown();
    } catch (error) {
      shutdownError = error;
    }

    if (terminationRequested && shutdownError === undefined) {
      return;
    }
    if (shutdownError !== undefined) {
      throw new AggregateError(
        [startupError, shutdownError],
        "Worker startup and cleanup failed",
      );
    }
    throw startupError;
  }
}

function readyWorker<Data>(
  worker: Worker<Data, void>,
  name: string,
): ReadyWorker {
  let execution: Promise<void> | undefined;

  return {
    start: () => {
      execution = worker.run();
    },
    waitUntilReady: () => {
      if (!execution) {
        return Promise.reject(new Error(`${name} worker was not started`));
      }
      const stoppedBeforeReady = execution.then<never>(
        () => {
          throw new Error(`${name} worker stopped before becoming ready`);
        },
        (error: unknown) => {
          throw error;
        },
      );
      return Promise.race([worker.waitUntilReady(), stoppedBeforeReady]);
    },
    checkReady: async () => {
      if (!worker.isRunning()) {
        throw new Error(`${name} worker is not running`);
      }
      await worker.waitUntilReady();
    },
  };
}

function observeWorker<Data>(worker: Worker<Data, void>, name: string): void {
  worker.on("failed", (job, error) => {
    console.error(
      `[worker] ${name} job ${job?.id ?? "unknown"} failed:`,
      error,
    );
  });
  worker.on("error", (error) => {
    console.error(`[worker] ${name} worker error:`, error);
  });
}

function observeQueue<Data, Name extends string>(
  queue: Queue<Data, void, Name>,
  name: string,
): void {
  queue.on("error", (error) => {
    console.error(`[worker] ${name} queue error:`, error);
  });
}

void program.parseAsync().catch((error: unknown) => {
  console.error("[worker] Startup failed:", error);
  process.exitCode = 1;
});
