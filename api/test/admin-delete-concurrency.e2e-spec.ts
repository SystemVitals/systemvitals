import { execFileSync } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import { resolve } from 'node:path';
import { BadRequestException } from '@nestjs/common';
import { PrismaClient } from '@systemvitals/database';
import { AdminService } from '../src/admin/admin.service';
import { AccountEntitlementsService } from '../src/billing/account-entitlements.service';
import { BillingService } from '../src/billing/billing.service';
import type { StripePriceRegistry } from '../src/billing/stripe-price-registry';
import type { PrismaService } from '../src/prisma/prisma.service';

const TIMEOUT_MS = 8_000;
const sourceUrl = process.env.DATABASE_URL;
if (!sourceUrl) throw new Error('DATABASE_URL is required');

const databaseDir = resolve(__dirname, '../../database');
const databaseName = `systemvitals_admin_delete_${randomUUID().replaceAll('-', '')}`;
if (!/^[a-z][a-z0-9_]+$/.test(databaseName)) {
  throw new Error(`Unsafe temporary database name: ${databaseName}`);
}
const adminUrl = new URL(sourceUrl);
adminUrl.search = '';
const testUrl = new URL(sourceUrl);
testUrl.pathname = `/${databaseName}`;
testUrl.searchParams.set('schema', 'public');

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

function admin(prisma: PrismaClient): AdminService {
  return new AdminService(
    prisma as unknown as PrismaService,
    {} as never,
    new AccountEntitlementsService(prisma as unknown as PrismaService),
  );
}

function billing(prisma: PrismaClient, stripe: unknown): BillingService {
  const prices = {
    priceIdFor: () => 'price_signal',
    planForPriceId: () => 'SIGNAL',
  } as unknown as StripePriceRegistry;
  return new BillingService(
    stripe as never,
    prisma as unknown as PrismaService,
    prices,
    new AccountEntitlementsService(prisma as unknown as PrismaService),
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
    await new Promise((resolveDelay) => setTimeout(resolveDelay, 10));
  }
  throw new Error(`${applicationName} did not contend on a row lock`);
}

async function holdUserLock(
  prisma: PrismaClient,
  userId: string,
  acquired: () => void,
  release: Promise<void>,
): Promise<void> {
  await prisma.$transaction(
    async (tx) => {
      await tx.$queryRaw`SELECT id FROM users WHERE id = ${userId} FOR UPDATE`;
      acquired();
      await release;
    },
    { timeout: TIMEOUT_MS },
  );
}

