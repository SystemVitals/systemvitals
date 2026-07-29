import { BadRequestException, ForbiddenException } from '@nestjs/common';
import { OrganizationsService } from './organizations.service';
import type { PrismaService } from '../prisma/prisma.service';
import type { AccountEntitlementsService } from '../billing/account-entitlements.service';

// Left untyped (not asserted to `PrismaService` here) so that referencing a
// mock method below — e.g. `prisma.membership.create` in an `expect(...)`
// call — resolves to plain `jest.Mock`, not a Prisma delegate method typed
// with an implicit `this`. Only `serviceWithTx` casts to `PrismaService`,
// right at the constructor boundary that requires it.
//
// `tx` is a DISTINCT object with its own `jest.fn()` mocks for everything
// `update()` and `remove()` touch inside their transaction callbacks — not the
// same mocks as the top-level Prisma client. This mirrors members.service.spec:
// a regression that silently swaps `tx.*` back to `this.prisma.*` leaves the
// transaction mocks uncalled and fails the authorization/write assertions.
function makePrisma(overrides: Record<string, unknown> = {}) {
  const tx = {
    user: {
      findUniqueOrThrow: jest.fn().mockResolvedValue({
        id: 'u1',
        email: 'owner@example.com',
      }),
    },
    organization: {
      create: jest.fn(),
      findUnique: jest.fn(),
      findUniqueOrThrow: jest.fn(),
      update: jest.fn(),
      delete: jest.fn(),
    },
    check: { count: jest.fn().mockResolvedValue(0) },
    project: { create: jest.fn() },
    membership: {
      create: jest.fn(),
      count: jest.fn().mockResolvedValue(0),
      findUnique: jest.fn().mockResolvedValue(null),
    },
    subscription: {
      findFirst: jest.fn().mockResolvedValue(null),
    },
    $queryRaw: jest.fn().mockResolvedValue([]),
  };
  const prisma = {
    tx,
    membership: {
      count: jest.fn().mockResolvedValue(0),
      findUnique: jest.fn().mockResolvedValue(null),
      findMany: jest.fn().mockResolvedValue([]),
      create: jest.fn(),
      delete: jest.fn(),
    },
    organization: {
      findMany: jest.fn().mockResolvedValue([]),
      create: jest.fn(),
      update: jest.fn(),
      delete: jest.fn(),
      findUniqueOrThrow: jest.fn(),
    },
    subscription: { create: jest.fn() },
    project: { create: jest.fn() },
    $transaction: jest.fn((fn: (tx: unknown) => unknown) => fn(tx)),
    ...overrides,
  };
  return prisma;
}

function harmlessEntitlementsMock(): AccountEntitlementsService {
  return {
    lockUsers: jest.fn(),
    forUser: jest.fn(),
    assertCanAddOrganization: jest.fn(),
  } as unknown as AccountEntitlementsService;
}

function makeService(prisma: ReturnType<typeof makePrisma>) {
  return new OrganizationsService(
    prisma as unknown as PrismaService,
    harmlessEntitlementsMock(),
  );
}

