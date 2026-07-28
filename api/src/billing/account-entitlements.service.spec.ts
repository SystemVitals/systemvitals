import { BadRequestException, ForbiddenException } from '@nestjs/common';
import {
  AccountEntitlementsService,
  SOLO_ORGANIZATION_LIMIT,
  assertCanAddCheck,
  assertInterval,
  type AccountEntitlements,
} from './account-entitlements.service';
import { PLAN_LIMITS } from './plan-limits';

function fakeTransaction() {
  return {
    subscription: { findUnique: jest.fn() },
    check: { count: jest.fn() },
    organization: { count: jest.fn() },
    $queryRaw: jest.fn().mockResolvedValue([]),
  };
}

function entitlements(
  overrides: Partial<AccountEntitlements> = {},
): AccountEntitlements {
  return {
    plan: 'SOLO',
    limits: PLAN_LIMITS.SOLO,
    checkCount: 0,
    organizationCount: 0,
    ...overrides,
  };
}

describe('AccountEntitlementsService', () => {
  const service = new AccountEntitlementsService({} as never);

  it('counts checks across every organization attributed to the account with the exact creator filter', async () => {
    const tx = fakeTransaction();
    tx.subscription.findUnique.mockResolvedValue({
      plan: 'SIGNAL',
      limits: null,
    });
    tx.check.count.mockResolvedValue(12);
    tx.organization.count.mockResolvedValue(3);

    await expect(service.forUser(tx as never, 'user-1')).resolves.toEqual({
      plan: 'SIGNAL',
      limits: PLAN_LIMITS.SIGNAL,
      checkCount: 12,
      organizationCount: 3,
    });
    expect(tx.subscription.findUnique).toHaveBeenCalledWith({
      where: { userId: 'user-1' },
    });
    expect(tx.check.count).toHaveBeenCalledWith({
      where: {
        project: {
          organization: { creatorUserId: 'user-1' },
        },
      },
    });
    expect(tx.organization.count).toHaveBeenCalledWith({
      where: { creatorUserId: 'user-1' },
    });
  });

  it('falls back to SOLO and merges account subscription custom limits', async () => {
    const customTx = fakeTransaction();
    customTx.subscription.findUnique.mockResolvedValue({
      plan: 'SOLO',
      limits: { maxChecks: 8 },
    });
    customTx.check.count.mockResolvedValue(2);
    customTx.organization.count.mockResolvedValue(1);

    await expect(
      service.forUser(customTx as never, 'custom-user'),
    ).resolves.toMatchObject({
      plan: 'SOLO',
      limits: {
        maxChecks: 8,
        minIntervalSeconds: PLAN_LIMITS.SOLO.minIntervalSeconds,
      },
    });

    const fallbackTx = fakeTransaction();
    fallbackTx.subscription.findUnique.mockResolvedValue(null);
    fallbackTx.check.count.mockResolvedValue(0);
    fallbackTx.organization.count.mockResolvedValue(0);

    await expect(
      service.forUser(fallbackTx as never, 'new-user'),
    ).resolves.toMatchObject({
      plan: 'SOLO',
      limits: PLAN_LIMITS.SOLO,
    });
  });

  it('allows a tenth SOLO organization at 9 and rejects another at 10', () => {
    expect(SOLO_ORGANIZATION_LIMIT).toBe(10);
    expect(() =>
      service.assertCanAddOrganization(entitlements({ organizationCount: 9 })),
    ).not.toThrow();
    expect(() =>
      service.assertCanAddOrganization(entitlements({ organizationCount: 10 })),
    ).toThrow(
      new BadRequestException(
        'Solo accounts can create or receive at most 10 organizations.',
      ),
    );
  });

  it.each(['SIGNAL', 'FLEET'] as const)(
    'allows unlimited organizations on %s',
    (plan) => {
      expect(() =>
        service.assertCanAddOrganization(
          entitlements({ plan, organizationCount: 10_000 }),
        ),
      ).not.toThrow();
    },
  );

  it('takes namespaced advisory locks then row locks for deduplicated users in sorted order', async () => {
    const tx = fakeTransaction();

    await service.lockUsers(tx as never, ['z-user', 'a-user', 'z-user']);

    expect(tx.$queryRaw).toHaveBeenCalledTimes(4);
    const calls = tx.$queryRaw.mock.calls as unknown[][];
    expect(calls.map((call) => call[1])).toEqual([
      'systemvitals:account-lock:v1:a-user',
      'a-user',
      'systemvitals:account-lock:v1:z-user',
      'z-user',
    ]);
    expect(calls[0]?.[0]).toEqual(
      expect.arrayContaining([
        expect.stringMatching(/pg_advisory_xact_lock/),
        expect.stringMatching(/hashtextextended/),
      ]),
    );
    expect(calls[1]?.[0]).toEqual(
      expect.arrayContaining([
        expect.stringMatching(/SELECT id FROM users WHERE id =\s*$/),
        expect.stringMatching(/FOR UPDATE/),
      ]),
    );
  });

  it('accepts the minimum interval and rejects only shorter intervals with BadRequestException', () => {
    const account = entitlements({
      limits: { maxChecks: 5, minIntervalSeconds: 60 },
    });

    expect(() => assertInterval(account, 60)).not.toThrow();
    expect(() => service.assertInterval(account, 59)).toThrow(
      new BadRequestException(
        'Interval of 59s is below the minimum interval of 60s for your plan. Please upgrade to use shorter intervals.',
      ),
    );
  });

  it('clamps a paid subscription interval override to one minute before validating checks', async () => {
    const tx = fakeTransaction();
    tx.subscription.findUnique.mockResolvedValue({
      plan: 'SIGNAL',
      limits: { minIntervalSeconds: 1 },
    });
    tx.check.count.mockResolvedValue(0);
    tx.organization.count.mockResolvedValue(1);

    const account = await service.forUser(tx as never, 'paid-user');

    expect(account.limits.minIntervalSeconds).toBe(60);
    expect(() => service.assertInterval(account, 59)).toThrow(
      new BadRequestException(
        'Interval of 59s is below the minimum interval of 60s for your plan. Please upgrade to use shorter intervals.',
      ),
    );
    expect(() => service.assertInterval(account, 60)).not.toThrow();
  });

  it('allows the last available check and rejects adding beyond the shared cap with ForbiddenException', () => {
    const belowCap = entitlements({
      limits: { maxChecks: 5, minIntervalSeconds: 300 },
      checkCount: 4,
    });
    const atCap = entitlements({ ...belowCap, checkCount: 5 });

    expect(() => service.assertCanAddCheck(belowCap)).not.toThrow();
    expect(() => assertCanAddCheck(atCap)).toThrow(
      new ForbiddenException(
        'Your plan limit of 5 checks has been reached. Please upgrade your plan to create more checks.',
      ),
    );
    expect(atCap.checkCount).toBe(5);
  });
});
