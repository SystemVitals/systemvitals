import { PrismaClient, type Prisma, type User } from '@systemvitals/database';
import { ForbiddenException } from '@nestjs/common';
import { OrganizationsService } from '../src/organizations/organizations.service';
import { MembersService } from '../src/members/members.service';
import { AccountEntitlementsService } from '../src/billing/account-entitlements.service';
import type { PrismaService } from '../src/prisma/prisma.service';
import type { InviteQueueService } from '../src/queue/invite-queue.service';

const TIMEOUT_MS = 8_000;
jest.setTimeout(30_000);

interface Deferred {
  promise: Promise<void>;
  resolve: () => void;
}

interface Scenario {
  setupClient: PrismaClient;
  users: [User, User];
  organizations: [{ id: string }, { id: string }];
  memberships: {
    firstInA: string;
    secondInA: string;
    firstInB: string;
    secondInB: string;
  };
}

function deferred(): Deferred {
  let resolve!: () => void;
  const promise = new Promise<void>((done) => {
    resolve = done;
  });
  return { promise, resolve };
}

function errorFrom(value: unknown, message: string): Error {
  return value instanceof Error ? value : new Error(message, { cause: value });
}

function connectionUrl(applicationName: string): string {
  const url = new URL(process.env.DATABASE_URL!);
  url.searchParams.set('connection_limit', '1');
  url.searchParams.set('application_name', applicationName);
  return url.toString();
}

function client(applicationName: string): PrismaClient {
  return new PrismaClient({
    datasourceUrl: connectionUrl(applicationName),
  });
}

function organizationsService(
  prisma: PrismaClient,
  entitlements = new AccountEntitlementsService(
    prisma as unknown as PrismaService,
  ),
): OrganizationsService {
  return new OrganizationsService(
    prisma as unknown as PrismaService,
    entitlements,
  );
}

function membersService(prisma: PrismaClient): MembersService {
  return new MembersService(
    prisma as unknown as PrismaService,
    {} as InviteQueueService,
  );
}

async function bounded<T>(promise: Promise<T>, label: string): Promise<T> {
  let timer: NodeJS.Timeout | undefined;
  const timeout = new Promise<never>((_, reject) => {
    timer = setTimeout(
      () => reject(new Error(`${label} exceeded ${TIMEOUT_MS}ms`)),
      TIMEOUT_MS,
    );
  });
  try {
    return await Promise.race([promise, timeout]);
  } finally {
    if (timer) clearTimeout(timer);
  }
}

function track<T>(
  outstanding: Promise<unknown>[],
  operation: Promise<T>,
): Promise<T> {
  outstanding.push(operation);
  // Attach a rejection handler immediately. The original promise remains
  // awaitable by the test, while an early assertion/barrier failure cannot
  // turn a concurrently rejected operation into an unhandled rejection.
  void operation.catch(() => undefined);
  return operation;
}

interface BackendSignalRow {
  pid: number;
  signaled: boolean;
}

function failedBackendSignals(rows: BackendSignalRow[]): number[] {
  return rows.filter(({ signaled }) => !signaled).map(({ pid }) => pid);
}

function fixtureFailure(errors: Error[]): Error {
  return errors.length === 1
    ? errors[0]
    : new AggregateError(
        errors,
        'Fixture creation and setup-backend cleanup failed',
      );
}

async function settlesWithin(
  settled: Promise<PromiseSettledResult<unknown>[]>,
): Promise<boolean> {
  let timer: NodeJS.Timeout | undefined;
  try {
    return await Promise.race([
      settled.then(() => true),
      new Promise<false>((resolve) => {
        timer = setTimeout(() => resolve(false), TIMEOUT_MS);
      }),
    ]);
  } finally {
    if (timer) clearTimeout(timer);
  }
}

type Completion =
  | { status: 'fulfilled' }
  | { status: 'rejected'; reason: unknown };

function observe(operation: Promise<unknown>): Promise<Completion> {
  void operation.catch(() => undefined);
  return operation.then<Completion, Completion>(
    () => ({ status: 'fulfilled' }),
    (reason: unknown) => ({ status: 'rejected', reason }),
  );
}

