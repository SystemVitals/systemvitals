import { Module, type INestApplicationContext } from '@nestjs/common';
import { ConfigModule } from '@nestjs/config';
import { NestFactory } from '@nestjs/core';
import { AccountEntitlementsService } from './billing/account-entitlements.service';
import { SubscriptionReconciliationService } from './billing/subscription-reconciliation.service';
import {
  ReconciliationLockUnavailableError,
  ReconciliationRunLock,
} from './billing/subscription-reconciliation-lock';
import { stripeClientFactory } from './billing/stripe.provider';
import { StripePriceRegistry } from './billing/stripe-price-registry';
import { PrismaModule } from './prisma/prisma.module';

@Module({
  imports: [ConfigModule.forRoot({ isGlobal: true }), PrismaModule],
  providers: [
    stripeClientFactory,
    AccountEntitlementsService,
    ReconciliationRunLock,
    StripePriceRegistry,
    SubscriptionReconciliationService,
  ],
})
export class ReconciliationCommandModule {}

type ReconciliationContext = Pick<INestApplicationContext, 'get' | 'close'>;
type ContextFactory = () => Promise<ReconciliationContext>;

const createContext: ContextFactory = () =>
  NestFactory.createApplicationContext(ReconciliationCommandModule, {
    logger: false,
  });

export async function runReconciliation(
  contextFactory: ContextFactory = createContext,
): Promise<void> {
  const app = await contextFactory();

  try {
    const reconciliation = app.get(SubscriptionReconciliationService);
    const summary = await reconciliation.reconcile();
    console.log(JSON.stringify(summary));
    if (summary.failures.length > 0) process.exitCode = 1;
  } finally {
    await app.close();
  }
}

export async function executeReconciliationCommand(
  run: () => Promise<void> = runReconciliation,
): Promise<void> {
  try {
    await run();
  } catch (error: unknown) {
    process.exitCode = 1;
    console.error(
      JSON.stringify({
        error:
          error instanceof ReconciliationLockUnavailableError
            ? 'Account subscription reconciliation is already running'
            : 'Account subscription reconciliation failed',
      }),
    );
  }
}

if (require.main === module) {
  void executeReconciliationCommand();
}
