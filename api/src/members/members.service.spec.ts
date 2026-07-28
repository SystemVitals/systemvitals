import { ForbiddenException } from '@nestjs/common';
import { MembersService, maskEmail, ROLE_RANK } from './members.service';
import type { PrismaService } from '../prisma/prisma.service';

/**
 * Minimal in-memory Prisma stand-in covering only what MembersService calls.
 * `tx` is a DISTINCT object with its own `jest.fn()` mocks for the members
 * `accept`'s transaction callback actually touches (`membership.findUnique`,
 * `membership.create`, `invite.update`) — not the same mocks as the top-level
 * `prisma.membership`/`prisma.invite`. This mirrors auth.service.spec.ts and
 * means a regression that silently swapped `tx.*` back to `this.prisma.*`
 * inside `accept` would leave the `tx` mocks uncalled and fail the relevant
 * assertions below, instead of passing vacuously.
 */
function makePrisma(overrides: Record<string, unknown> = {}) {
  const tx = {
    membership: {
      findUnique: jest.fn().mockResolvedValue(null),
      create: jest.fn(),
      // updateRole/removeMember/leave now write through `tx`, inside the same
      // transaction as the assertNotLastOwner lock+count -- default to a
      // shape close enough to production that tests overriding it only need
      // to tweak the field they care about.
      update: jest.fn().mockResolvedValue({
        id: 'target',
        role: 'ADMIN',
        createdAt: new Date('2026-01-02'),
        user: { id: 'u2', email: 'target@example.com' },
      }),
      delete: jest.fn().mockResolvedValue({ id: 'target' }),
      count: jest.fn().mockResolvedValue(0),
    },
    invite: {
      update: jest.fn(),
    },
    organization: {
      findUnique: jest.fn().mockResolvedValue({ creatorUserId: 'u1' }),
    },
    // assertNotLastOwner locks the org's OWNER rows with `FOR UPDATE` before
    // counting them -- see the dedicated locking-order tests below.
    $queryRaw: jest.fn().mockResolvedValue([]),
  };
  const prisma: Record<string, unknown> = {
    tx,
    membership: {
      findUnique: jest.fn().mockResolvedValue(null),
      findMany: jest.fn().mockResolvedValue([]),
      count: jest.fn().mockResolvedValue(0),
      create: jest.fn(),
      update: jest.fn(),
      delete: jest.fn(),
    },
    invite: {
      findMany: jest.fn().mockResolvedValue([]),
      findFirst: jest.fn().mockResolvedValue(null),
      findUnique: jest.fn().mockResolvedValue(null),
      create: jest.fn(),
      update: jest.fn(),
    },
    user: { findUnique: jest.fn().mockResolvedValue(null) },
    organization: { findUnique: jest.fn().mockResolvedValue(null) },
    $transaction: jest.fn((fn: (tx: unknown) => unknown) => fn(tx)),
    ...overrides,
  };
  return prisma as unknown as PrismaService & { tx: typeof tx };
}

const queue = { enqueue: jest.fn().mockResolvedValue(undefined) };

describe('maskEmail', () => {
  it('keeps the first character and the domain', () => {
    expect(maskEmail('nihey@example.com')).toBe('n***@example.com');
  });

  it('handles a single-character local part', () => {
    expect(maskEmail('a@example.com')).toBe('a***@example.com');
  });

  it('returns a fully masked value when there is no @', () => {
    expect(maskEmail('nonsense')).toBe('***');
  });
});

describe('ROLE_RANK', () => {
  it('orders OWNER above ADMIN above MEMBER', () => {
    expect(ROLE_RANK.OWNER).toBeGreaterThan(ROLE_RANK.ADMIN);
    expect(ROLE_RANK.ADMIN).toBeGreaterThan(ROLE_RANK.MEMBER);
  });
});

