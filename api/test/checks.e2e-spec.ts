import { buildApp } from '../src/main';
import type { NestFastifyApplication } from '@nestjs/platform-fastify';
import { PrismaService } from '../src/prisma/prisma.service';
import { isValidSlug } from '../src/common/slug';

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
        name: string;
        projects: Array<{
          id: string;
          name: string;
          pingKey: string;
        }>;
      }>;
    };
  };
}

interface CheckShape {
  id: string;
  name: string;
  slug?: string;
  type: string;
  status: string;
  pingSlug: string;
  periodSeconds: number;
  graceSeconds: number;
}

interface GqlCreateCheckResponse {
  data?: { createCheck: CheckShape };
  errors?: Array<{ message: string }>;
}

interface GqlChecksResponse {
  data?: { checks: CheckShape[] };
  errors?: Array<{ message: string }>;
}

interface GqlPauseCheckResponse {
  data?: { pauseCheck: CheckShape };
  errors?: Array<{ message: string }>;
}

interface GqlResumeCheckResponse {
  data?: { resumeCheck: CheckShape };
  errors?: Array<{ message: string }>;
}

interface GqlUpdateCheckResponse {
  data?: { updateCheck: CheckShape };
  errors?: Array<{ message: string }>;
}

interface GqlDeleteCheckResponse {
  data?: { deleteCheck: boolean };
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
    throw new AggregateError(errors, 'Check e2e cleanup failed');
  }
}

