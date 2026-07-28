import { Inject, Injectable } from '@nestjs/common';
import type Stripe from 'stripe';
import { PrismaService } from '../prisma/prisma.service';
import { AccountEntitlementsService } from './account-entitlements.service';
import { ReconciliationRunLock } from './subscription-reconciliation-lock';
import { StripePriceRegistry } from './stripe-price-registry';
import { STRIPE_CLIENT } from './stripe.provider';

const BATCH_SIZE = 100;
const CANDIDATE_TRANSACTION_MAX_WAIT_MS = 5_000;
const CANDIDATE_TRANSACTION_TIMEOUT_MS = 10_000;
const STRIPE_REQUEST_OPTIONS = {
  maxNetworkRetries: 0,
  timeout: 5_000,
} as const;
const LIVE_PAID_STATUSES = ['active', 'trialing', 'past_due'] as const;

export interface ReconciliationSummary {
  usersScanned: number;
  duplicatesCancelled: number;
  alreadyGone: number;
  failures: Array<{ subscriptionId: string; message: string }>;
}

type CancellationResult = 'cancelled' | 'already-gone' | 'skipped';

interface CandidateSnapshot {
  candidateId: string;
  candidateStripeId: string;
  candidateStatus: string;
  candidatePlan: 'SIGNAL' | 'FLEET';
  organizationId: string;
  organizationCreatorUserId: string;
  organizationStripeCustomerId: string;
  winnerStripeId: string;
  winnerStripeCustomerId: string;
  winnerPlan: 'SIGNAL' | 'FLEET';
  winnerOrganizationId: string | null;
  winnerOrganizationCreatorUserId: string | null;
  winnerOrganizationStripeCustomerId: string | null;
  billingStateVersion: number;
}

@Injectable()
export class SubscriptionReconciliationService {
  constructor(
    private readonly prisma: PrismaService,
    @Inject(STRIPE_CLIENT) private readonly stripe: Stripe,
    private readonly entitlements: AccountEntitlementsService,
    private readonly runLock: ReconciliationRunLock,
    private readonly prices: StripePriceRegistry,
  ) {}

  async reconcile(): Promise<ReconciliationSummary> {
    return this.runLock.withLock(() => this.reconcileLocked());
  }

  private async reconcileLocked(): Promise<ReconciliationSummary> {
    const summary: ReconciliationSummary = {
      usersScanned: 0,
      duplicatesCancelled: 0,
      alreadyGone: 0,
      failures: [],
    };
    const cancellationResults = new Map<string, CancellationResult>();
    let lastUserId: string | undefined;

    do {
      const accounts = await this.prisma.subscription.findMany({
        where: {
          userId: {
            not: null,
            ...(lastUserId ? { gt: lastUserId } : undefined),
          },
        },
        select: {
          id: true,
          userId: true,
          stripeSubscriptionId: true,
        },
        orderBy: { userId: 'asc' },
        take: BATCH_SIZE,
      });

      for (const account of accounts) {
        if (!account.userId) continue;
        summary.usersScanned += 1;
        await this.runLock.withUserLock(account.userId, () =>
          this.reconcileAccount(
            account.id,
            account.userId!,
            account.stripeSubscriptionId,
            summary,
            cancellationResults,
          ),
        );
      }

      if (accounts.length < BATCH_SIZE) break;
      lastUserId = accounts.at(-1)?.userId ?? undefined;
    } while (lastUserId);

    return summary;
  }

  private async reconcileAccount(
    accountRowId: string,
    userId: string,
    scannedWinnerStripeId: string | null,
    summary: ReconciliationSummary,
    cancellationResults: Map<string, CancellationResult>,
  ): Promise<void> {
    let duplicateCursor: string | undefined;
    let foundDuplicate = false;

    do {
      const duplicates = await this.prisma.subscription.findMany({
        where: {
          userId: null,
          organization: { creatorUserId: userId },
          stripeSubscriptionId: { not: null },
          plan: { in: ['SIGNAL', 'FLEET'] },
          status: { in: [...LIVE_PAID_STATUSES] },
        },
        select: { id: true, stripeSubscriptionId: true },
        orderBy: { id: 'asc' },
        ...(duplicateCursor
          ? { cursor: { id: duplicateCursor }, skip: 1 }
          : undefined),
        take: BATCH_SIZE,
      });
      foundDuplicate ||= duplicates.length > 0;

      if (!scannedWinnerStripeId) {
        if (foundDuplicate) {
          summary.failures.push({
            subscriptionId: accountRowId,
            message: 'Account winner Stripe subscription is unresolved',
          });
        }
        return;
      }

      for (const duplicate of duplicates) {
        const stripeId = duplicate.stripeSubscriptionId;
        if (!stripeId || stripeId === scannedWinnerStripeId) continue;

        try {
          const result = await this.reconcileCandidate(
            duplicate.id,
            userId,
            scannedWinnerStripeId,
            stripeId,
            cancellationResults,
          );
          if (result === 'cancelled') summary.duplicatesCancelled += 1;
          if (result === 'already-gone') summary.alreadyGone += 1;
        } catch (error: unknown) {
          summary.failures.push({
            subscriptionId: duplicate.id,
            message:
              error instanceof WinnerVerificationError
                ? 'Account winner verification failed; no duplicate was canceled'
                : error instanceof CandidateVerificationError
                  ? 'Legacy candidate verification failed; no duplicate was canceled'
                  : 'Stripe cancellation failed; retry required',
          });
        }
      }

      if (duplicates.length < BATCH_SIZE) break;
      duplicateCursor = duplicates.at(-1)?.id;
    } while (duplicateCursor);
  }

