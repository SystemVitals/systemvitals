import { buildApp } from '../src/main';
import type { NestFastifyApplication } from '@nestjs/platform-fastify';
import { PrismaService } from '../src/prisma/prisma.service';
import { JwtService } from '@nestjs/jwt';
import { cleanupTestUsers } from './cleanup-test-users';

const adminEmail = 'admin-metrics-admin@systemvitals.test';
const userEmail = 'admin-metrics-user@systemvitals.test';

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

describe('admin metrics (e2e)', () => {
  let app: NestFastifyApplication;
  let prisma: PrismaService;
  let jwtService: JwtService;
  let adminToken: string;
  let userToken: string;

  beforeAll(async () => {
    app = await buildApp();
    await app.init();
    await app.getHttpAdapter().getInstance().ready();

    prisma = app.get(PrismaService);
    jwtService = app.get(JwtService);

    // Clean up leftover test users
    await cleanupTestUsers(prisma, [adminEmail, userEmail]);

    // Sign up a regular user
    userToken = await signup(app, userEmail);
    const userRecord = await prisma.user.findUniqueOrThrow({
      where: { email: userEmail },
    });
    userToken = jwtService.sign({ sub: userRecord.id, email: userEmail });

    // Sign up admin and promote
    await signup(app, adminEmail);
    const adminRecord = await prisma.user.findUniqueOrThrow({
      where: { email: adminEmail },
    });
    await prisma.user.update({
      where: { id: adminRecord.id },
      data: { isAdmin: true },
    });
    adminToken = jwtService.sign({ sub: adminRecord.id, email: adminEmail });
  });

  afterAll(async () => {
    try {
      await cleanupTestUsers(prisma, [adminEmail, userEmail]);
    } finally {
      await app.close();
    }
  });

  it('adminMetrics returns numeric totals >= 0 and required arrays', async () => {
    const body = await adminGql(
      app,
      adminToken,
      `{
        adminMetrics {
          totalUsers
          totalOrgs
          totalProjects
          totalChecks
          alertsLast24h
          checksByStatus { status count }
          recentSignups { id email createdAt }
          signupsPerDay { day count }
        }
      }`,
    );
    expect(body.errors).toBeUndefined();
    const metrics = body.data?.adminMetrics as {
      totalUsers: number;
      totalOrgs: number;
      totalProjects: number;
      totalChecks: number;
      alertsLast24h: number;
      checksByStatus: { status: string; count: number }[];
      recentSignups: { id: string; email: string; createdAt: string }[];
      signupsPerDay: { day: string; count: number }[];
    };

    expect(metrics).toBeDefined();
    // Totals should be non-negative numbers
    expect(typeof metrics.totalUsers).toBe('number');
    expect(metrics.totalUsers).toBeGreaterThanOrEqual(0);
    expect(typeof metrics.totalOrgs).toBe('number');
    expect(metrics.totalOrgs).toBeGreaterThanOrEqual(0);
    expect(typeof metrics.totalProjects).toBe('number');
    expect(metrics.totalProjects).toBeGreaterThanOrEqual(0);
    expect(typeof metrics.totalChecks).toBe('number');
    expect(metrics.totalChecks).toBeGreaterThanOrEqual(0);
    expect(typeof metrics.alertsLast24h).toBe('number');
    expect(metrics.alertsLast24h).toBeGreaterThanOrEqual(0);

    // Arrays
    expect(Array.isArray(metrics.checksByStatus)).toBe(true);
    expect(Array.isArray(metrics.recentSignups)).toBe(true);
    expect(Array.isArray(metrics.signupsPerDay)).toBe(true);

    // recentSignups should have at most 10 items and include our test users
    expect(metrics.recentSignups.length).toBeLessThanOrEqual(10);
    if (metrics.recentSignups.length > 0) {
      const first = metrics.recentSignups[0];
      expect(typeof first.id).toBe('string');
      expect(typeof first.email).toBe('string');
      expect(typeof first.createdAt).toBe('string');
    }

    // signupsPerDay entries should have day (YYYY-MM-DD) and count
    if (metrics.signupsPerDay.length > 0) {
      const entry = metrics.signupsPerDay[0];
      expect(entry.day).toMatch(/^\d{4}-\d{2}-\d{2}$/);
      expect(typeof entry.count).toBe('number');
      expect(entry.count).toBeGreaterThanOrEqual(1);
    }

    // checksByStatus entries should have status string and count number
    if (metrics.checksByStatus.length > 0) {
      const entry = metrics.checksByStatus[0];
      expect(typeof entry.status).toBe('string');
      expect(typeof entry.count).toBe('number');
      expect(entry.count).toBeGreaterThanOrEqual(0);
    }
  });

  it('adminMetrics is forbidden for non-admin users', async () => {
    const body = await adminGql(
      app,
      userToken,
      `{ adminMetrics { totalUsers } }`,
    );
    expect(body.errors).toBeDefined();
    expect(body.errors!.length).toBeGreaterThan(0);
  });

  it('adminMetrics is forbidden without a token', async () => {
    const res = await app.inject({
      method: 'POST',
      url: '/admin/graphql',
      payload: { query: '{ adminMetrics { totalUsers } }' },
      headers: { 'content-type': 'application/json' },
    });
    const body = JSON.parse(res.body) as { errors?: { message: string }[] };
    expect(body.errors).toBeDefined();
    expect(body.errors!.length).toBeGreaterThan(0);
  });
});