async function completionBy(
  completion: Promise<Completion>,
  deadline: number,
): Promise<Completion | null> {
  const remaining = Math.max(0, deadline - Date.now());
  let timer: NodeJS.Timeout | undefined;
  try {
    return await Promise.race([
      completion,
      new Promise<null>((resolve) => {
        timer = setTimeout(() => resolve(null), remaining);
      }),
    ]);
  } finally {
    if (timer) clearTimeout(timer);
  }
}

async function runTeardownWithHardStop(
  operation: Promise<unknown>,
  hardStop: () => Promise<unknown>,
  softDeadline: number,
  hardDeadline: number,
  label: string,
): Promise<void> {
  const primaryCompletion = observe(operation);
  const primaryResult = await completionBy(primaryCompletion, softDeadline);
  if (primaryResult?.status === 'fulfilled') return;
  if (primaryResult?.status === 'rejected') {
    throw errorFrom(primaryResult.reason, `${label} failed`);
  }

  let hardStopOperation: Promise<unknown>;
  try {
    hardStopOperation = hardStop();
  } catch (error) {
    hardStopOperation = Promise.reject(
      errorFrom(error, `${label} hard-stop failed to start`),
    );
  }
  const hardStopCompletion = observe(hardStopOperation);
  const combined = Promise.all([primaryCompletion, hardStopCompletion]);
  const remaining = Math.max(0, hardDeadline - Date.now());
  let timer: NodeJS.Timeout | undefined;
  const results = await Promise.race([
    combined,
    new Promise<null>((resolve) => {
      timer = setTimeout(() => resolve(null), remaining);
    }),
  ]);
  if (timer) clearTimeout(timer);
  if (!results) {
    throw new AggregateError(
      [
        new Error(`${label} did not finish before the shared deadline`),
        new Error('Independent hard-stop did not complete cleanup'),
      ],
      `${label} cleanup is incomplete`,
    );
  }
  const failures = results.filter(
    (result): result is Extract<Completion, { status: 'rejected' }> =>
      result.status === 'rejected',
  );
  if (failures.length > 0) {
    throw new AggregateError(
      failures.map(({ reason }) => errorFrom(reason, `${label} failed`)),
      `${label} or its independent hard-stop failed`,
    );
  }
}

async function terminateWithClient(
  terminator: PrismaClient,
  applicationNames: string[],
  deadline: number,
): Promise<void> {
  try {
    for (const applicationName of applicationNames) {
      let failedPids: number[] = [];
      for (;;) {
        const canceled = await terminator.$queryRaw<BackendSignalRow[]>`
          SELECT pid, pg_cancel_backend(pid) AS signaled
          FROM pg_stat_activity
          WHERE application_name = ${applicationName}
            AND pid <> pg_backend_pid()
        `;
        failedPids = failedBackendSignals(canceled);

        const terminated = await terminator.$queryRaw<BackendSignalRow[]>`
          SELECT pid, pg_terminate_backend(pid) AS signaled
          FROM pg_stat_activity
          WHERE application_name = ${applicationName}
            AND pid <> pg_backend_pid()
        `;
        failedPids = [
          ...new Set([...failedPids, ...failedBackendSignals(terminated)]),
        ];
        const survivors = await terminator.$queryRaw<Array<{ pid: number }>>`
          SELECT pid
          FROM pg_stat_activity
          WHERE application_name = ${applicationName}
            AND pid <> pg_backend_pid()
        `;
        if (survivors.length === 0) break;
        if (Date.now() >= deadline) {
          throw new Error(
            `Backend ${applicationName} survived cancellation/termination; ` +
              `surviving pids=${survivors.map(({ pid }) => pid).join(',')}; ` +
              `failed signals=${failedPids.join(',') || 'none'}`,
          );
        }
        await new Promise((resolve) => setTimeout(resolve, 20));
      }
    }
  } finally {
    await terminator.$disconnect();
  }
}

