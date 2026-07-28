import type { JobsOptions } from 'bullmq';

export interface RedisConnectionOptions {
  host: string;
  port: number;
  password?: string;
  db?: number;
  maxRetriesPerRequest: null;
}

/** Parse a `redis://[:password@]host[:port][/db]` URL into a BullMQ connection object. */
export function parseRedisUrl(url: string): RedisConnectionOptions {
  const parsed = new URL(url);
  const result: RedisConnectionOptions = {
    host: parsed.hostname || 'localhost',
    port: parsed.port ? parseInt(parsed.port, 10) : 6379,
    maxRetriesPerRequest: null,
  };
  if (parsed.password) {
    result.password = decodeURIComponent(parsed.password);
  }
  if (parsed.pathname && parsed.pathname.length > 1) {
    result.db = Number(parsed.pathname.slice(1));
  }
  return result;
}

/** Shared default job options for all BullMQ queues in this app. */
export const DEFAULT_JOB_OPTIONS: JobsOptions = {
  attempts: 3,
  backoff: { type: 'exponential', delay: 5000 },
  removeOnComplete: 100,
  removeOnFail: 500,
};