describe('MembersService read operations', () => {
  it('listMembers rejects a non-member', async () => {
    const prisma = makePrisma();
    const svc = new MembersService(prisma, queue as never);

    await expect(svc.listMembers('u1', 'org1')).rejects.toBeInstanceOf(
      ForbiddenException,
    );
  });

  it('listMembers returns flattened rows for a member', async () => {
    const prisma = makePrisma();
    (prisma.membership.findUnique as jest.Mock).mockResolvedValue({
      id: 'm1',
      role: 'MEMBER',
    });
    (prisma.membership.findMany as jest.Mock).mockResolvedValue([
      {
        id: 'm1',
        role: 'OWNER',
        createdAt: new Date('2026-01-01'),
        user: { id: 'u1', email: 'owner@example.com' },
      },
    ]);
    const svc = new MembersService(prisma, queue as never);

    const rows = await svc.listMembers('u1', 'org1');

    expect(rows).toEqual([
      {
        id: 'm1',
        userId: 'u1',
        email: 'owner@example.com',
        role: 'OWNER',
        createdAt: new Date('2026-01-01'),
      },
    ]);
  });

  it('listInvites returns only pending invites', async () => {
    const prisma = makePrisma();
    (prisma.membership.findUnique as jest.Mock).mockResolvedValue({
      id: 'm1',
      role: 'ADMIN',
    });
    (prisma.invite.findMany as jest.Mock).mockResolvedValue([]);
    const svc = new MembersService(prisma, queue as never);

    await svc.listInvites('u1', 'org1');

    const calls = (prisma.invite.findMany as jest.Mock).mock
      .calls as unknown[][];
    const where = (
      calls[0][0] as {
        where: {
          organizationId: string;
          acceptedAt: null;
          revokedAt: null;
          expiresAt: { gt: Date };
        };
      }
    ).where;
    expect(where.organizationId).toBe('org1');
    expect(where.acceptedAt).toBeNull();
    expect(where.revokedAt).toBeNull();
    const gt: unknown = expect.any(Date);
    expect(where.expiresAt).toEqual({ gt });
  });

  it('listInvites rejects a plain MEMBER', async () => {
    const prisma = makePrisma();
    (prisma.membership.findUnique as jest.Mock).mockResolvedValue({
      id: 'm1',
      role: 'MEMBER',
    });
    const svc = new MembersService(prisma, queue as never);

    await expect(svc.listInvites('u1', 'org1')).rejects.toThrow(
      /owner or admin/i,
    );
  });
});

describe('MembersService.invite', () => {
  function serviceWithRole(role: string) {
    const prisma = makePrisma();
    (prisma.membership.findUnique as jest.Mock).mockResolvedValue({
      id: 'm1',
      role,
    });
    (prisma.invite.create as jest.Mock).mockImplementation(
      ({ data }: { data: Record<string, unknown> }) =>
        Promise.resolve({
          id: 'inv1',
          token: 'tok1',
          createdAt: new Date('2026-01-01'),
          ...data,
        }),
    );
    return { prisma, svc: new MembersService(prisma, queue as never) };
  }

  beforeEach(() => queue.enqueue.mockClear());

  it('rejects a MEMBER trying to invite', async () => {
    const { svc } = serviceWithRole('MEMBER');
    await expect(
      svc.invite('u1', 'org1', 'new@example.com', 'MEMBER'),
    ).rejects.toThrow(/owner or admin/i);
  });

  it('rejects inviting someone as an OWNER', async () => {
    const { svc } = serviceWithRole('OWNER');
    await expect(
      svc.invite('u1', 'org1', 'new@example.com', 'OWNER'),
    ).rejects.toThrow(/owner/i);
  });

  it('rejects an ADMIN inviting another ADMIN', async () => {
    const { svc } = serviceWithRole('ADMIN');
    await expect(
      svc.invite('u1', 'org1', 'new@example.com', 'ADMIN'),
    ).rejects.toThrow(/admins can only/i);
  });

  it('allows an OWNER to invite an ADMIN', async () => {
    const { svc } = serviceWithRole('OWNER');
    const row = await svc.invite('u1', 'org1', 'New@Example.com', 'ADMIN');
    expect(row.email).toBe('new@example.com');
    expect(row.role).toBe('ADMIN');
  });

  it('normalizes the email and sets a 7-day expiry', async () => {
    const { prisma, svc } = serviceWithRole('OWNER');
    await svc.invite('u1', 'org1', '  New@Example.COM ', 'MEMBER');

    const calls = (prisma.invite.create as jest.Mock).mock.calls as unknown[][];
    const data = (calls[0][0] as { data: { email: string; expiresAt: Date } })
      .data;
    expect(data.email).toBe('new@example.com');

    const days = (data.expiresAt.getTime() - Date.now()) / 86_400_000;
    expect(days).toBeGreaterThan(6.9);
    expect(days).toBeLessThan(7.1);
  });

  it('enqueues an invite email', async () => {
    const { svc } = serviceWithRole('OWNER');
    await svc.invite('u1', 'org1', 'new@example.com', 'MEMBER');
    expect(queue.enqueue).toHaveBeenCalledWith({ inviteId: 'inv1' });
  });

  it('rejects inviting someone who is already a member', async () => {
    const { prisma, svc } = serviceWithRole('OWNER');
    (prisma.user.findUnique as jest.Mock).mockResolvedValue({ id: 'u2' });
    (prisma.membership.findUnique as jest.Mock)
      .mockResolvedValueOnce({ id: 'm1', role: 'OWNER' })
      .mockResolvedValueOnce({ id: 'm2', role: 'MEMBER' });

    await expect(
      svc.invite('u1', 'org1', 'existing@example.com', 'MEMBER'),
    ).rejects.toThrow(/already a member/i);
  });

  it('rejects a duplicate pending invite', async () => {
    const { prisma, svc } = serviceWithRole('OWNER');
    (prisma.invite.findFirst as jest.Mock).mockResolvedValue({ id: 'inv0' });

    await expect(
      svc.invite('u1', 'org1', 'pending@example.com', 'MEMBER'),
    ).rejects.toThrow(/pending invite/i);
  });
});

