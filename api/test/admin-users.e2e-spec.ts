import { buildApp } from '../src/main';
import type { NestFastifyApplication } from '@nestjs/platform-fastify';
import { PrismaService } from '../src/prisma/prisma.service';
import { JwtService } from '@nestjs/jwt';

const adminEmail = 'admin-users-admin@systemvitals.test';
const victimEmail = 'admin-users-victim@systemvitals.test';
const deletionEmails = [
  'admin-delete-creator@systemvitals.test',
  'admin-delete-paid@systemvitals.test',
  'admin-delete-solo@systemvitals.test',
];

async function signup(
  app: NestFastifyApplication,
  email: string,
): Promise<string> {
  const res = await app.inject({
    method: 'POST',
    url: '/auth/signup',
    payload: { email, password: 'supersecret1!' },
  });
  return (JSON.parse(res.body) as { token: string }).token;
}

async function adminGql(
  app: NestFastifyApplication,
  token: string,
  query: string,
  variables?: Record<string, unknown>,
): Promise<{ data?: Record<string, unknown>; errors?: { message: string }[] }> {
  const res = await app.inject({
    method: 'POST',
    url: '/admin/graphql',
    payload: { query, variables },
    headers: {
      authorization: `Bearer ${token}`,
      'content-type': 'application/json',
    },
  });
  return JSON.parse(res.body) as {
    data?: Record<string, unknown>;
    errors?: { message: string }[];
  };
}

async function publicGql(
  app: NestFastifyApplication,
  token: string,
  query: string,
): Promise<{ data?: Record<string, unknown>; errors?: { message: string }[] }> {
  const res = await app.inject({
    method: 'POST',
    url: '/graphql',
    payload: { query },
    headers: {
      authorization: `Bearer ${token}`,
      'content-type': 'application/json',
    },
  });
  return JSON.parse(res.body) as {
    data?: Record<string, unknown>;
    errors?: { message: string }[];
  };
}

