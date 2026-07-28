import { BadRequestException } from '@nestjs/common';
import { AdminService } from './admin.service';

describe('AdminService.deleteOrganization', () => {
  const tx = {
    organization: {
      findUnique: jest.fn(),
      delete: jest.fn(),
    },
    subscription: {
      findFirst: jest.fn(),
    },
    auditLog: {
      create: jest.fn(),
    },
    $queryRaw: jest.fn().mockResolvedValue([]),
  };
  const prisma = {
    $transaction: jest.fn((callback: (client: typeof tx) => Promise<boolean>) =>
      callback(tx),
    ),
    auditLog: {
      create: jest.fn(),
    },
    organization: {
      delete: jest.fn().mockResolvedValue({ id: 'org1' }),
    },
  };
  const entitlements = { lockUsers: jest.fn() };
  const service = new AdminService(
    prisma as never,
    {} as never,
    entitlements as never,
  );

  beforeEach(() => {
    jest.clearAllMocks();
    tx.organization.findUnique.mockResolvedValue({
      id: 'org1',
      creatorUserId: 'creator1',
    });
    tx.subscription.findFirst.mockResolvedValue(null);
    tx.organization.delete.mockResolvedValue({ id: 'org1' });
    tx.auditLog.create.mockResolvedValue({});
  });

  it('rejects unresolved legacy billing without auditing or deleting', async () => {
    tx.subscription.findFirst.mockResolvedValue({ id: 'legacy-sub' });

    await expect(service.deleteOrganization('admin1', 'org1')).rejects.toThrow(
      new BadRequestException(
        'Complete account subscription reconciliation before transferring/deleting this organization.',
      ),
    );

    expect(entitlements.lockUsers).toHaveBeenCalledWith(tx, ['creator1']);
    expect(tx.auditLog.create).not.toHaveBeenCalled();
    expect(tx.organization.delete).not.toHaveBeenCalled();
  });

  it('deletes canceled legacy billing provenance without changing it', async () => {
    await expect(service.deleteOrganization('admin1', 'org1')).resolves.toBe(
      true,
    );

    expect(tx.organization.delete).toHaveBeenCalledWith({
      where: { id: 'org1' },
    });
    expect(tx.auditLog.create).toHaveBeenCalledTimes(1);
  });
});
