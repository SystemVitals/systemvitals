import { stripeClientFactory } from './stripe.provider';

describe('stripeClientFactory', () => {
  const originalEnv = { ...process.env };

  afterEach(() => {
    process.env = { ...originalEnv };
  });

  it('constructs a client when STRIPE_SECRET_KEY is set', () => {
    process.env.STRIPE_SECRET_KEY = 'sk_test_something';
    expect(() => stripeClientFactory.useFactory()).not.toThrow();
  });

  it('falls back to a dummy key when STRIPE_SECRET_KEY is unset', () => {
    delete process.env.STRIPE_SECRET_KEY;
    expect(() => stripeClientFactory.useFactory()).not.toThrow();
  });

  it('falls back to a dummy key when STRIPE_SECRET_KEY is an empty string (compose ${VAR:-} default)', () => {
    process.env.NODE_ENV = 'production';
    process.env.STRIPE_SECRET_KEY = '';
    expect(() => stripeClientFactory.useFactory()).not.toThrow();
  });
});