describe('admin users & organizations (e2e)', () => {
  let app: NestFastifyApplication;
  let prisma: PrismaService;
  let jwtService: JwtService;
  let adminToken: string;
  let victimToken: string;
  let adminId: string;
  let victimId: string;

  async function deleteFixtureAccounts() {
    const users = await prisma.user.findMany({
      where: {
        email: { in: [adminEmail, victimEmail, ...deletionEmails] },
      },
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
    jwtService = app.get(JwtService);

    // Clean up leftover test users
    await deleteFixtureAccounts();

    // Sign up both users
    victimToken = await signup(app, victimEmail);
    await signup(app, adminEmail);

    // Promote admin to isAdmin in DB
    const adminUser = await prisma.user.findUniqueOrThrow({
      where: { email: adminEmail },
    });
    adminId = adminUser.id;
    await prisma.user.update({
      where: { id: adminId },
      data: { isAdmin: true },
    });
    adminToken = jwtService.sign({ sub: adminId, email: adminEmail });

    // Get victim id
    const victimUser = await prisma.user.findUniqueOrThrow({
      where: { email: victimEmail },
    });
    victimId = victimUser.id;
    // Re-sign victim token for later use
    victimToken = jwtService.sign({ sub: victimId, email: victimEmail });
  });

  afterAll(async () => {
    // Restore victim (may have been deleted/suspended by tests)
    await deleteFixtureAccounts();
    await app.close();
  });

  // ─── adminUsers ──────────────────────────────────────────────────────────────

  it('adminUsers returns items with total >= 1', async () => {
    const body = await adminGql(
      app,
      adminToken,
      `{ adminUsers { items { id email isAdmin suspendedAt createdAt organizations { id name role } } total } }`,
    );
    expect(body.errors).toBeUndefined();
    const list = body.data?.adminUsers as { items: unknown[]; total: number };
    expect(list.total).toBeGreaterThanOrEqual(1);
    expect(list.items.length).toBeGreaterThanOrEqual(1);
  });

  it('adminUsers search by email narrows results', async () => {
    const body = await adminGql(
      app,
      adminToken,
      `query($search: String) { adminUsers(search: $search) { items { email } total } }`,
      { search: victimEmail },
    );
    expect(body.errors).toBeUndefined();
    const list = body.data?.adminUsers as {
      items: { email: string }[];
      total: number;
    };
    expect(list.items.every((u) => u.email.includes('victim'))).toBe(true);
  });

  // ─── adminUser ───────────────────────────────────────────────────────────────

  it('adminUser returns the victim by id', async () => {
    const body = await adminGql(
      app,
      adminToken,
      `query($id: ID!) { adminUser(id: $id) { id email isAdmin } }`,
      { id: victimId },
    );
    expect(body.errors).toBeUndefined();
    const user = body.data?.adminUser as { id: string; email: string };
    expect(user.id).toBe(victimId);
    expect(user.email).toBe(victimEmail);
  });

  // ─── adminSuspendUser + victim auth check ────────────────────────────────────

  it('adminSuspendUser sets suspendedAt and victim can no longer authenticate', async () => {
    const beforeCount = await prisma.auditLog.count({
      where: { actorUserId: adminId },
    });

    const body = await adminGql(
      app,
      adminToken,
      `mutation($id: ID!) { adminSuspendUser(id: $id) { id suspendedAt } }`,
      { id: victimId },
    );
    expect(body.errors).toBeUndefined();
    const updated = body.data?.adminSuspendUser as {
      id: string;
      suspendedAt: string | null;
    };
    expect(updated.suspendedAt).not.toBeNull();

    // AuditLog count should have increased
    const afterCount = await prisma.auditLog.count({
      where: { actorUserId: adminId },
    });
    expect(afterCount).toBeGreaterThan(beforeCount);

    // Victim token should now be rejected on /graphql me query
    const meBody = await publicGql(app, victimToken, '{ me { id } }');
    expect(meBody.errors).toBeDefined();
    expect(meBody.errors!.length).toBeGreaterThan(0);
  });

  it('adminUnsuspendUser clears suspendedAt and victim can authenticate again', async () => {
    const beforeCount = await prisma.auditLog.count({
      where: { actorUserId: adminId },
    });

    const body = await adminGql(
      app,
      adminToken,
      `mutation($id: ID!) { adminUnsuspendUser(id: $id) { id suspendedAt } }`,
      { id: victimId },
    );
    expect(body.errors).toBeUndefined();
    const updated = body.data?.adminUnsuspendUser as {
      id: string;
      suspendedAt: string | null;
    };
    expect(updated.suspendedAt).toBeNull();

    // AuditLog count should have increased
    const afterCount = await prisma.auditLog.count({
      where: { actorUserId: adminId },
    });
    expect(afterCount).toBeGreaterThan(beforeCount);

    // Victim token should work again (but note JWT strategy re-checks db on every request)
    const meBody = await publicGql(app, victimToken, '{ me { id } }');
    expect(meBody.errors).toBeUndefined();
    expect((meBody.data?.me as { id: string } | undefined)?.id).toBe(victimId);
  });

  // ─── adminSetUserAdmin ───────────────────────────────────────────────────────

  it('adminSetUserAdmin(victim, true) flips isAdmin and creates audit row', async () => {
    const beforeCount = await prisma.auditLog.count({
      where: { actorUserId: adminId },
    });

    const body = await adminGql(
      app,
      adminToken,
      `mutation($id: ID!, $isAdmin: Boolean!) { adminSetUserAdmin(id: $id, isAdmin: $isAdmin) { id isAdmin } }`,
      { id: victimId, isAdmin: true },
    );
    expect(body.errors).toBeUndefined();
    const updated = body.data?.adminSetUserAdmin as {
      id: string;
      isAdmin: boolean;
    };
    expect(updated.isAdmin).toBe(true);

    const afterCount = await prisma.auditLog.count({
      where: { actorUserId: adminId },
    });
    expect(afterCount).toBeGreaterThan(beforeCount);

    // Reset victim isAdmin for remaining tests
    await prisma.user.update({
      where: { id: victimId },
      data: { isAdmin: false },
    });
  });

  // ─── Self-protection ─────────────────────────────────────────────────────────

  it('adminSuspendUser on own id returns an error (self-protection)', async () => {
    const body = await adminGql(
      app,
      adminToken,
      `mutation($id: ID!) { adminSuspendUser(id: $id) { id } }`,
      { id: adminId },
    );
    expect(body.errors).toBeDefined();
    expect(body.errors!.length).toBeGreaterThan(0);
    expect(body.errors![0].message).toMatch(/yourself/i);
  });

  it('adminSetUserAdmin(self, false) is rejected (self-demote)', async () => {
    const body = await adminGql(
      app,
      adminToken,
      `mutation($id: ID!, $isAdmin: Boolean!) { adminSetUserAdmin(id: $id, isAdmin: $isAdmin) { id } }`,
      { id: adminId, isAdmin: false },
    );
    expect(body.errors).toBeDefined();
    expect(body.errors!.length).toBeGreaterThan(0);
  });

  // ─── adminOrganizations ──────────────────────────────────────────────────────

  it('adminOrganizations returns list with total >= 1', async () => {
    const body = await adminGql(
      app,
      adminToken,
      `{ adminOrganizations { items { id name createdAt projectCount plan members { userId email role } } total } }`,
    );
    expect(body.errors).toBeUndefined();
    const list = body.data?.adminOrganizations as {
      items: unknown[];
      total: number;
    };
    expect(list.total).toBeGreaterThanOrEqual(1);
  });

  it('adminOrganization returns a single org by id', async () => {
    // Get an org id from the victim's memberships
    const memberships = await prisma.membership.findMany({
      where: { userId: victimId },
      select: { organizationId: true },
    });
    expect(memberships.length).toBeGreaterThan(0);
    const orgId = memberships[0].organizationId;

    const body = await adminGql(
      app,
      adminToken,
      `query($id: ID!) { adminOrganization(id: $id) { id name projectCount members { userId role } } }`,
      { id: orgId },
    );
    expect(body.errors).toBeUndefined();
    const org = body.data?.adminOrganization as {
      id: string;
      members: unknown[];
    };
    expect(org.id).toBe(orgId);
    expect(Array.isArray(org.members)).toBe(true);
  });

  // ─── adminDeleteOrganization ─────────────────────────────────────────────────

  it('adminDeleteOrganization removes an org and writes audit row before delete', async () => {
    // Create a throwaway org to delete
    const throwawayOrg = await prisma.organization.create({
      data: {
        name: 'Throwaway Org for delete test',
        slug: `throwaway-${Date.now()}`,
        creatorUserId: adminId,
        memberships: {
          create: { userId: adminId, role: 'OWNER' },
        },
      },
    });

    const beforeCount = await prisma.auditLog.count({
      where: { actorUserId: adminId },
    });

    const body = await adminGql(
      app,
      adminToken,
      `mutation($id: ID!) { adminDeleteOrganization(id: $id) }`,
      { id: throwawayOrg.id },
    );
    expect(body.errors).toBeUndefined();
    expect(body.data?.adminDeleteOrganization).toBe(true);

    const afterCount = await prisma.auditLog.count({
      where: { actorUserId: adminId },
    });
    expect(afterCount).toBeGreaterThan(beforeCount);

    // Verify it's gone
    const gone = await prisma.organization.findUnique({
      where: { id: throwawayOrg.id },
    });
    expect(gone).toBeNull();
  });

  // ─── adminDeleteUser ─────────────────────────────────────────────────────────

  it('blocks an organization creator without writing a delete audit', async () => {
    const target = await prisma.user.create({
      data: {
        email: deletionEmails[0],
        passwordHash: 'x',
        createdOrganizations: {
          create: {
            name: 'Creator deletion guard',
            slug: `creator-delete-${Date.now()}`,
          },
        },
      },
    });

    const body = await adminGql(
      app,
      adminToken,
      `mutation($id: ID!) { adminDeleteUser(id: $id) }`,
      { id: target.id },
    );

    expect(body.errors?.[0]?.message).toBe(
      'Transfer organization creatorship before deleting this account',
    );
    await expect(
      prisma.user.findUnique({ where: { id: target.id } }),
    ).resolves.not.toBeNull();
    await expect(
      prisma.auditLog.count({
        where: {
          actorUserId: adminId,
          action: 'user.delete',
          targetId: target.id,
        },
      }),
    ).resolves.toBe(0);
  });

  it('blocks paid billing without audit or Stripe-side mutation', async () => {
    const target = await prisma.user.create({
      data: {
        email: deletionEmails[1],
        passwordHash: 'x',
        subscription: {
          create: {
            plan: 'SIGNAL',
            status: 'active',
            stripeSubscriptionId: `sub_admin_delete_${Date.now()}`,
          },
        },
      },
    });

    const body = await adminGql(
      app,
      adminToken,
      `mutation($id: ID!) { adminDeleteUser(id: $id) }`,
      { id: target.id },
    );

    expect(body.errors?.[0]?.message).toBe(
      'Cancel account billing before deleting this account',
    );
    const unchanged = await prisma.subscription.findUnique({
      where: { userId: target.id },
    });
    expect(unchanged).toMatchObject({
      plan: 'SIGNAL',
      status: 'active',
    });
    expect(unchanged?.stripeSubscriptionId).toMatch(/^sub_admin_delete_/);
    await expect(
      prisma.auditLog.count({
        where: {
          actorUserId: adminId,
          action: 'user.delete',
          targetId: target.id,
        },
      }),
    ).resolves.toBe(0);
  });

  it('deletes a transferred SOLO account and writes exactly one audit', async () => {
    const target = await prisma.user.create({
      data: {
        email: deletionEmails[2],
        passwordHash: 'x',
        subscription: {
          create: {
            plan: 'SOLO',
            status: 'active',
          },
        },
        createdOrganizations: {
          create: {
            name: 'Transferred deletion succeeds',
            slug: `transferred-delete-${Date.now()}`,
          },
        },
      },
      include: { createdOrganizations: true },
    });
    await prisma.organization.update({
      where: { id: target.createdOrganizations[0].id },
      data: { creatorUserId: adminId },
    });

    const body = await adminGql(
      app,
      adminToken,
      `mutation($id: ID!) { adminDeleteUser(id: $id) }`,
      { id: target.id },
    );

    expect(body.errors).toBeUndefined();
    expect(body.data?.adminDeleteUser).toBe(true);
    await expect(
      prisma.user.findUnique({ where: { id: target.id } }),
    ).resolves.toBeNull();
    await expect(
      prisma.subscription.findUnique({ where: { userId: target.id } }),
    ).resolves.toBeNull();
    await expect(
      prisma.auditLog.count({
        where: {
          actorUserId: adminId,
          action: 'user.delete',
          targetId: target.id,
        },
      }),
    ).resolves.toBe(1);
  });

  it('adminDeleteUser on own id is rejected (self-protection)', async () => {
    const body = await adminGql(
      app,
      adminToken,
      `mutation($id: ID!) { adminDeleteUser(id: $id) }`,
      { id: adminId },
    );
    expect(body.errors).toBeDefined();
    expect(body.errors!.length).toBeGreaterThan(0);
  });
});
