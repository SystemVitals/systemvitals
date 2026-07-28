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

interface GqlCreateCheckResponse {
  data?: { createCheck: { id: string; name: string; pingSlug: string } };
  errors?: Array<{ message: string }>;
}

interface GqlCreateStatusPageResponse {
  data?: { createStatusPage: { id: string; slug: string } };
  errors?: Array<{ message: string }>;
}

interface PublicStatusBody {
  title: string;
  branding: unknown;
  checks: Array<{ name: string; status: string; lastEventAt: string | null }>;
}

describe('public-status (e2e)', () => {
  let app: NestFastifyApplication;
  let prisma: PrismaService;
  const suffix = randomUUID().slice(0, 8);
  const email = `pub-status+${suffix}@systemvitals.com`;
  const slug = `pub-status-${suffix}`;

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
  let projectId: string;
  let checkId: string;
  let checkPingSlug: string;

  it('setup: signup → get projectId → create check → create status page', async () => {
    token = await signup(app, email);
    const me = (await gql(
      app,
      token,
      `{ me { organizations { projects { id } } } }`,
    )) as GqlMeResponse;
    projectId = me.data.me.organizations[0].projects[0].id;
    expect(projectId).toBeTruthy();

    const checkRes = (await gql(
      app,
      token,
      `mutation($projectId: ID!, $name: String!, $periodSeconds: Int!, $graceSeconds: Int!) {
        createCheck(projectId: $projectId, name: $name, periodSeconds: $periodSeconds, graceSeconds: $graceSeconds) {
          id name pingSlug
        }
      }`,
      {
        projectId,
        name: 'MyPublicCheck',
        periodSeconds: 300,
        graceSeconds: 30,
      },
    )) as GqlCreateCheckResponse;

    expect(checkRes.errors).toBeUndefined();
    checkId = checkRes.data!.createCheck.id;
    checkPingSlug = checkRes.data!.createCheck.pingSlug;
    expect(checkId).toBeTruthy();
    expect(checkPingSlug).toBeTruthy();

    const pageRes = (await gql(
      app,
      token,
      `mutation($projectId: ID!, $slug: String!, $title: String!, $checkIds: [ID!]!) {
        createStatusPage(projectId: $projectId, slug: $slug, title: $title, checkIds: $checkIds) {
          id slug
        }
      }`,
      {
        projectId,
        slug,
        title: 'My Public Status',
        checkIds: [checkId],
      },
    )) as GqlCreateStatusPageResponse;

    expect(pageRes.errors).toBeUndefined();
    expect(pageRes.data?.createStatusPage.slug).toBe(slug);
  });

  it('GET /status/:slug (no auth) → 200 with title and checks', async () => {
    const r = await app.inject({
      method: 'GET',
      url: `/status/${slug}`,
    });
    expect(r.statusCode).toBe(200);

    const body = JSON.parse(r.body) as PublicStatusBody;
    expect(body.title).toBe('My Public Status');
    expect(Array.isArray(body.checks)).toBe(true);
    expect(body.checks.length).toBe(1);
    expect(body.checks[0].name).toBe('MyPublicCheck');
    expect(typeof body.checks[0].status).toBe('string');
    expect('lastEventAt' in body.checks[0]).toBe(true);
  });

  it('no-leak: response does NOT contain sensitive fields', async () => {
    const r = await app.inject({
      method: 'GET',
      url: `/status/${slug}`,
    });
    expect(r.statusCode).toBe(200);

    const bodyStr = r.body;
    expect(bodyStr).not.toContain(checkPingSlug);
    expect(bodyStr).not.toContain('pingSlug');
    expect(bodyStr).not.toContain('target');
    expect(bodyStr).not.toContain('projectId');
    expect(bodyStr).not.toContain('organizationId');
    expect(bodyStr).not.toContain('checkIds');
  });

  it('GET /status/nonexistent → 404', async () => {
    const r = await app.inject({
      method: 'GET',
      url: '/status/does-not-exist-xyz-999',
    });
    expect(r.statusCode).toBe(404);
  });
});
