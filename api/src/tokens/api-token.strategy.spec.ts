import { UnauthorizedException } from '@nestjs/common';
import { JwtService } from '@nestjs/jwt';
import type { FastifyRequest } from 'fastify';
import { PrismaService } from '../prisma/prisma.service';
import { ApiTokenStrategy } from './api-token.strategy';

const NOW = new Date('2026-07-24T12:00:00.000Z');

type TokenRecord = {
  id: string;
  userId: string;
  projectId: string | null;
  projectNameSnapshot: string | null;
  organizationNameSnapshot: string | null;
  scopes: string[];
  revokedAt: Date | null;
  expiresAt: Date | null;
  user: {
    email: string;
    suspendedAt: Date | null;
  };
  project: {
    organization: {
      memberships: Array<{ id: string }>;
    };
  } | null;
};

function tokenRecord(overrides: Partial<TokenRecord> = {}): TokenRecord {
  const project =
    overrides.projectId === null
      ? null
      : {
          organization: {
            memberships: [{ id: 'membership-1' }],
          },
        };
  return {
    id: 'token-1',
    userId: 'user-1',
    projectId: 'project-1',
    projectNameSnapshot: 'Project one',
    organizationNameSnapshot: 'Organization one',
    scopes: ['checks:read', 'checks:write'],
    revokedAt: null,
    expiresAt: null,
    user: {
      email: 'user@example.com',
      suspendedAt: null,
    },
    project,
    ...overrides,
  };
}

function bearer(value?: string): FastifyRequest {
  return {
    headers: value ? { authorization: `Bearer ${value}` } : {},
  } as FastifyRequest;
}

function setup(token: TokenRecord | null = tokenRecord()) {
  const candidate =
    token === null
      ? null
      : {
          id: token.id,
          userId: token.userId,
          projectId: token.projectId,
        };
  const findUnique = jest
    .fn()
    .mockResolvedValueOnce(candidate)
    .mockResolvedValueOnce(token);
  const updateMany = jest.fn().mockResolvedValue({ count: 1 });
  const queryRaw = jest.fn().mockResolvedValue([]);
  const tx = {
    $queryRaw: queryRaw,
    apiToken: { findUnique, updateMany },
  };
  const transaction = jest.fn(
    async (callback: (client: typeof tx) => Promise<unknown>) => callback(tx),
  );
  const prisma = {
    $transaction: transaction,
  } as unknown as PrismaService;
  const strategy = new ApiTokenStrategy(prisma, {
    verify: jest.fn(),
  } as unknown as JwtService);

  return {
    strategy,
    findUnique,
    updateMany,
    queryRaw,
    transaction,
  };
}

