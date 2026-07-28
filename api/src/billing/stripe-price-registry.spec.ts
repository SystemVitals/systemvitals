import { StripePriceRegistry } from './stripe-price-registry';

describe('StripePriceRegistry', () => {
  const originalEnv = { ...process.env };
  let registry: StripePriceRegistry;

  beforeEach(() => {
    delete process.env.STRIPE_PRICE_SIGNAL;
    delete process.env.STRIPE_PRICE_FLEET;
    registry = new StripePriceRegistry();
  });

  afterEach(() => {
    process.env = { ...originalEnv };
  });

  it('resolves registered prices by plan and interval', () => {
    registry.register('systemvitals_signal_month', 'price_sm');
    registry.register('systemvitals_signal_year', 'price_sy');
    expect(registry.priceIdFor('SIGNAL', 'month')).toBe('price_sm');
    expect(registry.priceIdFor('SIGNAL', 'year')).toBe('price_sy');
  });

  it('returns empty string for unknown prices', () => {
    expect(registry.priceIdFor('FLEET', 'year')).toBe('');
  });

  it('env override wins for monthly prices', () => {
    process.env.STRIPE_PRICE_SIGNAL = 'price_env_signal';
    registry.register('systemvitals_signal_month', 'price_sm');
    expect(registry.priceIdFor('SIGNAL', 'month')).toBe('price_env_signal');
    // yearly is unaffected by the monthly override
    registry.register('systemvitals_signal_year', 'price_sy');
    expect(registry.priceIdFor('SIGNAL', 'year')).toBe('price_sy');
  });

  it('maps price ids back to plans, including yearly and env overrides', () => {
    process.env.STRIPE_PRICE_FLEET = 'price_env_fleet';
    registry.register('systemvitals_signal_year', 'price_sy');
    expect(registry.planForPriceId('price_sy')).toBe('SIGNAL');
    expect(registry.planForPriceId('price_env_fleet')).toBe('FLEET');
    expect(registry.planForPriceId('price_unknown')).toBeNull();
  });
});