async function hardStopBackends(applicationNames: string[]): Promise<void> {
  const hardStop = client(`task4-hard-stop-${Date.now()}`);
  try {
    for (const applicationName of applicationNames) {
      const results = await hardStop.$queryRaw<BackendSignalRow[]>`
        SELECT pid, pg_terminate_backend(pid) AS signaled
        FROM pg_stat_activity
        WHERE application_name = ${applicationName}
          AND pid <> pg_backend_pid()
      `;
      const failed = failedBackendSignals(results);
      if (failed.length > 0) {
        throw new Error(
          `Hard-stop failed for ${applicationName} pids=${failed.join(',')}`,
        );
      }
    }
  } finally {
    await hardStop.$disconnect();
  }
}

async function terminateBackends(applicationNames: string[]): Promise<void> {
  const terminatorName = `task4-terminator-${Date.now()}`;
  const terminator = client(terminatorName);
  const startedAt = Date.now();
  const hardDeadline = startedAt + TIMEOUT_MS;
  const softDeadline = startedAt + Math.floor(TIMEOUT_MS * 0.75);
  const operation = terminateWithClient(
    terminator,
    applicationNames,
    hardDeadline,
  );
  await runTeardownWithHardStop(
    operation,
    () => hardStopBackends([...applicationNames, terminatorName]),
    softDeadline,
    hardDeadline,
    'PostgreSQL backend termination',
  );
}

async function settleOutstanding(
  outstanding: Promise<unknown>[],
  label: string,
  applicationNames: string[],
  pollingAbort: AbortController,
): Promise<void> {
  pollingAbort.abort();
  const settled = Promise.allSettled(outstanding);
  const completedBeforeDeadline = await settlesWithin(settled);
  let terminationError: unknown;
  if (!completedBeforeDeadline) {
    try {
      await terminateBackends(applicationNames);
    } catch (error) {
      terminationError = error;
    }
  }
  // Never abandon started work. Backend termination makes blocked database
  // calls reject; polling exits through pollingAbort.
  const completedAfterTermination = completedBeforeDeadline
    ? true
    : await settlesWithin(settled);
  if (!completedAfterTermination) {
    throw new Error(`${label} did not settle after backend termination`);
  }
  if (terminationError) {
    throw errorFrom(terminationError, 'Failed to terminate test backends');
  }
  if (!completedBeforeDeadline) {
    throw new Error(`${label} required backend termination`);
  }
}

async function waitForLock(
  observer: PrismaClient,
  applicationName: string,
  signal: AbortSignal,
): Promise<void> {
  const deadline = Date.now() + TIMEOUT_MS;
  while (!signal.aborted) {
    const rows = await observer.$queryRaw<
      Array<{ waitEventType: string | null }>
    >`
      SELECT wait_event_type AS "waitEventType"
      FROM pg_stat_activity
      WHERE application_name = ${applicationName}
        AND state = 'active'
    `;
    if (rows.some((row) => row.waitEventType === 'Lock')) return;
    if (Date.now() >= deadline) {
      throw new Error(
        `${applicationName} did not block on a PostgreSQL lock within ${TIMEOUT_MS}ms`,
      );
    }
    await new Promise<void>((resolve) => {
      const onAbort = () => {
        clearTimeout(timer);
        resolve();
      };
      const timer = setTimeout(() => {
        signal.removeEventListener('abort', onAbort);
        resolve();
      }, 10);
      signal.addEventListener('abort', onAbort, { once: true });
    });
  }
}