describe('MembersService.revokeInvite', () => {
  it('rejects an ADMIN revoking an ADMIN invite', async () => {
    const prisma = makePrisma();
    (prisma.invite.findUnique as jest.Mock).mockResolvedValue({
      id: 'inv1',
      organizationId: 'org1',
      role: 'ADMIN',
      acceptedAt: null,
      revokedAt: null,
    });
    (prisma.membership.findUnique as jest.Mock).mockResolvedValue({
      id: 'm1',
      role: 'ADMIN',
    });
    const svc = new MembersService(prisma, queue as never);

    await expect(svc.revokeInvite('u1', 'inv1')).rejects.toThrow(
      /admins can only/i,
    );
  });

  it('stamps revokedAt for an authorized caller', async () => {
    const prisma = makePrisma();
    (prisma.invite.findUnique as jest.Mock).mockResolvedValue({
      id: 'inv1',
      organizationId: 'org1',
      role: 'MEMBER',
      acceptedAt: null,
      revokedAt: null,
    });
    (prisma.membership.findUnique as jest.Mock).mockResolvedValue({
      id: 'm1',
      role: 'OWNER',
    });
    const svc = new MembersService(prisma, queue as never);

    await expect(svc.revokeInvite('u1', 'inv1')).resolves.toBe(true);

    const calls = (prisma.invite.update as jest.Mock).mock.calls as unknown[][];
    const call = calls[0][0] as {
      where: { id: string };
      data: { revokedAt: Date };
    };
    expect(call.where).toEqual({ id: 'inv1' });
    expect(call.data.revokedAt).toBeInstanceOf(Date);
  });

  it('rejects revoking an already-accepted invite', async () => {
    const prisma = makePrisma();
    (prisma.invite.findUnique as jest.Mock).mockResolvedValue({
      id: 'inv1',
      organizationId: 'org1',
      role: 'MEMBER',
      acceptedAt: new Date('2026-01-01'),
      revokedAt: null,
    });
    (prisma.membership.findUnique as jest.Mock).mockResolvedValue({
      id: 'm1',
      role: 'OWNER',
    });
    const svc = new MembersService(prisma, queue as never);

    await expect(svc.revokeInvite('u1', 'inv1')).rejects.toThrow(
      /already been accepted/i,
    );
    const calls = (prisma.invite.update as jest.Mock).mock.calls as unknown[][];
    expect(calls.length).toBe(0);
  });

  it('is idempotent when revoking an already-revoked invite', async () => {
    const prisma = makePrisma();
    (prisma.invite.findUnique as jest.Mock).mockResolvedValue({
      id: 'inv1',
      organizationId: 'org1',
      role: 'MEMBER',
      acceptedAt: null,
      revokedAt: new Date('2026-01-01'),
    });
    (prisma.membership.findUnique as jest.Mock).mockResolvedValue({
      id: 'm1',
      role: 'OWNER',
    });
    const svc = new MembersService(prisma, queue as never);

    await expect(svc.revokeInvite('u1', 'inv1')).resolves.toBe(true);
    const calls = (prisma.invite.update as jest.Mock).mock.calls as unknown[][];
    expect(calls.length).toBe(0);
  });

  it('rejects a non-member before revealing that the invite was already revoked', async () => {
    const prisma = makePrisma();
    (prisma.invite.findUnique as jest.Mock).mockResolvedValue({
      id: 'inv1',
      organizationId: 'org1',
      role: 'MEMBER',
      acceptedAt: null,
      revokedAt: new Date('2026-01-01'),
    });
    (prisma.membership.findUnique as jest.Mock).mockResolvedValue(null);
    const svc = new MembersService(prisma, queue as never);

    await expect(svc.revokeInvite('u1', 'inv1')).rejects.toThrow(
      /not a member/i,
    );
    const calls = (prisma.invite.update as jest.Mock).mock.calls as unknown[][];
    expect(calls.length).toBe(0);
  });
});

