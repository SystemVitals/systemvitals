import { buildApp } from '../src/main';
import type { NestFastifyApplication } from '@nestjs/platform-fastify';
import { PrismaService } from '../src/prisma/prisma.service';
import { JwtService } from '@nestjs/jwt';
import { cleanupTestUsers } from './cleanup-test-users';

const adminEmail = 'admin-impersonate-admin@systemvitals.test';
const victimEmail = 'admin-impersonate-victim@systemvitals.test';

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

describe('admin impersonation (e2e)', () => {
  let app: NestFastifyApplication;
  let prisma: PrismaService;
  let jwtService: JwtService;
  let adminToken: string;
  let adminId: string;
  let victimId: string;

  beforeAll(async () => {
    app = await buildApp();
    await app.init();
    await app.getHttpAdapter().getInstance().ready();

    prisma = app.get(PrismaService);
    jwtService = app.get(JwtService);

    // Clean up leftover test users
    await cleanupTestUsers(prisma, [adminEmail, victimEmail]);

    // Sign up both users
    await signup(app, victimEmail);
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
  });

  afterAll(async () => {
    try {
      await cleanupTestUsers(prisma, [adminEmail, victimEmail]);
    } finally {
      await app.close();
    }
  });

  // ─── adminImpersonate ─────────────────────────────────────────────────────────

  it('adminImpersonate returns a token with sub=victimId and act=adminId', async () => {
    const body = await adminGql(
      app,
      adminToken,
      `mutation($userId: ID!) { adminImpersonate(userId: $userId) { token expiresAt } }`,
      { userId: victimId },
    );
    expect(body.errors).toBeUndefined();
    const result = body.data?.adminImpersonate as {
      token: string;
      expiresAt: string;
    };
    expect(result.token).toBeTruthy();
    expect(result.expiresAt).toBeTruthy();

    const payload = jwtService.verify<{
      sub: string;
      act: string;
      email: string;
    }>(result.token);
    expect(payload.sub).toBe(victimId);
    expect(payload.act).toBe(adminId);
    expect(payload.email).toBe(victimEmail);
  });

  it('impersonation token is rejected by /admin/graphql (victim is not admin)', async () => {
    const body = await adminGql(
      app,
      adminToken,
      `mutation($userId: ID!) { adminImpersonate(userId: $userId) { token } }`,
      { userId: victimId },
    );
    expect(body.errors).toBeUndefined();
    const impersonationToken = (
      body.data?.adminImpersonate as { token: string }
    ).token;

    // Use the impersonation token on /admin/graphql — should be forbidden since victim is not admin
    const adminRes = await adminGql(app, impersonationToken, `{ adminPing }`);
    expect(adminRes.errors).toBeDefined();
    expect(adminRes.errors!.length).toBeGreaterThan(0);
    expect(adminRes.errors![0].message).toMatch(
      /forbidden|admin access required|unauthorized/i,
    );
  });

  it('adminImpersonate writes an AuditLog row with action=impersonate', async () => {
    const beforeCount = await prisma.auditLog.count({
      where: {
        action: 'impersonate',
        actorUserId: adminId,
        targetId: victimId,
      },
    });

    await adminGql(
      app,
      adminToken,
      `mutation($userId: ID!) { adminImpersonate(userId: $userId) { token } }`,
      { userId: victimId },
    );

    const afterCount = await prisma.auditLog.count({
      where: {
        action: 'impersonate',
        actorUserId: adminId,
        targetId: victimId,
      },
    });
    expect(afterCount).toBeGreaterThan(beforeCount);
  });

  it('adminImpersonate of a suspended user returns an error', async () => {
    // Suspend the victim
    await prisma.user.update({
      where: { id: victimId },
      data: { suspendedAt: new Date() },
    });

    const body = await adminGql(
      app,
      adminToken,
      `mutation($userId: ID!) { adminImpersonate(userId: $userId) { token } }`,
      { userId: victimId },
    );
    expect(body.errors).toBeDefined();
    expect(body.errors!.length).toBeGreaterThan(0);

    // Unsuspend for subsequent tests
    await prisma.user.update({
      where: { id: victimId },
      data: { suspendedAt: null },
    });
  });

  it('adminImpersonate of a non-existent user returns NotFoundException', async () => {
    const body = await adminGql(
      app,
      adminToken,
      `mutation($userId: ID!) { adminImpersonate(userId: $userId) { token } }`,
      { userId: 'nonexistent-user-id-xyz' },
    );
    expect(body.errors).toBeDefined();
    expect(body.errors!.length).toBeGreaterThan(0);
  });

  // ─── adminAuditLog ────────────────────────────────────────────────────────────

  it('adminAuditLog returns a paginated list with items and total', async () => {
    const body = await adminGql(
      app,
      adminToken,
      `{ adminAuditLog { items { id actorUserId actorEmail action targetType targetId createdAt } total } }`,
    );
    expect(body.errors).toBeUndefined();
    const list = body.data?.adminAuditLog as {
      items: {
        id: string;
        actorUserId: string;
        actorEmail: string;
        action: string;
      }[];
      total: number;
    };
    expect(list.total).toBeGreaterThanOrEqual(1);
    expect(list.items.length).toBeGreaterThanOrEqual(1);
    // All items should have required fields
    for (const item of list.items) {
      expect(item.id).toBeTruthy();
      expect(item.actorUserId).toBeTruthy();
      expect(item.actorEmail).toBeTruthy();
      expect(item.action).toBeTruthy();
    }
  });

  it('adminAuditLog includes the impersonate action with correct actor and target', async () => {
    const body = await adminGql(
      app,
      adminToken,
      `query($pageSize: Int) { adminAuditLog(pageSize: $pageSize) { items { actorUserId actorEmail action targetType targetId } total } }`,
      { pageSize: 100 },
    );
    expect(body.errors).toBeUndefined();
    const list = body.data?.adminAuditLog as {
      items: {
        actorUserId: string;
        actorEmail: string;
        action: string;
        targetType: string;
        targetId: string;
      }[];
      total: number;
    };
    const impersonateRows = list.items.filter(
      (i) => i.action === 'impersonate' && i.actorUserId === adminId,
    );
    expect(impersonateRows.length).toBeGreaterThanOrEqual(1);
    expect(impersonateRows[0].actorEmail).toBe(adminEmail);
    expect(impersonateRows[0].targetId).toBe(victimId);
    expect(impersonateRows[0].targetType).toBe('user');
  });
});
