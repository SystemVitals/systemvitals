import { buildApp } from '../src/main';
import type { NestFastifyApplication } from '@nestjs/platform-fastify';
import { PrismaService } from '../src/prisma/prisma.service';
import { cleanupTestUsers } from './cleanup-test-users';

describe('mySubscription (e2e)', () => {
  let app: NestFastifyApplication;
  let prisma: PrismaService;
  const email = 'billing-query+e2e@systemvitals.com';

  beforeAll(async () => {
    app = await buildApp();
    await app.init();
    await app.getHttpAdapter().getInstance().ready();
    prisma = app.get(PrismaService);
    await cleanupTestUsers(prisma, email);
  });

  afterAll(async () => {
    try {
      await cleanupTestUsers(prisma, email);
    } finally {
      await app.close();
    }
  });

  it('returns plan=SOLO, status=active, and checkCount>=0 for a new user', async () => {
    // Create user
    const signupRes = await app.inject({
      method: 'POST',
      url: '/auth/signup',
      payload: { email, password: 'supersecret1' },
    });
    expect(signupRes.statusCode).toBe(201);
    const { token } = JSON.parse(signupRes.body) as { token: string };

    // Query mySubscription
    const gqlRes = await app.inject({
      method: 'POST',
      url: '/graphql',
      headers: { authorization: `Bearer ${token}` },
      payload: {
        query: `{ mySubscription { plan status checkCount } }`,
      },
    });

    expect(gqlRes.statusCode).toBe(200);
    const body = JSON.parse(gqlRes.body) as {
      data: {
        mySubscription: { plan: string; status: string; checkCount: number };
      };
    };
    expect(body.data.mySubscription.plan).toBe('SOLO');
    expect(body.data.mySubscription.status).toBe('active');
    expect(typeof body.data.mySubscription.checkCount).toBe('number');
    expect(body.data.mySubscription.checkCount).toBeGreaterThanOrEqual(0);
  });

  it('checkCount increments after creating an active check', async () => {
    // Re-use the same user — sign in again
    const loginRes = await app.inject({
      method: 'POST',
      url: '/auth/login',
      payload: { email, password: 'supersecret1' },
    });
    expect(loginRes.statusCode).toBe(201);
    const { token } = JSON.parse(loginRes.body) as { token: string };

    // Get the project id from me query
    const meRes = await app.inject({
      method: 'POST',
      url: '/graphql',
      headers: { authorization: `Bearer ${token}` },
      payload: {
        query: `{ me { organizations { projects { id } } } }`,
      },
    });
    expect(meRes.statusCode).toBe(200);
    const meBody = JSON.parse(meRes.body) as {
      data: { me: { organizations: { projects: { id: string }[] }[] } };
    };
    const projectId = meBody.data.me.organizations[0].projects[0].id;

    // Create an active check
    const createRes = await app.inject({
      method: 'POST',
      url: '/graphql',
      headers: { authorization: `Bearer ${token}` },
      payload: {
        query: `
          mutation {
            createActiveCheck(
              projectId: "${projectId}"
              name: "e2e billing check"
              type: "HTTP"
              target: "https://example.com"
              intervalSeconds: 300
              timeoutMs: 5000
            ) { id }
          }
        `,
      },
    });
    expect(createRes.statusCode).toBe(200);
    const createBody = JSON.parse(createRes.body) as {
      data?: { createActiveCheck: { id: string } };
      errors?: unknown[];
    };
    expect(createBody.errors).toBeUndefined();

    // Query mySubscription again — checkCount should be >= 1
    const gqlRes = await app.inject({
      method: 'POST',
      url: '/graphql',
      headers: { authorization: `Bearer ${token}` },
      payload: {
        query: `{ mySubscription { plan status checkCount } }`,
      },
    });
    expect(gqlRes.statusCode).toBe(200);
    const body = JSON.parse(gqlRes.body) as {
      data: {
        mySubscription: { plan: string; status: string; checkCount: number };
      };
    };
    expect(body.data.mySubscription.checkCount).toBeGreaterThanOrEqual(1);
  });

  it('requires authentication — returns 200 with errors for unauthenticated request', async () => {
    const gqlRes = await app.inject({
      method: 'POST',
      url: '/graphql',
      payload: {
        query: `{ mySubscription { plan status checkCount } }`,
      },
    });

    expect(gqlRes.statusCode).toBe(200);
    const body = JSON.parse(gqlRes.body) as {
      errors?: { message: string }[];
    };
    expect(body.errors).toBeDefined();
    expect(body.errors!.length).toBeGreaterThan(0);
  });
});
