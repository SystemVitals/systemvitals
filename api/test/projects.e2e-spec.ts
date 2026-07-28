import { buildApp } from '../src/main';
import type { NestFastifyApplication } from '@nestjs/platform-fastify';
import { PrismaService } from '../src/prisma/prisma.service';
import { cleanupTestUsers } from './cleanup-test-users';
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

interface GqlProjectsResponse {
  data: {
    projects: Array<{
      id: string;
      name: string;
    }>;
  };
}

interface GqlRegenerateResponse {
  data: {
    regeneratePingKey: {
      id: string;
      pingKey: string;
    };
  };
  errors?: Array<{ message: string }>;
}

interface GqlCreateTokenResponse {
  data: {
    createApiToken: {
      id: string;
      plaintext: string;
    };
  };
}

interface GqlCreateProjectResponse {
  data?: { createProject: { id: string; name: string; slug: string } };
  errors?: Array<{ message: string }>;
}

describe('projects (e2e)', () => {
  let app: NestFastifyApplication;
  let prisma: PrismaService;
  const a = 'proj-a@systemvitals.com';
  const b = 'proj-b@systemvitals.com';

  beforeAll(async () => {
    app = await buildApp();
    await app.init();
    await app.getHttpAdapter().getInstance().ready();
    prisma = app.get(PrismaService);
    const allEmails = [
      a,
      b,
      a.replace('@', '+x@'),
      b.replace('@', '+x@'),
      a.replace('@', '+apitest@'),
      a.replace('@', '+p@'),
      b.replace('@', '+p@'),
      a.replace('@', '+q@'),
    ];
    await cleanupTestUsers(prisma, allEmails);
  });
  afterAll(async () => {
    const allEmails = [
      a,
      b,
      a.replace('@', '+x@'),
      b.replace('@', '+x@'),
      a.replace('@', '+apitest@'),
      a.replace('@', '+p@'),
      b.replace('@', '+p@'),
      a.replace('@', '+q@'),
    ];
    try {
      await cleanupTestUsers(prisma, allEmails);
    } finally {
      await app.close();
    }
  });

  it('me returns the user with a default org+project', async () => {
    const token = await signup(app, a);
    const res = (await gql(
      app,
      token,
      `{ me { email organizations { id name projects { id name pingKey } } } }`,
    )) as GqlMeResponse;
    expect(res.data.me.email).toBe(a);
    expect(res.data.me.organizations[0].projects[0].pingKey).toBeTruthy();
  });

  it('regeneratePingKey changes the key', async () => {
    const token = await signup(app, b);
    const me = (await gql(
      app,
      token,
      `{ me { organizations { projects { id pingKey } } } }`,
    )) as GqlMeResponse;
    const proj = me.data.me.organizations[0].projects[0];
    const res = (await gql(
      app,
      token,
      `mutation($id:ID!){ regeneratePingKey(projectId:$id){ id pingKey } }`,
      { id: proj.id },
    )) as GqlRegenerateResponse;
    expect(res.data.regeneratePingKey.pingKey).not.toBe(proj.pingKey);
  });

  it("a user cannot regenerate another org's project key", async () => {
    const emailAx = a.replace('@', '+x@');
    const emailBx = b.replace('@', '+x@');
    const tokenA = await signup(app, emailAx);
    const tokenB = await signup(app, emailBx);
    const meA = (await gql(
      app,
      tokenA,
      `{ me { organizations { projects { id } } } }`,
    )) as GqlMeResponse;
    const projAId = meA.data.me.organizations[0].projects[0].id;
    const res = (await gql(
      app,
      tokenB,
      `mutation($id:ID!){ regeneratePingKey(projectId:$id){ id } }`,
      { id: projAId },
    )) as GqlRegenerateResponse;
    expect(res.errors?.[0]).toBeDefined(); // forbidden
  });

  it('revoked API token is rejected by a protected resolver', async () => {
    const emailC = a.replace('@', '+apitest@');
    const jwt = await signup(app, emailC);

    // Create an API token
    const created = (await gql(
      app,
      jwt,
      `mutation{ createApiToken(name:"test-revoke", scopes:["read"]){ id plaintext } }`,
    )) as GqlCreateTokenResponse;
    const { id, plaintext } = created.data.createApiToken;

    // Confirm the token can call me { email }
    const meRes = (await gql(
      app,
      plaintext,
      `{ me { email } }`,
    )) as GqlMeResponse;
    expect(meRes.data.me.email).toBe(emailC);

    // Revoke the token
    await gql(app, jwt, `mutation($id:ID!){ revokeApiToken(id:$id) }`, { id });

    // Now the revoked token should be rejected
    const revokedRes = (await gql(app, plaintext, `{ me { email } }`)) as {
      data?: { me?: { email: string } };
      errors?: Array<{ message: string }>;
    };
    // ApiAuthGuard rejection always yields a GraphQL error
    expect(revokedRes.errors).toBeDefined();
  });

  it('projects query returns the signed-up user default project', async () => {
    const emailP = a.replace('@', '+p@');
    const token = await signup(app, emailP);
    const res = (await gql(
      app,
      token,
      `{ projects { id name } }`,
    )) as GqlProjectsResponse;
    expect(res.data.projects.length).toBeGreaterThanOrEqual(1);
    expect(res.data.projects[0].name).toBeTruthy();
  });

  it('projects query does not return another user projects', async () => {
    const emailP2 = b.replace('@', '+p@');
    // token1 was issued in the previous test; log in to get a fresh one
    const r1 = await app.inject({
      method: 'POST',
      url: '/auth/login',
      payload: { email: a.replace('@', '+p@'), password: 'supersecret1' },
    });
    const token1 = (JSON.parse(r1.body) as { token: string }).token;
    const token2 = await signup(app, emailP2);
    const res1 = (await gql(
      app,
      token1,
      `{ projects { id } }`,
    )) as GqlProjectsResponse;
    const res2 = (await gql(
      app,
      token2,
      `{ projects { id } }`,
    )) as GqlProjectsResponse;
    const ids1 = new Set(res1.data.projects.map((p) => p.id));
    const ids2 = new Set(res2.data.projects.map((p) => p.id));
    const intersection = [...ids1].filter((id) => ids2.has(id));
    expect(intersection).toHaveLength(0);
  });

  it('N concurrent createProject mutations with the identical name ALL succeed with distinct, valid slugs (Fix 4)', async () => {
    const emailQ = a.replace('@', '+q@');
    await cleanupTestUsers(prisma, emailQ);
    const token = await signup(app, emailQ);
    const me = (await gql(
      app,
      token,
      `{ me { organizations { id } } }`,
    )) as GqlMeResponse;
    const organizationId = me.data.me.organizations[0].id;

    const CONCURRENCY = 10;
    const results = await Promise.all(
      Array.from({ length: CONCURRENCY }, () =>
        gql(
          app,
          token,
          `mutation($organizationId: ID!, $name: String!) {
            createProject(organizationId: $organizationId, name: $name) {
              id name slug
            }
          }`,
          { organizationId, name: 'Concurrent Same-Name Project' },
        ),
      ),
    );
    const typed = results as GqlCreateProjectResponse[];

    for (const res of typed) {
      expect(res.errors).toBeUndefined();
      expect(res.data?.createProject).toBeTruthy();
    }

    const slugs = typed.map((res) => res.data!.createProject.slug);
    const ids = typed.map((res) => res.data!.createProject.id);
    expect(new Set(slugs).size).toBe(CONCURRENCY);
    expect(new Set(ids).size).toBe(CONCURRENCY);
    for (const slug of slugs) {
      expect(isValidSlug(slug)).toBe(true);
    }

    await cleanupTestUsers(prisma, emailQ);
  });
});
