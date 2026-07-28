import { buildApp } from '../src/main';
import type { NestFastifyApplication } from '@nestjs/platform-fastify';
import { PrismaService } from '../src/prisma/prisma.service';
import { JwtService } from '@nestjs/jwt';
import type Stripe from 'stripe';
import { BillingService } from '../src/billing/billing.service';
import { AccountEntitlementsService } from '../src/billing/account-entitlements.service';
import type { StripePriceRegistry } from '../src/billing/stripe-price-registry';

const adminEmail = 'admin-subs-admin@systemvitals.test';
const userEmail = 'admin-subs-user@systemvitals.test';

async function signup(
  app: NestFastifyApplication,
  email: string,
): Promise<string> {
  const res = await app.inject({
    method: 'POST',
    url: '/auth/signup',
    payload: { email, password: 'supersecret1!' },
  });
  return (JSON.parse(res.body) as { token: string }).token;
}

async function adminGql(
  app: NestFastifyApplication,
  token: string,
  query: string,
  variables?: Record<string, unknown>,
): Promise<{ data?: Record<string, unknown>; errors?: { message: string }[] }> {
  const res = await app.inject({
    method: 'POST',
    url: '/admin/graphql',
    payload: { query, variables },
    headers: {
      authorization: `Bearer ${token}`,
      'content-type': 'application/json',
    },
  });
  return JSON.parse(res.body) as {
    data?: Record<string, unknown>;
    errors?: { message: string }[];
  };
}

