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

async function login(app: NestFastifyApplication, email: string) {
  const r = await app.inject({
    method: 'POST',
    url: '/auth/login',
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
  schedule?: string | null;
  tz?: string | null;
  nextExpectedAt?: string | null;
}

interface GqlCreateCheckResponse {
  data?: { createCheck: CheckShape };
  errors?: Array<{ message: string }>;
}

const CREATE_CRON_CHECK_MUTATION = `
  mutation(
    $projectId: ID!
    $name: String!
    $graceSeconds: Int!
    $periodSeconds: Int
    $schedule: String
    $tz: String
  ) {
    createCheck(
      projectId: $projectId
      name: $name
      graceSeconds: $graceSeconds
      periodSeconds: $periodSeconds
      schedule: $schedule
      tz: $tz
    ) {
      id
      schedule
      tz
      nextExpectedAt
    }
  }
`;

describe('cron check create (e2e)', () => {
  let app: NestFastifyApplication;
  let prisma: PrismaService;
  const email = 'cron-check@systemvitals.com';

  beforeAll(async () => {
    app = await buildApp();
    await app.init();
    await app.getHttpAdapter().getInstance().ready();
    prisma = app.get(PrismaService);
    await cleanupTestUsers(prisma, email);
    await signup(app, email);
  });

  afterAll(async () => {
    try {
      await cleanupTestUsers(prisma, email);
    } finally {
      await app.close();
    }
  });

  async function projectId(token: string) {
    const me = (await gql(
      app,
      token,
      `{ me { organizations { projects { id } } } }`,
    )) as GqlMeResponse;
    return me.data.me.organizations[0].projects[0].id;
  }

  it('creates a cron check with schedule/tz and a non-null nextExpectedAt', async () => {
    const token = await login(app, email);
    const pid = await projectId(token);

    const res = (await gql(app, token, CREATE_CRON_CHECK_MUTATION, {
      projectId: pid,
      name: 'Daily 3am job',
      graceSeconds: 60,
      schedule: '0 3 * * *',
      tz: 'UTC',
    })) as GqlCreateCheckResponse;

    expect(res.errors).toBeUndefined();
    expect(res.data?.createCheck.schedule).toBe('0 3 * * *');
    expect(res.data?.createCheck.tz).toBe('UTC');
    expect(res.data?.createCheck.nextExpectedAt).toBeTruthy();
  });

  it('rejects a cron schedule below the SOLO plan minimum gap (every minute)', async () => {
    const token = await login(app, email);
    const pid = await projectId(token);

    const res = (await gql(app, token, CREATE_CRON_CHECK_MUTATION, {
      projectId: pid,
      name: 'Every minute job',
      graceSeconds: 60,
      schedule: '* * * * *',
      tz: 'UTC',
    })) as GqlCreateCheckResponse;

    expect(res.errors).toBeDefined();
    expect(res.errors?.[0]?.message).toMatch(/minimum interval/i);
  });

  it('rejects an invalid cron expression', async () => {
    const token = await login(app, email);
    const pid = await projectId(token);

    const res = (await gql(app, token, CREATE_CRON_CHECK_MUTATION, {
      projectId: pid,
      name: 'Bad cron',
      graceSeconds: 60,
      schedule: 'nope',
    })) as GqlCreateCheckResponse;

    expect(res.errors).toBeDefined();
    expect(res.errors?.[0]?.message).toMatch(/invalid cron expression/i);
  });

  it('rejects providing both periodSeconds and schedule', async () => {
    const token = await login(app, email);
    const pid = await projectId(token);

    const res = (await gql(app, token, CREATE_CRON_CHECK_MUTATION, {
      projectId: pid,
      name: 'Both',
      graceSeconds: 60,
      periodSeconds: 300,
      schedule: '0 3 * * *',
    })) as GqlCreateCheckResponse;

    expect(res.errors).toBeDefined();
    expect(res.errors?.[0]?.message).toMatch(/exactly one/i);
  });

  it('rejects providing neither periodSeconds nor schedule', async () => {
    const token = await login(app, email);
    const pid = await projectId(token);

    const res = (await gql(app, token, CREATE_CRON_CHECK_MUTATION, {
      projectId: pid,
      name: 'Neither',
      graceSeconds: 60,
    })) as GqlCreateCheckResponse;

    expect(res.errors).toBeDefined();
    expect(res.errors?.[0]?.message).toMatch(/exactly one/i);
  });
});
