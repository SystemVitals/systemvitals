import {
  BadRequestException,
  ConflictException,
  Inject,
  Injectable,
} from '@nestjs/common';
import { randomUUID } from 'node:crypto';
import Stripe from 'stripe';
import { STRIPE_CLIENT } from './stripe.provider';
import { PrismaService } from '../prisma/prisma.service';
import type { PlanTier } from './plan-limits';
import { StripePriceRegistry } from './stripe-price-registry';
import type { BillingInterval, PaidPlan } from './plan-pricing';
import { AccountEntitlementsService } from './account-entitlements.service';

const STRIPE_CUSTOMER_IDEMPOTENCY_VERSION = 'v1';
const STRIPE_CHECKOUT_IDEMPOTENCY_VERSION = 'v3';
const STRIPE_PORTAL_IDEMPOTENCY_VERSION = 'v1';
const STRIPE_IDEMPOTENCY_RETENTION_MS = 24 * 60 * 60 * 1000;
const BILLING_TRANSACTION_MAX_WAIT_MS = 5_000;
const BILLING_TRANSACTION_TIMEOUT_MS = 15_000;
const STRIPE_REQUEST_TIMEOUT_MS = 10_000;
const CHECKOUT_OPERATION_LEASE_MS = 2 * 60 * 1000;
const CHECKOUT_OPERATION_ABANDON_HORIZON_MS =
  STRIPE_IDEMPOTENCY_RETENTION_MS + CHECKOUT_OPERATION_LEASE_MS;
const BILLING_SNAPSHOT_MAX_ATTEMPTS = 3;
const BILLING_TRANSACTION_OPTIONS = {
  maxWait: BILLING_TRANSACTION_MAX_WAIT_MS,
  timeout: BILLING_TRANSACTION_TIMEOUT_MS,
} as const;
const RELEVANT_SUBSCRIPTION_STATUSES = new Set([
  'active',
  'trialing',
  'past_due',
]);
const PLAN_RANK: Record<PlanTier, number> = {
  SOLO: 0,
  SIGNAL: 1,
  FLEET: 2,
};

interface AuthoritativeSubscriptionState {
  plan: PlanTier;
  stripeSubscriptionId: string | null;
  status: string;
}

interface StripeSubscriptionSnapshot {
  id: string;
  status: string;
  items: { data: Array<{ price: { id: string } }> };
}

interface StripeCheckoutSessionSnapshot {
  id: string;
  created: number;
  metadata: Record<string, string>;
  mode: string | null;
  status: string | null;
  url: string | null;
}

@Injectable()
export class BillingService {
  constructor(
    @Inject(STRIPE_CLIENT) private readonly stripe: Stripe,
    private readonly prisma: PrismaService,
    private readonly prices: StripePriceRegistry,
    private readonly entitlements: AccountEntitlementsService,
  ) {}

  // Read lazily (at call time, not constructor time) so tests can set env vars
  // before the service methods are called — env vars set at test-file module
  // level are visible here as long as they're assigned before describe() blocks.
  private get webhookSecret(): string {
    return process.env.STRIPE_WEBHOOK_SECRET ?? '';
  }

  private get appUrl(): string {
    return process.env.APP_URL ?? 'http://localhost:9999';
  }

  private async ensureCustomer(user: {
    id: string;
    email: string;
    stripeCustomerId: string | null;
    billingStateVersion: number;
  }): Promise<string> {
    if (user.stripeCustomerId) {
      return user.stripeCustomerId;
    }

    const customer = await this.stripe.customers.create(
      {
        email: user.email,
        metadata: { userId: user.id },
      },
      {
        idempotencyKey: `account-customer-${STRIPE_CUSTOMER_IDEMPOTENCY_VERSION}:${user.id}`,
        timeout: STRIPE_REQUEST_TIMEOUT_MS,
      },
    );

    for (let attempt = 0; attempt < BILLING_SNAPSHOT_MAX_ATTEMPTS; attempt++) {
      const snapshot = await this.prisma.user.findUnique({
        where: { id: user.id },
        select: { stripeCustomerId: true, billingStateVersion: true },
      });
      if (!snapshot) {
        throw new ConflictException('Billing state changed; retry checkout');
      }
      if (snapshot.stripeCustomerId) return snapshot.stripeCustomerId;
      const assigned = await this.prisma.$transaction(async (tx) => {
        await this.entitlements.lockUsers(tx, [user.id]);
        const current = await tx.user.findUnique({
          where: { id: user.id },
          select: { stripeCustomerId: true, billingStateVersion: true },
        });
        if (current?.stripeCustomerId) return current.stripeCustomerId;
        if (
          !current ||
          current.billingStateVersion !== snapshot.billingStateVersion
        ) {
          return null;
        }
        await tx.user.update({
          where: { id: user.id },
          data: {
            stripeCustomerId: customer.id,
            billingStateVersion: { increment: 1 },
          },
        });
        return customer.id;
      }, BILLING_TRANSACTION_OPTIONS);
      if (assigned) return assigned;
    }
    throw new ConflictException('Billing state changed; retry checkout');
  }

  // -------------------------------------------------------------------------
  // Price → plan tier mapping
  // -------------------------------------------------------------------------

  private priceToPlan(priceId: string): PlanTier {
    const plan = this.prices.planForPriceId(priceId);
    if (!plan) {
      throw new Error(`Unknown active Stripe price: ${priceId}`);
    }
    return plan;
  }

  private planToPrice(plan: PaidPlan, interval: BillingInterval): string {
    return this.prices.priceIdFor(plan, interval);
  }

