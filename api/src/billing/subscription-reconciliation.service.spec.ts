import { MODULE_METADATA } from '@nestjs/common/constants';
import type Stripe from 'stripe';
import type { PrismaService } from '../prisma/prisma.service';
import {
  executeReconciliationCommand,
  ReconciliationCommandModule,
  runReconciliation,
} from '../reconcile-account-subscriptions';
import { ReconciliationLockUnavailableError } from './subscription-reconciliation-lock';
import type { AccountEntitlementsService } from './account-entitlements.service';
import type { ReconciliationRunLock } from './subscription-reconciliation-lock';
import { SubscriptionReconciliationService } from './subscription-reconciliation.service';
import type { StripePriceRegistry } from './stripe-price-registry';

const account = {
  id: 'winner-row',
  userId: 'user-1',
  stripeSubscriptionId: 'sub_winner',
};
const candidate = {
  id: 'legacy-1',
  stripeSubscriptionId: 'sub_legacy',
};
const validSignalItems = {
  data: [
    {
      price: {
        id: 'price_signal',
        recurring: { interval: 'month' },
        unit_amount: 500,
      },
    },
  ],
};

function serviceWith() {
  const subscription = {
    findMany: jest.fn(),
    findUnique: jest.fn(),
    findFirst: jest.fn().mockResolvedValue(null),
    updateMany: jest.fn().mockResolvedValue({ count: 1 }),
  };
  const tx = {
    subscription,
    $queryRaw: jest.fn().mockResolvedValue([]),
  };
  const prisma = {
    subscription: {
      findMany: jest.fn(),
    },
    $transaction: jest.fn(
      (operation: (client: typeof tx) => Promise<unknown>) => operation(tx),
    ),
  };
  const stripe = {
    subscriptions: {
      retrieve: jest.fn<Promise<unknown>, [string]>((id: string) =>
        Promise.resolve(
          id === 'sub_winner'
            ? {
                id,
                status: 'active',
                customer: 'cus_user_1',
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
              }
            : {
                id,
                status: 'active',
                customer: {
                  id: 'cus_legacy_1',
                  deleted: false,
                  metadata: { organizationId: 'org-1' },
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
              },
        ),
      ),
      cancel: jest.fn().mockResolvedValue({ id: 'sub_legacy' }),
    },
    customers: {
      retrieve: jest.fn().mockResolvedValue({
        id: 'cus_user_1',
        deleted: false,
        metadata: { userId: 'user-1' },
      }),
    },
  };
  const entitlements = {
    lockUsers: jest.fn().mockResolvedValue(undefined),
    lockUserRows: jest.fn().mockResolvedValue(undefined),
  };
  const runLock = {
    withLock: jest.fn((operation: () => Promise<unknown>) => operation()),
    withUserLock: jest.fn(
      (_userId: string, operation: () => Promise<unknown>) => operation(),
    ),
  };
  const prices = {
    planForPriceId: jest.fn().mockReturnValue('SIGNAL'),
  };
  const service = new SubscriptionReconciliationService(
    prisma as unknown as PrismaService,
    stripe as unknown as Stripe,
    entitlements as unknown as AccountEntitlementsService,
    runLock as unknown as ReconciliationRunLock,
    prices as unknown as StripePriceRegistry,
  );

  return { service, prisma, tx, stripe, entitlements, runLock, prices };
}

function oneCandidate(
  fixture: ReturnType<typeof serviceWith>,
  organization: {
    id: string;
    creatorUserId: string;
    stripeCustomerId: string | null;
  } = {
    id: 'org-1',
    creatorUserId: 'user-1',
    stripeCustomerId: 'cus_legacy_1',
  },
  winnerOrganization: {
    id: string;
    creatorUserId: string;
    stripeCustomerId: string | null;
  } | null = null,
): void {
  fixture.prisma.subscription.findMany
    .mockResolvedValueOnce([account])
    .mockResolvedValueOnce([candidate]);
  fixture.tx.subscription.findUnique
    .mockResolvedValueOnce({
      ...candidate,
      userId: null,
      status: 'active',
      plan: 'SIGNAL',
      organization,
    })
    .mockResolvedValueOnce({
      stripeSubscriptionId: 'sub_winner',
      plan: 'SIGNAL',
      organization: winnerOrganization,
      user: { stripeCustomerId: 'cus_user_1', billingStateVersion: 7 },
    })
    .mockResolvedValueOnce({
      ...candidate,
      userId: null,
      status: 'active',
      plan: 'SIGNAL',
      organization,
    })
    .mockResolvedValueOnce({
      stripeSubscriptionId: 'sub_winner',
      plan: 'SIGNAL',
      organization: winnerOrganization,
      user: { stripeCustomerId: 'cus_user_1', billingStateVersion: 7 },
    });
}

describe('SubscriptionReconciliationService', () => {
  it('uses the dedicated run lock and short candidate transactions', async () => {
    const fixture = serviceWith();
    oneCandidate(fixture);

    await fixture.service.reconcile();

    expect(fixture.runLock.withLock).toHaveBeenCalledTimes(1);
    expect(fixture.runLock.withUserLock).toHaveBeenCalledWith(
      'user-1',
      expect.any(Function),
    );
    expect(fixture.entitlements.lockUsers).not.toHaveBeenCalled();
    expect(fixture.prisma.$transaction).toHaveBeenCalledWith(
      expect.any(Function),
      { maxWait: 5_000, timeout: 10_000 },
    );
  });

  it('performs no Stripe network call while a Prisma transaction callback is active', async () => {
    const fixture = serviceWith();
    oneCandidate(fixture);
    let transactionActive = false;
    fixture.prisma.$transaction.mockImplementation(
      async (operation: (client: typeof fixture.tx) => Promise<unknown>) => {
        transactionActive = true;
        try {
          return await operation(fixture.tx);
        } finally {
          transactionActive = false;
        }
      },
    );
    fixture.stripe.subscriptions.retrieve.mockImplementation((id: string) => {
      expect(transactionActive).toBe(false);
      return Promise.resolve(
        id === 'sub_winner'
          ? {
              id,
              status: 'active',
              customer: 'cus_user_1',
              items: validSignalItems,
            }
          : {
              id,
              status: 'active',
              customer: {
                id: 'cus_legacy_1',
                deleted: false,
                metadata: { organizationId: 'org-1' },
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
            },
      );
    });
    fixture.stripe.customers.retrieve.mockImplementation(() => {
      expect(transactionActive).toBe(false);
      return Promise.resolve({
        id: 'cus_user_1',
        deleted: false,
        metadata: { userId: 'user-1' },
      });
    });
    fixture.stripe.subscriptions.cancel.mockImplementation(() => {
      expect(transactionActive).toBe(false);
      return Promise.resolve({ id: 'sub_legacy' });
    });

    await fixture.service.reconcile();
  });

  it('skips a normal SOLO account with no live paid legacy duplicates', async () => {
    const fixture = serviceWith();
    fixture.prisma.subscription.findMany
      .mockResolvedValueOnce([{ ...account, stripeSubscriptionId: null }])
      .mockResolvedValueOnce([]);

    await expect(fixture.service.reconcile()).resolves.toEqual({
      usersScanned: 1,
      duplicatesCancelled: 0,
      alreadyGone: 0,
      failures: [],
    });
    expect(fixture.stripe.subscriptions.retrieve).not.toHaveBeenCalled();
    expect(fixture.stripe.subscriptions.cancel).not.toHaveBeenCalled();
  });

  it('fails safely when paid duplicates exist but no winner is persisted', async () => {
    const fixture = serviceWith();
    fixture.prisma.subscription.findMany
      .mockResolvedValueOnce([{ ...account, stripeSubscriptionId: null }])
      .mockResolvedValueOnce([candidate]);

    const summary = await fixture.service.reconcile();

    expect(summary.failures).toEqual([
      {
        subscriptionId: 'winner-row',
        message: 'Account winner Stripe subscription is unresolved',
      },
    ]);
    expect(fixture.stripe.subscriptions.cancel).not.toHaveBeenCalled();
  });

  it.each([
    [
      'missing',
      Promise.reject(
        Object.assign(new Error('missing'), { code: 'resource_missing' }),
      ),
    ],
    [
      'canceled',
      Promise.resolve({
        id: 'sub_winner',
        status: 'canceled',
        customer: 'cus_user_1',
        items: { data: [{ price: { id: 'price_signal' } }] },
      }),
    ],
    [
      'wrong id',
      Promise.resolve({
        id: 'sub_other',
        status: 'active',
        customer: 'cus_user_1',
        items: { data: [{ price: { id: 'price_signal' } }] },
      }),
    ],
    [
      'wrong customer',
      Promise.resolve({
        id: 'sub_winner',
        status: 'active',
        customer: 'cus_other',
        items: { data: [{ price: { id: 'price_signal' } }] },
      }),
    ],
  ])('fails safely for a %s authoritative winner', async (_label, result) => {
    const fixture = serviceWith();
    oneCandidate(fixture);
    fixture.stripe.subscriptions.retrieve.mockReturnValue(result);

    const summary = await fixture.service.reconcile();

    expect(summary.failures).toEqual([
      {
        subscriptionId: 'legacy-1',
        message:
          'Account winner verification failed; no duplicate was canceled',
      },
    ]);
    expect(fixture.stripe.subscriptions.cancel).not.toHaveBeenCalled();
    expect(fixture.tx.subscription.updateMany).not.toHaveBeenCalled();
  });

  it('fails safely when customer metadata belongs to another user', async () => {
    const fixture = serviceWith();
    oneCandidate(fixture);
    fixture.stripe.customers.retrieve.mockResolvedValue({
      id: 'cus_user_1',
      deleted: false,
      metadata: { userId: 'user-2' },
    });

    const summary = await fixture.service.reconcile();

    expect(summary.failures).toHaveLength(1);
    expect(fixture.stripe.subscriptions.cancel).not.toHaveBeenCalled();
  });

  it('accepts a migrated winner through the complete legacy organization chain', async () => {
    const fixture = serviceWith();
    oneCandidate(fixture, undefined, {
      id: 'winner-org',
      creatorUserId: 'user-1',
      stripeCustomerId: 'cus_user_1',
    });
    fixture.stripe.customers.retrieve.mockResolvedValue({
      id: 'cus_user_1',
      deleted: false,
      metadata: { organizationId: 'winner-org' },
    });

    await expect(fixture.service.reconcile()).resolves.toEqual({
      usersScanned: 1,
      duplicatesCancelled: 1,
      alreadyGone: 0,
      failures: [],
    });
    expect(fixture.stripe.subscriptions.cancel).toHaveBeenCalledTimes(1);
  });

  it.each([
    [
      'wrong organization metadata',
      {
        id: 'winner-org',
        creatorUserId: 'user-1',
        stripeCustomerId: 'cus_user_1',
      },
      { organizationId: 'other-org' },
    ],
    [
      'wrong organization creator',
      {
        id: 'winner-org',
        creatorUserId: 'user-2',
        stripeCustomerId: 'cus_user_1',
      },
      { organizationId: 'winner-org' },
    ],
    [
      'wrong organization customer',
      {
        id: 'winner-org',
        creatorUserId: 'user-1',
        stripeCustomerId: 'cus_other',
      },
      { organizationId: 'winner-org' },
    ],
  ])(
    'rejects a migrated winner with %s',
    async (_label, winnerOrganization, metadata) => {
      const fixture = serviceWith();
      oneCandidate(fixture, undefined, winnerOrganization);
      fixture.stripe.customers.retrieve.mockResolvedValue({
        id: 'cus_user_1',
        deleted: false,
        metadata,
      });

      const summary = await fixture.service.reconcile();

      expect(summary.failures).toEqual([
        {
          subscriptionId: 'legacy-1',
          message:
            'Account winner verification failed; no duplicate was canceled',
        },
      ]);
      expect(fixture.stripe.subscriptions.cancel).not.toHaveBeenCalled();
      expect(fixture.tx.subscription.updateMany).not.toHaveBeenCalled();
    },
  );

  it.each([
    ['empty', undefined, 'SIGNAL'],
    [
      'zero-priced',
      {
        id: 'price_signal',
        recurring: { interval: 'month' },
        unit_amount: 0,
      },
      'SIGNAL',
    ],
    [
      'unknown',
      {
        id: 'price_unknown',
        recurring: { interval: 'month' },
        unit_amount: 500,
      },
      null,
    ],
    [
      'one-time',
      { id: 'price_signal', recurring: null, unit_amount: 500 },
      'SIGNAL',
    ],
    [
      'persisted-plan mismatch',
      {
        id: 'price_fleet',
        recurring: { interval: 'month' },
        unit_amount: 2_000,
      },
      'FLEET',
    ],
  ])(
    'fails safely for a %s winner price',
    async (_label, price, recognizedPlan) => {
      const fixture = serviceWith();
      oneCandidate(fixture);
      fixture.prices.planForPriceId.mockReturnValue(recognizedPlan);
      fixture.stripe.subscriptions.retrieve.mockImplementation((id: string) =>
        Promise.resolve(
          id === 'sub_winner'
            ? {
                id,
                status: 'active',
                customer: 'cus_user_1',
                items: { data: price ? [{ price }] : [] },
              }
            : {
                id,
                status: 'active',
                customer: {
                  id: 'cus_legacy_1',
                  deleted: false,
                  metadata: { organizationId: 'org-1' },
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
              },
        ),
      );

      const summary = await fixture.service.reconcile();

      expect(summary.failures).toEqual([
        {
          subscriptionId: 'legacy-1',
          message:
            'Account winner verification failed; no duplicate was canceled',
        },
      ]);
      expect(fixture.stripe.subscriptions.cancel).not.toHaveBeenCalled();
      expect(fixture.tx.subscription.updateMany).not.toHaveBeenCalled();
    },
  );

  it('fails safely when the locked legacy organization has no expected customer', async () => {
    const fixture = serviceWith();
    oneCandidate(fixture, {
      id: 'org-1',
      creatorUserId: 'user-1',
      stripeCustomerId: null,
    });

    const summary = await fixture.service.reconcile();

    expect(summary.failures).toEqual([
      {
        subscriptionId: 'legacy-1',
        message:
          'Legacy candidate verification failed; no duplicate was canceled',
      },
    ]);
    expect(fixture.stripe.subscriptions.cancel).not.toHaveBeenCalled();
    expect(fixture.tx.subscription.updateMany).not.toHaveBeenCalled();
  });

  it.each([
    [
      'wrong customer',
      {
        id: 'sub_legacy',
        status: 'active',
        customer: {
          id: 'cus_other',
          deleted: false,
          metadata: { organizationId: 'org-1' },
        },
        items: { data: [{ price: { id: 'price_signal' } }] },
      },
    ],
    [
      'wrong organization metadata',
      {
        id: 'sub_legacy',
        status: 'active',
        customer: {
          id: 'cus_legacy_1',
          deleted: false,
          metadata: { organizationId: 'org-other' },
        },
        items: { data: [{ price: { id: 'price_signal' } }] },
      },
    ],
    [
      'missing paid price',
      {
        id: 'sub_legacy',
        status: 'active',
        customer: {
          id: 'cus_legacy_1',
          deleted: false,
          metadata: { organizationId: 'org-1' },
        },
        items: { data: [] },
      },
    ],
  ])('fails safely for a %s legacy candidate', async (_label, result) => {
    const fixture = serviceWith();
    oneCandidate(fixture);
    fixture.stripe.subscriptions.retrieve.mockImplementation((id: string) =>
      id === 'sub_winner'
        ? Promise.resolve({
            id,
            status: 'active',
            customer: 'cus_user_1',
            items: validSignalItems,
          })
        : result instanceof Error
          ? Promise.reject(result)
          : Promise.resolve(result),
    );

    const summary = await fixture.service.reconcile();

    expect(summary.failures).toEqual([
      {
        subscriptionId: 'legacy-1',
        message:
          'Legacy candidate verification failed; no duplicate was canceled',
      },
    ]);
    expect(fixture.stripe.subscriptions.cancel).not.toHaveBeenCalled();
    expect(fixture.tx.subscription.updateMany).not.toHaveBeenCalled();
  });

  it.each([
    [
      'resource-missing',
      Object.assign(new Error('missing'), { code: 'resource_missing' }),
    ],
    [
      'terminal canceled',
      {
        id: 'sub_legacy',
        status: 'canceled',
        customer: null,
        items: { data: [] },
      },
    ],
    [
      'terminal incomplete-expired',
      {
        id: 'sub_legacy',
        status: 'incomplete_expired',
        customer: null,
        items: { data: [] },
      },
    ],
  ])(
    'checkpoints a %s candidate as already gone after winner verification',
    async (_label, result) => {
      const fixture = serviceWith();
      oneCandidate(fixture);
      fixture.stripe.subscriptions.retrieve.mockImplementation((id: string) =>
        id === 'sub_winner'
          ? Promise.resolve({
              id,
              status: 'active',
              customer: 'cus_user_1',
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
            })
          : result instanceof Error
            ? Promise.reject(result)
            : Promise.resolve(result),
      );

      await expect(fixture.service.reconcile()).resolves.toEqual({
        usersScanned: 1,
        duplicatesCancelled: 0,
        alreadyGone: 1,
        failures: [],
      });
      expect(fixture.stripe.subscriptions.cancel).not.toHaveBeenCalled();
      expect(fixture.tx.subscription.updateMany).toHaveBeenCalledTimes(1);
      expect(fixture.stripe.subscriptions.retrieve).toHaveBeenNthCalledWith(
        1,
        'sub_winner',
        {},
        { maxNetworkRetries: 0, timeout: 5_000 },
      );
    },
  );

  it('does not accept a terminal response for an unrelated candidate id', async () => {
    const fixture = serviceWith();
    oneCandidate(fixture);
    fixture.stripe.subscriptions.retrieve.mockImplementation((id: string) =>
      Promise.resolve(
        id === 'sub_winner'
          ? {
              id,
              status: 'active',
              customer: 'cus_user_1',
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
            }
          : {
              id: 'sub_unrelated',
              status: 'canceled',
              customer: null,
              items: { data: [] },
            },
      ),
    );

    const summary = await fixture.service.reconcile();

    expect(summary.failures).toHaveLength(1);
    expect(fixture.stripe.subscriptions.cancel).not.toHaveBeenCalled();
    expect(fixture.tx.subscription.updateMany).not.toHaveBeenCalled();
  });

  it.each([
    [
      'zero-priced',
      {
        id: 'price_signal',
        recurring: { interval: 'month' },
        unit_amount: 0,
      },
      'SIGNAL',
    ],
    [
      'one-time',
      {
        id: 'price_signal',
        recurring: null,
        unit_amount: 500,
      },
      'SIGNAL',
    ],
    [
      'unrelated',
      {
        id: 'price_unrelated',
        recurring: { interval: 'month' },
        unit_amount: 500,
      },
      null,
    ],
    [
      'persisted-plan mismatch',
      {
        id: 'price_fleet',
        recurring: { interval: 'month' },
        unit_amount: 2_000,
      },
      'FLEET',
    ],
  ])(
    'fails safely for a %s candidate price',
    async (_label, price, recognizedPlan) => {
      const fixture = serviceWith();
      oneCandidate(fixture);
      fixture.prices.planForPriceId.mockImplementation((priceId: string) =>
        priceId === 'price_signal' ? 'SIGNAL' : recognizedPlan,
      );
      fixture.stripe.subscriptions.retrieve.mockImplementation((id: string) =>
        Promise.resolve(
          id === 'sub_winner'
            ? {
                id,
                status: 'active',
                customer: 'cus_user_1',
                items: validSignalItems,
              }
            : {
                id,
                status: 'active',
                customer: {
                  id: 'cus_legacy_1',
                  deleted: false,
                  metadata: { organizationId: 'org-1' },
                },
                items: { data: [{ price }] },
              },
        ),
      );

      const summary = await fixture.service.reconcile();

      expect(summary.failures).toEqual([
        {
          subscriptionId: 'legacy-1',
          message:
            'Legacy candidate verification failed; no duplicate was canceled',
        },
      ]);
      expect(fixture.stripe.subscriptions.cancel).not.toHaveBeenCalled();
      expect(fixture.tx.subscription.updateMany).not.toHaveBeenCalled();
    },
  );

  it('locks user then candidate, verifies the winner, cancels, and checkpoints', async () => {
    const fixture = serviceWith();
    oneCandidate(fixture);

    await expect(fixture.service.reconcile()).resolves.toEqual({
      usersScanned: 1,
      duplicatesCancelled: 1,
      alreadyGone: 0,
      failures: [],
    });

    expect(
      fixture.entitlements.lockUserRows.mock.invocationCallOrder[0],
    ).toBeLessThan(fixture.tx.$queryRaw.mock.invocationCallOrder[0]);
    expect(
      fixture.stripe.subscriptions.retrieve.mock.invocationCallOrder[0],
    ).toBeLessThan(
      fixture.stripe.subscriptions.cancel.mock.invocationCallOrder[0],
    );
    expect(fixture.stripe.subscriptions.retrieve).toHaveBeenCalledWith(
      'sub_winner',
      {},
      { maxNetworkRetries: 0, timeout: 5_000 },
    );
    expect(fixture.stripe.customers.retrieve).toHaveBeenCalledWith(
      'cus_user_1',
      {},
      { maxNetworkRetries: 0, timeout: 5_000 },
    );
    expect(fixture.stripe.subscriptions.retrieve).toHaveBeenCalledWith(
      'sub_legacy',
      { expand: ['customer'] },
      { maxNetworkRetries: 0, timeout: 5_000 },
    );
    expect(fixture.stripe.subscriptions.cancel).toHaveBeenCalledWith(
      'sub_legacy',
      {},
      { maxNetworkRetries: 0, timeout: 5_000 },
    );
    expect(
      fixture.stripe.subscriptions.cancel.mock.invocationCallOrder[0],
    ).toBeLessThan(
      fixture.tx.subscription.updateMany.mock.invocationCallOrder[0],
    );
  });

  it('sanitizes cancellation failures and leaves the row retryable', async () => {
    const fixture = serviceWith();
    oneCandidate(fixture);
    fixture.stripe.subscriptions.cancel.mockRejectedValue({
      message: 'sk_live_secret',
    });

    const summary = await fixture.service.reconcile();

    expect(summary.failures).toEqual([
      {
        subscriptionId: 'legacy-1',
        message: 'Stripe cancellation failed; retry required',
      },
    ]);
    expect(fixture.tx.subscription.updateMany).not.toHaveBeenCalled();
  });

  it('scans account winners in ascending user-id keyset order', async () => {
    const fixture = serviceWith();
    const page = Array.from({ length: 100 }, (_, index) => ({
      ...account,
      id: `winner-${index}`,
      userId: `user-${String(index).padStart(3, '0')}`,
    }));
    fixture.prisma.subscription.findMany
      .mockResolvedValueOnce(page)
      .mockResolvedValueOnce([]);
    for (let index = 0; index < page.length; index += 1) {
      fixture.prisma.subscription.findMany.mockResolvedValueOnce([]);
    }

    await fixture.service.reconcile();

    expect(fixture.prisma.subscription.findMany).toHaveBeenLastCalledWith(
      expect.objectContaining({
        where: { userId: { not: null, gt: 'user-099' } },
        orderBy: { userId: 'asc' },
      }),
    );
  });
});

describe('runReconciliation', () => {
  const originalExitCode = process.exitCode;

  afterEach(() => {
    process.exitCode = originalExitCode;
    jest.restoreAllMocks();
  });

  it('prints a structured summary, sets failure exit code, and closes', async () => {
    const summary = {
      usersScanned: 1,
      duplicatesCancelled: 0,
      alreadyGone: 0,
      failures: [{ subscriptionId: 'row', message: 'sanitized' }],
    };
    const close = jest.fn().mockResolvedValue(undefined);
    const output = jest.spyOn(console, 'log').mockImplementation();

    await runReconciliation(() =>
      Promise.resolve({
        get: jest.fn().mockReturnValue({
          reconcile: jest.fn().mockResolvedValue(summary),
        }),
        close,
      }),
    );

    expect(output).toHaveBeenCalledWith(JSON.stringify(summary));
    expect(process.exitCode).toBe(1);
    expect(close).toHaveBeenCalledTimes(1);
  });

  it('keeps the command module minimal', () => {
    const imports = Reflect.getMetadata(
      MODULE_METADATA.IMPORTS,
      ReconciliationCommandModule,
    ) as unknown[];
    const providers = Reflect.getMetadata(
      MODULE_METADATA.PROVIDERS,
      ReconciliationCommandModule,
    ) as unknown[];
    expect(imports).toHaveLength(2);
    expect(providers).toHaveLength(5);
  });

  it('prints a sanitized lock-timeout failure and exits nonzero', async () => {
    const output = jest.spyOn(console, 'error').mockImplementation();

    await executeReconciliationCommand(() =>
      Promise.reject(new ReconciliationLockUnavailableError()),
    );

    expect(process.exitCode).toBe(1);
    expect(output).toHaveBeenCalledWith(
      JSON.stringify({
        error: 'Account subscription reconciliation is already running',
      }),
    );
  });
});
