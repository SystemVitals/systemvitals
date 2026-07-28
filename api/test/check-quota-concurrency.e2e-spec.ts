import { execFileSync } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import { resolve } from 'node:path';
import { ConflictException, ForbiddenException } from '@nestjs/common';
import { Prisma, PrismaClient } from '@systemvitals/database';
import { AccountEntitlementsService } from '../src/billing/account-entitlements.service';
import { BillingService } from '../src/billing/billing.service';
import type { StripePriceRegistry } from '../src/billing/stripe-price-registry';
import { ChecksService } from '../src/checks/checks.service';
import { MembersService } from '../src/members/members.service';
import { OrganizationsService } from '../src/organizations/organizations.service';
import type { InviteQueueService } from '../src/queue/invite-queue.service';
import type { PrismaService } from '../src/prisma/prisma.service';

const TIMEOUT_MS = 8_000;
const sourceUrl = process.env.DATABASE_URL;
if (!sourceUrl) throw new Error('DATABASE_URL is required');

const databaseDir = resolve(__dirname, '../../database');
const databaseName = `systemvitals_check_quota_${randomUUID().replaceAll('-', '')}`;
if (!/^[a-z][a-z0-9_]+$/.test(databaseName)) {
  throw new Error(`Unsafe temporary database name: ${databaseName}`);
}
const quotedDatabaseName = `"${databaseName}"`;
const adminUrl = new URL(sourceUrl);
adminUrl.search = '';
const testUrl = new URL(sourceUrl);
testUrl.pathname = `/${databaseName}`;
testUrl.searchParams.set('schema', 'public');

interface Deferred {
  promise: Promise<void>;
  resolve: () => void;
}

function deferred(): Deferred {
  let resolve!: () => void;
  const promise = new Promise<void>((done) => {
    resolve = done;
  });
  return { promise, resolve };
}

function run(command: string, args: string[], env: NodeJS.ProcessEnv = {}) {
  return execFileSync(command, args, {
    cwd: databaseDir,
    env: { ...process.env, ...env },
    encoding: 'utf8',
    stdio: ['ignore', 'pipe', 'pipe'],
  });
}

function sql(statement: string): void {
  run('psql', [adminUrl.toString(), '-v', 'ON_ERROR_STOP=1', '-c', statement]);
}

function client(label: string): PrismaClient {
  const url = new URL(testUrl);
  url.searchParams.set('connection_limit', '1');
  url.searchParams.set('application_name', label);
  return new PrismaClient({ datasourceUrl: url.toString() });
}

function checks(prisma: PrismaClient): ChecksService {
  return new ChecksService(
    prisma as unknown as PrismaService,
    new AccountEntitlementsService(prisma as unknown as PrismaService),
  );
}

function billing(
  prisma: PrismaClient,
  stripe: unknown = {
    subscriptions: {
      list: () => ({
        autoPagingToArray: () => Promise.resolve([]),
      }),
    },
  },
  prices: StripePriceRegistry = {} as StripePriceRegistry,
): BillingService {
  const entitlements = new AccountEntitlementsService(
    prisma as unknown as PrismaService,
  );
  return new BillingService(
    stripe as never,
    prisma as unknown as PrismaService,
    prices,
    entitlements,
  );
}

function organizations(prisma: PrismaClient): OrganizationsService {
  return new OrganizationsService(
    prisma as unknown as PrismaService,
    new AccountEntitlementsService(prisma as unknown as PrismaService),
  );
}

function members(prisma: PrismaClient): MembersService {
  return new MembersService(
    prisma as unknown as PrismaService,
    {} as InviteQueueService,
  );
}

async function bounded<T>(operation: Promise<T>, label: string): Promise<T> {
  let timer: NodeJS.Timeout | undefined;
  try {
    return await Promise.race([
      operation,
      new Promise<never>((_, reject) => {
        timer = setTimeout(
          () => reject(new Error(`${label} exceeded ${TIMEOUT_MS}ms`)),
          TIMEOUT_MS,
        );
      }),
    ]);
  } finally {
    if (timer) clearTimeout(timer);
  }
}

function track<T>(outstanding: Promise<unknown>[], operation: Promise<T>) {
  outstanding.push(operation);
  void operation.catch(() => undefined);
  return operation;
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
    if (rows.some(({ waitEventType }) => waitEventType === 'Lock')) return;
    if (Date.now() >= deadline) {
      throw new Error(`${applicationName} did not contend on a row lock`);
    }
    await new Promise<void>((done) => {
      const onAbort = () => {
        clearTimeout(timer);
        done();
      };
      const timer = setTimeout(() => {
        signal.removeEventListener('abort', onAbort);
        done();
      }, 10);
      signal.addEventListener('abort', onAbort, { once: true });
    });
  }
  throw new Error(
    `Stopped observing ${applicationName} before lock contention`,
  );
}

async function lockUserUntilReleased(
  blocker: PrismaClient,
  userId: string,
  locked: Deferred,
  release: Deferred,
): Promise<void> {
  await blocker.$transaction(
    async (tx) => {
      await tx.$queryRaw`
        SELECT id FROM users WHERE id = ${userId} FOR UPDATE
      `;
      locked.resolve();
      await release.promise;
    },
    { timeout: TIMEOUT_MS },
  );
}

async function lockUsersUntilReleased(
  blocker: PrismaClient,
  userIds: string[],
  locked: Deferred,
  release: Deferred,
): Promise<void> {
  await blocker.$transaction(
    async (tx) => {
      for (const userId of [...userIds].sort()) {
        await tx.$queryRaw`
          SELECT id FROM users WHERE id = ${userId} FOR UPDATE
        `;
      }
      locked.resolve();
      await release.promise;
    },
    { timeout: TIMEOUT_MS },
  );
}

async function lockMembershipUntilReleased(
  blocker: PrismaClient,
  membershipId: string,
  locked: Deferred,
  release: Deferred,
): Promise<void> {
  await blocker.$transaction(
    async (tx) => {
      await tx.$queryRaw`
        SELECT id FROM memberships WHERE id = ${membershipId} FOR UPDATE
      `;
      locked.resolve();
      await release.promise;
    },
    { timeout: TIMEOUT_MS },
  );
}

async function lockCheckUntilReleased(
  blocker: PrismaClient,
  checkId: string,
  locked: Deferred,
  release: Deferred,
): Promise<void> {
  await blocker.$transaction(
    async (tx) => {
      await tx.$queryRaw`
        SELECT id FROM checks WHERE id = ${checkId} FOR UPDATE
      `;
      locked.resolve();
      await release.promise;
    },
    { timeout: TIMEOUT_MS },
  );
}

async function terminateBackends(applicationNames: string[]): Promise<void> {
  const terminator = client(`task5-terminator-${Date.now()}`);
  try {
    await terminator.$queryRaw`
      SELECT pg_terminate_backend(pid)
      FROM pg_stat_activity
      WHERE application_name IN (${Prisma.join(applicationNames)})
        AND pid <> pg_backend_pid()
    `;
  } finally {
    await terminator.$disconnect();
  }
}