  private async listRelevantSubscriptions(
    stripeCustomerId: string,
  ): Promise<StripeSubscriptionSnapshot[]> {
    const subscriptions = await this.stripe.subscriptions
      .list(
        {
          customer: stripeCustomerId,
          status: 'all',
          limit: 100,
        },
        { timeout: STRIPE_REQUEST_TIMEOUT_MS },
      )
      .autoPagingToArray({ limit: 10_000 });
    return subscriptions.filter(({ status }) =>
      RELEVANT_SUBSCRIPTION_STATUSES.has(status),
    );
  }

  private resolveAuthoritativeState(
    subscriptions: StripeSubscriptionSnapshot[],
  ): AuthoritativeSubscriptionState {
    if (subscriptions.length === 0) {
      return {
        plan: 'SOLO',
        stripeSubscriptionId: null,
        status: 'canceled',
      };
    }

    const ranked = subscriptions.map((subscription) => {
      const plans = subscription.items.data.map(({ price }) =>
        this.priceToPlan(price.id),
      );
      if (plans.length === 0) {
        throw new Error(
          `Active Stripe subscription ${subscription.id} has no price`,
        );
      }
      const plan = plans.reduce((highest, candidate) =>
        PLAN_RANK[candidate] > PLAN_RANK[highest] ? candidate : highest,
      );
      return { subscription, plan };
    });
    ranked.sort(
      (left, right) =>
        PLAN_RANK[right.plan] - PLAN_RANK[left.plan] ||
        left.subscription.id.localeCompare(right.subscription.id),
    );
    const winner = ranked[0];
    return {
      plan: winner.plan,
      stripeSubscriptionId: winner.subscription.id,
      status: winner.subscription.status,
    };
  }

  private async listAccountCheckoutSessions(
    stripeCustomerId: string,
    userId: string,
  ): Promise<StripeCheckoutSessionSnapshot[]> {
    const sessions = await this.stripe.checkout.sessions
      .list(
        { customer: stripeCustomerId, limit: 100 },
        { timeout: STRIPE_REQUEST_TIMEOUT_MS },
      )
      .autoPagingToArray({ limit: 10_000 });
    return sessions
      .filter(
        (session) =>
          session.mode === 'subscription' &&
          session.metadata?.userId === userId,
      )
      .map((session) => ({
        id: session.id,
        created: session.created,
        metadata: session.metadata ?? {},
        mode: session.mode,
        status: session.status,
        url: session.url,
      }))
      .sort(
        (left, right) =>
          right.created - left.created || right.id.localeCompare(left.id),
      );
  }

  private checkoutAttemptKey(attemptId: string): string {
    return `account-checkout-${STRIPE_CHECKOUT_IDEMPOTENCY_VERSION}:${attemptId}`;
  }

  private async reconcileCheckoutCleanup(userId: string): Promise<void> {
    const pending = await this.prisma.checkoutCleanupIntent.findMany({
      where: { userId },
      orderBy: [{ createdAt: 'asc' }, { id: 'asc' }],
    });
    let firstError: unknown;
    for (const intent of pending) {
      const alreadyOwned = await this.prisma.$transaction(async (tx) => {
        await this.entitlements.lockUsers(tx, [userId]);
        const user = await tx.user.findUnique({
          where: { id: userId },
          select: { checkoutSessionId: true },
        });
        if (user?.checkoutSessionId !== intent.stripeSessionId) return false;
        const deleted = await tx.checkoutCleanupIntent.deleteMany({
          where: { id: intent.id, userId },
        });
        if (deleted.count > 0) {
          await tx.user.update({
            where: { id: userId },
            data: { billingStateVersion: { increment: 1 } },
          });
        }
        return true;
      }, BILLING_TRANSACTION_OPTIONS);
      if (alreadyOwned) continue;
      let status: string;
      try {
        let session = await this.stripe.checkout.sessions.retrieve(
          intent.stripeSessionId,
          {},
          { timeout: STRIPE_REQUEST_TIMEOUT_MS },
        );
        if (session.status === 'open') {
          session = await this.stripe.checkout.sessions.expire(
            intent.stripeSessionId,
            {},
            { timeout: STRIPE_REQUEST_TIMEOUT_MS },
          );
        }
        status = session.status ?? '';
      } catch (error) {
        if (
          typeof error === 'object' &&
          error !== null &&
          'code' in error &&
          error.code === 'resource_missing'
        ) {
          status = 'expired';
        } else {
          firstError ??= error;
          continue;
        }
      }
      if (status !== 'expired' && status !== 'complete') {
        firstError ??= new ConflictException(
          'Checkout cleanup is still pending; retry',
        );
        continue;
      }
      await this.prisma.$transaction(async (tx) => {
        await this.entitlements.lockUsers(tx, [userId]);
        const deleted = await tx.checkoutCleanupIntent.deleteMany({
          where: { id: intent.id, userId },
        });
        if (deleted.count > 0) {
          await tx.user.update({
            where: { id: userId },
            data: { billingStateVersion: { increment: 1 } },
          });
        }
      }, BILLING_TRANSACTION_OPTIONS);
    }
    if (firstError instanceof Error) throw firstError;
    if (firstError) throw new Error('Checkout cleanup failed');
  }

  private async completeCheckoutOperation(
    userId: string,
    operationId: string,
    ownerToken: string,
  ): Promise<void> {
    await this.prisma.$transaction(async (tx) => {
      await this.entitlements.lockUsers(tx, [userId]);
      const deleted = await tx.checkoutOperation.deleteMany({
        where: { id: operationId, userId, ownerToken },
      });
      if (deleted.count > 0) {
        await tx.user.update({
          where: { id: userId },
          data: { billingStateVersion: { increment: 1 } },
        });
      }
    }, BILLING_TRANSACTION_OPTIONS);
  }