  private async reconcileCandidate(
    candidateId: string,
    userId: string,
    scannedWinnerStripeId: string,
    candidateStripeId: string,
    cancellationResults: Map<string, CancellationResult>,
  ): Promise<CancellationResult> {
    const snapshot = await this.captureCandidate(
      candidateId,
      userId,
      scannedWinnerStripeId,
      candidateStripeId,
    );
    if (!snapshot) return 'skipped';

    await this.verifyWinner(
      userId,
      snapshot.winnerStripeId,
      snapshot.winnerStripeCustomerId,
      snapshot.winnerPlan,
      {
        id: snapshot.winnerOrganizationId,
        creatorUserId: snapshot.winnerOrganizationCreatorUserId,
        stripeCustomerId: snapshot.winnerOrganizationStripeCustomerId,
      },
    );
    const candidateState = await this.verifyCandidate(
      snapshot.candidateStripeId,
      snapshot.organizationId,
      snapshot.organizationStripeCustomerId,
      snapshot.candidatePlan,
    );

    const previous = cancellationResults.get(candidateStripeId);
    let result: CancellationResult;
    if (previous === 'cancelled' || previous === 'already-gone') {
      result = previous;
    } else if (candidateState === 'already-gone') {
      result = 'already-gone';
      cancellationResults.set(candidateStripeId, result);
    } else {
      result = await this.cancelLegacySubscription(candidateStripeId);
      cancellationResults.set(candidateStripeId, result);
    }

    const checkpointed = await this.checkpointCandidate(snapshot, userId);
    return checkpointed && !previous ? result : 'skipped';
  }

  private captureCandidate(
    candidateId: string,
    userId: string,
    scannedWinnerStripeId: string,
    candidateStripeId: string,
  ): Promise<CandidateSnapshot | null> {
    return this.prisma.$transaction(
      async (tx) => {
        await this.entitlements.lockUserRows(tx, [userId]);
        await tx.$queryRaw`
          SELECT id FROM subscriptions WHERE id = ${candidateId} FOR UPDATE
        `;
        const candidate = await tx.subscription.findUnique({
          where: { id: candidateId },
          select: {
            userId: true,
            status: true,
            stripeSubscriptionId: true,
            plan: true,
            organization: {
              select: {
                id: true,
                creatorUserId: true,
                stripeCustomerId: true,
              },
            },
          },
        });
        const winner = await tx.subscription.findUnique({
          where: { userId },
          select: {
            stripeSubscriptionId: true,
            plan: true,
            organization: {
              select: {
                id: true,
                creatorUserId: true,
                stripeCustomerId: true,
              },
            },
            user: {
              select: {
                stripeCustomerId: true,
                billingStateVersion: true,
              },
            },
          },
        });
        const globalWinner = await tx.subscription.findFirst({
          where: {
            userId: { not: null },
            stripeSubscriptionId: candidateStripeId,
          },
          select: { id: true },
        });

        if (
          !candidate ||
          candidate.userId !== null ||
          !LIVE_PAID_STATUSES.includes(
            candidate.status as (typeof LIVE_PAID_STATUSES)[number],
          ) ||
          (candidate.plan !== 'SIGNAL' && candidate.plan !== 'FLEET') ||
          candidate.stripeSubscriptionId !== candidateStripeId ||
          candidate.organization?.creatorUserId !== userId ||
          !winner?.stripeSubscriptionId ||
          (winner.plan !== 'SIGNAL' && winner.plan !== 'FLEET') ||
          winner.stripeSubscriptionId !== scannedWinnerStripeId ||
          winner.stripeSubscriptionId === candidateStripeId ||
          globalWinner
        ) {
          return null;
        }
        if (
          !candidate.organization.stripeCustomerId ||
          !winner.user?.stripeCustomerId
        ) {
          throw new CandidateVerificationError();
        }
        return {
          candidateId,
          candidateStripeId,
          candidateStatus: candidate.status,
          candidatePlan: candidate.plan,
          organizationId: candidate.organization.id,
          organizationCreatorUserId: candidate.organization.creatorUserId,
          organizationStripeCustomerId: candidate.organization.stripeCustomerId,
          winnerStripeId: winner.stripeSubscriptionId,
          winnerStripeCustomerId: winner.user.stripeCustomerId,
          winnerPlan: winner.plan,
          winnerOrganizationId: winner.organization?.id ?? null,
          winnerOrganizationCreatorUserId:
            winner.organization?.creatorUserId ?? null,
          winnerOrganizationStripeCustomerId:
            winner.organization?.stripeCustomerId ?? null,
          billingStateVersion: winner.user.billingStateVersion,
        };
      },
      {
        maxWait: CANDIDATE_TRANSACTION_MAX_WAIT_MS,
        timeout: CANDIDATE_TRANSACTION_TIMEOUT_MS,
      },
    );
  }

