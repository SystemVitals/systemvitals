import { buildApp } from '../src/main';
import type { NestFastifyApplication } from '@nestjs/platform-fastify';
import { PrismaService } from '../src/prisma/prisma.service';

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

interface ActiveCheckShape {
  id: string;
  name: string;
  type: string;
  status: string;
  target: string | null;
  method: string | null;
  expectedStatus: number | null;
  intervalSeconds: number | null;
  timeoutMs: number | null;
}

interface CheckEventShape {
  id: string;
  responseTimeMs: number | null;
  statusCode: number | null;
}

interface CheckWithEventsShape {
  id: string;
  events: CheckEventShape[];
}

interface GqlCreateActiveCheckResponse {
  data?: { createActiveCheck: ActiveCheckShape };
  errors?: Array<{ message: string }>;
}

interface GqlChecksResponse {
  data?: { checks: ActiveCheckShape[] };
  errors?: Array<{ message: string }>;
}

interface GqlCheckResponse {
  data?: { check: CheckWithEventsShape };
  errors?: Array<{ message: string }>;
}

async function cleanupUsersByEmail(
  prisma: PrismaService,
  emails: string[],
): Promise<void> {
  const errors: unknown[] = [];
  const users = await prisma.user.findMany({
    where: { email: { in: emails } },
    select: { id: true },
  });
  const userIds = users.map(({ id }) => id);
  if (userIds.length === 0) return;
  try {
    await prisma.organization.deleteMany({
      where: { creatorUserId: { in: userIds } },
    });
  } catch (error) {
    errors.push(error);
  }
  try {
    await prisma.user.deleteMany({ where: { id: { in: userIds } } });
  } catch (error) {
    errors.push(error);
  }
  try {
    const [survivingOrganizations, survivingUsers] = await Promise.all([
      prisma.organization.findMany({
        where: { creatorUserId: { in: userIds } },
        select: { id: true },
      }),
      prisma.user.findMany({
        where: {
          OR: [{ id: { in: userIds } }, { email: { in: emails } }],
        },
        select: { id: true, email: true },
      }),
    ]);
    if (survivingOrganizations.length > 0 || survivingUsers.length > 0) {
      errors.push(
        new Error(
          `Cleanup survivors: organizationIds=${survivingOrganizations
            .map(({ id }) => id)
            .join(',')}; users=${survivingUsers
            .map(({ id, email }) => `${id}:${email}`)
            .join(',')}`,
        ),
      );
    }
  } catch (error) {
    errors.push(error);
  }
  if (errors.length > 0) {
    throw new AggregateError(errors, 'Active-check e2e cleanup failed');
  }
}