async function createScenario(seed: string): Promise<Scenario> {
  const setupName = `task4-setup-${seed}`;
  const setup = client(setupName);
  try {
    const fixture = await setup.$transaction(async (tx) => {
      const first = await tx.user.create({
        data: {
          email: `task4-first-${seed}@example.com`,
          subscription: { create: { plan: 'FLEET' } },
        },
      });
      const second = await tx.user.create({
        data: {
          email: `task4-second-${seed}@example.com`,
          subscription: { create: { plan: 'FLEET' } },
        },
      });
      const organizationA = await tx.organization.create({
        data: {
          name: 'Organization A',
          slug: `task4-a-${seed}`,
          creatorUserId: first.id,
          projects: {
            create: {
              name: 'Default',
              slug: 'default',
            },
          },
        },
      });
      const organizationB = await tx.organization.create({
        data: {
          name: 'Organization B',
          slug: `task4-b-${seed}`,
          creatorUserId: second.id,
          projects: {
            create: {
              name: 'Default',
              slug: 'default',
            },
          },
        },
      });
      const firstInA = await tx.membership.create({
        data: {
          userId: first.id,
          organizationId: organizationA.id,
          role: 'OWNER',
        },
      });
      const secondInA = await tx.membership.create({
        data: {
          userId: second.id,
          organizationId: organizationA.id,
          role: 'OWNER',
        },
      });
      const firstInB = await tx.membership.create({
        data: {
          userId: first.id,
          organizationId: organizationB.id,
          role: 'OWNER',
        },
      });
      const secondInB = await tx.membership.create({
        data: {
          userId: second.id,
          organizationId: organizationB.id,
          role: 'OWNER',
        },
      });
      return {
        users: [first, second] as [User, User],
        organizations: [organizationA, organizationB] as [
          { id: string },
          { id: string },
        ],
        memberships: {
          firstInA: firstInA.id,
          secondInA: secondInA.id,
          firstInB: firstInB.id,
          secondInB: secondInB.id,
        },
      };
    });
    return { ...fixture, setupClient: setup };
  } catch (originalError) {
    const errors = [errorFrom(originalError, 'Fixture transaction failed')];
    try {
      await setup.$disconnect();
    } catch (disconnectError) {
      errors.push(
        errorFrom(disconnectError, 'Fixture setup client failed to disconnect'),
      );
      try {
        await terminateBackends([setupName]);
      } catch (terminationError) {
        errors.push(
          errorFrom(terminationError, 'Fixture setup backend cleanup failed'),
        );
      }
    }
    throw fixtureFailure(errors);
  }
}

async function cleanupScenario(scenario: Scenario): Promise<void> {
  let setupDisconnectError: unknown;
  try {
    await scenario.setupClient.$disconnect();
  } catch (error) {
    setupDisconnectError = error;
  }
  const cleanup = client(`task4-cleanup-${scenario.organizations[0].id}`);
  try {
    await cleanup.organization.deleteMany({
      where: {
        id: { in: scenario.organizations.map(({ id }) => id) },
      },
    });
    await cleanup.user.deleteMany({
      where: { id: { in: scenario.users.map(({ id }) => id) } },
    });
  } finally {
    await cleanup.$disconnect();
  }
  if (setupDisconnectError) {
    throw errorFrom(
      setupDisconnectError,
      'Fixture setup client failed to disconnect',
    );
  }
}

async function disconnectClientsAndCleanup(
  clients: PrismaClient[],
  scenario: Scenario,
): Promise<void> {
  const disconnects = clients.map((prisma) => {
    const disconnect = prisma.$disconnect();
    void disconnect.catch(() => undefined);
    return disconnect;
  });
  const results = await Promise.allSettled(disconnects);
  await cleanupScenario(scenario);
  const failures = results.filter(
    (result): result is PromiseRejectedResult => result.status === 'rejected',
  );
  if (failures.length > 0) {
    throw new AggregateError(
      failures.map(({ reason }) =>
        errorFrom(reason as unknown, 'Prisma client failed to disconnect'),
      ),
      'One or more Prisma clients failed to disconnect',
    );
  }
}

async function lockOwnersUntilReleased(
  blocker: PrismaClient,
  organizationId: string,
  locked: Deferred,
  release: Deferred,
): Promise<void> {
  await blocker.$transaction(
    async (tx) => {
      await tx.$queryRaw`
        SELECT id FROM memberships
        WHERE organization_id = ${organizationId} AND role = 'OWNER'
        FOR UPDATE
      `;
      locked.resolve();
      await release.promise;
    },
    { timeout: TIMEOUT_MS },
  );
}

