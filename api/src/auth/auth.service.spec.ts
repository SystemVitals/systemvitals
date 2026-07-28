import { UnauthorizedException } from '@nestjs/common';
import * as argon2 from 'argon2';
import { AuthService } from './auth.service';
import type { PrismaService } from '../prisma/prisma.service';
import type { JwtService } from '@nestjs/jwt';

/** Minimal in-memory stand-in for the tables AuthService touches. */
export function makePrismaMock() {
  const created: Record<string, unknown[]> = {
    user: [],
    organization: [],
    membership: [],
    project: [],
    subscription: [],
  };
  const tx = {
    user: {
      create: jest.fn(({ data }: { data: Record<string, unknown> }) => {
        const row = {
          id: `u${created.user.length + 1}`,
          suspendedAt: null,
          ...data,
        };
        created.user.push(row);
        return Promise.resolve(row);
      }),
    },
    organization: {
      create: jest.fn(({ data }: { data: Record<string, unknown> }) => {
        const row = { id: `o${created.organization.length + 1}`, ...data };
        created.organization.push(row);
        return Promise.resolve(row);
      }),
      findMany: jest.fn(() =>
        Promise.resolve(
          created.organization.map((o) => ({
            slug: (o as { slug: string }).slug,
          })),
        ),
      ),
    },
    membership: {
      create: jest.fn(({ data }: { data: unknown }) => {
        created.membership.push(data);
        return Promise.resolve(data);
      }),
    },
    project: {
      create: jest.fn(({ data }: { data: unknown }) => {
        created.project.push(data);
        return Promise.resolve(data);
      }),
    },
    subscription: {
      create: jest.fn(({ data }: { data: unknown }) => {
        created.subscription.push(data);
        return Promise.resolve(data);
      }),
    },
  };
  const prisma = {
    created,
    tx,
    user: {
      findUnique: jest.fn(() => Promise.resolve(null)),
      findUniqueOrThrow: jest.fn(() => Promise.resolve(null)),
      update: jest.fn(
        ({
          where,
          data,
        }: {
          where: Record<string, unknown>;
          data: Record<string, unknown>;
        }) =>
          Promise.resolve({
            id: (where.id as string) || 'u1',
            suspendedAt: null,
            ...data,
          }),
      ),
    },
    // Read outside the transaction so a slug-collision retry (Fix 4) can
    // reload the current taken set before re-running the whole transaction.
    organization: {
      findMany: jest.fn(() =>
        Promise.resolve(
          created.organization.map((o) => ({
            slug: (o as { slug: string }).slug,
          })),
        ),
      ),
    },
    $transaction: jest.fn((fn: (t: typeof tx) => unknown) =>
      Promise.resolve(fn(tx)),
    ),
  };
  return prisma;
}

export function makeService(prisma: ReturnType<typeof makePrismaMock>) {
  const jwt = { sign: jest.fn(() => 'signed.jwt.token') };
  return new AuthService(
    prisma as unknown as PrismaService,
    jwt as unknown as JwtService,
  );
}

describe('AuthService.signup', () => {
  it('provisions user, creator-owned org, OWNER membership, Default project and account SOLO subscription', async () => {
    const prisma = makePrismaMock();
    const service = makeService(prisma);

    const result = await service.signup('ada@example.com', 'hunter2hunter2');

    expect(result).toEqual({ token: 'signed.jwt.token', userId: 'u1' });
    expect(prisma.created.organization[0]).toMatchObject({
      name: "ada's org",
      creatorUserId: 'u1',
    });
    expect(prisma.created.membership[0]).toMatchObject({ role: 'OWNER' });
    expect(prisma.created.project[0]).toMatchObject({ name: 'Default' });
    expect(prisma.created.subscription[0]).toEqual({
      userId: 'u1',
      plan: 'SOLO',
    });
    expect(prisma.created.subscription[0]).not.toHaveProperty('organizationId');
  });

  it('normalizes a mixed-case email before storing it', async () => {
    const prisma = makePrismaMock();
    const service = makeService(prisma);

    await service.signup('Ada@Example.com', 'hunter2hunter2');

    const call = prisma.tx.user.create.mock.calls[0][0] as unknown as {
      data: { email: string };
    };
    expect(call.data.email).toBe('ada@example.com');
  });

  it('stores an argon2 hash, never the raw password', async () => {
    const prisma = makePrismaMock();
    const service = makeService(prisma);

    await service.signup('ada@example.com', 'hunter2hunter2');

    const user = prisma.created.user[0] as { passwordHash: string };
    expect(user.passwordHash).not.toBe('hunter2hunter2');
    expect(await argon2.verify(user.passwordHash, 'hunter2hunter2')).toBe(true);
  });
});

