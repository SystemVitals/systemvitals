import Stripe from 'stripe';

/**
 * DI token for the Stripe client.
 * Tests can override this with a fake:
 *   .overrideProvider(STRIPE_CLIENT).useValue(fakeStripe)
 */
export const STRIPE_CLIENT = Symbol('STRIPE_CLIENT');

export const stripeClientFactory = {
  provide: STRIPE_CLIENT,
  useFactory: (): Stripe => {
    if (
      process.env.NODE_ENV === 'production' &&
      !process.env.STRIPE_SECRET_KEY
    ) {
      console.warn(
        '[billing] STRIPE_SECRET_KEY is not set in production — billing endpoints will fail',
      );
    }
    // `||` (not `??`): an empty string — e.g. from a compose `${VAR:-}`
    // default — must also fall back, matching the warning condition above.
    return new Stripe(process.env.STRIPE_SECRET_KEY || 'sk_test_dummy');
  },
};
