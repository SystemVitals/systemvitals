import { IsIn, IsOptional } from 'class-validator';
import type { BillingInterval, PaidPlan } from './plan-pricing';

export class CheckoutDto {
  @IsIn(['SIGNAL', 'FLEET'])
  plan!: PaidPlan;

  @IsOptional()
  @IsIn(['month', 'year'])
  interval?: BillingInterval;
}

export class PortalDto {}