describe('AuthService.login', () => {
  it('rejects a Google-only user with the generic message', async () => {
    const prisma = makePrismaMock();
    prisma.user.findUnique = jest.fn(() =>
      Promise.resolve({
        id: 'u1',
        email: 'ada@example.com',
        passwordHash: null,
        googleId: 'g1',
        suspendedAt: null,
      }),
    ) as unknown as typeof prisma.user.findUnique;
    const service = makeService(prisma);

    await expect(service.login('ada@example.com', 'anything')).rejects.toThrow(
      new UnauthorizedException('Invalid credentials'),
    );
  });

  it('logs in a user who has a password hash', async () => {
    const prisma = makePrismaMock();
    const hash = await argon2.hash('hunter2hunter2');
    prisma.user.findUnique = jest.fn(() =>
      Promise.resolve({
        id: 'u1',
        email: 'ada@example.com',
        passwordHash: hash,
        googleId: null,
        suspendedAt: null,
      }),
    ) as unknown as typeof prisma.user.findUnique;
    const service = makeService(prisma);

    await expect(
      service.login('ada@example.com', 'hunter2hunter2'),
    ).resolves.toEqual({
      token: 'signed.jwt.token',
      userId: 'u1',
    });
  });

  it('normalizes a mixed-case email before the lookup', async () => {
    const prisma = makePrismaMock();
    const hash = await argon2.hash('hunter2hunter2');
    prisma.user.findUnique = jest.fn(() =>
      Promise.resolve({
        id: 'u1',
        email: 'ada@example.com',
        passwordHash: hash,
        googleId: null,
        suspendedAt: null,
      }),
    ) as unknown as typeof prisma.user.findUnique;
    const service = makeService(prisma);

    await service.login('Ada@Example.com', 'hunter2hunter2');

    expect(prisma.user.findUnique).toHaveBeenCalledWith({
      where: { email: 'ada@example.com' },
    });
  });
});

