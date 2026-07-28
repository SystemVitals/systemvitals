import type Stripe from 'stripe';
import { BillingService } from './billing.service';
import type { PrismaService } from '../prisma/prisma.service';
import type { StripePriceRegistry } from './stripe-price-registry';
import type { AccountEntitlementsService } from './account-entitlements.service';

const originalWebhookSecret = process.env.STRIPE_WEBHOOK_SECRET;

afterAll(() => {
  if (originalWebhookSecret === undefined) {
    delete process.env.STRIPE_WEBHOOK_SECRET;
  } else {
    process.env.STRIPE_WEBHOOK_SECRET = originalWebhookSecret;
  }
});

function serviceWith(overrides: Record<string, unknown> = {}) {
  let transactionDepth = 0;
  const checkoutOperations: Array<{
    id: string;
    userId: string;
    operationKind: string;
    attemptId?: string;
    requestedPlan?: string;
    interval?: string;
    stripePriceId?: string;
    successUrl?: string;
    cancelUrl?: string;
    stripeCustomerId?: string;
    portalReturnUrl?: string;
    ownerToken: string;
    state: string;
    leaseExpiresAt: Date;
  }> = [];
  const checkoutState = {
    id: 'user-1',
    email: 'holder@example.com',
    stripeCustomerId: null as string | null,
    checkoutAttemptId: null as string | null,
    checkoutAttemptPlan: null as string | null,
    checkoutAttemptInterval: null as string | null,
    checkoutAttemptCreatedAt: null as Date | null,
    checkoutSessionId: null as string | null,
    checkoutSessionUrl: null as string | null,
    checkoutCleanupSessionId: null as string | null,
    billingStateVersion: 0,
    subscription: { plan: 'SIGNAL', status: 'active' },
  };
  const rootFindUniqueOrThrow = jest
    .fn()
    .mockImplementation(() => checkoutState);
  rootFindUniqueOrThrow.mockResolvedValue = ((value: unknown) => {
    if (typeof value === 'object' && value !== null) {
      Object.assign(checkoutState, value);
    }
    return rootFindUniqueOrThrow.mockImplementation(() => checkoutState);
  }) as typeof rootFindUniqueOrThrow.mockResolvedValue;
  const applyCheckoutData = (data: Record<string, unknown>) => {
    for (const [key, value] of Object.entries(data)) {
      if (typeof value === 'object' && value !== null && 'increment' in value) {
        const current = Number(
          checkoutState[key as keyof typeof checkoutState] ?? 0,
        );
        Object.assign(checkoutState, {
          [key]: current + Number(value.increment),
        });
      } else if (
        typeof value === 'object' &&
        value !== null &&
        'decrement' in value
      ) {
        const current = Number(
          checkoutState[key as keyof typeof checkoutState] ?? 0,
        );
        Object.assign(checkoutState, {
          [key]: current - Number(value.decrement),
        });
      } else {
        Object.assign(checkoutState, { [key]: value });
      }
    }
  };
  const txFindUnique = jest.fn().mockImplementation(() => checkoutState);
  const configureTxFindUnique =
    txFindUnique.mockImplementation.bind(txFindUnique);
  txFindUnique.mockResolvedValue = ((value: unknown) => {
    if (typeof value === 'object' && value !== null) {
      Object.assign(checkoutState, value);
    }
    return configureTxFindUnique(() => checkoutState);
  }) as typeof txFindUnique.mockResolvedValue;
  const txFindUniqueOrThrow = jest.fn().mockImplementation(() => checkoutState);
  const configureTxFindUniqueOrThrow =
    txFindUniqueOrThrow.mockImplementation.bind(txFindUniqueOrThrow);
  txFindUniqueOrThrow.mockResolvedValue = ((value: unknown) => {
    if (typeof value === 'object' && value !== null) {
      Object.assign(checkoutState, value);
    }
    return configureTxFindUniqueOrThrow(() => checkoutState);
  }) as typeof txFindUniqueOrThrow.mockResolvedValue;
  const rootFindUnique = jest.fn().mockImplementation(() => checkoutState);
  const configureRootFindUnique =
    rootFindUnique.mockImplementation.bind(rootFindUnique);
  rootFindUnique.mockResolvedValue = ((value: unknown) => {
    if (typeof value === 'object' && value !== null) {
      Object.assign(checkoutState, value);
    }
    return configureRootFindUnique(() => checkoutState);
  }) as typeof rootFindUnique.mockResolvedValue;
  const tx = {
    user: {
      findUnique: txFindUnique,
      findUniqueOrThrow: txFindUniqueOrThrow,
      update: jest
        .fn()
        .mockImplementation(({ data }: { data: Record<string, unknown> }) => {
          applyCheckoutData(data);
          return Promise.resolve(checkoutState);
        }),
      updateMany: jest
        .fn()
        .mockImplementation(({ data }: { data: Record<string, unknown> }) => {
          applyCheckoutData(data);
          return Promise.resolve({ count: 1 });
        }),
    },
    subscription: {
      findUnique: jest.fn(),
      update: jest.fn(),
      upsert: jest.fn(),
    },
    checkoutCleanupIntent: {
      findMany: jest.fn().mockResolvedValue([]),
      count: jest.fn().mockResolvedValue(0),
      upsert: jest.fn(),
      deleteMany: jest.fn().mockResolvedValue({ count: 1 }),
    },
    checkoutOperation: {
      findMany: jest.fn().mockImplementation(() => checkoutOperations),
      findUnique: jest
        .fn()
        .mockImplementation(({ where }: { where: { id: string } }) =>
          checkoutOperations.find(({ id }) => id === where.id),
        ),
      count: jest.fn().mockImplementation(() => checkoutOperations.length),
      create: jest
        .fn()
        .mockImplementation(
          ({ data }: { data: (typeof checkoutOperations)[number] }) => {
            checkoutOperations.push(data);
            return Promise.resolve(data);
          },
        ),
      updateMany: jest
        .fn()
        .mockImplementation(
          ({
            where,
            data,
          }: {
            where: { id: string; ownerToken?: string };
            data: Partial<(typeof checkoutOperations)[number]>;
          }) => {
            const operation = checkoutOperations.find(
              ({ id, ownerToken }) =>
                id === where.id &&
                (where.ownerToken === undefined ||
                  ownerToken === where.ownerToken),
            );
            if (!operation) return Promise.resolve({ count: 0 });
            Object.assign(operation, data);
            return Promise.resolve({ count: 1 });
          },
        ),
      deleteMany: jest
        .fn()
        .mockImplementation(
          ({ where }: { where: { id: string; ownerToken?: string } }) => {
            const index = checkoutOperations.findIndex(
              ({ id, ownerToken }) =>
                id === where.id &&
                (where.ownerToken === undefined ||
                  ownerToken === where.ownerToken),
            );
            if (index < 0) return Promise.resolve({ count: 0 });
            checkoutOperations.splice(index, 1);
            return Promise.resolve({ count: 1 });
          },
        ),
    },
  };
  const prisma = {
    tx,
    user: {
      findUnique: rootFindUnique,
      findUniqueOrThrow: rootFindUniqueOrThrow,
    },
    checkoutCleanupIntent: {
      findMany: jest.fn().mockResolvedValue([]),
    },
    checkoutOperation: {
      findMany: jest.fn().mockImplementation(() => checkoutOperations),
    },
    $transaction: jest.fn(async (fn: (client: typeof tx) => unknown) => {
      transactionDepth += 1;
      try {
        return await fn(tx);
      } finally {
        transactionDepth -= 1;
      }
    }),
    ...overrides,
  };
  const stripe = {
    customers: { create: jest.fn() },
    subscriptions: {
      list: jest.fn().mockReturnValue({
        autoPagingToArray: jest.fn().mockResolvedValue([]),
      }),
    },
    checkout: {
      sessions: {
        create: jest.fn(),
        expire: jest.fn(),
        list: jest.fn().mockReturnValue({
          autoPagingToArray: jest.fn().mockResolvedValue([]),
        }),
        retrieve: jest.fn(),
      },
    },
    billingPortal: { sessions: { create: jest.fn() } },
    webhooks: { constructEvent: jest.fn() },
  };
  const prices = {
    priceIdFor: jest.fn().mockReturnValue('price_signal'),
    planForPriceId: jest.fn((priceId: string) => {
      if (priceId === 'price_signal') return 'SIGNAL';
      if (priceId === 'price_fleet') return 'FLEET';
      return undefined;
    }),
  };
  const entitlements = {
    lockUsers: jest.fn().mockResolvedValue(undefined),
    forUser: jest.fn(),
  };
  return {
    service: new BillingService(
      stripe as unknown as Stripe,
      prisma as unknown as PrismaService,
      prices as unknown as StripePriceRegistry,
      entitlements as unknown as AccountEntitlementsService,
    ),
    prisma,
    tx,
    stripe,
    entitlements,
    checkoutState,
    checkoutOperations,
    isTransactionActive: () => transactionDepth > 0,
  };
}

