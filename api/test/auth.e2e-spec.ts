import { buildApp } from '../src/main';
import type { NestFastifyApplication } from '@nestjs/platform-fastify';
import { PrismaService } from '../src/prisma/prisma.service';
import { isValidSlug } from '../src/common/slug';

describe('auth (e2e)', () => {
  let app: NestFastifyApplication;
  let prisma: PrismaService;
  const email = 'owner@systemvitals.com';
  async function deleteAccounts(emails: string[]) {
    const users = await prisma.user.findMany({
      where: { email: { in: emails } },
      select: { id: true },
    });
    const userIds = users.map((user) => user.id);
    await prisma.$transaction([
      prisma.organization.deleteMany({
        where: { creatorUserId: { in: userIds } },
      }),
      prisma.user.deleteMany({ where: { id: { in: userIds } } }),
    ]);
  }

  beforeAll(async () => {
    app = await buildApp();
    await app.init();
    await app.getHttpAdapter().getInstance().ready();
    prisma = app.get(PrismaService);
    await deleteAccounts([email]);
  });
  afterAll(async () => {
    await deleteAccounts([email]);
    await app.close();
  });

  it('signup creates a user with an org, owner membership, and default project', async () => {
    const res = await app.inject({
      method: 'POST',
      url: '/auth/signup',
      payload: { email, password: 'supersecret1' },
    });
    expect(res.statusCode).toBe(201);
    const body = JSON.parse(res.body) as { token: string };
    expect(body.token).toBeDefined();

    const user = await prisma.user.findUnique({
      where: { email },
      include: {
        subscription: true,
        memberships: {
          include: {
            organization: { include: { projects: true } },
          },
        },
      },
    });
    expect(user!.memberships).toHaveLength(1);
    expect(user!.memberships[0].role).toBe('OWNER');
    const org = user!.memberships[0].organization;
    expect(org.creatorUserId).toBe(user!.id);
    expect(org.projects).toHaveLength(1);
    expect(org.projects[0].pingKey).toBeTruthy();
    expect(user!.subscription!.plan).toBe('SOLO');
  });

  it('login returns a token for valid credentials and rejects bad ones', async () => {
    const ok = await app.inject({
      method: 'POST',
      url: '/auth/login',
      payload: { email, password: 'supersecret1' },
    });
    expect(ok.statusCode).toBe(201);
    expect((JSON.parse(ok.body) as { token: string }).token).toBeDefined();

    const bad = await app.inject({
      method: 'POST',
      url: '/auth/login',
      payload: { email, password: 'wrong' },
    });
    expect(bad.statusCode).toBe(401);
  });

  it('N concurrent signups whose email local-parts collide ALL succeed with distinct, valid org slugs (Fix 4)', async () => {
    const CONCURRENCY = 10;
    // Same local-part ("racer"), distinct domains — auth.service derives the
    // org slug base from the local-part alone, so these all race for the
    // same starting slug candidate.
    const emails = Array.from(
      { length: CONCURRENCY },
      (_, i) => `racer@race-domain-${i}.systemvitals.com`,
    );
    await deleteAccounts(emails);

    const results = await Promise.all(
      emails.map((raceEmail) =>
        app.inject({
          method: 'POST',
          url: '/auth/signup',
          payload: { email: raceEmail, password: 'supersecret1' },
        }),
      ),
    );

    for (const res of results) {
      expect(res.statusCode).toBe(201);
      expect((JSON.parse(res.body) as { token: string }).token).toBeDefined();
    }

    const users = await prisma.user.findMany({
      where: { email: { in: emails } },
      include: { memberships: { include: { organization: true } } },
    });
    expect(users).toHaveLength(CONCURRENCY);

    const orgSlugs = users.map((u) => u.memberships[0].organization.slug);
    expect(new Set(orgSlugs).size).toBe(CONCURRENCY);
    for (const slug of orgSlugs) {
      expect(isValidSlug(slug)).toBe(true);
    }

    await deleteAccounts(emails);
  });
});