describe('OrganizationsService.create', () => {
  function serviceWithTx(
    prisma: ReturnType<typeof makePrisma>,
    account: {
      plan: 'SOLO' | 'SIGNAL' | 'FLEET';
      organizationCount: number;
    } = {
      plan: 'SOLO',
      organizationCount: 1,
    },
  ) {
    const entitlements = {
      lockUsers: jest.fn().mockResolvedValue(undefined),
      forUser: jest.fn().mockResolvedValue(account),
      assertCanAddOrganization: jest.fn(),
    };
    prisma.tx.organization.create.mockImplementation(
      ({ data }: { data: { name: string; slug: string } }) =>
        Promise.resolve({ id: 'org-new', name: data.name, slug: data.slug }),
    );
    prisma.tx.project.create.mockResolvedValue({
      id: 'project-default',
      name: 'Default',
      slug: 'default',
      pingKey: 'ping-key',
      organizationId: 'org-new',
    });
    const service = new OrganizationsService(
      prisma as unknown as PrismaService,
      entitlements as unknown as AccountEntitlementsService,
    );
    return { service, entitlements };
  }

  it('creates a creator-owned starter shape inheriting the account plan', async () => {
    const prisma = makePrisma();
    const { service: svc, entitlements } = serviceWithTx(prisma);

    const row = await svc.create('u1', 'Acme Inc');

    expect(row).toEqual({
      id: 'org-new',
      name: 'Acme Inc',
      slug: 'acme-inc',
      pingKey: 'ping-key',
      role: 'OWNER',
      plan: 'SOLO',
      creatorUserId: 'u1',
      creatorLabel: 'owner@example.com',
      projects: [
        {
          id: 'project-default',
          name: 'Default',
          slug: 'default',
          pingKey: 'ping-key',
          organizationId: 'org-new',
        },
      ],
    });
    expect(entitlements.lockUsers).toHaveBeenCalledWith(prisma.tx, ['u1']);
    expect(entitlements.forUser).toHaveBeenCalledWith(prisma.tx, 'u1');
    expect(entitlements.assertCanAddOrganization).toHaveBeenCalledWith(
      expect.objectContaining({ plan: 'SOLO', organizationCount: 1 }),
    );
    expect(prisma.tx.organization.create).toHaveBeenCalledWith({
      data: { name: 'Acme Inc', slug: 'acme-inc', creatorUserId: 'u1' },
    });
    expect(prisma.tx.membership.create).toHaveBeenCalledWith({
      data: { userId: 'u1', organizationId: 'org-new', role: 'OWNER' },
    });
    expect(prisma.tx.project.create).toHaveBeenCalledWith({
      data: { name: 'Default', slug: 'default', organizationId: 'org-new' },
    });
    expect(prisma.subscription.create).not.toHaveBeenCalled();
    expect(prisma.$transaction).toHaveBeenCalledTimes(1);
  });

  it('rejects the whole creation operation when the Default project cannot be created', async () => {
    const prisma = makePrisma();
    const { service: svc } = serviceWithTx(prisma);
    prisma.tx.project.create.mockRejectedValue(
      new Error('project invariant rejected'),
    );

    await expect(svc.create('u1', 'Acme Inc')).rejects.toThrow(
      'project invariant rejected',
    );

    expect(prisma.$transaction).toHaveBeenCalledTimes(1);
    expect(prisma.tx.organization.create).toHaveBeenCalledTimes(1);
    expect(prisma.tx.membership.create).toHaveBeenCalledTimes(1);
    expect(prisma.tx.project.create).toHaveBeenCalledTimes(1);
  });

  it('rejects a blank name', async () => {
    const { service: svc } = serviceWithTx(makePrisma());
    await expect(svc.create('u1', '   ')).rejects.toThrow(/name is required/i);
  });

  it.each(['SIGNAL', 'FLEET'] as const)(
    'allows a %s creator above the SOLO organization boundary and returns the inherited plan',
    async (plan) => {
      const prisma = makePrisma();
      const { service: svc, entitlements } = serviceWithTx(prisma, {
        plan,
        organizationCount: 10,
      });

      const row = await svc.create('u1', `${plan} Team`);

      expect(entitlements.assertCanAddOrganization).toHaveBeenCalledWith({
        plan,
        organizationCount: 10,
      });
      expect(prisma.tx.organization.create).toHaveBeenCalled();
      expect(prisma.tx.membership.create).toHaveBeenCalledWith({
        data: {
          userId: 'u1',
          organizationId: 'org-new',
          role: 'OWNER',
        },
      });
      expect(prisma.tx.project.create).toHaveBeenCalled();
      expect(row.plan).toBe(plan);
    },
  );

  it('checks the SOLO boundary through account entitlements inside the transaction', async () => {
    const prisma = makePrisma();
    const { service: svc, entitlements } = serviceWithTx(prisma);
    entitlements.assertCanAddOrganization.mockImplementation(() => {
      throw new ForbiddenException('account organization limit reached');
    });

    await expect(svc.create('u1', 'One More')).rejects.toThrow(
      /account organization limit/i,
    );
    expect(prisma.tx.organization.create).not.toHaveBeenCalled();
  });
});

