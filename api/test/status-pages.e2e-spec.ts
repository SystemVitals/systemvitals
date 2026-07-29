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
        id: string;
        projects: Array<{ id: string }>;
      }>;
    };
  };
}

interface StatusPageShape {
  id: string;
  slug: string;
  title: string;
  branding: string | null;
  checkIds: string[];
  organizationId: string;
  projectId: string;
}

interface GqlCreateStatusPageResponse {
  data?: { createStatusPage: StatusPageShape };
  errors?: Array<{ message: string }>;
}

interface GqlStatusPagesResponse {
  data?: { statusPages: StatusPageShape[] };
  errors?: Array<{ message: string }>;
}

interface GqlUpdateStatusPageResponse {
  data?: { updateStatusPage: StatusPageShape };
  errors?: Array<{ message: string }>;
}

interface GqlDeleteStatusPageResponse {
  data?: { deleteStatusPage: boolean };
  errors?: Array<{ message: string }>;
}

interface GqlCreateCheckResponse {
  data?: { createCheck: { id: string } };
  errors?: Array<{ message: string }>;
}

describe('status-pages (e2e)', () => {
  let app: NestFastifyApplication;
  let prisma: PrismaService;
  const suffix = randomUUID().slice(0, 8);
  const emailA = `sp-a+${suffix}@systemvitals.com`;
  const emailB = `sp-b+${suffix}@systemvitals.com`;

  beforeAll(async () => {
    app = await buildApp();
    await app.init();
    await app.getHttpAdapter().getInstance().ready();
    prisma = app.get(PrismaService);
    await cleanupTestUsers(prisma, [emailA, emailB]);
  });

  afterAll(async () => {
    try {
      await cleanupTestUsers(prisma, [emailA, emailB]);
    } finally {
      await app.close();
    }
  });

  let tokenA: string;
  let tokenB: string;
  let organizationIdA: string;
  let projectIdA: string;
  let projectIdB: string;
  let check1Id: string;
  let check2Id: string;
  let checkBId: string;
  let statusPageId: string;

  it('signup → me → get default projectId for user A', async () => {
    tokenA = await signup(app, emailA);
    const me = (await gql(
      app,
      tokenA,
      `{ me { organizations { id projects { id } } } }`,
    )) as GqlMeResponse;
    organizationIdA = me.data.me.organizations[0].id;
    projectIdA = me.data.me.organizations[0].projects[0].id;
    expect(projectIdA).toBeTruthy();
  });

  it('signup user B and get their project', async () => {
    tokenB = await signup(app, emailB);
    const meB = (await gql(
      app,
      tokenB,
      `{ me { organizations { projects { id } } } }`,
    )) as GqlMeResponse;
    projectIdB = meB.data.me.organizations[0].projects[0].id;
    expect(projectIdB).toBeTruthy();
  });

  it('create 2 heartbeat checks in project A', async () => {
    const res1 = (await gql(
      app,
      tokenA,
      `mutation($projectId: ID!, $name: String!, $periodSeconds: Int!, $graceSeconds: Int!) {
        createCheck(projectId: $projectId, name: $name, periodSeconds: $periodSeconds, graceSeconds: $graceSeconds) {
          id
        }
      }`,
      {
        projectId: projectIdA,
        name: 'Check 1',
        periodSeconds: 300,
        graceSeconds: 30,
      },
    )) as GqlCreateCheckResponse;

    expect(res1.errors).toBeUndefined();
    check1Id = res1.data!.createCheck.id;
    expect(check1Id).toBeTruthy();

    const res2 = (await gql(
      app,
      tokenA,
      `mutation($projectId: ID!, $name: String!, $periodSeconds: Int!, $graceSeconds: Int!) {
        createCheck(projectId: $projectId, name: $name, periodSeconds: $periodSeconds, graceSeconds: $graceSeconds) {
          id
        }
      }`,
      {
        projectId: projectIdA,
        name: 'Check 2',
        periodSeconds: 300,
        graceSeconds: 30,
      },
    )) as GqlCreateCheckResponse;

    expect(res2.errors).toBeUndefined();
    check2Id = res2.data!.createCheck.id;
    expect(check2Id).toBeTruthy();
  });

  it('create a check in project B', async () => {
    const res = (await gql(
      app,
      tokenB,
      `mutation($projectId: ID!, $name: String!, $periodSeconds: Int!, $graceSeconds: Int!) {
        createCheck(projectId: $projectId, name: $name, periodSeconds: $periodSeconds, graceSeconds: $graceSeconds) {
          id
        }
      }`,
      {
        projectId: projectIdB,
        name: 'Check B',
        periodSeconds: 300,
        graceSeconds: 30,
      },
    )) as GqlCreateCheckResponse;
    expect(res.errors).toBeUndefined();
    checkBId = res.data!.createCheck.id;
    expect(checkBId).toBeTruthy();
  });

  it('createStatusPage returns page with slug, title, checkIds', async () => {
    const slug = `acme-${suffix}`;
    const res = (await gql(
      app,
      tokenA,
      `mutation($organizationId: ID!, $slug: String!, $title: String!, $checkIds: [ID!]!) {
        createStatusPage(organizationId: $organizationId, slug: $slug, title: $title, checkIds: $checkIds) {
          id slug title branding checkIds organizationId projectId
        }
      }`,
      {
        organizationId: organizationIdA,
        slug,
        title: 'Acme',
        checkIds: [check1Id],
      },
    )) as GqlCreateStatusPageResponse;

    expect(res.errors).toBeUndefined();
    expect(res.data?.createStatusPage.slug).toBe(slug);
    expect(res.data?.createStatusPage.title).toBe('Acme');
    expect(res.data?.createStatusPage.checkIds).toContain(check1Id);
    expect(res.data?.createStatusPage.organizationId).toBe(organizationIdA);
    expect(res.data?.createStatusPage.projectId).toBe(projectIdA);
    expect(res.data?.createStatusPage.branding).toBeNull();
    statusPageId = res.data!.createStatusPage.id;
    expect(statusPageId).toBeTruthy();
  });

  it('statusPages(projectId) lists the created page', async () => {
    const res = (await gql(
      app,
      tokenA,
      `query($projectId: ID!) {
        statusPages(projectId: $projectId) {
          id slug title checkIds projectId
        }
      }`,
      { projectId: projectIdA },
    )) as GqlStatusPagesResponse;

    expect(res.errors).toBeUndefined();
    expect(res.data?.statusPages.length).toBeGreaterThanOrEqual(1);
    const page = res.data?.statusPages.find((p) => p.id === statusPageId);
    expect(page).toBeDefined();
    expect(page?.slug).toBeTruthy();
    expect(page?.checkIds).toContain(check1Id);
  });

  it.each([
    ['both', { organizationId: 'org', projectId: 'project' }],
    ['neither', {}],
  ])(
    'rejects %s workspace selector for status pages',
    async (_case, variables) => {
      const res = (await gql(
        app,
        tokenA,
        `query($organizationId: ID, $projectId: ID) {
        statusPages(organizationId: $organizationId, projectId: $projectId) {
          id
        }
      }`,
        variables,
      )) as GqlStatusPagesResponse;

      expect(res.errors?.[0]?.message).toBe(
        'Provide exactly one of organizationId or projectId',
      );
    },
  );

  it('createStatusPage with a checkId from ANOTHER project → error', async () => {
    const slug = `cross-project-${suffix}`;
    const res = (await gql(
      app,
      tokenA,
      `mutation($projectId: ID!, $slug: String!, $title: String!, $checkIds: [ID!]!) {
        createStatusPage(projectId: $projectId, slug: $slug, title: $title, checkIds: $checkIds) {
          id
        }
      }`,
      { projectId: projectIdA, slug, title: 'Bad Page', checkIds: [checkBId] },
    )) as GqlCreateStatusPageResponse;

    expect(res.errors).toBeDefined();
    expect(res.errors?.[0]?.message).toMatch(/check|project/i);
  });

  it('duplicate slug → error', async () => {
    const slug = `acme-${suffix}`; // same slug as first createStatusPage
    const res = (await gql(
      app,
      tokenA,
      `mutation($projectId: ID!, $slug: String!, $title: String!, $checkIds: [ID!]!) {
        createStatusPage(projectId: $projectId, slug: $slug, title: $title, checkIds: $checkIds) {
          id
        }
      }`,
      { projectId: projectIdA, slug, title: 'Duplicate', checkIds: [check1Id] },
    )) as GqlCreateStatusPageResponse;

    expect(res.errors).toBeDefined();
    expect(res.errors?.[0]?.message).toMatch(/slug|conflict|already/i);
  });

  it('does not disclose another user organization during canonical create', async () => {
    const slug = `cross-user-${suffix}`;
    const res = (await gql(
      app,
      tokenB,
      `mutation($organizationId: ID!, $slug: String!, $title: String!, $checkIds: [ID!]!) {
        createStatusPage(organizationId: $organizationId, slug: $slug, title: $title, checkIds: $checkIds) {
          id
        }
      }`,
      {
        organizationId: organizationIdA,
        slug,
        title: 'Intruder',
        checkIds: [],
      },
    )) as GqlCreateStatusPageResponse;

    expect(res.errors).toBeDefined();
    expect(res.errors?.[0]?.message).toBe('Workspace not found');
  });

  it('updateStatusPage changes title and checkIds', async () => {
    const res = (await gql(
      app,
      tokenA,
      `mutation($id: ID!, $title: String, $checkIds: [ID!]) {
        updateStatusPage(id: $id, title: $title, checkIds: $checkIds) {
          id slug title checkIds projectId
        }
      }`,
      { id: statusPageId, title: 'New Title', checkIds: [check1Id, check2Id] },
    )) as GqlUpdateStatusPageResponse;

    expect(res.errors).toBeUndefined();
    expect(res.data?.updateStatusPage.title).toBe('New Title');
    expect(res.data?.updateStatusPage.checkIds).toContain(check1Id);
    expect(res.data?.updateStatusPage.checkIds).toContain(check2Id);
  });

  it('updateStatusPage with brandingJson round-trips', async () => {
    const branding = JSON.stringify({
      primaryColor: '#ff0000',
      logo: 'https://example.com/logo.png',
    });
    const res = (await gql(
      app,
      tokenA,
      `mutation($id: ID!, $brandingJson: String) {
        updateStatusPage(id: $id, brandingJson: $brandingJson) {
          id branding
        }
      }`,
      { id: statusPageId, brandingJson: branding },
    )) as GqlUpdateStatusPageResponse;

    expect(res.errors).toBeUndefined();
    expect(res.data?.updateStatusPage.branding).toBeTruthy();
    const parsed = JSON.parse(res.data!.updateStatusPage.branding!) as {
      primaryColor: string;
    };
    expect(parsed.primaryColor).toBe('#ff0000');
  });

  it('cross-project checkId rejected on update', async () => {
    const res = (await gql(
      app,
      tokenA,
      `mutation($id: ID!, $checkIds: [ID!]) {
        updateStatusPage(id: $id, checkIds: $checkIds) {
          id
        }
      }`,
      { id: statusPageId, checkIds: [checkBId] },
    )) as GqlUpdateStatusPageResponse;

    expect(res.errors).toBeDefined();
    expect(res.errors?.[0]?.message).toMatch(/check|project/i);
  });

  it('cross-user update forbidden', async () => {
    const res = (await gql(
      app,
      tokenB,
      `mutation($id: ID!, $title: String) {
        updateStatusPage(id: $id, title: $title) {
          id
        }
      }`,
      { id: statusPageId, title: 'Hacked' },
    )) as GqlUpdateStatusPageResponse;

    expect(res.errors).toBeDefined();
    expect(res.errors?.[0]?.message).toMatch(/not a member|forbidden/i);
  });

  it('cross-user delete forbidden', async () => {
    const res = (await gql(
      app,
      tokenB,
      `mutation($id: ID!) { deleteStatusPage(id: $id) }`,
      { id: statusPageId },
    )) as GqlDeleteStatusPageResponse;

    expect(res.errors).toBeDefined();
  });

  it('deleteStatusPage returns true; gone from statusPages', async () => {
    const deleteRes = (await gql(
      app,
      tokenA,
      `mutation($id: ID!) { deleteStatusPage(id: $id) }`,
      { id: statusPageId },
    )) as GqlDeleteStatusPageResponse;

    expect(deleteRes.errors).toBeUndefined();
    expect(deleteRes.data?.deleteStatusPage).toBe(true);

    const listRes = (await gql(
      app,
      tokenA,
      `query($projectId: ID!) { statusPages(projectId: $projectId) { id } }`,
      { projectId: projectIdA },
    )) as GqlStatusPagesResponse;
    const ids = listRes.data?.statusPages.map((p) => p.id) ?? [];
    expect(ids).not.toContain(statusPageId);
  });
});
