import { Inject, Injectable, Optional } from '@nestjs/common';
import { Client, type QueryResult } from 'pg';
import {
  ACCOUNT_USER_LOCK_HASH_SEED,
  accountUserLockKey,
} from './account-user-lock';

const GLOBAL_RECONCILIATION_LOCK = 1_735_688_564;
const LOCK_ACQUIRE_TIMEOUT_MS = 5_000;
const LOCK_POLL_INTERVAL_MS = 250;
const LOCK_QUERY_TIMEOUT_MS = 5_000;

interface LockClient {
  connect(): Promise<unknown>;
  query(text: string, values?: unknown[]): Promise<QueryResult>;
  end(): Promise<void>;
}
type CreateLockClient = () => LockClient;
type Clock = () => number;
type Sleep = (milliseconds: number) => Promise<void>;
const RECONCILIATION_LOCK_CLIENT = Symbol('RECONCILIATION_LOCK_CLIENT');
const RECONCILIATION_LOCK_CLOCK = Symbol('RECONCILIATION_LOCK_CLOCK');
const RECONCILIATION_LOCK_SLEEP = Symbol('RECONCILIATION_LOCK_SLEEP');

export class ReconciliationLockUnavailableError extends Error {
  constructor() {
    super('Reconciliation is already running; lock acquisition timed out');
  }
}

@Injectable()
export class ReconciliationRunLock {
  constructor(
    @Optional()
    @Inject(RECONCILIATION_LOCK_CLIENT)
    private readonly createClientOverride?: CreateLockClient,
    @Optional()
    @Inject(RECONCILIATION_LOCK_CLOCK)
    private readonly now: Clock = Date.now,
    @Optional()
    @Inject(RECONCILIATION_LOCK_SLEEP)
    private readonly sleep: Sleep = (milliseconds) =>
      new Promise((resolve) => setTimeout(resolve, milliseconds)),
  ) {}

  async withLock<T>(operation: () => Promise<T>): Promise<T> {
    return this.withSessionLock(
      (client) => this.acquireGlobal(client),
      (client) => this.releaseGlobal(client),
      operation,
    );
  }

  async withUserLock<T>(
    userId: string,
    operation: () => Promise<T>,
  ): Promise<T> {
    const values = [
      accountUserLockKey(userId),
      ACCOUNT_USER_LOCK_HASH_SEED.toString(),
    ];
    return this.withSessionLock(
      (client) =>
        this.acquire(
          client,
          'SELECT pg_try_advisory_lock(hashtextextended($1, $2)) AS acquired',
          values,
        ),
      (client) =>
        this.release(
          client,
          'SELECT pg_advisory_unlock(hashtextextended($1, $2)) AS unlocked',
          values,
        ),
      operation,
    );
  }

  private async withSessionLock<T>(
    acquire: (client: LockClient) => Promise<boolean>,
    release: (client: LockClient) => Promise<void>,
    operation: () => Promise<T>,
  ): Promise<T> {
    const client = (this.createClientOverride ?? this.createClient)();
    let locked = false;
    let result!: T;
    let failure: unknown;
    try {
      try {
        await client.connect();
      } catch {
        throw new Error('Reconciliation lock connection failed');
      }

      try {
        locked = await acquire(client);
      } catch (error: unknown) {
        if (error instanceof ReconciliationLockUnavailableError) throw error;
        throw new Error('Reconciliation lock acquisition failed');
      }
      if (!locked) throw new ReconciliationLockUnavailableError();

      result = await operation();
    } catch (error: unknown) {
      failure = error;
    }

    if (locked) {
      try {
        await release(client);
      } catch (error: unknown) {
        failure = error;
      }
    }
    try {
      await client.end();
    } catch {
      failure = new Error('Reconciliation lock connection close failed');
    }

    if (failure) {
      throw failure instanceof Error
        ? failure
        : new Error('Account subscription reconciliation failed');
    }
    return result;
  }

  private acquireGlobal(client: LockClient): Promise<boolean> {
    return this.acquire(client, 'SELECT pg_try_advisory_lock($1) AS acquired', [
      GLOBAL_RECONCILIATION_LOCK,
    ]);
  }

  private async acquire(
    client: LockClient,
    query: string,
    values: unknown[],
  ): Promise<boolean> {
    const deadline = this.now() + LOCK_ACQUIRE_TIMEOUT_MS;
    while (this.now() < deadline) {
      const result = await client.query(query, values);
      const row = result.rows[0] as { acquired?: unknown } | undefined;
      if (row?.acquired === true) return true;
      await this.sleep(LOCK_POLL_INTERVAL_MS);
    }
    return false;
  }

  private releaseGlobal(client: LockClient): Promise<void> {
    return this.release(client, 'SELECT pg_advisory_unlock($1) AS unlocked', [
      GLOBAL_RECONCILIATION_LOCK,
    ]);
  }

  private async release(
    client: LockClient,
    query: string,
    values: unknown[],
  ): Promise<void> {
    try {
      const result = await client.query(query, values);
      const row = result.rows[0] as { unlocked?: unknown } | undefined;
      if (row?.unlocked !== true) {
        throw new Error('unlock returned false');
      }
    } catch {
      throw new Error('Reconciliation lock release failed');
    }
  }

  private readonly createClient: CreateLockClient = () =>
    new Client({
      connectionString: process.env.DATABASE_URL,
      connectionTimeoutMillis: LOCK_QUERY_TIMEOUT_MS,
      query_timeout: LOCK_QUERY_TIMEOUT_MS,
    });
}