describe('BillingService account billing', () => {
  const subscription = (id: string, priceId: string, status = 'active') => ({
    id,
    customer: 'cus_1',
    status,
    items: { data: [{ price: { id: priceId } }] },
  });

  it('creates a Stripe customer with user metadata and assigns it while holding the user lock', async () => {
    const { service, prisma, tx, stripe, entitlements, isTransactionActive } =
      serviceWith();
    prisma.user.findUniqueOrThrow.mockResolvedValue({
      id: 'user-1',
      email: 'holder@example.com',
      stripeCustomerId: null,
    });
    stripe.customers.create.mockImplementation(() => {
      expect(isTransactionActive()).toBe(false);
      return Promise.resolve({ id: 'cus_1' });
    });
    tx.user.findUnique.mockResolvedValue({ stripeCustomerId: null });
    stripe.checkout.sessions.create.mockResolvedValue({
      url: 'https://stripe.test/checkout',
    });

    await service.createCheckout('user-1', 'SIGNAL');

    expect(stripe.customers.create).toHaveBeenCalledWith(
      {
        email: 'holder@example.com',
        metadata: { userId: 'user-1' },
      },
      {
        idempotencyKey: 'account-customer-v1:user-1',
        timeout: 10_000,
      },
    );
    expect(entitlements.lockUsers).toHaveBeenCalledWith(tx, ['user-1']);
    expect(tx.user.update).toHaveBeenCalledWith({
      where: { id: 'user-1' },
      data: {
        stripeCustomerId: 'cus_1',
        billingStateVersion: { increment: 1 },
      },
    });
    expect(prisma.$transaction).toHaveBeenCalledTimes(5);
  });

  it('retries customer assignment when a same-parameter reservation advances the billing version', async () => {
    const { service, prisma, tx, stripe, checkoutState } = serviceWith();
    const typedUpdateUser = tx.user.update as jest.MockedFunction<
      (args: { data: Record<string, unknown> }) => Promise<typeof checkoutState>
    >;
    const updateUser = typedUpdateUser.getMockImplementation();
    if (!updateUser) throw new Error('User update mock is not configured');
    typedUpdateUser.mockImplementation(async (args) => ({
      ...(await updateUser(args)),
    }));
    prisma.user.findUniqueOrThrow.mockResolvedValue({
      id: 'user-1',
      email: 'holder@example.com',
      stripeCustomerId: null,
    });
    stripe.customers.create.mockImplementation(() => {
      checkoutState.billingStateVersion += 1;
      return Promise.resolve({ id: 'cus_1' });
    });
    stripe.checkout.sessions.create.mockResolvedValue({
      id: 'cs_1',
      url: 'https://stripe.test/checkout',
    });

    await expect(service.createCheckout('user-1', 'SIGNAL')).resolves.toEqual({
      url: 'https://stripe.test/checkout',
    });
    expect(stripe.customers.create).toHaveBeenCalledTimes(1);
    expect(checkoutState.stripeCustomerId).toBe('cus_1');
  });

  it('reuses an open session for the same plan and interval', async () => {
    const { service, prisma, tx, stripe, checkoutState } = serviceWith();
    prisma.user.findUniqueOrThrow.mockResolvedValue({
      id: 'user-1',
      email: 'holder@example.com',
      stripeCustomerId: null,
    });
    stripe.customers.create.mockResolvedValue({ id: 'cus_1' });
    tx.user.findUnique.mockResolvedValue({ stripeCustomerId: 'cus_1' });
    Object.assign(checkoutState, {
      checkoutAttemptId: 'attempt-1',
      checkoutAttemptPlan: 'SIGNAL',
      checkoutAttemptInterval: 'month',
      checkoutAttemptCreatedAt: new Date(),
      checkoutSessionId: null,
      checkoutSessionUrl: null,
    });
    stripe.checkout.sessions.create.mockResolvedValue({
      id: 'cs_first',
      url: 'https://stripe.test/checkout',
    });
    stripe.checkout.sessions.list
      .mockReturnValueOnce({
        autoPagingToArray: jest.fn().mockResolvedValue([]),
      })
      .mockReturnValueOnce({
        autoPagingToArray: jest.fn().mockResolvedValue([
          {
            id: 'cs_first',
            created: 100,
            metadata: {
              userId: 'user-1',
              attemptId: 'attempt-1',
              plan: 'SIGNAL',
              interval: 'month',
            },
            mode: 'subscription',
            status: 'open',
            url: 'https://stripe.test/checkout',
          },
        ]),
      });

    const first = await service.createCheckout('user-1', 'SIGNAL');
    const retry = await service.createCheckout('user-1', 'SIGNAL');

    expect(first).toEqual(retry);
    expect(stripe.checkout.sessions.create).toHaveBeenCalledTimes(1);
    expect(stripe.checkout.sessions.expire).not.toHaveBeenCalled();
  });

  it.each(['active', 'trialing', 'past_due'])(
    'routes checkout to the portal when Stripe has a %s subscription',
    async (status) => {
      const { service, prisma, stripe, isTransactionActive } = serviceWith();
      prisma.user.findUniqueOrThrow.mockResolvedValue({
        id: 'user-1',
        email: 'holder@example.com',
        stripeCustomerId: 'cus_1',
      });
      stripe.subscriptions.list.mockReturnValue({
        autoPagingToArray: jest.fn().mockResolvedValue([
          {
            id: 'sub_existing',
            customer: 'cus_1',
            status,
            items: { data: [{ price: { id: 'price_signal' } }] },
          },
        ]),
      });
      stripe.billingPortal.sessions.create.mockImplementation(() => {
        expect(isTransactionActive()).toBe(false);
        return Promise.resolve({ url: 'https://stripe.test/portal' });
      });
      await expect(service.createCheckout('user-1', 'FLEET')).resolves.toEqual({
        url: 'https://stripe.test/portal',
      });
      expect(stripe.checkout.sessions.create).not.toHaveBeenCalled();
      expect(stripe.subscriptions.list).toHaveBeenCalledWith(
        {
          customer: 'cus_1',
          status: 'all',
          limit: 100,
        },
        { timeout: 10_000 },
      );
      const portalCalls = stripe.billingPortal.sessions.create.mock
        .calls as unknown as Array<
        [Stripe.BillingPortal.SessionCreateParams, Stripe.RequestOptions]
      >;
      expect(portalCalls[0]).toEqual([
        {
          customer: 'cus_1',
          return_url: 'http://localhost:9999/billing',
        },
        {
          idempotencyKey: portalCalls[0][1].idempotencyKey,
          timeout: 10_000,
        },
      ]);
      expect(portalCalls[0][1].idempotencyKey).toMatch(/^account-portal-v1:/);
    },
  );

  it('retains the checkout fence when its paid-subscription portal call is ambiguous', async () => {
    const { service, prisma, stripe, checkoutOperations } = serviceWith();
    prisma.user.findUniqueOrThrow.mockResolvedValue({
      id: 'user-1',
      email: 'holder@example.com',
      stripeCustomerId: 'cus_1',
    });
    stripe.subscriptions.list.mockReturnValue({
      autoPagingToArray: jest.fn().mockResolvedValue([
        {
          id: 'sub_existing',
          customer: 'cus_1',
          status: 'active',
          items: { data: [{ price: { id: 'price_signal' } }] },
        },
      ]),
    });
    stripe.billingPortal.sessions.create.mockRejectedValue(
      new Error('ambiguous portal timeout'),
    );

    await expect(service.createCheckout('user-1', 'FLEET')).rejects.toThrow(
      'ambiguous portal timeout',
    );
    expect(checkoutOperations).toEqual([
      expect.objectContaining({
        operationKind: 'CHECKOUT',
        state: 'UNCERTAIN',
      }),
    ]);
  });

  it('reserves and renews a fenced portal operation before calling Stripe outside the transaction', async () => {
    const {
      service,
      stripe,
      checkoutOperations,
      isTransactionActive,
      tx,
      checkoutState,
    } = serviceWith();
    checkoutState.stripeCustomerId = 'cus_1';
    stripe.billingPortal.sessions.create.mockImplementation(() => {
      expect(isTransactionActive()).toBe(false);
      expect(checkoutOperations).toEqual([
        expect.objectContaining({
          operationKind: 'PORTAL',
          stripeCustomerId: 'cus_1',
          portalReturnUrl: 'http://localhost:9999/billing',
        }),
      ]);
      return Promise.resolve({ url: 'https://stripe.test/portal' });
    });

    await expect(service.createPortal('user-1')).resolves.toEqual({
      url: 'https://stripe.test/portal',
    });

    const renewalCalls = tx.checkoutOperation.updateMany.mock
      .calls as unknown as Array<
      [
        {
          where: {
            operationKind?: string;
            ownerToken?: string;
          };
        },
      ]
    >;
    const renewal = renewalCalls.find(
      ([{ where }]) => where.operationKind === 'PORTAL',
    );
    expect(renewal?.[0].where.operationKind).toBe('PORTAL');
    expect(typeof renewal?.[0].where.ownerToken).toBe('string');
    expect(checkoutOperations).toHaveLength(0);
  });

  it('retains an uncertain portal operation after an ambiguous Stripe timeout', async () => {
    const { service, stripe, checkoutOperations, checkoutState } =
      serviceWith();
    checkoutState.stripeCustomerId = 'cus_1';
    stripe.billingPortal.sessions.create.mockRejectedValue(
      new Error('portal timeout'),
    );

    await expect(service.createPortal('user-1')).rejects.toThrow(
      'portal timeout',
    );

    expect(checkoutOperations).toEqual([
      expect.objectContaining({
        operationKind: 'PORTAL',
        state: 'UNCERTAIN',
      }),
    ]);
  });

  it('removes its fenced portal operation after a definitive Stripe error', async () => {
    const { service, stripe, checkoutOperations, checkoutState } =
      serviceWith();
    checkoutState.stripeCustomerId = 'cus_1';
    stripe.billingPortal.sessions.create.mockRejectedValue({
      type: 'StripeInvalidRequestError',
      statusCode: 400,
      message: 'invalid portal configuration',
    });

    await expect(service.createPortal('user-1')).rejects.toEqual(
      expect.objectContaining({ message: 'invalid portal configuration' }),
    );
    expect(checkoutOperations).toHaveLength(0);
  });

  it('expires a different open attempt before creating its replacement', async () => {
    const { service, prisma, tx, stripe, isTransactionActive, checkoutState } =
      serviceWith();
    prisma.user.findUniqueOrThrow.mockResolvedValue({
      id: 'user-1',
      email: 'holder@example.com',
      stripeCustomerId: 'cus_1',
    });
    tx.user.findUnique.mockResolvedValue({ stripeCustomerId: 'cus_1' });
    Object.assign(checkoutState, {
      checkoutAttemptId: 'attempt-signal',
      checkoutAttemptPlan: 'SIGNAL',
      checkoutAttemptInterval: 'month',
      checkoutAttemptCreatedAt: new Date(),
      checkoutSessionId: 'cs_signal',
      checkoutSessionUrl: 'https://stripe.test/signal',
    });
    const signalSession = {
      id: 'cs_signal',
      created: 100,
      metadata: {
        userId: 'user-1',
        attemptId: 'attempt-signal',
        plan: 'SIGNAL',
        interval: 'month',
      },
      mode: 'subscription',
      status: 'open',
      url: 'https://stripe.test/signal',
    };
    stripe.checkout.sessions.list
      .mockReturnValueOnce({
        autoPagingToArray: jest.fn().mockResolvedValue([signalSession]),
      })
      .mockReturnValueOnce({
        autoPagingToArray: jest.fn().mockResolvedValue([
          {
            ...signalSession,
            status: 'expired',
            url: null,
          },
        ]),
      });
    stripe.checkout.sessions.expire.mockImplementation(() => {
      expect(isTransactionActive()).toBe(false);
      return Promise.resolve({ id: 'cs_signal' });
    });
    stripe.checkout.sessions.create.mockImplementation(() => {
      expect(isTransactionActive()).toBe(false);
      return Promise.resolve({
        id: 'cs_fleet',
        url: 'https://stripe.test/fleet',
      });
    });

    await service.createCheckout('user-1', 'FLEET', 'year');

    expect(stripe.checkout.sessions.expire).toHaveBeenCalledWith(
      'cs_signal',
      {},
      { timeout: 10_000 },
    );
    const userUpdateCalls = tx.user.update.mock.calls as Array<
      [{ data: { checkoutAttemptPlan?: string } }]
    >;
    const replacementIntentIndex = userUpdateCalls.findIndex(
      ([{ data }]) => data.checkoutAttemptPlan === 'FLEET',
    );
    expect(
      tx.user.update.mock.invocationCallOrder[replacementIntentIndex],
    ).toBeLessThan(stripe.checkout.sessions.expire.mock.invocationCallOrder[0]);
    const [[params, options]] = stripe.checkout.sessions.create.mock
      .calls as unknown as Array<
      [Stripe.Checkout.SessionCreateParams, Stripe.RequestOptions]
    >;
    expect(params.metadata).toMatchObject({
      userId: 'user-1',
      plan: 'FLEET',
      interval: 'year',
    });
    expect(options.idempotencyKey).toMatch(/^account-checkout-v3:/);
  });

  it('recovers immediately after an ambiguous expiry timeout using persisted replacement intent', async () => {
    const { service, prisma, checkoutState, stripe } = serviceWith();
    prisma.user.findUniqueOrThrow.mockResolvedValue({
      id: 'user-1',
      email: 'holder@example.com',
      stripeCustomerId: 'cus_1',
    });
    Object.assign(checkoutState, {
      checkoutAttemptId: 'attempt-signal',
      checkoutAttemptPlan: 'SIGNAL',
      checkoutAttemptInterval: 'month',
      checkoutAttemptCreatedAt: new Date(),
      checkoutSessionId: 'cs_signal',
      checkoutSessionUrl: 'https://stripe.test/signal',
    });
    const openSession = {
      id: 'cs_signal',
      created: 100,
      metadata: {
        userId: 'user-1',
        attemptId: 'attempt-signal',
        plan: 'SIGNAL',
        interval: 'month',
      },
      mode: 'subscription',
      status: 'open',
      url: 'https://stripe.test/signal',
    };
    stripe.checkout.sessions.list
      .mockReturnValueOnce({
        autoPagingToArray: jest.fn().mockResolvedValue([openSession]),
      })
      .mockReturnValueOnce({
        autoPagingToArray: jest
          .fn()
          .mockResolvedValue([
            { ...openSession, status: 'expired', url: null },
          ]),
      });
    stripe.checkout.sessions.expire.mockRejectedValueOnce(
      new Error('network timeout after side effect'),
    );
    stripe.checkout.sessions.create.mockResolvedValue({
      id: 'cs_fleet',
      url: 'https://stripe.test/fleet',
    });

    await expect(service.createCheckout('user-1', 'FLEET')).rejects.toThrow(
      'network timeout after side effect',
    );
    expect(checkoutState).toMatchObject({
      checkoutAttemptPlan: 'FLEET',
      checkoutAttemptInterval: 'month',
      checkoutSessionId: 'cs_signal',
      checkoutSessionUrl: null,
    });
    const replacementAttemptId = checkoutState.checkoutAttemptId;

    await expect(service.createCheckout('user-1', 'FLEET')).resolves.toEqual({
      url: 'https://stripe.test/fleet',
    });
    expect(stripe.checkout.sessions.expire).toHaveBeenCalledTimes(1);
    const [[createParams, createOptions]] = stripe.checkout.sessions.create.mock
      .calls as unknown as Array<
      [Stripe.Checkout.SessionCreateParams, Stripe.RequestOptions]
    >;
    expect(createParams.metadata).toMatchObject({
      attemptId: replacementAttemptId,
      plan: 'FLEET',
    });
    expect(createOptions).toEqual({
      idempotencyKey: `account-checkout-v3:${replacementAttemptId}`,
      timeout: 10_000,
    });
  });

  it('creates a newly fenced attempt at the 24-hour replacement boundary', async () => {
    const now = jest.spyOn(Date, 'now').mockReturnValue(100_000_000);
    const { service, prisma, tx, stripe } = serviceWith();
    prisma.user.findUniqueOrThrow.mockResolvedValue({
      id: 'user-1',
      email: 'holder@example.com',
      stripeCustomerId: 'cus_1',
    });
    tx.user.findUnique.mockResolvedValue({ stripeCustomerId: 'cus_1' });
    tx.user.findUniqueOrThrow.mockResolvedValue({
      checkoutAttemptId: 'attempt-abandoned',
      checkoutAttemptPlan: 'SIGNAL',
      checkoutAttemptInterval: 'month',
      checkoutAttemptCreatedAt: new Date(Date.now() - 24 * 60 * 60 * 1000),
      checkoutSessionId: 'cs_abandoned',
      checkoutSessionUrl: null,
    });
    stripe.checkout.sessions.list.mockReturnValue({
      autoPagingToArray: jest.fn().mockResolvedValue([
        {
          id: 'cs_abandoned',
          created: 100,
          metadata: {
            userId: 'user-1',
            attemptId: 'attempt-abandoned',
            plan: 'SIGNAL',
            interval: 'month',
          },
          mode: 'subscription',
          status: 'expired',
          url: null,
        },
      ]),
    });
    stripe.checkout.sessions.create.mockResolvedValue({
      id: 'cs_replacement',
      url: 'https://stripe.test/replacement',
    });

    try {
      await service.createCheckout('user-1', 'SIGNAL');

      const [[, options]] = stripe.checkout.sessions.create.mock
        .calls as unknown as Array<
        [Stripe.Checkout.SessionCreateParams, Stripe.RequestOptions]
      >;
      expect(options.idempotencyKey).toMatch(/^account-checkout-v3:/);
      expect(options.idempotencyKey).not.toBe(
        'account-checkout-v3:attempt-abandoned',
      );
    } finally {
      now.mockRestore();
    }
  });

  it('reuses the persisted key after an unknown response and more than one hour', async () => {
    let currentTime = 7_200_000;
    const now = jest.spyOn(Date, 'now').mockImplementation(() => currentTime);
    try {
      const { service, prisma, tx, stripe, checkoutOperations } = serviceWith();
      prisma.user.findUniqueOrThrow.mockResolvedValue({
        id: 'user-1',
        email: 'holder@example.com',
        stripeCustomerId: 'cus_1',
      });
      tx.user.findUniqueOrThrow.mockResolvedValue({
        checkoutAttemptId: 'attempt-retry',
        checkoutAttemptPlan: 'SIGNAL',
        checkoutAttemptInterval: 'month',
        checkoutAttemptCreatedAt: new Date(0),
        checkoutSessionId: null,
        checkoutSessionUrl: null,
      });
      let recoveredSession:
        | {
            id: string;
            created: number;
            metadata: { attemptId: string; userId: string };
            mode: string;
            status: string;
            url: string;
          }
        | undefined;
      stripe.checkout.sessions.list.mockReturnValue({
        autoPagingToArray: jest
          .fn()
          .mockImplementation(() =>
            Promise.resolve(recoveredSession ? [recoveredSession] : []),
          ),
      });
      stripe.checkout.sessions.create
        .mockRejectedValueOnce(new Error('connection reset'))
        .mockImplementationOnce(() => {
          recoveredSession = {
            id: 'cs_retry',
            created: 1,
            metadata: { attemptId: 'attempt-retry', userId: 'user-1' },
            mode: 'subscription',
            status: 'open',
            url: 'https://stripe.test/retry',
          };
          return Promise.resolve(recoveredSession);
        });

      await expect(service.createCheckout('user-1', 'SIGNAL')).rejects.toThrow(
        'connection reset',
      );
      expect(checkoutOperations).toHaveLength(1);
      expect(checkoutOperations[0]).toMatchObject({
        attemptId: 'attempt-retry',
        state: 'UNCERTAIN',
      });
      currentTime += 2 * 60 * 1000 + 1;
      await service.createCheckout('user-1', 'SIGNAL');

      const expectedOptions = {
        idempotencyKey: 'account-checkout-v3:attempt-retry',
        timeout: 10_000,
      };
      expect(stripe.checkout.sessions.create).toHaveBeenNthCalledWith(
        1,
        expect.any(Object),
        expectedOptions,
      );
      expect(stripe.checkout.sessions.create).toHaveBeenNthCalledWith(
        2,
        expect.any(Object),
        expectedOptions,
      );
    } finally {
      now.mockRestore();
    }
  });

  it('removes its fenced operation after a definitive Stripe validation error', async () => {
    const { service, prisma, stripe, checkoutOperations } = serviceWith();
    prisma.user.findUniqueOrThrow.mockResolvedValue({
      id: 'user-1',
      email: 'holder@example.com',
      stripeCustomerId: 'cus_1',
    });
    stripe.checkout.sessions.create.mockRejectedValue({
      type: 'StripeInvalidRequestError',
      statusCode: 400,
      message: 'invalid price',
    });

    await expect(service.createCheckout('user-1', 'SIGNAL')).rejects.toEqual(
      expect.objectContaining({ message: 'invalid price' }),
    );

    expect(checkoutOperations).toHaveLength(0);
  });

  it('does not call Stripe after recovery steals the operation token during coordination', async () => {
    const { service, prisma, stripe, checkoutOperations } = serviceWith();
    prisma.user.findUniqueOrThrow.mockResolvedValue({
      id: 'user-1',
      email: 'holder@example.com',
      stripeCustomerId: 'cus_1',
    });
    stripe.checkout.sessions.list.mockReturnValueOnce({
      autoPagingToArray: jest.fn().mockImplementation(() => {
        checkoutOperations[0].ownerToken =
          '00000000-0000-4000-8000-000000000099';
        checkoutOperations[0].leaseExpiresAt = new Date(
          Date.now() + 2 * 60 * 1000,
        );
        return Promise.resolve([]);
      }),
    });

    await expect(service.createCheckout('user-1', 'SIGNAL')).rejects.toThrow(
      'Billing state changed; retry checkout',
    );
    expect(stripe.checkout.sessions.create).not.toHaveBeenCalled();
  });

  it('locks the account before reading and mutating webhook subscription state', async () => {
    const { service, prisma, tx, stripe, entitlements } = serviceWith();
    prisma.user.findUnique.mockResolvedValue({
      id: 'user-1',
      stripeCustomerId: 'cus_1',
      billingStateVersion: 0,
    });
    tx.user.findUnique.mockResolvedValue({
      id: 'user-1',
      stripeCustomerId: 'cus_1',
      billingStateVersion: 0,
    });
    tx.subscription.findUnique.mockResolvedValue({ manualOverride: false });
    stripe.subscriptions.list.mockReturnValue({
      autoPagingToArray: jest
        .fn()
        .mockResolvedValue([subscription('sub_1', 'price_signal')]),
    });

    await service.applySubscriptionEvent('cus_1');

    expect(entitlements.lockUsers).toHaveBeenCalledWith(tx, ['user-1']);
    const lockOrder = entitlements.lockUsers.mock.invocationCallOrder[0];
    const stripeReadOrder =
      stripe.subscriptions.list.mock.invocationCallOrder[0];
    const subscriptionReadOrder =
      tx.subscription.findUnique.mock.invocationCallOrder[0];
    const subscriptionWriteOrder =
      tx.subscription.upsert.mock.invocationCallOrder[0];
    expect(lockOrder).toBeLessThan(subscriptionReadOrder);
    expect(stripeReadOrder).toBeLessThan(subscriptionReadOrder);
    expect(stripeReadOrder).toBeLessThan(lockOrder);
    expect(subscriptionReadOrder).toBeLessThan(subscriptionWriteOrder);
    expect(tx.user.update).toHaveBeenCalledWith({
      where: { id: 'user-1' },
      data: {
        checkoutAttemptId: null,
        checkoutAttemptPlan: null,
        checkoutAttemptInterval: null,
        checkoutAttemptCreatedAt: null,
        checkoutSessionId: null,
        checkoutSessionUrl: null,
        checkoutSessionExpiresAt: null,
        billingStateVersion: { increment: 1 },
      },
    });
    expect(tx.subscription.upsert).toHaveBeenCalledWith({
      where: { userId: 'user-1' },
      update: {
        plan: 'SIGNAL',
        status: 'active',
        stripeSubscriptionId: 'sub_1',
      },
      create: {
        userId: 'user-1',
        plan: 'SIGNAL',
        status: 'active',
        stripeSubscriptionId: 'sub_1',
      },
    });
  });

  it('performs every Stripe snapshot read outside the database transaction', async () => {
    const { service, prisma, tx, stripe, isTransactionActive } = serviceWith();
    prisma.user.findUnique.mockResolvedValue({
      id: 'user-1',
      stripeCustomerId: 'cus_1',
      billingStateVersion: 0,
    });
    tx.user.findUnique.mockResolvedValue({
      id: 'user-1',
      stripeCustomerId: 'cus_1',
      billingStateVersion: 0,
    });
    tx.subscription.findUnique.mockResolvedValue({ manualOverride: false });
    stripe.subscriptions.list.mockImplementation(() => {
      expect(isTransactionActive()).toBe(false);
      return {
        autoPagingToArray: jest
          .fn()
          .mockResolvedValue([subscription('sub_1', 'price_signal')]),
      };
    });

    await service.applySubscriptionEvent('cus_1');
  });

  it('discards a stale webhook snapshot and refetches after the billing version changes', async () => {
    const { service, prisma, tx, stripe } = serviceWith();
    prisma.user.findUnique
      .mockResolvedValueOnce({
        id: 'user-1',
        stripeCustomerId: 'cus_1',
        billingStateVersion: 4,
      })
      .mockResolvedValueOnce({
        id: 'user-1',
        stripeCustomerId: 'cus_1',
        billingStateVersion: 4,
      })
      .mockResolvedValueOnce({
        id: 'user-1',
        stripeCustomerId: 'cus_1',
        billingStateVersion: 5,
      })
      .mockResolvedValueOnce({
        id: 'user-1',
        stripeCustomerId: 'cus_1',
        billingStateVersion: 5,
      });
    tx.user.findUnique
      .mockResolvedValueOnce({
        id: 'user-1',
        stripeCustomerId: 'cus_1',
        billingStateVersion: 5,
      })
      .mockResolvedValueOnce({
        id: 'user-1',
        stripeCustomerId: 'cus_1',
        billingStateVersion: 5,
      });
    tx.subscription.findUnique.mockResolvedValue({ manualOverride: false });
    stripe.subscriptions.list
      .mockReturnValueOnce({
        autoPagingToArray: jest
          .fn()
          .mockResolvedValue([subscription('sub_old', 'price_signal')]),
      })
      .mockReturnValueOnce({
        autoPagingToArray: jest
          .fn()
          .mockResolvedValue([subscription('sub_new', 'price_fleet')]),
      });

    await service.applySubscriptionEvent('cus_1');

    expect(stripe.subscriptions.list).toHaveBeenCalledTimes(2);
    expect(tx.subscription.upsert).toHaveBeenCalledTimes(1);
    expect(tx.subscription.upsert).toHaveBeenCalledWith(
      expect.objectContaining({
        // eslint-disable-next-line @typescript-eslint/no-unsafe-assignment
        update: expect.objectContaining({
          stripeSubscriptionId: 'sub_new',
          plan: 'FLEET',
        }),
      }),
    );
  });

  it('reserves the checkout attempt before authoritatively revalidating Stripe state', async () => {
    const { service, prisma, tx, stripe } = serviceWith();
    prisma.user.findUniqueOrThrow.mockResolvedValue({
      id: 'user-1',
      email: 'holder@example.com',
      stripeCustomerId: 'cus_1',
    });
    tx.user.findUnique.mockResolvedValue({
      id: 'user-1',
      stripeCustomerId: 'cus_1',
      billingStateVersion: 0,
    });
    stripe.checkout.sessions.create.mockResolvedValue({
      id: 'cs_1',
      url: 'https://stripe.test/checkout',
    });

    await service.createCheckout('user-1', 'SIGNAL');

    const updateCalls = tx.user.update.mock.calls as Array<
      [{ data?: { checkoutAttemptId?: string } }]
    >;
    const reservationOrder = tx.user.update.mock.invocationCallOrder.find(
      (order, index) =>
        updateCalls[index]?.[0].data?.checkoutAttemptId !== undefined,
    );
    expect(reservationOrder).toBeDefined();
    expect(reservationOrder).toBeLessThan(
      stripe.subscriptions.list.mock.invocationCallOrder[0],
    );
  });

  it('holds a leased checkout operation until the returned session is persisted', async () => {
    const { service, prisma, stripe, checkoutOperations } = serviceWith();
    prisma.user.findUniqueOrThrow.mockResolvedValue({
      id: 'user-1',
      email: 'holder@example.com',
      stripeCustomerId: 'cus_1',
    });
    let releaseCreate!: () => void;
    const released = new Promise<void>((resolve) => {
      releaseCreate = resolve;
    });
    let markEntered!: () => void;
    const entered = new Promise<void>((resolve) => {
      markEntered = resolve;
    });
    stripe.checkout.sessions.create.mockImplementation(async () => {
      markEntered();
      await released;
      return {
        id: 'cs_in_flight',
        url: 'https://stripe.test/in-flight',
      };
    });

    const checkout = service.createCheckout('user-1', 'SIGNAL');
    try {
      await entered;
      expect(checkoutOperations).toHaveLength(1);
      releaseCreate();

      await expect(checkout).resolves.toEqual({
        url: 'https://stripe.test/in-flight',
      });
      expect(checkoutOperations).toHaveLength(0);
    } finally {
      releaseCreate();
      await checkout.catch(() => undefined);
    }
  });

  it('preserves a manual account override while syncing Stripe status', async () => {
    const { service, prisma, tx, stripe } = serviceWith();
    prisma.user.findUnique.mockResolvedValue({
      id: 'user-1',
      stripeCustomerId: 'cus_1',
      billingStateVersion: 0,
    });
    tx.user.findUnique.mockResolvedValue({
      id: 'user-1',
      stripeCustomerId: 'cus_1',
      billingStateVersion: 0,
    });
    tx.subscription.findUnique.mockResolvedValue({ manualOverride: true });
    stripe.subscriptions.list.mockReturnValue({
      autoPagingToArray: jest.fn().mockResolvedValue([]),
    });

    await service.applySubscriptionEvent('cus_1');

    expect(tx.subscription.update).toHaveBeenCalledWith({
      where: { userId: 'user-1' },
      data: { status: 'canceled', stripeSubscriptionId: null },
    });
    expect(tx.subscription.upsert).not.toHaveBeenCalled();
  });

  it('converges duplicate and reversed webhook delivery to the highest authoritative active plan', async () => {
    process.env.STRIPE_WEBHOOK_SECRET = 'whsec_unit';
    const { service, prisma, tx, stripe } = serviceWith();
    prisma.user.findUnique.mockResolvedValue({
      id: 'user-1',
      stripeCustomerId: 'cus_1',
      billingStateVersion: 0,
    });
    tx.user.findUnique.mockResolvedValue({
      id: 'user-1',
      stripeCustomerId: 'cus_1',
      billingStateVersion: 0,
    });
    tx.subscription.findUnique.mockResolvedValue({ manualOverride: false });
    stripe.subscriptions.list.mockReturnValue({
      autoPagingToArray: jest
        .fn()
        .mockResolvedValue([
          subscription('sub_signal', 'price_signal'),
          subscription('sub_fleet', 'price_fleet', 'trialing'),
        ]),
    });
    stripe.webhooks.constructEvent
      .mockReturnValueOnce({
        type: 'customer.subscription.deleted',
        data: { object: subscription('sub_fleet', 'price_fleet', 'canceled') },
      })
      .mockReturnValueOnce({
        type: 'customer.subscription.updated',
        data: { object: subscription('sub_signal', 'price_signal') },
      })
      .mockReturnValueOnce({
        type: 'customer.subscription.updated',
        data: { object: subscription('sub_signal', 'price_signal') },
      });

    await service.handleWebhook(Buffer.from('{}'), 'signature');
    await service.handleWebhook(Buffer.from('{}'), 'signature');
    await service.handleWebhook(Buffer.from('{}'), 'signature');

    expect(tx.subscription.upsert).toHaveBeenLastCalledWith({
      where: { userId: 'user-1' },
      update: {
        plan: 'FLEET',
        status: 'trialing',
        stripeSubscriptionId: 'sub_fleet',
      },
      create: {
        userId: 'user-1',
        plan: 'FLEET',
        status: 'trialing',
        stripeSubscriptionId: 'sub_fleet',
      },
    });
  });

  it('falls back to a remaining duplicate subscription after the winner is deleted', async () => {
    const { service, prisma, tx, stripe } = serviceWith();
    prisma.user.findUnique.mockResolvedValue({
      id: 'user-1',
      stripeCustomerId: 'cus_1',
      billingStateVersion: 0,
    });
    tx.user.findUnique.mockResolvedValue({
      id: 'user-1',
      stripeCustomerId: 'cus_1',
      billingStateVersion: 0,
    });
    tx.subscription.findUnique.mockResolvedValue({ manualOverride: false });
    stripe.subscriptions.list.mockReturnValue({
      autoPagingToArray: jest
        .fn()
        .mockResolvedValue([subscription('sub_signal', 'price_signal')]),
    });

    await service.applySubscriptionEvent('cus_1');

    expect(tx.subscription.upsert).toHaveBeenCalledWith({
      where: { userId: 'user-1' },
      update: {
        plan: 'SIGNAL',
        status: 'active',
        stripeSubscriptionId: 'sub_signal',
      },
      create: {
        userId: 'user-1',
        plan: 'SIGNAL',
        status: 'active',
        stripeSubscriptionId: 'sub_signal',
      },
    });
  });

  it('fails an active unknown Stripe price so the webhook is retried', async () => {
    const { service, prisma, tx, stripe } = serviceWith();
    prisma.user.findUnique.mockResolvedValue({
      id: 'user-1',
      stripeCustomerId: 'cus_1',
      billingStateVersion: 0,
    });
    tx.user.findUnique.mockResolvedValue({
      id: 'user-1',
      stripeCustomerId: 'cus_1',
      billingStateVersion: 0,
    });
    stripe.subscriptions.list.mockReturnValue({
      autoPagingToArray: jest
        .fn()
        .mockResolvedValue([subscription('sub_unknown', 'price_unknown')]),
    });

    await expect(service.applySubscriptionEvent('cus_1')).rejects.toThrow(
      'Unknown active Stripe price: price_unknown',
    );
    expect(tx.subscription.upsert).not.toHaveBeenCalled();
  });
});