describe('OrganizationsService.transferCreatorship', () => {
  const projects = [
    {
      id: 'p1',
      name: 'Default',
      slug: 'default',
      pingKey: 'pk1',
      organizationId: 'org1',
    },
  ];

  function setup(
    options: {
      callerId?: string;
      creatorId?: string;
      freshCreatorId?: string;
      callerRole?: string | null;
      recipientRole?: string | null;
      recipientCheckCount?: number;
      transferredChecks?: number;
      maxChecks?: number;
      plan?: 'SOLO' | 'SIGNAL' | 'FLEET';
      organizationCount?: number;
      unresolvedLegacyBilling?: boolean;
    } = {},
  ) {
    const callerId = options.callerId ?? 'creator-z';
    const creatorId = options.creatorId ?? callerId;
    const recipientId = 'recipient-a';
    const prisma = makePrisma();
    prisma.tx.organization.findUnique
      .mockResolvedValueOnce({ creatorUserId: creatorId })
      .mockResolvedValueOnce({
        id: 'org1',
        name: 'Acme',
        slug: 'acme',
        creatorUserId: options.freshCreatorId ?? creatorId,
        projects,
      });
    prisma.tx.membership.findUnique.mockImplementation(
      ({
        where: {
          userId_organizationId: { userId },
        },
      }: {
        where: { userId_organizationId: { userId: string } };
      }) =>
        Promise.resolve(
          userId === callerId
            ? options.callerRole === null
              ? null
              : { role: options.callerRole ?? 'OWNER' }
            : options.recipientRole === null
              ? null
              : { role: options.recipientRole ?? 'OWNER' },
        ),
    );
    prisma.tx.check.count.mockResolvedValue(options.transferredChecks ?? 2);
    prisma.tx.subscription.findFirst.mockResolvedValue(
      options.unresolvedLegacyBilling ? { id: 'legacy-sub' } : null,
    );
    prisma.tx.organization.update.mockResolvedValue({
      id: 'org1',
      name: 'Acme',
      slug: 'acme',
      creatorUserId: recipientId,
      projects,
      creator: {
        email: 'recipient@example.com',
        subscription: { plan: options.plan ?? 'SIGNAL' },
      },
    });
    const entitlements = {
      lockUsers: jest.fn().mockResolvedValue(undefined),
      forUser: jest.fn().mockResolvedValue({
        plan: options.plan ?? 'SIGNAL',
        limits: {
          maxChecks: options.maxChecks ?? 100,
          minIntervalSeconds: 1,
        },
        checkCount: options.recipientCheckCount ?? 3,
        organizationCount: options.organizationCount ?? 1,
      }),
      assertCanAddOrganization: jest.fn(),
    };
    const service = new OrganizationsService(
      prisma as unknown as PrismaService,
      entitlements as unknown as AccountEntitlementsService,
    );
    return { service, prisma, entitlements, callerId, recipientId };
  }

  it('rejects a caller who is not the current creator without writing', async () => {
    const { service, prisma, callerId, recipientId } = setup({
      creatorId: 'someone-else',
    });

    await expect(
      service.transferCreatorship(callerId, 'org1', recipientId),
    ).rejects.toBeInstanceOf(ForbiddenException);
    expect(prisma.tx.organization.update).not.toHaveBeenCalled();
  });

  it('rejects when creatorship changed after the initial creator was observed and locked', async () => {
    const { service, prisma, callerId, recipientId } = setup({
      creatorId: 'initial-creator',
      freshCreatorId: 'creator-z',
    });

    await expect(
      service.transferCreatorship(callerId, 'org1', recipientId),
    ).rejects.toThrow(/creator.*changed/i);
    expect(prisma.tx.organization.update).not.toHaveBeenCalled();
  });

  it('re-reads the organization and rejects a creator who is no longer OWNER', async () => {
    const { service, prisma, callerId, recipientId } = setup({
      callerRole: 'ADMIN',
    });

    await expect(
      service.transferCreatorship(callerId, 'org1', recipientId),
    ).rejects.toThrow(/creator.*owner/i);
    expect(prisma.tx.organization.findUnique).toHaveBeenCalledTimes(2);
    expect(prisma.tx.organization.update).not.toHaveBeenCalled();
  });

  it('rejects transferring to the same user before locking or writing', async () => {
    const { service, prisma, entitlements, callerId } = setup();

    await expect(
      service.transferCreatorship(callerId, 'org1', callerId),
    ).rejects.toBeInstanceOf(BadRequestException);
    expect(entitlements.lockUsers).not.toHaveBeenCalled();
    expect(prisma.tx.organization.update).not.toHaveBeenCalled();
  });

  it.each([
    [null, 'absent'],
    ['ADMIN', 'admin'],
    ['MEMBER', 'member'],
  ])(
    'rejects a recipient with %s membership (%s) without writing',
    async (recipientRole, label) => {
      void label;
      const { service, prisma, callerId, recipientId } = setup({
        recipientRole,
      });

      await expect(
        service.transferCreatorship(callerId, 'org1', recipientId),
      ).rejects.toThrow(/recipient.*owner/i);
      expect(prisma.tx.organization.update).not.toHaveBeenCalled();
    },
  );

  it('locks the current creator and recipient once in sorted order before fresh reads', async () => {
    const { service, prisma, entitlements, callerId, recipientId } = setup();
    const order: string[] = [];
    entitlements.lockUsers.mockImplementation(() => {
      order.push('user-locks');
      return Promise.resolve();
    });
    prisma.tx.$queryRaw.mockImplementation(() => {
      order.push('owner-membership-locks');
      return Promise.resolve([]);
    });
    prisma.tx.organization.findUnique.mockReset();
    prisma.tx.organization.findUnique
      .mockImplementationOnce(() => {
        order.push('initial-org');
        return Promise.resolve({ creatorUserId: callerId });
      })
      .mockImplementationOnce(() => {
        order.push('fresh-org');
        return Promise.resolve({
          id: 'org1',
          name: 'Acme',
          slug: 'acme',
          creatorUserId: callerId,
          projects,
        });
      });

    await service.transferCreatorship(callerId, 'org1', recipientId);

    expect(entitlements.lockUsers).toHaveBeenCalledWith(prisma.tx, [
      callerId,
      recipientId,
    ]);
    expect(order.slice(0, 4)).toEqual([
      'initial-org',
      'user-locks',
      'owner-membership-locks',
      'fresh-org',
    ]);
  });

  it('fresh-reads caller and recipient roles only after locking all OWNER rows', async () => {
    const { service, prisma, callerId, recipientId } = setup();
    const order: string[] = [];
    prisma.tx.$queryRaw.mockImplementation(() => {
      order.push('owner-membership-locks');
      return Promise.resolve([]);
    });
    prisma.tx.membership.findUnique.mockImplementation(
      ({
        where: {
          userId_organizationId: { userId },
        },
      }: {
        where: { userId_organizationId: { userId: string } };
      }) => {
        order.push(`role:${userId}`);
        return Promise.resolve({ role: 'OWNER' });
      },
    );

    await service.transferCreatorship(callerId, 'org1', recipientId);

    expect(prisma.tx.$queryRaw).toHaveBeenCalledTimes(2);
    expect(order).toEqual([
      'owner-membership-locks',
      `role:${callerId}`,
      `role:${recipientId}`,
      'owner-membership-locks',
    ]);
  });

  it('rejects a SOLO recipient at the organization cap without writing', async () => {
    const { service, prisma, entitlements, callerId, recipientId } = setup({
      plan: 'SOLO',
      organizationCount: 10,
    });
    entitlements.assertCanAddOrganization.mockImplementation(() => {
      throw new BadRequestException('Solo organization cap');
    });

    await expect(
      service.transferCreatorship(callerId, 'org1', recipientId),
    ).rejects.toThrow(/organization cap/i);
    expect(prisma.tx.organization.update).not.toHaveBeenCalled();
  });

  it('rejects when transferred checks would exceed the recipient cap without writing', async () => {
    const { service, prisma, callerId, recipientId } = setup({
      recipientCheckCount: 4,
      transferredChecks: 2,
      maxChecks: 5,
    });

    await expect(
      service.transferCreatorship(callerId, 'org1', recipientId),
    ).rejects.toThrow(/check.*limit/i);
    expect(prisma.tx.organization.update).not.toHaveBeenCalled();
  });

  it('rejects unresolved legacy billing after locking its subscription row without writing', async () => {
    const { service, prisma, callerId, recipientId } = setup({
      unresolvedLegacyBilling: true,
    });

    await expect(
      service.transferCreatorship(callerId, 'org1', recipientId),
    ).rejects.toThrow(
      'Complete account subscription reconciliation before transferring/deleting this organization.',
    );

    expect(prisma.tx.subscription.findFirst).toHaveBeenCalledWith({
      where: {
        organizationId: 'org1',
        userId: null,
        stripeSubscriptionId: { not: null },
        status: { notIn: ['canceled', 'incomplete_expired'] },
        plan: { in: ['SIGNAL', 'FLEET'] },
      },
      select: { id: true },
    });
    expect(prisma.tx.organization.update).not.toHaveBeenCalled();
  });

  it('allows exact check-cap equality, updates only creatorUserId, preserves roles, and returns the full inherited shape', async () => {
    const { service, prisma, entitlements, callerId, recipientId } = setup({
      recipientCheckCount: 3,
      transferredChecks: 2,
      maxChecks: 5,
    });

    const result = await service.transferCreatorship(
      callerId,
      'org1',
      recipientId,
    );

    expect(entitlements.forUser).toHaveBeenCalledWith(prisma.tx, recipientId);
    expect(prisma.tx.check.count).toHaveBeenCalledWith({
      where: { project: { organizationId: 'org1' } },
    });
    expect(prisma.tx.organization.update).toHaveBeenCalledWith({
      where: { id: 'org1' },
      data: { creatorUserId: recipientId },
      include: {
        projects: true,
        creator: { include: { subscription: true } },
      },
    });
    expect(prisma.tx.membership.create).not.toHaveBeenCalled();
    expect(result).toEqual({
      id: 'org1',
      name: 'Acme',
      slug: 'acme',
      pingKey: 'pk1',
      role: 'OWNER',
      plan: 'SIGNAL',
      creatorUserId: recipientId,
      creatorLabel: 'recipient@example.com',
      projects,
    });
  });
});

