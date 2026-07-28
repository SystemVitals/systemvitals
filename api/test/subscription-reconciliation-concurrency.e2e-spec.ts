import { randomUUID } from 'node:crypto';
import { PrismaClient } from '@systemvitals/database';
import type Stripe from 'stripe';
import { AdminService } from '../src/admin/admin.service';
import type { AuthService } from '../src/auth/auth.service';
import { AccountEntitlementsService } from '../src/billing/account-entitlements.service';
import { BillingService } from '../src/billing/billing.service';
import {
  type ReconciliationSummary,
  SubscriptionReconciliationService,
} from '../src/billing/subscription-reconciliation.service';
import { ReconciliationRunLock } from '../src/billing/subscription-reconciliation-lock';
import type { StripePriceRegistry } from '../src/billing/stripe-price-registry';
import { OrganizationsService } from '../src/organizations/organizations.service';
import type { PrismaService } from '../src/prisma/prisma.service';

const TIMEOUT_MS = 8_000;
jest.setTimeout(30_000);

const reconciliationPrices = {
  planForPriceId: (priceId: string) =>
    priceId.includes('fleet') ? 'FLEET' : 'SIGNAL',
} as StripePriceRegistry;

function connectionUrl(applicationName: string): string {
  const url = new URL(process.env.DATABASE_URL!);
  url.searchParams.set('connection_limit', '1');
  url.searchParams.set('application_name', applicationName);
  return url.toString();
}

