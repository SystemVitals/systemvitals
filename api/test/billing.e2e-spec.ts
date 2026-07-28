import { Test } from '@nestjs/testing';
import {
  FastifyAdapter,
  NestFastifyApplication,
} from '@nestjs/platform-fastify';
import { ValidationPipe } from '@nestjs/common';
import { AppModule } from '../src/app.module';
import { STRIPE_CLIENT } from '../src/billing/stripe.provider';
import { PrismaService } from '../src/prisma/prisma.service';
import Stripe from 'stripe';
import { JwtService } from '@nestjs/jwt';

// ---------------------------------------------------------------------------
// Fake Stripe
// ---------------------------------------------------------------------------

// Fixed test price IDs — injected into env before AppModule loads so the
// BillingService picks them up for the price→tier mapping.
const TEST_PRICE_SIGNAL = 'price_signal_e2e_test';
const TEST_PRICE_FLEET = 'price_fleet_e2e_test';
const originalStripeEnv = {
  STRIPE_PRICE_SIGNAL: process.env.STRIPE_PRICE_SIGNAL,
  STRIPE_PRICE_FLEET: process.env.STRIPE_PRICE_FLEET,
  STRIPE_WEBHOOK_SECRET: process.env.STRIPE_WEBHOOK_SECRET,
};

// Set before the module is compiled
process.env.STRIPE_PRICE_SIGNAL = TEST_PRICE_SIGNAL;
process.env.STRIPE_PRICE_FLEET = TEST_PRICE_FLEET;
process.env.STRIPE_WEBHOOK_SECRET = 'whsec_test';

const fakeCheckoutUrl = 'https://checkout.stripe.com/fake-session';
const fakePortalUrl = 'https://billing.stripe.com/fake-portal';
// Use unique IDs per test run to avoid DB unique-constraint collisions on reruns
const runId = Date.now();
const fakeCustomerId = `cus_billing_e2e_${runId}`;
const fakeSubscriptionId = `sub_billing_e2e_${runId}`;

function deferred() {
  let resolve!: () => void;
  const promise = new Promise<void>((done) => {
    resolve = done;
  });
  return { promise, resolve };
}

function buildFakeStripe() {
  const realWebhooks = new Stripe('sk_test_dummy').webhooks;
  const checkoutSessions: Array<{
    id: string;
    created: number;
    metadata: Record<string, string>;
    mode: 'subscription';
    status: 'open' | 'expired';
    url: string;
  }> = [];
  const checkoutByIdempotencyKey = new Map<
    string,
    (typeof checkoutSessions)[number]
  >();
  return {
    checkoutSessions,
    checkoutByIdempotencyKey,
    customers: {
      create: jest.fn().mockResolvedValue({ id: fakeCustomerId }),
    },
    subscriptions: {
      list: jest.fn().mockReturnValue({
        autoPagingToArray: jest.fn().mockResolvedValue([]),
      }),
    },
    checkout: {
      sessions: {
        create: jest.fn(
          (
            input: {
              metadata?: Record<string, string>;
              mode: 'subscription';
            },
            options: { idempotencyKey: string },
          ) => {
            const existing = checkoutByIdempotencyKey.get(
              options.idempotencyKey,
            );
            if (existing) return Promise.resolve(existing);
            const id = `cs_fake_${checkoutSessions.length + 1}`;
            const session = {
              id,
              created: checkoutSessions.length + 1,
              metadata: input.metadata ?? {},
              mode: input.mode,
              status: 'open' as const,
              url: fakeCheckoutUrl,
            };
            checkoutSessions.push(session);
            checkoutByIdempotencyKey.set(options.idempotencyKey, session);
            return Promise.resolve(session);
          },
        ),
        expire: jest.fn((id: string) => {
          const session = checkoutSessions.find(
            (candidate) => candidate.id === id,
          );
          if (session) session.status = 'expired';
          return Promise.resolve(session);
        }),
        list: jest.fn(() => ({
          autoPagingToArray: jest.fn().mockResolvedValue([...checkoutSessions]),
        })),
      },
    },
    billingPortal: {
      sessions: {
        create: jest.fn().mockResolvedValue({ url: fakePortalUrl }),
      },
    },
    webhooks: realWebhooks,
  };
}

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

async function signup(
  app: NestFastifyApplication,
  email: string,
): Promise<string> {
  const r = await app.inject({
    method: 'POST',
    url: '/auth/signup',
    payload: { email, password: 'supersecret1' },
  });
  return (JSON.parse(r.body) as { token: string }).token;
}

