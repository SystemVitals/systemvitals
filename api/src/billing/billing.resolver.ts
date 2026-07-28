import { Field, Int, ObjectType, Query, Resolver } from '@nestjs/graphql';
import { UseGuards } from '@nestjs/common';
import { ApiAuthGuard } from '../tokens/api-auth.guard';
import { CurrentUser } from '../common/current-user.decorator';
import type { JwtUser } from '../auth/jwt.strategy';
import { PrismaService } from '../prisma/prisma.service';
import { AccountEntitlementsService } from './account-entitlements.service';

@ObjectType()
export class SubscriptionStatus {
  @Field()
  plan!: string;

  @Field()
  status!: string;

  @Field(() => Int)
  maxChecks!: number;

  @Field(() => Int)
  checkCount!: number;

  @Field(() => Int)
  organizationCount!: number;
}

@Resolver()
@UseGuards(ApiAuthGuard)
export class BillingResolver {
  constructor(
    private readonly prisma: PrismaService,
    private readonly entitlements: AccountEntitlementsService,
  ) {}

  @Query(() => SubscriptionStatus)
  async mySubscription(
    @CurrentUser() user: JwtUser,
  ): Promise<SubscriptionStatus> {
    return this.prisma.$transaction(async (tx) => {
      const [sub, account] = await Promise.all([
        tx.subscription.findUnique({ where: { userId: user.userId } }),
        this.entitlements.forUser(tx, user.userId),
      ]);
      return {
        plan: account.plan,
        status: sub?.status ?? 'active',
        maxChecks: account.limits.maxChecks,
        checkCount: account.checkCount,
        organizationCount: account.organizationCount,
      };
    });
  }
}
