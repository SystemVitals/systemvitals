import { BadRequestException } from '@nestjs/common';
import { Prisma } from '@systemvitals/database';
import { AdminService, parseAdminLimits } from './admin.service';

describe('parseAdminLimits', () => {
  it.each([
    ['not-json', 'not valid JSON'],
    ['null', 'JSON object'],
    ['[]', 'JSON object'],
    ['{"unknown":1}', 'unsupported key'],
    ['{"maxChecks":0}', 'positive integer'],
    ['{"maxChecks":-1}', 'positive integer'],
    ['{"maxChecks":1.5}', 'positive integer'],
    ['{"maxChecks":"1"}', 'positive integer'],
    ['{"maxChecks":1e400}', 'positive integer'],
    ['{"minIntervalSeconds":0}', 'positive integer'],
    ['{"minIntervalSeconds":-1}', 'positive integer'],
    ['{"minIntervalSeconds":1.5}', 'positive integer'],
    ['{"minIntervalSeconds":"1"}', 'positive integer'],
    ['{"minIntervalSeconds":1e400}', 'positive integer'],
  ])('rejects %s', (input, message) => {
    expect(() => parseAdminLimits(input)).toThrow(message);
  });

  it('accepts exactly the registered custom-limit keys', () => {
    expect(
      parseAdminLimits('{"maxChecks":25,"minIntervalSeconds":15}'),
    ).toEqual({ maxChecks: 25, minIntervalSeconds: 15 });
  });

  it.each([null, undefined, '{}'])(
    'treats %s as clearing custom limits',
    (input) => {
      expect(parseAdminLimits(input)).toBeUndefined();
    },
  );
});

describe('AdminService.deleteUser', () => {
  const tx = {
    user: { findUnique: jest.fn(), delete: jest.fn() },
    organization: { count: jest.fn() },
    checkoutCleanupIntent: { count: jest.fn() },
    checkoutOperation: { count: jest.fn() },
    auditLog: { create: jest.fn() },
  };
  const prisma = {
    $transaction: jest.fn((callback: (client: typeof tx) => Promise<boolean>) =>
      callback(tx),
    ),
  };
  const entitlements = { lockUsers: jest.fn() };
  const service = new AdminService(
    prisma as never,
    {} as never,
    entitlements as never,
  );

  beforeEach(() => {
    jest.clearAllMocks();
    tx.user.findUnique.mockResolvedValue({
      id: 'target',
      subscription: {
        plan: 'SOLO',
        status: 'active',
        stripeSubscriptionId: null,
      },
      checkoutAttemptId: null,
      checkoutAttemptPlan: null,
      checkoutAttemptInterval: null,
      checkoutAttemptCreatedAt: null,
      checkoutSessionId: null,
      checkoutSessionUrl: null,
      checkoutSessionExpiresAt: null,
      checkoutCleanupSessionId: null,
      checkoutCleanupCreatedAt: null,
    });
    tx.organization.count.mockResolvedValue(0);
    tx.checkoutCleanupIntent.count.mockResolvedValue(0);
    tx.checkoutOperation.count.mockResolvedValue(0);
    tx.user.delete.mockResolvedValue({ id: 'target' });
    tx.auditLog.create.mockResolvedValue({});
  });

  it('locks the target and rejects an organization creator without auditing or deleting', async () => {
    tx.organization.count.mockResolvedValue(1);

    await expect(service.deleteUser('actor', 'target')).rejects.toThrow(
      new BadRequestException(
        'Transfer organization creatorship before deleting this account',
      ),
    );

    expect(entitlements.lockUsers).toHaveBeenCalledWith(tx, ['target']);
    expect(tx.auditLog.create).not.toHaveBeenCalled();
    expect(tx.user.delete).not.toHaveBeenCalled();
  });

  it.each([
    ['SIGNAL', 'active', null],
    ['FLEET', 'trialing', null],
    ['SIGNAL', 'past_due', null],
    ['SOLO', 'active', 'sub_live'],
  ])(
    'rejects live paid billing (%s/%s/%s) without auditing or deleting',
    async (plan, status, stripeSubscriptionId) => {
      tx.user.findUnique.mockResolvedValue({
        id: 'target',
        subscription: { plan, status, stripeSubscriptionId },
      });

      await expect(service.deleteUser('actor', 'target')).rejects.toThrow(
        new BadRequestException(
          'Cancel account billing before deleting this account',
        ),
      );

      expect(tx.auditLog.create).not.toHaveBeenCalled();
      expect(tx.user.delete).not.toHaveBeenCalled();
    },
  );

  it('rejects a queued checkout cleanup intent without deleting', async () => {
    tx.checkoutCleanupIntent.count.mockResolvedValue(2);

    await expect(service.deleteUser('actor', 'target')).rejects.toThrow(
      'Resolve account checkout before deleting this account',
    );
    expect(tx.user.delete).not.toHaveBeenCalled();
  });

  it('rejects an in-flight checkout operation without deleting', async () => {
    tx.checkoutOperation.count.mockResolvedValue(2);

    await expect(service.deleteUser('actor', 'target')).rejects.toThrow(
      'Resolve account checkout before deleting this account',
    );
    expect(tx.user.delete).not.toHaveBeenCalled();
  });

  it.each([
    ['unresolved attempt', { checkoutAttemptId: 'attempt_pending' }],
    [
      'known open session',
      {
        checkoutAttemptId: 'attempt_open',
        checkoutSessionId: 'cs_open',
        checkoutSessionUrl: 'https://stripe.test/open',
      },
    ],
    ['partial persisted state', { checkoutAttemptPlan: 'SIGNAL' }],
    [
      'orphan session cleanup',
      {
        checkoutCleanupSessionId: 'cs_cleanup',
        checkoutCleanupCreatedAt: new Date(),
      },
    ],
  ])(
    'rejects %s without auditing or deleting',
    async (_label, checkoutState) => {
      tx.user.findUnique.mockResolvedValue({
        id: 'target',
        subscription: {
          plan: 'SOLO',
          status: 'active',
          stripeSubscriptionId: null,
        },
        checkoutAttemptId: null,
        checkoutAttemptPlan: null,
        checkoutAttemptInterval: null,
        checkoutAttemptCreatedAt: null,
        checkoutSessionId: null,
        checkoutSessionUrl: null,
        checkoutSessionExpiresAt: null,
        checkoutCleanupSessionId: null,
        checkoutCleanupCreatedAt: null,
        ...checkoutState,
      });

      await expect(service.deleteUser('actor', 'target')).rejects.toThrow(
        new BadRequestException(
          'Resolve account checkout before deleting this account',
        ),
      );

      expect(tx.auditLog.create).not.toHaveBeenCalled();
      expect(tx.user.delete).not.toHaveBeenCalled();
    },
  );

  it('deletes a transferred SOLO account and audits exactly once in the transaction', async () => {
    await expect(service.deleteUser('actor', 'target')).resolves.toBe(true);

    expect(tx.user.delete).toHaveBeenCalledTimes(1);
    expect(tx.user.delete).toHaveBeenCalledWith({ where: { id: 'target' } });
    expect(tx.auditLog.create).toHaveBeenCalledTimes(1);
    expect(tx.auditLog.create).toHaveBeenCalledWith({
      data: {
        actorUserId: 'actor',
        action: 'user.delete',
        targetType: 'user',
        targetId: 'target',
        metadata: Prisma.JsonNull,
      },
    });
  });
});
