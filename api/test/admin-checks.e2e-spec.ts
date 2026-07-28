import { buildApp } from '../src/main';
import type { NestFastifyApplication } from '@nestjs/platform-fastify';
import { PrismaService } from '../src/prisma/prisma.service';
import { JwtService } from '@nestjs/jwt';
import { cleanupTestUsers } from './cleanup-test-users';

const adminEmail = 'admin-checks-admin@systemvitals.test';
const userEmail = 'admin-checks-user@systemvitals.test';

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

async function userGql(
  app: NestFastifyApplication,
  token: string,
  query: string,
  variables?: Record<string, unknown>,
): Promise<{ data?: Record<string, unknown>; errors?: { message: string }[] }> {
  const res = await app.inject({
    method: 'POST',
    url: '/graphql',
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

describe('admin checks & projects (e2e)', () => {
  let app: NestFastifyApplication;
  let prisma: PrismaService;
  let jwtService: JwtService;
  let adminToken: string;
  let adminId: string;
  let userToken: string;
  let checkId: string;
  let projectId: string;

  beforeAll(async () => {
    app = await buildApp();
    await app.init();
    await app.getHttpAdapter().getInstance().ready();

    prisma = app.get(PrismaService);
    jwtService = app.get(JwtService);

    // Clean up leftover test users
    await cleanupTestUsers(prisma, [adminEmail, userEmail]);

    // Sign up a regular user (this auto-creates their Default org + project)
    userToken = await signup(app, userEmail);
    const userRecord = await prisma.user.findUniqueOrThrow({
      where: { email: userEmail },
    });
    userToken = jwtService.sign({ sub: userRecord.id, email: userEmail });

    // Sign up admin
    await signup(app, adminEmail);
    const adminRecord = await prisma.user.findUniqueOrThrow({
      where: { email: adminEmail },
    });
    adminId = adminRecord.id;
    await prisma.user.update({
      where: { id: adminRecord.id },
      data: { isAdmin: true },
    });
    adminToken = jwtService.sign({ sub: adminRecord.id, email: adminEmail });

    // Find the user's default project
    const membership = await prisma.membership.findFirstOrThrow({
      where: { userId: userRecord.id },
      include: { organization: { include: { projects: true } } },
    });
    const project = membership.organization.projects[0];
    projectId = project.id;

    // Create a check via GraphQL (user API)
    const createRes = await userGql(
      app,
      userToken,
      `mutation($projectId: ID!, $name: String!, $periodSeconds: Int!, $graceSeconds: Int!) {
        createCheck(projectId: $projectId, name: $name, periodSeconds: $periodSeconds, graceSeconds: $graceSeconds) {
          id
        }
      }`,
      {
        projectId,
        name: 'Admin Test Check',
        periodSeconds: 300,
        graceSeconds: 60,
      },
    );
    expect(createRes.errors).toBeUndefined();
    checkId = (createRes.data?.createCheck as { id: string }).id;
  });

  afterAll(async () => {
    try {
      await cleanupTestUsers(prisma, [adminEmail, userEmail]);
    } finally {
      await app.close();
    }
  });

  // ─── adminProjects ────────────────────────────────────────────────────────────

  it('adminProjects returns items with org context and total >= 1', async () => {
    const body = await adminGql(
      app,
      adminToken,
      `{ adminProjects { items { id name organizationId organizationName checkCount createdAt } total } }`,
    );
    expect(body.errors).toBeUndefined();
    const list = body.data?.adminProjects as {
      items: { id: string; organizationId: string; organizationName: string }[];
      total: number;
    };
    expect(list.total).toBeGreaterThanOrEqual(1);
    expect(list.items.length).toBeGreaterThanOrEqual(1);
    // Every item has org context populated
    expect(
      list.items.every((p) => p.organizationId && p.organizationName),
    ).toBe(true);
  });

  it('adminProjects search narrows results', async () => {
    const body = await adminGql(
      app,
      adminToken,
      `query($search: String) { adminProjects(search: $search) { items { id name } total } }`,
      { search: 'nonexistent-project-xyz-12345' },
    );
    expect(body.errors).toBeUndefined();
    const list = body.data?.adminProjects as {
      items: unknown[];
      total: number;
    };
    expect(list.total).toBe(0);
    expect(list.items.length).toBe(0);
  });

  // ─── adminChecks (list + status filter) ──────────────────────────────────────

  it('adminChecks lists checks cross-tenant with org/project context', async () => {
    const body = await adminGql(
      app,
      adminToken,
      `{ adminChecks { items { id name type status projectId projectName organizationId organizationName } total } }`,
    );
    expect(body.errors).toBeUndefined();
    const list = body.data?.adminChecks as {
      items: {
        id: string;
        name: string;
        type: string;
        status: string;
        projectId: string;
        projectName: string;
        organizationId: string;
        organizationName: string;
      }[];
      total: number;
    };
    expect(list.total).toBeGreaterThanOrEqual(1);
    // Find our seeded check
    const found = list.items.find((c) => c.id === checkId);
    expect(found).toBeDefined();
    expect(found!.projectId).toBe(projectId);
    expect(found!.organizationId).toBeTruthy();
    expect(found!.organizationName).toBeTruthy();
    expect(found!.projectName).toBeTruthy();
  });

  it('adminChecks status filter narrows results to PAUSED when no checks are paused', async () => {
    const body = await adminGql(
      app,
      adminToken,
      `query($status: String) { adminChecks(status: $status) { items { id status } total } }`,
      { status: 'PAUSED' },
    );
    expect(body.errors).toBeUndefined();
    const list = body.data?.adminChecks as {
      items: { id: string; status: string }[];
      total: number;
    };
    // Our check is NEW, not paused — so it should not appear in PAUSED filter
    const foundOurCheck = list.items.find((c) => c.id === checkId);
    expect(foundOurCheck).toBeUndefined();
    // All returned items must be PAUSED
    expect(list.items.every((c) => c.status === 'PAUSED')).toBe(true);
  });

  // ─── adminPauseCheck ──────────────────────────────────────────────────────────

  it('adminPauseCheck sets check status to PAUSED and writes audit row', async () => {
    const beforeCount = await prisma.auditLog.count({
      where: { actorUserId: adminId },
    });

    const body = await adminGql(
      app,
      adminToken,
      `mutation($id: ID!) { adminPauseCheck(id: $id) { id status } }`,
      { id: checkId },
    );
    expect(body.errors).toBeUndefined();
    const updated = body.data?.adminPauseCheck as {
      id: string;
      status: string;
    };
    expect(updated.id).toBe(checkId);
    expect(updated.status).toBe('PAUSED');

    const afterCount = await prisma.auditLog.count({
      where: { actorUserId: adminId },
    });
    expect(afterCount).toBeGreaterThan(beforeCount);

    // Verify in DB
    const dbCheck = await prisma.check.findUniqueOrThrow({
      where: { id: checkId },
    });
    expect(dbCheck.status).toBe('PAUSED');
  });

  it('adminChecks status filter narrows to PAUSED after pause', async () => {
    const body = await adminGql(
      app,
      adminToken,
      `query($status: String) { adminChecks(status: $status) { items { id status } total } }`,
      { status: 'PAUSED' },
    );
    expect(body.errors).toBeUndefined();
    const list = body.data?.adminChecks as {
      items: { id: string; status: string }[];
      total: number;
    };
    const found = list.items.find((c) => c.id === checkId);
    expect(found).toBeDefined();
    expect(found!.status).toBe('PAUSED');
  });

  // ─── adminResumeCheck ─────────────────────────────────────────────────────────

  it('adminResumeCheck sets check status back to NEW and writes audit row', async () => {
    const beforeCount = await prisma.auditLog.count({
      where: { actorUserId: adminId },
    });

    const body = await adminGql(
      app,
      adminToken,
      `mutation($id: ID!) { adminResumeCheck(id: $id) { id status } }`,
      { id: checkId },
    );
    expect(body.errors).toBeUndefined();
    const updated = body.data?.adminResumeCheck as {
      id: string;
      status: string;
    };
    expect(updated.id).toBe(checkId);
    expect(updated.status).toBe('NEW');

    const afterCount = await prisma.auditLog.count({
      where: { actorUserId: adminId },
    });
    expect(afterCount).toBeGreaterThan(beforeCount);

    // Verify in DB
    const dbCheck = await prisma.check.findUniqueOrThrow({
      where: { id: checkId },
    });
    expect(dbCheck.status).toBe('NEW');
  });

  // ─── adminDeleteCheck ─────────────────────────────────────────────────────────

  it('adminDeleteCheck removes the check and writes audit row', async () => {
    const beforeCount = await prisma.auditLog.count({
      where: { actorUserId: adminId },
    });

    const body = await adminGql(
      app,
      adminToken,
      `mutation($id: ID!) { adminDeleteCheck(id: $id) }`,
      { id: checkId },
    );
    expect(body.errors).toBeUndefined();
    expect(body.data?.adminDeleteCheck).toBe(true);

    const afterCount = await prisma.auditLog.count({
      where: { actorUserId: adminId },
    });
    expect(afterCount).toBeGreaterThan(beforeCount);

    // Verify it's gone from DB
    const gone = await prisma.check.findUnique({ where: { id: checkId } });
    expect(gone).toBeNull();

    // Verify adminChecks no longer lists it
    const listBody = await adminGql(
      app,
      adminToken,
      `{ adminChecks { items { id } total } }`,
    );
    const list = listBody.data?.adminChecks as { items: { id: string }[] };
    const stillThere = list.items.find((c) => c.id === checkId);
    expect(stillThere).toBeUndefined();
  });

  it('adminDeleteCheck on non-existent id returns an error', async () => {
    const body = await adminGql(
      app,
      adminToken,
      `mutation($id: ID!) { adminDeleteCheck(id: $id) }`,
      { id: 'nonexistent-check-id' },
    );
    expect(body.errors).toBeDefined();
    expect(body.errors!.length).toBeGreaterThan(0);
  });
});
