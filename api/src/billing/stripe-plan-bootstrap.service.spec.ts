import Stripe from 'stripe';
import { StripePlanBootstrapService } from './stripe-plan-bootstrap.service';
import { StripePriceRegistry } from './stripe-price-registry';
import { PLAN_PRICES } from './plan-pricing';

interface FakePrice {
  id: string;
  lookup_key: string;
  unit_amount: number;
  product: string;
}

function fakeStripe(existing: {
  prices?: FakePrice[];
  products?: { id: string; metadata: Record<string, string> }[];
}) {
  const prices = [...(existing.prices ?? [])];
  const products = [...(existing.products ?? [])];
  let priceSeq = 0;
  let productSeq = 0;

  const priceList = jest.fn(({ lookup_keys }: { lookup_keys: string[] }) =>
    Promise.resolve({
      data: prices.filter((p) => lookup_keys.includes(p.lookup_key)),
    }),
  );
  const priceCreate = jest.fn((params: Stripe.PriceCreateParams) => {
    const price: FakePrice = {
      id: `price_new_${priceSeq++}`,
      lookup_key: params.lookup_key ?? '',
      unit_amount: params.unit_amount ?? 0,
      product: String(params.product),
    };
    prices.push(price);
    return Promise.resolve(price);
  });
  const productList = jest.fn(() => Promise.resolve({ data: products }));
  const productCreate = jest.fn((params: Stripe.ProductCreateParams) => {
    const product = {
      id: `prod_new_${productSeq++}`,
      metadata: (params.metadata ?? {}) as Record<string, string>,
    };
    products.push(product);
    return Promise.resolve(product);
  });

  const stripe = {
    prices: { list: priceList, create: priceCreate },
    products: { list: productList, create: productCreate },
  } as unknown as Stripe;

  return {
    stripe,
    mocks: { priceList, priceCreate, productList, productCreate },
  };
}

describe('StripePlanBootstrapService', () => {
  const originalEnv = { ...process.env };

  beforeEach(() => {
    process.env.STRIPE_SECRET_KEY = 'sk_test_something';
  });

  afterEach(() => {
    process.env = { ...originalEnv };
  });

  it('creates all four prices (and one product per tier) from scratch', async () => {
    const { stripe, mocks } = fakeStripe({});
    const registry = new StripePriceRegistry();
    const service = new StripePlanBootstrapService(stripe, registry);

    await service.ensurePlans();

    expect(mocks.productCreate.mock.calls).toHaveLength(2);
    expect(mocks.priceCreate.mock.calls).toHaveLength(4);
    for (const { plan, interval } of PLAN_PRICES) {
      expect(registry.priceIdFor(plan, interval)).not.toBe('');
    }
  });

  it('is a no-op when all prices already exist', async () => {
    const { stripe, mocks } = fakeStripe({
      prices: PLAN_PRICES.map((p, i) => ({
        id: `price_existing_${i}`,
        lookup_key: p.lookupKey,
        unit_amount: p.unitAmount,
        product: 'prod_x',
      })),
    });
    const registry = new StripePriceRegistry();
    const service = new StripePlanBootstrapService(stripe, registry);

    await service.ensurePlans();

    expect(mocks.productCreate).not.toHaveBeenCalled();
    expect(mocks.priceCreate).not.toHaveBeenCalled();
    expect(registry.priceIdFor('SIGNAL', 'year')).toBe('price_existing_1');
  });

  it('replaces a price whose amount drifted, transferring the lookup key', async () => {
    const { stripe, mocks } = fakeStripe({
      prices: PLAN_PRICES.map((p, i) => ({
        id: `price_existing_${i}`,
        lookup_key: p.lookupKey,
        // drift the SIGNAL yearly amount
        unit_amount:
          p.lookupKey === 'systemvitals_signal_year' ? 9999 : p.unitAmount,
        product: 'prod_x',
      })),
    });
    const registry = new StripePriceRegistry();
    const service = new StripePlanBootstrapService(stripe, registry);

    await service.ensurePlans();

    const createCalls = mocks.priceCreate.mock.calls;
    expect(createCalls).toHaveLength(1);
    expect(createCalls[0][0]).toMatchObject({
      lookup_key: 'systemvitals_signal_year',
      transfer_lookup_key: true,
      unit_amount: 3000,
    });
    expect(registry.priceIdFor('SIGNAL', 'year')).toBe('price_new_0');
  });

  it('does nothing without a Stripe key', async () => {
    process.env.STRIPE_SECRET_KEY = '';
    const { stripe, mocks } = fakeStripe({});
    const registry = new StripePriceRegistry();
    const service = new StripePlanBootstrapService(stripe, registry);

    await service.onApplicationBootstrap();

    expect(mocks.priceList).not.toHaveBeenCalled();
  });

  it('never throws out of onApplicationBootstrap on Stripe errors', async () => {
    const { stripe, mocks } = fakeStripe({});
    mocks.priceList.mockRejectedValue(new Error('stripe down'));
    const registry = new StripePriceRegistry();
    const service = new StripePlanBootstrapService(stripe, registry);

    await expect(service.onApplicationBootstrap()).resolves.toBeUndefined();
  });
});