describe('OrganizationsService.rename', () => {
  it('rejects a non-manager', async () => {
    const prisma = makePrisma();
    prisma.tx.membership.findUnique.mockResolvedValue({
      role: 'MEMBER',
    });
    const svc = makeService(prisma);
    await expect(svc.rename('u1', 'org1', 'New')).rejects.toBeInstanceOf(
      ForbiddenException,
    );
  });

  it('renames when the caller is OWNER or ADMIN', async () => {
    const prisma = makePrisma();
    prisma.tx.membership.findUnique.mockResolvedValue({
      role: 'ADMIN',
    });
    prisma.tx.organization.update.mockResolvedValue({
      id: 'org1',
      name: 'New',
      slug: 's',
      projects: [
        {
          id: 'p1',
          name: 'Default',
          slug: 'default',
          pingKey: 'pk1',
          organizationId: 'org1',
        },
      ],
      creatorUserId: 'creator-1',
      creator: {
        email: 'creator@example.com',
        subscription: { plan: 'SOLO' },
      },
    });
    const svc = makeService(prisma);
    const res = await svc.rename('u1', 'org1', '  New  ');
    expect(prisma.tx.organization.update).toHaveBeenCalledWith({
      where: { id: 'org1' },
      data: { name: 'New' },
      include: {
        projects: true,
        creator: { include: { subscription: true } },
      },
    });
    expect(res.name).toBe('New');
  });

  it('rejects a blank name', async () => {
    const prisma = makePrisma();
    prisma.tx.membership.findUnique.mockResolvedValue({
      role: 'OWNER',
    });
    const svc = makeService(prisma);
    await expect(svc.rename('u1', 'org1', '  ')).rejects.toThrow(
      /name is required/i,
    );
  });
});

