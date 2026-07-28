import {
  Inject,
  Injectable,
  Logger,
  OnApplicationBootstrap,
} from '@nestjs/common';
import Stripe from 'stripe';
import { STRIPE_CLIENT } from './stripe.provider';
import { StripePriceRegistry } from './stripe-price-registry';
import {
  PaidPlan,
  PLAN_CURRENCY,
  PLAN_PRICES,
  PLAN_PRODUCT_NAMES,
} from './plan-pricing';

const PLAN_METADATA_KEY = 'systemvitals_plan';

/**
 * Idempotently reconciles the plan catalog (plan-pricing.ts) into Stripe on
 * boot: finds prices by lookup_key, creating missing products/prices, and
 * replacing prices whose amount drifted (transfer_lookup_key keeps the key
 * pointing at the current price; existing subscriptions stay on the old one).
 * Populates StripePriceRegistry either way. Must never crash boot.
 */
@Injectable()
export class StripePlanBootstrapService implements OnApplicationBootstrap {
  private readonly logger = new Logger(StripePlanBootstrapService.name);

  constructor(
    @Inject(STRIPE_CLIENT) private readonly stripe: Stripe,
    private readonly registry: StripePriceRegistry,
  ) {}

  async onApplicationBootstrap(): Promise<void> {
    if (!process.env.STRIPE_SECRET_KEY) {
      this.logger.log(
        'STRIPE_SECRET_KEY not set — skipping Stripe plan bootstrap',
      );
      return;
    }
    try {
      await this.ensurePlans();
    } catch (err) {
      this.logger.error(
        `Stripe plan bootstrap failed — billing may be unavailable: ${String(err)}`,
      );
    }
  }

  async ensurePlans(): Promise<void> {
    const existing = await this.stripe.prices.list({
      lookup_keys: PLAN_PRICES.map((p) => p.lookupKey),
      limit: PLAN_PRICES.length,
    });
    const byLookupKey = new Map(
      existing.data.map((price) => [price.lookup_key ?? '', price]),
    );

    const productIds = new Map<PaidPlan, string>();

    for (const entry of PLAN_PRICES) {
      const found = byLookupKey.get(entry.lookupKey);

      if (found && found.unit_amount === entry.unitAmount) {
        this.registry.register(entry.lookupKey, found.id);
        continue;
      }

      const productId = found
        ? typeof found.product === 'string'
          ? found.product
          : found.product.id
        : await this.ensureProduct(entry.plan, productIds);

      const price = await this.stripe.prices.create({
        product: productId,
        currency: PLAN_CURRENCY,
        unit_amount: entry.unitAmount,
        recurring: { interval: entry.interval },
        lookup_key: entry.lookupKey,
        // No-op on fresh keys; on amount drift it moves the key to this price.
        transfer_lookup_key: true,
      });
      this.registry.register(entry.lookupKey, price.id);
      this.logger.log(
        `Created Stripe price ${entry.lookupKey} (${price.id}, $${entry.unitAmount / 100}/${entry.interval})`,
      );
    }
  }

  private async ensureProduct(
    plan: PaidPlan,
    cache: Map<PaidPlan, string>,
  ): Promise<string> {
    const cached = cache.get(plan);
    if (cached) return cached;

    const products = await this.stripe.products.list({
      active: true,
      limit: 100,
    });
    let product = products.data.find(
      (p) => p.metadata?.[PLAN_METADATA_KEY] === plan,
    );
    if (!product) {
      product = await this.stripe.products.create({
        name: PLAN_PRODUCT_NAMES[plan],
        metadata: { [PLAN_METADATA_KEY]: plan },
      });
      this.logger.log(`Created Stripe product ${product.name} (${product.id})`);
    }
    cache.set(plan, product.id);
    return product.id;
  }
}