describe('checks (e2e)', () => {
  let app: NestFastifyApplication;
  let prisma: PrismaService;
  const emailA = 'check-a@systemvitals.com';
  const emailB = 'check-b@systemvitals.com';

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

  it('createCheck returns HEARTBEAT/NEW with a non-empty pingSlug', async () => {
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
      `mutation($projectId: ID!, $name: String!, $periodSeconds: Int!, $graceSeconds: Int!) {
        createCheck(projectId: $projectId, name: $name, periodSeconds: $periodSeconds, graceSeconds: $graceSeconds) {
          id name type status pingSlug periodSeconds graceSeconds
        }
      }`,
      { projectId, name: 'My Heartbeat', periodSeconds: 300, graceSeconds: 10 },
    )) as GqlCreateCheckResponse;

    expect(res.errors).toBeUndefined();
    expect(res.data?.createCheck.type).toBe('HEARTBEAT');
    expect(res.data?.createCheck.status).toBe('NEW');
    expect(res.data?.createCheck.pingSlug).toBeTruthy();
    expect(res.data?.createCheck.name).toBe('My Heartbeat');
    expect(res.data?.createCheck.periodSeconds).toBe(300);
    expect(res.data?.createCheck.graceSeconds).toBe(10);
  });

  it('checks(projectId) lists the created check', async () => {
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
      `query($projectId: ID!) { checks(projectId: $projectId) { id name type status pingSlug } }`,
      { projectId },
    )) as GqlChecksResponse;

    expect(res.errors).toBeUndefined();
    expect(res.data?.checks.length).toBeGreaterThanOrEqual(1);
    const check = res.data?.checks[0];
    expect(check?.type).toBe('HEARTBEAT');
    expect(check?.pingSlug).toBeTruthy();
  });

  it('pauseCheck sets status to PAUSED; resumeCheck sets it back to NEW', async () => {
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
      `query($projectId: ID!) { checks(projectId: $projectId) { id } }`,
      { projectId },
    )) as GqlChecksResponse;
    const checkId = checksRes.data?.checks[0].id as string;

    const pauseRes = (await gql(
      app,
      tokenA,
      `mutation($id: ID!) { pauseCheck(id: $id) { id status } }`,
      { id: checkId },
    )) as GqlPauseCheckResponse;
    expect(pauseRes.errors).toBeUndefined();
    expect(pauseRes.data?.pauseCheck.status).toBe('PAUSED');

    const resumeRes = (await gql(
      app,
      tokenA,
      `mutation($id: ID!) { resumeCheck(id: $id) { id status } }`,
      { id: checkId },
    )) as GqlResumeCheckResponse;
    expect(resumeRes.errors).toBeUndefined();
    expect(resumeRes.data?.resumeCheck.status).toBe('NEW');
  });

  it('updateCheck changes name and periodSeconds', async () => {
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
      `query($projectId: ID!) { checks(projectId: $projectId) { id } }`,
      { projectId },
    )) as GqlChecksResponse;
    const checkId = checksRes.data?.checks[0].id as string;

    const updateRes = (await gql(
      app,
      tokenA,
      `mutation($id: ID!, $input: UpdateCheckInput!) {
        updateCheck(id: $id, input: $input) {
          id name periodSeconds
        }
      }`,
      { id: checkId, input: { name: 'Updated Name', periodSeconds: 600 } },
    )) as GqlUpdateCheckResponse;

    expect(updateRes.errors).toBeUndefined();
    expect(updateRes.data?.updateCheck.name).toBe('Updated Name');
    expect(updateRes.data?.updateCheck.periodSeconds).toBe(600);
  });

  it('a second user CANNOT createCheck in the first user project (cross-user forbidden)', async () => {
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
      `mutation($projectId: ID!, $name: String!, $periodSeconds: Int!, $graceSeconds: Int!) {
        createCheck(projectId: $projectId, name: $name, periodSeconds: $periodSeconds, graceSeconds: $graceSeconds) {
          id
        }
      }`,
      {
        projectId: projectIdA,
        name: 'Forbidden',
        periodSeconds: 300,
        graceSeconds: 10,
      },
    )) as GqlCreateCheckResponse;

    expect(res.errors).toBeDefined();
    expect(res.errors?.[0]?.message).toBe('Workspace not found');
  });

  it('deleteCheck returns true and the check disappears from checks list', async () => {
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
      `query($projectId: ID!) { checks(projectId: $projectId) { id } }`,
      { projectId },
    )) as GqlChecksResponse;
    const checkId = checksRes.data?.checks[0].id as string;

    const deleteRes = (await gql(
      app,
      tokenA,
      `mutation($id: ID!) { deleteCheck(id: $id) }`,
      { id: checkId },
    )) as GqlDeleteCheckResponse;

    expect(deleteRes.errors).toBeUndefined();
    expect(deleteRes.data?.deleteCheck).toBe(true);

    const afterRes = (await gql(
      app,
      tokenA,
      `query($projectId: ID!) { checks(projectId: $projectId) { id } }`,
      { projectId },
    )) as GqlChecksResponse;
    const remainingIds = afterRes.data?.checks.map((c) => c.id) ?? [];
    expect(remainingIds).not.toContain(checkId);
  });

  it('N concurrent createCheck mutations with the identical name ALL succeed with distinct, valid slugs (Fix 4)', async () => {
    const r = await app.inject({
      method: 'POST',
      url: '/auth/login',
      payload: { email: emailA, password: 'supersecret1' },
    });
    const tokenA = (JSON.parse(r.body) as { token: string }).token;
    const account = await prisma.user.findUniqueOrThrow({
      where: { email: emailA },
      select: { id: true },
    });
    await prisma.subscription.update({
      where: { userId: account.id },
      data: { limits: { maxChecks: 100, minIntervalSeconds: 60 } },
    });
    const me = (await gql(
      app,
      tokenA,
      `{ me { organizations { projects { id } } } }`,
    )) as GqlMeResponse;
    const projectId = me.data.me.organizations[0].projects[0].id;

    const CONCURRENCY = 10;
    const results = await Promise.all(
      Array.from({ length: CONCURRENCY }, () =>
        gql(
          app,
          tokenA,
          `mutation($projectId: ID!, $name: String!, $periodSeconds: Int!, $graceSeconds: Int!) {
            createCheck(projectId: $projectId, name: $name, periodSeconds: $periodSeconds, graceSeconds: $graceSeconds) {
              id name slug
            }
          }`,
          {
            projectId,
            name: 'Concurrent Same-Name Check',
            periodSeconds: 300,
            graceSeconds: 10,
          },
        ),
      ),
    );

    const typed = results as GqlCreateCheckResponse[];

    // Every single one must succeed — creation must never fail because a
    // name is reused, even under concurrency.
    for (const res of typed) {
      expect(res.errors).toBeUndefined();
      expect(res.data?.createCheck).toBeTruthy();
    }

    const slugs = typed.map((res) => res.data!.createCheck.slug as string);
    const ids = typed.map((res) => res.data!.createCheck.id);

    // All distinct — no two concurrent creates collided on the same slug.
    expect(new Set(slugs).size).toBe(CONCURRENCY);
    expect(new Set(ids).size).toBe(CONCURRENCY);

    // Every slug is well-formed per the shared slug contract.
    for (const slug of slugs) {
      expect(isValidSlug(slug)).toBe(true);
    }
  });

  it('sequential createCheck calls whose second NAME collides with a generated suffix still get distinct slugs (cross-partition collision)', async () => {
    // "Backup Job" x2 forces the second create to fall back to the
    // generated suffix "backup-job-2". "Backup Job 2" then naturally
    // slugifies to that SAME "backup-job-2" — this is the exact shape of
    // collision that a naive `row_number() PARTITION BY natural slug`
    // backfill misses, because the generated suffix is never checked
    // against a different row's natural slug. uniqueSlug() (and therefore
    // this live create path) must still hand out three distinct slugs.
    //
    // A dedicated signup is used (rather than emailA's project) so the
    // free plan's 5-check limit isn't already spent by earlier tests in
    // this file.
    const emailCollision = 'check-collision@systemvitals.com';
    await cleanupUsersByEmail(prisma, [emailCollision]);
    const tokenA = await signup(app, emailCollision);
    const me = (await gql(
      app,
      tokenA,
      `{ me { organizations { projects { id } } } }`,
    )) as GqlMeResponse;
    const projectId = me.data.me.organizations[0].projects[0].id;

    const mutation = `mutation($projectId: ID!, $name: String!, $periodSeconds: Int!, $graceSeconds: Int!) {
      createCheck(projectId: $projectId, name: $name, periodSeconds: $periodSeconds, graceSeconds: $graceSeconds) {
        id name slug
      }
    }`;

    const names = ['Backup Job', 'Backup Job', 'Backup Job 2'];
    const created: CheckShape[] = [];
    for (const name of names) {
      const res = (await gql(app, tokenA, mutation, {
        projectId,
        name,
        periodSeconds: 300,
        graceSeconds: 10,
      })) as GqlCreateCheckResponse;
      expect(res.errors).toBeUndefined();
      expect(res.data?.createCheck).toBeTruthy();
      created.push(res.data!.createCheck);
    }

    await cleanupUsersByEmail(prisma, [emailCollision]);

    const slugs = created.map((c) => c.slug as string);

    expect(new Set(slugs).size).toBe(3);
    for (const slug of slugs) {
      expect(isValidSlug(slug)).toBe(true);
    }

    expect(slugs[0]).toBe('backup-job');
    expect(slugs[1]).toBe('backup-job-2');
    expect(slugs[2]).toBe('backup-job-2-2');
  });
});