describe('OrganizationsService.update', () => {
  function setup() {
    const prisma = makePrisma();
    prisma.tx.membership.findUnique.mockResolvedValue({ role: 'ADMIN' });
    prisma.tx.organization.update.mockResolvedValue({
      id: 'org1',
      name: 'Renamed',
      slug: 'new-slug',
      projects: [
        {
          id: 'p1',
          name: 'Default',
          slug: 'default',
          pingKey: 'pk1',
          organizationId: 'org1',
        },
      ],
      subscription: { plan: 'SIGNAL' },
      creatorUserId: 'creator-1',
      creator: {
        email: 'creator@example.com',
        subscription: { plan: 'FLEET' },
      },
    });
    const svc = makeService(prisma);
    return { prisma, svc };
  }

  it('updates name and slug atomically with one authorization and one database update', async () => {
    const { prisma, svc } = setup();

    const result = await svc.update('u1', 'org1', {
      name: '  Renamed  ',
      slug: 'new-slug',
    });

    expect(prisma.tx.$queryRaw).toHaveBeenCalledTimes(1);
    expect(prisma.tx.membership.findUnique).toHaveBeenCalledTimes(1);
    expect(prisma.tx.organization.update).toHaveBeenCalledTimes(1);
    expect(prisma.tx.organization.update).toHaveBeenCalledWith({
      where: { id: 'org1' },
      data: { name: 'Renamed', slug: 'new-slug' },
      include: {
        projects: true,
        creator: { include: { subscription: true } },
      },
    });
    expect(result).toEqual({
      id: 'org1',
      name: 'Renamed',
      slug: 'new-slug',
      pingKey: 'pk1',
      role: 'ADMIN',
      plan: 'FLEET',
      creatorUserId: 'creator-1',
      creatorLabel: 'creator@example.com',
      projects: [
        {
          id: 'p1',
          name: 'Default',
          slug: 'default',
          pingKey: 'pk1',
          organizationId: 'org1',
        },
      ],
    });
  });

  it('uses the fresh in-transaction membership role before writing', async () => {
    const { prisma, svc } = setup();
    prisma.membership.findUnique.mockResolvedValue({ role: 'OWNER' });
    prisma.tx.membership.findUnique.mockResolvedValue({ role: 'MEMBER' });

    await expect(
      svc.update('u1', 'org1', { name: 'No longer allowed' }),
    ).rejects.toBeInstanceOf(ForbiddenException);

    expect(prisma.membership.findUnique).not.toHaveBeenCalled();
    expect(prisma.tx.membership.findUnique).toHaveBeenCalled();
    expect(prisma.tx.organization.update).not.toHaveBeenCalled();
  });

  it.each([
    [{}, /name or slug/i],
    [{ name: '   ' }, /name is required/i],
    [{ slug: 'Bad Slug' }, /lowercase letters/i],
    [{ name: 'Valid', slug: 'admin' }, /reserved/i],
  ])('validates %p before issuing an update', async (input, message) => {
    const { prisma, svc } = setup();

    await expect(svc.update('u1', 'org1', input)).rejects.toThrow(message);

    expect(prisma.tx.membership.findUnique).not.toHaveBeenCalled();
    expect(prisma.tx.organization.update).not.toHaveBeenCalled();
  });
});