  private isDefinitiveCheckoutCreateFailure(error: unknown): boolean {
    if (typeof error !== 'object' || error === null) return false;
    const candidate = error as { type?: unknown; statusCode?: unknown };
    return (
      candidate.type === 'StripeInvalidRequestError' &&
      typeof candidate.statusCode === 'number' &&
      candidate.statusCode >= 400 &&
      candidate.statusCode < 500 &&
      ![408, 409, 429].includes(candidate.statusCode)
    );
  }

  private portalOperationKey(operationId: string): string {
    return `account-portal-${STRIPE_PORTAL_IDEMPOTENCY_VERSION}:${operationId}`;
  }

  private async createStripePortalSession(input: {
    operationId: string;
    customerId: string;
    returnUrl: string;
  }) {
    return this.stripe.billingPortal.sessions.create(
      {
        customer: input.customerId,
        return_url: input.returnUrl,
      },
      {
        idempotencyKey: this.portalOperationKey(input.operationId),
        timeout: STRIPE_REQUEST_TIMEOUT_MS,
      },
    );
  }

  private async markCheckoutOperationUncertain(
    userId: string,
    operationId: string,
    ownerToken: string,
  ): Promise<void> {
    await this.prisma.$transaction(async (tx) => {
      await this.entitlements.lockUsers(tx, [userId]);
      const updated = await tx.checkoutOperation.updateMany({
        where: { id: operationId, userId, ownerToken },
        data: { state: 'UNCERTAIN' },
      });
      if (updated.count > 0) {
        await tx.user.update({
          where: { id: userId },
          data: { billingStateVersion: { increment: 1 } },
        });
      }
    }, BILLING_TRANSACTION_OPTIONS);
  }

  private async createStripeCheckoutSession(input: {
    customerId: string;
    userId: string;
    plan: PaidPlan;
    interval: BillingInterval;
    attemptId: string;
    priceId: string;
    successUrl: string;
    cancelUrl: string;
  }) {
    return this.stripe.checkout.sessions.create(
      {
        mode: 'subscription',
        customer: input.customerId,
        line_items: [{ price: input.priceId, quantity: 1 }],
        metadata: {
          userId: input.userId,
          plan: input.plan,
          interval: input.interval,
          attemptId: input.attemptId,
        },
        success_url: input.successUrl,
        cancel_url: input.cancelUrl,
      },
      {
        idempotencyKey: this.checkoutAttemptKey(input.attemptId),
        timeout: STRIPE_REQUEST_TIMEOUT_MS,
      },
    );
  }

  private async persistReturnedCheckoutSession(input: {
    userId: string;
    operationId: string;
    ownerToken: string;
    attemptId: string;
    session: Stripe.Checkout.Session;
  }): Promise<'owned' | 'cleanup' | 'stale'> {
    return this.prisma.$transaction(async (tx) => {
      await this.entitlements.lockUsers(tx, [input.userId]);
      const operation = await tx.checkoutOperation.findUnique({
        where: { id: input.operationId },
        select: { ownerToken: true },
      });
      const hasFence = operation?.ownerToken === input.ownerToken;
      const owned =
        input.session.url && hasFence
          ? await tx.user.updateMany({
              where: {
                id: input.userId,
                checkoutAttemptId: input.attemptId,
              },
              data: {
                checkoutSessionId: input.session.id,
                checkoutSessionUrl: input.session.url,
                checkoutSessionExpiresAt: input.session.expires_at
                  ? new Date(input.session.expires_at * 1000)
                  : null,
                billingStateVersion: { increment: 1 },
              },
            })
          : { count: 0 };
      if (owned.count > 0) {
        await tx.checkoutCleanupIntent.deleteMany({
          where: {
            userId: input.userId,
            stripeSessionId: input.session.id,
          },
        });
        await tx.checkoutOperation.deleteMany({
          where: {
            id: input.operationId,
            userId: input.userId,
            ownerToken: input.ownerToken,
          },
        });
        return 'owned';
      }
      await tx.checkoutCleanupIntent.upsert({
        where: { stripeSessionId: input.session.id },
        create: {
          userId: input.userId,
          stripeSessionId: input.session.id,
        },
        update: {},
      });
      if (hasFence) {
        await tx.checkoutOperation.deleteMany({
          where: {
            id: input.operationId,
            userId: input.userId,
            ownerToken: input.ownerToken,
          },
        });
      }
      await tx.user.update({
        where: { id: input.userId },
        data: { billingStateVersion: { increment: 1 } },
      });
      return hasFence ? 'cleanup' : 'stale';
    }, BILLING_TRANSACTION_OPTIONS);
  }

