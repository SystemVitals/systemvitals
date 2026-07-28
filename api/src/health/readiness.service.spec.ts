import type { PrismaService } from '../prisma/prisma.service';
import { redisReadinessConnectionOptions } from './health.module';
import {
  PostgresReadinessProbe,
  READINESS_PROBE_TIMEOUT_MS,
  ReadinessService,
  RedisReadinessProbe,
  type ManagedRedisConnection,
} from './readiness.service';

function createProbe() {
  return {
    check: jest.fn<Promise<void>, []>().mockResolvedValue(undefined),
  };
}

describe('ReadinessService', () => {
  afterEach(() => {
    jest.useRealTimers();
  });

  it('reports starting before the application is marked ready', async () => {
    const postgres = createProbe();
    const redis = createProbe();
    const service = new ReadinessService(postgres, redis);

    await expect(service.check()).resolves.toEqual({
      ready: false,
      reason: 'starting',
    });
    expect(postgres.check).not.toHaveBeenCalled();
    expect(redis.check).not.toHaveBeenCalled();
  });

  it('reports ready after both dependencies pass', async () => {
    const postgres = createProbe();
    const redis = createProbe();
    const service = new ReadinessService(postgres, redis);

    service.markReady();

    await expect(service.check()).resolves.toEqual({ ready: true });
  });

  it('sanitizes a failed Postgres probe', async () => {
    const postgres = createProbe();
    const redis = createProbe();
    postgres.check.mockRejectedValue(
      new Error('postgres://user:secret@database.internal/systemvitals'),
    );
    const service = new ReadinessService(postgres, redis);
    service.markReady();

    await expect(service.check()).resolves.toEqual({
      ready: false,
      reason: 'postgres_unavailable',
    });
    expect(redis.check).not.toHaveBeenCalled();
  });

  it('sanitizes a failed Redis probe', async () => {
    const postgres = createProbe();
    const redis = createProbe();
    redis.check.mockRejectedValue(
      new Error('redis://:secret@redis.internal:6379'),
    );
    const service = new ReadinessService(postgres, redis);
    service.markReady();

    await expect(service.check()).resolves.toEqual({
      ready: false,
      reason: 'redis_unavailable',
    });
  });

  it('bounds a dependency probe that never settles', async () => {
    jest.useFakeTimers();
    const postgres = createProbe();
    const redis = createProbe();
    postgres.check.mockImplementation(() => new Promise(() => undefined));
    const service = new ReadinessService(postgres, redis);
    service.markReady();

    const result = service.check();
    await jest.advanceTimersByTimeAsync(READINESS_PROBE_TIMEOUT_MS);

    await expect(result).resolves.toEqual({
      ready: false,
      reason: 'postgres_unavailable',
    });
  });

  it('coalesces concurrent and subsequent callers around one stalled probe', async () => {
    jest.useFakeTimers();
    const postgres = createProbe();
    const redis = createProbe();
    postgres.check.mockImplementation(() => new Promise(() => undefined));
    const service = new ReadinessService(postgres, redis);
    service.markReady();

    const first = service.check();
    const second = service.check();
    expect(postgres.check).toHaveBeenCalledTimes(1);

    await jest.advanceTimersByTimeAsync(READINESS_PROBE_TIMEOUT_MS);
    await expect(first).resolves.toEqual({
      ready: false,
      reason: 'postgres_unavailable',
    });
    await expect(second).resolves.toEqual({
      ready: false,
      reason: 'postgres_unavailable',
    });

    const afterTimeout = service.check();
    expect(postgres.check).toHaveBeenCalledTimes(1);
    await jest.advanceTimersByTimeAsync(READINESS_PROBE_TIMEOUT_MS);
    await expect(afterTimeout).resolves.toEqual({
      ready: false,
      reason: 'postgres_unavailable',
    });
  });
});

describe('dependency probes', () => {
  it('checks Postgres in a transaction with native acquisition and query deadlines', async () => {
    const queryRaw = jest.fn().mockResolvedValue([{ '?column?': 1 }]);
    const transaction = jest.fn(
      async (
        callback: (client: { $queryRaw: typeof queryRaw }) => Promise<void>,
      ) => callback({ $queryRaw: queryRaw }),
    );
    const probe = new PostgresReadinessProbe({
      $transaction: transaction,
    } as unknown as PrismaService);

    await probe.check();

    expect(queryRaw).toHaveBeenCalledTimes(1);
    expect(transaction).toHaveBeenCalledWith(expect.any(Function), {
      maxWait: READINESS_PROBE_TIMEOUT_MS,
      timeout: READINESS_PROBE_TIMEOUT_MS,
    });
  });

  it('configures native Redis connection and command deadlines', () => {
    expect(
      redisReadinessConnectionOptions('redis://redis.internal:6380/2'),
    ).toEqual(
      expect.objectContaining({
        commandTimeout: READINESS_PROBE_TIMEOUT_MS,
        connectTimeout: READINESS_PROBE_TIMEOUT_MS,
        enableOfflineQueue: false,
        maxRetriesPerRequest: 1,
      }),
    );
  });

  it('reuses and closes one lifecycle-managed Redis connection', async () => {
    const client = {
      info: jest
        .fn<Promise<string>, []>()
        .mockResolvedValue('# Server\r\nredis_version:7.0.0'),
    };
    const connection: ManagedRedisConnection = {
      client: Promise.resolve(client),
      close: jest.fn<Promise<void>, [boolean?]>().mockResolvedValue(undefined),
      on: jest.fn().mockReturnThis(),
    };
    const probe = new RedisReadinessProbe(connection);

    await probe.check();
    await probe.check();
    await probe.onModuleDestroy();

    expect(client.info).toHaveBeenCalledTimes(2);
    expect(connection.close).toHaveBeenCalledTimes(1);
  });
});