describe('OrganizationsService.updateSlug (org-scoped)', () => {
  it('renames the slug of the named org for a manager — no ambiguity', async () => {
    const prisma = makePrisma();
    prisma.tx.membership.findUnique.mockResolvedValue({
      role: 'OWNER',
    });
    prisma.tx.organization.update.mockResolvedValue({
      id: 'org2',
      name: 'n',
      slug: 'new-slug',
      projects: [
        {
          id: 'p2',
          name: 'Default',
          slug: 'default',
          pingKey: 'pk2',
          organizationId: 'org2',
        },
      ],
      creatorUserId: 'creator-1',
      creator: {
        email: 'creator@example.com',
        subscription: { plan: 'SOLO' },
      },
    });
    const svc = makeService(prisma);
    const res = await svc.updateSlug('u1', 'org2', 'new-slug');
    expect(prisma.tx.membership.findUnique).toHaveBeenCalledWith({
      where: {
        userId_organizationId: { userId: 'u1', organizationId: 'org2' },
      },
    });
    expect(prisma.tx.organization.update).toHaveBeenCalledWith({
      where: { id: 'org2' },
      data: { slug: 'new-slug' },
      include: {
        projects: true,
        creator: { include: { subscription: true } },
      },
    });
    expect(res.slug).toBe('new-slug');
  });

  it('rejects a reserved slug', async () => {
    const prisma = makePrisma();
    prisma.tx.membership.findUnique.mockResolvedValue({
      role: 'OWNER',
    });
    const svc = makeService(prisma);
    await expect(svc.updateSlug('u1', 'org2', 'admin')).rejects.toThrow(
      /reserved/i,
    );
  });

  it('rejects a non-manager', async () => {
    const prisma = makePrisma();
    prisma.tx.membership.findUnique.mockResolvedValue({
      role: 'MEMBER',
    });
    const svc = makeService(prisma);
    await expect(
      svc.updateSlug('u1', 'org2', 'ok-slug'),
    ).rejects.toBeInstanceOf(ForbiddenException);
  });
});

