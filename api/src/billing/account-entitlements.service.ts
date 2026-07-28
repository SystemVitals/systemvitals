import {
  BadRequestException,
  ForbiddenException,
  Injectable,
} from '@nestjs/common';
import { Prisma } from '@systemvitals/database';
import { PrismaService } from '../prisma/prisma.service';
import {
  ACCOUNT_USER_LOCK_HASH_SEED,
  accountUserLockKey,
  sortedUniqueUserIds,
} from './account-user-lock';
import { effectiveLimits, type PlanLimits, type PlanTier } from './plan-limits';

export const SOLO_ORGANIZATION_LIMIT = 10;

export interface AccountEntitlements {
  plan: PlanTier;
  limits: PlanLimits;
  checkCount: number;
  organizationCount: number;
}

export function assertInterval(
  entitlements: AccountEntitlements,
  intervalSeconds: number,
): void {
  if (intervalSeconds < entitlements.limits.minIntervalSeconds) {
    throw new BadRequestException(
      `Interval of ${intervalSeconds}s is below the minimum interval of ${entitlements.limits.minIntervalSeconds}s for your plan. Please upgrade to use shorter intervals.`,
    );
  }
}

export function assertCanAddCheck(entitlements: AccountEntitlements): void {
  if (entitlements.checkCount >= entitlements.limits.maxChecks) {
    throw new ForbiddenException(
      `Your plan limit of ${entitlements.limits.maxChecks} checks has been reached. Please upgrade your plan to create more checks.`,
    );
  }
}

@Injectable()
export class AccountEntitlementsService {
  constructor(private readonly prisma: PrismaService) {}

  async lockUsers(
    tx: Prisma.TransactionClient,
    userIds: string[],
  ): Promise<void> {
    for (const userId of sortedUniqueUserIds(userIds)) {
      await tx.$queryRaw`
        SELECT CAST(
          pg_advisory_xact_lock(
            hashtextextended(
              ${accountUserLockKey(userId)},
              ${ACCOUNT_USER_LOCK_HASH_SEED}
            )
          ) AS TEXT
        ) AS locked
      `;
      await this.lockUserRow(tx, userId);
    }
  }

  async lockUserRows(
    tx: Prisma.TransactionClient,
    userIds: string[],
  ): Promise<void> {
    for (const userId of sortedUniqueUserIds(userIds)) {
      await this.lockUserRow(tx, userId);
    }
  }

  private async lockUserRow(
    tx: Prisma.TransactionClient,
    userId: string,
  ): Promise<void> {
    await tx.$queryRaw`
        SELECT id FROM users WHERE id = ${userId} FOR UPDATE
      `;
  }

  async forUser(
    tx: Prisma.TransactionClient,
    userId: string,
  ): Promise<AccountEntitlements> {
    const [subscription, checkCount, organizationCount] = await Promise.all([
      tx.subscription.findUnique({ where: { userId } }),
      tx.check.count({
        where: {
          project: {
            organization: { creatorUserId: userId },
          },
        },
      }),
      tx.organization.count({ where: { creatorUserId: userId } }),
    ]);
    const plan: PlanTier = subscription?.plan ?? 'SOLO';

    return {
      plan,
      limits: effectiveLimits(plan, subscription?.limits ?? null),
      checkCount,
      organizationCount,
    };
  }

  assertCanAddOrganization(entitlements: AccountEntitlements): void {
    if (
      entitlements.plan === 'SOLO' &&
      entitlements.organizationCount >= SOLO_ORGANIZATION_LIMIT
    ) {
      throw new BadRequestException(
        'Solo accounts can create or receive at most 10 organizations.',
      );
    }
  }

  assertInterval(
    entitlements: AccountEntitlements,
    intervalSeconds: number,
  ): void {
    assertInterval(entitlements, intervalSeconds);
  }

  assertCanAddCheck(entitlements: AccountEntitlements): void {
    assertCanAddCheck(entitlements);
  }
}
