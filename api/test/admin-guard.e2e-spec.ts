import { buildApp } from '../src/main';
import type { NestFastifyApplication } from '@nestjs/platform-fastify';
import { PrismaService } from '../src/prisma/prisma.service';
import { JwtService } from '@nestjs/jwt';
import { cleanupTestUsers } from './cleanup-test-users';

const normalEmail = 'admin-guard-normal@systemvitals.test';
const adminEmail = 'admin-guard-admin@systemvitals.test';
const suspendedEmail = 'admin-guard-suspended@systemvitals.test';

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
): Promise<{ data?: unknown; errors?: { message: string }[] }> {
  const res = await app.inject({
    method: 'POST',
    url: '/admin/graphql',
    payload: { query },
    headers: {
      authorization: `Bearer ${token}`,
      'content-type': 'application/json',
    },
  });
  return JSON.parse(res.body) as {
    data?: unknown;
    errors?: { message: string }[];
  };
}

async function publicGqlIntrospect(app: NestFastifyApplication): Promise<{
  data?: { __schema?: { queryType?: { fields?: { name: string }[] } } };
  errors?: unknown[];
}> {
  const res = await app.inject({
    method: 'POST',
    url: '/graphql',
    payload: {
      query: `{ __schema { queryType { fields { name } } } }`,
    },
    headers: { 'content-type': 'application/json' },
  });
  return JSON.parse(res.body) as {
    data?: { __schema?: { queryType?: { fields?: { name: string }[] } } };
    errors?: unknown[];
  };
}

describe('AdminGuard + /admin/graphql (e2e)', () => {
  let app: NestFastifyApplication;
  let prisma: PrismaService;
  let jwtService: JwtService;
  let normalToken: string;
  let adminToken: string;
  let suspendedToken: string;

  beforeAll(async () => {
    app = await buildApp();
    await app.init();
    await app.getHttpAdapter().getInstance().ready();

    prisma = app.get(PrismaService);
    jwtService = app.get(JwtService);

    // Clean up any leftover test users
    await cleanupTestUsers(prisma, [normalEmail, adminEmail, suspendedEmail]);

    // Sign up all three users
    normalToken = await signup(app, normalEmail);
    adminToken = await signup(app, adminEmail);
    suspendedToken = await signup(app, suspendedEmail);

    // Promote admin user to isAdmin
    const adminUser = await prisma.user.findUniqueOrThrow({
      where: { email: adminEmail },
    });
    await prisma.user.update({
      where: { id: adminUser.id },
      data: { isAdmin: true },
    });
    // Sign a fresh token for the admin (with their userId/email)
    adminToken = jwtService.sign({ sub: adminUser.id, email: adminEmail });

    // Promote suspended user to admin + set suspendedAt
    const suspendedUser = await prisma.user.findUniqueOrThrow({
      where: { email: suspendedEmail },
    });
    await prisma.user.update({
      where: { id: suspendedUser.id },
      data: { isAdmin: true, suspendedAt: new Date() },
    });
    suspendedToken = jwtService.sign({
      sub: suspendedUser.id,
      email: suspendedEmail,
    });
  });

  afterAll(async () => {
    try {
      await cleanupTestUsers(prisma, [normalEmail, adminEmail, suspendedEmail]);
    } finally {
      await app.close();
    }
  });

  it('normal user gets Forbidden on /admin/graphql', async () => {
    const body = await adminGql(app, normalToken, '{ adminPing }');
    expect(body.errors).toBeDefined();
    expect(body.errors!.length).toBeGreaterThan(0);
    // GraphQL returns data: null (not undefined) when all resolvers error
    expect(
      (body.data as { adminPing?: string } | null)?.adminPing,
    ).toBeUndefined();
  });

  it('admin user can query adminPing on /admin/graphql', async () => {
    const body = await adminGql(app, adminToken, '{ adminPing }');
    expect(body.errors).toBeUndefined();
    expect((body.data as { adminPing: string }).adminPing).toBe('ok');
  });

  it('suspended admin gets Forbidden on /admin/graphql', async () => {
    const body = await adminGql(app, suspendedToken, '{ adminPing }');
    expect(body.errors).toBeDefined();
    expect(body.errors!.length).toBeGreaterThan(0);
    // GraphQL returns data: null (not undefined) when all resolvers error
    expect(
      (body.data as { adminPing?: string } | null)?.adminPing,
    ).toBeUndefined();
  });

  it('public /graphql introspection does NOT list adminPing', async () => {
    const body = await publicGqlIntrospect(app);
    const fields = body.data?.__schema?.queryType?.fields ?? [];
    const names = fields.map((f) => f.name);
    expect(names).not.toContain('adminPing');
    expect(names).toContain('health');
  });
});
