import { Module } from '@nestjs/common';
import { BillingController } from './billing.controller';
import { BillingService } from './billing.service';
import { BillingResolver } from './billing.resolver';
import { stripeClientFactory } from './stripe.provider';
import { StripePriceRegistry } from './stripe-price-registry';
import { StripePlanBootstrapService } from './stripe-plan-bootstrap.service';
import { AccountEntitlementsService } from './account-entitlements.service';
import { SubscriptionReconciliationService } from './subscription-reconciliation.service';
import { ReconciliationRunLock } from './subscription-reconciliation-lock';
import { AuthModule } from '../auth/auth.module';
import { TokensCoreModule } from '../tokens/tokens-core.module';
import { BillingActionsResolver } from './billing-actions.resolver';

@Module({
  imports: [AuthModule, TokensCoreModule],
  controllers: [BillingController],
  providers: [
    stripeClientFactory,
    StripePriceRegistry,
    StripePlanBootstrapService,
    BillingService,
    BillingResolver,
    BillingActionsResolver,
    AccountEntitlementsService,
    SubscriptionReconciliationService,
    ReconciliationRunLock,
  ],
  exports: [
    BillingService,
    AccountEntitlementsService,
    SubscriptionReconciliationService,
  ],
})
export class BillingModule {}
