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
      email: string;
      organizations: Array<{
        id: string;
        slug: string;
        projects: Array<{
          id: string;
          slug: string;
        }>;
      }>;
    };
  };
}

interface CheckShape {
  id: string;
  name: string;
  slug: string;
}

interface GqlCreateCheckResponse {
  data?: { createCheck: CheckShape };
  errors?: Array<{ message: string }>;
}

describe('slug generation (e2e)', () => {
  let app: NestFastifyApplication;
  let prisma: PrismaService;
  const emailA = 'slug-gen-a@systemvitals.com';

  beforeAll(async () => {
    app = await buildApp();
    await app.init();
    await app.getHttpAdapter().getInstance().ready();
    prisma = app.get(PrismaService);
    await cleanupTestUsers(prisma, emailA);
  });

  afterAll(async () => {
    try {
      await cleanupTestUsers(prisma, emailA);
    } finally {
      await app.close();
    }
  });

  it('signup produces an organization and project each with a valid slug, visible on me', async () => {
    const token = await signup(app, emailA);
    const me = (await gql(
      app,
      token,
      `{ me { email organizations { id slug projects { id slug } } } }`,
    )) as GqlMeResponse;

    expect(me.data.me.organizations.length).toBe(1);
    const org = me.data.me.organizations[0];
    expect(org.slug).toBeTruthy();
    expect(org.projects.length).toBe(1);
    expect(org.projects[0].slug).toBeTruthy();
  });

  it('creating a check named "Autoclipper API" yields slug "autoclipper-api"', async () => {
    const r = await app.inject({
      method: 'POST',
      url: '/auth/login',
      payload: { email: emailA, password: 'supersecret1' },
    });
    const token = (JSON.parse(r.body) as { token: string }).token;
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
          id name slug
        }
      }`,
      {
        projectId,
        name: 'Autoclipper API',
        periodSeconds: 300,
        graceSeconds: 10,
      },
    )) as GqlCreateCheckResponse;

    expect(res.errors).toBeUndefined();
    expect(res.data?.createCheck.slug).toBe('autoclipper-api');
  });

  it('creating a SECOND check with the same name de-duplicates to "autoclipper-api-2"', async () => {
    const r = await app.inject({
      method: 'POST',
      url: '/auth/login',
      payload: { email: emailA, password: 'supersecret1' },
    });
    const token = (JSON.parse(r.body) as { token: string }).token;
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
          id name slug
        }
      }`,
      {
        projectId,
        name: 'Autoclipper API',
        periodSeconds: 300,
        graceSeconds: 10,
      },
    )) as GqlCreateCheckResponse;

    expect(res.errors).toBeUndefined();
    expect(res.data?.createCheck.slug).toBe('autoclipper-api-2');
  });

  it('creating a check named "São Paulo — DB!" yields slug "sao-paulo-db"', async () => {
    const r = await app.inject({
      method: 'POST',
      url: '/auth/login',
      payload: { email: emailA, password: 'supersecret1' },
    });
    const token = (JSON.parse(r.body) as { token: string }).token;
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
          id name slug
        }
      }`,
      {
        projectId,
        name: 'São Paulo — DB!',
        periodSeconds: 300,
        graceSeconds: 10,
      },
    )) as GqlCreateCheckResponse;

    expect(res.errors).toBeUndefined();
    expect(res.data?.createCheck.slug).toBe('sao-paulo-db');
  });

  it('creating a check named "!!!" yields slug "untitled"', async () => {
    const r = await app.inject({
      method: 'POST',
      url: '/auth/login',
      payload: { email: emailA, password: 'supersecret1' },
    });
    const token = (JSON.parse(r.body) as { token: string }).token;
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
          id name slug
        }
      }`,
      { projectId, name: '!!!', periodSeconds: 300, graceSeconds: 10 },
    )) as GqlCreateCheckResponse;

    expect(res.errors).toBeUndefined();
    expect(res.data?.createCheck.slug).toBe('untitled');
  });
});