describe('MembersService.previewInvite', () => {
  const base = {
    id: 'inv1',
    email: 'invitee@example.com',
    organizationId: 'org1',
    role: 'MEMBER',
    token: 'tok1',
    acceptedAt: null,
    revokedAt: null,
    expiresAt: new Date(Date.now() + 86_400_000),
    organization: { name: 'Acme' },
  };

  function svcWithInvite(invite: Record<string, unknown> | null) {
    const prisma = makePrisma();
    (prisma.invite.findUnique as jest.Mock).mockResolvedValue(invite);
    return new MembersService(prisma, queue as never);
  }

  it('reports NOT_FOUND for an unknown token without leaking anything', async () => {
    const result = await svcWithInvite(null).previewInvite('bogus');
    expect(result).toEqual({
      organizationName: '',
      maskedEmail: '',
      status: 'NOT_FOUND',
    });
  });

  it('reports PENDING with a masked email for a live invite', async () => {
    const result = await svcWithInvite(base).previewInvite('tok1');
    expect(result).toEqual({
      organizationName: 'Acme',
      maskedEmail: 'i***@example.com',
      status: 'PENDING',
    });
  });

  it('reports ACCEPTED, REVOKED and EXPIRED distinctly, each with no extra fields', async () => {
    const accepted = await svcWithInvite({
      ...base,
      acceptedAt: new Date(),
    }).previewInvite('tok1');
    expect(accepted).toEqual({
      organizationName: 'Acme',
      maskedEmail: 'i***@example.com',
      status: 'ACCEPTED',
    });

    const revoked = await svcWithInvite({
      ...base,
      revokedAt: new Date(),
    }).previewInvite('tok1');
    expect(revoked).toEqual({
      organizationName: 'Acme',
      maskedEmail: 'i***@example.com',
      status: 'REVOKED',
    });

    const expired = await svcWithInvite({
      ...base,
      expiresAt: new Date(Date.now() - 1000),
    }).previewInvite('tok1');
    expect(expired).toEqual({
      organizationName: 'Acme',
      maskedEmail: 'i***@example.com',
      status: 'EXPIRED',
    });
  });
});