  private checkpointCandidate(
    snapshot: CandidateSnapshot,
    userId: string,
  ): Promise<boolean> {
    return this.prisma.$transaction(
      async (tx) => {
        await this.entitlements.lockUserRows(tx, [userId]);
        await tx.$queryRaw`
          SELECT id FROM subscriptions
          WHERE id = ${snapshot.candidateId}
          FOR UPDATE
        `;
        const [candidate, winner, globalWinner] = await Promise.all([
          tx.subscription.findUnique({
            where: { id: snapshot.candidateId },
            select: {
              userId: true,
              status: true,
              stripeSubscriptionId: true,
              plan: true,
              organization: {
                select: {
                  id: true,
                  creatorUserId: true,
                  stripeCustomerId: true,
                },
              },
            },
          }),
          tx.subscription.findUnique({
            where: { userId },
            select: {
              stripeSubscriptionId: true,
              plan: true,
              organization: {
                select: {
                  id: true,
                  creatorUserId: true,
                  stripeCustomerId: true,
                },
              },
              user: {
                select: {
                  stripeCustomerId: true,
                  billingStateVersion: true,
                },
              },
            },
          }),
          tx.subscription.findFirst({
            where: {
              userId: { not: null },
              stripeSubscriptionId: snapshot.candidateStripeId,
            },
            select: { id: true },
          }),
        ]);
        if (
          !candidate ||
          candidate.userId !== null ||
          candidate.status !== snapshot.candidateStatus ||
          candidate.stripeSubscriptionId !== snapshot.candidateStripeId ||
          candidate.plan !== snapshot.candidatePlan ||
          candidate.organization?.id !== snapshot.organizationId ||
          candidate.organization.creatorUserId !==
            snapshot.organizationCreatorUserId ||
          candidate.organization.stripeCustomerId !==
            snapshot.organizationStripeCustomerId ||
          winner?.stripeSubscriptionId !== snapshot.winnerStripeId ||
          winner.plan !== snapshot.winnerPlan ||
          (winner.organization?.id ?? null) !== snapshot.winnerOrganizationId ||
          (winner.organization?.creatorUserId ?? null) !==
            snapshot.winnerOrganizationCreatorUserId ||
          (winner.organization?.stripeCustomerId ?? null) !==
            snapshot.winnerOrganizationStripeCustomerId ||
          winner.user?.stripeCustomerId !== snapshot.winnerStripeCustomerId ||
          winner.user.billingStateVersion !== snapshot.billingStateVersion ||
          globalWinner
        ) {
          return false;
        }
        const update = await tx.subscription.updateMany({
          where: {
            id: snapshot.candidateId,
            userId: null,
            stripeSubscriptionId: snapshot.candidateStripeId,
            status: snapshot.candidateStatus,
          },
          data: { status: 'canceled' },
        });
        return update.count === 1;
      },
      {
        maxWait: CANDIDATE_TRANSACTION_MAX_WAIT_MS,
        timeout: CANDIDATE_TRANSACTION_TIMEOUT_MS,
      },
    );
  }