describe('AuthService.loginWithGoogle', () => {
  const identity = {
    googleId: 'google-sub-1',
    email: 'ada@example.com',
    emailVerified: true,
  };

  it('rejects an unverified Google email', async () => {
    const prisma = makePrismaMock();
    const service = makeService(prisma);

    await expect(
      service.loginWithGoogle({ ...identity, emailVerified: false }),
    ).rejects.toThrow(UnauthorizedException);
    expect(prisma.created.user).toHaveLength(0);
  });

  it('rejects a truthy non-boolean emailVerified from the JSON boundary', async () => {
    const prisma = makePrismaMock();
    const service = makeService(prisma);

    await expect(
      service.loginWithGoogle({
        ...identity,
        emailVerified: 'false' as unknown as boolean,
      }),
    ).rejects.toThrow(UnauthorizedException);
    expect(prisma.created.user).toHaveLength(0);
  });

  it('logs in an existing user matched by googleId', async () => {
    const prisma = makePrismaMock();
    prisma.user.findUnique = jest.fn(
      (args: { where: Record<string, unknown> }) =>
        Promise.resolve(
          args.where.googleId
            ? { id: 'u9', email: 'ada@example.com', suspendedAt: null }
            : null,
        ),
    ) as unknown as typeof prisma.user.findUnique;
    const service = makeService(prisma);

    await expect(service.loginWithGoogle(identity)).resolves.toEqual({
      token: 'signed.jwt.token',
      userId: 'u9',
    });
    expect(prisma.created.user).toHaveLength(0);
  });

  it('links Google to an existing password account with the same email', async () => {
    const prisma = makePrismaMock();
    prisma.user.findUnique = jest.fn(
      (args: { where: Record<string, unknown> }) =>
        Promise.resolve(
          args.where.email
            ? {
                id: 'u5',
                email: 'ada@example.com',
                suspendedAt: null,
                googleId: null,
              }
            : null,
        ),
    ) as unknown as typeof prisma.user.findUnique;
    const service = makeService(prisma);

    const result = await service.loginWithGoogle(identity);

    expect(result.userId).toBe('u5');
    expect(prisma.user.update).toHaveBeenCalledWith({
      where: { id: 'u5' },
      data: { googleId: 'google-sub-1' },
    });
    expect(prisma.created.user).toHaveLength(0);
  });

  it('links to the existing account when the stored email differs only by case (the reported bug)', async () => {
    // Reproduces the real-world report: an account exists (already normalized
    // to lowercase, as every account will be post-migration) but the identity
    // handed to loginWithGoogle arrives with different casing. The mock does
    // an exact string comparison against the *normalized* stored value — just
    // like a real Postgres unique-index lookup would — so this only passes if
    // the service itself normalizes before querying, not because the mock is
    // lenient about what was passed.
    const prisma = makePrismaMock();
    prisma.user.findUnique = jest.fn(
      (args: { where: Record<string, unknown> }) => {
        if (args.where.googleId) return Promise.resolve(null);
        if (args.where.email === 'ada@example.com') {
          return Promise.resolve({
            id: 'u5',
            email: 'ada@example.com',
            suspendedAt: null,
            googleId: null,
          });
        }
        return Promise.resolve(null);
      },
    ) as unknown as typeof prisma.user.findUnique;
    const service = makeService(prisma);

    const result = await service.loginWithGoogle({
      ...identity,
      email: 'Ada@Example.com',
    });

    expect(result.userId).toBe('u5');
    expect(prisma.user.update).toHaveBeenCalledWith({
      where: { id: 'u5' },
      data: { googleId: 'google-sub-1' },
    });
    expect(prisma.created.user).toHaveLength(0);
  });

  it('normalizes the email it provisions for a brand-new user', async () => {
    const prisma = makePrismaMock();
    const service = makeService(prisma);

    const result = await service.loginWithGoogle({
      ...identity,
      email: 'Ada@Example.com',
    });

    expect(result.userId).toBe('u1');
    const call = prisma.tx.user.create.mock.calls[0][0] as unknown as {
      data: { email: string };
    };
    expect(call.data.email).toBe('ada@example.com');
    expect(prisma.created.organization[0]).toMatchObject({ name: "ada's org" });
  });

  it('provisions a brand-new account when nothing matches', async () => {
    const prisma = makePrismaMock();
    const service = makeService(prisma);

    const result = await service.loginWithGoogle(identity);

    expect(result.userId).toBe('u1');
    expect(prisma.created.user[0]).toMatchObject({
      email: 'ada@example.com',
      googleId: 'google-sub-1',
      passwordHash: null,
    });
    expect(prisma.created.organization[0]).toMatchObject({ name: "ada's org" });
    expect(prisma.created.membership[0]).toMatchObject({ role: 'OWNER' });
    expect(prisma.created.project[0]).toMatchObject({ name: 'Default' });
    expect(prisma.created.subscription[0]).toMatchObject({ plan: 'SOLO' });
  });

  it('rejects a suspended account matched by googleId', async () => {
    const prisma = makePrismaMock();
    prisma.user.findUnique = jest.fn(
      (args: { where: Record<string, unknown> }) =>
        Promise.resolve(
          args.where.googleId
            ? { id: 'u9', email: 'ada@example.com', suspendedAt: new Date() }
            : null,
        ),
    ) as unknown as typeof prisma.user.findUnique;
    const service = makeService(prisma);

    await expect(service.loginWithGoogle(identity)).rejects.toThrow(
      UnauthorizedException,
    );
  });

  it('rejects a suspended account matched by email', async () => {
    const prisma = makePrismaMock();
    prisma.user.findUnique = jest.fn(
      (args: { where: Record<string, unknown> }) =>
        Promise.resolve(
          args.where.email
            ? {
                id: 'u5',
                email: 'ada@example.com',
                suspendedAt: new Date(),
                googleId: null,
              }
            : null,
        ),
    ) as unknown as typeof prisma.user.findUnique;
    const service = makeService(prisma);

    await expect(service.loginWithGoogle(identity)).rejects.toThrow(
      UnauthorizedException,
    );
    expect(prisma.user.update).not.toHaveBeenCalled();
  });
});