describe('MembersService.accept', () => {
  const invite = {
    id: 'inv1',
    email: 'invitee@example.com',
    organizationId: 'org1',
    role: 'MEMBER',
    token: 'tok1',
    acceptedAt: null,
    revokedAt: null,
    expiresAt: new Date(Date.now() + 86_400_000),
    organization: { name: 'Acme' },
  };

  function setup(
    inviteOverrides: Record<string, unknown> = {},
    userEmail = 'invitee@example.com',
  ) {
    const prisma = makePrisma();
    (prisma.invite.findUnique as jest.Mock).mockResolvedValue({
      ...invite,
      ...inviteOverrides,
    });
    (prisma.user.findUnique as jest.Mock).mockResolvedValue({
      id: 'u2',
      email: userEmail,
    });
    prisma.tx.membership.create.mockResolvedValue({
      id: 'm2',
      role: 'MEMBER',
      createdAt: new Date('2026-01-02'),
    });
    return { prisma, svc: new MembersService(prisma, queue as never) };
  }

  it('rejects an expired invite', async () => {
    const { svc } = setup({ expiresAt: new Date(Date.now() - 1000) });
    await expect(svc.accept('u2', 'tok1')).rejects.toThrow(/expired/i);
  });

  it('rejects an already-accepted invite', async () => {
    const { svc } = setup({ acceptedAt: new Date() });
    await expect(svc.accept('u2', 'tok1')).rejects.toThrow(
      /already been accepted/i,
    );
  });

  it('rejects a revoked invite', async () => {
    const { svc } = setup({ revokedAt: new Date() });
    await expect(svc.accept('u2', 'tok1')).rejects.toThrow(/revoked/i);
  });

  it('rejects an email mismatch instead of silently joining', async () => {
    const { prisma, svc } = setup({}, 'someone-else@example.com');
    await expect(svc.accept('u2', 'tok1')).rejects.toThrow(/different email/i);
    // Production code throws before the transaction ever opens, so the
    // strongest check is that $transaction itself was never invoked — not
    // merely that membership.create wasn't called.
    const calls = (prisma.$transaction as jest.Mock).mock.calls as unknown[][];
    expect(calls.length).toBe(0);
  });

  it('creates the membership with the invited role and stamps acceptedAt', async () => {
    const { prisma, svc } = setup();

    const row = await svc.accept('u2', 'tok1');

    const createCalls = prisma.tx.membership.create.mock.calls as unknown[][];
    expect(createCalls[0][0]).toEqual({
      data: { userId: 'u2', organizationId: 'org1', role: 'MEMBER' },
    });
    const updateCalls = prisma.tx.invite.update.mock.calls as unknown[][];
    const updateArg = updateCalls[0][0] as { data: { acceptedAt: Date } };
    expect(updateArg.data.acceptedAt).toBeInstanceOf(Date);
    expect(row.email).toBe('invitee@example.com');
    expect(row.role).toBe('MEMBER');
  });

  it('rejects accepting when already a member', async () => {
    const { prisma, svc } = setup();
    prisma.tx.membership.findUnique.mockResolvedValue({
      id: 'm9',
      role: 'MEMBER',
    });

    await expect(svc.accept('u2', 'tok1')).rejects.toThrow(/already a member/i);
  });

  it('translates a raced P2002 from membership.create into the clean "already a member" error', async () => {
    // Simulates two concurrent accept() calls for the same token: both pass
    // the pre-create existence check (findUnique still resolves null here),
    // and the loser's membership.create rejects with the
    // @@unique([userId, organizationId]) constraint violation Prisma raises
    // as P2002. Without the catch in the transaction, this raw error would
    // propagate straight out of accept() instead of the clean
    // BadRequestException the sequential path produces.
    const { prisma, svc } = setup();
    const p2002 = Object.assign(new Error('Unique constraint failed'), {
      code: 'P2002',
    });
    prisma.tx.membership.create.mockRejectedValue(p2002);

    await expect(svc.accept('u2', 'tok1')).rejects.toThrow(/already a member/i);
  });
});