  private async verifyWinner(
    userId: string,
    persistedWinnerId: string,
    persistedCustomerId: string | null,
    persistedPlan: 'SIGNAL' | 'FLEET',
    legacyOrganization: {
      id: string | null;
      creatorUserId: string | null;
      stripeCustomerId: string | null;
    },
  ): Promise<void> {
    if (!persistedCustomerId) throw new WinnerVerificationError();
    let subscription: Stripe.Subscription;
    try {
      subscription = await this.stripe.subscriptions.retrieve(
        persistedWinnerId,
        {},
        STRIPE_REQUEST_OPTIONS,
      );
    } catch {
      throw new WinnerVerificationError();
    }
    const customerId =
      typeof subscription.customer === 'string'
        ? subscription.customer
        : subscription.customer.id;
    if (
      subscription.id !== persistedWinnerId ||
      !LIVE_PAID_STATUSES.includes(
        subscription.status as (typeof LIVE_PAID_STATUSES)[number],
      ) ||
      customerId !== persistedCustomerId
    ) {
      throw new WinnerVerificationError();
    }
    if (!this.hasRecognizedPaidPlan(subscription, persistedPlan)) {
      throw new WinnerVerificationError();
    }

    let customer: Stripe.Customer | Stripe.DeletedCustomer;
    try {
      customer =
        typeof subscription.customer === 'string'
          ? await this.stripe.customers.retrieve(
              customerId,
              {},
              STRIPE_REQUEST_OPTIONS,
            )
          : subscription.customer;
    } catch {
      throw new WinnerVerificationError();
    }
    const modernOwnership =
      !customer.deleted &&
      customer.id === customerId &&
      customer.metadata.userId === userId;
    const legacyOwnership =
      !customer.deleted &&
      legacyOrganization.id !== null &&
      legacyOrganization.creatorUserId === userId &&
      legacyOrganization.stripeCustomerId === persistedCustomerId &&
      customerId === persistedCustomerId &&
      customer.id === customerId &&
      customer.metadata.organizationId === legacyOrganization.id;
    if (!modernOwnership && !legacyOwnership) {
      throw new WinnerVerificationError();
    }
  }

  private async cancelLegacySubscription(
    stripeSubscriptionId: string,
  ): Promise<CancellationResult> {
    try {
      await this.stripe.subscriptions.cancel(
        stripeSubscriptionId,
        {},
        STRIPE_REQUEST_OPTIONS,
      );
      return 'cancelled';
    } catch (error: unknown) {
      if (this.isAlreadyGone(error)) return 'already-gone';
      throw error;
    }
  }

  private async verifyCandidate(
    candidateStripeId: string,
    organizationId: string,
    expectedCustomerId: string | null,
    persistedPlan: 'SIGNAL' | 'FLEET',
  ): Promise<'live' | 'already-gone'> {
    if (!expectedCustomerId) throw new CandidateVerificationError();

    let subscription: Stripe.Subscription;
    try {
      subscription = await this.stripe.subscriptions.retrieve(
        candidateStripeId,
        { expand: ['customer'] },
        STRIPE_REQUEST_OPTIONS,
      );
    } catch (error: unknown) {
      if (this.isResourceMissing(error)) return 'already-gone';
      throw new CandidateVerificationError();
    }

    if (subscription.id !== candidateStripeId) {
      throw new CandidateVerificationError();
    }
    if (
      subscription.status === 'canceled' ||
      subscription.status === 'incomplete_expired'
    ) {
      return 'already-gone';
    }

    const customer = subscription.customer;
    if (
      !LIVE_PAID_STATUSES.includes(
        subscription.status as (typeof LIVE_PAID_STATUSES)[number],
      ) ||
      typeof customer === 'string' ||
      customer.id !== expectedCustomerId ||
      customer.deleted ||
      customer.metadata.organizationId !== organizationId ||
      !this.hasRecognizedPaidPlan(subscription, persistedPlan)
    ) {
      throw new CandidateVerificationError();
    }
    return 'live';
  }

  private hasRecognizedPaidPlan(
    subscription: Pick<Stripe.Subscription, 'items'>,
    persistedPlan: 'SIGNAL' | 'FLEET',
  ): boolean {
    if (subscription.items.data.length !== 1) return false;
    const price = subscription.items.data[0]?.price;
    if (!price?.recurring) return false;
    const positiveAmount =
      (price.unit_amount !== null &&
        price.unit_amount !== undefined &&
        price.unit_amount > 0) ||
      (price.unit_amount_decimal !== null &&
        price.unit_amount_decimal !== undefined &&
        Number(price.unit_amount_decimal) > 0);
    return (
      positiveAmount && this.prices.planForPriceId(price.id) === persistedPlan
    );
  }

  private isResourceMissing(error: unknown): boolean {
    if (!error || typeof error !== 'object') return false;
    const candidate = error as {
      code?: unknown;
      raw?: { code?: unknown };
    };
    const code =
      typeof candidate.code === 'string' ? candidate.code : candidate.raw?.code;
    return code === 'resource_missing';
  }

  private isAlreadyGone(error: unknown): boolean {
    if (!error || typeof error !== 'object') return false;
    const candidate = error as {
      code?: unknown;
      raw?: { code?: unknown };
    };
    const code =
      typeof candidate.code === 'string' ? candidate.code : candidate.raw?.code;
    return (
      code === 'resource_missing' || code === 'subscription_already_canceled'
    );
  }
}

class WinnerVerificationError extends Error {}
class CandidateVerificationError extends Error {}