async function gql(
  app: NestFastifyApplication,
  token: string | null,
  query: string,
  variables?: unknown,
) {
  const r = await app.inject({
    method: 'POST',
    url: '/graphql',
    headers: token ? { authorization: `Bearer ${token}` } : {},
    payload: { query, variables },
  });
  return JSON.parse(r.body) as {
    data?: Record<string, unknown>;
    errors?: Array<{ message: string }>;
  };
}

interface MeOrgs {
  data: { me: { organizations: Array<{ id: string }> } };
}

const ME_ORGS = `{ me { organizations { id } } }`;

async function createApiToken(
  app: NestFastifyApplication,
  jwt: string,
): Promise<string> {
  const response = await gql(
    app,
    jwt,
    `mutation {
      createApiToken(name: "billing-auth-test", scopes: ["read", "write"]) {
        plaintext
      }
    }`,
  );
  return (
    response.data?.createApiToken as {
      plaintext: string;
    }
  ).plaintext;
}

// ---------------------------------------------------------------------------
// Suite
// ---------------------------------------------------------------------------

describe('billing (e2e)', () => {
  let app: NestFastifyApplication;
  let prisma: PrismaService;
  let jwtService: JwtService;
  let fakeStripe: ReturnType<typeof buildFakeStripe>;

  const email = 'billing+e2e@systemvitals.com';
  // Ownership-enforcement scenario: A owns an org, B is invited as a plain
  // MEMBER. Kept separate from `email` above so this scenario doesn't
  // interfere with the ordered checkout/portal/webhook tests that share
  // that single user's org.
  const ownerEmail = 'billing+owner-e2e@systemvitals.com';
  const memberEmail = 'billing+member-e2e@systemvitals.com';

  beforeAll(async () => {
    fakeStripe = buildFakeStripe();

    const moduleRef = await Test.createTestingModule({
      imports: [AppModule],
    })
      .overrideProvider(STRIPE_CLIENT)
      .useValue(fakeStripe)
      .compile();

    app = moduleRef.createNestApplication<NestFastifyApplication>(
      new FastifyAdapter({ logger: false }),
      { rawBody: true },
    );

    app.useGlobalPipes(new ValidationPipe({ whitelist: true }));
    app.enableCors({ origin: true, credentials: true });

    await app.init();
    await app.getHttpAdapter().getInstance().ready();

    prisma = app.get(PrismaService);
    jwtService = app.get(JwtService);
    await prisma.organization.deleteMany({
      where: {
        creator: { email: { in: [email, ownerEmail, memberEmail] } },
      },
    });
    await prisma.user.deleteMany({ where: { email } });
    await prisma.user.deleteMany({
      where: { email: { in: [ownerEmail, memberEmail] } },
    });
  });

  afterAll(async () => {
    await prisma.organization.deleteMany({
      where: {
        creator: { email: { in: [email, ownerEmail, memberEmail] } },
      },
    });
    await prisma.user.deleteMany({ where: { email } });
    await prisma.user.deleteMany({
      where: { email: { in: [ownerEmail, memberEmail] } },
    });
    await app.close();
  });

  afterAll(() => {
    for (const [name, value] of Object.entries(originalStripeEnv)) {
      if (value === undefined) delete process.env[name];
      else process.env[name] = value;
    }
  });

  async function cleanupPrimaryFixture() {
    await prisma.organization.deleteMany({
      where: { creator: { email } },
    });
    await prisma.user.deleteMany({ where: { email } });
  }

  beforeEach(async () => {
    await cleanupPrimaryFixture();
    jest.clearAllMocks();
    fakeStripe.checkoutSessions.splice(0);
    fakeStripe.checkoutByIdempotencyKey.clear();
    fakeStripe.customers.create.mockResolvedValue({ id: fakeCustomerId });
    fakeStripe.billingPortal.sessions.create.mockResolvedValue({
      url: fakePortalUrl,
    });
    fakeStripe.subscriptions.list.mockReturnValue({
      autoPagingToArray: jest.fn().mockResolvedValue([]),
    });
  });

  afterEach(async () => {
    await cleanupPrimaryFixture();
  });

  it('recovers a returned session after simulated persistence failure leaves multiple expired process operations', async () => {
    const token = await signup(app, email);
    const user = await prisma.user.findUniqueOrThrow({ where: { email } });
    const attemptId = 'attempt_process_crash';
    await prisma.user.update({
      where: { id: user.id },
      data: {
        stripeCustomerId: fakeCustomerId,
        checkoutAttemptId: attemptId,
        checkoutAttemptPlan: 'SIGNAL',
        checkoutAttemptInterval: 'month',
        checkoutAttemptCreatedAt: new Date(),
      },
    });
    await prisma.checkoutOperation.createMany({
      data: [
        '00000000-0000-4000-8000-000000000001',
        '00000000-0000-4000-8000-000000000002',
      ].map((id) => ({
        id,
        userId: user.id,
        attemptId,
        requestedPlan: 'SIGNAL' as const,
        interval: 'month',
        leaseExpiresAt: new Date(Date.now() - 1_000),
      })),
    });
    fakeStripe.checkoutSessions.push({
      id: 'cs_process_crash',
      created: 1,
      metadata: {
        userId: user.id,
        plan: 'SIGNAL',
        interval: 'month',
        attemptId,
      },
      mode: 'subscription',
      status: 'open',
      url: fakeCheckoutUrl,
    });

    const response = await app.inject({
      method: 'POST',
      url: '/billing/checkout',
      headers: { authorization: `Bearer ${token}` },
      payload: { plan: 'SIGNAL' },
    });

    const responseBody: unknown = JSON.parse(response.body);
    expect({ statusCode: response.statusCode, body: responseBody }).toEqual({
      statusCode: 201,
      body: { url: fakeCheckoutUrl },
    });
    await expect(
      prisma.checkoutOperation.count({ where: { userId: user.id } }),
    ).resolves.toBe(0);
    await expect(
      prisma.user.findUniqueOrThrow({ where: { id: user.id } }),
    ).resolves.toMatchObject({
      checkoutSessionId: 'cs_process_crash',
      checkoutSessionUrl: fakeCheckoutUrl,
    });
    expect(fakeStripe.checkout.sessions.create).not.toHaveBeenCalled();
  });

  it('fences a delayed owner while recovery retries the same Stripe idempotency key', async () => {
    const token = await signup(app, email);
    const user = await prisma.user.findUniqueOrThrow({ where: { email } });
    await prisma.user.update({
      where: { id: user.id },
      data: { stripeCustomerId: fakeCustomerId },
    });
    const originalEntered = deferred();
    const recoveryEntered = deferred();
    const releaseOriginal = deferred();
    const releaseRecovery = deferred();
    const originalList =
      fakeStripe.checkout.sessions.list.getMockImplementation();
    const originalCreate =
      fakeStripe.checkout.sessions.create.getMockImplementation();
    if (!originalList || !originalCreate) {
      throw new Error('Fake checkout sessions are not configured');
    }
    let sessionVisible = false;
    const delayedSession = {
      id: 'cs_fenced_recovery',
      created: 1,
      metadata: {} as Record<string, string>,
      mode: 'subscription' as const,
      status: 'open' as const,
      url: fakeCheckoutUrl,
    };
    let createCalls = 0;
    fakeStripe.checkout.sessions.list.mockImplementation(() => ({
      autoPagingToArray: jest
        .fn()
        .mockImplementation(() =>
          Promise.resolve(sessionVisible ? [delayedSession] : []),
        ),
    }));
    fakeStripe.checkout.sessions.create.mockImplementation(
      async (input: { metadata?: Record<string, string> }) => {
        createCalls += 1;
        delayedSession.metadata = input.metadata ?? {};
        if (createCalls === 1) {
          originalEntered.resolve();
          await releaseOriginal.promise;
        } else {
          recoveryEntered.resolve();
          await releaseRecovery.promise;
        }
        return delayedSession;
      },
    );

    let original: ReturnType<NestFastifyApplication['inject']> | undefined;
    let recovery: ReturnType<NestFastifyApplication['inject']> | undefined;
    try {
      original = app.inject({
        method: 'POST',
        url: '/billing/checkout',
        headers: { authorization: `Bearer ${token}` },
        payload: { plan: 'SIGNAL' },
      });
      await originalEntered.promise;
      const initialOperation = await prisma.checkoutOperation.findFirstOrThrow({
        where: { userId: user.id },
      });
      await prisma.checkoutOperation.update({
        where: { id: initialOperation.id },
        data: { leaseExpiresAt: new Date(Date.now() - 1_000) },
      });

      recovery = app.inject({
        method: 'POST',
        url: '/billing/checkout',
        headers: { authorization: `Bearer ${token}` },
        payload: { plan: 'SIGNAL' },
      });
      await recoveryEntered.promise;
      const reclaimedOperation =
        await prisma.checkoutOperation.findUniqueOrThrow({
          where: { id: initialOperation.id },
        });
      expect(reclaimedOperation.state).toBe('ACTIVE');
      expect(reclaimedOperation.ownerToken).not.toBe(
        initialOperation.ownerToken,
      );

      releaseOriginal.resolve();
      const originalResponse = await original;
      expect(originalResponse.statusCode).toBe(409);
      await expect(
        prisma.checkoutCleanupIntent.count({ where: { userId: user.id } }),
      ).resolves.toBe(1);
      await expect(
        prisma.checkoutOperation.count({ where: { userId: user.id } }),
      ).resolves.toBe(1);

      sessionVisible = true;
      releaseRecovery.resolve();
      const recoveryResponse = await recovery;
      expect({
        statusCode: recoveryResponse.statusCode,
        body: JSON.parse(recoveryResponse.body) as unknown,
      }).toEqual({
        statusCode: 201,
        body: { url: fakeCheckoutUrl },
      });
      await expect(
        prisma.checkoutOperation.count({ where: { userId: user.id } }),
      ).resolves.toBe(0);
      await expect(
        prisma.checkoutCleanupIntent.count({ where: { userId: user.id } }),
      ).resolves.toBe(0);
      const idempotencyKeys =
        fakeStripe.checkout.sessions.create.mock.calls.map(
          ([, options]) => options.idempotencyKey,
        );
      expect(idempotencyKeys).toEqual([idempotencyKeys[0], idempotencyKeys[0]]);
    } finally {
      releaseOriginal.resolve();
      releaseRecovery.resolve();
      await Promise.allSettled([
        ...(original ? [original] : []),
        ...(recovery ? [recovery] : []),
      ]);
      fakeStripe.checkout.sessions.list.mockImplementation(originalList);
      fakeStripe.checkout.sessions.create.mockImplementation(originalCreate);
    }
  });

  it('prevents a pre-create stale owner from calling Stripe after recovery claims its expired lease', async () => {
    const token = await signup(app, email);
    const user = await prisma.user.findUniqueOrThrow({ where: { email } });
    await prisma.user.update({
      where: { id: user.id },
      data: { stripeCustomerId: fakeCustomerId },
    });
    const originalSnapshotEntered = deferred();
    const releaseOriginalSnapshot = deferred();
    const originalList =
      fakeStripe.checkout.sessions.list.getMockImplementation();
    if (!originalList) throw new Error('Fake checkout list is not configured');
    let listCalls = 0;
    fakeStripe.checkout.sessions.list.mockImplementation((...args) => {
      listCalls += 1;
      const result = originalList(...args);
      if (listCalls !== 1) return result;
      return {
        autoPagingToArray: jest.fn().mockImplementation(async () => {
          originalSnapshotEntered.resolve();
          await releaseOriginalSnapshot.promise;
          return [];
        }),
      };
    });

    let original: ReturnType<NestFastifyApplication['inject']> | undefined;
    let recovery: ReturnType<NestFastifyApplication['inject']> | undefined;
    try {
      original = app.inject({
        method: 'POST',
        url: '/billing/checkout',
        headers: { authorization: `Bearer ${token}` },
        payload: { plan: 'SIGNAL' },
      });
      await originalSnapshotEntered.promise;
      const operation = await prisma.checkoutOperation.findFirstOrThrow({
        where: { userId: user.id },
      });
      await prisma.checkoutOperation.update({
        where: { id: operation.id },
        data: { leaseExpiresAt: new Date(Date.now() - 1_000) },
      });

      recovery = app.inject({
        method: 'POST',
        url: '/billing/checkout',
        headers: { authorization: `Bearer ${token}` },
        payload: { plan: 'SIGNAL' },
      });
      const recoveryResponse = await recovery;
      expect(recoveryResponse.statusCode).toBe(201);
      expect(fakeStripe.checkout.sessions.create).toHaveBeenCalledTimes(1);

      releaseOriginalSnapshot.resolve();
      const originalResponse = await original;
      expect(originalResponse.statusCode).toBe(409);
      expect(fakeStripe.checkout.sessions.create).toHaveBeenCalledTimes(1);
      await expect(
        prisma.checkoutOperation.count({ where: { userId: user.id } }),
      ).resolves.toBe(0);
    } finally {
      releaseOriginalSnapshot.resolve();
      await Promise.allSettled([
        ...(original ? [original] : []),
        ...(recovery ? [recovery] : []),
      ]);
      fakeStripe.checkout.sessions.list.mockImplementation(originalList);
    }
  });

  it('retains a superseded no-session operation until the conservative horizon', async () => {
    const token = await signup(app, email);
    const user = await prisma.user.findUniqueOrThrow({ where: { email } });
    await prisma.user.update({
      where: { id: user.id },
      data: {
        stripeCustomerId: fakeCustomerId,
        checkoutAttemptId: 'attempt_current',
        checkoutAttemptPlan: 'SIGNAL',
        checkoutAttemptInterval: 'month',
        checkoutAttemptCreatedAt: new Date(),
      },
    });
    await prisma.checkoutOperation.create({
      data: {
        id: '00000000-0000-4000-8000-000000000003',
        userId: user.id,
        attemptId: 'attempt_superseded',
        requestedPlan: 'SIGNAL',
        interval: 'month',
        leaseExpiresAt: new Date(Date.now() - 1_000),
      },
    });

    const response = await app.inject({
      method: 'POST',
      url: '/billing/portal',
      headers: { authorization: `Bearer ${token}` },
    });

    expect(response.statusCode).toBe(409);
    await expect(
      prisma.checkoutOperation.count({ where: { userId: user.id } }),
    ).resolves.toBe(1);
  });

  it('concurrent first checkout uses one versioned account idempotency key and persists stripeCustomerId', async () => {
    const token = await signup(app, email);
    const userId = (await prisma.user.findUniqueOrThrow({ where: { email } }))
      .id;
    const firstCustomerEntered = deferred();
    const secondCustomerEntered = deferred();
    const releaseFirstCustomer = deferred();
    const releaseSecondCustomer = deferred();
    let customerCallCount = 0;
    fakeStripe.customers.create.mockImplementation(async () => {
      customerCallCount += 1;
      if (customerCallCount === 1) {
        firstCustomerEntered.resolve();
        await releaseFirstCustomer.promise;
      } else {
        secondCustomerEntered.resolve();
        await releaseSecondCustomer.promise;
      }
      return { id: fakeCustomerId };
    });
    const advanceVersion = deferred();
    const rowLockAcquired = deferred();
    let blocker: Promise<void> | undefined;
    let firstRequest: ReturnType<NestFastifyApplication['inject']> | undefined;
    let secondRequest: ReturnType<NestFastifyApplication['inject']> | undefined;
    let first: Awaited<typeof firstRequest>;
    let second: Awaited<typeof secondRequest>;
    try {
      firstRequest = app.inject({
        method: 'POST',
        url: '/billing/checkout',
        headers: { authorization: `Bearer ${token}` },
        payload: { plan: 'SIGNAL' },
      });
      await firstCustomerEntered.promise;
      secondRequest = app.inject({
        method: 'POST',
        url: '/billing/checkout',
        headers: { authorization: `Bearer ${token}` },
        payload: { plan: 'SIGNAL' },
      });
      await secondCustomerEntered.promise;
      blocker = prisma.$transaction(
        async (tx) => {
          await tx.$queryRaw`
            SELECT id FROM users WHERE id = ${userId} FOR UPDATE
          `;
          rowLockAcquired.resolve();
          await advanceVersion.promise;
          await tx.user.update({
            where: { id: userId },
            data: { billingStateVersion: { increment: 1 } },
          });
        },
        { timeout: 15_000 },
      );
      await rowLockAcquired.promise;

      releaseFirstCustomer.resolve();
      await new Promise((resolve) => setTimeout(resolve, 50));
      advanceVersion.resolve();
      await blocker;
      releaseSecondCustomer.resolve();
      [first, second] = await Promise.all([firstRequest, secondRequest]);
    } finally {
      releaseFirstCustomer.resolve();
      releaseSecondCustomer.resolve();
      advanceVersion.resolve();
      await Promise.allSettled([
        ...(blocker ? [blocker] : []),
        ...(firstRequest ? [firstRequest] : []),
        ...(secondRequest ? [secondRequest] : []),
      ]);
    }

    const firstBody: unknown = JSON.parse(first.body);
    const secondBody: unknown = JSON.parse(second.body);
    expect([
      { statusCode: first.statusCode, body: firstBody },
      { statusCode: second.statusCode, body: secondBody },
    ]).toEqual([
      { statusCode: 201, body: { url: fakeCheckoutUrl } },
      { statusCode: 201, body: { url: fakeCheckoutUrl } },
    ]);

    expect([1, 2]).toContain(
      fakeStripe.checkout.sessions.create.mock.calls.length,
    );

    // customers.create must have been called (no existing stripeCustomerId)
    expect([1, 2]).toContain(fakeStripe.customers.create.mock.calls.length);

    // The authenticated account holder must have persisted stripeCustomerId.
    const user = await prisma.user.findUniqueOrThrow({
      where: { email },
    });
    expect(user.stripeCustomerId).toBe(fakeCustomerId);
    expect(fakeStripe.checkout.sessions.create).toHaveBeenNthCalledWith(
      1,
      expect.objectContaining({
        mode: 'subscription',
        line_items: [expect.objectContaining({ price: TEST_PRICE_SIGNAL })],
      }),
      {
        idempotencyKey: `account-checkout-v3:${user.checkoutAttemptId}`,
        timeout: 10_000,
      },
    );
    expect(fakeStripe.checkout.sessions.expire).not.toHaveBeenCalled();
    expect(fakeStripe.customers.create).toHaveBeenCalledWith(
      { email, metadata: { userId: user.id } },
      {
        idempotencyKey: `account-customer-v1:${user.id}`,
        timeout: 10_000,
      },
    );
  });

  it('blocks a differing concurrent request while the persisted attempt is unresolved', async () => {
    const token = await signup(app, email);
    const createEntered = deferred();
    const releaseCreate = deferred();
    const originalCreate =
      fakeStripe.checkout.sessions.create.getMockImplementation();
    if (!originalCreate)
      throw new Error('Fake checkout create is not configured');
    fakeStripe.checkout.sessions.create.mockImplementationOnce(
      async (...args: Parameters<typeof originalCreate>) => {
        createEntered.resolve();
        await releaseCreate.promise;
        return originalCreate(...args);
      },
    );
    let firstCheckout: ReturnType<NestFastifyApplication['inject']> | undefined;
    let firstResponse: Awaited<typeof firstCheckout>;
    try {
      firstCheckout = app.inject({
        method: 'POST',
        url: '/billing/checkout',
        headers: { authorization: `Bearer ${token}` },
        payload: { plan: 'SIGNAL', interval: 'month' },
      });
      await createEntered.promise;

      const unresolvedUser = await prisma.user.findUniqueOrThrow({
        where: { email },
      });
      expect(unresolvedUser.checkoutAttemptId).not.toBeNull();
      expect(unresolvedUser.checkoutAttemptPlan).toBe('SIGNAL');
      expect(unresolvedUser.checkoutAttemptInterval).toBe('month');
      expect(unresolvedUser.checkoutSessionId).toBeNull();
      expect(fakeStripe.checkoutSessions).toHaveLength(0);

      const differingCheckout = await app.inject({
        method: 'POST',
        url: '/billing/checkout',
        headers: { authorization: `Bearer ${token}` },
        payload: { plan: 'FLEET', interval: 'month' },
      });
      expect(differingCheckout.statusCode).toBe(409);
      expect(fakeStripe.checkout.sessions.create).toHaveBeenCalledTimes(1);
      expect(fakeStripe.checkoutSessions).toHaveLength(0);
    } finally {
      releaseCreate.resolve();
      firstResponse = await firstCheckout;
    }

    expect(firstResponse?.statusCode).toBe(201);
    expect(fakeStripe.checkout.sessions.create).toHaveBeenCalledTimes(1);
    expect(fakeStripe.checkout.sessions.expire).not.toHaveBeenCalled();
    const openSessions = fakeStripe.checkoutSessions.filter(
      ({ status }) => status === 'open',
    );
    expect(openSessions).toHaveLength(1);
    const user = await prisma.user.findUniqueOrThrow({ where: { email } });
    expect(openSessions[0].metadata.userId).toBe(user.id);
    expect(openSessions[0].metadata).toMatchObject({
      plan: 'SIGNAL',
      interval: 'month',
      attemptId: user.checkoutAttemptId,
    });
  });

  it('POST /billing/checkout with invalid plan returns 400', async () => {
    const token = await signup(app, email);

    const res = await app.inject({
      method: 'POST',
      url: '/billing/checkout',
      headers: { authorization: `Bearer ${token}` },
      payload: { plan: 'SOLO' },
    });

    expect(res.statusCode).toBe(400);
  });

  it('POST /billing/portal returns {url}', async () => {
    const token = await signup(app, email);
    const user = await prisma.user.update({
      where: { email },
      data: { stripeCustomerId: fakeCustomerId },
    });
    await prisma.subscription.update({
      where: { userId: user.id },
      data: { plan: 'SIGNAL', status: 'active' },
    });

    const res = await app.inject({
      method: 'POST',
      url: '/billing/portal',
      headers: { authorization: `Bearer ${token}` },
    });

    expect(res.statusCode).toBe(201);
    const body = JSON.parse(res.body) as { url: string };
    expect(body.url).toBe(fakePortalUrl);
    expect(fakeStripe.billingPortal.sessions.create).toHaveBeenCalled();
  });

  describe('account-session-only authorization', () => {
    it.each([
      ['checkout', { plan: 'SIGNAL' }],
      ['portal', undefined],
    ])(
      'rejects an API token on POST /billing/%s without calling Stripe',
      async (endpoint, payload) => {
        const jwt = await signup(app, email);
        const apiToken = await createApiToken(app, jwt);

        const response = await app.inject({
          method: 'POST',
          url: `/billing/${endpoint}`,
          headers: { authorization: `Bearer ${apiToken}` },
          payload,
        });

        expect([401, 403]).toContain(response.statusCode);
        expect(fakeStripe.customers.create).not.toHaveBeenCalled();
        expect(fakeStripe.checkout.sessions.create).not.toHaveBeenCalled();
        expect(fakeStripe.billingPortal.sessions.create).not.toHaveBeenCalled();
      },
    );

    it.each([
      ['checkout', { plan: 'SIGNAL' }],
      ['portal', undefined],
    ])(
      'rejects an impersonation JWT on POST /billing/%s with 403 without calling Stripe',
      async (endpoint, payload) => {
        await signup(app, email);
        const user = await prisma.user.findUniqueOrThrow({ where: { email } });
        const impersonationToken = jwtService.sign({
          sub: user.id,
          email: user.email,
          act: 'admin-test-actor',
        });

        const response = await app.inject({
          method: 'POST',
          url: `/billing/${endpoint}`,
          headers: { authorization: `Bearer ${impersonationToken}` },
          payload,
        });

        expect(response.statusCode).toBe(403);
        expect(fakeStripe.customers.create).not.toHaveBeenCalled();
        expect(fakeStripe.checkout.sessions.create).not.toHaveBeenCalled();
        expect(fakeStripe.billingPortal.sessions.create).not.toHaveBeenCalled();
      },
    );
  });

  it('POST /billing/webhook with valid signature updates Subscription plan', async () => {
    await signup(app, email);
    const user = await prisma.user.findUniqueOrThrow({
      where: { email },
    });
    await prisma.user.update({
      where: { id: user.id },
      data: { stripeCustomerId: fakeCustomerId },
    });

    const fakeEvent = {
      type: 'customer.subscription.updated',
      data: {
        object: {
          id: fakeSubscriptionId,
          customer: fakeCustomerId,
          status: 'active',
          items: {
            data: [{ price: { id: TEST_PRICE_SIGNAL } }],
          },
        },
      },
    };

    const rawBody = JSON.stringify(fakeEvent);
    const signature = fakeStripe.webhooks.generateTestHeaderString({
      payload: rawBody,
      secret: process.env.STRIPE_WEBHOOK_SECRET!,
    });
    fakeStripe.subscriptions.list.mockReturnValue({
      autoPagingToArray: jest.fn().mockResolvedValue([
        {
          id: fakeSubscriptionId,
          customer: fakeCustomerId,
          status: 'active',
          items: { data: [{ price: { id: TEST_PRICE_SIGNAL } }] },
        },
      ]),
    });

    const res = await app.inject({
      method: 'POST',
      url: '/billing/webhook',
      headers: {
        'content-type': 'application/json',
        'stripe-signature': signature,
      },
      body: rawBody,
    });

    expect(res.statusCode).toBe(201);
    const body = JSON.parse(res.body) as { received: boolean };
    expect(body.received).toBe(true);

    // Subscription must have been updated to SIGNAL
    const sub = await prisma.subscription.findUniqueOrThrow({
      where: { userId: user.id },
    });
    expect(sub.plan).toBe('SIGNAL');
    expect(sub.status).toBe('active');
    expect(sub.stripeSubscriptionId).toBe(fakeSubscriptionId);
  });

  it('mySubscription is account-scoped and returns effective limits and account totals', async () => {
    const token = await signup(app, email);
    const user = await prisma.user.findUniqueOrThrow({
      where: { email },
      include: {
        createdOrganizations: { include: { projects: true } },
      },
    });
    const firstProject = user.createdOrganizations[0].projects[0];
    const secondOrg = await prisma.organization.create({
      data: {
        name: 'Billing aggregate second org',
        slug: `billing-aggregate-${runId}`,
        creatorUserId: user.id,
        memberships: {
          create: { userId: user.id, role: 'OWNER' },
        },
        projects: {
          create: { name: 'Default', slug: 'default' },
        },
      },
      include: { projects: true },
    });
    await prisma.check.createMany({
      data: [
        {
          name: 'First org check',
          slug: 'first-org-check',
          type: 'HEARTBEAT',
          status: 'NEW',
          pingSlug: `billing-first-${runId}`,
          periodSeconds: 300,
          graceSeconds: 10,
          projectId: firstProject.id,
        },
        {
          name: 'Second org check one',
          slug: 'second-org-check-one',
          type: 'HEARTBEAT',
          status: 'NEW',
          pingSlug: `billing-second-one-${runId}`,
          periodSeconds: 300,
          graceSeconds: 10,
          projectId: secondOrg.projects[0].id,
        },
        {
          name: 'Second org check two',
          slug: 'second-org-check-two',
          type: 'HEARTBEAT',
          status: 'NEW',
          pingSlug: `billing-second-two-${runId}`,
          periodSeconds: 300,
          graceSeconds: 10,
          projectId: secondOrg.projects[0].id,
        },
      ],
    });
    await prisma.subscription.update({
      where: { userId: user.id },
      data: {
        plan: 'SIGNAL',
        limits: { maxChecks: 17, minIntervalSeconds: 1 },
      },
    });
    const result = await gql(
      app,
      token,
      `{ mySubscription {
        plan status maxChecks checkCount organizationCount
      } }`,
    );

    expect(result.errors).toBeUndefined();
    expect(result.data?.mySubscription).toEqual({
      plan: 'SIGNAL',
      status: 'active',
      maxChecks: 17,
      checkCount: 3,
      organizationCount: 2,
    });
  });

  it('POST /billing/webhook with bad signature returns 400 and does not mutate subscription', async () => {
    await signup(app, email);
    const user = await prisma.user.findUniqueOrThrow({ where: { email } });
    const sub = await prisma.subscription.findUniqueOrThrow({
      where: { userId: user.id },
    });
    const planBefore = sub.plan;

    const res = await app.inject({
      method: 'POST',
      url: '/billing/webhook',
      headers: {
        'content-type': 'application/json',
        'stripe-signature': 't=123,v1=bad-sig',
      },
      body: JSON.stringify({ bad: true }),
    });

    expect(res.statusCode).toBe(400);

    // Plan must be unchanged
    const subAfter = await prisma.subscription.findUniqueOrThrow({
      where: { userId: user.id },
    });
    expect(subAfter.plan).toBe(planBefore);
  });

  // ---------------------------------------------------------------------
  // Account isolation — organization input cannot redirect a billing action.
  // ---------------------------------------------------------------------

  describe('account isolation on checkout/portal', () => {
    let ownerToken: string;
    let memberToken: string;
    let ownerOrgId: string;

    beforeAll(async () => {
      ownerToken = await signup(app, ownerEmail);
      memberToken = await signup(app, memberEmail);

      const me = (await gql(app, ownerToken, ME_ORGS)) as unknown as MeOrgs;
      ownerOrgId = me.data.me.organizations[0].id;

      const invited = await gql(
        app,
        ownerToken,
        `mutation($organizationId: ID!, $email: String!, $role: String!) {
          inviteMember(organizationId: $organizationId, email: $email, role: $role) { token }
        }`,
        { organizationId: ownerOrgId, email: memberEmail, role: 'MEMBER' },
      );
      if (invited.errors) throw new Error(invited.errors[0].message);
      const inviteToken = (invited.data?.inviteMember as { token: string })
        .token;

      const accepted = await gql(
        app,
        memberToken,
        `mutation($token: String!) { acceptInvite(token: $token) { id role } }`,
        { token: inviteToken },
      );
      if (accepted.errors) throw new Error(accepted.errors[0].message);
      expect((accepted.data?.acceptInvite as { role: string }).role).toBe(
        'MEMBER',
      );
    });

    it("ignores an owner's organizationId and checks only the authenticated member's portal account", async () => {
      const res = await app.inject({
        method: 'POST',
        url: '/billing/portal',
        headers: { authorization: `Bearer ${memberToken}` },
        payload: { organizationId: ownerOrgId },
      });

      expect(res.statusCode).toBe(400);
      const body = JSON.parse(res.body) as { message: string };
      expect(body.message).toMatch(/no billing account/i);
    });

    it("checkout with another account's organizationId assigns only the authenticated account", async () => {
      const memberCustomerId = `${fakeCustomerId}_member`;
      fakeStripe.customers.create.mockResolvedValueOnce({
        id: memberCustomerId,
      });
      const res = await app.inject({
        method: 'POST',
        url: '/billing/checkout',
        headers: { authorization: `Bearer ${memberToken}` },
        payload: { plan: 'SIGNAL', organizationId: ownerOrgId },
      });

      expect(res.statusCode).toBe(201);
      const [owner, member] = await Promise.all([
        prisma.user.findUniqueOrThrow({ where: { email: ownerEmail } }),
        prisma.user.findUniqueOrThrow({ where: { email: memberEmail } }),
      ]);
      expect(owner.stripeCustomerId).toBeNull();
      expect(member.stripeCustomerId).toBe(memberCustomerId);
      expect(fakeStripe.customers.create).toHaveBeenLastCalledWith(
        {
          email: memberEmail,
          metadata: { userId: member.id },
        },
        {
          idempotencyKey: `account-customer-v1:${member.id}`,
          timeout: 10_000,
        },
      );
    });
  });
});