describe('active checks (e2e)', () => {
  let app: NestFastifyApplication;
  let prisma: PrismaService;
  const emailA = 'active-check+a@systemvitals.com';
  const emailB = 'active-check+b@systemvitals.com';

  beforeAll(async () => {
    app = await buildApp();
    await app.init();
    await app.getHttpAdapter().getInstance().ready();
    prisma = app.get(PrismaService);
    const allEmails = [emailA, emailB];
    await cleanupUsersByEmail(prisma, allEmails);
  });

  afterAll(async () => {
    const allEmails = [emailA, emailB];
    await cleanupUsersByEmail(prisma, allEmails);
    await app.close();
  });

  it('createActiveCheck returns HTTP check with type=HTTP, status=NEW, target set, intervalSeconds=300, method defaults to GET', async () => {
    const tokenA = await signup(app, emailA);
    const me = (await gql(
      app,
      tokenA,
      `{ me { organizations { projects { id } } } }`,
    )) as GqlMeResponse;
    const projectId = me.data.me.organizations[0].projects[0].id;

    const res = (await gql(
      app,
      tokenA,
      `mutation($projectId: ID!, $name: String!, $type: String!, $target: String!, $intervalSeconds: Int!, $timeoutMs: Int!) {
        createActiveCheck(
          projectId: $projectId,
          name: $name,
          type: $type,
          target: $target,
          intervalSeconds: $intervalSeconds,
          timeoutMs: $timeoutMs
        ) {
          id name type status target method intervalSeconds timeoutMs
        }
      }`,
      {
        projectId,
        name: 'site',
        type: 'HTTP',
        target: 'https://example.com',
        intervalSeconds: 300,
        timeoutMs: 5000,
      },
    )) as GqlCreateActiveCheckResponse;

    expect(res.errors).toBeUndefined();
    expect(res.data?.createActiveCheck.type).toBe('HTTP');
    expect(res.data?.createActiveCheck.status).toBe('NEW');
    expect(res.data?.createActiveCheck.target).toBe('https://example.com');
    expect(res.data?.createActiveCheck.intervalSeconds).toBe(300);
    expect(res.data?.createActiveCheck.method).toBe('GET');
  });

  it('createActiveCheck with type=TCP and target=host:port returns TCP check', async () => {
    const r = await app.inject({
      method: 'POST',
      url: '/auth/login',
      payload: { email: emailA, password: 'supersecret1' },
    });
    const tokenA = (JSON.parse(r.body) as { token: string }).token;
    const me = (await gql(
      app,
      tokenA,
      `{ me { organizations { projects { id } } } }`,
    )) as GqlMeResponse;
    const projectId = me.data.me.organizations[0].projects[0].id;

    const res = (await gql(
      app,
      tokenA,
      `mutation($projectId: ID!, $name: String!, $type: String!, $target: String!, $intervalSeconds: Int!, $timeoutMs: Int!) {
        createActiveCheck(
          projectId: $projectId,
          name: $name,
          type: $type,
          target: $target,
          intervalSeconds: $intervalSeconds,
          timeoutMs: $timeoutMs
        ) {
          id name type status target
        }
      }`,
      {
        projectId,
        name: 'tcp-site',
        type: 'TCP',
        target: 'example.com:443',
        intervalSeconds: 300,
        timeoutMs: 3000,
      },
    )) as GqlCreateActiveCheckResponse;

    expect(res.errors).toBeUndefined();
    expect(res.data?.createActiveCheck.type).toBe('TCP');
    expect(res.data?.createActiveCheck.target).toBe('example.com:443');
  });

  it('createActiveCheck with type=HEARTBEAT is rejected with BadRequest', async () => {
    const r = await app.inject({
      method: 'POST',
      url: '/auth/login',
      payload: { email: emailA, password: 'supersecret1' },
    });
    const tokenA = (JSON.parse(r.body) as { token: string }).token;
    const me = (await gql(
      app,
      tokenA,
      `{ me { organizations { projects { id } } } }`,
    )) as GqlMeResponse;
    const projectId = me.data.me.organizations[0].projects[0].id;

    const res = (await gql(
      app,
      tokenA,
      `mutation($projectId: ID!, $name: String!, $type: String!, $target: String!, $intervalSeconds: Int!, $timeoutMs: Int!) {
        createActiveCheck(
          projectId: $projectId,
          name: $name,
          type: $type,
          target: $target,
          intervalSeconds: $intervalSeconds,
          timeoutMs: $timeoutMs
        ) {
          id
        }
      }`,
      {
        projectId,
        name: 'hb',
        type: 'HEARTBEAT',
        target: 'https://example.com',
        intervalSeconds: 60,
        timeoutMs: 5000,
      },
    )) as GqlCreateActiveCheckResponse;

    expect(res.errors).toBeDefined();
    expect(res.errors?.[0]?.message).toMatch(/type must be http or tcp/i);
  });

  it('createActiveCheck with type=PING is rejected with BadRequest', async () => {
    const r = await app.inject({
      method: 'POST',
      url: '/auth/login',
      payload: { email: emailA, password: 'supersecret1' },
    });
    const tokenA = (JSON.parse(r.body) as { token: string }).token;
    const me = (await gql(
      app,
      tokenA,
      `{ me { organizations { projects { id } } } }`,
    )) as GqlMeResponse;
    const projectId = me.data.me.organizations[0].projects[0].id;

    const res = (await gql(
      app,
      tokenA,
      `mutation($projectId: ID!, $name: String!, $type: String!, $target: String!, $intervalSeconds: Int!, $timeoutMs: Int!) {
        createActiveCheck(
          projectId: $projectId,
          name: $name,
          type: $type,
          target: $target,
          intervalSeconds: $intervalSeconds,
          timeoutMs: $timeoutMs
        ) {
          id
        }
      }`,
      {
        projectId,
        name: 'ping',
        type: 'PING',
        target: 'example.com',
        intervalSeconds: 60,
        timeoutMs: 5000,
      },
    )) as GqlCreateActiveCheckResponse;

    expect(res.errors).toBeDefined();
    expect(res.errors?.[0]?.message).toMatch(/type must be http or tcp/i);
  });

  it('a second user CANNOT createActiveCheck in the first user project (cross-user forbidden)', async () => {
    const tokenB = await signup(app, emailB);
    const r = await app.inject({
      method: 'POST',
      url: '/auth/login',
      payload: { email: emailA, password: 'supersecret1' },
    });
    const tokenA = (JSON.parse(r.body) as { token: string }).token;
    const meA = (await gql(
      app,
      tokenA,
      `{ me { organizations { projects { id } } } }`,
    )) as GqlMeResponse;
    const projectIdA = meA.data.me.organizations[0].projects[0].id;

    const res = (await gql(
      app,
      tokenB,
      `mutation($projectId: ID!, $name: String!, $type: String!, $target: String!, $intervalSeconds: Int!, $timeoutMs: Int!) {
        createActiveCheck(
          projectId: $projectId,
          name: $name,
          type: $type,
          target: $target,
          intervalSeconds: $intervalSeconds,
          timeoutMs: $timeoutMs
        ) {
          id
        }
      }`,
      {
        projectId: projectIdA,
        name: 'Forbidden',
        type: 'HTTP',
        target: 'https://example.com',
        intervalSeconds: 60,
        timeoutMs: 5000,
      },
    )) as GqlCreateActiveCheckResponse;

    expect(res.errors).toBeDefined();
    expect(res.errors?.[0]?.message).toMatch(/not a member/i);
  });

  it('checks(projectId) includes active checks created via createActiveCheck', async () => {
    const r = await app.inject({
      method: 'POST',
      url: '/auth/login',
      payload: { email: emailA, password: 'supersecret1' },
    });
    const tokenA = (JSON.parse(r.body) as { token: string }).token;
    const me = (await gql(
      app,
      tokenA,
      `{ me { organizations { projects { id } } } }`,
    )) as GqlMeResponse;
    const projectId = me.data.me.organizations[0].projects[0].id;

    const res = (await gql(
      app,
      tokenA,
      `query($projectId: ID!) {
        checks(projectId: $projectId) {
          id name type status target
        }
      }`,
      { projectId },
    )) as GqlChecksResponse;

    expect(res.errors).toBeUndefined();
    const types = res.data?.checks.map((c) => c.type) ?? [];
    expect(types).toContain('HTTP');
    expect(types).toContain('TCP');
  });

  it('check(id) exposes events with responseTimeMs and statusCode fields (empty events ok)', async () => {
    const r = await app.inject({
      method: 'POST',
      url: '/auth/login',
      payload: { email: emailA, password: 'supersecret1' },
    });
    const tokenA = (JSON.parse(r.body) as { token: string }).token;
    const me = (await gql(
      app,
      tokenA,
      `{ me { organizations { projects { id } } } }`,
    )) as GqlMeResponse;
    const projectId = me.data.me.organizations[0].projects[0].id;

    const checksRes = (await gql(
      app,
      tokenA,
      `query($projectId: ID!) { checks(projectId: $projectId) { id type } }`,
      { projectId },
    )) as GqlChecksResponse;

    const httpCheck = checksRes.data?.checks.find((c) => c.type === 'HTTP');
    expect(httpCheck).toBeDefined();
    const checkId = httpCheck!.id;

    const res = (await gql(
      app,
      tokenA,
      `query($id: ID!) {
        check(id: $id) {
          id
          events {
            id
            responseTimeMs
            statusCode
          }
        }
      }`,
      { id: checkId },
    )) as GqlCheckResponse;

    expect(res.errors).toBeUndefined();
    expect(res.data?.check.id).toBe(checkId);
    expect(Array.isArray(res.data?.check.events)).toBe(true);
  });
});