function client(applicationName: string): PrismaClient {
  return new PrismaClient({ datasourceUrl: connectionUrl(applicationName) });
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

async function waitForLock(
  observer: PrismaClient,
  applicationName: string,
): Promise<void> {
  const deadline = Date.now() + TIMEOUT_MS;
  while (Date.now() < deadline) {
    const rows = await observer.$queryRaw<
      Array<{ waitEventType: string | null }>
    >`
      SELECT wait_event_type AS "waitEventType"
      FROM pg_stat_activity
      WHERE application_name = ${applicationName}
        AND state = 'active'
    `;
    if (rows.some(({ waitEventType }) => waitEventType === 'Lock')) return;
    await new Promise((resolve) => setTimeout(resolve, 10));
  }
  throw new Error(`${applicationName} did not wait on a PostgreSQL lock`);
}

describe('subscription reconciliation lock ordering (PostgreSQL)', () => {
  it('serializes concurrent runs and cancels a duplicate once', async () => {
    const suffix = randomUUID();
    const userId = `concurrent-user-${suffix}`;
    const orgId = `concurrent-org-${suffix}`;
    const winnerOrgId = `concurrent-winner-org-${suffix}`;
    const winnerId = `concurrent-winner-${suffix}`;
    const legacyId = `concurrent-legacy-${suffix}`;
    const customerId = `cus-concurrent-${suffix}`;
    const winnerStripeId = `sub-concurrent-winner-${suffix}`;
    const legacyStripeId = `sub-concurrent-legacy-${suffix}`;
    const setup = client(`reconcile-concurrent-setup-${suffix}`);
    const firstClient = client(`reconcile-concurrent-first-${suffix}`);
    const secondClient = client(`reconcile-concurrent-second-${suffix}`);
    let releaseCancellation!: () => void;
    const cancellationBlocked = new Promise<void>((resolve) => {
      releaseCancellation = resolve;
    });
    let cancellationStarted!: () => void;
    const started = new Promise<void>((resolve) => {
      cancellationStarted = resolve;
    });
    const cancel = jest.fn(async () => {
      cancellationStarted();
      await cancellationBlocked;
      return { id: legacyStripeId };
    });
    const stripe = {
      subscriptions: {
        cancel,
        retrieve: jest.fn((id: string) =>
          Promise.resolve({
            id,
            status: 'active',
            customer:
              id === winnerStripeId
                ? customerId
                : {
                    id: `cus-legacy-${orgId}`,
                    deleted: false,
                    metadata: { organizationId: orgId },
                  },
            items: {
              data: [
                {
                  price: {
                    id: 'price_signal',
                    recurring: { interval: 'month' },
                    unit_amount: 500,
                  },
                },
              ],
            },
          }),
        ),
      },
      customers: {
        retrieve: jest.fn(() =>
          Promise.resolve({
            id: customerId,
            deleted: false,
            metadata: { organizationId: winnerOrgId },
          }),
        ),
      },
    } as unknown as Stripe;
    const makeService = (prisma: PrismaClient) =>
      new SubscriptionReconciliationService(
        prisma as unknown as PrismaService,
        stripe,
        new AccountEntitlementsService(prisma as unknown as PrismaService),
        new ReconciliationRunLock(),
        reconciliationPrices,
      );
    let firstRun: Promise<ReconciliationSummary> | undefined;
    let secondRun: Promise<ReconciliationSummary> | undefined;

    try {
      await setup.user.create({
        data: {
          id: userId,
          email: `${userId}@example.test`,
          passwordHash: 'unused',
          stripeCustomerId: customerId,
        },
      });
      await setup.organization.create({
        data: {
          id: orgId,
          name: 'Concurrent run',
          slug: orgId,
          creatorUserId: userId,
          stripeCustomerId: `cus-legacy-${orgId}`,
        },
      });
      await setup.organization.create({
        data: {
          id: winnerOrgId,
          name: 'Migrated winner organization',
          slug: winnerOrgId,
          creatorUserId: userId,
          stripeCustomerId: customerId,
        },
      });
      await setup.subscription.createMany({
        data: [
          {
            id: winnerId,
            userId,
            organizationId: winnerOrgId,
            plan: 'SIGNAL',
            status: 'active',
            stripeSubscriptionId: winnerStripeId,
          },
          {
            id: legacyId,
            organizationId: orgId,
            plan: 'SIGNAL',
            status: 'active',
            stripeSubscriptionId: legacyStripeId,
          },
        ],
      });

      firstRun = makeService(firstClient).reconcile();
      await bounded(started, 'first concurrent cancellation');
      secondRun = makeService(secondClient).reconcile();
      await new Promise((resolve) => setTimeout(resolve, 50));
      expect(cancel).toHaveBeenCalledTimes(1);

      releaseCancellation();
      const summaries = await bounded(
        Promise.all([firstRun, secondRun]),
        'concurrent reconciliation runs',
      );
      expect(cancel).toHaveBeenCalledTimes(1);
      expect(
        summaries.reduce(
          (total, summary) => total + summary.duplicatesCancelled,
          0,
        ),
      ).toBe(1);
    } finally {
      releaseCancellation();
      await Promise.allSettled(
        [firstRun, secondRun].filter(
          (run): run is Promise<ReconciliationSummary> => run !== undefined,
        ),
      );
      await setup.subscription.deleteMany({
        where: { id: { in: [winnerId, legacyId] } },
      });
      await setup.organization.deleteMany({
        where: { id: { in: [orgId, winnerOrgId] } },
      });
      await setup.user.deleteMany({ where: { id: userId } });
      await Promise.all([
        setup.$disconnect(),
        firstClient.$disconnect(),
        secondClient.$disconnect(),
      ]);
    }
  });

  it('commits successful candidates before a later Stripe failure', async () => {
    const suffix = randomUUID();
    const userId = `progress-user-${suffix}`;
    const customerId = `cus-progress-${suffix}`;
    const winnerStripeId = `sub-progress-winner-${suffix}`;
    const orgIds = [`progress-org-a-${suffix}`, `progress-org-b-${suffix}`];
    const rowIds = [
      `progress-winner-${suffix}`,
      `progress-legacy-a-${suffix}`,
      `progress-legacy-b-${suffix}`,
    ];
    const stripeIds = [
      winnerStripeId,
      `sub-progress-legacy-a-${suffix}`,
      `sub-progress-legacy-b-${suffix}`,
    ];
    const setup = client(`reconcile-progress-setup-${suffix}`);
    const reconcileClient = client(`reconcile-progress-run-${suffix}`);
    const cancel = jest
      .fn()
      .mockResolvedValueOnce({ id: stripeIds[1] })
      .mockRejectedValueOnce(new Error('transient Stripe failure'));
    const reconciliation = new SubscriptionReconciliationService(
      reconcileClient as unknown as PrismaService,
      {
        subscriptions: {
          cancel,
          retrieve: jest.fn((id: string) =>
            Promise.resolve({
              id,
              status: 'active',
              customer:
                id === winnerStripeId
                  ? customerId
                  : {
                      id: `cus-legacy-${orgIds[stripeIds.indexOf(id) - 1]}`,
                      deleted: false,
                      metadata: {
                        organizationId: orgIds[stripeIds.indexOf(id) - 1],
                      },
                    },
              items: {
                data: [
                  {
                    price: {
                      id: id.includes('legacy-b')
                        ? 'price_fleet'
                        : 'price_signal',
                      recurring: { interval: 'month' },
                      unit_amount: id.includes('legacy-b') ? 2_000 : 500,
                    },
                  },
                ],
              },
            }),
          ),
        },
        customers: {
          retrieve: jest.fn(() =>
            Promise.resolve({
              id: customerId,
              deleted: false,
              metadata: { userId },
            }),
          ),
        },
      } as unknown as Stripe,
      new AccountEntitlementsService(
        reconcileClient as unknown as PrismaService,
      ),
      new ReconciliationRunLock(),
      reconciliationPrices,
    );

    try {
      await setup.user.create({
        data: {
          id: userId,
          email: `${userId}@example.test`,
          passwordHash: 'unused',
          stripeCustomerId: customerId,
        },
      });
      await setup.organization.createMany({
        data: orgIds.map((id) => ({
          id,
          name: id,
          slug: id,
          creatorUserId: userId,
          stripeCustomerId: `cus-legacy-${id}`,
        })),
      });
      await setup.subscription.createMany({
        data: [
          {
            id: rowIds[0],
            userId,
            plan: 'SIGNAL',
            status: 'active',
            stripeSubscriptionId: stripeIds[0],
          },
          {
            id: rowIds[1],
            organizationId: orgIds[0],
            plan: 'SIGNAL',
            status: 'active',
            stripeSubscriptionId: stripeIds[1],
          },
          {
            id: rowIds[2],
            organizationId: orgIds[1],
            plan: 'FLEET',
            status: 'active',
            stripeSubscriptionId: stripeIds[2],
          },
        ],
      });

      const summary = await reconciliation.reconcile();

      expect(summary.duplicatesCancelled).toBe(1);
      expect(summary.failures).toEqual([
        {
          subscriptionId: rowIds[2],
          message: 'Stripe cancellation failed; retry required',
        },
      ]);
      await expect(
        setup.subscription.findMany({
          where: { id: { in: rowIds.slice(1) } },
          orderBy: { id: 'asc' },
          select: { status: true },
        }),
      ).resolves.toEqual([{ status: 'canceled' }, { status: 'active' }]);
    } finally {
      await setup.subscription.deleteMany({ where: { id: { in: rowIds } } });
      await setup.organization.deleteMany({ where: { id: { in: orgIds } } });
      await setup.user.deleteMany({ where: { id: userId } });
      await Promise.all([setup.$disconnect(), reconcileClient.$disconnect()]);
    }
  });

  it('repairs local status on rerun when cancellation succeeded but commit failed', async () => {
    const suffix = randomUUID();
    const userId = `repair-user-${suffix}`;
    const orgId = `repair-org-${suffix}`;
    const winnerRowId = `repair-winner-${suffix}`;
    const legacyRowId = `repair-legacy-${suffix}`;
    const customerId = `cus-repair-${suffix}`;
    const winnerStripeId = `sub-repair-winner-${suffix}`;
    const legacyStripeId = `sub-repair-legacy-${suffix}`;
    const setup = client(`reconcile-repair-setup-${suffix}`);
    const reconcileClient = client(`reconcile-repair-run-${suffix}`);
    let transactionCount = 0;
    const prismaFacade = {
      subscription: reconcileClient.subscription,
      $transaction: <T>(
        operation: (tx: PrismaClient) => Promise<T>,
        options: { maxWait: number; timeout: number },
      ) =>
        reconcileClient.$transaction(async (tx) => {
          transactionCount += 1;
          const result = await operation(tx as unknown as PrismaClient);
          if (transactionCount === 2) {
            throw new Error('simulated commit failure');
          }
          return result;
        }, options),
    };
    let candidateCanceled = false;
    const cancel = jest.fn().mockImplementation(() => {
      candidateCanceled = true;
      return Promise.resolve({ id: legacyStripeId });
    });
    const reconciliation = new SubscriptionReconciliationService(
      prismaFacade as unknown as PrismaService,
      {
        subscriptions: {
          cancel,
          retrieve: jest.fn((id: string) =>
            Promise.resolve({
              id,
              status:
                id === legacyStripeId && candidateCanceled
                  ? 'canceled'
                  : 'active',
              customer:
                id === winnerStripeId
                  ? customerId
                  : {
                      id: `cus-legacy-${orgId}`,
                      deleted: false,
                      metadata: { organizationId: orgId },
                    },
              items: {
                data: [
                  {
                    price: {
                      id: 'price_signal',
                      recurring: { interval: 'month' },
                      unit_amount: 500,
                    },
                  },
                ],
              },
            }),
          ),
        },
        customers: {
          retrieve: jest.fn(() =>
            Promise.resolve({
              id: customerId,
              deleted: false,
              metadata: { userId },
            }),
          ),
        },
      } as unknown as Stripe,
      new AccountEntitlementsService(prismaFacade as unknown as PrismaService),
      new ReconciliationRunLock(),
      reconciliationPrices,
    );

    try {
      await setup.user.create({
        data: {
          id: userId,
          email: `${userId}@example.test`,
          passwordHash: 'unused',
          stripeCustomerId: customerId,
        },
      });
      await setup.organization.create({
        data: {
          id: orgId,
          name: 'Commit repair',
          slug: orgId,
          creatorUserId: userId,
          stripeCustomerId: `cus-legacy-${orgId}`,
        },
      });
      await setup.subscription.createMany({
        data: [
          {
            id: winnerRowId,
            userId,
            plan: 'SIGNAL',
            status: 'active',
            stripeSubscriptionId: winnerStripeId,
          },
          {
            id: legacyRowId,
            organizationId: orgId,
            plan: 'SIGNAL',
            status: 'active',
            stripeSubscriptionId: legacyStripeId,
          },
        ],
      });

      const first = await reconciliation.reconcile();
      expect(first.failures).toEqual([
        {
          subscriptionId: legacyRowId,
          message: 'Stripe cancellation failed; retry required',
        },
      ]);
      await expect(
        setup.subscription.findUniqueOrThrow({
          where: { id: legacyRowId },
          select: { status: true },
        }),
      ).resolves.toEqual({ status: 'active' });

      const second = await reconciliation.reconcile();
      expect(second.usersScanned).toBeGreaterThanOrEqual(1);
      expect(second.duplicatesCancelled).toBe(0);
      expect(second.alreadyGone).toBe(1);
      expect(second.failures).toEqual([]);
      await expect(
        setup.subscription.findUniqueOrThrow({
          where: { id: legacyRowId },
          select: { status: true },
        }),
      ).resolves.toEqual({ status: 'canceled' });
      expect(cancel).toHaveBeenCalledTimes(1);
    } finally {
      await setup.subscription.deleteMany({
        where: { id: { in: [winnerRowId, legacyRowId] } },
      });
      await setup.organization.deleteMany({ where: { id: orgId } });
      await setup.user.deleteMany({ where: { id: userId } });
      await Promise.all([setup.$disconnect(), reconcileClient.$disconnect()]);
    }
  });

  it('blocks real billing and admin mutations on the reconciliation user lock', async () => {
    const suffix = randomUUID();
    const actorId = `advisory-actor-${suffix}`;
    const userId = `advisory-user-${suffix}`;
    const customerId = `cus-advisory-${suffix}`;
    const stripeSubscriptionId = `sub-advisory-${suffix}`;
    const billingName = `advisory-billing-${suffix}`;
    const adminName = `advisory-admin-${suffix}`;
    const setup = client(`advisory-setup-${suffix}`);
    const billingClient = client(billingName);
    const adminClient = client(adminName);
    const observer = client(`advisory-observer-${suffix}`);
    const stripe = {
      subscriptions: {
        list: jest.fn(() => ({
          autoPagingToArray: () =>
            Promise.resolve([
              {
                id: stripeSubscriptionId,
                status: 'active',
                items: { data: [{ price: { id: 'price_signal' } }] },
              },
            ]),
        })),
      },
    } as unknown as Stripe;
    const billing = new BillingService(
      stripe,
      billingClient as unknown as PrismaService,
      reconciliationPrices,
      new AccountEntitlementsService(billingClient as unknown as PrismaService),
    );
    const admin = new AdminService(
      adminClient as unknown as PrismaService,
      {} as AuthService,
      new AccountEntitlementsService(adminClient as unknown as PrismaService),
    );
    let billingRun: Promise<void> | undefined;
    let adminRun: Promise<unknown> | undefined;

    try {
      await setup.user.createMany({
        data: [
          {
            id: actorId,
            email: `${actorId}@example.test`,
            passwordHash: 'unused',
          },
          {
            id: userId,
            email: `${userId}@example.test`,
            passwordHash: 'unused',
            stripeCustomerId: customerId,
          },
        ],
      });
      await setup.subscription.create({
        data: {
          userId,
          plan: 'SIGNAL',
          status: 'active',
          stripeSubscriptionId,
        },
      });

      await new ReconciliationRunLock().withUserLock(userId, async () => {
        billingRun = billing.applySubscriptionEvent(customerId);
        adminRun = admin.setUserPlan(actorId, userId, 'FLEET', null, true);
        void billingRun.catch(() => undefined);
        void adminRun.catch(() => undefined);

        await bounded(
          Promise.all([
            waitForLock(observer, billingName),
            waitForLock(observer, adminName),
          ]),
          'billing/admin advisory-lock observation',
        );
        await expect(
          setup.user.findUniqueOrThrow({
            where: { id: userId },
            select: { billingStateVersion: true },
          }),
        ).resolves.toEqual({ billingStateVersion: 0 });
      });

      await bounded(
        Promise.all([billingRun!, adminRun!]),
        'billing/admin completion after user-lock release',
      );
      await expect(
        setup.user.findUniqueOrThrow({
          where: { id: userId },
          select: { billingStateVersion: true },
        }),
      ).resolves.not.toEqual({ billingStateVersion: 0 });
    } finally {
      await Promise.allSettled(
        [billingRun, adminRun].filter(
          (operation): operation is Promise<unknown> => operation !== undefined,
        ),
      );
      await setup.auditLog.deleteMany({
        where: { actorUserId: actorId, targetId: userId },
      });
      await setup.subscription.deleteMany({ where: { userId } });
      await setup.user.deleteMany({
        where: { id: { in: [actorId, userId] } },
      });
      await Promise.all([
        setup.$disconnect(),
        billingClient.$disconnect(),
        adminClient.$disconnect(),
        observer.$disconnect(),
      ]);
    }
  });

  it('completes reconciliation and a concurrent A/Z transfer without deadlock', async () => {
    const suffix = randomUUID();
    const userA = `a-reconcile-${suffix}`;
    const userZ = `z-reconcile-${suffix}`;
    const orgA = `org-a-reconcile-${suffix}`;
    const orgZ = `org-z-reconcile-${suffix}`;
    const accountA = `winner-z-id-${suffix}`;
    const accountZ = `winner-a-id-${suffix}`;
    const legacyA = `legacy-a-${suffix}`;
    const legacyZ = `legacy-z-${suffix}`;
    const reconcileName = `task8-reconcile-${suffix}`;
    const transferName = `task8-transfer-${suffix}`;
    const setup = client(`task8-setup-${suffix}`);
    const reconcileClient = client(reconcileName);
    const transferClient = client(transferName);
    const observer = client(`task8-observer-${suffix}`);
    let releaseFirstCancellation: (() => void) | undefined;
    const firstCancellationBlocked = new Promise<void>((resolve) => {
      releaseFirstCancellation = resolve;
    });
    let markCancellationStarted!: () => void;
    const cancellationStarted = new Promise<void>((resolve) => {
      markCancellationStarted = resolve;
    });
    const cancel = jest
      .fn<Promise<{ id: string }>, [string]>()
      .mockImplementationOnce(async () => {
        markCancellationStarted();
        await firstCancellationBlocked;
        return { id: `sub-legacy-a-${suffix}` };
      })
      .mockResolvedValue({ id: `sub-legacy-z-${suffix}` });
    const stripe = {
      subscriptions: {
        cancel,
        retrieve: jest.fn((id: string) =>
          Promise.resolve({
            id,
            status: 'active',
            customer: id.includes('winner')
              ? id.includes('winner-a')
                ? `cus-a-${suffix}`
                : `cus-z-${suffix}`
              : {
                  id: id.includes('legacy-a')
                    ? `cus-legacy-a-${suffix}`
                    : `cus-legacy-z-${suffix}`,
                  deleted: false,
                  metadata: {
                    organizationId: id.includes('legacy-a') ? orgA : orgZ,
                  },
                },
            items: {
              data: [
                {
                  price: {
                    id: 'price_signal',
                    recurring: { interval: 'month' },
                    unit_amount: 500,
                  },
                },
              ],
            },
          }),
        ),
      },
      customers: {
        retrieve: jest.fn((id: string) =>
          Promise.resolve({
            id,
            deleted: false,
            metadata: {
              userId: id.includes('cus-a') ? userA : userZ,
            },
          }),
        ),
      },
    };
    const reconciliation = new SubscriptionReconciliationService(
      reconcileClient as unknown as PrismaService,
      stripe as unknown as Stripe,
      new AccountEntitlementsService(
        reconcileClient as unknown as PrismaService,
      ),
      new ReconciliationRunLock(),
      reconciliationPrices,
    );
    const organizations = new OrganizationsService(
      transferClient as unknown as PrismaService,
      new AccountEntitlementsService(
        transferClient as unknown as PrismaService,
      ),
    );
    let reconcileRun: Promise<unknown> | undefined;
    let transferRun: Promise<unknown> | undefined;

    try {
      await setup.user.createMany({
        data: [
          {
            id: userA,
            email: `${userA}@example.test`,
            passwordHash: 'not-used',
            stripeCustomerId: `cus-a-${suffix}`,
          },
          {
            id: userZ,
            email: `${userZ}@example.test`,
            passwordHash: 'not-used',
            stripeCustomerId: `cus-z-${suffix}`,
          },
        ],
      });
      await setup.organization.create({
        data: {
          id: orgA,
          name: 'Account A',
          slug: orgA,
          creatorUserId: userA,
          stripeCustomerId: `cus-legacy-a-${suffix}`,
          memberships: { create: { userId: userA, role: 'OWNER' } },
        },
      });
      await setup.organization.create({
        data: {
          id: orgZ,
          name: 'Account Z',
          slug: orgZ,
          creatorUserId: userZ,
          stripeCustomerId: `cus-legacy-z-${suffix}`,
          memberships: {
            createMany: {
              data: [
                { userId: userZ, role: 'OWNER' },
                { userId: userA, role: 'OWNER' },
              ],
            },
          },
        },
      });
      await setup.subscription.createMany({
        data: [
          {
            id: accountA,
            userId: userA,
            plan: 'SIGNAL',
            status: 'active',
            stripeSubscriptionId: `sub-winner-a-${suffix}`,
          },
          {
            id: accountZ,
            userId: userZ,
            plan: 'SIGNAL',
            status: 'active',
            stripeSubscriptionId: `sub-winner-z-${suffix}`,
          },
          {
            id: legacyA,
            organizationId: orgA,
            plan: 'SIGNAL',
            status: 'active',
            stripeSubscriptionId: `sub-legacy-a-${suffix}`,
          },
          {
            id: legacyZ,
            organizationId: orgZ,
            plan: 'SIGNAL',
            status: 'active',
            stripeSubscriptionId: `sub-legacy-z-${suffix}`,
          },
        ],
      });

      reconcileRun = reconciliation.reconcile();
      void reconcileRun.catch(() => undefined);
      await bounded(
        Promise.race([
          cancellationStarted,
          reconcileRun.then(() => {
            throw new Error('reconciliation completed before cancellation');
          }),
        ]),
        'first cancellation start',
      );
      const [{ acquired }] = await observer.$queryRaw<
        Array<{ acquired: boolean }>
      >`
        SELECT pg_try_advisory_lock(1735688564) AS acquired
      `;
      expect(acquired).toBe(false);

      transferRun = organizations.transferCreatorship(userZ, orgZ, userA);
      void transferRun.catch(() => undefined);
      await bounded(
        waitForLock(observer, transferName),
        'transfer advisory-lock observation',
      );

      releaseFirstCancellation?.();
      const [summary] = await bounded(
        Promise.all([
          reconcileRun,
          expect(transferRun).rejects.toThrow(
            'Complete account subscription reconciliation before transferring/deleting this organization.',
          ),
        ]),
        'reconciliation/transfer completion',
      );

      const reconciliationSummary = summary as ReconciliationSummary;
      expect(reconciliationSummary.usersScanned).toBeGreaterThanOrEqual(2);
      expect(reconciliationSummary.duplicatesCancelled).toBe(2);
      expect(reconciliationSummary.alreadyGone).toBe(0);
      expect(reconciliationSummary.failures).not.toEqual(
        expect.arrayContaining([
          expect.objectContaining({ subscriptionId: accountA }),
          expect.objectContaining({ subscriptionId: accountZ }),
        ]),
      );
      expect(cancel.mock.calls.map(([stripeId]) => stripeId)).toEqual([
        `sub-legacy-a-${suffix}`,
        `sub-legacy-z-${suffix}`,
      ]);
      expect(
        await setup.subscription.findMany({
          where: { id: { in: [legacyA, legacyZ] } },
          orderBy: { id: 'asc' },
          select: { status: true },
        }),
      ).toEqual([{ status: 'canceled' }, { status: 'canceled' }]);
      await expect(
        setup.organization.findUniqueOrThrow({
          where: { id: orgZ },
          select: { creatorUserId: true },
        }),
      ).resolves.toEqual({ creatorUserId: userZ });
    } finally {
      releaseFirstCancellation?.();
      await Promise.allSettled(
        [reconcileRun, transferRun].filter(
          (operation): operation is Promise<unknown> => operation !== undefined,
        ),
      );
      await setup.subscription.deleteMany({
        where: { id: { in: [accountA, accountZ, legacyA, legacyZ] } },
      });
      await setup.organization.deleteMany({
        where: { id: { in: [orgA, orgZ] } },
      });
      await setup.user.deleteMany({ where: { id: { in: [userA, userZ] } } });
      await Promise.all([
        setup.$disconnect(),
        reconcileClient.$disconnect(),
        transferClient.$disconnect(),
        observer.$disconnect(),
      ]);
    }
  });

  it('checkpoints reconciliation before a waiting admin organization delete', async () => {
    const suffix = randomUUID();
    const actorId = `admin-reconcile-delete-${suffix}`;
    const userId = `creator-reconcile-delete-${suffix}`;
    const orgId = `org-reconcile-delete-${suffix}`;
    const accountId = `account-reconcile-delete-${suffix}`;
    const legacyId = `legacy-reconcile-delete-${suffix}`;
    const customerId = `cus-reconcile-delete-${suffix}`;
    const winnerStripeId = `sub-winner-delete-${suffix}`;
    const legacyStripeId = `sub-legacy-delete-${suffix}`;
    const reconcileName = `reconcile-delete-${suffix}`;
    const deleteName = `admin-delete-reconcile-${suffix}`;
    const setup = client(`reconcile-delete-setup-${suffix}`);
    const reconcileClient = client(reconcileName);
    const deleteClient = client(deleteName);
    const observer = client(`reconcile-delete-observer-${suffix}`);
    let releaseCancellation!: () => void;
    const cancellationBlocked = new Promise<void>((resolve) => {
      releaseCancellation = resolve;
    });
    let markCancellationStarted!: () => void;
    const cancellationStarted = new Promise<void>((resolve) => {
      markCancellationStarted = resolve;
    });
    const cancel = jest.fn(async () => {
      markCancellationStarted();
      await cancellationBlocked;
      return { id: legacyStripeId };
    });
    const stripe = {
      subscriptions: {
        cancel,
        retrieve: jest.fn((id: string) =>
          Promise.resolve({
            id,
            status: 'active',
            customer:
              id === winnerStripeId
                ? customerId
                : {
                    id: `cus-legacy-delete-${suffix}`,
                    deleted: false,
                    metadata: { organizationId: orgId },
                  },
            items: {
              data: [
                {
                  price: {
                    id: 'price_signal',
                    recurring: { interval: 'month' },
                    unit_amount: 500,
                  },
                },
              ],
            },
          }),
        ),
      },
      customers: {
        retrieve: jest.fn(() =>
          Promise.resolve({
            id: customerId,
            deleted: false,
            metadata: { userId },
          }),
        ),
      },
    } as unknown as Stripe;
    const reconciliation = new SubscriptionReconciliationService(
      reconcileClient as unknown as PrismaService,
      stripe,
      new AccountEntitlementsService(
        reconcileClient as unknown as PrismaService,
      ),
      new ReconciliationRunLock(),
      reconciliationPrices,
    );
    const admin = new AdminService(
      deleteClient as unknown as PrismaService,
      {} as AuthService,
      new AccountEntitlementsService(deleteClient as unknown as PrismaService),
    );
    let reconcileRun: Promise<ReconciliationSummary> | undefined;
    let deleteRun: Promise<boolean> | undefined;

    try {
      await setup.user.createMany({
        data: [
          {
            id: actorId,
            email: `${actorId}@example.test`,
            passwordHash: 'unused',
            isAdmin: true,
          },
          {
            id: userId,
            email: `${userId}@example.test`,
            passwordHash: 'unused',
            stripeCustomerId: customerId,
          },
        ],
      });
      await setup.organization.create({
        data: {
          id: orgId,
          name: 'Reconcile then delete',
          slug: orgId,
          creatorUserId: userId,
          stripeCustomerId: `cus-legacy-delete-${suffix}`,
        },
      });
      await setup.subscription.createMany({
        data: [
          {
            id: accountId,
            userId,
            plan: 'SIGNAL',
            status: 'active',
            stripeSubscriptionId: winnerStripeId,
          },
          {
            id: legacyId,
            organizationId: orgId,
            plan: 'SIGNAL',
            status: 'active',
            stripeSubscriptionId: legacyStripeId,
          },
        ],
      });

      reconcileRun = reconciliation.reconcile();
      void reconcileRun.catch(() => undefined);
      await bounded(cancellationStarted, 'delete cancellation start');
      deleteRun = admin.deleteOrganization(actorId, orgId);
      void deleteRun.catch(() => undefined);
      await bounded(
        waitForLock(observer, deleteName),
        'admin delete reconciliation lock observation',
      );

      releaseCancellation();
      const [summary, deleted] = await bounded(
        Promise.all([reconcileRun, deleteRun]),
        'reconciliation/admin delete completion',
      );

      expect(summary.duplicatesCancelled).toBe(1);
      expect(deleted).toBe(true);
      expect(cancel).toHaveBeenCalledTimes(1);
      expect(
        await setup.subscription.findUniqueOrThrow({
          where: { id: legacyId },
          select: { status: true, organizationId: true },
        }),
      ).toEqual({ status: 'canceled', organizationId: null });
      expect(
        await setup.subscription.findUniqueOrThrow({
          where: { id: accountId },
          select: { status: true, stripeSubscriptionId: true, userId: true },
        }),
      ).toEqual({
        status: 'active',
        stripeSubscriptionId: winnerStripeId,
        userId,
      });
    } finally {
      releaseCancellation();
      await Promise.allSettled(
        [reconcileRun, deleteRun].filter(
          (operation) => operation !== undefined,
        ),
      );
      await setup.subscription.deleteMany({
        where: { id: { in: [accountId, legacyId] } },
      });
      await setup.organization.deleteMany({ where: { id: orgId } });
      await setup.auditLog.deleteMany({ where: { actorUserId: actorId } });
      await setup.user.deleteMany({
        where: { id: { in: [actorId, userId] } },
      });
      await Promise.all([
        setup.$disconnect(),
        reconcileClient.$disconnect(),
        deleteClient.$disconnect(),
        observer.$disconnect(),
      ]);
    }
  });
});
