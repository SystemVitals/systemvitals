import { randomUUID } from 'node:crypto';
import { buildApp } from '../src/main';
import type { NestFastifyApplication } from '@nestjs/platform-fastify';
import { PrismaService } from '../src/prisma/prisma.service';
import { cleanupTestUsers } from './cleanup-test-users';

async function signup(app: NestFastifyApplication, email: string) {
  const r = await app.inject({
    method: 'POST',
    url: '/auth/signup',
    payload: { email, password: 'supersecret1' },
  });
  return (JSON.parse(r.body) as { token: string }).token;
}

async function gql(
  app: NestFastifyApplication,
  token: string,
  query: string,
  variables?: unknown,
) {
  const r = await app.inject({
    method: 'POST',
    url: '/graphql',
    headers: { authorization: `Bearer ${token}` },
    payload: { query, variables },
  });
  return JSON.parse(r.body) as unknown;
}

interface GqlMeResponse {
  data: {
    me: {
      organizations: Array<{
        projects: Array<{ id: string }>;
      }>;
    };
  };
}

interface CheckShape {
  id: string;
  name: string;
  status: string;
  pingSlug: string;
  lastEventAt: string | null;
  events: Array<{ id: string; status: string; timestamp: string }>;
}

interface GqlCreateCheckResponse {
  data?: { createCheck: CheckShape };
  errors?: Array<{ message: string }>;
}

interface GqlCheckResponse {
  data?: { check: CheckShape };
  errors?: Array<{ message: string }>;
}

describe('ping (e2e)', () => {
  let app: NestFastifyApplication;
  let prisma: PrismaService;
  const email = `ping-test+${randomUUID().slice(0, 8)}@systemvitals.com`;

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

  let token: string;
  let checkId: string;
  let pingSlug: string;

  it('creates a heartbeat check and grabs its pingSlug', async () => {
    token = await signup(app, email);
    const me = (await gql(
      app,
      token,
      `{ me { organizations { projects { id } } } }`,
    )) as GqlMeResponse;
    const projectId = me.data.me.organizations[0].projects[0].id;

    const res = (await gql(
      app,
      token,
      `mutation($projectId: ID!, $name: String!, $periodSeconds: Int!, $graceSeconds: Int!) {
        createCheck(projectId: $projectId, name: $name, periodSeconds: $periodSeconds, graceSeconds: $graceSeconds) {
          id name status pingSlug
        }
      }`,
      {
        projectId,
        name: 'Ping Test Check',
        periodSeconds: 300,
        graceSeconds: 60,
      },
    )) as GqlCreateCheckResponse;

    expect(res.errors).toBeUndefined();
    checkId = res.data!.createCheck.id;
    pingSlug = res.data!.createCheck.pingSlug;
    expect(pingSlug).toBeTruthy();
    expect(res.data!.createCheck.status).toBe('NEW');
  });

  it('GET /ping/:slug returns 200 "OK"', async () => {
    const r = await app.inject({ method: 'GET', url: `/ping/${pingSlug}` });
    expect(r.statusCode).toBe(200);
    expect(r.body).toBe('OK');
  });

  it('after GET ping, check shows status=UP, lastEventAt non-null, and an UP event', async () => {
    const res = (await gql(
      app,
      token,
      `query($id: ID!) {
        check(id: $id) {
          id status lastEventAt
          events { id status timestamp }
        }
      }`,
      { id: checkId },
    )) as GqlCheckResponse;

    expect(res.errors).toBeUndefined();
    const check = res.data!.check;
    expect(check.status).toBe('UP');
    expect(check.lastEventAt).not.toBeNull();
    expect(check.events.length).toBeGreaterThanOrEqual(1);
    expect(check.events.some((e) => e.status === 'UP')).toBe(true);
  });

  it('POST /ping/:slug also returns 200 "OK"', async () => {
    const r = await app.inject({ method: 'POST', url: `/ping/${pingSlug}` });
    expect(r.statusCode).toBe(200);
    expect(r.body).toBe('OK');
  });

  it('GET /ping/nonexistent-slug returns 404', async () => {
    const r = await app.inject({
      method: 'GET',
      url: '/ping/does-not-exist-slug-xyz',
    });
    expect(r.statusCode).toBe(404);
  });
});

interface GqlUpdateCheckResponse {
  data?: { updateCheck: CheckShape };
  errors?: Array<{ message: string }>;
}

describe('ping on a converted check (e2e)', () => {
  let app: NestFastifyApplication;
  let prisma: PrismaService;
  const email = `ping-converted-test+${randomUUID().slice(0, 8)}@systemvitals.com`;

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

  it('rejects a ping to the retained pingSlug of a check converted away from HEARTBEAT, and leaves it untouched', async () => {
    const token = await signup(app, email);
    const me = (await gql(
      app,
      token,
      `{ me { organizations { projects { id } } } }`,
    )) as GqlMeResponse;
    const projectId = me.data.me.organizations[0].projects[0].id;

    const created = (await gql(
      app,
      token,
      `mutation($projectId: ID!, $name: String!, $periodSeconds: Int!, $graceSeconds: Int!) {
        createCheck(projectId: $projectId, name: $name, periodSeconds: $periodSeconds, graceSeconds: $graceSeconds) {
          id pingSlug
        }
      }`,
      {
        projectId,
        name: 'Converted Ping Test Check',
        periodSeconds: 300,
        graceSeconds: 60,
      },
    )) as GqlCreateCheckResponse;
    const checkId = created.data!.createCheck.id;
    const pingSlug = created.data!.createCheck.pingSlug;

    // Convert HEARTBEAT -> HTTP. Per the design, the ping slug is retained
    // (not nulled) so converting back restores the same URL.
    const converted = (await gql(
      app,
      token,
      `mutation($id: ID!) {
        updateCheck(id: $id, input: {
          type: "HTTP", target: "https://example.com/health",
          intervalSeconds: 300, timeoutMs: 5000
        }) { id name status pingSlug lastEventAt events { id status timestamp } }
      }`,
      { id: checkId },
    )) as GqlUpdateCheckResponse;
    expect(converted.errors).toBeUndefined();
    const convertedCheck = converted.data!.updateCheck;
    // The slug survives the conversion.
    expect(convertedCheck.pingSlug).toBe(pingSlug);
    const statusBeforePing = convertedCheck.status;
    const lastEventAtBeforePing = convertedCheck.lastEventAt;

    // A ping against the now-dormant slug must behave exactly like an
    // unknown slug: 404, and no mutation of the (now HTTP) check.
    const r = await app.inject({ method: 'GET', url: `/ping/${pingSlug}` });
    expect(r.statusCode).toBe(404);

    const after = (await gql(
      app,
      token,
      `query($id: ID!) {
        check(id: $id) {
          id status lastEventAt
          events { id status timestamp }
        }
      }`,
      { id: checkId },
    )) as GqlCheckResponse;
    const afterCheck = after.data!.check;
    expect(afterCheck.status).toBe(statusBeforePing);
    expect(afterCheck.lastEventAt).toBe(lastEventAtBeforePing);
    // No UP event was written by the rejected ping.
    expect(afterCheck.events.every((e) => e.status !== 'UP')).toBe(true);
  });
});
