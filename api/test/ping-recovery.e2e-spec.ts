import { randomUUID } from 'node:crypto';
import { Test } from '@nestjs/testing';
import { FastifyAdapter } from '@nestjs/platform-fastify';
import type { NestFastifyApplication } from '@nestjs/platform-fastify';
import { AppModule } from '../src/app.module';
import { AlertQueueService } from '../src/queue/alert-queue.service';
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
  data?: { createCheck: { id: string; pingSlug: string; status: string } };
  errors?: Array<{ message: string }>;
}

describe('ping recovery (e2e, DI override)', () => {
  let app: NestFastifyApplication;
  let prisma: PrismaService;
  const enqueue = jest.fn<
    Promise<void>,
    [{ checkId: string; kind: 'down' | 'recovery' }]
  >();
  const email = `ping-recovery+${randomUUID().slice(0, 8)}@systemvitals.com`;

  beforeAll(async () => {
    const moduleRef = await Test.createTestingModule({ imports: [AppModule] })
      .overrideProvider(AlertQueueService)
      .useValue({ enqueue, onModuleDestroy: jest.fn() })
      .compile();

    app = moduleRef.createNestApplication<NestFastifyApplication>(
      new FastifyAdapter(),
    );
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

  let checkId: string;
  let pingSlug: string;

  beforeEach(() => {
    enqueue.mockClear();
  });

  it('sets up a check and forces it DOWN via Prisma', async () => {
    const token = await signup(app, email);
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
          id pingSlug status
        }
      }`,
      {
        projectId,
        name: 'Recovery Test Check',
        periodSeconds: 300,
        graceSeconds: 10,
      },
    )) as GqlCreateCheckResponse;

    expect(res.errors).toBeUndefined();
    checkId = res.data!.createCheck.id;
    pingSlug = res.data!.createCheck.pingSlug;

    // Force status to DOWN directly via Prisma
    await prisma.check.update({
      where: { id: checkId },
      data: { status: 'DOWN' },
    });

    const updated = await prisma.check.findUnique({ where: { id: checkId } });
    expect(updated?.status).toBe('DOWN');
  });

  it('GET /ping/:slug when check is DOWN triggers recovery enqueue exactly once', async () => {
    const r = await app.inject({ method: 'GET', url: `/ping/${pingSlug}` });
    expect(r.statusCode).toBe(200);

    expect(enqueue).toHaveBeenCalledTimes(1);
    expect(enqueue).toHaveBeenCalledWith({ checkId, kind: 'recovery' });
  });

  it('GET /ping/:slug when check is already UP does NOT enqueue again', async () => {
    // Check is now UP (set by previous ping)
    const check = await prisma.check.findUnique({ where: { id: checkId } });
    expect(check?.status).toBe('UP');

    const r = await app.inject({ method: 'GET', url: `/ping/${pingSlug}` });
    expect(r.statusCode).toBe(200);

    // enqueue should NOT have been called this time
    expect(enqueue).not.toHaveBeenCalled();
  });
});