describe('ApiTokenStrategy', () => {
  beforeEach(() => {
    jest.spyOn(Date, 'now').mockReturnValue(NOW.getTime());
  });

  afterEach(() => {
    jest.restoreAllMocks();
  });

  it.each([
    ['at the current instant', NOW],
    ['before the current instant', new Date(NOW.getTime() - 1)],
  ])(
    'rejects a token expiring %s without updating usage',
    async (_, expiresAt) => {
      const { strategy, updateMany } = setup(tokenRecord({ expiresAt }));

      await expect(strategy.validate(bearer('svt_expired'))).rejects.toThrow(
        new UnauthorizedException('Credential expired'),
      );
      expect(updateMany).not.toHaveBeenCalled();
    },
  );

  it('rejects a revoked token without updating usage', async () => {
    const { strategy, updateMany } = setup(
      tokenRecord({ revokedAt: new Date(NOW.getTime() - 1) }),
    );

    await expect(strategy.validate(bearer('svt_revoked'))).rejects.toThrow(
      new UnauthorizedException('Credential revoked'),
    );
    expect(updateMany).not.toHaveBeenCalled();
  });

  it('rejects a scoped token whose project has been deleted', async () => {
    const { strategy, updateMany } = setup(
      tokenRecord({
        projectId: null,
        projectNameSnapshot: 'Deleted project',
      }),
    );

    await expect(
      strategy.validate(bearer('svt_deleted_project')),
    ).rejects.toThrow(
      new UnauthorizedException('Credential project no longer exists'),
    );
    expect(updateMany).not.toHaveBeenCalled();
  });

  it('rejects a scoped token after its owner loses project access', async () => {
    const { strategy, updateMany } = setup(
      tokenRecord({
        project: {
          organization: {
            memberships: [],
          },
        },
      }),
    );

    await expect(
      strategy.validate(bearer('svt_inaccessible_project')),
    ).rejects.toThrow(
      new UnauthorizedException('Credential project is no longer accessible'),
    );
    expect(updateMany).not.toHaveBeenCalled();
  });

  it('rejects a malformed explicit check credential without a project', async () => {
    const { strategy, updateMany } = setup(
      tokenRecord({
        projectId: null,
        projectNameSnapshot: null,
        organizationNameSnapshot: null,
        scopes: ['checks:read'],
      }),
    );

    await expect(strategy.validate(bearer('svt_malformed'))).rejects.toThrow(
      new UnauthorizedException(
        'Scoped credential is missing a project binding',
      ),
    );
    expect(updateMany).not.toHaveBeenCalled();
  });

  it('rejects an unbound token with no supported legacy scope', async () => {
    const { strategy, updateMany } = setup(
      tokenRecord({
        projectId: null,
        projectNameSnapshot: null,
        organizationNameSnapshot: null,
        scopes: ['unknown'],
      }),
    );

    await expect(
      strategy.validate(bearer('svt_unknown_scope')),
    ).rejects.toThrow(
      new UnauthorizedException('Credential has no supported scope'),
    );
    expect(updateMany).not.toHaveBeenCalled();
  });

  it('continues accepting an unbound legacy token without snapshots', async () => {
    const { strategy } = setup(
      tokenRecord({
        projectId: null,
        projectNameSnapshot: null,
        organizationNameSnapshot: null,
        scopes: ['read'],
      }),
    );

    await expect(
      strategy.validate(bearer('svt_legacy_broad')),
    ).resolves.toMatchObject({
      apiToken: { projectId: null, legacyScopes: ['read'] },
    });
  });

  it('rejects a suspended token owner without updating usage', async () => {
    const { strategy, updateMany } = setup(
      tokenRecord({
        user: {
          email: 'user@example.com',
          suspendedAt: NOW,
        },
      }),
    );

    await expect(strategy.validate(bearer('svt_suspended'))).rejects.toThrow(
      new UnauthorizedException('Credential owner account suspended'),
    );
    expect(updateMany).not.toHaveBeenCalled();
  });

  it('rejects a missing credential without querying or updating a token', async () => {
    const { strategy, findUnique, updateMany, transaction } = setup();

    await expect(strategy.validate(bearer())).rejects.toThrow(
      UnauthorizedException,
    );
    expect(findUnique).not.toHaveBeenCalled();
    expect(updateMany).not.toHaveBeenCalled();
    expect(transaction).not.toHaveBeenCalled();
  });

  it('rejects an unknown API token without updating usage', async () => {
    const { strategy, findUnique, updateMany } = setup(null);

    await expect(strategy.validate(bearer('svt_unknown'))).rejects.toThrow(
      UnauthorizedException,
    );
    expect(findUnique).toHaveBeenCalledTimes(1);
    expect(updateMany).not.toHaveBeenCalled();
  });

  it('returns a session principal from a valid JWT without updating token usage', async () => {
    const verify = jest.fn().mockReturnValue({
      sub: 'user-1',
      email: 'user@example.com',
      act: 'admin-1',
    });
    const tokenUpdate = jest.fn();
    const userFindUnique = jest.fn().mockResolvedValue({ suspendedAt: null });
    const prisma = {
      apiToken: { update: tokenUpdate },
      user: { findUnique: userFindUnique },
    } as unknown as PrismaService;
    const strategy = new ApiTokenStrategy(prisma, {
      verify,
    } as unknown as JwtService);

    const principal = await strategy.validate(bearer('valid-session-jwt'));

    expect(verify).toHaveBeenCalledWith('valid-session-jwt');
    expect(userFindUnique).toHaveBeenCalledWith({
      where: { id: 'user-1' },
      select: { suspendedAt: true },
    });
    expect(principal).toEqual({
      userId: 'user-1',
      email: 'user@example.com',
      impersonatedBy: 'admin-1',
      authKind: 'session',
    });
    expect(principal).not.toHaveProperty('apiToken');
    expect(tokenUpdate).not.toHaveBeenCalled();
  });

  it('normalizes recognized scopes and ignores unknown scopes', async () => {
    const { strategy } = setup(
      tokenRecord({
        scopes: ['checks:read', 'unknown', 'read', 'checks:write', 'other'],
      }),
    );

    const principal = await strategy.validate(bearer('svt_valid'));

    expect(principal.apiToken).toEqual(
      expect.objectContaining({
        capabilities: ['checks:read', 'checks:write'],
        legacyScopes: ['read'],
      }),
    );
  });

  it('authenticates an existing stored project token unchanged', async () => {
    const { strategy, findUnique, updateMany, queryRaw } = setup();

    const principal = await strategy.validate(bearer('svt_valid'));

    expect(queryRaw).toHaveBeenCalledTimes(4);
    const lockStatements = queryRaw.mock.calls.map(([statement]) =>
      (statement as TemplateStringsArray).join(' '),
    );
    const membershipLock = lockStatements.findIndex((statement) =>
      statement.includes('FROM memberships'),
    );
    const projectLock = lockStatements.findIndex((statement) =>
      statement.includes('FROM projects'),
    );
    expect(membershipLock).toBeGreaterThan(-1);
    expect(projectLock).toBeGreaterThan(-1);
    expect(membershipLock).toBeLessThan(projectLock);
    expect(updateMany).toHaveBeenCalledWith({
      where: {
        id: 'token-1',
        projectId: 'project-1',
        revokedAt: null,
        OR: [
          { expiresAt: null },
          { expiresAt: { gt: expect.any(Date) as Date } },
        ],
      },
      data: { lastUsedAt: expect.any(Date) as Date },
    });
    expect(principal).toEqual({
      userId: 'user-1',
      email: 'user@example.com',
      authKind: 'api-token',
      apiToken: {
        id: 'token-1',
        projectId: 'project-1',
        capabilities: ['checks:read', 'checks:write'],
        legacyScopes: [],
      },
    });
    expect(queryRaw.mock.invocationCallOrder.at(-1)).toBeLessThan(
      findUnique.mock.invocationCallOrder[1],
    );
    expect(findUnique.mock.invocationCallOrder[1]).toBeLessThan(
      updateMany.mock.invocationCallOrder[0],
    );
  });

  it('re-reads liveness after acquiring locks and rejects concurrent revocation', async () => {
    const active = tokenRecord();
    const revoked = tokenRecord({ revokedAt: NOW });
    const findUnique = jest
      .fn()
      .mockResolvedValueOnce({
        id: active.id,
        userId: active.userId,
        projectId: active.projectId,
      })
      .mockResolvedValueOnce(revoked);
    const updateMany = jest.fn();
    const queryRaw = jest.fn().mockResolvedValue([]);
    const tx = {
      $queryRaw: queryRaw,
      apiToken: { findUnique, updateMany },
    };
    const prisma = {
      $transaction: jest.fn(
        async (callback: (client: typeof tx) => Promise<unknown>) =>
          callback(tx),
      ),
    } as unknown as PrismaService;
    const strategy = new ApiTokenStrategy(prisma, {
      verify: jest.fn(),
    } as unknown as JwtService);

    await expect(
      strategy.validate(bearer('svt_racing_revoke')),
    ).rejects.toThrow(new UnauthorizedException('Credential revoked'));
    expect(queryRaw).toHaveBeenCalledTimes(4);
    expect(queryRaw.mock.invocationCallOrder.at(-1)).toBeLessThan(
      findUnique.mock.invocationCallOrder[1],
    );
    expect(updateMany).not.toHaveBeenCalled();
  });

  it('rejects when the conditional usage touch loses an invalidation race', async () => {
    const findUnique = jest
      .fn()
      .mockResolvedValueOnce({
        id: 'token-1',
        userId: 'user-1',
        projectId: 'project-1',
      })
      .mockResolvedValueOnce(tokenRecord());
    const updateMany = jest.fn().mockResolvedValue({ count: 0 });
    const tx = {
      $queryRaw: jest.fn().mockResolvedValue([]),
      apiToken: { findUnique, updateMany },
    };
    const prisma = {
      $transaction: jest.fn(
        async (callback: (client: typeof tx) => Promise<unknown>) =>
          callback(tx),
      ),
    } as unknown as PrismaService;
    const strategy = new ApiTokenStrategy(prisma, {
      verify: jest.fn(),
    } as unknown as JwtService);

    await expect(strategy.validate(bearer('svt_racing'))).rejects.toThrow(
      new UnauthorizedException(
        'Credential became inactive during authentication',
      ),
    );
    expect(updateMany).toHaveBeenCalledWith({
      where: {
        id: 'token-1',
        projectId: 'project-1',
        revokedAt: null,
        OR: [
          { expiresAt: null },
          { expiresAt: { gt: expect.any(Date) as Date } },
        ],
      },
      data: { lastUsedAt: expect.any(Date) as Date },
    });
  });
});