describe('MembersService member management', () => {
  /**
   * @param actorRole  role of the caller in the org
   * @param targetRole role of the membership being acted on
   * @param ownerCount how many OWNERs the org has
   */
  function setup(actorRole: string, targetRole: string, ownerCount = 2) {
    const prisma = makePrisma();
    (prisma.membership.findUnique as jest.Mock).mockImplementation(
      ({ where }: { where: Record<string, unknown> }) => {
        if (where.id === 'target') {
          return Promise.resolve({
            id: 'target',
            userId: 'u2',
            organizationId: 'org1',
            role: targetRole,
            createdAt: new Date('2026-01-02'),
            user: { id: 'u2', email: 'target@example.com' },
          });
        }
        return Promise.resolve({ id: 'actor', role: actorRole });
      },
    );
    // assertNotLastOwner now locks+counts through `tx`, not the top-level
    // `prisma.membership` mock -- the write (update/delete) also happens
    // through `tx`, matching the transaction the service opens.
    prisma.tx.membership.count.mockResolvedValue(ownerCount);
    // updateRole/removeMember re-read the target's role INSIDE the
    // transaction (see members.service.ts) rather than trusting the
    // pre-transaction `target` snapshot. By default this mirrors that
    // snapshot so existing tests don't have to think about the race;
    // the dedicated "concurrent promotion" tests below override it.
    prisma.tx.membership.findUnique.mockResolvedValue({
      id: 'target',
      userId: 'u2',
      organizationId: 'org1',
      role: targetRole,
      createdAt: new Date('2026-01-02'),
    });
    prisma.tx.membership.update.mockResolvedValue({
      id: 'target',
      role: 'ADMIN',
      createdAt: new Date('2026-01-02'),
      user: { id: 'u2', email: 'target@example.com' },
    });
    prisma.tx.membership.delete.mockResolvedValue({ id: 'target' });
    return { prisma, svc: new MembersService(prisma, queue as never) };
  }

  describe('updateRole', () => {
    it('rejects an ADMIN caller', async () => {
      const { svc } = setup('ADMIN', 'MEMBER');
      await expect(svc.updateRole('u1', 'target', 'ADMIN')).rejects.toThrow(
        /owner role/i,
      );
    });

    it('lets an OWNER promote a MEMBER to ADMIN', async () => {
      const { svc } = setup('OWNER', 'MEMBER');
      const row = await svc.updateRole('u1', 'target', 'ADMIN');
      expect(row.role).toBe('ADMIN');
    });

    it('refuses to demote the last OWNER', async () => {
      const { svc } = setup('OWNER', 'OWNER', 1);
      await expect(svc.updateRole('u1', 'target', 'ADMIN')).rejects.toThrow(
        /at least one owner/i,
      );
    });

    it('allows demoting an OWNER when another OWNER remains', async () => {
      const { svc } = setup('OWNER', 'OWNER', 2);
      await expect(
        svc.updateRole('u1', 'target', 'ADMIN'),
      ).resolves.toBeDefined();
    });

    it('refuses to demote the current creator after locking and fresh reads', async () => {
      const { prisma, svc } = setup('OWNER', 'OWNER', 2);
      prisma.tx.organization.findUnique.mockResolvedValue({
        creatorUserId: 'u2',
      });

      await expect(svc.updateRole('u1', 'target', 'ADMIN')).rejects.toThrow(
        'Transfer organization creatorship first',
      );
      expect(prisma.tx.membership.update).not.toHaveBeenCalled();
      expect(prisma.tx.$queryRaw.mock.invocationCallOrder[0]).toBeLessThan(
        prisma.tx.organization.findUnique.mock.invocationCallOrder[0],
      );
      expect(prisma.tx.$queryRaw.mock.invocationCallOrder[0]).toBeLessThan(
        prisma.tx.membership.findUnique.mock.invocationCallOrder[0],
      );
    });
  });

  describe('removeMember', () => {
    it('rejects a MEMBER caller', async () => {
      const { svc } = setup('MEMBER', 'MEMBER');
      await expect(svc.removeMember('u1', 'target')).rejects.toThrow(
        /owner or admin/i,
      );
    });

    it('rejects an ADMIN removing another ADMIN', async () => {
      const { svc } = setup('ADMIN', 'ADMIN');
      await expect(svc.removeMember('u1', 'target')).rejects.toThrow(
        /admins can only/i,
      );
    });

    it('lets an ADMIN remove a MEMBER', async () => {
      const { svc } = setup('ADMIN', 'MEMBER');
      await expect(svc.removeMember('u1', 'target')).resolves.toBe(true);
    });

    it('refuses to remove the last OWNER', async () => {
      const { svc } = setup('OWNER', 'OWNER', 1);
      await expect(svc.removeMember('u1', 'target')).rejects.toThrow(
        /at least one owner/i,
      );
    });

    it('refuses to remove the current creator without writing', async () => {
      const { prisma, svc } = setup('OWNER', 'OWNER', 2);
      prisma.tx.organization.findUnique.mockResolvedValue({
        creatorUserId: 'u2',
      });

      await expect(svc.removeMember('u1', 'target')).rejects.toThrow(
        'Transfer organization creatorship first',
      );
      expect(prisma.tx.membership.delete).not.toHaveBeenCalled();
    });
  });

  describe('leave', () => {
    it('refuses when the caller is the last OWNER', async () => {
      const prisma = makePrisma();
      (prisma.membership.findUnique as jest.Mock).mockResolvedValue({
        id: 'm1',
        role: 'OWNER',
      });
      prisma.tx.membership.findUnique.mockResolvedValue({
        id: 'm1',
        organizationId: 'org1',
        role: 'OWNER',
      });
      prisma.tx.membership.count.mockResolvedValue(1);
      const svc = new MembersService(prisma, queue as never);

      await expect(svc.leave('u1', 'org1')).rejects.toThrow(
        /at least one owner/i,
      );
    });

    it('lets a MEMBER leave', async () => {
      const prisma = makePrisma();
      (prisma.membership.findUnique as jest.Mock).mockResolvedValue({
        id: 'm1',
        role: 'MEMBER',
      });
      prisma.tx.membership.findUnique.mockResolvedValue({
        id: 'm1',
        organizationId: 'org1',
        role: 'MEMBER',
      });
      const svc = new MembersService(prisma, queue as never);

      await expect(svc.leave('u1', 'org1')).resolves.toBe(true);
      const calls = prisma.tx.membership.delete.mock.calls as unknown[][];
      expect(calls[0][0]).toEqual({ where: { id: 'm1' } });
    });

    it('refuses to let the current creator leave without writing', async () => {
      const prisma = makePrisma();
      (prisma.membership.findUnique as jest.Mock).mockResolvedValue({
        id: 'm1',
        role: 'OWNER',
      });
      prisma.tx.membership.findUnique.mockResolvedValue({
        id: 'm1',
        userId: 'u1',
        organizationId: 'org1',
        role: 'OWNER',
      });
      prisma.tx.organization.findUnique.mockResolvedValue({
        creatorUserId: 'u1',
      });
      prisma.tx.membership.count.mockResolvedValue(2);
      const svc = new MembersService(prisma, queue as never);

      await expect(svc.leave('u1', 'org1')).rejects.toThrow(
        'Transfer organization creatorship first',
      );
      expect(prisma.tx.membership.delete).not.toHaveBeenCalled();
    });
  });

  describe('owner-set row locking', () => {
    it('locks the OWNER rows FOR UPDATE before counting them, in that order, when vacating an OWNER membership', async () => {
      const { prisma, svc } = setup('OWNER', 'OWNER', 2);

      await svc.updateRole('u1', 'target', 'ADMIN');

      expect(prisma.tx.$queryRaw).toHaveBeenCalledTimes(1);
      const rawCall = prisma.tx.$queryRaw.mock.calls as unknown[][];
      const sqlParts = (rawCall[0][0] as string[]).join(' ');
      expect(sqlParts).toMatch(/FOR UPDATE/i);
      expect(sqlParts).toMatch(/memberships/i);

      const countOrder = prisma.tx.membership.count.mock.invocationCallOrder[0];
      const lockOrder = prisma.tx.$queryRaw.mock.invocationCallOrder[0] as
        | number
        | undefined;
      expect(lockOrder).toBeDefined();
      expect(lockOrder as number).toBeLessThan(countOrder);
    });

    it('locks the OWNER rows but does not count when the change does not vacate an OWNER role', async () => {
      const { prisma, svc } = setup('OWNER', 'MEMBER', 2);

      await svc.updateRole('u1', 'target', 'ADMIN');

      const rawCalls = prisma.tx.$queryRaw.mock.calls as unknown[][];
      expect(rawCalls.length).toBe(1);
      const countCalls = prisma.tx.membership.count.mock.calls as unknown[][];
      expect(countCalls.length).toBe(0);
    });

    it('removeMember locks before counting when removing an OWNER', async () => {
      const { prisma, svc } = setup('OWNER', 'OWNER', 2);

      await svc.removeMember('u1', 'target');

      expect(prisma.tx.$queryRaw).toHaveBeenCalledTimes(1);
      const lockOrder = prisma.tx.$queryRaw.mock.invocationCallOrder[0] as
        | number
        | undefined;
      const countOrder = prisma.tx.membership.count.mock.invocationCallOrder[0];
      expect(lockOrder).toBeDefined();
      expect(lockOrder as number).toBeLessThan(countOrder);
    });

    it('removeMember still locks the OWNER rows when the target is not an OWNER', async () => {
      const { prisma, svc } = setup('ADMIN', 'MEMBER', 2);

      await svc.removeMember('u1', 'target');

      const rawCalls = prisma.tx.$queryRaw.mock.calls as unknown[][];
      expect(rawCalls.length).toBe(1);
    });

    it('leave locks before counting when the leaver is an OWNER', async () => {
      const prisma = makePrisma();
      (prisma.membership.findUnique as jest.Mock).mockResolvedValue({
        id: 'm1',
        role: 'OWNER',
      });
      prisma.tx.membership.findUnique.mockResolvedValue({
        id: 'm1',
        organizationId: 'org1',
        role: 'OWNER',
      });
      prisma.tx.membership.count.mockResolvedValue(2);
      const svc = new MembersService(prisma, queue as never);

      await svc.leave('u1', 'org1');

      expect(prisma.tx.$queryRaw).toHaveBeenCalledTimes(1);
      const lockOrder = prisma.tx.$queryRaw.mock.invocationCallOrder[0] as
        | number
        | undefined;
      const countOrder = prisma.tx.membership.count.mock.invocationCallOrder[0];
      expect(lockOrder).toBeDefined();
      expect(lockOrder as number).toBeLessThan(countOrder);
    });

    it('leave still locks the OWNER rows when the leaver is a plain MEMBER', async () => {
      const prisma = makePrisma();
      (prisma.membership.findUnique as jest.Mock).mockResolvedValue({
        id: 'm1',
        role: 'MEMBER',
      });
      prisma.tx.membership.findUnique.mockResolvedValue({
        id: 'm1',
        organizationId: 'org1',
        role: 'MEMBER',
      });
      const svc = new MembersService(prisma, queue as never);

      await svc.leave('u1', 'org1');

      const rawCalls = prisma.tx.$queryRaw.mock.calls as unknown[][];
      expect(rawCalls.length).toBe(1);
    });
  });

  describe('concurrent promotion to OWNER (fresh in-transaction re-read)', () => {
    /**
     * Reproduces the residual race: `loadTarget` (the pre-transaction read)
     * sees the membership as a non-OWNER, but a concurrent transaction has
     * already promoted it to OWNER by the time this transaction opens.
     * `tx.membership.findUnique` stands in for that fresh, post-promotion
     * read. If the service still decided the lock/invariant from the stale
     * `target.role` snapshot, it would see a non-OWNER target, skip the
     * lock and the count entirely, and let the write through unguarded --
     * these assertions would then fail (no $queryRaw call, no exception).
     */
    it('updateRole takes the lock and enforces the invariant from the fresh role, not the stale one', async () => {
      const prisma = makePrisma();
      (prisma.membership.findUnique as jest.Mock).mockImplementation(
        ({ where }: { where: Record<string, unknown> }) => {
          if (where.id === 'target') {
            // Stale pre-transaction snapshot: still ADMIN.
            return Promise.resolve({
              id: 'target',
              userId: 'u2',
              organizationId: 'org1',
              role: 'ADMIN',
              createdAt: new Date('2026-01-02'),
              user: { id: 'u2', email: 'target@example.com' },
            });
          }
          return Promise.resolve({ id: 'actor', role: 'OWNER' });
        },
      );
      // A concurrent transaction promoted this same membership to OWNER
      // after loadTarget ran but before this transaction started.
      prisma.tx.membership.findUnique.mockResolvedValue({
        id: 'target',
        userId: 'u2',
        organizationId: 'org1',
        role: 'OWNER',
        createdAt: new Date('2026-01-02'),
      });
      prisma.tx.membership.count.mockResolvedValue(1); // now the sole owner
      const svc = new MembersService(prisma, queue as never);

      await expect(svc.updateRole('u1', 'target', 'MEMBER')).rejects.toThrow(
        /at least one owner/i,
      );
      expect(prisma.tx.$queryRaw).toHaveBeenCalledTimes(1);
      const countCalls = prisma.tx.membership.count.mock.calls as unknown[][];
      expect(countCalls.length).toBe(1);
    });

    it('removeMember takes the lock and enforces the invariant from the fresh role, not the stale one', async () => {
      const prisma = makePrisma();
      (prisma.membership.findUnique as jest.Mock).mockImplementation(
        ({ where }: { where: Record<string, unknown> }) => {
          if (where.id === 'target') {
            return Promise.resolve({
              id: 'target',
              userId: 'u2',
              organizationId: 'org1',
              role: 'ADMIN',
              createdAt: new Date('2026-01-02'),
              user: { id: 'u2', email: 'target@example.com' },
            });
          }
          return Promise.resolve({ id: 'actor', role: 'OWNER' });
        },
      );
      prisma.tx.membership.findUnique.mockResolvedValue({
        id: 'target',
        userId: 'u2',
        organizationId: 'org1',
        role: 'OWNER',
        createdAt: new Date('2026-01-02'),
      });
      prisma.tx.membership.count.mockResolvedValue(1);
      const svc = new MembersService(prisma, queue as never);

      await expect(svc.removeMember('u1', 'target')).rejects.toThrow(
        /at least one owner/i,
      );
      expect(prisma.tx.$queryRaw).toHaveBeenCalledTimes(1);
      const countCalls = prisma.tx.membership.count.mock.calls as unknown[][];
      expect(countCalls.length).toBe(1);
    });
  });
});
