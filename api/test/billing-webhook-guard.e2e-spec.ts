/**
 * E2E tests for BillingService.applySubscriptionEvent — the extracted method
 * that enforces the manualOverride guard when syncing Stripe subscription events.
 *
 * We call applySubscriptionEvent() directly so the test exercises the actual
 * guard logic (not a raw prisma.subscription.update bypass like the old no-op).
 */

import { Test } from '@nestjs/testing';
import {
  FastifyAdapter,
  NestFastifyApplication,
} from '@nestjs/platform-fastify';
import { ValidationPipe } from '@nestjs/common';
import { AppModule } from '../src/app.module';
import { STRIPE_CLIENT } from '../src/billing/stripe.provider';
import { BillingService } from '../src/billing/billing.service';
import { PrismaService } from '../src/prisma/prisma.service';

// ---------------------------------------------------------------------------
// Minimal Stripe stub — we only need customers.create for signup lifecycle
// ---------------------------------------------------------------------------
function buildFakeStripe() {
  return {
    customers: {
      create: jest.fn().mockResolvedValue({ id: 'cus_guard_stub' }),
    },
    subscriptions: {
      list: jest.fn(),
    },
    checkout: {
      sessions: {
        create: jest
          .fn()
          .mockResolvedValue({ url: 'https://checkout.stripe.com/stub' }),
      },
    },
    billingPortal: {
      sessions: {
        create: jest
          .fn()
          .mockResolvedValue({ url: 'https://billing.stripe.com/stub' }),
      },
    },
    webhooks: {
      constructEvent: jest.fn(),
    },
  };
}

// ---------------------------------------------------------------------------
// Unique email/customerId per run to avoid DB collision on reruns
// ---------------------------------------------------------------------------
const runId = Date.now();
const testEmail = `webhook-guard-${runId}@systemvitals.test`;
const fakeCustomerId = `cus_guard_test_${runId}`;
const fakeSubId = `sub_guard_test_${runId}`;
const originalSignalPrice = process.env.STRIPE_PRICE_SIGNAL;
process.env.STRIPE_PRICE_SIGNAL = 'price_guard_signal';

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

// ---------------------------------------------------------------------------
// Suite
// ---------------------------------------------------------------------------

describe('BillingService.applySubscriptionEvent — webhook guard (e2e)', () => {
  let app: NestFastifyApplication;
  let prisma: PrismaService;
  let billingService: BillingService;
  let fakeStripe: ReturnType<typeof buildFakeStripe>;
  let userId: string;

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
    billingService = app.get(BillingService);

    // Clean up any leftover from a previous run
    await prisma.organization.deleteMany({
      where: { creator: { email: testEmail } },
    });
    await prisma.user.deleteMany({ where: { email: testEmail } });

    // Sign up to create user → org → subscription (lifecycle)
    await signup(app, testEmail);

    const user = await prisma.user.findUniqueOrThrow({
      where: { email: testEmail },
    });
    userId = user.id;

    await prisma.user.update({
      where: { id: userId },
      data: { stripeCustomerId: fakeCustomerId },
    });
  });

  afterAll(async () => {
    await prisma.organization.deleteMany({
      where: { creator: { email: testEmail } },
    });
    await prisma.user.deleteMany({ where: { email: testEmail } });
    await app.close();
  });

  afterAll(() => {
    if (originalSignalPrice === undefined) {
      delete process.env.STRIPE_PRICE_SIGNAL;
    } else {
      process.env.STRIPE_PRICE_SIGNAL = originalSignalPrice;
    }
  });

  // ─── Guard active: plan must NOT be clobbered ────────────────────────────────

  it('when manualOverride=true, plan is NOT overwritten but status/stripeSubscriptionId ARE updated', async () => {
    // Set override + plan=FLEET via prisma (simulating a prior admin action)
    await prisma.subscription.update({
      where: { userId },
      data: { plan: 'FLEET', manualOverride: true },
    });

    fakeStripe.subscriptions.list.mockReturnValue({
      autoPagingToArray: jest.fn().mockResolvedValue([
        {
          id: fakeSubId,
          customer: fakeCustomerId,
          status: 'active',
          items: { data: [{ price: { id: 'price_guard_signal' } }] },
        },
      ]),
    });
    await billingService.applySubscriptionEvent(fakeCustomerId);

    const sub = await prisma.subscription.findUniqueOrThrow({
      where: { userId },
    });

    // Guard must have blocked the plan clobber
    expect(sub.plan).toBe('FLEET');
    expect(sub.manualOverride).toBe(true);

    // But status + stripeSubscriptionId must have been updated
    expect(sub.status).toBe('active');
    expect(sub.stripeSubscriptionId).toBe(fakeSubId);
  });

  // ─── Guard inactive: plan MUST sync from Stripe ──────────────────────────────

  it('when manualOverride=false, plan IS synced from the Stripe event', async () => {
    // Disable override
    await prisma.subscription.update({
      where: { userId },
      data: { manualOverride: false },
    });

    // Simulate Stripe sending a SIGNAL upgrade event
    const newSubId = `${fakeSubId}_updated`;
    fakeStripe.subscriptions.list.mockReturnValue({
      autoPagingToArray: jest.fn().mockResolvedValue([
        {
          id: newSubId,
          customer: fakeCustomerId,
          status: 'active',
          items: { data: [{ price: { id: 'price_guard_signal' } }] },
        },
      ]),
    });
    await billingService.applySubscriptionEvent(fakeCustomerId);

    const sub = await prisma.subscription.findUniqueOrThrow({
      where: { userId },
    });

    // Plan must now reflect the Stripe event
    expect(sub.plan).toBe('SIGNAL');
    expect(sub.status).toBe('active');
    expect(sub.stripeSubscriptionId).toBe(newSubId);
  });
});
