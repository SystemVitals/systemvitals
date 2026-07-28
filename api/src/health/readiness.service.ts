import { Inject, Injectable, type OnModuleDestroy } from '@nestjs/common';
import { PrismaService } from '../prisma/prisma.service';

export const READINESS_PROBE_TIMEOUT_MS = 1_000;
export const REDIS_READINESS_CONNECTION = Symbol('REDIS_READINESS_CONNECTION');
export const POSTGRES_READINESS_PROBE = Symbol('POSTGRES_READINESS_PROBE');
export const REDIS_READINESS_PROBE = Symbol('REDIS_READINESS_PROBE');

export type ReadinessReason =
  | 'starting'
  | 'postgres_unavailable'
  | 'redis_unavailable';

export interface ReadinessResult {
  ready: boolean;
  reason?: ReadinessReason;
}

export interface DependencyProbe {
  check(): Promise<void>;
}

interface RedisProbeClient {
  info: () => Promise<unknown>;
}

export interface ManagedRedisConnection {
  readonly client: Promise<RedisProbeClient>;
  on: (event: 'error', listener: (error: unknown) => void) => unknown;
  close: (force?: boolean) => Promise<void>;
}

@Injectable()
export class PostgresReadinessProbe implements DependencyProbe {
  constructor(private readonly prisma: PrismaService) {}

  async check(): Promise<void> {
    await this.prisma.$transaction(
      async (transaction) => {
        await transaction.$queryRaw`SELECT 1`;
      },
      {
        maxWait: READINESS_PROBE_TIMEOUT_MS,
        timeout: READINESS_PROBE_TIMEOUT_MS,
      },
    );
  }
}

@Injectable()
export class RedisReadinessProbe implements DependencyProbe, OnModuleDestroy {
  constructor(
    @Inject(REDIS_READINESS_CONNECTION)
    private readonly connection: ManagedRedisConnection,
  ) {
    // Connection failures are represented by readiness, never emitted as an
    // unhandled EventEmitter error or exposed to the HTTP response.
    this.connection.on('error', () => undefined);
  }

  async check(): Promise<void> {
    const client = await this.connection.client;
    await client.info();
  }

  async onModuleDestroy(): Promise<void> {
    await this.connection.close();
  }
}

@Injectable()
export class ReadinessService {
  private state: 'starting' | 'ready' = 'starting';
  private checkInFlight?: Promise<ReadinessResult>;
  private readonly probeOperations = new Map<DependencyProbe, Promise<void>>();

  constructor(
    @Inject(POSTGRES_READINESS_PROBE)
    private readonly postgres: DependencyProbe,
    @Inject(REDIS_READINESS_PROBE)
    private readonly redis: DependencyProbe,
  ) {}

  markReady(): void {
    this.state = 'ready';
  }

  check(): Promise<ReadinessResult> {
    const localResult = this.localResult();
    if (localResult) {
      return Promise.resolve(localResult);
    }

    if (!this.checkInFlight) {
      const operation = this.runCheck();
      this.checkInFlight = operation;
      const clear = () => {
        if (this.checkInFlight === operation) {
          this.checkInFlight = undefined;
        }
      };
      void operation.then(clear, clear);
    }
    return this.checkInFlight;
  }

  private async runCheck(): Promise<ReadinessResult> {
    const postgresReady = await this.probe(this.postgres);
    const afterPostgres = this.localResult();
    if (afterPostgres) return afterPostgres;
    if (!postgresReady) {
      return { ready: false, reason: 'postgres_unavailable' };
    }

    const redisReady = await this.probe(this.redis);
    const afterRedis = this.localResult();
    if (afterRedis) return afterRedis;
    if (!redisReady) {
      return { ready: false, reason: 'redis_unavailable' };
    }
    return { ready: true };
  }

  private localResult(): ReadinessResult | undefined {
    if (this.state === 'ready') return undefined;
    return { ready: false, reason: this.state };
  }

  private async probe(probe: DependencyProbe): Promise<boolean> {
    let timer: NodeJS.Timeout | undefined;
    try {
      await Promise.race([
        this.probeOperation(probe),
        new Promise<never>((_, reject) => {
          timer = setTimeout(
            () => reject(new Error('readiness probe timed out')),
            READINESS_PROBE_TIMEOUT_MS,
          );
        }),
      ]);
      return true;
    } catch {
      return false;
    } finally {
      if (timer) clearTimeout(timer);
    }
  }

  private probeOperation(probe: DependencyProbe): Promise<void> {
    const existing = this.probeOperations.get(probe);
    if (existing) return existing;

    let operation: Promise<void>;
    try {
      operation = probe.check();
    } catch (error) {
      operation = Promise.reject(
        error instanceof Error
          ? error
          : new Error('readiness probe failed', { cause: error }),
      );
    }
    this.probeOperations.set(probe, operation);
    const clear = () => {
      if (this.probeOperations.get(probe) === operation) {
        this.probeOperations.delete(probe);
      }
    };
    void operation.then(clear, clear);
    return operation;
  }
}