function stripeFixture(activeSubscription = false, suffix = '') {
  const customerCreate = jest.fn().mockResolvedValue({
    id: `cus_created${suffix}`,
  });
  const checkoutCreate = jest.fn().mockResolvedValue({
    id: 'cs_created',
    url: 'https://stripe.test/checkout',
    expires_at: null,
  });
  return {
    checkoutCreate,
    customerCreate,
    stripe: {
      customers: { create: customerCreate },
      subscriptions: {
        list: () => ({
          autoPagingToArray: () =>
            Promise.resolve(
              activeSubscription
                ? [
                    {
                      id: `sub_active${suffix}`,
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
          create: checkoutCreate,
          expire: jest.fn(),
        },
      },
      billingPortal: {
        sessions: {
          create: jest
            .fn()
            .mockResolvedValue({ url: 'https://stripe.test/portal' }),
        },
      },
    },
  };
}

describe('admin account deletion concurrency (fresh PostgreSQL database)', () => {
  beforeAll(() => {
    try {
      sql(`CREATE DATABASE "${databaseName}"`);
      run('npx', ['prisma', 'migrate', 'deploy'], {
        DATABASE_URL: testUrl.toString(),
      });
    } catch (error) {
      sql(`DROP DATABASE IF EXISTS "${databaseName}" WITH (FORCE)`);
      throw error;
    }
  }, 30_000);

  afterAll(() => {
    sql(`DROP DATABASE IF EXISTS "${databaseName}" WITH (FORCE)`);
  });

  it.each([
    [
      'unresolved attempt',
      {
        checkoutAttemptId: 'attempt_pending',
        checkoutAttemptPlan: 'SIGNAL' as const,
        checkoutAttemptInterval: 'month',
        checkoutAttemptCreatedAt: new Date(),
      },
    ],
    [
      'known open session',
      {
        checkoutAttemptId: 'attempt_open',
        checkoutAttemptPlan: 'SIGNAL' as const,
        checkoutAttemptInterval: 'month',
        checkoutAttemptCreatedAt: new Date(),
        checkoutSessionId: 'cs_open',
        checkoutSessionUrl: 'https://stripe.test/open',
      },
    ],
  ])('blocks a persisted %s without audit', async (_label, checkoutState) => {
    const prisma = client(`admin-delete-state-${String(_label)}`);
    try {
      const [actor, target] = await Promise.all([
        prisma.user.create({
          data: {
            email: `actor-${String(_label)}@example.com`,
            passwordHash: 'unused',
          },
        }),
        prisma.user.create({
          data: {
            email: `target-${String(_label)}@example.com`,
            passwordHash: 'unused',
            ...checkoutState,
          },
        }),
      ]);

      await expect(
        admin(prisma).deleteUser(actor.id, target.id),
      ).rejects.toThrow(
        new BadRequestException(
          'Resolve account checkout before deleting this account',
        ),
      );
      await expect(
        prisma.auditLog.count({
          where: { action: 'user.delete', targetId: target.id },
        }),
      ).resolves.toBe(0);
    } finally {
      await prisma.$disconnect();
    }
  });

  it('blocks deletion while normalized cleanup intents are queued', async () => {
    const prisma = client('admin-delete-cleanup-intent');
    try {
      const [actor, target] = await Promise.all([
        prisma.user.create({
          data: {
            email: 'actor-cleanup-intent@example.com',
            passwordHash: 'unused',
          },
        }),
        prisma.user.create({
          data: {
            email: 'target-cleanup-intent@example.com',
            passwordHash: 'unused',
          },
        }),
      ]);
      await prisma.checkoutCleanupIntent.create({
        data: { userId: target.id, stripeSessionId: 'cs_delete_blocked' },
      });

      await expect(
        admin(prisma).deleteUser(actor.id, target.id),
      ).rejects.toThrow(
        'Resolve account checkout before deleting this account',
      );
      await expect(
        prisma.user.findUnique({ where: { id: target.id } }),
      ).resolves.not.toBeNull();
    } finally {
      await prisma.$disconnect();
    }
  });

  it('keeps deletion blocked across delayed checkout, webhook clear, and cleanup queueing', async () => {
    const setup = client('admin-delete-three-way-setup');
    const checkoutClient = client('admin-delete-three-way-checkout');
    const webhookClient = client('admin-delete-three-way-webhook');
    const deletionClient = client('admin-delete-three-way-deletion');
    let releaseCreate!: () => void;
    const createReleased = new Promise<void>((resolve) => {
      releaseCreate = resolve;
    });
    let markCreateEntered!: () => void;
    const createEntered = new Promise<void>((resolve) => {
      markCreateEntered = resolve;
    });
    let subscriptionActive = false;
    const session = {
      id: 'cs_three_way',
      created: 1,
      metadata: {} as Record<string, string>,
      mode: 'subscription',
      status: 'open',
      url: 'https://stripe.test/three-way',
      expires_at: null,
    };
    const stripe = {
      subscriptions: {
        list: () => ({
          autoPagingToArray: () =>
            Promise.resolve(
              subscriptionActive
                ? [
                    {
                      id: 'sub_three_way',
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
            session.metadata = input.metadata;
            markCreateEntered();
            await createReleased;
            return session;
          },
          retrieve: () => Promise.resolve(session),
          expire: () => Promise.reject(new Error('ambiguous expiry timeout')),
        },
      },
    };
    try {
      const [actor, target] = await Promise.all([
        setup.user.create({
          data: {
            email: 'actor-three-way@example.com',
            passwordHash: 'unused',
          },
        }),
        setup.user.create({
          data: {
            email: 'target-three-way@example.com',
            passwordHash: 'unused',
            stripeCustomerId: 'cus_three_way',
          },
        }),
      ]);
      await Promise.all([
        checkoutClient.$connect(),
        webhookClient.$connect(),
        deletionClient.$connect(),
      ]);
      const checkout = billing(checkoutClient, stripe).createCheckout(
        target.id,
        'SIGNAL',
      );
      void checkout.catch(() => undefined);
      await bounded(createEntered, 'three-way checkout create');
      await expect(
        setup.checkoutOperation.count({ where: { userId: target.id } }),
      ).resolves.toBe(1);

      subscriptionActive = true;
      await billing(webhookClient, stripe).applySubscriptionEvent(
        'cus_three_way',
      );
      await expect(
        admin(deletionClient).deleteUser(actor.id, target.id),
      ).rejects.toThrow(
        'Resolve account checkout before deleting this account',
      );

      releaseCreate();
      await expect(
        bounded(checkout, 'three-way checkout settle'),
      ).rejects.toThrow('ambiguous expiry timeout');
      await expect(
        setup.user.findUniqueOrThrow({ where: { id: target.id } }),
      ).resolves.toMatchObject({
        checkoutAttemptId: null,
      });
      await expect(
        setup.checkoutOperation.count({ where: { userId: target.id } }),
      ).resolves.toBe(0);
      await expect(
        setup.checkoutCleanupIntent.count({ where: { userId: target.id } }),
      ).resolves.toBe(1);
      await expect(
        admin(deletionClient).deleteUser(actor.id, target.id),
      ).rejects.toThrow(
        'Resolve account checkout before deleting this account',
      );
    } finally {
      releaseCreate();
      await Promise.allSettled([
        checkoutClient.$disconnect(),
        webhookClient.$disconnect(),
        deletionClient.$disconnect(),
        setup.$disconnect(),
      ]);
    }
  });

  it.each(['delete', 'checkout'] as const)(
    'serializes deletion racing checkout with %s winning',
    async (winner) => {
      const names = {
        blocker: `admin-delete-${winner}-blocker`,
        deletion: `admin-delete-${winner}-deletion`,
        checkout: `admin-delete-${winner}-checkout`,
        observer: `admin-delete-${winner}-observer`,
      };
      const setup = client(`admin-delete-${winner}-setup`);
      const blocker = client(names.blocker);
      const deletionClient = client(names.deletion);
      const checkoutClient = client(names.checkout);
      const observer = client(names.observer);
      let releaseLock!: () => void;
      const release = new Promise<void>((resolveRelease) => {
        releaseLock = resolveRelease;
      });
      let markAcquired!: () => void;
      const acquired = new Promise<void>((resolveAcquired) => {
        markAcquired = resolveAcquired;
      });
      const stripe = stripeFixture();
      try {
        const actor = await setup.user.create({
          data: {
            email: `actor-race-${winner}@example.com`,
            passwordHash: 'unused',
          },
        });
        const target = await setup.user.create({
          data: {
            email: `target-race-${winner}@example.com`,
            passwordHash: 'unused',
          },
        });
        await Promise.all([
          blocker.$connect(),
          deletionClient.$connect(),
          checkoutClient.$connect(),
          observer.$connect(),
        ]);
        const held = holdUserLock(blocker, target.id, markAcquired, release);
        await bounded(acquired, 'blocker acquisition');

        let deletion: Promise<boolean>;
        let checkout: Promise<{ url: string }>;
        if (winner === 'delete') {
          deletion = admin(deletionClient).deleteUser(actor.id, target.id);
          void deletion.catch(() => undefined);
          await waitForLock(observer, names.deletion);
          checkout = billing(checkoutClient, stripe.stripe).createCheckout(
            target.id,
            'SIGNAL',
          );
          void checkout.catch(() => undefined);
        } else {
          checkout = billing(checkoutClient, stripe.stripe).createCheckout(
            target.id,
            'SIGNAL',
          );
          void checkout.catch(() => undefined);
          await waitForLock(observer, names.checkout);
          deletion = admin(deletionClient).deleteUser(actor.id, target.id);
          void deletion.catch(() => undefined);
        }
        releaseLock();
        await bounded(held, 'blocker release');

        if (winner === 'delete') {
          await expect(bounded(deletion, 'winning deletion')).resolves.toBe(
            true,
          );
          await expect(bounded(checkout, 'losing checkout')).rejects.toThrow();
          expect(stripe.checkoutCreate).not.toHaveBeenCalled();
          expect(stripe.customerCreate).not.toHaveBeenCalled();
        } else {
          await expect(bounded(checkout, 'winning checkout')).resolves.toEqual({
            url: 'https://stripe.test/checkout',
          });
          await expect(bounded(deletion, 'losing deletion')).rejects.toThrow(
            'Resolve account checkout before deleting this account',
          );
          expect(stripe.checkoutCreate).toHaveBeenCalledTimes(1);
          expect(stripe.customerCreate).toHaveBeenCalledTimes(1);
        }
      } finally {
        releaseLock();
        await Promise.allSettled([
          blocker.$disconnect(),
          deletionClient.$disconnect(),
          checkoutClient.$disconnect(),
          observer.$disconnect(),
          setup.$disconnect(),
        ]);
      }
    },
  );

  it('allows deletion after a billing entry reconciles an expired operation with no Stripe session', async () => {
    const setup = client('admin-delete-expired-operation');
    const { stripe } = stripeFixture();
    try {
      const [actor, target] = await Promise.all([
        setup.user.create({
          data: { email: 'actor-expired-op@example.com', passwordHash: 'x' },
        }),
        setup.user.create({
          data: {
            email: 'target-expired-op@example.com',
            passwordHash: 'x',
            stripeCustomerId: 'cus_expired_operation',
            subscription: {
              create: { plan: 'SIGNAL', status: 'active' },
            },
          },
        }),
      ]);
      await setup.checkoutOperation.create({
        data: {
          id: '00000000-0000-4000-8000-000000000010',
          userId: target.id,
          attemptId: 'attempt_crashed_without_session',
          requestedPlan: 'SIGNAL',
          interval: 'month',
          leaseExpiresAt: new Date(Date.now() - 1_000),
          createdAt: new Date(Date.now() - 25 * 60 * 60 * 1000),
        },
      });

      await expect(
        admin(setup).deleteUser(actor.id, target.id),
      ).rejects.toThrow(
        'Resolve account checkout before deleting this account',
      );
      await expect(
        billing(setup, stripe).createPortal(target.id),
      ).resolves.toEqual({ url: 'https://stripe.test/portal' });
      await expect(
        setup.checkoutOperation.count({ where: { userId: target.id } }),
      ).resolves.toBe(0);
      await setup.subscription.update({
        where: { userId: target.id },
        data: {
          plan: 'SOLO',
          status: 'canceled',
          stripeSubscriptionId: null,
        },
      });
      await expect(admin(setup).deleteUser(actor.id, target.id)).resolves.toBe(
        true,
      );
    } finally {
      await setup.$disconnect();
    }
  });

  it.each(['delete', 'webhook'] as const)(
    'blocks deletion on pending or active billing when %s reaches the lock first',
    async (winner) => {
      const names = {
        blocker: `admin-delete-webhook-${winner}-blocker`,
        deletion: `admin-delete-webhook-${winner}-deletion`,
        webhook: `admin-delete-webhook-${winner}-webhook`,
        observer: `admin-delete-webhook-${winner}-observer`,
      };
      const setup = client(`admin-delete-webhook-${winner}-setup`);
      const blocker = client(names.blocker);
      const deletionClient = client(names.deletion);
      const webhookClient = client(names.webhook);
      const observer = client(names.observer);
      let releaseLock!: () => void;
      const release = new Promise<void>((resolveRelease) => {
        releaseLock = resolveRelease;
      });
      let markAcquired!: () => void;
      const acquired = new Promise<void>((resolveAcquired) => {
        markAcquired = resolveAcquired;
      });
      const stripe = stripeFixture(true, `_${winner}`);
      try {
        const actor = await setup.user.create({
          data: {
            email: `actor-webhook-${winner}@example.com`,
            passwordHash: 'unused',
          },
        });
        const target = await setup.user.create({
          data: {
            email: `target-webhook-${winner}@example.com`,
            passwordHash: 'unused',
            stripeCustomerId: `cus_webhook_${winner}`,
            checkoutAttemptId: `attempt_webhook_${winner}`,
            checkoutAttemptPlan: 'SIGNAL',
            checkoutAttemptInterval: 'month',
            checkoutAttemptCreatedAt: new Date(),
          },
        });
        await Promise.all([
          blocker.$connect(),
          deletionClient.$connect(),
          webhookClient.$connect(),
          observer.$connect(),
        ]);
        const held = holdUserLock(blocker, target.id, markAcquired, release);
        await bounded(acquired, 'webhook blocker acquisition');

        let deletion: Promise<boolean>;
        let webhook: Promise<void>;
        if (winner === 'delete') {
          deletion = admin(deletionClient).deleteUser(actor.id, target.id);
          void deletion.catch(() => undefined);
          await waitForLock(observer, names.deletion);
          webhook = billing(
            webhookClient,
            stripe.stripe,
          ).applySubscriptionEvent(target.stripeCustomerId!);
          void webhook.catch(() => undefined);
          releaseLock();
          await bounded(held, 'webhook blocker release');
        } else {
          webhook = billing(
            webhookClient,
            stripe.stripe,
          ).applySubscriptionEvent(target.stripeCustomerId!);
          void webhook.catch(() => undefined);
          await waitForLock(observer, names.webhook);
          releaseLock();
          await bounded(held, 'webhook blocker release');
          await bounded(webhook, 'winning webhook');
          deletion = admin(deletionClient).deleteUser(actor.id, target.id);
          void deletion.catch(() => undefined);
        }

        await expect(bounded(deletion, 'blocked deletion')).rejects.toThrow(
          winner === 'delete'
            ? 'Resolve account checkout before deleting this account'
            : 'Cancel account billing before deleting this account',
        );
        await expect(
          bounded(webhook, 'serialized webhook'),
        ).resolves.toBeUndefined();
        await expect(
          setup.subscription.findUnique({ where: { userId: target.id } }),
        ).resolves.toMatchObject({
          plan: 'SIGNAL',
          status: 'active',
          stripeSubscriptionId: `sub_active_${winner}`,
        });
        await expect(
          setup.auditLog.count({
            where: { action: 'user.delete', targetId: target.id },
          }),
        ).resolves.toBe(0);
      } finally {
        releaseLock();
        await Promise.allSettled([
          blocker.$disconnect(),
          deletionClient.$disconnect(),
          webhookClient.$disconnect(),
          observer.$disconnect(),
          setup.$disconnect(),
        ]);
      }
    },
  );
});
