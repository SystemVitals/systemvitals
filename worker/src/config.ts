import "dotenv/config";
import { DEFAULT_WORKER_READINESS_HEARTBEAT_INTERVAL_MS } from "./readiness.js";
import { DEFAULT_WORKER_SHUTDOWN_TIMEOUT_MS } from "./shutdown.js";

function requireEnv(name: string): string {
  const value = process.env[name];
  if (!value) {
    throw new Error(`Missing required environment variable: ${name}`);
  }
  return value;
}

function optionalEnv(name: string, defaultValue: string): string {
  return process.env[name] ?? defaultValue;
}

function optionalNonEmptyEnv(name: string, defaultValue: string): string {
  return process.env[name] || defaultValue;
}

const EMAIL_VERIFICATION_QUEUE_NAME_PATTERN =
  /^[A-Za-z0-9][A-Za-z0-9_-]{0,79}$/;

function emailVerificationQueueEnv(): string {
  const queueName = optionalEnv(
    "QUEUE_EMAIL_VERIFICATION",
    "email-verification",
  ).trim();
  if (!EMAIL_VERIFICATION_QUEUE_NAME_PATTERN.test(queueName)) {
    throw new Error("QUEUE_EMAIL_VERIFICATION has an invalid format");
  }
  return queueName;
}

function appUrlEnv(): string {
  const value = optionalEnv("APP_URL", "http://localhost:9999").trim();
  let url: URL;
  try {
    url = new URL(value);
  } catch {
    throw new Error("APP_URL must be a credential-free HTTP(S) origin");
  }
  if (
    (url.protocol !== "http:" && url.protocol !== "https:") ||
    url.username ||
    url.password ||
    url.pathname !== "/" ||
    url.search ||
    url.hash
  ) {
    throw new Error("APP_URL must be a credential-free HTTP(S) origin");
  }
  return url.origin;
}

function positiveSafeIntegerEnv(name: string, defaultValue: number): number {
  const value = Number(optionalEnv(name, String(defaultValue)));
  if (!Number.isSafeInteger(value) || value <= 0) {
    throw new Error(`${name} must be a positive safe integer`);
  }
  return value;
}

const watchdogIntervalMs = parseInt(
  optionalEnv("WATCHDOG_INTERVAL_MS", "30000"),
  10,
);
const probeSchedulerIntervalMs = parseInt(
  optionalEnv("PROBE_SCHEDULER_INTERVAL_MS", "15000"),
  10,
);

export const config = {
  databaseUrl: requireEnv("DATABASE_URL"),
  redisUrl: optionalEnv("REDIS_URL", "redis://localhost:6379"),
  queueAlert: optionalEnv("QUEUE_ALERT", "alert"),
  queueProbe: optionalEnv("QUEUE_PROBE", "probe"),
  queueEscalation: optionalEnv("QUEUE_ESCALATION", "escalation"),
  queueInvite: optionalEnv("QUEUE_INVITE", "invite"),
  queueEmailVerification: emailVerificationQueueEnv(),
  appUrl: appUrlEnv(),
  watchdogIntervalMs,
  probeSchedulerIntervalMs,
  schedulerLeaseTtlMs: positiveSafeIntegerEnv(
    "SCHEDULER_LEASE_TTL_MS",
    3 * Math.max(watchdogIntervalMs, probeSchedulerIntervalMs),
  ),
  workerShutdownTimeoutMs: positiveSafeIntegerEnv(
    "WORKER_SHUTDOWN_TIMEOUT_MS",
    DEFAULT_WORKER_SHUTDOWN_TIMEOUT_MS,
  ),
  workerReadinessPath: optionalNonEmptyEnv(
    "WORKER_READINESS_PATH",
    "/tmp/systemvitals-worker-ready",
  ),
  workerReadinessHeartbeatIntervalMs: positiveSafeIntegerEnv(
    "WORKER_READINESS_HEARTBEAT_INTERVAL_MS",
    DEFAULT_WORKER_READINESS_HEARTBEAT_INTERVAL_MS,
  ),
  mailFrom: optionalEnv("MAIL_FROM", "alerts@systemvitals.com"),
  telegramBotToken: optionalEnv("TELEGRAM_BOT_TOKEN", ""),
  ssrfAllowPrivate: process.env.SSRF_ALLOW_PRIVATE === "true",
} as const;