async function settleOutstanding(
  outstanding: Promise<unknown>[],
  applicationNames: string[],
): Promise<void> {
  try {
    await bounded(Promise.allSettled(outstanding), 'outstanding operations');
  } catch (originalError) {
    let terminationError: unknown;
    try {
      await terminateBackends(applicationNames);
    } catch (error) {
      terminationError = error;
    }
    await bounded(
      Promise.allSettled(outstanding),
      'operations after backend termination',
    );
    if (terminationError) {
      throw new AggregateError(
        [originalError, terminationError],
        'Operations hung and backend termination failed',
      );
    }
    throw originalError;
  }
}

async function cleanupFixture(
  clients: PrismaClient[],
  setup: PrismaClient,
  organizationIds: string[],
  userIds: string[],
): Promise<void> {
  const errors: unknown[] = [];
  const disconnectResults = await Promise.allSettled(
    clients.map((prisma) => prisma.$disconnect()),
  );
  for (const result of disconnectResults) {
    if (result.status === 'rejected') errors.push(result.reason as unknown);
  }
  try {
    await setup.organization.deleteMany({
      where: { id: { in: organizationIds } },
    });
  } catch (error) {
    errors.push(error);
  }
  try {
    await setup.user.deleteMany({ where: { id: { in: userIds } } });
  } catch (error) {
    errors.push(error);
  }
  try {
    const [survivingOrganizations, survivingUsers] = await Promise.all([
      setup.organization.findMany({
        where: { id: { in: organizationIds } },
        select: { id: true },
      }),
      setup.user.findMany({
        where: { id: { in: userIds } },
        select: { id: true, email: true },
      }),
    ]);
    if (survivingOrganizations.length > 0 || survivingUsers.length > 0) {
      errors.push(
        new Error(
          `Cleanup survivors: organizationIds=${survivingOrganizations
            .map(({ id }) => id)
            .join(',')}; users=${survivingUsers
            .map(({ id, email }) => `${id}:${email}`)
            .join(',')}`,
        ),
      );
    }
  } catch (error) {
    errors.push(error);
  }
  try {
    await setup.$disconnect();
  } catch (error) {
    errors.push(error);
  }
  if (errors.length > 0) {
    throw new AggregateError(errors, 'Exact fixture cleanup failed');
  }
}

async function finishScenario(
  outstanding: Promise<unknown>[],
  applicationNames: string[],
  clients: PrismaClient[],
  setup: PrismaClient,
  organizationIds: string[],
  userIds: string[],
): Promise<void> {
  const errors: unknown[] = [];
  try {
    await settleOutstanding(outstanding, applicationNames);
  } catch (error) {
    errors.push(error);
  }
  try {
    await cleanupFixture(clients, setup, organizationIds, userIds);
  } catch (error) {
    errors.push(error);
  }
  if (errors.length > 0) {
    throw new AggregateError(errors, 'Scenario teardown failed');
  }
}

async function createUser(
  prisma: PrismaClient,
  id: string,
  maxChecks: number,
  minIntervalSeconds = 60,
) {
  return prisma.user.create({
    data: {
      id,
      email: `${id}@example.com`,
      passwordHash: 'unused',
      subscription: {
        create: {
          plan: 'SOLO',
          limits: { maxChecks, minIntervalSeconds },
        },
      },
    },
  });
}

async function createOrganization(
  prisma: PrismaClient,
  id: string,
  creatorUserId: string,
  ownerUserIds: string[],
) {
  return prisma.organization.create({
    data: {
      id,
      name: id,
      slug: id,
      creatorUserId,
      memberships: {
        create: ownerUserIds.map((userId) => ({ userId, role: 'OWNER' })),
      },
      projects: {
        create: { id: `${id}-project`, name: 'Default', slug: 'default' },
      },
    },
    include: { projects: true },
  });
}

async function createExistingCheck(
  prisma: PrismaClient,
  id: string,
  projectId: string,
): Promise<void> {
  await prisma.check.create({
    data: {
      id,
      name: id,
      slug: id,
      type: 'HEARTBEAT',
      status: 'NEW',
      pingSlug: randomUUID(),
      periodSeconds: 60,
      graceSeconds: 10,
      projectId,
    },
  });
}

function rejection(results: PromiseSettledResult<unknown>[]) {
  const rejected = results.filter(
    (result): result is PromiseRejectedResult => result.status === 'rejected',
  );
  expect(rejected).toHaveLength(1);
  expect(rejected[0].reason).toBeInstanceOf(ForbiddenException);
  return rejected[0].reason as ForbiddenException;
}

