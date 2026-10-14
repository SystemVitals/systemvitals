import { Args, Field, Mutation, ObjectType, Resolver } from '@nestjs/graphql';
import { BadRequestException } from '@nestjs/common';
import { CurrentUser } from '../common/current-user.decorator';
import type { JwtUser } from '../auth/jwt.strategy';
import { AccountAccess } from '../tokens/account-access.guard';
import { BillingService } from './billing.service';

@ObjectType()
export class BillingLink {
  @Field() url!: string;
}

@Resolver()
@AccountAccess()
export class BillingActionsResolver {
  constructor(private readonly billing: BillingService) {}

  @Mutation(() => BillingLink)
  async createBillingCheckout(
    @CurrentUser() user: JwtUser,
    @Args('plan') plan: string,
    @Args('interval', { type: () => String, nullable: true })
    interval?: string | null,
  ): Promise<BillingLink> {
    if (plan !== 'SIGNAL' && plan !== 'FLEET') {
      throw new BadRequestException('Invalid billing plan');
    }
    const billingInterval = interval ?? 'month';
    if (billingInterval !== 'month' && billingInterval !== 'year') {
      throw new BadRequestException('Invalid billing interval');
    }
    return this.billing.createCheckout(user.userId, plan, billingInterval);
  }

  @Mutation(() => BillingLink)
  createBillingPortal(@CurrentUser() user: JwtUser): Promise<BillingLink> {
    return this.billing.createPortal(user.userId);
  }
}