describe('admin subscriptions (e2e)', () => {
  let app: NestFastifyApplication;
  let prisma: PrismaService;
  let jwtService: JwtService;
  let adminToken: string;
  let adminId: string;
  let userId: string;
  let organizationId: string;

  function billingWithAuthoritativePlan(plan: 'SIGNAL' | 'FLEET') {
    const priceId = plan === 'FLEET' ? 'price_fleet' : 'price_signal';
    const stripe = {
      subscriptions: {
        list: jest.fn().mockReturnValue({
          autoPagingToArray: jest.fn().mockResolvedValue([
            {
              id: `sub_${plan.toLowerCase()}`,
              customer: 'cus_admin_test',
              status: 'active',
              items: { data: [{ price: { id: priceId } }] },
            },
          ]),
        }),
      },
    };
    const prices = {
      planForPriceId: jest.fn((id: string) => {
        if (id === 'price_signal') return 'SIGNAL';
        if (id === 'price_fleet') return 'FLEET';
        return undefined;
      }),
    };
    return new BillingService(
      stripe as unknown as Stripe,
      prisma,
      prices as unknown as StripePriceRegistry,
      new AccountEntitlementsService(prisma),
    );
  }

  async function deleteFixtureAccounts() {
    const users = await prisma.user.findMany({
      where: { email: { in: [adminEmail, userEmail] } },
      select: { id: true },
    });
    const userIds = users.map((user) => user.id);
    await prisma.$transaction([
      prisma.organization.deleteMany({
        where: { creatorUserId: { in: userIds } },
      }),
      prisma.user.deleteMany({ where: { id: { in: userIds } } }),
    ]);
  }

  beforeAll(async () => {
    app = await buildApp();
    await app.init();
    await app.getHttpAdapter().getInstance().ready();

    prisma = app.get(PrismaService);
    jwtService = app.get(JwtService);

    // Clean up leftover test users
    await deleteFixtureAccounts();

    // Sign up regular user (creates an org)
    await signup(app, userEmail);
    await signup(app, adminEmail);

    // Promote admin
    const adminUser = await prisma.user.findUniqueOrThrow({
      where: { email: adminEmail },
    });
    adminId = adminUser.id;
    await prisma.user.update({
      where: { id: adminUser.id },
      data: { isAdmin: true },
    });
    adminToken = jwtService.sign({ sub: adminUser.id, email: adminEmail });

    // Find the user's org
    const userUser = await prisma.user.findUniqueOrThrow({
      where: { email: userEmail },
    });
    userId = userUser.id;
    organizationId = (
      await prisma.organization.findFirstOrThrow({
        where: { creatorUserId: userId },
        select: { id: true },
      })
    ).id;
  });

  afterAll(async () => {
    await deleteFixtureAccounts();
    await app.close();
  });

  // ─── adminSubscriptions query ─────────────────────────────────────────────────

  it('adminSubscriptions returns list', async () => {
    const body = await adminGql(
      app,
      adminToken,
      `{ adminSubscriptions {
        items {
          id
          userId
          userEmail
          plan
          status
          manualOverride
          limitsJson
          stripeSubscriptionId
          createdAt
        }
        total
      } }`,
    );
    expect(body.errors).toBeUndefined();
    const list = body.data?.adminSubscriptions as {
      items: unknown[];
      total: number;
    };
    expect(list.total).toBeGreaterThanOrEqual(2);
    expect(
      (list.items as Array<{ userId: string; userEmail: string }>).find(
        (item) => item.userId === userId,
      ),
    ).toMatchObject({ userId, userEmail });
  });

  it('omits legacy organization-only subscription sentinels', async () => {
    const sentinel = await prisma.subscription.create({
      data: { organizationId, plan: 'FLEET', status: 'active' },
    });
    try {
      const body = await adminGql(
        app,
        adminToken,
        `{ adminSubscriptions { items { userId userEmail } total } }`,
      );
      expect(body.errors).toBeUndefined();
      const list = body.data?.adminSubscriptions as {
        items: Array<{ userId: string; userEmail: string }>;
        total: number;
      };
      expect(list.items.every((item) => item.userId && item.userEmail)).toBe(
        true,
      );
      const organizationBody = await adminGql(
        app,
        adminToken,
        `query($id: ID!) { adminOrganization(id: $id) { id plan } }`,
        { id: organizationId },
      );
      expect(organizationBody.errors).toBeUndefined();
      expect(
        (organizationBody.data?.adminOrganization as { plan: string }).plan,
      ).toBe('SOLO');
    } finally {
      await prisma.subscription.deleteMany({ where: { id: sentinel.id } });
    }
    expect(
      await prisma.subscription.findUnique({ where: { id: sentinel.id } }),
    ).toBeNull();
    expect(
      await prisma.subscription.findUnique({ where: { userId } }),
    ).not.toBeNull();
  });

  // ─── adminSetUserPlan mutation ─────────────────────────────────────────────────

  it('adminSetUserPlan updates the account plan and audits the user target', async () => {
    const auditsBefore = await prisma.auditLog.count({
      where: { actorUserId: adminId },
    });

    const body = await adminGql(
      app,
      adminToken,
      `mutation($userId: ID!, $plan: String!, $limitsJson: String, $manualOverride: Boolean) {
        adminSetUserPlan(userId: $userId, plan: $plan, limitsJson: $limitsJson, manualOverride: $manualOverride) {
          id
          userId
          userEmail
          plan
        }
      }`,
      {
        userId,
        plan: 'SIGNAL',
        limitsJson: JSON.stringify({ maxChecks: 999, minIntervalSeconds: 10 }),
        manualOverride: true,
      },
    );

    expect(body.errors).toBeUndefined();
    const subscription = body.data?.adminSetUserPlan as {
      userId: string;
      userEmail: string;
      plan: string;
    };
    expect(subscription).toMatchObject({ userId, userEmail, plan: 'SIGNAL' });

    // Verify subscription in DB
    const sub = await prisma.subscription.findUnique({
      where: { userId },
    });
    expect(sub?.plan).toBe('SIGNAL');
    expect(sub?.manualOverride).toBe(true);
    expect(sub?.limits).toMatchObject({
      maxChecks: 999,
      minIntervalSeconds: 10,
    });

    // Audit log was written
    const auditsAfter = await prisma.auditLog.count({
      where: { actorUserId: adminId },
    });
    expect(auditsAfter).toBeGreaterThan(auditsBefore);

    const auditRow = await prisma.auditLog.findFirst({
      where: { action: 'user.setPlan', targetType: 'user', targetId: userId },
      orderBy: { createdAt: 'desc' },
    });
    expect(auditRow).not.toBeNull();
    const meta = auditRow!.metadata as Record<string, unknown>;
    expect((meta.after as Record<string, unknown>).plan).toBe('SIGNAL');
    expect((meta.after as Record<string, unknown>).manualOverride).toBe(true);
  });

  it('adminSetUserPlan rejects invalid JSON', async () => {
    const body = await adminGql(
      app,
      adminToken,
      `mutation($userId: ID!, $plan: String!, $limitsJson: String) {
        adminSetUserPlan(userId: $userId, plan: $plan, limitsJson: $limitsJson) { id }
      }`,
      { userId, plan: 'SOLO', limitsJson: 'not-json' },
    );
    expect(body.errors).toBeDefined();
    expect(body.errors![0].message).toMatch(/not valid JSON/);
  });

  it.each([
    '{"unknown":1}',
    '{"maxChecks":0}',
    '{"maxChecks":-1}',
    '{"maxChecks":1.5}',
    '{"maxChecks":"1"}',
    '{"maxChecks":1e400}',
    '{"minIntervalSeconds":0}',
    '{"minIntervalSeconds":-1}',
    '{"minIntervalSeconds":1.5}',
    '{"minIntervalSeconds":"1"}',
  ])('adminSetUserPlan rejects invalid limits %s', async (limitsJson) => {
    const body = await adminGql(
      app,
      adminToken,
      `mutation($userId: ID!, $plan: String!, $limitsJson: String) {
        adminSetUserPlan(userId: $userId, plan: $plan, limitsJson: $limitsJson) { id }
      }`,
      { userId, plan: 'SOLO', limitsJson },
    );
    expect(body.errors?.[0]?.message).toMatch(
      /unsupported key|positive integer/,
    );
  });

  it.each([null, '{}'])(
    'adminSetUserPlan treats %s as clearing custom limits',
    async (limitsJson) => {
      const body = await adminGql(
        app,
        adminToken,
        `mutation($userId: ID!, $plan: String!, $limitsJson: String) {
          adminSetUserPlan(userId: $userId, plan: $plan, limitsJson: $limitsJson) { id }
        }`,
        { userId, plan: 'SOLO', limitsJson },
      );
      expect(body.errors).toBeUndefined();
      expect(
        (await prisma.subscription.findUnique({ where: { userId } }))?.limits,
      ).toBeNull();
    },
  );

  // ─── webhook guard ────────────────────────────────────────────────────────────

  it.each([
    {
      manualOverride: true,
      expectedPlan: 'FLEET',
      expectedLimits: { maxChecks: 77, minIntervalSeconds: 7 },
    },
    {
      manualOverride: false,
      expectedPlan: 'SIGNAL',
      expectedLimits: { maxChecks: 77, minIntervalSeconds: 7 },
    },
  ])(
    'applies authoritative Stripe state with manualOverride=$manualOverride',
    async ({ manualOverride, expectedPlan, expectedLimits }) => {
      await prisma.user.update({
        where: { id: userId },
        data: { stripeCustomerId: 'cus_admin_test' },
      });
      await prisma.subscription.update({
        where: { userId },
        data: {
          plan: 'FLEET',
          limits: expectedLimits,
          manualOverride,
        },
      });

      await billingWithAuthoritativePlan('SIGNAL').applySubscriptionEvent(
        'cus_admin_test',
      );

      const subscription = await prisma.subscription.findUniqueOrThrow({
        where: { userId },
      });
      expect(subscription.plan).toBe(expectedPlan);
      expect(subscription.limits).toEqual(expectedLimits);
      expect(subscription.stripeSubscriptionId).toBe('sub_signal');
      expect(subscription.status).toBe('active');
    },
  );
});