describe('AuthService.setPassword', () => {
  it('sets a password for a Google-only user without asking for a current one', async () => {
    const prisma = makePrismaMock();
    prisma.user.findUniqueOrThrow = jest.fn(() =>
      Promise.resolve({
        id: 'u1',
        email: 'ada@example.com',
        passwordHash: null,
      }),
    ) as unknown as typeof prisma.user.findUniqueOrThrow;
    const service = makeService(prisma);

    await expect(service.setPassword('u1', 'newpassword123')).resolves.toBe(
      true,
    );

    const call = prisma.user.update.mock.calls[0][0] as unknown as {
      data: { passwordHash: string };
    };
    expect(await argon2.verify(call.data.passwordHash, 'newpassword123')).toBe(
      true,
    );
  });

  it('requires the current password when one is already set', async () => {
    const prisma = makePrismaMock();
    const hash = await argon2.hash('oldpassword123');
    prisma.user.findUniqueOrThrow = jest.fn(() =>
      Promise.resolve({
        id: 'u1',
        email: 'ada@example.com',
        passwordHash: hash,
      }),
    ) as unknown as typeof prisma.user.findUniqueOrThrow;
    const service = makeService(prisma);

    await expect(service.setPassword('u1', 'newpassword123')).rejects.toThrow(
      UnauthorizedException,
    );
    expect(prisma.user.update).not.toHaveBeenCalled();
  });

  it('rejects a wrong current password', async () => {
    const prisma = makePrismaMock();
    const hash = await argon2.hash('oldpassword123');
    prisma.user.findUniqueOrThrow = jest.fn(() =>
      Promise.resolve({
        id: 'u1',
        email: 'ada@example.com',
        passwordHash: hash,
      }),
    ) as unknown as typeof prisma.user.findUniqueOrThrow;
    const service = makeService(prisma);

    await expect(
      service.setPassword('u1', 'newpassword123', 'wrongpassword'),
    ).rejects.toThrow(UnauthorizedException);
    expect(prisma.user.update).not.toHaveBeenCalled();
  });

  it('changes the password when the current one is correct', async () => {
    const prisma = makePrismaMock();
    const hash = await argon2.hash('oldpassword123');
    prisma.user.findUniqueOrThrow = jest.fn(() =>
      Promise.resolve({
        id: 'u1',
        email: 'ada@example.com',
        passwordHash: hash,
      }),
    ) as unknown as typeof prisma.user.findUniqueOrThrow;
    const service = makeService(prisma);

    await expect(
      service.setPassword('u1', 'newpassword123', 'oldpassword123'),
    ).resolves.toBe(true);

    const call = prisma.user.update.mock.calls[0][0] as unknown as {
      data: { passwordHash: string };
    };
    expect(await argon2.verify(call.data.passwordHash, 'newpassword123')).toBe(
      true,
    );
  });
});