  private async reconcileCheckoutOperations(
    userId: string,
  ): Promise<{ recoveredPortalUrl?: string }> {
    const hasExpiredOperation =
      (
        await this.prisma.checkoutOperation.findMany({
          where: { userId, leaseExpiresAt: { lte: new Date() } },
          select: { id: true },
          take: 1,
        })
      ).length > 0;
    if (!hasExpiredOperation) return {};
    for (let attempt = 0; attempt < BILLING_SNAPSHOT_MAX_ATTEMPTS; attempt++) {
      const snapshot = await this.prisma.user.findUnique({
        where: { id: userId },
        select: {
          stripeCustomerId: true,
          billingStateVersion: true,
        },
      });
      if (!snapshot) return {};
      const sessions = snapshot.stripeCustomerId
        ? await this.listAccountCheckoutSessions(
            snapshot.stripeCustomerId,
            userId,
          )
        : [];
      type ReconciliationResult =
        | { kind: 'stale' }
        | { kind: 'done' }
        | {
            kind: 'recover-checkout';
            operationId: string;
            ownerToken: string;
            attemptId: string;
            plan: PaidPlan;
            interval: BillingInterval;
            priceId: string;
            successUrl: string;
            cancelUrl: string;
          }
        | {
            kind: 'recover-portal';
            operationId: string;
            ownerToken: string;
            customerId: string;
            returnUrl: string;
          };
      const result = await this.prisma.$transaction<ReconciliationResult>(
        async (tx) => {
          await this.entitlements.lockUsers(tx, [userId]);
          const current = await tx.user.findUnique({
            where: { id: userId },
            select: {
              stripeCustomerId: true,
              billingStateVersion: true,
              checkoutAttemptId: true,
            },
          });
          if (
            !current ||
            current.stripeCustomerId !== snapshot.stripeCustomerId ||
            current.billingStateVersion !== snapshot.billingStateVersion
          ) {
            return { kind: 'stale' };
          }
          const now = new Date();
          const expired = await tx.checkoutOperation.findMany({
            where: { userId, leaseExpiresAt: { lte: now } },
            orderBy: [{ createdAt: 'asc' }, { id: 'asc' }],
          });
          let changed = false;
          let recovery: ReconciliationResult | undefined;
          for (const operation of expired) {
            if (operation.operationKind === 'PORTAL') {
              const hasExactParameters =
                operation.stripeCustomerId !== null &&
                operation.portalReturnUrl !== null;
              if (
                !hasExactParameters ||
                current.stripeCustomerId !== operation.stripeCustomerId
              ) {
                if (
                  Date.now() - operation.createdAt.getTime() >=
                  CHECKOUT_OPERATION_ABANDON_HORIZON_MS
                ) {
                  await tx.checkoutOperation.deleteMany({
                    where: {
                      id: operation.id,
                      userId,
                      ownerToken: operation.ownerToken,
                      leaseExpiresAt: { lte: now },
                    },
                  });
                  changed = true;
                }
                continue;
              }
              if (recovery) continue;
              const ownerToken = randomUUID();
              const claimed = await tx.checkoutOperation.updateMany({
                where: {
                  id: operation.id,
                  userId,
                  ownerToken: operation.ownerToken,
                  leaseExpiresAt: { lte: now },
                },
                data: {
                  ownerToken,
                  state: 'ACTIVE',
                  leaseExpiresAt: new Date(
                    Date.now() + CHECKOUT_OPERATION_LEASE_MS,
                  ),
                },
              });
              if (claimed.count === 1) {
                changed = true;
                recovery = {
                  kind: 'recover-portal',
                  operationId: operation.id,
                  ownerToken,
                  customerId: operation.stripeCustomerId!,
                  returnUrl: operation.portalReturnUrl!,
                };
              }
              continue;
            }
            const session = sessions.find(
              ({ metadata }) => metadata.attemptId === operation.attemptId,
            );
            if (session) {
              if (current.checkoutAttemptId === operation.attemptId) {
                await tx.user.update({
                  where: { id: userId },
                  data: {
                    checkoutSessionId: session.id,
                    checkoutSessionUrl: session.url,
                    checkoutSessionExpiresAt: null,
                  },
                });
                await tx.checkoutCleanupIntent.deleteMany({
                  where: { userId, stripeSessionId: session.id },
                });
              } else {
                await tx.checkoutCleanupIntent.upsert({
                  where: { stripeSessionId: session.id },
                  create: { userId, stripeSessionId: session.id },
                  update: {},
                });
              }
              await tx.checkoutOperation.deleteMany({
                where: {
                  id: operation.id,
                  userId,
                  ownerToken: operation.ownerToken,
                },
              });
              changed = true;
              continue;
            }
            if (current.checkoutAttemptId !== operation.attemptId) {
              if (
                Date.now() - operation.createdAt.getTime() >=
                CHECKOUT_OPERATION_ABANDON_HORIZON_MS
              ) {
                await tx.checkoutOperation.deleteMany({
                  where: {
                    id: operation.id,
                    userId,
                    ownerToken: operation.ownerToken,
                    leaseExpiresAt: { lte: now },
                  },
                });
                changed = true;
              }
              continue;
            }
            const hasExactParameters =
              operation.attemptId !== null &&
              operation.requestedPlan !== null &&
              operation.interval !== null &&
              operation.stripePriceId !== null &&
              operation.successUrl !== null &&
              operation.cancelUrl !== null;
            if (!hasExactParameters) {
              if (
                Date.now() - operation.createdAt.getTime() >=
                CHECKOUT_OPERATION_ABANDON_HORIZON_MS
              ) {
                await tx.checkoutOperation.deleteMany({
                  where: {
                    id: operation.id,
                    userId,
                    ownerToken: operation.ownerToken,
                    leaseExpiresAt: { lte: now },
                  },
                });
                changed = true;
              }
              continue;
            }
            if (!snapshot.stripeCustomerId || recovery) {
              continue;
            }
            const ownerToken = randomUUID();
            const claimed = await tx.checkoutOperation.updateMany({
              where: {
                id: operation.id,
                userId,
                ownerToken: operation.ownerToken,
                leaseExpiresAt: { lte: now },
              },
              data: {
                ownerToken,
                state: 'ACTIVE',
                leaseExpiresAt: new Date(
                  Date.now() + CHECKOUT_OPERATION_LEASE_MS,
                ),
              },
            });
            if (claimed.count > 0) {
              changed = true;
              recovery = {
                kind: 'recover-checkout',
                operationId: operation.id,
                ownerToken,
                attemptId: operation.attemptId!,
                plan: operation.requestedPlan as PaidPlan,
                interval: operation.interval as BillingInterval,
                priceId: operation.stripePriceId!,
                successUrl: operation.successUrl!,
                cancelUrl: operation.cancelUrl!,
              };
            }
          }
          if (changed) {
            await tx.user.update({
              where: { id: userId },
              data: { billingStateVersion: { increment: 1 } },
            });
          }
          return recovery ?? { kind: 'done' };
        },
        BILLING_TRANSACTION_OPTIONS,
      );
      if (result.kind === 'stale') continue;
      if (result.kind === 'done') return {};
      try {
        if (result.kind === 'recover-portal') {
          const portal = await this.createStripePortalSession({
            operationId: result.operationId,
            customerId: result.customerId,
            returnUrl: result.returnUrl,
          });
          await this.completeCheckoutOperation(
            userId,
            result.operationId,
            result.ownerToken,
          );
          return { recoveredPortalUrl: portal.url };
        }
        const session = await this.createStripeCheckoutSession({
          customerId: snapshot.stripeCustomerId!,
          userId,
          plan: result.plan,
          interval: result.interval,
          attemptId: result.attemptId,
          priceId: result.priceId,
          successUrl: result.successUrl,
          cancelUrl: result.cancelUrl,
        });
        await this.persistReturnedCheckoutSession({
          userId,
          operationId: result.operationId,
          ownerToken: result.ownerToken,
          attemptId: result.attemptId,
          session,
        });
      } catch (error) {
        if (this.isDefinitiveCheckoutCreateFailure(error)) {
          await this.completeCheckoutOperation(
            userId,
            result.operationId,
            result.ownerToken,
          );
        } else {
          await this.markCheckoutOperationUncertain(
            userId,
            result.operationId,
            result.ownerToken,
          );
        }
        throw error;
      }
    }
    throw new ConflictException('Billing state changed; retry checkout');
  }

