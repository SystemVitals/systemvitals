import { BadRequestException } from '@nestjs/common';
import { BillingActionsResolver } from './billing-actions.resolver';
import { BillingService } from './billing.service';

describe('BillingActionsResolver', () => {
  const user = { userId: 'u1', email: 'agent@example.test' };
  function setup() {
    const createCheckout = jest
      .fn()
      .mockResolvedValue({ url: 'https://checkout.example.test' });
    const createPortal = jest
      .fn()
      .mockResolvedValue({ url: 'https://portal.example.test' });
    const resolver = new BillingActionsResolver({
      createCheckout,
      createPortal,
    } as unknown as BillingService);
    return { resolver, createCheckout, createPortal };
  }
  it('uses the authenticated account and defaults checkout to monthly', async () => {
    const { resolver, createCheckout } = setup();
    await expect(
      resolver.createBillingCheckout(user, 'SIGNAL'),
    ).resolves.toHaveProperty('url');
    expect(createCheckout).toHaveBeenCalledWith('u1', 'SIGNAL', 'month');
  });
  it.each([
    ['SOLO', 'month'],
    ['FLEET', 'week'],
  ])('rejects invalid checkout %s/%s', async (plan, interval) => {
    const { resolver, createCheckout } = setup();
    await expect(
      resolver.createBillingCheckout(user, plan, interval),
    ).rejects.toThrow(BadRequestException);
    expect(createCheckout).not.toHaveBeenCalled();
  });
  it('returns a portal link for the authenticated account', async () => {
    const { resolver, createPortal } = setup();
    await expect(resolver.createBillingPortal(user)).resolves.toHaveProperty(
      'url',
    );
    expect(createPortal).toHaveBeenCalledWith('u1');
  });
});