describe('OrganizationsService.remove', () => {
  // `otherMemberships` seeds tx.membership.count -- the last-org guard now
  // runs inside the transaction, against `tx`, not the top-level prisma mock.
  function setup(role: string | null, otherMemberships = 2) {
    const prisma = makePrisma();
    prisma.tx.organization.findUnique.mockResolvedValue({
      creatorUserId: 'u1',
    });
    prisma.tx.membership.findUnique.mockResolvedValue(role ? { role } : null);
    prisma.tx.membership.count.mockResolvedValue(otherMemberships);
    prisma.tx.organization.delete.mockResolvedValue({ id: 'org1' });
    return prisma;
  }

  it('rejects a non-owner (ADMIN cannot delete)', async () => {
    const prisma = setup('ADMIN', 2);
    const svc = makeService(prisma);
    await expect(svc.remove('u1', 'org1')).rejects.toThrow(/owner/i);
    expect(prisma.tx.organization.delete).not.toHaveBeenCalled();
  });

  it('rejects unresolved legacy billing without deleting', async () => {
    const prisma = setup('OWNER', 2);
    prisma.tx.organization.findUnique.mockResolvedValue({
      creatorUserId: 'u1',
    });
    prisma.tx.subscription.findFirst.mockResolvedValue({ id: 'legacy-sub' });
    const svc = makeService(prisma);

    await expect(svc.remove('u1', 'org1')).rejects.toThrow(
      'Complete account subscription reconciliation before transferring/deleting this organization.',
    );

    expect(prisma.tx.organization.delete).not.toHaveBeenCalled();
  });

  it('rejects a non-member with ForbiddenException and does not delete', async () => {
    const prisma = setup(null, 2);
    const svc = makeService(prisma);
    await expect(svc.remove('u1', 'org1')).rejects.toBeInstanceOf(
      ForbiddenException,
    );
    expect(prisma.tx.organization.delete).not.toHaveBeenCalled();
  });

  it('uses the fresh in-transaction OWNER role before deleting', async () => {
    const prisma = setup('ADMIN', 2);
    prisma.membership.findUnique.mockResolvedValue({ role: 'OWNER' });
    const svc = makeService(prisma);

    await expect(svc.remove('u1', 'org1')).rejects.toBeInstanceOf(
      ForbiddenException,
    );

    expect(prisma.membership.findUnique).not.toHaveBeenCalled();
    expect(prisma.tx.membership.findUnique).toHaveBeenCalled();
    expect(prisma.tx.organization.findUniqueOrThrow).not.toHaveBeenCalled();
    expect(prisma.tx.organization.delete).not.toHaveBeenCalled();
  });

  it("refuses to delete the caller's last organization", async () => {
    const prisma = setup('OWNER', 1);
    const svc = makeService(prisma);
    await expect(svc.remove('u1', 'org1')).rejects.toThrow(
      /at least one organization/i,
    );
    expect(prisma.tx.organization.delete).not.toHaveBeenCalled();
  });

  it('locks the caller membership rows before counting, then deletes (multi-org OWNER)', async () => {
    const prisma = setup('OWNER', 2);
    const svc = makeService(prisma);

    await expect(svc.remove('u1', 'org1')).resolves.toBe(true);

    expect(prisma.tx.$queryRaw).toHaveBeenCalledTimes(3);
    const lockOrder = prisma.tx.$queryRaw.mock.invocationCallOrder[0];
    const authOrder =
      prisma.tx.membership.findUnique.mock.invocationCallOrder[0];
    const countOrder = prisma.tx.membership.count.mock.invocationCallOrder[0];
    expect(lockOrder).toBeLessThan(authOrder);
    expect(authOrder).toBeLessThan(countOrder);
    expect(prisma.tx.organization.delete).toHaveBeenCalledWith({
      where: { id: 'org1' },
    });
  });

  it('deletes after finding no unresolved legacy billing and never calls Stripe', async () => {
    const prisma = setup('OWNER', 2);
    const svc = makeService(prisma);

    await expect(svc.remove('u1', 'org1')).resolves.toBe(true);
    expect(prisma.tx.organization.findUniqueOrThrow).not.toHaveBeenCalled();
    expect(prisma.tx.organization.delete).toHaveBeenCalledWith({
      where: { id: 'org1' },
    });
  });
});