describe('organization transfer concurrency harness helpers', () => {
  it('bounds hanging termination and hard-stop operations without unhandled rejection', async () => {
    const never = new Promise<void>(() => undefined);
    const started = Date.now();

    await expect(
      runTeardownWithHardStop(
        never,
        () => never,
        Date.now() + 10,
        Date.now() + 40,
        'hanging teardown',
      ),
    ).rejects.toBeInstanceOf(AggregateError);
    expect(Date.now() - started).toBeLessThan(500);
  });

  it('treats a false backend signal result as a failure', () => {
    expect(
      failedBackendSignals([
        { pid: 101, signaled: true },
        { pid: 202, signaled: false },
      ]),
    ).toEqual([202]);
  });

  it('preserves the original fixture error alongside cleanup failures', () => {
    const original = new Error('fixture failed');
    const disconnect = new Error('disconnect failed');
    const termination = new Error('termination failed');

    const result = fixtureFailure([original, disconnect, termination]);

    expect(result).toBeInstanceOf(AggregateError);
    expect((result as AggregateError).errors).toEqual([
      original,
      disconnect,
      termination,
    ]);
  });
});

describe('organization creatorship transfer concurrency (PostgreSQL)', () => {
  it('serializes opposite-direction transfers across two organizations without deadlocking', async () => {
    const seed = `${Date.now()}-${Math.random().toString(16).slice(2)}`;
    const scenario = await createScenario(seed);
    const firstName = `task4-opposite-first-${seed}`;
    const secondName = `task4-opposite-second-${seed}`;
    const observerName = `task4-opposite-observer-${seed}`;
    const firstClient = client(firstName);
    const secondClient = client(secondName);
    const observer = client(observerName);
    const firstLocked = deferred();
    const releaseFirst = deferred();
    const outstanding: Promise<unknown>[] = [];
    const pollingAbort = new AbortController();
    class PausingEntitlements extends AccountEntitlementsService {
      override async lockUsers(
        tx: Prisma.TransactionClient,
        userIds: string[],
      ): Promise<void> {
        await super.lockUsers(tx, userIds);
        firstLocked.resolve();
        await releaseFirst.promise;
      }
    }

    try {
      await Promise.all([
        track(outstanding, firstClient.$connect()),
        track(outstanding, secondClient.$connect()),
        track(outstanding, observer.$connect()),
      ]);
      const firstTransfer = track(
        outstanding,
        organizationsService(
          firstClient,
          new PausingEntitlements(firstClient as unknown as PrismaService),
        ).transferCreatorship(
          scenario.users[0].id,
          scenario.organizations[0].id,
          scenario.users[1].id,
        ),
      );
      await bounded(firstLocked.promise, 'first transfer did not lock users');

      const secondTransfer = track(
        outstanding,
        organizationsService(secondClient).transferCreatorship(
          scenario.users[1].id,
          scenario.organizations[1].id,
          scenario.users[0].id,
        ),
      );
      await track(
        outstanding,
        waitForLock(observer, secondName, pollingAbort.signal),
      );
      releaseFirst.resolve();

      await bounded(
        Promise.all([firstTransfer, secondTransfer]),
        'opposite-direction transfers deadlocked',
      );
      const organizations = await observer.organization.findMany({
        where: {
          id: { in: scenario.organizations.map(({ id }) => id) },
        },
        orderBy: { name: 'asc' },
        select: { creatorUserId: true },
      });
      expect(organizations).toEqual([
        { creatorUserId: scenario.users[1].id },
        { creatorUserId: scenario.users[0].id },
      ]);
    } finally {
      releaseFirst.resolve();
      try {
        await settleOutstanding(
          outstanding,
          'opposite-direction operations did not settle during cleanup',
          [firstName, secondName, observerName],
          pollingAbort,
        );
      } finally {
        await disconnectClientsAndCleanup(
          [firstClient, secondClient, observer],
          scenario,
        );
      }
    }
  });

  it.each([
    ['updateRole current creator demotion', 'demote-creator'],
    ['updateRole recipient demotion', 'demote-recipient'],
    ['removeMember current creator', 'remove-creator'],
    ['removeMember recipient owner', 'remove-recipient'],
    ['leave by current creator', 'leave-creator'],
    ['leave by recipient owner', 'leave-recipient'],
  ] as const)(
    'serializes transfer vs %s without stale authorization',
    async (_label, operation) => {
      const seed = `${Date.now()}-${operation}-${Math.random()
        .toString(16)
        .slice(2)}`;
      const scenario = await createScenario(seed);
      const blockerName = `task4-blocker-${seed}`;
      const memberName = `task4-member-${seed}`;
      const transferName = `task4-transfer-${seed}`;
      const observerName = `task4-observer-${seed}`;
      const blocker = client(blockerName);
      const memberClient = client(memberName);
      const transferClient = client(transferName);
      const observer = client(observerName);
      const locked = deferred();
      const release = deferred();
      const outstanding: Promise<unknown>[] = [];
      const pollingAbort = new AbortController();

      try {
        await Promise.all([
          track(outstanding, blocker.$connect()),
          track(outstanding, memberClient.$connect()),
          track(outstanding, transferClient.$connect()),
          track(outstanding, observer.$connect()),
        ]);
        const blockerPromise = track(
          outstanding,
          lockOwnersUntilReleased(
            blocker,
            scenario.organizations[0].id,
            locked,
            release,
          ),
        );
        await bounded(locked.promise, 'OWNER-row blocker did not acquire lock');

        const members = membersService(memberClient);
        let memberOperation: Promise<unknown>;
        if (operation === 'demote-creator') {
          memberOperation = track(
            outstanding,
            members.updateRole(
              scenario.users[1].id,
              scenario.memberships.firstInA,
              'ADMIN',
            ),
          );
        } else if (operation === 'demote-recipient') {
          memberOperation = track(
            outstanding,
            members.updateRole(
              scenario.users[0].id,
              scenario.memberships.secondInA,
              'ADMIN',
            ),
          );
        } else if (operation === 'remove-creator') {
          memberOperation = track(
            outstanding,
            members.removeMember(
              scenario.users[1].id,
              scenario.memberships.firstInA,
            ),
          );
        } else if (operation === 'remove-recipient') {
          memberOperation = track(
            outstanding,
            members.removeMember(
              scenario.users[0].id,
              scenario.memberships.secondInA,
            ),
          );
        } else if (operation === 'leave-creator') {
          memberOperation = track(
            outstanding,
            members.leave(scenario.users[0].id, scenario.organizations[0].id),
          );
        } else {
          memberOperation = track(
            outstanding,
            members.leave(scenario.users[1].id, scenario.organizations[0].id),
          );
        }
        await track(
          outstanding,
          waitForLock(observer, memberName, pollingAbort.signal),
        );

        const transfer = track(
          outstanding,
          organizationsService(transferClient).transferCreatorship(
            scenario.users[0].id,
            scenario.organizations[0].id,
            scenario.users[1].id,
          ),
        );
        await track(
          outstanding,
          waitForLock(observer, transferName, pollingAbort.signal),
        );
        release.resolve();

        await bounded(blockerPromise, `${operation} blocker deadlocked`);
        const targetsCurrentCreator =
          operation === 'demote-creator' ||
          operation === 'remove-creator' ||
          operation === 'leave-creator';
        if (targetsCurrentCreator) {
          await expect(
            bounded(memberOperation, `${operation} left member op blocked`),
          ).rejects.toThrow('Transfer organization creatorship first');
          await expect(
            bounded(transfer, `${operation} left transfer blocked`),
          ).resolves.toBeDefined();
        } else {
          await expect(
            bounded(memberOperation, `${operation} left member op blocked`),
          ).resolves.toBeDefined();
          await expect(
            bounded(transfer, `${operation} left transfer blocked`),
          ).rejects.toBeInstanceOf(ForbiddenException);
        }

        const organization = await observer.organization.findUniqueOrThrow({
          where: { id: scenario.organizations[0].id },
          select: { creatorUserId: true },
        });
        expect(organization.creatorUserId).toBe(
          targetsCurrentCreator ? scenario.users[1].id : scenario.users[0].id,
        );
        const memberships = await observer.membership.findMany({
          where: { organizationId: scenario.organizations[0].id },
          select: { userId: true, role: true },
        });
        if (targetsCurrentCreator) {
          expect(memberships).toEqual(
            expect.arrayContaining([
              { userId: scenario.users[0].id, role: 'OWNER' },
              { userId: scenario.users[1].id, role: 'OWNER' },
            ]),
          );
        } else if (operation === 'demote-recipient') {
          expect(memberships).toEqual(
            expect.arrayContaining([
              { userId: scenario.users[0].id, role: 'OWNER' },
              { userId: scenario.users[1].id, role: 'ADMIN' },
            ]),
          );
        } else {
          expect(
            memberships.some(({ userId }) => userId === scenario.users[1].id),
          ).toBe(false);
        }
      } finally {
        release.resolve();
        try {
          await settleOutstanding(
            outstanding,
            `${operation} operations did not settle during cleanup`,
            [blockerName, memberName, transferName, observerName],
            pollingAbort,
          );
        } finally {
          await disconnectClientsAndCleanup(
            [blocker, memberClient, transferClient, observer],
            scenario,
          );
        }
      }
    },
  );

  it.each([
    ['updateRole', 'demote'],
    ['removeMember', 'remove'],
    ['leave', 'leave'],
  ] as const)(
    'allows old-creator %s after a concurrent transfer wins the OWNER lock',
    async (_label, operation) => {
      const seed = `${Date.now().toString(36)}-tf-${operation}-${Math.random()
        .toString(16)
        .slice(2, 8)}`;
      const scenario = await createScenario(seed);
      const blockerName = `task4-blocker-${seed}`;
      const transferName = `task4-transfer-${seed}`;
      const memberName = `task4-member-${seed}`;
      const observerName = `task4-observer-${seed}`;
      const blocker = client(blockerName);
      const transferClient = client(transferName);
      const memberClient = client(memberName);
      const observer = client(observerName);
      const locked = deferred();
      const release = deferred();
      const outstanding: Promise<unknown>[] = [];
      const pollingAbort = new AbortController();

      try {
        await Promise.all([
          track(outstanding, blocker.$connect()),
          track(outstanding, transferClient.$connect()),
          track(outstanding, memberClient.$connect()),
          track(outstanding, observer.$connect()),
        ]);
        const blockerPromise = track(
          outstanding,
          lockOwnersUntilReleased(
            blocker,
            scenario.organizations[0].id,
            locked,
            release,
          ),
        );
        await bounded(locked.promise, 'OWNER-row blocker did not acquire lock');

        const transfer = track(
          outstanding,
          organizationsService(transferClient).transferCreatorship(
            scenario.users[0].id,
            scenario.organizations[0].id,
            scenario.users[1].id,
          ),
        );
        await track(
          outstanding,
          waitForLock(observer, transferName, pollingAbort.signal),
        );

        const members = membersService(memberClient);
        const memberOperation: Promise<unknown> =
          operation === 'demote'
            ? members.updateRole(
                scenario.users[1].id,
                scenario.memberships.firstInA,
                'ADMIN',
              )
            : operation === 'remove'
              ? members.removeMember(
                  scenario.users[1].id,
                  scenario.memberships.firstInA,
                )
              : members.leave(
                  scenario.users[0].id,
                  scenario.organizations[0].id,
                );
        const trackedMemberOperation = track(outstanding, memberOperation);
        await track(
          outstanding,
          waitForLock(observer, memberName, pollingAbort.signal),
        );
        release.resolve();

        await bounded(
          Promise.all([blockerPromise, transfer, trackedMemberOperation]),
          `${operation} transfer-first operations deadlocked`,
        );
        await expect(
          observer.organization.findUniqueOrThrow({
            where: { id: scenario.organizations[0].id },
            select: { creatorUserId: true },
          }),
        ).resolves.toEqual({ creatorUserId: scenario.users[1].id });
        const oldCreatorMembership = await observer.membership.findUnique({
          where: { id: scenario.memberships.firstInA },
          select: { role: true },
        });
        expect(oldCreatorMembership).toEqual(
          operation === 'demote' ? { role: 'ADMIN' } : null,
        );
      } finally {
        release.resolve();
        try {
          await settleOutstanding(
            outstanding,
            `${operation} transfer-first operations did not settle`,
            [blockerName, transferName, memberName, observerName],
            pollingAbort,
          );
        } finally {
          await disconnectClientsAndCleanup(
            [blocker, transferClient, memberClient, observer],
            scenario,
          );
        }
      }
    },
  );
});
