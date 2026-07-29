import { buildApp } from '../src/main';
import type { NestFastifyApplication } from '@nestjs/platform-fastify';
import { PrismaService } from '../src/prisma/prisma.service';
import { isValidSlug } from '../src/common/slug';

describe('slug columns (e2e)', () => {
  let app: NestFastifyApplication;
  let prisma: PrismaService;
  let creatorUserId: string;
  const creatorEmail = `slug-fixture-${process.pid}@systemvitals.test`;

  beforeAll(async () => {
    app = await buildApp();
    await app.init();
    await app.getHttpAdapter().getInstance().ready();
    prisma = app.get(PrismaService);
    const creator = await prisma.user.create({ data: { email: creatorEmail } });
    creatorUserId = creator.id;
  });

  afterAll(async () => {
    await prisma.$transaction([
      prisma.organization.deleteMany({ where: { creatorUserId } }),
      prisma.user.delete({ where: { id: creatorUserId } }),
    ]);
    await prisma.$disconnect();
    await app.close();
  });

  it('holds a valid slug on every existing row', async () => {
    const orgs = await prisma.organization.findMany({ select: { slug: true } });
    const projects = await prisma.project.findMany({ select: { slug: true } });
    const checks = await prisma.check.findMany({ select: { slug: true } });

    for (const row of [...orgs, ...projects, ...checks]) {
      expect(isValidSlug(row.slug)).toBe(true);
    }
  });

  it('enforces globally unique organization slugs', async () => {
    const slug = `dup-org-${Date.now()}`;
    await prisma.organization.create({
      data: {
        name: 'A',
        slug,
        creatorUserId,
        memberships: {
          create: { userId: creatorUserId, role: 'OWNER' },
        },
      },
    });
    await expect(
      prisma.organization.create({
        data: { name: 'B', slug, creatorUserId },
      }),
    ).rejects.toThrow();
  });

  it('allows the same project slug in different organizations', async () => {
    const slug = `shared-${Date.now()}`;
    const a = await prisma.organization.create({
      data: {
        name: 'OrgA',
        slug: `a-${Date.now()}`,
        creatorUserId,
        memberships: {
          create: { userId: creatorUserId, role: 'OWNER' },
        },
      },
    });
    const b = await prisma.organization.create({
      data: {
        name: 'OrgB',
        slug: `b-${Date.now()}`,
        creatorUserId,
        memberships: {
          create: { userId: creatorUserId, role: 'OWNER' },
        },
      },
    });

    await prisma.project.create({
      data: { name: 'P', slug, organizationId: a.id },
    });
    await expect(
      prisma.project.create({
        data: { name: 'P', slug, organizationId: b.id },
      }),
    ).resolves.toBeTruthy();
  });

  it('rejects a second project within one organization', async () => {
    const org = await prisma.organization.create({
      data: {
        name: 'OrgC',
        slug: `c-${Date.now()}`,
        creatorUserId,
        memberships: {
          create: { userId: creatorUserId, role: 'OWNER' },
        },
      },
    });
    const slug = `only-once-${Date.now()}`;
    await prisma.project.create({
      data: { name: 'P', slug, organizationId: org.id },
    });
    await expect(
      prisma.project.create({
        data: {
          name: 'P2',
          slug: `different-${Date.now()}`,
          organizationId: org.id,
        },
      }),
    ).rejects.toThrow();
  });

  it('rejects a duplicate check slug within one project', async () => {
    const org = await prisma.organization.create({
      data: {
        name: 'OrgD',
        slug: `d-${Date.now()}`,
        creatorUserId,
        memberships: {
          create: { userId: creatorUserId, role: 'OWNER' },
        },
      },
    });
    const project = await prisma.project.create({
      data: { name: 'P', slug: `p-${Date.now()}`, organizationId: org.id },
    });
    const slug = `check-once-${Date.now()}`;
    await prisma.check.create({
      data: { name: 'C', slug, type: 'HEARTBEAT', projectId: project.id },
    });
    await expect(
      prisma.check.create({
        data: { name: 'C2', slug, type: 'HEARTBEAT', projectId: project.id },
      }),
    ).rejects.toThrow();
  });
});