describe('shared check quota concurrency (fresh PostgreSQL database)', () => {
  beforeAll(() => {
    try {
      sql(`CREATE DATABASE ${quotedDatabaseName}`);
      run('npx', ['prisma', 'migrate', 'deploy'], {
        DATABASE_URL: testUrl.toString(),
      });
    } catch (error) {
      sql(`DROP DATABASE IF EXISTS ${quotedDatabaseName} WITH (FORCE)`);
      throw error;
    }
  }, 30_000);

  afterAll(() => {
    sql(`DROP DATABASE IF EXISTS ${quotedDatabaseName} WITH (FORCE)`);
  });

  it('serializes portal reservation against checkout so only one Stripe action starts', async () => {
    const setup = client('billing-portal-checkout-setup');
    const portalClient = client('billing-portal-checkout-portal');
    const checkoutClient = client('billing-portal-checkout-checkout');
    const userId = 'billing-portal-checkout-user';
    const customerId = 'billing-portal-checkout-customer';
    const actionEntered = deferred();
    const releaseAction = deferred();
    const portalCreate = jest.fn(async () => {
      actionEntered.resolve();
      await releaseAction.promise;
      return { url: 'https://stripe.test/portal' };
    });
    const checkoutCreate = jest.fn(async (input: { metadata: object }) => {
      actionEntered.resolve();
      await releaseAction.promise;
      return {
        id: 'cs_portal_checkout_race',
        created: 1,
        metadata: input.metadata,
        mode: 'subscription',
        status: 'open',
        url: 'https://stripe.test/checkout',
        expires_at: null,
      };
    });
    const stripe = {
      customers: { create: jest.fn() },
      subscriptions: {
        list: () => ({
          autoPagingToArray: () => Promise.resolve([]),
        }),
      },
      checkout: {
        sessions: {
          list: () => ({
            autoPagingToArray: () => Promise.resolve([]),
          }),
          create: checkoutCreate,
          expire: jest.fn(),
        },
      },
      billingPortal: { sessions: { create: portalCreate } },
    };
    const prices = {
      priceIdFor: () => 'price_signal',
      planForPriceId: () => 'SIGNAL',
    } as unknown as StripePriceRegistry;
    try {
      await createUser(setup, userId, 100, 1);
      await setup.user.update({
        where: { id: userId },
        data: { stripeCustomerId: customerId },
      });
      await setup.subscription.update({
        where: { userId },
        data: { plan: 'SIGNAL', status: 'active' },
      });
      await Promise.all([portalClient.$connect(), checkoutClient.$connect()]);

      const requests = [
        billing(portalClient, stripe, prices).createPortal(userId),
        billing(checkoutClient, stripe, prices).createCheckout(
          userId,
          'SIGNAL',
        ),
      ];
      await bounded(actionEntered.promise, 'portal/checkout Stripe winner');
      const settledBeforeRelease = await Promise.race([
        Promise.allSettled(requests),
        new Promise<null>((resolve) => setTimeout(() => resolve(null), 100)),
      ]);
      expect(settledBeforeRelease).toBeNull();
      expect(
        portalCreate.mock.calls.length + checkoutCreate.mock.calls.length,
      ).toBe(1);
      releaseAction.resolve();

      const results = await bounded(
        Promise.allSettled(requests),
        'portal/checkout race',
      );
      expect(
        results.filter(({ status }) => status === 'fulfilled'),
      ).toHaveLength(1);
      const rejected = results.find(
        (result): result is PromiseRejectedResult =>
          result.status === 'rejected',
      );
      expect(rejected?.reason).toBeInstanceOf(ConflictException);
      expect(
        portalCreate.mock.calls.length + checkoutCreate.mock.calls.length,
      ).toBe(1);
    } finally {
      releaseAction.resolve();
      await Promise.allSettled([
        setup.user.deleteMany({ where: { id: userId } }),
        portalClient.$disconnect(),
        checkoutClient.$disconnect(),
      ]);
      await setup.$disconnect();
    }
  });

  it('fences a stale portal owner after an expired operation is reclaimed', async () => {
    const setup = client('billing-portal-fence-setup');
    const staleClient = client('billing-portal-fence-stale');
    const recoveryClient = client('billing-portal-fence-recovery');
    const userId = 'billing-portal-fence-user';
    const customerId = 'billing-portal-fence-customer';
    const reservationCommitted = deferred();
    const releaseStaleOwner = deferred();
    const portalCreate = jest
      .fn()
      .mockResolvedValue({ url: 'https://stripe.test/portal-recovered' });
    const stripe = {
      billingPortal: { sessions: { create: portalCreate } },
      checkout: {
        sessions: {
          list: () => ({
            autoPagingToArray: () => Promise.resolve([]),
          }),
        },
      },
    };
    try {
      await createUser(setup, userId, 100, 1);
      await setup.user.update({
        where: { id: userId },
        data: { stripeCustomerId: customerId },
      });
      await setup.subscription.update({
        where: { userId },
        data: { plan: 'SIGNAL', status: 'active' },
      });
      await Promise.all([staleClient.$connect(), recoveryClient.$connect()]);
      const originalTransaction = staleClient.$transaction.bind(staleClient);
      let transactionCount = 0;
      Object.assign(staleClient, {
        $transaction: async (
          ...args: Parameters<typeof originalTransaction>
        ) => {
          const result = await originalTransaction(...args);
          transactionCount += 1;
          if (transactionCount === 1) {
            reservationCommitted.resolve();
            await releaseStaleOwner.promise;
          }
          return result;
        },
      });

      const stale = billing(staleClient, stripe).createPortal(userId);
      await bounded(reservationCommitted.promise, 'portal reservation commit');
      await setup.checkoutOperation.updateMany({
        where: { userId, operationKind: 'PORTAL' },
        data: { leaseExpiresAt: new Date(Date.now() - 1) },
      });
      const recovered = billing(recoveryClient, stripe).createPortal(userId);
      await bounded(
        (async () => {
          while (portalCreate.mock.calls.length === 0) {
            await new Promise((resolve) => setTimeout(resolve, 5));
          }
        })(),
        'portal recovery claim',
      );
      releaseStaleOwner.resolve();

      await expect(recovered).resolves.toEqual({
        url: 'https://stripe.test/portal-recovered',
      });
      await expect(stale).rejects.toThrow(
        'Billing state changed; retry portal',
      );
      expect(portalCreate).toHaveBeenCalledTimes(1);
      await expect(
        setup.checkoutOperation.count({ where: { userId } }),
      ).resolves.toBe(0);
    } finally {
      releaseStaleOwner.resolve();
      await Promise.allSettled([
        setup.user.deleteMany({ where: { id: userId } }),
        staleClient.$disconnect(),
        recoveryClient.$disconnect(),
      ]);
      await setup.$disconnect();
    }
  });

  it('routes checkout to the portal when a completing checkout webhook wins the user lock', async () => {
    const names = {
      blocker: 'billing-checkout-webhook-blocker',
      webhook: 'billing-checkout-webhook-webhook',
      checkout: 'billing-checkout-webhook-checkout',
      observer: 'billing-checkout-webhook-observer',
    };
    const setup = client('billing-checkout-webhook-setup');
    const blocker = client(names.blocker);
    const webhookClient = client(names.webhook);
    const checkoutClient = client(names.checkout);
    const observer = client(names.observer);
    const userId = 'billing-checkout-webhook-user';
    const customerId = 'billing-checkout-webhook-customer';
    const locked = deferred();
    const release = deferred();
    const abort = new AbortController();
    const outstanding: Promise<unknown>[] = [];
    const checkoutCreate = jest.fn();
    const portalCreate = jest
      .fn()
      .mockResolvedValue({ url: 'https://stripe.test/portal' });
    const stripe = {
      subscriptions: {
        list: () => ({
          autoPagingToArray: () =>
            Promise.resolve([
              {
                id: 'sub_completed',
                status: 'active',
                items: { data: [{ price: { id: 'price_signal' } }] },
              },
            ]),
        }),
      },
      checkout: {
        sessions: {
          list: () => ({
            autoPagingToArray: () => Promise.resolve([]),
          }),
          create: checkoutCreate,
          expire: jest.fn(),
        },
      },
      billingPortal: { sessions: { create: portalCreate } },
    };
    const prices = {
      priceIdFor: () => 'price_signal',
      planForPriceId: (priceId: string) =>
        priceId === 'price_signal' ? 'SIGNAL' : undefined,
    } as unknown as StripePriceRegistry;
    try {
      await createUser(setup, userId, 100, 1);
      await setup.user.update({
        where: { id: userId },
        data: {
          stripeCustomerId: customerId,
          checkoutAttemptId: 'attempt-completed',
          checkoutAttemptPlan: 'SIGNAL',
          checkoutAttemptInterval: 'month',
          checkoutAttemptCreatedAt: new Date(),
          checkoutSessionId: 'cs_completed',
          checkoutSessionUrl: 'https://stripe.test/completed',
        },
      });
      await Promise.all([
        blocker.$connect(),
        webhookClient.$connect(),
        checkoutClient.$connect(),
        observer.$connect(),
      ]);
      const heldLock = track(
        outstanding,
        lockUserUntilReleased(blocker, userId, locked, release),
      );
      await bounded(locked.promise, 'checkout/webhook blocker acquisition');
      const webhook = track(
        outstanding,
        billing(webhookClient, stripe, prices).applySubscriptionEvent(
          customerId,
        ),
      );
      await waitForLock(observer, names.webhook, abort.signal);
      const checkout = track(
        outstanding,
        billing(checkoutClient, stripe, prices).createCheckout(
          userId,
          'SIGNAL',
        ),
      );
      await waitForLock(observer, names.checkout, abort.signal);
      release.resolve();
      await bounded(heldLock, 'checkout/webhook blocker release');

      await expect(
        bounded(webhook, 'winning checkout webhook'),
      ).resolves.toBeUndefined();
      await expect(
        bounded(checkout, 'checkout after webhook'),
      ).resolves.toEqual({ url: 'https://stripe.test/portal' });
      expect(checkoutCreate).not.toHaveBeenCalled();
      expect(portalCreate).toHaveBeenCalledTimes(1);
      expect(
        await setup.subscription.findUniqueOrThrow({ where: { userId } }),
      ).toMatchObject({
        plan: 'SIGNAL',
        stripeSubscriptionId: 'sub_completed',
      });
    } finally {
      abort.abort();
      release.resolve();
      await finishScenario(
        outstanding,
        Object.values(names),
        [blocker, webhookClient, checkoutClient, observer],
        setup,
        [],
        [userId],
      );
    }
  });

  it('discards a stale webhook snapshot after a version winner commits and refetches', async () => {
    const names = {
      first: 'billing-stale-webhook-first',
      second: 'billing-stale-webhook-second',
    };
    const setup = client('billing-stale-webhook-setup');
    const firstClient = client(names.first);
    const secondClient = client(names.second);
    const userId = 'billing-stale-webhook-user';
    const customerId = 'billing-stale-webhook-customer';
    const firstSnapshotEntered = deferred();
    const releaseFirstSnapshot = deferred();
    const outstanding: Promise<unknown>[] = [];
    let snapshot = {
      id: 'sub_signal',
      status: 'active',
      items: { data: [{ price: { id: 'price_signal' } }] },
    };
    let listCount = 0;
    const stripe = {
      subscriptions: {
        list: () => {
          listCount += 1;
          const captured = snapshot;
          return {
            autoPagingToArray: async () => {
              if (listCount === 1) {
                firstSnapshotEntered.resolve();
                await releaseFirstSnapshot.promise;
              }
              return [captured];
            },
          };
        },
      },
    };
    const prices = {
      priceIdFor: () => 'price_signal',
      planForPriceId: (priceId: string) => {
        if (priceId === 'price_signal') return 'SIGNAL';
        if (priceId === 'price_fleet') return 'FLEET';
        return undefined;
      },
    } as unknown as StripePriceRegistry;
    try {
      await createUser(setup, userId, 100, 1);
      await setup.user.update({
        where: { id: userId },
        data: { stripeCustomerId: customerId },
      });
      await Promise.all([firstClient.$connect(), secondClient.$connect()]);

      const first = track(
        outstanding,
        billing(firstClient, stripe, prices).applySubscriptionEvent(customerId),
      );
      await bounded(firstSnapshotEntered.promise, 'first webhook snapshot');
      snapshot = {
        id: 'sub_fleet',
        status: 'active',
        items: { data: [{ price: { id: 'price_fleet' } }] },
      };
      const second = track(
        outstanding,
        billing(secondClient, stripe, prices).applySubscriptionEvent(
          customerId,
        ),
      );
      await bounded(second, 'version-winning webhook commit');
      expect(listCount).toBe(2);
      releaseFirstSnapshot.resolve();
      await bounded(first, 'stale webhook refetch');

      expect(listCount).toBe(3);
      expect(
        await setup.subscription.findUniqueOrThrow({ where: { userId } }),
      ).toMatchObject({
        plan: 'FLEET',
        stripeSubscriptionId: 'sub_fleet',
      });
    } finally {
      releaseFirstSnapshot.resolve();
      await finishScenario(
        outstanding,
        Object.values(names),
        [firstClient, secondClient],
        setup,
        [],
        [userId],
      );
    }
  });

  it('durably cleans an unowned session after webhook clear and ambiguous expiry', async () => {
    const setup = client('billing-orphan-cleanup-setup');
    const checkoutClient = client('billing-orphan-cleanup-checkout');
    const webhookClient = client('billing-orphan-cleanup-webhook');
    const userId = 'billing-orphan-cleanup-user';
    const customerId = 'billing-orphan-cleanup-customer';
    const createEntered = deferred();
    const releaseCreate = deferred();
    const outstanding: Promise<unknown>[] = [];
    let subscriptionActive = false;
    const session: {
      id: string;
      created: number;
      metadata: Record<string, string>;
      mode: string;
      status: string;
      url: string | null;
      expires_at: null;
    } = {
      id: 'cs_orphan_cleanup',
      created: 100,
      metadata: {
        userId,
        attemptId: '',
        plan: 'SIGNAL',
        interval: 'month',
      },
      mode: 'subscription',
      status: 'open',
      url: 'https://stripe.test/orphan',
      expires_at: null,
    };
    const expire = jest
      .fn()
      .mockRejectedValueOnce(new Error('timeout after Stripe expired session'))
      .mockImplementationOnce(() => {
        session.status = 'expired';
        session.url = null;
        return Promise.resolve(session);
      });
    const stripe = {
      subscriptions: {
        list: () => ({
          autoPagingToArray: () =>
            Promise.resolve(
              subscriptionActive
                ? [
                    {
                      id: 'sub_cleanup',
                      status: 'active',
                      items: { data: [{ price: { id: 'price_signal' } }] },
                    },
                  ]
                : [],
            ),
        }),
      },
      checkout: {
        sessions: {
          list: () => ({
            autoPagingToArray: () => Promise.resolve([]),
          }),
          create: async (input: { metadata: Record<string, string> }) => {
            session.metadata = {
              ...session.metadata,
              ...input.metadata,
            };
            createEntered.resolve();
            await releaseCreate.promise;
            return session;
          },
          retrieve: () => Promise.resolve(session),
          expire,
        },
      },
      billingPortal: {
        sessions: {
          create: () => Promise.resolve({ url: 'https://stripe.test/portal' }),
        },
      },
    };
    const prices = {
      priceIdFor: () => 'price_signal',
      planForPriceId: () => 'SIGNAL',
    } as unknown as StripePriceRegistry;
    try {
      await createUser(setup, userId, 100, 1);
      await setup.user.update({
        where: { id: userId },
        data: { stripeCustomerId: customerId },
      });
      await Promise.all([checkoutClient.$connect(), webhookClient.$connect()]);
      const checkout = track(
        outstanding,
        billing(checkoutClient, stripe, prices).createCheckout(
          userId,
          'SIGNAL',
        ),
      );
      await bounded(createEntered.promise, 'orphan checkout create');
      subscriptionActive = true;
      await billing(webhookClient, stripe, prices).applySubscriptionEvent(
        customerId,
      );
      releaseCreate.resolve();

      await expect(
        bounded(checkout, 'orphan checkout cleanup'),
      ).rejects.toThrow('timeout after Stripe expired session');
      await expect(
        setup.checkoutCleanupIntent.findMany({ where: { userId } }),
      ).resolves.toEqual([
        expect.objectContaining({ stripeSessionId: session.id }),
      ]);
      await expect(
        setup.user.findUniqueOrThrow({ where: { id: userId } }),
      ).resolves.toMatchObject({ checkoutAttemptId: null });
      expect(session.status).toBe('open');

      await expect(
        billing(setup, stripe, prices).createPortal(userId),
      ).resolves.toEqual({ url: 'https://stripe.test/portal' });
      expect(expire).toHaveBeenCalledTimes(2);
      expect(session.status).toBe('expired');
      await expect(
        setup.checkoutCleanupIntent.count({ where: { userId } }),
      ).resolves.toBe(0);
    } finally {
      releaseCreate.resolve();
      await finishScenario(
        outstanding,
        [],
        [checkoutClient, webhookClient],
        setup,
        [],
        [userId],
      );
    }
  });

  it('queues and drains two lost checkout generations after a webhook clears ownership', async () => {
    const setup = client('billing-multi-cleanup-setup');
    const firstClient = client('billing-multi-cleanup-first');
    const secondClient = client('billing-multi-cleanup-second');
    const webhookClient = client('billing-multi-cleanup-webhook');
    const userId = 'billing-multi-cleanup-user';
    const customerId = 'billing-multi-cleanup-customer';
    const bothCreatesEntered = deferred();
    const releaseCreates = deferred();
    const outstanding: Promise<unknown>[] = [];
    const sessions = new Map<
      string,
      {
        id: string;
        created: number;
        metadata: Record<string, string>;
        mode: string;
        status: string;
        url: string | null;
        expires_at: null;
      }
    >();
    let createCount = 0;
    let subscriptionActive = false;
    let allowExpiry = false;
    const stripe = {
      subscriptions: {
        list: () => ({
          autoPagingToArray: () =>
            Promise.resolve(
              subscriptionActive
                ? [
                    {
                      id: 'sub_multi_cleanup',
                      status: 'active',
                      items: { data: [{ price: { id: 'price_signal' } }] },
                    },
                  ]
                : [],
            ),
        }),
      },
      checkout: {
        sessions: {
          list: () => ({
            autoPagingToArray: () => Promise.resolve([]),
          }),
          create: async (input: { metadata: Record<string, string> }) => {
            createCount += 1;
            const id = `cs_multi_cleanup_${createCount}`;
            const session = {
              id,
              created: createCount,
              metadata: input.metadata,
              mode: 'subscription',
              status: 'open',
              url: `https://stripe.test/${id}`,
              expires_at: null,
            };
            sessions.set(id, session);
            if (createCount === 2) bothCreatesEntered.resolve();
            await releaseCreates.promise;
            return session;
          },
          retrieve: (id: string) => Promise.resolve(sessions.get(id)!),
          expire: (id: string) => {
            if (!allowExpiry) {
              return Promise.reject(
                new Error(`ambiguous expiry timeout for ${id}`),
              );
            }
            const session = sessions.get(id)!;
            session.status = 'expired';
            session.url = null;
            return Promise.resolve(session);
          },
        },
      },
      billingPortal: {
        sessions: {
          create: () => Promise.resolve({ url: 'https://stripe.test/portal' }),
        },
      },
    };
    const prices = {
      priceIdFor: () => 'price_signal',
      planForPriceId: () => 'SIGNAL',
    } as unknown as StripePriceRegistry;
    try {
      await createUser(setup, userId, 100, 1);
      await setup.user.update({
        where: { id: userId },
        data: { stripeCustomerId: customerId },
      });
      await Promise.all([
        firstClient.$connect(),
        secondClient.$connect(),
        webhookClient.$connect(),
      ]);
      const checkouts = [firstClient, secondClient].map((checkoutClient) =>
        track(
          outstanding,
          billing(checkoutClient, stripe, prices).createCheckout(
            userId,
            'SIGNAL',
          ),
        ),
      );
      await bounded(bothCreatesEntered.promise, 'both delayed checkouts');
      await expect(
        setup.checkoutOperation.count({ where: { userId } }),
      ).resolves.toBe(2);
      subscriptionActive = true;
      await billing(webhookClient, stripe, prices).applySubscriptionEvent(
        customerId,
      );
      await expect(
        setup.checkoutOperation.count({ where: { userId } }),
      ).resolves.toBe(2);
      releaseCreates.resolve();

      const results = await bounded(
        Promise.allSettled(checkouts),
        'lost checkout generations',
      );
      expect(results.every(({ status }) => status === 'rejected')).toBe(true);
      await expect(
        setup.checkoutCleanupIntent.findMany({
          where: { userId },
          orderBy: { stripeSessionId: 'asc' },
          select: { stripeSessionId: true },
        }),
      ).resolves.toEqual([
        { stripeSessionId: 'cs_multi_cleanup_1' },
        { stripeSessionId: 'cs_multi_cleanup_2' },
      ]);
      await expect(
        setup.checkoutOperation.count({ where: { userId } }),
      ).resolves.toBe(0);

      allowExpiry = true;
      await expect(
        billing(setup, stripe, prices).createPortal(userId),
      ).resolves.toEqual({ url: 'https://stripe.test/portal' });
      await expect(
        setup.checkoutCleanupIntent.count({ where: { userId } }),
      ).resolves.toBe(0);
      expect(
        [...sessions.values()].every(({ status }) => status === 'expired'),
      ).toBe(true);
    } finally {
      releaseCreates.resolve();
      await finishScenario(
        outstanding,
        [],
        [firstClient, secondClient, webhookClient],
        setup,
        [],
        [userId],
      );
    }
  });

  it.each(['creation', 'webhook'] as const)(
    'serializes creation-vs-downgrade with %s first, preserves permitted post-downgrade overage, and blocks subsequent creation',
    async (firstOperation) => {
      const names = {
        blocker: `task6-billing-${firstOperation}-blocker`,
        creation: `task6-billing-${firstOperation}-creation`,
        webhook: `task6-billing-${firstOperation}-webhook`,
        observer: `task6-billing-${firstOperation}-observer`,
      };
      const setup = client(`task6-billing-${firstOperation}-setup`);
      const blocker = client(names.blocker);
      const creationClient = client(names.creation);
      const webhookClient = client(names.webhook);
      const observer = client(names.observer);
      const userId = `task6-billing-${firstOperation}-user`;
      const customerId = `task6-billing-${firstOperation}-customer`;
      const organizationIds = [`task6-billing-${firstOperation}-org`];
      const locked = deferred();
      const release = deferred();
      const abort = new AbortController();
      const outstanding: Promise<unknown>[] = [];
      try {
        await createUser(setup, userId, 100, 1);
        await setup.user.update({
          where: { id: userId },
          data: { stripeCustomerId: customerId },
        });
        await setup.subscription.update({
          where: { userId },
          data: { plan: 'SIGNAL', limits: Prisma.DbNull },
        });
        const organization = await createOrganization(
          setup,
          organizationIds[0],
          userId,
          [userId],
        );
        for (let index = 0; index < 5; index += 1) {
          await createExistingCheck(
            setup,
            `task6-billing-${firstOperation}-existing-${index}`,
            organization.projects[0].id,
          );
        }
        await Promise.all([
          blocker.$connect(),
          creationClient.$connect(),
          webhookClient.$connect(),
          observer.$connect(),
        ]);
        const heldLock = track(
          outstanding,
          lockUserUntilReleased(blocker, userId, locked, release),
        );
        await bounded(locked.promise, 'billing creator lock acquisition');
        const startCreation = () =>
          track(
            outstanding,
            checks(creationClient).create(
              userId,
              organization.projects[0].id,
              `Candidate ${firstOperation}`,
              10,
              300,
            ),
          );
        const startWebhook = () =>
          track(
            outstanding,
            billing(webhookClient).applySubscriptionEvent(customerId),
          );
        const first =
          firstOperation === 'creation' ? startCreation() : startWebhook();
        await waitForLock(observer, names[firstOperation], abort.signal);
        const second =
          firstOperation === 'creation' ? startWebhook() : startCreation();
        await waitForLock(
          observer,
          firstOperation === 'creation' ? names.webhook : names.creation,
          abort.signal,
        );
        release.resolve();
        await bounded(heldLock, 'billing creator lock release');
        const results = await bounded(
          Promise.allSettled([first, second]),
          'creation and webhook downgrade',
        );

        const creationResult =
          firstOperation === 'creation' ? results[0] : results[1];
        if (firstOperation === 'creation') {
          expect(creationResult.status).toBe('fulfilled');
        } else {
          expect(creationResult.status).toBe('rejected');
          if (creationResult.status === 'rejected') {
            expect(creationResult.reason).toBeInstanceOf(ForbiddenException);
          }
        }
        expect(
          await setup.subscription.findUniqueOrThrow({ where: { userId } }),
        ).toMatchObject({ plan: 'SOLO' });
        const finalCheckCount = await setup.check.count({
          where: { project: { organization: { creatorUserId: userId } } },
        });
        expect(finalCheckCount).toBe(firstOperation === 'creation' ? 6 : 5);
        if (firstOperation === 'creation') {
          // The creation committed under SIGNAL before the downgrade. The
          // resulting six existing checks are deliberately preserved even
          // though SOLO's limit is five.
          expect(finalCheckCount).toBeGreaterThan(5);
        }
        await expect(
          checks(setup).create(
            userId,
            organization.projects[0].id,
            `Post-downgrade candidate ${firstOperation}`,
            10,
            300,
          ),
        ).rejects.toThrow(
          'Your plan limit of 5 checks has been reached. Please upgrade your plan to create more checks.',
        );
      } finally {
        abort.abort();
        release.resolve();
        await finishScenario(
          outstanding,
          Object.values(names),
          [blocker, creationClient, webhookClient, observer],
          setup,
          organizationIds,
          [userId],
        );
      }
    },
  );

  it('proves two cross-organization final-slot creations contend and only one wins', async () => {
    const names = {
      blocker: 'task5-final-slot-blocker',
      first: 'task5-final-slot-first',
      second: 'task5-final-slot-second',
      observer: 'task5-final-slot-observer',
    };
    const setup = client('task5-final-slot-setup');
    const blocker = client(names.blocker);
    const first = client(names.first);
    const second = client(names.second);
    const observer = client(names.observer);
    const ownerId = 'task5-final-slot-owner';
    const organizationIds = ['task5-final-slot-a', 'task5-final-slot-b'];
    const locked = deferred();
    const release = deferred();
    const abort = new AbortController();
    const outstanding: Promise<unknown>[] = [];
    try {
      await createUser(setup, ownerId, 2);
      const [organizationA, organizationB] = await Promise.all(
        organizationIds.map((id) =>
          createOrganization(setup, id, ownerId, [ownerId]),
        ),
      );
      await createExistingCheck(
        setup,
        'task5-final-slot-existing',
        organizationA.projects[0].id,
      );
      await Promise.all([
        blocker.$connect(),
        first.$connect(),
        second.$connect(),
        observer.$connect(),
      ]);
      const heldLock = track(
        outstanding,
        lockUserUntilReleased(blocker, ownerId, locked, release),
      );
      await bounded(locked.promise, 'creator lock acquisition');
      const operations = [
        track(
          outstanding,
          checks(first).create(
            ownerId,
            organizationA.projects[0].id,
            'Candidate A',
            10,
            60,
          ),
        ),
        track(
          outstanding,
          checks(second).create(
            ownerId,
            organizationB.projects[0].id,
            'Candidate B',
            10,
            60,
          ),
        ),
      ];
      await Promise.all([
        waitForLock(observer, names.first, abort.signal),
        waitForLock(observer, names.second, abort.signal),
      ]);
      release.resolve();
      await bounded(heldLock, 'held creator lock release');
      const results = await bounded(
        Promise.allSettled(operations),
        'final-slot creations',
      );

      expect(
        results.filter(({ status }) => status === 'fulfilled'),
      ).toHaveLength(1);
      expect(rejection(results).message).toBe(
        'Your plan limit of 2 checks has been reached. Please upgrade your plan to create more checks.',
      );
      expect(
        await setup.check.count({
          where: {
            project: { organization: { creatorUserId: ownerId } },
          },
        }),
      ).toBe(2);
    } finally {
      abort.abort();
      release.resolve();
      await finishScenario(
        outstanding,
        Object.values(names),
        [blocker, first, second, observer],
        setup,
        organizationIds,
        [ownerId],
      );
    }
  });

  it.each(['transfer', 'creation'] as const)(
    'pins %s first when transfer contends with creation inside the transferred organization',
    async (firstOperation) => {
      const suffix = firstOperation;
      const names = {
        blocker: `task5-transfer-${suffix}-blocker`,
        transfer: `task5-transfer-${suffix}-operation`,
        create: `task5-transfer-${suffix}-create`,
        observer: `task5-transfer-${suffix}-observer`,
      };
      const setup = client(`task5-transfer-${suffix}-setup`);
      const blocker = client(names.blocker);
      const transferClient = client(names.transfer);
      const createClient = client(names.create);
      const observer = client(names.observer);
      const creatorId = `task5-transfer-${suffix}-creator`;
      const recipientId = `task5-transfer-${suffix}-recipient`;
      const candidateName = `Transferred candidate ${suffix}`;
      const organizationIds = [
        `task5-transfer-${suffix}-org`,
        `task5-recipient-${suffix}-org`,
      ];
      const locked = deferred();
      const release = deferred();
      const abort = new AbortController();
      const outstanding: Promise<unknown>[] = [];
      try {
        await createUser(setup, creatorId, 2);
        await createUser(setup, recipientId, 2);
        const transferred = await createOrganization(
          setup,
          organizationIds[0],
          creatorId,
          [creatorId, recipientId],
        );
        const recipient = await createOrganization(
          setup,
          organizationIds[1],
          recipientId,
          [recipientId],
        );
        await createExistingCheck(
          setup,
          `task5-transfer-${suffix}-existing`,
          transferred.projects[0].id,
        );
        await createExistingCheck(
          setup,
          `task5-recipient-${suffix}-existing`,
          recipient.projects[0].id,
        );
        await Promise.all([
          blocker.$connect(),
          transferClient.$connect(),
          createClient.$connect(),
          observer.$connect(),
        ]);
        const heldLock = track(
          outstanding,
          lockUsersUntilReleased(
            blocker,
            [creatorId, recipientId],
            locked,
            release,
          ),
        );
        await bounded(locked.promise, 'creator and recipient lock acquisition');
        const startTransfer = () =>
          track(
            outstanding,
            organizations(transferClient).transferCreatorship(
              creatorId,
              transferred.id,
              recipientId,
            ),
          );
        const startCreation = () =>
          track(
            outstanding,
            checks(createClient).create(
              recipientId,
              transferred.projects[0].id,
              candidateName,
              10,
              60,
            ),
          );
        let transfer: ReturnType<typeof startTransfer>;
        let creation: ReturnType<typeof startCreation>;
        if (firstOperation === 'transfer') {
          transfer = startTransfer();
          await waitForLock(observer, names.transfer, abort.signal);
          creation = startCreation();
          await waitForLock(observer, names.create, abort.signal);
        } else {
          creation = startCreation();
          await waitForLock(observer, names.create, abort.signal);
          transfer = startTransfer();
          await waitForLock(observer, names.transfer, abort.signal);
        }
        release.resolve();
        await bounded(heldLock, 'held recipient lock release');
        const results = await bounded(
          Promise.allSettled([transfer, creation]),
          'transfer vs creation',
        );

        expect(
          results.filter(({ status }) => status === 'fulfilled'),
        ).toHaveLength(1);
        const loser = rejection(results);
        const organization = await setup.organization.findUniqueOrThrow({
          where: { id: transferred.id },
          select: { creatorUserId: true },
        });
        const candidate = await setup.check.findFirst({
          where: { name: candidateName, projectId: transferred.projects[0].id },
          select: { id: true },
        });
        const recipientCount = await setup.check.count({
          where: {
            project: { organization: { creatorUserId: recipientId } },
          },
        });
        const creatorCount = await setup.check.count({
          where: {
            project: { organization: { creatorUserId: creatorId } },
          },
        });

        if (firstOperation === 'transfer') {
          expect(results[0].status).toBe('fulfilled');
          expect(loser.message).toBe(
            'Your plan limit of 2 checks has been reached. Please upgrade your plan to create more checks.',
          );
          expect(organization.creatorUserId).toBe(recipientId);
          expect(candidate).toBeNull();
          expect(recipientCount).toBe(2);
          expect(creatorCount).toBe(0);
        } else {
          expect(results[1].status).toBe('fulfilled');
          expect(loser.message).toBe(
            "Transfer would exceed the recipient's check limit of 2.",
          );
          expect(organization.creatorUserId).toBe(creatorId);
          expect(candidate).not.toBeNull();
          expect(recipientCount).toBe(1);
          expect(creatorCount).toBe(2);
        }
      } finally {
        abort.abort();
        release.resolve();
        await finishScenario(
          outstanding,
          Object.values(names),
          [blocker, transferClient, createClient, observer],
          setup,
          organizationIds,
          [creatorId, recipientId],
        );
      }
    },
  );

  it('uses the creator account custom interval across organizations', async () => {
    const setup = client('task5-custom-interval-setup');
    const operation = client('task5-custom-interval-operation');
    const creatorId = 'task5-custom-interval-creator';
    const memberId = 'task5-custom-interval-member';
    const organizationIds = ['task5-custom-interval-a'];
    try {
      await createUser(setup, creatorId, 5, 30);
      await createUser(setup, memberId, 5, 300);
      const organization = await createOrganization(
        setup,
        organizationIds[0],
        creatorId,
        [creatorId, memberId],
      );

      await expect(
        checks(operation).createActiveCheck(
          memberId,
          organization.projects[0].id,
          'Creator interval',
          'HTTP',
          'https://example.com',
          30,
          5000,
        ),
      ).resolves.toMatchObject({ intervalSeconds: 30 });
    } finally {
      await cleanupFixture([operation], setup, organizationIds, [
        creatorId,
        memberId,
      ]);
    }
  });

  it.each(['creation', 'removal'] as const)(
    'serializes check creation with membership removal when %s reaches the membership lock first',
    async (firstOperation) => {
      const suffix = `membership-${firstOperation}`;
      const names = {
        blocker: `task5-${suffix}-blocker`,
        create: `task5-${suffix}-create`,
        remove: `task5-${suffix}-remove`,
        observer: `task5-${suffix}-observer`,
      };
      const setup = client(`task5-${suffix}-setup`);
      const blocker = client(names.blocker);
      const createClient = client(names.create);
      const memberClient = client(names.remove);
      const observer = client(names.observer);
      const ownerId = `task5-${suffix}-owner`;
      const memberId = `task5-${suffix}-member`;
      const organizationIds = [`task5-${suffix}-org`];
      const membershipId = `task5-${suffix}-membership`;
      const candidateName = `Membership candidate ${firstOperation}`;
      const locked = deferred();
      const release = deferred();
      const abort = new AbortController();
      const outstanding: Promise<unknown>[] = [];
      try {
        await createUser(setup, ownerId, 5);
        await createUser(setup, memberId, 5);
        const organization = await createOrganization(
          setup,
          organizationIds[0],
          ownerId,
          [ownerId],
        );
        await setup.membership.create({
          data: {
            id: membershipId,
            userId: memberId,
            organizationId: organization.id,
            role: 'MEMBER',
          },
        });
        await Promise.all([
          blocker.$connect(),
          createClient.$connect(),
          memberClient.$connect(),
          observer.$connect(),
        ]);
        const heldLock = track(
          outstanding,
          lockMembershipUntilReleased(blocker, membershipId, locked, release),
        );
        await bounded(locked.promise, 'membership lock acquisition');
        const startCreation = () =>
          track(
            outstanding,
            checks(createClient).create(
              memberId,
              organization.projects[0].id,
              candidateName,
              10,
              60,
            ),
          );
        const startRemoval = () =>
          track(
            outstanding,
            members(memberClient).removeMember(ownerId, membershipId),
          );
        let creation: ReturnType<typeof startCreation>;
        let removal: ReturnType<typeof startRemoval>;
        if (firstOperation === 'creation') {
          creation = startCreation();
          await waitForLock(observer, names.create, abort.signal);
          removal = startRemoval();
          await waitForLock(observer, names.remove, abort.signal);
        } else {
          removal = startRemoval();
          await waitForLock(observer, names.remove, abort.signal);
          creation = startCreation();
          await waitForLock(observer, names.create, abort.signal);
        }
        release.resolve();
        await bounded(heldLock, 'held membership lock release');
        const [creationResult, removalResult] = await bounded(
          Promise.allSettled([creation, removal]),
          'creation vs membership removal',
        );

        expect(removalResult.status).toBe('fulfilled');
        const candidate = await setup.check.findFirst({
          where: {
            projectId: organization.projects[0].id,
            name: candidateName,
          },
          select: { id: true },
        });
        if (firstOperation === 'creation') {
          expect(creationResult.status).toBe('fulfilled');
          expect(candidate).not.toBeNull();
        } else {
          expect(creationResult.status).toBe('rejected');
          if (creationResult.status === 'rejected') {
            expect(creationResult.reason).toBeInstanceOf(ForbiddenException);
          }
          expect(candidate).toBeNull();
        }
        expect(
          await setup.membership.findUnique({ where: { id: membershipId } }),
        ).toBeNull();
      } finally {
        abort.abort();
        release.resolve();
        await finishScenario(
          outstanding,
          Object.values(names),
          [blocker, createClient, memberClient, observer],
          setup,
          organizationIds,
          [ownerId, memberId],
        );
      }
    },
  );

  it('prevents an update authorized from a membership removed by concurrent leave', async () => {
    const names = {
      blocker: 'task5-update-leave-blocker',
      update: 'task5-update-leave-update',
      leave: 'task5-update-leave-operation',
      observer: 'task5-update-leave-observer',
    };
    const setup = client('task5-update-leave-setup');
    const blocker = client(names.blocker);
    const updateClient = client(names.update);
    const leaveClient = client(names.leave);
    const observer = client(names.observer);
    const ownerId = 'task5-update-leave-owner';
    const memberId = 'task5-update-leave-member';
    const organizationIds = ['task5-update-leave-org'];
    const membershipId = 'task5-update-leave-membership';
    const checkId = 'task5-update-leave-check';
    const locked = deferred();
    const release = deferred();
    const abort = new AbortController();
    const outstanding: Promise<unknown>[] = [];
    try {
      await createUser(setup, ownerId, 5);
      await createUser(setup, memberId, 5);
      const organization = await createOrganization(
        setup,
        organizationIds[0],
        ownerId,
        [ownerId],
      );
      await setup.membership.create({
        data: {
          id: membershipId,
          userId: memberId,
          organizationId: organization.id,
          role: 'MEMBER',
        },
      });
      await createExistingCheck(setup, checkId, organization.projects[0].id);
      await Promise.all([
        blocker.$connect(),
        updateClient.$connect(),
        leaveClient.$connect(),
        observer.$connect(),
      ]);
      const heldLock = track(
        outstanding,
        lockMembershipUntilReleased(blocker, membershipId, locked, release),
      );
      await bounded(locked.promise, 'update membership lock acquisition');
      const leave = track(
        outstanding,
        members(leaveClient).leave(memberId, organization.id),
      );
      await waitForLock(observer, names.leave, abort.signal);
      const update = track(
        outstanding,
        checks(updateClient).update(
          memberId,
          checkId,
          organization.projects[0].id,
          {
            name: 'Stale update',
          },
        ),
      );
      await waitForLock(observer, names.update, abort.signal);
      release.resolve();
      await bounded(heldLock, 'held update membership lock release');
      const [leaveResult, updateResult] = await bounded(
        Promise.allSettled([leave, update]),
        'update vs leave',
      );

      expect(leaveResult.status).toBe('fulfilled');
      expect(updateResult.status).toBe('rejected');
      if (updateResult.status === 'rejected') {
        expect(updateResult.reason).toBeInstanceOf(ForbiddenException);
      }
      expect(
        await setup.check.findUniqueOrThrow({
          where: { id: checkId },
          select: { name: true },
        }),
      ).toEqual({ name: checkId });
    } finally {
      abort.abort();
      release.resolve();
      await finishScenario(
        outstanding,
        Object.values(names),
        [blocker, updateClient, leaveClient, observer],
        setup,
        organizationIds,
        [ownerId, memberId],
      );
    }
  });

  it('serializes conversion before interval edit without applying a stale active payload', async () => {
    const names = {
      blocker: 'task5-conversion-blocker',
      conversion: 'task5-conversion-operation',
      interval: 'task5-interval-operation',
      observer: 'task5-conversion-observer',
    };
    const setup = client('task5-conversion-setup');
    const blocker = client(names.blocker);
    const conversionClient = client(names.conversion);
    const intervalClient = client(names.interval);
    const observer = client(names.observer);
    const ownerId = 'task5-conversion-owner';
    const organizationIds = ['task5-conversion-org'];
    const checkId = 'task5-conversion-check';
    const locked = deferred();
    const release = deferred();
    const abort = new AbortController();
    const outstanding: Promise<unknown>[] = [];
    try {
      await createUser(setup, ownerId, 5);
      const organization = await createOrganization(
        setup,
        organizationIds[0],
        ownerId,
        [ownerId],
      );
      await setup.check.create({
        data: {
          id: checkId,
          name: 'Active',
          slug: 'active',
          type: 'HTTP',
          status: 'NEW',
          target: 'https://example.com',
          method: 'GET',
          expectedStatus: 200,
          intervalSeconds: 300,
          timeoutMs: 5000,
          projectId: organization.projects[0].id,
        },
      });
      await Promise.all([
        blocker.$connect(),
        conversionClient.$connect(),
        intervalClient.$connect(),
        observer.$connect(),
      ]);
      const heldLock = track(
        outstanding,
        lockCheckUntilReleased(blocker, checkId, locked, release),
      );
      await bounded(locked.promise, 'check row lock acquisition');
      const conversion = track(
        outstanding,
        checks(conversionClient).update(
          ownerId,
          checkId,
          organization.projects[0].id,
          {
            type: 'HEARTBEAT',
            periodSeconds: 120,
            graceSeconds: 10,
          },
        ),
      );
      await waitForLock(observer, names.conversion, abort.signal);
      const intervalEdit = track(
        outstanding,
        checks(intervalClient).update(
          ownerId,
          checkId,
          organization.projects[0].id,
          {
            intervalSeconds: 60,
          },
        ),
      );
      await waitForLock(observer, names.interval, abort.signal);
      release.resolve();
      await bounded(heldLock, 'held check row lock release');
      await bounded(
        Promise.all([conversion, intervalEdit]),
        'conversion vs interval edit',
      );

      expect(
        await setup.check.findUniqueOrThrow({
          where: { id: checkId },
          select: {
            type: true,
            periodSeconds: true,
            graceSeconds: true,
            target: true,
            intervalSeconds: true,
            timeoutMs: true,
          },
        }),
      ).toEqual({
        type: 'HEARTBEAT',
        periodSeconds: 120,
        graceSeconds: 10,
        target: null,
        intervalSeconds: null,
        timeoutMs: null,
      });
    } finally {
      abort.abort();
      release.resolve();
      await finishScenario(
        outstanding,
        Object.values(names),
        [blocker, conversionClient, intervalClient, observer],
        setup,
        organizationIds,
        [ownerId],
      );
    }
  });
});