  // -------------------------------------------------------------------------
  // createCheckout
  // -------------------------------------------------------------------------

  async createCheckout(
    userId: string,
    plan: PaidPlan,
    interval: BillingInterval = 'month',
  ): Promise<{ url: string }> {
    const priceId = this.planToPrice(plan, interval);
    if (!priceId) {
      throw new BadRequestException(
        'Billing is not configured for this plan yet',
      );
    }
    const successUrl = `${this.appUrl}/billing/success`;
    const cancelUrl = `${this.appUrl}/billing/cancel`;
    const recovery = await this.reconcileCheckoutOperations(userId);
    if (recovery.recoveredPortalUrl) {
      throw new ConflictException('Billing portal operation recovered; retry');
    }
    await this.reconcileCheckoutCleanup(userId);
    const reservation = await this.prisma.$transaction(async (tx) => {
      await this.entitlements.lockUsers(tx, [userId]);
      const current = await tx.user.findUniqueOrThrow({
        where: { id: userId },
        select: {
          id: true,
          email: true,
          stripeCustomerId: true,
          checkoutAttemptId: true,
          checkoutAttemptPlan: true,
          checkoutAttemptInterval: true,
          checkoutAttemptCreatedAt: true,
          checkoutSessionId: true,
          checkoutSessionUrl: true,
          billingStateVersion: true,
        },
      });
      if ((await tx.checkoutCleanupIntent.count({ where: { userId } })) > 0) {
        throw new ConflictException('Checkout cleanup is pending; retry');
      }
      const checkoutAttemptId = current.checkoutAttemptId ?? randomUUID();
      const conflictingOperationCount = await tx.checkoutOperation.count({
        where: {
          userId,
          leaseExpiresAt: { gt: new Date() },
          OR: [
            { operationKind: 'PORTAL' },
            {
              operationKind: 'CHECKOUT',
              NOT: { requestedPlan: plan, interval },
            },
          ],
        },
      });
      if (conflictingOperationCount > 0) {
        throw new ConflictException('Checkout already in progress');
      }
      const user = await tx.user.update({
        where: { id: userId },
        data: {
          ...(current.checkoutAttemptId
            ? {}
            : {
                checkoutAttemptId,
                checkoutAttemptPlan: plan,
                checkoutAttemptInterval: interval,
                checkoutAttemptCreatedAt: new Date(),
                checkoutSessionId: null,
                checkoutSessionUrl: null,
                checkoutSessionExpiresAt: null,
              }),
          billingStateVersion: { increment: 1 },
        },
        select: {
          id: true,
          email: true,
          stripeCustomerId: true,
          checkoutAttemptId: true,
          checkoutAttemptPlan: true,
          checkoutAttemptInterval: true,
          checkoutAttemptCreatedAt: true,
          checkoutSessionId: true,
          checkoutSessionUrl: true,
          billingStateVersion: true,
        },
      });
      const operation = await tx.checkoutOperation.create({
        data: {
          id: randomUUID(),
          userId,
          operationKind: 'CHECKOUT',
          attemptId: checkoutAttemptId,
          requestedPlan: plan,
          interval,
          stripePriceId: priceId,
          successUrl,
          cancelUrl,
          portalReturnUrl: `${this.appUrl}/billing`,
          ownerToken: randomUUID(),
          state: 'ACTIVE',
          leaseExpiresAt: new Date(Date.now() + CHECKOUT_OPERATION_LEASE_MS),
        },
        select: { id: true, ownerToken: true },
      });
      return {
        user,
        operationId: operation.id,
        ownerToken: operation.ownerToken,
      };
    }, BILLING_TRANSACTION_OPTIONS);
    const { user, operationId, ownerToken } = reservation;
    let returnedSessionNeedsDurableOwnership = false;
    let operationMustRemain = false;
    try {
      const customerId = await this.ensureCustomer(user);

      type CheckoutAction =
        | { kind: 'portal' }
        | { kind: 'reuse'; url: string }
        | { kind: 'create'; attemptId: string }
        | { kind: 'expire'; attemptId: string; sessionId: string };

      const coordinate = async (): Promise<CheckoutAction> => {
        for (
          let snapshotAttempt = 0;
          snapshotAttempt < BILLING_SNAPSHOT_MAX_ATTEMPTS;
          snapshotAttempt++
        ) {
          const snapshot = await this.prisma.user.findUniqueOrThrow({
            where: { id: user.id },
            select: {
              stripeCustomerId: true,
              billingStateVersion: true,
            },
          });
          if (!snapshot.stripeCustomerId) {
            throw new ConflictException('Billing customer changed; retry');
          }
          const [subscriptions, sessions] = await Promise.all([
            this.listRelevantSubscriptions(snapshot.stripeCustomerId),
            this.listAccountCheckoutSessions(
              snapshot.stripeCustomerId,
              user.id,
            ),
          ]);
          const result = await this.prisma.$transaction<CheckoutAction | null>(
            async (tx) => {
              await this.entitlements.lockUsers(tx, [user.id]);
              const current = await tx.user.findUniqueOrThrow({
                where: { id: user.id },
                select: {
                  stripeCustomerId: true,
                  billingStateVersion: true,
                  checkoutAttemptId: true,
                  checkoutAttemptPlan: true,
                  checkoutAttemptInterval: true,
                  checkoutAttemptCreatedAt: true,
                  checkoutSessionId: true,
                },
              });
              if (
                current.stripeCustomerId !== snapshot.stripeCustomerId ||
                current.billingStateVersion !== snapshot.billingStateVersion
              ) {
                return null;
              }
              if (
                (await tx.checkoutCleanupIntent.count({
                  where: { userId: user.id },
                })) > 0
              ) {
                throw new ConflictException(
                  'Checkout cleanup is pending; retry',
                );
              }
              const renewFence = async (
                attemptId?: string,
              ): Promise<boolean> => {
                const renewed = await tx.checkoutOperation.updateMany({
                  where: {
                    id: operationId,
                    userId: user.id,
                    ownerToken,
                  },
                  data: {
                    ...(attemptId ? { attemptId } : {}),
                    state: 'ACTIVE',
                    leaseExpiresAt: new Date(
                      Date.now() + CHECKOUT_OPERATION_LEASE_MS,
                    ),
                  },
                });
                return renewed.count === 1;
              };
              if (subscriptions.length > 0) {
                if (!(await renewFence())) return null;
                await tx.user.update({
                  where: { id: user.id },
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
                return { kind: 'portal' };
              }
              const sameParams =
                current.checkoutAttemptPlan === plan &&
                current.checkoutAttemptInterval === interval;
              const attemptSession = current.checkoutAttemptId
                ? sessions.find(
                    ({ metadata }) =>
                      metadata.attemptId === current.checkoutAttemptId,
                  )
                : undefined;
              const persistedSession = sessions.find(
                ({ id }) => id === current.checkoutSessionId,
              );
              const knownSession = attemptSession ?? persistedSession;
              if (
                sameParams &&
                attemptSession?.status === 'open' &&
                attemptSession.url
              ) {
                if (!(await renewFence(current.checkoutAttemptId!))) {
                  return null;
                }
                await tx.user.update({
                  where: { id: user.id },
                  data: {
                    checkoutSessionId: attemptSession.id,
                    checkoutSessionUrl: attemptSession.url,
                    checkoutSessionExpiresAt: null,
                    billingStateVersion: { increment: 1 },
                  },
                });
                return { kind: 'reuse', url: attemptSession.url };
              }

              const oldEnough =
                current.checkoutAttemptCreatedAt !== null &&
                Date.now() - current.checkoutAttemptCreatedAt.getTime() >=
                  STRIPE_IDEMPOTENCY_RETENTION_MS;
              if (!sameParams && !oldEnough) {
                if (knownSession?.status === 'open') {
                  const attemptId = randomUUID();
                  if (!(await renewFence(attemptId))) return null;
                  await tx.user.update({
                    where: { id: user.id },
                    data: {
                      checkoutAttemptId: attemptId,
                      checkoutAttemptPlan: plan,
                      checkoutAttemptInterval: interval,
                      checkoutAttemptCreatedAt: new Date(),
                      checkoutSessionId: knownSession.id,
                      checkoutSessionUrl: null,
                      checkoutSessionExpiresAt: null,
                      billingStateVersion: { increment: 1 },
                    },
                  });
                  return {
                    kind: 'expire',
                    attemptId,
                    sessionId: knownSession.id,
                  };
                } else {
                  throw new ConflictException('Checkout already in progress');
                }
              } else if (
                sameParams &&
                persistedSession?.metadata.attemptId !==
                  current.checkoutAttemptId
              ) {
                if (persistedSession?.status === 'open') {
                  if (!(await renewFence(current.checkoutAttemptId!))) {
                    return null;
                  }
                  return {
                    kind: 'expire',
                    attemptId: current.checkoutAttemptId!,
                    sessionId: persistedSession.id,
                  };
                }
                if (
                  persistedSession?.status === 'expired' ||
                  !persistedSession
                ) {
                  if (!(await renewFence(current.checkoutAttemptId!))) {
                    return null;
                  }
                  return {
                    kind: 'create',
                    attemptId: current.checkoutAttemptId!,
                  };
                }
              } else if (knownSession?.status === 'expired' && !oldEnough) {
                throw new ConflictException(
                  'Checkout attempt cannot be replaced yet',
                );
              } else if (
                knownSession &&
                knownSession.status !== 'expired' &&
                !oldEnough
              ) {
                throw new ConflictException('Checkout already in progress');
              }

              let attemptId = current.checkoutAttemptId;
              if (!attemptId || (!sameParams && knownSession) || oldEnough) {
                attemptId = randomUUID();
                if (!(await renewFence(attemptId))) return null;
                await tx.user.update({
                  where: { id: user.id },
                  data: {
                    checkoutAttemptId: attemptId,
                    checkoutAttemptPlan: plan,
                    checkoutAttemptInterval: interval,
                    checkoutAttemptCreatedAt: new Date(),
                    checkoutSessionId: null,
                    checkoutSessionUrl: null,
                    checkoutSessionExpiresAt: null,
                    billingStateVersion: { increment: 1 },
                  },
                });
              } else if (!(await renewFence(attemptId))) {
                return null;
              }
              return { kind: 'create', attemptId };
            },
            BILLING_TRANSACTION_OPTIONS,
          );
          if (result) return result;
        }
        throw new ConflictException('Billing state changed; retry checkout');
      };

      let action = await coordinate();
      if (action.kind === 'expire') {
        await this.stripe.checkout.sessions.expire(
          action.sessionId,
          {},
          { timeout: STRIPE_REQUEST_TIMEOUT_MS },
        );
        const expiredAttemptId = action.attemptId;
        action = await coordinate();
        if (action.kind === 'expire' && action.attemptId === expiredAttemptId) {
          throw new ConflictException(
            'Checkout session expiry is still being confirmed; retry',
          );
        }
      }

      if (action.kind === 'portal') {
        let portal: Stripe.BillingPortal.Session;
        try {
          portal = await this.createStripePortalSession({
            operationId,
            customerId,
            returnUrl: `${this.appUrl}/billing`,
          });
        } catch (error) {
          if (!this.isDefinitiveCheckoutCreateFailure(error)) {
            operationMustRemain = true;
            await this.markCheckoutOperationUncertain(
              user.id,
              operationId,
              ownerToken,
            );
          }
          throw error;
        }
        await this.completeCheckoutOperation(user.id, operationId, ownerToken);
        return { url: portal.url };
      }
      if (action.kind === 'reuse') {
        await this.completeCheckoutOperation(user.id, operationId, ownerToken);
        return { url: action.url };
      }

      let session: Stripe.Checkout.Session;
      try {
        session = await this.createStripeCheckoutSession({
          customerId,
          userId: user.id,
          plan,
          interval,
          attemptId: action.attemptId,
          priceId,
          successUrl,
          cancelUrl,
        });
      } catch (error) {
        if (!this.isDefinitiveCheckoutCreateFailure(error)) {
          operationMustRemain = true;
          await this.markCheckoutOperationUncertain(
            user.id,
            operationId,
            ownerToken,
          );
        }
        throw error;
      }
      returnedSessionNeedsDurableOwnership = true;
      const persistence = await this.persistReturnedCheckoutSession({
        userId: user.id,
        operationId,
        ownerToken,
        attemptId: action.attemptId,
        session,
      });
      returnedSessionNeedsDurableOwnership = false;
      if (!session.url) {
        throw new BadRequestException('Failed to create checkout session');
      }
      if (persistence === 'cleanup') {
        await this.reconcileCheckoutCleanup(user.id);
        throw new ConflictException('Checkout attempt changed; retry');
      }
      if (persistence === 'stale') {
        throw new ConflictException('Checkout recovery owns this attempt');
      }
      return { url: session.url };
    } finally {
      if (!returnedSessionNeedsDurableOwnership && !operationMustRemain) {
        await this.completeCheckoutOperation(user.id, operationId, ownerToken);
      }
    }
  }

  // -------------------------------------------------------------------------
  // createPortal
  // -------------------------------------------------------------------------

  async createPortal(userId: string): Promise<{ url: string }> {
    const recovery = await this.reconcileCheckoutOperations(userId);
    if (recovery.recoveredPortalUrl) {
      return { url: recovery.recoveredPortalUrl };
    }
    await this.reconcileCheckoutCleanup(userId);
    const returnUrl = `${this.appUrl}/billing`;
    const reservation = await this.prisma.$transaction(async (tx) => {
      await this.entitlements.lockUsers(tx, [userId]);
      if (
        (await tx.checkoutOperation.count({
          where: { userId },
        })) > 0
      ) {
        throw new ConflictException('Billing operation already in progress');
      }
      const user = await tx.user.findUniqueOrThrow({
        where: { id: userId },
        select: {
          stripeCustomerId: true,
          subscription: { select: { plan: true, status: true } },
        },
      });
      if (
        !user.stripeCustomerId ||
        !user.subscription ||
        user.subscription.plan === 'SOLO' ||
        !RELEVANT_SUBSCRIPTION_STATUSES.has(user.subscription.status)
      ) {
        throw new BadRequestException(
          'No billing account with a paid subscription found. Start a subscription first.',
        );
      }
      const operation = await tx.checkoutOperation.create({
        data: {
          id: randomUUID(),
          userId,
          operationKind: 'PORTAL',
          stripeCustomerId: user.stripeCustomerId,
          portalReturnUrl: returnUrl,
          ownerToken: randomUUID(),
          state: 'ACTIVE',
          leaseExpiresAt: new Date(Date.now() + CHECKOUT_OPERATION_LEASE_MS),
        },
        select: {
          id: true,
          ownerToken: true,
          stripeCustomerId: true,
          portalReturnUrl: true,
        },
      });
      await tx.user.update({
        where: { id: userId },
        data: { billingStateVersion: { increment: 1 } },
      });
      return operation;
    }, BILLING_TRANSACTION_OPTIONS);

    const ownsFence = await this.prisma.$transaction(async (tx) => {
      await this.entitlements.lockUsers(tx, [userId]);
      const renewed = await tx.checkoutOperation.updateMany({
        where: {
          id: reservation.id,
          userId,
          ownerToken: reservation.ownerToken,
          operationKind: 'PORTAL',
        },
        data: {
          state: 'ACTIVE',
          leaseExpiresAt: new Date(Date.now() + CHECKOUT_OPERATION_LEASE_MS),
        },
      });
      return renewed.count === 1;
    }, BILLING_TRANSACTION_OPTIONS);
    if (!ownsFence) {
      throw new ConflictException('Billing state changed; retry portal');
    }
    try {
      const session = await this.createStripePortalSession({
        operationId: reservation.id,
        customerId: reservation.stripeCustomerId!,
        returnUrl: reservation.portalReturnUrl!,
      });
      await this.completeCheckoutOperation(
        userId,
        reservation.id,
        reservation.ownerToken,
      );
      return { url: session.url };
    } catch (error) {
      if (this.isDefinitiveCheckoutCreateFailure(error)) {
        await this.completeCheckoutOperation(
          userId,
          reservation.id,
          reservation.ownerToken,
        );
      } else {
        await this.markCheckoutOperationUncertain(
          userId,
          reservation.id,
          reservation.ownerToken,
        );
      }
      throw error;
    }
  }

  // -------------------------------------------------------------------------
  // applySubscriptionEvent — extracted core sync logic (testable directly)
  // -------------------------------------------------------------------------

  async applySubscriptionEvent(stripeCustomerId: string): Promise<void> {
    for (let attempt = 0; attempt < BILLING_SNAPSHOT_MAX_ATTEMPTS; attempt++) {
      const user = await this.prisma.user.findUnique({
        where: { stripeCustomerId },
        select: {
          id: true,
          stripeCustomerId: true,
          billingStateVersion: true,
        },
      });
      if (!user) return;
      await this.reconcileCheckoutOperations(user.id);
      await this.reconcileCheckoutCleanup(user.id);
      const snapshot = await this.prisma.user.findUnique({
        where: { id: user.id },
        select: {
          id: true,
          stripeCustomerId: true,
          billingStateVersion: true,
        },
      });
      if (!snapshot || snapshot.stripeCustomerId !== stripeCustomerId) return;
      const state = this.resolveAuthoritativeState(
        await this.listRelevantSubscriptions(stripeCustomerId),
      );
      const applied = await this.prisma.$transaction(async (tx) => {
        await this.entitlements.lockUsers(tx, [user.id]);
        const currentUser = await tx.user.findUnique({
          where: { id: user.id },
          select: {
            stripeCustomerId: true,
            billingStateVersion: true,
          },
        });
        if (
          !currentUser ||
          currentUser.stripeCustomerId !== snapshot.stripeCustomerId ||
          currentUser.billingStateVersion !== snapshot.billingStateVersion
        ) {
          return false;
        }
        const existingSub = await tx.subscription.findUnique({
          where: { userId: user.id },
          select: { manualOverride: true },
        });
        if (state.stripeSubscriptionId) {
          await tx.user.update({
            where: { id: user.id },
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
        } else {
          await tx.user.update({
            where: { id: user.id },
            data: { billingStateVersion: { increment: 1 } },
          });
        }
        if (existingSub?.manualOverride) {
          await tx.subscription.update({
            where: { userId: user.id },
            data: {
              status: state.status,
              stripeSubscriptionId: state.stripeSubscriptionId,
            },
          });
        } else {
          await tx.subscription.upsert({
            where: { userId: user.id },
            update: state,
            create: { userId: user.id, ...state },
          });
        }
        return true;
      }, BILLING_TRANSACTION_OPTIONS);
      if (applied) return;
    }
    throw new ConflictException('Billing state changed; retry webhook');
  }

  // -------------------------------------------------------------------------
  // handleWebhook
  // -------------------------------------------------------------------------

  async handleWebhook(rawBody: Buffer, signature: string): Promise<void> {
    if (!this.webhookSecret) {
      throw new BadRequestException('Webhook not configured');
    }

    let event: Stripe.Event;

    try {
      event = this.stripe.webhooks.constructEvent(
        rawBody,
        signature,
        this.webhookSecret,
      );
    } catch {
      throw new BadRequestException('Invalid Stripe webhook signature');
    }

    if (
      event.type === 'customer.subscription.created' ||
      event.type === 'customer.subscription.updated' ||
      event.type === 'customer.subscription.deleted'
    ) {
      const sub = event.data.object;
      const customerId =
        typeof sub.customer === 'string' ? sub.customer : sub.customer.id;

      await this.applySubscriptionEvent(customerId);
    }
  }
}
